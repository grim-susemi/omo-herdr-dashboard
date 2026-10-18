import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BAND_LAYOUT, isBandDashboard, isColumnDashboard } from '../src/controller.mjs';

const ids = { parent: 'parent', todo: 'todo', workers: 'workers', dag: 'dag' };
const ROLES = Object.keys(ids);
const KEYS = ['x', 'y', 'width', 'height'];

// Measured target rects (task-1-tree.md section 2, chat at 40 percent).
const TARGETS = {
  '172x46': { area: [172, 46], parent: [0, 0, 69, 46], todo: [69, 0, 103, 16], workers: [69, 16, 41, 30], dag: [110, 16, 62, 30] },
  '120x40': { area: [120, 40], parent: [0, 0, 48, 40], todo: [48, 0, 72, 14], workers: [48, 14, 29, 26], dag: [77, 14, 43, 26] },
  '100x30': { area: [100, 30], parent: [0, 0, 40, 30], todo: [40, 0, 60, 11], workers: [40, 11, 24, 19], dag: [64, 11, 36, 19] },
};
const rect = ([x, y, width, height]) => ({ x, y, width, height });
function layoutOf(spec) {
  return {
    area: { x: 0, y: 0, width: spec.area[0], height: spec.area[1] },
    panes: ROLES.map(role => ({ pane_id: ids[role], rect: rect(spec[role]) })),
  };
}
const paneOf = (layout, role) => layout.panes.find(pane => pane.pane_id === ids[role]);

// Same columns fixture as test/column-layout.test.mjs:5-14.
const columns = {
  area: { x: 0, y: 0, width: 172, height: 46 },
  panes: [
    { pane_id: 'parent', rect: { x: 0, y: 0, width: 68, height: 46 } },
    { pane_id: 'todo', rect: { x: 68, y: 0, width: 52, height: 23 } },
    { pane_id: 'workers', rect: { x: 68, y: 23, width: 52, height: 23 } },
    { pane_id: 'dag', rect: { x: 120, y: 0, width: 52, height: 46 } },
  ],
};

test('band dashboard is true for the measured target rects at 172x46, 120x40 and 100x30', () => {
  for (const [size, spec] of Object.entries(TARGETS)) {
    assert.equal(isBandDashboard(layoutOf(spec), ids), true, size);
  }
});

test('band dashboard is false when any role is off by one cell in any dimension', () => {
  let probes = 0;
  for (const [size, spec] of Object.entries(TARGETS)) {
    for (const role of ROLES) {
      for (const key of KEYS) {
        for (const delta of [-1, 1]) {
          const broken = layoutOf(spec);
          paneOf(broken, role).rect[key] += delta;
          assert.equal(isBandDashboard(broken, ids), false, `${size} ${role}.${key}${delta > 0 ? '+1' : '-1'}`);
          probes++;
        }
      }
    }
  }
  assert.equal(probes, 3 * 4 * 4 * 2);
});

test('band dashboard is false when workers and DAG are swapped', () => {
  for (const [size, spec] of Object.entries(TARGETS)) {
    const swapped = layoutOf(spec);
    const workers = paneOf(swapped, 'workers'), dag = paneOf(swapped, 'dag');
    workers.pane_id = ids.dag;
    dag.pane_id = ids.workers;
    assert.equal(isBandDashboard(swapped, ids), false, size);
  }
});

test('band dashboard is false with a foreign pane, whether extra or in place of a role', () => {
  for (const [size, spec] of Object.entries(TARGETS)) {
    const extra = layoutOf(spec);
    extra.panes.push({ pane_id: 'foreign', rect: rect(spec.parent) });
    assert.equal(isBandDashboard(extra, ids), false, `${size} extra`);
    const replaced = layoutOf(spec);
    paneOf(replaced, 'dag').pane_id = 'foreign';
    assert.equal(isBandDashboard(replaced, ids), false, `${size} replaced`);
  }
});

test('band dashboard is false for the columns fixture, and the columns detector is unchanged', () => {
  assert.equal(isBandDashboard(columns, ids), false);
  assert.equal(isColumnDashboard(columns, ids), true);
  for (const [size, spec] of Object.entries(TARGETS)) {
    assert.equal(isColumnDashboard(layoutOf(spec), ids), false, `${size} band is not columns`);
  }
});

test('band dashboard checks shape only: any split ratios that keep the shape are accepted', () => {
  const area = [172, 46];
  for (const [todoHeight, chatWidth, workersWidth] of [[1, 1, 1], [20, 30, 100], [30, 100, 2], [45, 171 - 1, 1]]) {
    const dashboard = area[0] - chatWidth;
    const lower = area[1] - todoHeight;
    if (dashboard < 2) continue;
    const workersCols = Math.min(workersWidth, dashboard - 1);
    const layout = layoutOf({
      area,
      parent: [0, 0, chatWidth, area[1]],
      todo: [chatWidth, 0, dashboard, todoHeight],
      workers: [chatWidth, todoHeight, workersCols, lower],
      dag: [chatWidth + workersCols, todoHeight, dashboard - workersCols, lower],
    });
    assert.equal(isBandDashboard(layout, ids), true, JSON.stringify({ todoHeight, chatWidth, workersCols }));
  }
});

test('band dashboard requires exactly four owned panes with distinct ids', () => {
  const spec = TARGETS['172x46'];
  const three = layoutOf(spec);
  three.panes.pop();
  assert.equal(isBandDashboard(three, ids), false, 'missing pane');
  const duplicateEntry = layoutOf(spec);
  duplicateEntry.panes[3] = { pane_id: ids.workers, rect: rect(spec.dag) };
  assert.equal(isBandDashboard(duplicateEntry, ids), false, 'duplicate pane entry');
  assert.equal(isBandDashboard(layoutOf(spec), { ...ids, dag: ids.workers }), false, 'duplicate role id');
  assert.equal(isBandDashboard(layoutOf(spec), { ...ids, dag: undefined }), false, 'missing role id');
  assert.equal(isBandDashboard(layoutOf(spec), { ...ids, dag: 'nope' }), false, 'role id not in layout');
});

test('band dashboard keeps the parent unchanged on the left of the whole dashboard area', () => {
  const spec = TARGETS['172x46'];
  const parentRight = layoutOf({
    area: spec.area,
    parent: [103, 0, 69, 46], todo: [0, 0, 103, 16], workers: [0, 16, 41, 30], dag: [41, 16, 62, 30],
  });
  assert.equal(isBandDashboard(parentRight, ids), false, 'parent on the right');
  const parentShort = layoutOf({ ...spec, parent: [0, 0, 69, 45] });
  assert.equal(isBandDashboard(parentShort, ids), false, 'parent shorter than the area');
  const parentOnTop = layoutOf({
    area: spec.area,
    parent: [0, 0, 172, 20], todo: [0, 20, 103, 6], workers: [0, 26, 41, 20], dag: [41, 26, 62, 20],
  });
  assert.equal(isBandDashboard(parentOnTop, ids), false, 'parent on top');
});

test('band dashboard requires the Todo width to equal workers.width + dag.width and to reach the area edge', () => {
  const spec = TARGETS['172x46'];
  for (const [size, target] of Object.entries(TARGETS)) {
    const layout = layoutOf(target);
    const todo = paneOf(layout, 'todo').rect, workers = paneOf(layout, 'workers').rect, dag = paneOf(layout, 'dag').rect;
    assert.equal(todo.width, workers.width + dag.width, size);
  }
  const gap = layoutOf({ ...spec, dag: [111, 16, 61, 30] });
  assert.equal(isBandDashboard(gap, ids), false, 'gap between workers and DAG');
  const narrowTodo = layoutOf({ ...spec, todo: [69, 0, 102, 16] });
  assert.equal(isBandDashboard(narrowTodo, ids), false, 'Todo narrower than the lower row');
  const wideRow = layoutOf({ ...spec, dag: [110, 16, 63, 30] });
  assert.equal(isBandDashboard(wideRow, ids), false, 'lower row wider than Todo');
});

test('band dashboard rejects malformed layouts and rects without throwing', () => {
  const spec = TARGETS['172x46'];
  for (const layout of [undefined, null, {}, { area: spec.area }, { panes: [] }, { area: null, panes: layoutOf(spec).panes },
    { area: rect([0, 0, 172, 46]), panes: 'nope' }, { area: rect([0, 0, 172, 46]), panes: [null, null, null, null] }]) {
    assert.equal(isBandDashboard(layout, ids), false);
  }
  assert.equal(isBandDashboard(layoutOf(spec), undefined), false);
  assert.equal(isBandDashboard(layoutOf(spec), null), false);
  const bad = [NaN, -1, 0, Infinity, '41', null, undefined];
  for (const role of ROLES) {
    for (const key of KEYS) {
      for (const value of bad) {
        if (value === 0 && (key === 'x' || key === 'y')) continue; // 0 is a valid origin
        const layout = layoutOf(spec);
        paneOf(layout, role).rect[key] = value;
        assert.equal(isBandDashboard(layout, ids), false, `${role}.${key}=${String(value)}`);
      }
      const missing = layoutOf(spec);
      delete paneOf(missing, role).rect[key];
      assert.equal(isBandDashboard(missing, ids), false, `${role}.${key} missing`);
    }
    const noRect = layoutOf(spec);
    delete paneOf(noRect, role).rect;
    assert.equal(isBandDashboard(noRect, ids), false, `${role} without rect`);
  }
  for (const key of KEYS) {
    const layout = layoutOf(spec);
    layout.area[key] = NaN;
    assert.equal(isBandDashboard(layout, ids), false, `area.${key}=NaN`);
  }
  const negativeArea = layoutOf(spec);
  negativeArea.area.width = -172;
  assert.equal(isBandDashboard(negativeArea, ids), false, 'negative area');
});

test('band dashboard does not mutate its inputs', () => {
  const layout = layoutOf(TARGETS['120x40']);
  const before = structuredClone(layout), idsBefore = structuredClone(ids);
  isBandDashboard(layout, ids);
  assert.deepEqual(layout, before);
  assert.deepEqual(ids, idsBefore);
});

test('BAND_LAYOUT is the single place for the band constants and carries the measured values', () => {
  assert.deepEqual(BAND_LAYOUT, {
    chatShare: 0.5,
    todoHeight: 0.35,
    workersWidth: 0.4,
    minWorkersColumns: 24,
    readableWorkersColumns: 40,
    minTodoRows: 8,
    minLowerRows: 12,
    tolerance: 0,
  });
  assert.equal(Object.isFrozen(BAND_LAYOUT), true);
});

// Decision #185: the lower row may hold a recorded collaboration pane left of workers (28 | 28 | 30).
const collabLayout = () => ({
  area: { x: 0, y: 0, width: 172, height: 46 },
  panes: [
    { pane_id: 'parent', rect: { x: 0, y: 0, width: 86, height: 46 } },
    { pane_id: 'todo', rect: { x: 86, y: 0, width: 86, height: 16 } },
    { pane_id: 'collab', rect: { x: 86, y: 16, width: 28, height: 30 } },
    { pane_id: 'workers', rect: { x: 114, y: 16, width: 28, height: 30 } },
    { pane_id: 'dag', rect: { x: 142, y: 16, width: 30, height: 30 } },
  ],
});

test('band dashboard accepts a recorded collaboration pane leftmost in the lower row', () => {
  assert.equal(isBandDashboard(collabLayout(), { ...ids, coordination: 'collab' }), true);
  // The four-pane band without a collaboration pane still passes.
  assert.equal(isBandDashboard(layoutOf(TARGETS['172x46']), ids), true);
});

test('band dashboard refuses the collaboration pane unless recorded and directly left of workers', () => {
  assert.equal(isBandDashboard(collabLayout(), ids), false, 'unrecorded fifth pane is foreign');
  const moved = collabLayout();
  [moved.panes[2].rect.x, moved.panes[3].rect.x] = [114, 86];
  assert.equal(isBandDashboard(moved, { ...ids, coordination: 'collab' }), false, 'right of workers');
  const short = collabLayout();
  short.panes[2].rect.height = 29;
  assert.equal(isBandDashboard(short, { ...ids, coordination: 'collab' }), false, 'not the same row');
  const extra = collabLayout();
  extra.panes.push({ pane_id: 'foreign', rect: { x: 0, y: 0, width: 1, height: 1 } });
  assert.equal(isBandDashboard(extra, { ...ids, coordination: 'collab' }), false, 'foreign extra pane');
});
