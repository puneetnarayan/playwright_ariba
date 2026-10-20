// Turns a recording into a replayable workflow, and stores the active workflow.
// Step kinds: type (fill a field), click, capture (read data by a rule).
// Capture rules (all built from text the user selected while recording):
//   row-by-status : in a table, the row whose Status cell equals the recorded status; read the recorded columns
//   label-value   : the value next to a label such as "Current Phase:"
//   same-element  : the element at the same place (fallback)
const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, 'default-workflow.json');
const PR_TOKEN = '{{PR}}';
const TASK_NAME = '^[A-Za-z0-9]{1,3}[.)]\\s*\\S';

const isLoginAction = a => /login\.microsoftonline\.com|login\.live\.com/i.test(a.url || '') || /^#idSIButton9$|KmsiCheckbox/i.test(a.selector || '');

function describeRule(rule) {
  if (!rule) return '';
  if (rule.type === 'row-by-status') return 'Row whose ' + (rule.statusHeader || 'Status') + ' is "' + rule.status + '" (' + (rule.colHeaders || []).map(h => h || 'column').join(', ') + ')';
  if (rule.type === 'label-value') return 'Value next to "' + rule.label + '"';
  return 'Same place on the page (' + (rule.selector || rule.cssPath || '?') + ')';
}

function uniqueName(name, used) {
  let n = name || 'Capture', k = 2;
  while (used.has(n.toLowerCase())) n = (name || 'Capture') + ' ' + k++;
  used.add(n.toLowerCase());
  return n;
}

// capture: a saved recording ({actions:[...]}). Returns a workflow object.
function buildFromCapture(capture, label) {
  const actions = (capture.actions || []).slice().sort((a, b) => (a.sequenceNo || 0) - (b.sequenceNo || 0));
  const steps = [];
  let prValue = '';
  const used = new Set();
  let lastClick = null;
  for (const a of actions) {
    if (isLoginAction(a) || a.blocked) continue;
    if (a.kind === 'change' && a.tag !== 'select' && a.value && a.value !== '[REDACTED]' && !/REDACTED/.test(a.value)) {
      const isCheck = /^(true|false|checked|unchecked|on)$/i.test(a.value);
      if (isCheck) continue;
      if (!prValue && /^\d{5,}$/.test(a.value)) prValue = a.value;
      steps.push({ kind: 'type', include: true, optional: false, label: 'Type in "' + (a.field || a.selector) + '"', target: { selector: a.selector || '', tag: a.tag || 'input', cssPath: a.cssPath || '' }, value: a.value });
    } else if (a.kind === 'click' || a.kind === 'component-click') {
      const prev = steps[steps.length - 1];
      // Collapse a repeated click on the same thing (double clicks, focus clicks)
      if (prev && prev.kind === 'click' && prev.target.selector === (a.selector || '') && prev.target.text === (a.text || '')) continue;
      steps.push({ kind: 'click', include: a.kind === 'click', optional: false, label: 'Click ' + ((a.text || a.selector || a.tag || '').slice(0, 60)), target: { selector: a.selector || '', tag: a.tag || '', role: a.role || '', text: a.text || '', cssPath: a.cssPath || '' } });
      lastClick = a;
    } else if (a.kind === 'capture' && a.rule) {
      const cols = (a.columns && a.columns.length ? a.columns : [a.rule.label || 'Capture']).map(n => uniqueName(n, used));
      steps.push({ kind: 'capture', include: true, optional: false, label: 'Capture ' + cols.join(', '), rule: a.rule, columns: cols, sample: (a.text || '').slice(0, 200) });
    }
  }
  // Only the part of the recording from the first typed value onward is replayed (anything before is login/landing noise).
  const firstType = steps.findIndex(s => s.kind === 'type');
  const trimmed = firstType > 0 ? steps.slice(firstType) : steps;
  trimmed.forEach((s, i) => { s.id = i + 1; });
  // Replace the recorded PR number with a token everywhere it appears.
  if (prValue) {
    for (const s of trimmed) {
      if (s.kind === 'type' && s.value === prValue) s.value = PR_TOKEN;
      if (s.kind === 'click' && s.target.text) s.target.text = s.target.text.split(prValue).join(PR_TOKEN);
    }
  }
  return {
    name: label || capture.recordingName || 'Recorded workflow',
    source: capture.recordingFileStem || '',
    prValue: prValue || '',
    notFoundText: 'Search Result\\s+0\\s+project|No (results|items) found',
    verifyNumberOnPage: true,
    steps: trimmed
  };
}

function summarise(wf) {
  return {
    name: wf.name, source: wf.source || '', prValue: wf.prValue || '', verifyNumberOnPage: wf.verifyNumberOnPage !== false, notFoundText: wf.notFoundText || '',
    steps: (wf.steps || []).map(s => ({ ...s, ruleText: describeRule(s.rule) }))
  };
}

function makeStore(dir) {
  const file = path.join(dir, 'active_workflow.json');
  return {
    file,
    load() {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none saved yet */ }
      return JSON.parse(fs.readFileSync(DEFAULT_FILE, 'utf8'));
    },
    save(wf) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(wf, null, 2)); },
    reset() { try { fs.unlinkSync(file); } catch { /* already default */ } return JSON.parse(fs.readFileSync(DEFAULT_FILE, 'utf8')); }
  };
}

// Validates an edited workflow coming from the UI and returns a clean copy.
function sanitise(wf) {
  if (!wf || !Array.isArray(wf.steps)) throw new Error('The workflow has no steps.');
  const used = new Set();
  const steps = wf.steps.map((s, i) => {
    const out = { ...s, id: i + 1, include: !!s.include, optional: !!s.optional };
    delete out.ruleText;
    if (s.kind === 'capture') out.columns = (s.columns || []).map((n, k) => uniqueName(String(n || '').trim() || ('Capture ' + (k + 1)), used));
    return out;
  });
  if (!steps.some(s => s.include && s.kind === 'capture')) throw new Error('Select at least one capture step: the output needs some data to read.');
  if (!steps.some(s => s.include && s.kind === 'type')) throw new Error('The workflow needs a step that types the PR number.');
  if (!steps.some(s => s.include && s.kind === 'type' && String(s.value || '').includes(PR_TOKEN))) throw new Error('No typing step uses the PR number. Type the PR number into the search box while recording, or put {{PR}} in the value.');
  return { ...wf, steps };
}

module.exports = { buildFromCapture, makeStore, summarise, sanitise, describeRule, PR_TOKEN, TASK_NAME };
