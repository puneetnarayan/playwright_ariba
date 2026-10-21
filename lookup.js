// Replays a recorded workflow for every PR number in the uploaded workbook (read-only) and writes the captured data
// into the tracker workbook. Every step waits for its own component to appear before acting; nothing is clicked
// blindly and a missing component fails that row (red) while the run carries on with the next PR.
const fs = require('fs');
const path = require('path');
const tracker = require('./tracker');
const { PR_TOKEN } = require('./workflow');

const CONFIG_FILE = path.join(__dirname, 'lookup-config.json');
const APP_VERSION = (() => { try { return fs.readFileSync(path.join(__dirname, 'VERSION.txt'), 'utf8').trim() || 'dev'; } catch { return 'dev'; } })();
const DEFAULTS = { timeouts: { navMs: 30000, componentMs: 120000, optionalMs: 8000, noMatchMs: 15000, loginWaitMinutes: 10 }, pauseBetweenRowsMs: 1500, keepDebugDays: 14 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function loadConfig() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { throw new Error('Could not read lookup-config.json: ' + e.message); }
  return { timeouts: { ...DEFAULTS.timeouts, ...(user.timeouts || {}) }, pauseBetweenRowsMs: user.pauseBetweenRowsMs ?? DEFAULTS.pauseBetweenRowsMs, keepDebugDays: user.keepDebugDays ?? DEFAULTS.keepDebugDays };
}

// Runs inside the page (and every frame): marks the title link of the first lettered task that has a document, for the next click.
const markTaskFn = () => {
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  document.querySelectorAll('[data-pr-target]').forEach(e => e.removeAttribute('data-pr-target'));
  document.querySelectorAll('[data-pr-arrow]').forEach(e => e.removeAttribute('data-pr-arrow'));
  let hdr = null, nIdx = -1, dIdx = -1;
  for (const tr of document.querySelectorAll('tr')) {
    const cells = Array.from(tr.children).filter(c => /^T[DH]$/.test(c.tagName));
    const texts = cells.map(c => clean(c.innerText));
    if (!hdr) { const n = texts.indexOf('Name'), d = texts.indexOf('Document'); if (n >= 0 && d >= 0) { hdr = texts; nIdx = n; dIdx = d; } continue; }
    const at = i => (texts.length === hdr.length ? i : texts.length - (hdr.length - i));
    const name = texts[at(nIdx)] || '', doc = texts[at(dIdx)] || '';
    if (!/^[A-Za-z][.)]\s*\S/.test(name) || !doc) continue;
    for (const a of cells[at(nIdx)].querySelectorAll('a')) {
      if (clean(a.innerText) && name.startsWith(clean(a.innerText).slice(0, 12))) {
        a.setAttribute('data-pr-target', '1');
        // The small "V" after the title: the first small, empty, visible element after the title link in the same cell.
        const all = Array.from(cells[at(nIdx)].querySelectorAll('*'));
        for (const e of all.slice(all.indexOf(a) + 1)) {
          if (e.closest('[role="menu"]') || e.getAttribute('role') === 'menuitem' || !['A', 'IMG', 'SPAN', 'I', 'DIV', 'BUTTON'].includes(e.tagName)) continue;
          const r = e.getBoundingClientRect();
          if (r.width >= 6 && r.width <= 45 && r.height >= 6 && r.height <= 45 && getComputedStyle(e).visibility !== 'hidden' && !clean(e.innerText)) { e.setAttribute('data-pr-arrow', '1'); break; }
        }
        return true;
      }
    }
  }
  return false;
};

// Runs inside the page (and every frame): reads data by a capture rule. Returns {state:'ok'|'wait'|'nomatch', values}.
const readFn = rule => {
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const cellsOf = tr => Array.from(tr.children).filter(c => /^T[DH]$/.test(c.tagName));
  if (rule.type === 'label-value') {
    const want = clean(rule.label).replace(/\s*:\s*$/, '').toLowerCase();
    for (const tr of document.querySelectorAll('tr')) {
      const cells = cellsOf(tr).map(c => clean(c.innerText));
      const idx = cells.findIndex(c => c);
      if (idx < 0 || cells[idx].replace(/\s*:\s*$/, '').toLowerCase() !== want) continue;
      const rest = cells.slice(idx + 1).filter(Boolean);
      if (rest.length) return { state: 'ok', values: [rest[0]] };
    }
    const lines = (document.body ? document.body.innerText : '').split('\n').map(clean).filter(Boolean);
    const re = new RegExp('^' + want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:\\-]\\s*(.+)$', 'i');
    for (const l of lines) { const m = l.match(re); if (m) return { state: 'ok', values: [m[1]] }; }
    return { state: 'wait' };
  }
  const headerIndex = (cells, name) => cells.findIndex(c => c.toLowerCase() === String(name || '').toLowerCase());
  const cellAt = (cells, hdr, idx) => (idx < 0 ? '' : (cells.length === hdr.length ? cells[idx] : cells[cells.length - (hdr.length - idx)])) || '';
  if (rule.type === 'task-steps') {
    const namePat = new RegExp(rule.namePattern || '^([A-Za-z])[.)]\\s*\\S');
    let hdr = null, nIdx = -1, sIdx = -1, oIdx = -1;
    const steps = [];
    for (const tr of document.querySelectorAll('tr')) {
      const cells = cellsOf(tr).map(c => clean(c.innerText));
      if (!hdr) { const n = headerIndex(cells, rule.nameHeader || 'Name'), st = headerIndex(cells, rule.statusHeader || 'Status'); if (n >= 0 && st >= 0) { hdr = cells; nIdx = n; sIdx = st; oIdx = headerIndex(cells, rule.ownerHeader || 'Owner'); } continue; }
      const name = cellAt(cells, hdr, nIdx), status = cellAt(cells, hdr, sIdx);
      if (!name || !status || name.length > 200 || cells.length < 3) continue;
      const m = name.match(namePat);
      if (!m) continue;
      if (steps.some(x => x.name === name)) continue;
      steps.push({ letter: m[1].toUpperCase(), name, status, owner: cellAt(cells, hdr, oIdx) });
    }
    if (!hdr || !steps.length) return { state: 'wait' };
    const letters = (rule.letters && rule.letters.length) ? rule.letters : steps.map(x => x.letter);
    const values = letters.map(l => { const x = steps.find(y => y.letter === l); return x ? (x.status === 'Complete' ? 'Complete' : x.status + (x.owner ? ' (' + x.owner + ')' : '')) : 'Not found'; });
    const pending = steps.filter(x => x.status !== 'Complete').map(x => x.name + ' - ' + x.status + (x.owner ? ' - ' + x.owner : ''));
    values.push(pending.length ? pending.join('; ') : 'None');
    return { state: 'ok', values };
  }
  if (rule.type === 'participation') {
    let hdr = null, nIdx = -1, sIdx = -1;
    const rows = [];
    for (const tr of document.querySelectorAll('tr')) {
      const cells = cellsOf(tr).map(c => clean(c.innerText));
      const n = headerIndex(cells, rule.nameHeader || 'Organization Name'), st = headerIndex(cells, rule.statusHeader || 'Status');
      if (n >= 0 && st >= 0) { hdr = cells; nIdx = n; sIdx = st; rows.length = 0; continue; }
      if (!hdr || cells.length < 3 || cells.length > hdr.length + 1 || cells.length < hdr.length - 1) continue;
      const name = cellAt(cells, hdr, nIdx);
      if (!name || name.length > 150) continue;
      if (rows.some(r => r.name === name)) continue;
      rows.push({ name, status: cellAt(cells, hdr, sIdx) });
    }
    if (!hdr) return { state: 'wait' };
    if (!rows.length) return { state: 'nomatch' };
    const ok = String(rule.okValue || 'Participated').toLowerCase();
    const done = rows.filter(r => r.status.toLowerCase() === ok);
    const follow = rows.filter(r => r.status.toLowerCase() !== ok);
    return { state: 'ok', values: [String(rows.length), String(done.length), follow.length ? follow.map(r => r.name + (r.status ? ' (' + r.status + ')' : ' (no bid)')).join('; ') : 'None', rows.map(r => r.name + ': ' + (r.status || 'blank')).join('; ')] };
  }
  if (rule.type === 'row-by-status') {
    const need = (rule.headers || []).map(h => h.toLowerCase());
    const pat = rule.namePattern ? new RegExp(rule.namePattern) : null;
    const statusHeader = String(rule.statusHeader || 'Status').toLowerCase();
    let hdr = null, dataRows = 0;
    const matches = [];
    for (const tr of document.querySelectorAll('tr')) {
      const cells = cellsOf(tr).map(c => clean(c.innerText));
      const low = cells.map(c => c.toLowerCase());
      if (cells.filter(Boolean).length >= 2 && need.length && need.every(h => low.includes(h))) { hdr = cells; continue; }
      if (!hdr) continue;
      const sIdx = hdr.findIndex(h => h.toLowerCase() === statusHeader);
      if (sIdx < 0 || cells.length <= sIdx || !cells[sIdx]) continue;
      dataRows++;
      if (cells[sIdx].toLowerCase() !== String(rule.status).toLowerCase()) continue;
      const idxs = (rule.colHeaders || []).map((h, k) => { const byName = h ? hdr.findIndex(x => x === h) : -1; return byName >= 0 ? byName : (rule.cols || [])[k]; });
      if (pat && !pat.test(cells[idxs[0]] || '')) continue;
      matches.push(idxs.map(i => cells[i] || ''));
    }
    if (!hdr || !dataRows) return { state: 'wait' };
    if (!matches.length) return { state: 'nomatch' };
    return { state: 'ok', values: matches[matches.length - 1], count: matches.length };
  }
  let el = null;
  for (const sel of [rule.selector, rule.cssPath]) { if (!sel || el) continue; try { el = document.querySelector(sel); } catch { /* bad selector */ } }
  const t = el ? clean(el.innerText) : '';
  return t ? { state: 'ok', values: [t] } : { state: 'wait' };
};

function createLookup({ getPage, isRecording, resultsDir, loadWorkflow }) {
  const trackerFile = path.join(resultsDir, 'PR_Status_Tracker.xlsx');
  const debugRoot = path.join(resultsDir, 'debug');
  let job = null;
  const phase = text => { if (job) job.phase = text; };

  async function visibleText(page) {
    const chunks = [];
    for (const f of page.frames()) {
      try { chunks.push(await f.evaluate(() => document.body ? document.body.innerText : '')); } catch { /* detached frame */ }
    }
    return chunks.join('\n');
  }
  const onLoginPage = async page => {
    if (/login\.microsoftonline\.com|login\.live\.com/i.test(page.url())) return true;
    for (const f of page.frames()) {
      try { if (await f.locator('input[type="password"]:visible').count()) return true; } catch { /* ignore */ }
    }
    return false;
  };
  const settle = async (page, cfg) => {
    // Only a short breather here; the real wait is always for the specific component the next step needs.
    await page.waitForLoadState('domcontentloaded', { timeout: cfg.timeouts.navMs }).catch(() => {});
    await sleep(400);
  };
  async function waitForLogin(cfg) {
    const until = Date.now() + cfg.timeouts.loginWaitMinutes * 60000;
    job.state = 'waiting-login';
    job.message = 'Login page detected. Log in again in the Playwright browser; the run resumes automatically.';
    while (Date.now() < until && !job.stop) {
      await sleep(3000);
      const page = getPage();
      if (page && !page.isClosed() && !(await onLoginPage(page))) { job.state = 'running'; job.message = ''; return true; }
    }
    return false;
  }
  async function saveDebug(runId, number, why) {
    try {
      const page = getPage(); if (!page || page.isClosed()) return;
      const base = path.join(debugRoot, runId, number.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40));
      fs.mkdirSync(path.dirname(base), { recursive: true });
      await page.screenshot({ path: base + '.jpg', type: 'jpeg', quality: 55, timeout: 8000 }).catch(() => {});
      fs.writeFileSync(base + '.txt', '[' + why + ']\nURL: ' + page.url().replace(/awssk=[^&#]*/, 'awssk=REDACTED') + '\nTitle: ' + (await page.title().catch(() => '')) + '\n\n' + (await visibleText(page)).slice(0, 60000));
    } catch { /* debug is best effort */ }
  }
  function cleanOldDebug(days) {
    try {
      const limit = Date.now() - days * 86400000;
      for (const n of fs.readdirSync(debugRoot)) { const p = path.join(debugRoot, n); if (fs.statSync(p).mtimeMs < limit) fs.rmSync(p, { recursive: true, force: true }); }
    } catch { /* nothing to clean */ }
  }

  // ---- locating recorded components ----
  const subst = (s, number) => String(s || '').split(PR_TOKEN).join(number);
  function textRegex(text, match) {
    const t = String(text).trim();
    const truncated = /(\.\.\.|…)$/.test(t);
    const core = t.replace(/(\.\.\.|…)$/, '').trim();
    return new RegExp('^\\s*' + esc(core) + (truncated || match === 'prefix' ? '' : '\\s*$'), 'i');
  }
  // Candidate ways to find a recorded target: by id (when its text still fits), by tag/role/text, by recorded css path.
  function candidates(target, number) {
    const out = [];
    const text = subst(target.text, number).trim();
    const re = text ? textRegex(text, target.match) : null;
    const tag = (target.tag || '*').toLowerCase();
    const tagSel = tag + (target.role ? '[role="' + target.role + '"]' : '');
    if (target.selector && target.selector.startsWith('#')) out.push({ make: f => f.locator(target.selector), verify: re });
    if (re) out.push({ make: f => f.locator(tagSel + ':visible').filter({ hasText: re }), verify: null });
    if (target.cssPath) out.push({ make: f => f.locator(target.cssPath), verify: re });
    if (re && text) out.push({ make: f => f.getByText(re).locator('visible=true'), verify: null });   // last resort: the smallest visible element with that text (tabs, headings)
    return out;
  }
  async function findNow(page, target, number) {
    if (target.special === 'task-with-document') {
      for (const f of page.frames()) {
        try { if (await f.evaluate(markTaskFn)) { const loc = f.locator('[data-pr-target="1"]').first(); if (await loc.isVisible().catch(() => false)) return loc; } } catch { /* frame navigating */ }
      }
      return null;
    }
    const cands = candidates(target, number);
    if (!cands.length) return null;
    for (const f of page.frames()) {
      for (const c of cands) {
        try {
          const loc = c.make(f).first();
          if (!(await loc.isVisible().catch(() => false))) continue;
          if (c.verify && !c.verify.test(((await loc.innerText().catch(() => '')) || '').replace(/\s+/g, ' '))) continue;
          return loc;
        } catch { /* frame navigating */ }
      }
    }
    return null;
  }
  const describe = (target, number) => (target.special === 'task-with-document' || target.special === 'open-event-from-task' ? 'the first step that has a document' : '') || subst(target.text, number) || target.selector || target.cssPath || target.tag || 'component';

  // Opens the event from the dropdown menu of the first lettered step that has a document: the small V after the title,
  // then 'Open Event'. Tries the V, then the title link, then a click just right of the title, until the menu shows.
  async function openEventFromTask(cfg) {
    const menuItem = () => getPage().locator('[role="menuitem"]:visible', { hasText: /^\s*Open Event\s*$/ }).first();
    const markTasks = async () => {
      for (const f of getPage().frames()) { try { if (await f.evaluate(markTaskFn)) return f; } catch { /* navigating */ } }
      return null;
    };
    let frame = null;
    const until = Date.now() + cfg.timeouts.componentMs;
    while (Date.now() < until && !job.stop && !(frame = await markTasks())) await sleep(500);
    if (!frame) { const e = new Error('timeout'); e.code = 'timeout'; throw e; }
    for (const how of ['title', 'arrow', 'offset']) {
      await getPage().keyboard.press('Escape').catch(() => {});
      frame = (await markTasks()) || frame;
      const title = frame.locator('[data-pr-target="1"]').first();
      try {
        if (how === 'arrow') { const arrow = frame.locator('[data-pr-arrow="1"]').first(); if (!(await arrow.count())) continue; await arrow.click({ timeout: 5000 }); }
        else if (how === 'title') await title.click({ timeout: 5000 });
        else { const b = await title.boundingBox(); if (!b) continue; await getPage().mouse.click(b.x + b.width + 14, b.y + b.height / 2); }
      } catch { continue; }
      const u = Date.now() + 6000;
      while (Date.now() < u) { if (await menuItem().isVisible().catch(() => false)) { await getPage().evaluate(() => document.documentElement.setAttribute('data-pr-stale', '1')).catch(() => {}); await menuItem().click({ timeout: cfg.timeouts.navMs }); return; } await sleep(300); }
    }
    throw new Error('The step menu with "Open Event" did not open (tried the title link, the V arrow and a click beside the title)');
  }

  // Waits for a component. Throws errors with code 'not_found' or 'timeout' that the caller turns into row results.
  async function waitFor(page, target, number, ms, ctx) {
    const t0 = Date.now(), until = t0 + ms;
    let kicks = 0;
    while (Date.now() < until && !job.stop) {
      page = getPage();
      const loc = await findNow(page, target, number);
      if (loc) return loc;
      if (ctx.notFoundRe) {
        const body = await visibleText(page).catch(() => '');
        if (ctx.notFoundRe.test(body)) {
          const rebuilt = await page.evaluate(() => !document.documentElement.hasAttribute('data-pr-stale')).catch(() => true);
          if (rebuilt || Date.now() - t0 > 8000) { const e = new Error('not_found'); e.code = 'not_found'; throw e; }
        }
      }
      // The page was never rebuilt after our last click: it probably did not register. Click it again (twice at most).
      const waited = Date.now() - t0;
      if (ctx.retryPrev && kicks < 2 && waited > (kicks ? 35000 : 15000) && await page.evaluate(() => document.documentElement.hasAttribute('data-pr-stale')).catch(() => false)) {
        kicks++; phase('the page did not react - clicking again');
        await ctx.retryPrev().catch(() => {});
      }
      await sleep(400);
    }
    const e = new Error('timeout'); e.code = 'timeout'; throw e;
  }

  async function readCapture(page, rule, cfg) {
    const until = Date.now() + cfg.timeouts.componentMs;
    let nomatchSince = 0;
    while (Date.now() < until && !job.stop) {
      page = getPage();
      let sawNoMatch = false;
      for (const f of page.frames()) {
        try {
          const r = await f.evaluate(readFn, rule);
          if (r.state === 'ok') return r;
          if (r.state === 'nomatch') sawNoMatch = true;
        } catch { /* frame navigating */ }
      }
      if (sawNoMatch) { nomatchSince = nomatchSince || Date.now(); if (Date.now() - nomatchSince > cfg.timeouts.noMatchMs) return rule.type === 'participation' ? { state: 'ok', values: ['0', '0', 'No suppliers listed', ''] } : { state: 'nomatch' }; } else nomatchSince = 0;
      await sleep(600);
    }
    return { state: 'wait' };
  }

  // Gets the browser to the page where the workflow's first step can be done.
  async function reachStart(first, number, cfg, startUrl) {
    const visible = async ms => { const u = Date.now() + ms; do { if (await findNow(getPage(), first.target, number)) return true; await sleep(400); } while (Date.now() < u); return false; };
    await getPage().keyboard.press('Escape').catch(() => {});
    if (await visible(2500)) return;
    const home = getPage().locator('a', { hasText: /^\s*HOME\s*$/ }).first();
    if (await home.count().catch(() => 0)) {
      await home.click({ timeout: 5000 }).catch(() => {});
      await settle(getPage(), cfg);
      if (await visible(cfg.timeouts.navMs)) return;
    }
    for (let i = 0; i < 5; i++) {
      await getPage().goBack({ waitUntil: 'domcontentloaded', timeout: cfg.timeouts.navMs }).catch(() => {});
      await settle(getPage(), cfg);
      if (await visible(10000)) return;
    }
    await getPage().goto(startUrl, { waitUntil: 'domcontentloaded', timeout: cfg.timeouts.navMs }).catch(() => {});
    await settle(getPage(), cfg);
    if (await visible(cfg.timeouts.componentMs)) return;
    throw new Error('Could not get back to the page where the recorded steps begin (tried the HOME link, browser Back and the start URL). Start the run on that page.');
  }

  // Replays the workflow for one PR number. Returns {kind:'ok'|'not_found'|'error', vals, reason, note}.
  async function runOne(number, wf, cfg, startUrl) {
    const steps = wf.steps.filter(s => s.include);
    const vals = {};
    const notes = [];
    const ctx = { notFoundRe: wf.notFoundText ? new RegExp(wf.notFoundText, 'i') : null, retryPrev: null };
    let page = getPage();
    if (!page || page.isClosed()) return { kind: 'error', reason: 'The Playwright browser window was closed.' };
    if (await onLoginPage(page)) {
      if (!(await waitForLogin(cfg))) return { kind: 'error', reason: 'Session expired and login was not completed in time.' };
    }
    const first = steps.find(s => s.kind === 'type' || s.kind === 'click');
    try {
      phase('going to the starting page');
      await reachStart(first, number, cfg, startUrl);
    } catch (e) { return { kind: 'error', reason: e.message }; }

    let seenNumber = false;
    for (let i = 0; i < steps.length && !job.stop; i++) {
      const s = steps[i];
      const where = 'step ' + (i + 1) + ' of ' + steps.length + ': ' + s.label;
      phase(where);
      page = getPage();
      try {
        if (s.skipIfVisible && await findNow(page, s.skipIfVisible, number)) continue;
        if (s.kind === 'capture') {
          const r = await readCapture(page, s.rule, cfg);
          if (r.state !== 'ok') {
            const what = (s.columns || []).join(', ');
            return { kind: 'error', vals, reason: (r.state === 'nomatch' ? 'No row with ' + (s.rule.statusHeader || 'Status') + ' "' + s.rule.status + '" was found for ' : 'The place to read was not found for ') + what + ' (' + where + ')' };
          }
          (s.columns || []).forEach((name, k) => { vals[name] = (r.values[k] || '').trim(); });
          if (r.count > 1) notes.push(r.count + ' rows matched "' + s.rule.status + '"; used the last one');
          if (!seenNumber) seenNumber = (await visibleText(page)).includes(number);
          continue;
        }
        const target = s.target || {};
        if (target.special === 'open-event-from-task') { await openEventFromTask(cfg); ctx.retryPrev = null; await settle(page, cfg); continue; }
        const loc = await waitFor(page, target, number, s.optional ? cfg.timeouts.optionalMs : cfg.timeouts.componentMs, ctx);
        if (s.kind === 'type') {
          await loc.fill(subst(s.value, number));
          ctx.retryPrev = null;
        } else {
          await page.evaluate(() => document.documentElement.setAttribute('data-pr-stale', '1')).catch(() => {});   // vanishes when the page is rebuilt
          await loc.click({ timeout: cfg.timeouts.navMs });
          ctx.retryPrev = async () => { const again = await findNow(getPage(), target, number); if (again) await again.click({ timeout: 5000 }); };
          await settle(page, cfg);
        }
      } catch (e) {
        if (e.code === 'not_found') return { kind: 'not_found', reason: 'The portal reports no result for this number' };
        if (e.code === 'timeout') {
          if (s.optional) continue;
          return { kind: 'error', vals, reason: 'Waited ' + Math.round(cfg.timeouts.componentMs / 1000) + ' seconds for "' + describe(s.target || {}, number) + '" but it did not appear (' + where + ')' };
        }
        return { kind: 'error', vals, reason: String(e.message || e).split('\n')[0].slice(0, 300) + ' (' + where + ')' };
      }
    }
    if (job.stop) return { kind: 'error', vals, reason: 'Run stopped' };
    if (wf.verifyNumberOnPage !== false && !seenNumber) return { kind: 'error', vals, reason: 'The number ' + number + ' was not visible on the page where the data was read, so the data may belong to another project' };
    return { kind: 'ok', vals, note: notes.join('; ') };
  }

  async function run(opts) {
    const cfg = loadConfig();
    const wf = opts.workflow;
    const capSteps = wf.steps.filter(s => s.include && s.kind === 'capture');
    const cols = capSteps.flatMap(s => s.columns || []);
    const styles = {};
    capSteps.forEach(s => (s.columns || []).forEach((c, k) => { if ((s.columnStyles || [])[k]) styles[c] = s.columnStyles[k]; }));
    const numbers = opts.numbers;
    const startUrl = getPage().url();
    const now = new Date();
    const runId = tracker.localStamp(now).replace(/[ :]/g, '-');
    cleanOldDebug(cfg.keepDebugDays);
    const state = await tracker.load(trackerFile, cols);
    if (state.rotatedTo) job.message = 'The data columns changed, so the earlier tracker was kept as ' + state.rotatedTo + ' and a new one was started.';
    job.total = numbers.length; job.trackerFile = path.basename(trackerFile);
    const runInfo = { id: runId, now, today: tracker.localDateOnlyUtc(now), order: 0 };
    let changed = 0;
    const counts = { SUCCESS: 0, NOT_FOUND: 0, ERROR: 0 };
    for (let i = 0; i < numbers.length && !job.stop; i++) {
      const number = numbers[i];
      job.current = number; job.index = i + 1; phase('starting');
      let outcome;
      try { outcome = await runOne(number, wf, cfg, startUrl); }
      catch (e) { outcome = { kind: 'error', reason: String(e.message || e).split('\n')[0].slice(0, 300) }; }
      if (job.stop && outcome.kind === 'error' && outcome.reason === 'Run stopped') { job.index = i; break; }
      if (outcome.kind !== 'ok') await saveDebug(runId, number, outcome.kind + ': ' + (outcome.reason || ''));
      runInfo.order = i;
      const r = tracker.apply(state, cols, number, outcome, runInfo);
      if (r.changed) changed++;
      const row = state.current.find(x => x.pr === number);
      counts[row.result]++;
      job.counts = { ...counts };
      job.recent.push({ number, result: row.result, data: cols.map(c => (row.vals && row.vals[c]) || '').filter(Boolean).join(' | '), days: row.days, change: row.change, reason: row.reason });
      job.recent = job.recent.slice(-200);
      await persist(state, cols, styles);
      if (i < numbers.length - 1 && !job.stop) await sleep(cfg.pauseBetweenRowsMs);
    }
    state.runLog.push([runId, tracker.localStamp(now), tracker.localStamp(new Date()), opts.sourceName || '', job.index, counts.SUCCESS, counts.NOT_FOUND, counts.ERROR, changed, job.stop ? 'stopped' : 'done', APP_VERSION, wf.name || '']);
    await persist(state, cols, styles);
    job.changed = changed;
  }

  async function persist(state, cols, styles) {
    try { await tracker.save(trackerFile, cols, state, styles); }
    catch (e) {
      const alt = trackerFile.replace(/\.xlsx$/, '_' + Date.now() + '.xlsx');
      await tracker.save(alt, cols, state, styles);
      job.trackerFile = path.basename(alt);
      job.message = 'The tracker was open in Excel, so this run was saved as ' + path.basename(alt) + '. Close Excel and merge or rename it.';
    }
  }

  return {
    status() { return job ? { ...job } : { state: 'idle' }; },
    file() { return job && job.trackerFile ? path.join(resultsDir, job.trackerFile) : (fs.existsSync(trackerFile) ? trackerFile : null); },
    folder() { return resultsDir; },
    stop() { if (job && (job.state === 'running' || job.state === 'waiting-login')) { job.stop = true; return true; } return false; },
    async start(opts) {
      if (job && (job.state === 'running' || job.state === 'waiting-login')) throw new Error('A lookup run is already active.');
      if (isRecording()) throw new Error('Stop recording before running the lookup.');
      const page = getPage();
      if (!page || page.isClosed()) throw new Error('Open the portal and log in first, then go to the page where the recorded steps begin.');
      if (!opts.numbers || !opts.numbers.length) throw new Error('No PR numbers were found in the workbook.');
      loadConfig();
      const workflow = loadWorkflow();
      job = { state: 'running', stop: false, message: '', startedAt: new Date().toISOString(), index: 0, total: 0, current: '', counts: {}, recent: [], trackerFile: '', workflow: workflow.name };
      run({ ...opts, workflow }).then(() => { job.state = job.stop ? 'stopped' : 'done'; job.finishedAt = new Date().toISOString(); })
        .catch(e => { job.state = 'failed'; job.message = String(e.message || e); job.finishedAt = new Date().toISOString(); });
      return { ok: true };
    }
  };
}

module.exports = { APP_VERSION, createLookup, loadConfig, readFn };
