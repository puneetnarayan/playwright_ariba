// Persistent PR status tracker workbook: current status per PR, a history of every step change, and a run log.
// The workbook itself is the state: each run reads it, updates it and writes it back.
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const GREEN = 'FFD9F2D9', RED = 'FFF8D0D0';
const CURRENT_COLS = [
  ['PR Number', 'pr', 16], ['Event Title', 'title', 44], ['Project ID', 'projectId', 16], ['Current Phase', 'phase', 22], ['Sub Phase', 'subPhase', 24],
  ['Current Step', 'step', 44], ['Step Status', 'stepStatus', 14], ['Step Owner', 'owner', 20], ['Other In-Progress Steps', 'others', 36],
  ['Step First Seen', 'firstSeen', 16], ['Days at Step', 'days', 12], ['Change This Run', 'change', 22], ['Last Checked', 'lastChecked', 20], ['Result', 'result', 12], ['Reason / Notes', 'reason', 50]
];
const HISTORY_COLS = [['PR Number', 22], ['Detected On', 14], ['Detected At', 12], ['Event', 24], ['Phase', 22], ['Sub Phase', 24], ['Step', 44], ['Step Status', 14], ['Owner', 20], ['Previous Step', 44], ['Previous Status', 14], ['Run ID', 20]];
const RUNLOG_COLS = [['Run ID', 20], ['Started', 20], ['Finished', 20], ['Input File', 36], ['PRs Checked', 12], ['Success', 10], ['Not Found', 11], ['Error', 8], ['New / Changed', 14], ['Run Status', 12], ['App Version', 12]];

const pad = n => String(n).padStart(2, '0');
const localDateOnlyUtc = d => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));   // Excel date at midnight, no timezone drift
const localStamp = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
const daysBetweenUtc = (a, b) => Math.round((b - a) / 86400000);
const cellText = v => v === null || v === undefined ? '' : (typeof v === 'object' && v.richText ? v.richText.map(t => t.text).join('') : typeof v === 'object' && v.text !== undefined ? String(v.text) : String(v));

async function load(file) {
  const state = { current: [], history: [], runLog: [] };
  if (!file || !fs.existsSync(file)) return state;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const cur = wb.getWorksheet('Current Status');
  if (cur) {
    const headers = []; cur.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { headers[i] = cellText(c.value); });
    cur.eachRow((row, n) => {
      if (n === 1) return;
      const o = {};
      for (const [title, key] of CURRENT_COLS) {
        const i = headers.indexOf(title); if (i < 1) continue;
        const v = row.getCell(i).value;
        o[key] = key === 'firstSeen' ? (v instanceof Date ? v : null) : (key === 'days' ? (v === '' || v === null ? '' : Number(v)) : cellText(v));
      }
      if (o.pr) state.current.push(o);
    });
  }
  const readRows = (name, width) => {
    const ws = wb.getWorksheet(name), out = [];
    if (!ws) return out;
    ws.eachRow((row, n) => { if (n === 1) return; const a = []; for (let i = 1; i <= width; i++) { const v = row.getCell(i).value; a.push(v instanceof Date ? v : (typeof v === 'number' ? v : cellText(v))); } out.push(a); });
    return out;
  };
  state.history = readRows('Step History', HISTORY_COLS.length);
  state.runLog = readRows('Run Log', RUNLOG_COLS.length);
  return state;
}

// Applies one lookup outcome to the state. outcome: {kind:'ok'|'not_found'|'error', ...fields}
function apply(state, pr, outcome, run) {
  let row = state.current.find(r => r.pr === pr);
  if (!row) { row = { pr, title: '', projectId: '', phase: '', subPhase: '', step: '', stepStatus: '', owner: '', others: '', firstSeen: null, days: '', change: '', lastChecked: '', result: '', reason: '' }; state.current.push(row); }
  row._checked = true; row._order = run.order;
  row.lastChecked = localStamp(run.now);
  if (outcome.kind !== 'ok') {
    row.result = outcome.kind === 'not_found' ? 'NOT_FOUND' : 'ERROR';
    row.reason = outcome.reason || '';
    row.change = outcome.kind === 'not_found' ? 'Not found' : 'Check failed';
    if (row.firstSeen) row.days = daysBetweenUtc(row.firstSeen, run.today);
    return { changed: false };
  }
  const prevStep = row.step, prevStatus = row.stepStatus;
  Object.assign(row, { title: outcome.title || row.title, projectId: outcome.projectId || row.projectId, phase: outcome.phase, subPhase: outcome.subPhase, step: outcome.step, stepStatus: outcome.stepStatus, owner: outcome.owner, others: outcome.others, result: 'SUCCESS', reason: outcome.note || '' });
  let event = '';
  if (!prevStep) event = 'First check (baseline)';
  else if (prevStep !== outcome.step) event = 'Step changed';
  else if (prevStatus !== outcome.stepStatus) event = 'Step status changed';
  if (event) {
    row.firstSeen = run.today;
    row.change = event === 'First check (baseline)' ? 'New PR (baseline)' : event;
    state.history.push([pr, run.today, run.now.getHours() * 3600 / 86400 + run.now.getMinutes() * 60 / 86400, event, outcome.phase, outcome.subPhase, outcome.step, outcome.stepStatus, outcome.owner, prevStep || '', prevStatus || '', run.id]);
  } else row.change = 'No change';
  row.days = daysBetweenUtc(row.firstSeen || run.today, run.today);
  return { changed: !!event };
}

async function save(file, state) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Current Status');
  ws.addRow(CURRENT_COLS.map(c => c[0])).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 1 }];
  CURRENT_COLS.forEach((c, i) => { ws.getColumn(i + 1).width = c[2]; });
  const checked = state.current.filter(r => r._checked).sort((a, b) => a._order - b._order);
  const rest = state.current.filter(r => !r._checked);
  for (const r of [...checked, ...rest]) {
    const row = ws.addRow(CURRENT_COLS.map(c => c[1] === 'firstSeen' ? (r.firstSeen || '') : (r[c[1]] === undefined ? '' : r[c[1]])));
    row.getCell(CURRENT_COLS.findIndex(c => c[1] === 'firstSeen') + 1).numFmt = 'dd-mmm-yyyy';
    if (!r._checked) { row.getCell(12).value = 'Not in latest input'; continue; }
    const argb = r.result === 'SUCCESS' ? GREEN : RED;
    for (let c = 1; c <= CURRENT_COLS.length; c++) row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
  }
  const hs = wb.addWorksheet('Step History');
  hs.addRow(HISTORY_COLS.map(c => c[0])).font = { bold: true };
  hs.views = [{ state: 'frozen', ySplit: 1 }];
  HISTORY_COLS.forEach((c, i) => { hs.getColumn(i + 1).width = c[1]; });
  state.history.forEach(h => { const row = hs.addRow(h); row.getCell(2).numFmt = 'dd-mmm-yyyy'; row.getCell(3).numFmt = 'hh:mm'; });
  const rs = wb.addWorksheet('Run Log');
  rs.addRow(RUNLOG_COLS.map(c => c[0])).font = { bold: true };
  RUNLOG_COLS.forEach((c, i) => { rs.getColumn(i + 1).width = c[1]; });
  state.runLog.forEach(r => rs.addRow(r));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await wb.xlsx.writeFile(tmp);
  fs.renameSync(tmp, file);   // fails (EBUSY/EPERM) while the file is open in Excel; the caller falls back to another name
}

module.exports = { load, apply, save, localDateOnlyUtc, localStamp };
