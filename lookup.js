// Read-only row-by-row PR lookup: reads numbers from the uploaded workbook, looks each one up in the
// already-logged-in Playwright page, and writes a colour-coded results workbook.
// It only types into the search box and clicks the search button, the result link and configured tabs.
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const CONFIG_FILE = path.join(__dirname, 'lookup-config.json');
const DEFAULTS = {
  search: { inputSelector: '', buttonSelector: '', pressEnterInstead: false },
  result: { linkSelector: '' },
  afterOpen: [],
  stage: { selector: '', labels: ['Status'] },
  stageDate: { selector: '', labels: [], order: 'DMY' },
  timeouts: { searchMs: 20000, pageMs: 20000, loginWaitMinutes: 10 },
  pauseBetweenRowsMs: 1500
};
const GREEN = 'FFD9F2D9', RED = 'FFF8D0D0';
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

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// Returns a local Date (time kept) or null. order = 'DMY' | 'MDY' applies only to all-numeric dates like 05/10/2026.
function parseDate(text, order) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  m = s.match(/(\d{1,2})[\s\-\/]([A-Za-z]{3})[a-z]*[\s\-\/,]+(\d{4})(?:\D+(\d{1,2}):(\d{2})\s*(AM|PM)?)?/i);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) return build(+m[3], MONTHS[m[2].toLowerCase()], +m[1], m[4], m[5], m[6]);
  m = s.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})(?:\D+(\d{1,2}):(\d{2})\s*(AM|PM)?)?/i);
  if (m && MONTHS[m[1].toLowerCase()] !== undefined) return build(+m[3], MONTHS[m[1].toLowerCase()], +m[2], m[4], m[5], m[6]);
  m = s.match(/(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{4})(?:\D+(\d{1,2}):(\d{2})\s*(AM|PM)?)?/i);
  if (m) {
    const a = +m[1], b = +m[2];
    const [d, mo] = order === 'MDY' ? [b, a] : [a, b];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return build(+m[3], mo - 1, d, m[4], m[5], m[6]);
  }
  return null;
}
function build(y, mo, d, h, mi, ap) {
  let hh = +(h || 0);
  if (ap) { ap = ap.toUpperCase(); if (ap === 'PM' && hh < 12) hh += 12; if (ap === 'AM' && hh === 12) hh = 0; }
  return new Date(y, mo, d, hh, +(mi || 0));
}
function daysBetween(then, now = new Date()) {
  const a = new Date(then.getFullYear(), then.getMonth(), then.getDate()), b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b - a) / 86400000);
}

// Pull "Label: value" or "Label" / next line "value" out of visible text lines.
function valueForLabels(lines, labels) {
  for (const label of labels) {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const inline = new RegExp('^' + esc + '\\s*[:\\-]\\s*(.+)$', 'i');
    for (let i = 0; i < lines.length; i++) {
      const im = lines[i].match(inline);
      if (im && im[1].trim()) return { value: im[1].trim(), label };
      if (lines[i].replace(/\s*[:\-]$/, '').toLowerCase() === label.toLowerCase()) {
        for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) if (lines[j].trim()) return { value: lines[j].trim(), label };
      }
    }
  }
  return null;
}

function createLookup({ getPage, isRecording, outDir, readRows }) {
  const debugRoot = path.join(outDir, 'lookup_debug');
  let job = null;

  async function visibleText(page) {
    const chunks = [];
    for (const f of page.frames()) {
      try { chunks.push(await f.evaluate(() => document.body ? document.body.innerText : '')); } catch { /* detached frame */ }
    }
    return chunks.join('\n');
  }
  const hasLoginForm = async page => {
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
      if (page && !page.isClosed() && !(await hasLoginForm(page))) { job.state = 'running'; job.message = ''; return true; }
    }
    return false;
  }

  async function lookupOne(number, cfg, startUrl, debugBase) {
    let page = getPage();
    if (!page || page.isClosed()) throw new Error('The Playwright browser window was closed.');
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: cfg.timeouts.pageMs }).catch(() => {});
    await settle(page, cfg);
    if (await hasLoginForm(page)) {
      if (!(await waitForLogin(cfg))) throw new Error('Session expired and login was not completed in time.');
      page = getPage();
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: cfg.timeouts.pageMs }).catch(() => {});
      await settle(page, cfg);
    }
    const input = page.locator(cfg.search.inputSelector).first();
    try { await input.waitFor({ state: 'visible', timeout: cfg.timeouts.searchMs }); }
    catch { throw new Error('Search box not found with selector ' + cfg.search.inputSelector + ' (is the browser on the search page?).'); }
    await input.fill(number);
    if (cfg.search.pressEnterInstead) await input.press('Enter');
    else await page.locator(cfg.search.buttonSelector).first().click({ timeout: cfg.timeouts.searchMs });
    await settle(page, cfg);

    const linkLoc = cfg.result.linkSelector
      ? page.locator(cfg.result.linkSelector)
      : page.locator('a', { hasText: number });
    const deadline = Date.now() + cfg.timeouts.pageMs;
    let count = 0;
    while (Date.now() < deadline) { count = await linkLoc.count(); if (count) break; await sleep(500); }
    if (!count) { await saveDebug(page, debugBase, 'no result link'); return { found: false }; }

    let pick = 0, note = '';
    if (count > 1) {
      const texts = await linkLoc.allInnerTexts();
      const exact = texts.findIndex(t => t.trim().startsWith(number));
      pick = exact >= 0 ? exact : 0;
      note = count + ' matching links; used #' + (pick + 1);
    }
    const title = ((await linkLoc.nth(pick).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    await linkLoc.nth(pick).click({ timeout: cfg.timeouts.pageMs });
    await settle(page, cfg);
    page = getPage();

    for (const step of cfg.afterOpen || []) {
      if (!step.clickText) continue;
      const tab = page.getByText(step.clickText, { exact: false }).first();
      try { await tab.click({ timeout: 8000 }); await settle(page, cfg); } catch { note += (note ? '; ' : '') + 'could not open "' + step.clickText + '"'; }
    }

    const text = await visibleText(page);
    const lines = text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    let stage = null, since = null;
    if (cfg.stage.selector) { const t = await page.locator(cfg.stage.selector).first().innerText().catch(() => ''); if (t.trim()) stage = { value: t.replace(/\s+/g, ' ').trim(), label: 'selector' }; }
    if (!stage && cfg.stage.labels.length) stage = valueForLabels(lines, cfg.stage.labels);
    if (cfg.stageDate.selector) { const t = await page.locator(cfg.stageDate.selector).first().innerText().catch(() => ''); if (t.trim()) since = { value: t.replace(/\s+/g, ' ').trim(), label: 'selector' }; }
    if (!since && cfg.stageDate.labels.length) since = valueForLabels(lines, cfg.stageDate.labels);
    await saveDebug(page, debugBase, null, text);
    return { found: true, title, note, stage: stage && stage.value, stageLabel: stage && stage.label, sinceText: since && since.value, sinceLabel: since && since.label };
  }

  async function saveDebug(page, base, why, text) {
    try {
      fs.mkdirSync(path.dirname(base), { recursive: true });
      await page.screenshot({ path: base + '.jpg', type: 'jpeg', quality: 55, timeout: 8000 }).catch(() => {});
      fs.writeFileSync(base + '.txt', (why ? '[' + why + ']\n' : '') + (text !== undefined ? text : await visibleText(page)));
    } catch { /* debug is best effort */ }
  }

  async function writeWorkbook(file, headers, rows) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Results');
    const extra = ['Current Stage', 'Stage Since', 'Days at Stage', 'Result', 'Reason', 'Event Title', 'Checked At'];
    ws.addRow([...headers, ...extra]).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of rows) {
      const row = ws.addRow([...r.original, r.stage || '', r.since || '', r.days === null || r.days === undefined ? '' : r.days, r.result, r.reason || '', r.title || '', r.checkedAt]);
      const argb = r.result === 'SUCCESS' ? GREEN : RED;
      for (let c = 1; c <= headers.length + extra.length; c++) row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
    }
    ws.columns.forEach(col => { col.width = 22; });
    const dbg = wb.addWorksheet('Debug');
    dbg.addRow(['Lookup value', 'Result', 'Stage label matched', 'Date label matched', 'Raw date text', 'Screenshot', 'Page text']).font = { bold: true };
    for (const r of rows) dbg.addRow([r.number, r.result, r.stageLabel || '', r.sinceLabel || '', r.sinceText || '', r.debugFile ? r.debugFile + '.jpg' : '', r.debugFile ? r.debugFile + '.txt' : '']);
    dbg.columns.forEach(col => { col.width = 30; });
    const tmp = file + '.tmp';
    await wb.xlsx.writeFile(tmp);
    fs.renameSync(tmp, file);
  }

  async function run(opts) {
    const cfg = loadConfig();
    const { headers, dataRows } = readRows(opts.sheetName);
    const colIdx = headers.indexOf(opts.column);
    const page = getPage();
    const startUrl = page.url();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outFile = path.join(outDir, 'PR_status_results_' + stamp + '.xlsx');
    job.outFile = path.basename(outFile);
    job.total = dataRows.length;
    const cache = new Map();
    const results = [];
    for (let i = 0; i < dataRows.length && !job.stop; i++) {
      const original = headers.map((_, c) => dataRows[i][c] === undefined ? '' : dataRows[i][c]);
      const number = String(dataRows[i][colIdx] === undefined ? '' : dataRows[i][colIdx]).trim();
      const res = { original, number, result: 'ERROR', reason: '', checkedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) };
      job.current = number; job.index = i + 1;
      try {
        if (!number) { res.result = 'ERROR'; res.reason = 'Empty lookup value'; }
        else {
          const debugBase = path.join(debugRoot, stamp, String(i + 1).padStart(4, '0') + '_' + number.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40));
          let r = cache.get(number);
          if (!r) { r = await lookupOne(number, cfg, startUrl, debugBase); r.debugFile = path.relative(outDir, debugBase).split(path.sep).join('/'); cache.set(number, r); }
          res.debugFile = r.debugFile; res.title = r.title; res.stageLabel = r.stageLabel; res.sinceLabel = r.sinceLabel; res.sinceText = r.sinceText;
          if (!r.found) { res.result = 'NOT_FOUND'; res.reason = 'No result found for this number in the portal search'; }
          else {
            res.stage = r.stage;
            const d = r.sinceText ? parseDate(r.sinceText, cfg.stageDate.order) : null;
            if (d) { res.since = d.toISOString().slice(0, 10); res.days = daysBetween(d); }
            const problems = [];
            if (!r.stage) problems.push('Stage not found on the page (check labels in lookup-config.json; see Debug sheet)');
            if (!r.sinceText) problems.push('Stage date not found'); else if (!d) problems.push('Could not read date "' + r.sinceText + '"');
            if (r.note) problems.push(r.note);
            if (r.stage && d) { res.result = 'SUCCESS'; res.reason = r.note || ''; }
            else { res.result = 'ERROR'; res.reason = problems.join('; '); }
          }
        }
      } catch (e) { res.result = 'ERROR'; res.reason = String(e.message || e).split('\n')[0].slice(0, 300); }
      results.push(res);
      job.counts[res.result] = (job.counts[res.result] || 0) + 1;
      job.recent = results.slice(-200).map(x => ({ number: x.number, result: x.result, stage: x.stage || '', days: x.days === undefined ? '' : x.days, reason: x.reason }));
      await writeWorkbook(outFile, headers, results);
      if (i < dataRows.length - 1 && !job.stop) await sleep(cfg.pauseBetweenRowsMs);
    }
    job.processed = results.length;
  }

  return {
    status() { return job ? { ...job } : { state: 'idle' }; },
    file() { return job && job.outFile ? path.join(outDir, job.outFile) : null; },
    stop() { if (job && (job.state === 'running' || job.state === 'waiting-login')) { job.stop = true; return true; } return false; },
    async start(opts) {
      if (job && (job.state === 'running' || job.state === 'waiting-login')) throw new Error('A lookup run is already active.');
      if (isRecording()) throw new Error('Stop recording before running the lookup.');
      const page = getPage();
      if (!page || page.isClosed()) throw new Error('Open the portal and log in first, then go to the search page.');
      loadConfig();
      job = { state: 'running', stop: false, message: '', startedAt: new Date().toISOString(), index: 0, total: 0, current: '', counts: {}, recent: [], outFile: '' };
      run(opts).then(() => { job.state = job.stop ? 'stopped' : 'done'; job.finishedAt = new Date().toISOString(); })
        .catch(e => { job.state = 'failed'; job.message = String(e.message || e); job.finishedAt = new Date().toISOString(); });
      return { ok: true };
    }
  };
}

module.exports = { createLookup, parseDate, daysBetween, valueForLabels, loadConfig };
