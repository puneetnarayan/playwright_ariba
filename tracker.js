// Persistent PR status tracker workbook. The data columns come from the workflow's capture steps, so the same
// file layout works for any recorded workflow.
//   Current Status : one row per PR with the captured values, when they were first seen and how many days unchanged
//   Step History   : one row every time a PR's captured values change
//   Run Log        : one row per run
// The workbook itself is the state: each run reads it, updates it and writes it back.
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const GREEN = 'FFD9F2D9', RED = 'FFF8D0D0';
const pad = n => String(n).padStart(2, '0');
const localDateOnlyUtc = d => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));   // Excel date at midnight, no timezone drift
const localStamp = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
const daysBetweenUtc = (a, b) => Math.round((b - a) / 86400000);
const cellText = v => v === null || v === undefined ? '' : (typeof v === 'object' && v.richText ? v.richText.map(t => t.text).join('') : typeof v === 'object' && v.text !== undefined ? String(v.text) : String(v));

const TAIL = ['Data First Seen', 'Days Unchanged', 'Change This Run', 'Last Checked', 'Result', 'Reason / Notes'];
const currentHeaders = cols => ['PR Number', ...cols, ...TAIL];
const historyHeaders = cols => ['PR Number', 'Detected On', 'Detected At', 'Event', ...cols, 'Previous Values', 'Run ID'];
const RUNLOG_HEADERS = ['Run ID', 'Started', 'Finished', 'Input File', 'PRs Checked', 'Success', 'Not Found', 'Error', 'New / Changed', 'Run Status', 'App Version', 'Workflow'];

// Loads the tracker. If its data columns differ from the current workflow's, the old file is renamed and a fresh one starts.
async function load(file, cols) {
  const state = { current: [], history: [], runLog: [], rotatedTo: '' };
  if (!file || !fs.existsSync(file)) return state;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const cur = wb.getWorksheet('Current Status');
  const headers = [];
  if (cur) cur.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { headers[i - 1] = cellText(c.value); });
  const want = currentHeaders(cols);
  if (!cur || headers.length !== want.length || want.some((h, i) => headers[i] !== h)) {
    const old = file.replace(/\.xlsx$/, '_old_' + Date.now() + '.xlsx');
    fs.renameSync(file, old);
    state.rotatedTo = path.basename(old);
    return state;
  }
  cur.eachRow((row, n) => {
    if (n === 1) return;
    const vals = {};
    cols.forEach((c, i) => { vals[c] = cellText(row.getCell(2 + i).value); });
    const t = 2 + cols.length;
    const fs0 = row.getCell(t).value;
    const days = row.getCell(t + 1).value;
    const pr = cellText(row.getCell(1).value);
    if (!pr) return;
    state.current.push({ pr, vals, firstSeen: fs0 instanceof Date ? fs0 : null, days: days === '' || days === null ? '' : Number(days), change: cellText(row.getCell(t + 2).value), lastChecked: cellText(row.getCell(t + 3).value), result: cellText(row.getCell(t + 4).value), reason: cellText(row.getCell(t + 5).value) });
  });
  const readRows = (name, width) => {
    const ws = wb.getWorksheet(name), out = [];
    if (!ws) return out;
    ws.eachRow((row, n) => { if (n === 1) return; const a = []; for (let i = 1; i <= width; i++) { const v = row.getCell(i).value; a.push(v instanceof Date ? v : (typeof v === 'number' ? v : cellText(v))); } out.push(a); });
    return out;
  };
  state.history = readRows('Step History', historyHeaders(cols).length);
  state.runLog = readRows('Run Log', RUNLOG_HEADERS.length);
  return state;
}

const signature = (cols, vals) => cols.map(c => (vals[c] || '').trim()).join(' | ');

// Applies one outcome to the state. outcome: {kind:'ok'|'not_found'|'error', vals?, reason?, note?}
function apply(state, cols, pr, outcome, run) {
  let row = state.current.find(r => r.pr === pr);
  if (!row) { row = { pr, vals: {}, firstSeen: null, days: '', change: '', lastChecked: '', result: '', reason: '' }; state.current.push(row); }
  row._checked = true; row._order = run.order;
  row.lastChecked = localStamp(run.now);
  if (outcome.kind !== 'ok') {
    row.result = outcome.kind === 'not_found' ? 'NOT_FOUND' : 'ERROR';
    row.reason = outcome.reason || '';
    row.change = outcome.kind === 'not_found' ? 'Not found' : 'Check failed';
    if (row.firstSeen) row.days = daysBetweenUtc(row.firstSeen, run.today);
    return { changed: false };
  }
  const prevSig = row.firstSeen ? signature(cols, row.vals) : null;
  const newSig = signature(cols, outcome.vals);
  const previousValues = prevSig === null ? '' : prevSig;
  row.vals = { ...outcome.vals };
  row.result = 'SUCCESS';
  row.reason = outcome.note || '';
  let event = '';
  if (prevSig === null) event = 'First check (baseline)';
  else if (prevSig !== newSig) event = 'Data changed';
  if (event) {
    row.firstSeen = run.today;
    row.change = event === 'First check (baseline)' ? 'New PR (baseline)' : event;
    state.history.push([pr, run.today, run.now.getHours() / 24 + run.now.getMinutes() / 1440, event, ...cols.map(c => outcome.vals[c] || ''), previousValues, run.id]);
  } else row.change = 'No change';
  row.days = daysBetweenUtc(row.firstSeen || run.today, run.today);
  return { changed: !!event };
}

async function save(file, cols, state) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Current Status');
  const heads = currentHeaders(cols);
  ws.addRow(heads).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 1 }];
  heads.forEach((h, i) => { ws.getColumn(i + 1).width = i === 0 ? 16 : (i <= cols.length ? 30 : (h === 'Reason / Notes' ? 50 : 16)); });
  const seenIdx = 2 + cols.length;
  const checked = state.current.filter(r => r._checked).sort((a, b) => a._order - b._order);
  const rest = state.current.filter(r => !r._checked);
  for (const r of [...checked, ...rest]) {
    const row = ws.addRow([r.pr, ...cols.map(c => (r.vals && r.vals[c]) || ''), r.firstSeen || '', r.days === undefined ? '' : r.days, r._checked ? r.change : 'Not in latest input', r.lastChecked, r.result, r.reason]);
    row.getCell(seenIdx).numFmt = 'dd-mmm-yyyy';
    if (!r._checked) continue;
    const argb = r.result === 'SUCCESS' ? GREEN : RED;
    for (let c = 1; c <= heads.length; c++) row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
  }
  const hs = wb.addWorksheet('Step History');
  hs.addRow(historyHeaders(cols)).font = { bold: true };
  hs.views = [{ state: 'frozen', ySplit: 1 }];
  historyHeaders(cols).forEach((h, i) => { hs.getColumn(i + 1).width = i === 0 ? 16 : (i < 4 ? 16 : 30); });
  state.history.forEach(h => { const row = hs.addRow(h); row.getCell(2).numFmt = 'dd-mmm-yyyy'; row.getCell(3).numFmt = 'hh:mm'; });
  const rs = wb.addWorksheet('Run Log');
  rs.addRow(RUNLOG_HEADERS).font = { bold: true };
  RUNLOG_HEADERS.forEach((h, i) => { rs.getColumn(i + 1).width = i === 3 || i === 11 ? 36 : 16; });
  state.runLog.forEach(r => rs.addRow(r));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await wb.xlsx.writeFile(tmp);
  fs.renameSync(tmp, file);   // fails (EBUSY/EPERM) while the file is open in Excel; the caller falls back to another name
}

module.exports = { load, apply, save, localDateOnlyUtc, localStamp, signature };
