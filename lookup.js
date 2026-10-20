// Read-only PR status lookup. For every PR number in the uploaded workbook it searches the portal in the
// already-logged-in Playwright page, opens the project, reads the task list and works out the current step.
// Results go into one persistent tracker workbook (current status + history of step changes + run log).
// It only types in the search box and clicks the search button and the result link.
const fs = require('fs');
const path = require('path');
const tracker = require('./tracker');

const CONFIG_FILE = path.join(__dirname, 'lookup-config.json');
const DEFAULTS = {
  search: { inputSelector: '', buttonSelector: '', pressEnterInstead: false },
  result: { linkSelector: '', noResultText: 'Search Result\\s+0\\s+project|No (results|items) found' },
  project: {
    phaseLabels: ['Current Phase'], subPhaseLabels: ['Sub Phase'],
    taskNamePattern: '^[A-Za-z0-9]{1,3}[.)]\\s*\\S',
    inProgressStatuses: ['In Progress'], doneStatuses: ['Complete', 'Completed', 'Reviewed']
  },
  afterOpen: [],
  timeouts: { searchMs: 20000, pageMs: 20000, loginWaitMinutes: 10 },
  pauseBetweenRowsMs: 1500,
  keepDebugDays: 14
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadConfig() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { throw new Error('Could not read lookup-config.json: ' + e.message); }
  const merged = {};
  for (const k of Object.keys(DEFAULTS)) {
    const d = DEFAULTS[k], u = user[k];
    merged[k] = d && typeof d === 'object' && !Array.isArray(d) ? { ...d, ...(u || {}) } : (u === undefined ? d : u);
  }
  return merged;
}

// Pull "Label: value" (or "Label" followed by a value line) out of visible text lines.
function valueForLabels(lines, labels) {
  for (const label of labels) {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const inline = new RegExp('^' + esc + '\\s*[:\\-]\\s*(.+)$', 'i');
    for (let i = 0; i < lines.length; i++) {
      const im = lines[i].match(inline);
      if (im && im[1].trim()) return im[1].trim();
      if (lines[i].replace(/\s*[:\-]$/, '').toLowerCase() === label.toLowerCase()) {
        for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) if (lines[j].trim()) return lines[j].trim();
      }
    }
  }
  return null;
}

// Runs inside the page (and every frame): reads the project task table (Name / Owner / Status columns).
const tasksFn = () => {
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const ST = /^(Not Started|In Progress|Completed?|Reviewed|Pending|On Hold|Overdue|Cancell?ed|Skipped|Waiting)$/i;
  let idx = null;
  const rows = [];
  for (const tr of document.querySelectorAll('tr')) {
    const cells = Array.from(tr.children).filter(c => /^T[DH]$/.test(c.tagName)).map(c => clean(c.innerText));
    if (!idx) { const n = cells.indexOf('Name'), s = cells.indexOf('Status'); if (n >= 0 && s >= 0) idx = { name: n, status: s, owner: cells.indexOf('Owner') }; continue; }
    if (cells.length > idx.status && ST.test(cells[idx.status]) && cells[idx.name] && cells[idx.name].length < 200) {
      rows.push({ name: cells[idx.name], owner: idx.owner >= 0 ? (cells[idx.owner] || '') : '', status: cells[idx.status] });
    }
  }
  return { header: !!idx, rows };
};

// Decides the current step from the task rows. Returns {step, stepStatus, owner, others, note} or null.
function pickCurrentStep(rows, pc) {
  const seen = new Set(), list = [];
  for (const r of rows) { const k = r.name + '|' + r.owner + '|' + r.status; if (!seen.has(k)) { seen.add(k); list.push(r); } }
  const isTask = new RegExp(pc.taskNamePattern);
  const lc = a => a.map(x => x.toLowerCase());
  const inProg = lc(pc.inProgressStatuses), done = lc(pc.doneStatuses);
  const tasks = list.filter(r => isTask.test(r.name));
  const pool = tasks.length ? tasks : list;
  const running = pool.filter(r => inProg.includes(r.status.toLowerCase()));
  if (running.length) {
    const cur = running[running.length - 1];
    return { step: cur.name, stepStatus: cur.status, owner: cur.owner, others: running.slice(0, -1).map(r => r.name).join(' | '), note: '' };
  }
  const finished = pool.filter(r => done.includes(r.status.toLowerCase()));
  if (finished.length) {
    const cur = finished[finished.length - 1];
    return { step: cur.name, stepStatus: cur.status, owner: cur.owner, others: '', note: 'No step in progress; showing the last finished step' };
  }
  return pool.length ? { step: pool[0].name, stepStatus: pool[0].status, owner: pool[0].owner, others: '', note: 'No step started yet' } : null;
}

// Ariba keeps every screen on the same path and tells them apart by session state; the home/search screen is the same path with the session key kept.
function homeUrlFrom(url) {
  try {
    const u = new URL(url);
    const key = u.searchParams.get('awssk'), realm = u.searchParams.get('realm');
    if (!/\/Sourcing\/Main\/aw/i.test(u.pathname) || !key) return null;
    return u.origin + u.pathname + '?awh=r&awssk=' + encodeURIComponent(key) + (realm ? '&realm=' + encodeURIComponent(realm) : '') + '&dard=1';
  } catch { return null; }
}

function createLookup({ getPage, isRecording, resultsDir, readRows }) {
  const trackerFile = path.join(resultsDir, 'PR_Status_Tracker.xlsx');
  const debugRoot = path.join(resultsDir, 'debug');
  let job = null;

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
    await page.waitForLoadState('domcontentloaded', { timeout: cfg.timeouts.pageMs }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await sleep(800);
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
      fs.writeFileSync(base + '.txt', '[' + why + ']\n' + (await visibleText(page)).slice(0, 60000));
    } catch { /* debug is best effort */ }
  }
  function cleanOldDebug(days) {
    try {
      const limit = Date.now() - days * 86400000;
      for (const n of fs.readdirSync(debugRoot)) { const p = path.join(debugRoot, n); if (fs.statSync(p).mtimeMs < limit) fs.rmSync(p, { recursive: true, force: true }); }
    } catch { /* nothing to clean */ }
  }

  // Search one number and read the project page. Returns {kind:'ok'|'not_found'|'error', ...}.
  async function lookupOne(number, cfg, startUrl) {
    let page = getPage();
    if (!page || page.isClosed()) throw new Error('The Playwright browser window was closed.');
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: cfg.timeouts.pageMs }).catch(() => {});
    await settle(page, cfg);
    if (await onLoginPage(page)) {
      if (!(await waitForLogin(cfg))) throw new Error('Session expired and login was not completed in time.');
      page = getPage();
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: cfg.timeouts.pageMs }).catch(() => {});
      await settle(page, cfg);
    }
    const input = page.locator(cfg.search.inputSelector).first();
    try { await input.waitFor({ state: 'visible', timeout: cfg.timeouts.searchMs }); }
    catch { throw new Error('Search box not found (' + cfg.search.inputSelector + '). Start the run while the browser is on the Ariba Sourcing home/search page.'); }
    await input.fill(number);
    if (cfg.search.pressEnterInstead) await input.press('Enter');
    else await page.locator(cfg.search.buttonSelector).first().click({ timeout: cfg.timeouts.searchMs });
    await settle(page, cfg);

    const linkLoc = cfg.result.linkSelector ? page.locator(cfg.result.linkSelector) : page.locator('a', { hasText: number });
    const noResult = new RegExp(cfg.result.noResultText, 'i');
    const deadline = Date.now() + cfg.timeouts.pageMs;
    let count = 0;
    while (Date.now() < deadline) {
      count = await linkLoc.count(); if (count) break;
      const body = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
      if (noResult.test(body)) return { kind: 'not_found', reason: 'The portal search returned no project for this number' };
      await sleep(500);
    }
    if (!count) return { kind: 'not_found', reason: 'No result link appeared for this number' };

    let pick = 0, note = '';
    const texts = await linkLoc.allInnerTexts();
    const exact = texts.findIndex(t => t.trim().startsWith(number));
    if (exact >= 0) pick = exact; else if (count > 1) note = 'No result title starts with the number; used the first of ' + count;
    if (count > 1 && exact >= 0) note = count + ' results; used the one starting with the number';
    const linkTitle = (texts[pick] || '').replace(/\s+/g, ' ').trim();
    await linkLoc.nth(pick).click({ timeout: cfg.timeouts.pageMs });
    await settle(page, cfg);
    page = getPage();

    for (const step of cfg.afterOpen || []) {
      if (!step.clickText) continue;
      try { await page.getByText(step.clickText, { exact: false }).first().click({ timeout: 8000 }); await settle(page, cfg); } catch { note += (note ? '; ' : '') + 'could not open "' + step.clickText + '"'; }
    }

    // Wait for the project page to render its task list.
    let best = { rows: [] };
    const until = Date.now() + cfg.timeouts.pageMs;
    while (Date.now() < until) {
      for (const f of page.frames()) {
        try { const r = await f.evaluate(tasksFn); if (r.rows.length > best.rows.length) best = r; } catch { /* frame navigating */ }
      }
      if (best.rows.length) break;
      await sleep(700);
    }
    const lines = (await visibleText(page)).split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const step = pickCurrentStep(best.rows, cfg.project);
    if (!step) return { kind: 'error', reason: 'Project opened but no task list was found on the page' };
    const idLine = lines.find(l => /^ID\s+\S+$/.test(l));
    return {
      kind: 'ok', title: lines.find(l => l.startsWith(number + '-')) || linkTitle, projectId: idLine ? idLine.replace(/^ID\s+/, '') : '',
      phase: valueForLabels(lines, cfg.project.phaseLabels) || '', subPhase: valueForLabels(lines, cfg.project.subPhaseLabels) || '',
      ...step, note: [note, step.note].filter(Boolean).join('; ')
    };
  }

  async function run(opts) {
    const cfg = loadConfig();
    const numbers = opts.numbers;
    const page = getPage();
    let startUrl = page.url();
    // The run must start from the Sourcing search page. If the browser was left on a project page (e.g. after a previous run), go back to the home page.
    if (!(await page.locator(cfg.search.inputSelector).first().waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false))) {
      const home = homeUrlFrom(startUrl);
      if (home) {
        await page.goto(home, { waitUntil: 'domcontentloaded', timeout: cfg.timeouts.pageMs }).catch(() => {});
        await settle(page, cfg);
        if (await page.locator(cfg.search.inputSelector).first().waitFor({ state: 'visible', timeout: cfg.timeouts.searchMs }).then(() => true, () => false)) startUrl = home;
      }
    }
    const now = new Date();
    const runId = tracker.localStamp(now).replace(/[ :]/g, '-');
    cleanOldDebug(cfg.keepDebugDays);
    const state = await tracker.load(trackerFile);
    job.total = numbers.length; job.trackerFile = path.basename(trackerFile);
    const runInfo = { id: runId, now, today: tracker.localDateOnlyUtc(now), order: 0 };
    let changed = 0;
    const counts = { SUCCESS: 0, NOT_FOUND: 0, ERROR: 0 };
    for (let i = 0; i < numbers.length && !job.stop; i++) {
      const number = numbers[i];
      job.current = number; job.index = i + 1;
      let outcome;
      try { outcome = await lookupOne(number, cfg, startUrl); }
      catch (e) { outcome = { kind: 'error', reason: String(e.message || e).split('\n')[0].slice(0, 300) }; }
      if (outcome.kind !== 'ok') await saveDebug(runId, number, outcome.kind + ': ' + (outcome.reason || ''));
      runInfo.order = i;
      const r = tracker.apply(state, number, outcome, runInfo);
      if (r.changed) changed++;
      const row = state.current.find(x => x.pr === number);
      counts[row.result]++;
      job.counts = { ...counts };
      job.recent.push({ number, result: row.result, step: row.step, stepStatus: row.stepStatus, days: row.days, change: row.change, reason: row.reason });
      job.recent = job.recent.slice(-200);
      await persist(state);
      if (i < numbers.length - 1 && !job.stop) await sleep(cfg.pauseBetweenRowsMs);
    }
    state.runLog.push([runId, tracker.localStamp(now), tracker.localStamp(new Date()), opts.sourceName || '', job.index, counts.SUCCESS, counts.NOT_FOUND, counts.ERROR, changed, job.stop ? 'stopped' : 'done']);
    await persist(state);
    job.changed = changed;
    // Leave the browser on the search page so the next run can start right away.
    const end = getPage();
    if (end && !end.isClosed()) await end.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: cfg.timeouts.pageMs }).catch(() => {});
  }

  async function persist(state) {
    try { await tracker.save(trackerFile, state); }
    catch (e) {
      const alt = trackerFile.replace(/\.xlsx$/, '_' + Date.now() + '.xlsx');
      await tracker.save(alt, state);
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
      if (!page || page.isClosed()) throw new Error('Open the portal and log in first, then go to the Sourcing search page.');
      if (!opts.numbers || !opts.numbers.length) throw new Error('No PR numbers were found in the workbook.');
      loadConfig();
      job = { state: 'running', stop: false, message: '', startedAt: new Date().toISOString(), index: 0, total: 0, current: '', counts: {}, recent: [], trackerFile: '' };
      run(opts).then(() => { job.state = job.stop ? 'stopped' : 'done'; job.finishedAt = new Date().toISOString(); })
        .catch(e => { job.state = 'failed'; job.message = String(e.message || e); job.finishedAt = new Date().toISOString(); });
      return { ok: true };
    }
  };
}

module.exports = { createLookup, valueForLabels, pickCurrentStep, tasksFn, loadConfig };
