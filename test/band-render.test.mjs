import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { BAND_LAYOUT } from '../packages/dag/src/controller.mjs';
import { t as dagText } from '../packages/dag/src/i18n.mjs';
import { t as todoText } from '../packages/todo/src/i18n.mjs';
import { OWNER_REGION, ROLES, TERMINALS, bandPanes, dashboardState, freshPanes, renderRole, renderTodo,
  todoSnapshot } from './helpers/band-render.mjs';

const LANGUAGES = ['en', 'ko', 'zh-cn'];
// Independent cell oracle, not the renderers' width(): Hangul and CJK take two cells, every other glyph one.
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;
const cells = line => [...line].reduce((total, character) => total + (WIDE.test(character) ? 2 : 1), 0);
const size = ({ columns, rows }) => `${columns}x${rows}`;

// One line per pane row, and every line leaves the pane's last cell free (the renderers' ConPTY rule).
function assertFrame(lines, { columns, rows }, label) {
  assert.equal(lines.length, rows, `${label}: line count`);
  for (const line of lines) assert.ok(cells(line) < columns, `${label}: ${JSON.stringify(line)} is ${cells(line)} cells`);
}

function assertTodo(pane, language, label) {
  const snapshot = todoSnapshot();
  const { frame, target } = renderTodo(snapshot, { ...pane, language });
  const lines = frame.lines.map(line => stripVTControlCharacters(line));
  assertFrame(lines, pane, label);
  // The current target: named on the Now line, and its marked row is in view.
  const lead = [...target.content].slice(0, 4).join('');
  assert.ok(lines.some(line => line.startsWith(`${todoText(language, 'now')}: ${lead}`)), `${label}: Now line`);
  const range = frame.taskRanges[target.key];
  assert.ok(range.start >= frame.scroll && range.start < frame.scroll + frame.bodyRows, `${label}: target row in view`);
  assert.ok(lines[frame.bodyStart + range.start - frame.scroll].startsWith(`[•] ${lead}`), `${label}: target row`);
  assert.ok(frame.lines[frame.bodyStart + range.start - frame.scroll].startsWith('\x1b[1;36m[•] '), `${label}: bold target row`);
  const footer = lines.at(-1);
  // The footer sits one column in from the pane edge.
  assert.ok(['followOn', 'followShortOn'].some(key => footer.startsWith(` ${todoText(language, key)}`)) &&
    footer.includes(todoText(language, 'current')), `${label}: footer ${footer}`);
}

function assertRole(role, pane, language, label) {
  const state = dashboardState(language);
  const { frame, target } = renderRole(state, role, pane);
  const lines = stripVTControlCharacters(frame.text).split('\n');
  assertFrame(lines, pane, label);
  // The running node or task is inside the visible body with its spinner and the start of its name.
  const range = role === 'dag' ? frame.graphRanges[target.nodeId] : frame.taskRanges[target.taskId];
  const shown = lines.slice(frame.bodyStart + Math.max(0, range.start - frame.scroll),
    frame.bodyStart + Math.min(frame.bodyRows, range.end - frame.scroll)).join('\n');
  const name = role === 'dag' ? state.runs[0].nodes.find(node => node.id === target.nodeId).label :
    state.tasks.find(task => task.id === target.taskId).description;
  assert.match(shown, /⠋/, `${label}: running spinner`);
  assert.ok(shown.includes([...name].slice(0, 2).join('')), `${label}: current target ${name}`);
  // Follow and live state; below 40 usable columns (the last cell stays free) in the narrow form.
  const narrow = pane.columns - 1 < 40;
  const footer = lines.at(-1);
  assert.ok(footer.startsWith(` ${dagText(language, narrow ? 'followShortOn' : 'followOn')} · ${dagText(language, 'liveShort')}`),
    `${label}: footer ${footer}`);
  return lines;
}

const assertPane = (role, pane, label) => {
  for (const language of LANGUAGES) {
    if (role === 'todo') assertTodo(pane, language, `${label} ${language}`);
    else assertRole(role, pane, language, `${label} ${language}`);
  }
};

test('band pane sizes come from BAND_LAYOUT: a fresh 172x46 dashboard is Todo 86x16, workers 34x30 and DAG 52x30', () => {
  assert.deepEqual(ROLES.map(role => size(freshPanes({ width: 172, height: 46 })[role])), ['86x16', '34x30', '52x30']);
  // The owner's live dashboard area keeps 88 of 172 columns after an in-place migration.
  assert.deepEqual(ROLES.map(role => size(bandPanes(OWNER_REGION)[role])), ['88x16', '35x30', '53x30']);
});

for (const terminal of TERMINALS) for (const role of ROLES) {
  const pane = freshPanes(terminal)[role];
  test(`band ${role} pane of a fresh ${terminal.width}x${terminal.height} dashboard renders ${size(pane)} with its current target and footer`,
    () => assertPane(role, pane, `${role} ${size(pane)}`));
}

for (const role of ROLES) {
  const pane = bandPanes(OWNER_REGION)[role];
  test(`band ${role} pane of the owner's 88-column dashboard at 172x46 renders ${size(pane)} with its current target and footer`,
    () => assertPane(role, pane, `${role} ${size(pane)}`));
}

test('a workers pane narrower than minWorkersColumns renders the narrow fallback without overflow', () => {
  const columns = BAND_LAYOUT.minWorkersColumns - 1;
  for (const terminal of TERMINALS) for (const language of LANGUAGES) {
    const pane = { columns, rows: freshPanes(terminal).workers.rows };
    const lines = assertRole('workers', pane, language, `workers ${size(pane)} ${language}`);
    assert.ok(lines.at(-1).startsWith(` ${dagText(language, 'followShortOn')}`), `workers ${size(pane)} ${language}: narrow footer`);
  }
});
