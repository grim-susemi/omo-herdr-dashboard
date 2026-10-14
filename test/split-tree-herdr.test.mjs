import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixedDagPane, isColumnDashboard } from '../packages/dag/src/controller.mjs';
import { TodoPane, authoritativePaneNotFound } from '../packages/todo/src/controller.mjs';
import { writeJson } from '../packages/dag/src/storage.mjs';
import { createSplitTreeHerdr } from './helpers/split-tree-herdr.mjs';

// Independent copy of the child geometry at packages/todo/src/controller.mjs:1213-1218.
const children = split => {
  const axis = split.direction === 'right' ? 'width' : 'height';
  const coordinate = split.direction === 'right' ? 'x' : 'y';
  const size = Math.round(Math.fround(split.rect[axis] * Math.fround(split.ratio)));
  return [{ ...split.rect, [axis]: size }, { ...split.rect,
    [coordinate]: split.rect[coordinate] + size, [axis]: split.rect[axis] - size }];
};
const rectOf = (layout, id) => layout.panes.find(pane => pane.pane_id === id).rect;
const ids = { parent: 'parent', todo: 'todo', workers: 'workers', dag: 'dag' };
// Legacy stacked dashboard: chat left, Todo, workers and DAG stacked on the right.
const stacked = { direction: 'right', ratio: 0.4, first: 'parent', second:
  { direction: 'down', ratio: 0.34, first: 'todo', second: { direction: 'down', ratio: 0.5, first: 'workers', second: 'dag' } } };

function assertConsistent(layout) {
  assert.equal(layout.splits.length, layout.panes.length - 1);
  assert.deepEqual(layout.splits[0].rect, layout.area);
  const leaves = [], walk = (rect, index) => {
    const split = layout.splits[index];
    if (!split || JSON.stringify(split.rect) !== JSON.stringify(rect)) { leaves.push(rect); return index; }
    const [a, b] = children(split);
    return walk(b, walk(a, index + 1));
  };
  walk(layout.area, 0);
  assert.deepEqual(layout.panes.map(pane => pane.rect), leaves);
}

test('layout reports tab, area, preorder splits and leaf rectangles from the split tree', () => {
  const fake = createSplitTreeHerdr({ tree: stacked, area: { x: 0, y: 0, width: 172, height: 46 } });
  const layout = fake.layout();
  assert.equal(layout.tab_id, 'tab');
  assert.equal(layout.focused_pane_id, 'parent');
  assert.deepEqual(layout.panes.map(pane => pane.pane_id), ['parent', 'todo', 'workers', 'dag']);
  assert.deepEqual(rectOf(layout, 'parent'), { x: 0, y: 0, width: 69, height: 46 });
  assert.deepEqual(rectOf(layout, 'todo'), { x: 69, y: 0, width: 103, height: 16 });
  assert.deepEqual(layout.splits.map(split => split.direction), ['right', 'down', 'down']);
  assert.equal(new Set(layout.splits.map(split => split.id)).size, 3);
  assertConsistent(layout);
});

test('split rounds the first child exactly like the controller resize verification', async () => {
  const fake = createSplitTreeHerdr({ tree: 'parent', area: { x: 0, y: 0, width: 101, height: 31 } });
  const created = await fake.herdr('split', '--pane', 'parent', '--direction', 'right', '--ratio', '0.5', '--no-focus');
  assert.deepEqual(created, { pane: { pane_id: 'created-1', tab_id: 'tab' } });
  let layout = fake.layout();
  assert.deepEqual(rectOf(layout, 'parent'), { x: 0, y: 0, width: 51, height: 31 });
  assert.deepEqual(rectOf(layout, 'created-1'), { x: 51, y: 0, width: 50, height: 31 });
  assert.equal(layout.focused_pane_id, 'parent', '--no-focus keeps the input pane');
  await fake.herdr('split', '--pane', 'created-1', '--direction', 'down', '--ratio', '0.3');
  layout = fake.layout();
  assert.deepEqual(rectOf(layout, 'created-1'), { x: 51, y: 0, width: 50, height: 9 });
  assert.equal(layout.focused_pane_id, 'created-2', 'split without --no-focus selects the new pane');
  assertConsistent(layout);
});

test('resize moves the nearest divider by the area fraction and rounds like the controller', async () => {
  const fake = createSplitTreeHerdr({ tree: { direction: 'right', ratio: 0.5, first: 'parent', second: 'todo' },
    area: { x: 0, y: 0, width: 172, height: 46 } });
  const parent = rectOf(fake.layout(), 'parent');
  assert.equal(parent.width, 86);
  const desired = Math.round(172 * .4);
  const before = fake.layout();
  await fake.herdr('resize', '--pane', 'parent', '--direction', 'left',
    '--amount', String(Math.abs(parent.width - desired) / 172));
  const after = fake.layout();
  assert.deepEqual(rectOf(after, 'parent'), { ...parent, width: desired });
  assert.deepEqual(rectOf(after, 'todo'), { x: 69, y: 0, width: 103, height: 46 });
  assert.equal(after.focused_pane_id, before.focused_pane_id);
  assert.equal(after.splits[0].id, before.splits[0].id);
  assertConsistent(after);
  // 0.3 of 101 = 30.3 cells; the ratio is rounded through Math.fround and Math.round.
  const odd = createSplitTreeHerdr({ tree: { direction: 'down', ratio: 0.5, first: 'a', second: 'b' },
    area: { x: 0, y: 0, width: 10, height: 101 } });
  assert.equal(rectOf(odd.layout(), 'a').height, 51);
  await odd.herdr('resize', '--pane', 'b', '--direction', 'up', '--amount', '0.3');
  assert.deepEqual(rectOf(odd.layout(), 'a'), { x: 0, y: 0, width: 10, height: 21 });
  assert.deepEqual(rectOf(odd.layout(), 'b'), { x: 0, y: 21, width: 10, height: 80 });
  assertConsistent(odd.layout());
});

test('resize selects the divider on the far edge for forward and the near edge for backward moves', async () => {
  const fake = createSplitTreeHerdr({ tree: { direction: 'right', ratio: 0.25, first: 'a',
    second: { direction: 'right', ratio: 0.5, first: 'b', second: 'c' } }, area: { x: 0, y: 0, width: 100, height: 10 } });
  await fake.herdr('resize', '--pane', 'b', '--direction', 'right', '--amount', '0.1');
  assert.deepEqual(fake.layout().panes.map(pane => pane.rect.width), [25, 48, 27]);
  await fake.herdr('resize', '--pane', 'b', '--direction', 'left', '--amount', '0.05');
  // The inner split keeps its ratio, so its children rescale with the narrower subtree.
  assert.deepEqual(fake.layout().panes.map(pane => pane.rect.width), [20, 51, 29]);
  assertConsistent(fake.layout());
});

test('swap exchanges leaf positions, keeps splits and selects the source pane', async () => {
  const fake = createSplitTreeHerdr({ tree: stacked });
  const before = fake.layout();
  assert.deepEqual(await fake.herdr('swap', '--source-pane', 'todo', '--target-pane', 'dag'), {});
  const after = fake.layout();
  assert.deepEqual(rectOf(after, 'todo'), rectOf(before, 'dag'));
  assert.deepEqual(rectOf(after, 'dag'), rectOf(before, 'todo'));
  assert.deepEqual(after.splits, before.splits);
  assert.equal(after.focused_pane_id, 'todo');
});

test('close gives the closed pane space to its sibling subtree and moves focus off it', async () => {
  const fake = createSplitTreeHerdr({ tree: stacked, focused: 'workers', area: { x: 0, y: 0, width: 100, height: 40 } });
  const dag = rectOf(fake.layout(), 'dag');
  await fake.herdr('close', 'workers');
  const layout = fake.layout();
  assert.deepEqual(layout.panes.map(pane => pane.pane_id), ['parent', 'todo', 'dag']);
  assert.deepEqual(rectOf(layout, 'dag'), { ...dag, y: rectOf(layout, 'todo').height, height: 40 - rectOf(layout, 'todo').height });
  assert.equal(layout.focused_pane_id, 'dag');
  assert.equal(layout.splits.length, 2);
  assertConsistent(layout);
  assert.deepEqual((await fake.herdr('list')).panes.map(pane => [pane.pane_id, pane.focused]),
    [['parent', false], ['todo', false], ['dag', true]]);
});

test('neighbor and focus follow adjacent rectangles', async () => {
  const fake = createSplitTreeHerdr({ tree: stacked });
  const { neighbor } = await fake.herdr('neighbor', '--pane', 'workers', '--direction', 'left');
  assert.equal(neighbor.neighbor_pane_id, 'parent');
  assert.equal(neighbor.layout.focused_pane_id, 'parent');
  await fake.herdr('focus', '--pane', 'parent', '--direction', 'right');
  assert.equal(fake.layout().focused_pane_id, 'todo');
  assert.equal((await fake.herdr('neighbor', '--pane', 'todo', '--direction', 'up')).neighbor.neighbor_pane_id, null);
});

for (const [name, args] of [
  ['get', ['get', 'ghost']], ['close', ['close', 'ghost']], ['layout', ['layout', '--pane', 'ghost']],
  ['split', ['split', '--pane', 'ghost', '--direction', 'right', '--ratio', '0.5']],
  ['swap', ['swap', '--source-pane', 'todo', '--target-pane', 'ghost']],
  ['resize', ['resize', '--pane', 'ghost', '--direction', 'left', '--amount', '0.1']],
  ['process-info', ['process-info', '--pane', 'ghost']],
]) test(`${name} of an unknown pane fails with the authoritative pane_not_found shape`, async () => {
  const fake = createSplitTreeHerdr({ tree: stacked });
  const before = JSON.stringify(fake.layout());
  const error = await fake.herdr(...args).then(() => null, value => value);
  assert.ok(error instanceof Error);
  assert.equal(error.code, 'pane_not_found');
  assert.equal(authoritativePaneNotFound(error), true);
  assert.equal(JSON.stringify(fake.layout()), before);
});

for (const [name, args] of [
  ['split direction', ['split', '--pane', 'todo', '--direction', 'diagonal', '--ratio', '0.5']],
  ['split ratio 0', ['split', '--pane', 'todo', '--direction', 'right', '--ratio', '0']],
  ['split ratio 1', ['split', '--pane', 'todo', '--direction', 'right', '--ratio', '1']],
  ['split ratio 1.5', ['split', '--pane', 'todo', '--direction', 'down', '--ratio', '1.5']],
  ['split ratio NaN', ['split', '--pane', 'todo', '--direction', 'down', '--ratio', 'half']],
  ['resize direction', ['resize', '--pane', 'parent', '--direction', 'sideways', '--amount', '0.1']],
  ['resize amount 0', ['resize', '--pane', 'parent', '--direction', 'left', '--amount', '0']],
  ['resize amount negative', ['resize', '--pane', 'parent', '--direction', 'left', '--amount', '-0.1']],
  ['resize collapsing a pane', ['resize', '--pane', 'parent', '--direction', 'left', '--amount', '0.6']],
  ['resize without divider', ['resize', '--pane', 'parent', '--direction', 'up', '--amount', '0.1']],
  ['swap with itself', ['swap', '--source-pane', 'todo', '--target-pane', 'todo']],
  ['unknown verb', ['teleport', 'todo']],
]) test(`malformed ${name} is rejected as non-authoritative without changing the tree`, async () => {
  const fake = createSplitTreeHerdr({ tree: stacked });
  const before = JSON.stringify(fake.layout());
  const error = await fake.herdr(...args).then(() => null, value => value);
  assert.ok(error instanceof Error);
  assert.notEqual(error.code, 'pane_not_found');
  assert.equal(authoritativePaneNotFound(error), false);
  assert.equal(JSON.stringify(fake.layout()), before);
});

test('closing the last pane is refused', async () => {
  const fake = createSplitTreeHerdr({ tree: 'parent' });
  await assert.rejects(fake.herdr('close', 'parent'), error => error.code === 'invalid_argument');
});

async function placementReplay(fake) {
  // The 11 operations of test/managed-layout.test.mjs:161-171, as issued by arrangeDashboard.
  const move = async (id, target, direction) => {
    const created = (await fake.herdr('split', '--pane', target, '--direction', direction, '--ratio', '0.5',
      '--cwd', '.', '--no-focus')).pane.pane_id;
    await fake.herdr('swap', '--source-pane', id, '--target-pane', created);
    await fake.herdr('close', created);
  };
  await move('dag', 'parent', 'right');
  await move('workers', 'dag', 'right');
  await fake.herdr('swap', '--source-pane', 'workers', '--target-pane', 'dag');
  await move('todo', 'workers', 'down');
  await fake.herdr('swap', '--source-pane', 'todo', '--target-pane', 'workers');
}

test('the 11-operation placement replay ends as a column dashboard and the parent resize lands at 40 percent', async () => {
  const fake = createSplitTreeHerdr({ tree: stacked, area: { x: 0, y: 0, width: 172, height: 46 } });
  await placementReplay(fake);
  assert.deepEqual(fake.calls.map(args => args[0]),
    ['split', 'swap', 'close', 'split', 'swap', 'close', 'swap', 'split', 'swap', 'close', 'swap']);
  const placed = fake.layout();
  assert.equal(isColumnDashboard(placed, ids), true);
  const parent = rectOf(placed, 'parent'), desired = Math.round(placed.area.width * .4);
  await fake.herdr('resize', '--pane', 'parent', '--direction', parent.width > desired ? 'left' : 'right',
    '--amount', String(Math.abs(parent.width - desired) / placed.area.width));
  const final = fake.layout();
  assert.equal(isColumnDashboard(final, ids), true);
  assert.equal(rectOf(final, 'parent').width, 69);
  assertConsistent(final);
});

test('identical operation sequences produce identical layouts', async () => {
  const runs = [];
  for (let index = 0; index < 2; index++) {
    const fake = createSplitTreeHerdr({ tree: stacked });
    await placementReplay(fake);
    runs.push(JSON.stringify(fake.layout()));
  }
  assert.equal(runs[0], runs[1]);
});

test('the fake injects where the scripted fake is injected and drives the real managed placement', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-split-tree-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fake = createSplitTreeHerdr({ tree: stacked, area: { x: 0, y: 0, width: 100, height: 40 } });
  const mutations = [];
  const todo = new TodoPane({ managed: true, stateDir: directory, cwd: directory, herdr: fake.herdr,
    environment: { HERDR_SOCKET_PATH: 'qa:socket', HERDR_PANE_ID: 'parent' },
    ctx: { sessionManager: { getSessionId: () => 'session' } }, viewer: join(directory, 'todo-viewer.mjs') });
  todo.scopeEpoch = 1;
  const dag = new FixedDagPane({ managedAvailable: true, stateDir: directory, cwd: directory, herdr: fake.herdr,
    socket: 'qa:socket', parentPane: 'parent', sessionId: 'session', node: 'node',
    viewer: join(directory, 'dag-viewer.mjs'),
    inspectShell: async pid => [{ ProcessId: pid, Birth: 'shell-birth', CreationDate: 'shell-date',
      ExecutablePath: 'shell', CommandLine: 'shell' }] });
  const actor = { snapshot: { ownerNonce: 'owner', generation: 1, operations: [], closures: [] }, leaseHeld: true };
  const target = async paneId => ({ paneId, tabId: 'tab', shell: { pid: 100, birth: 'shell-birth' } });
  const todoCoordinator = todo.coordinator();
  dag.coordinator = { actor, lifetimeId: todo.lifetimeId,
    inspectTodo: todoCoordinator.inspectTodo, closeTodoForLayout: todoCoordinator.closeTodoForLayout,
    assertCurrent() {}, join: async () => {}, registerRole: async () => {}, reconcileLegacy: async () => {}, target,
    mutate: async (role, type, nativeTarget, args) => { mutations.push(args); return fake.herdr(...args); } };
  dag.managedActor = actor;
  dag.nativeTarget = record => target(record.paneId);
  dag.preflightRecovery = async () => {};
  dag.save = async () => {};
  dag.placementFocus = async () => 'parent';
  dag.restorePlacementFocus = async () => {};
  dag.verify = todo.verify = async record => record?.ready && fake.panes().includes(record.paneId) ? { pid: 200 } : null;
  const todoRecord = { schema: 'omo-herdr-dashboard/pane/1', ...todo.binding, role: 'todo', paneId: 'todo',
    tabId: 'tab', scopeEpoch: 1, launchToken: 'todo-launch', statePath: todo.stateFile, viewerPath: todo.viewer,
    ready: true, processId: 200 };
  await writeJson(todo.recordFile, todoRecord);
  todo.ownedRoles.set('todo', todoRecord);
  for (const role of ['dag', 'workers']) {
    const record = { schema: 'omo-herdr-dashboard/pane/1', ...dag.binding, role, paneId: role, tabId: 'tab',
      scopeEpoch: 1, launchToken: `${role}-launch`, statePath: dag.roleFile(role), viewerPath: dag.viewer,
      ready: true, processId: 200 };
    await writeJson(dag.paneFile(role), record);
    dag.records.set(role, record);
  }
  dag.claim = { ...dag.binding, lifetimeId: todo.lifetimeId, tabId: 'tab', layout: 'columns' };
  assert.equal(isColumnDashboard(fake.layout(), ids), false);
  await dag.arrangeDashboard();
  assert.deepEqual(mutations.map(args => args[0]),
    ['split', 'swap', 'close', 'split', 'swap', 'close', 'swap', 'split', 'swap', 'close', 'swap', 'resize']);
  assert.deepEqual(mutations.at(-1), ['resize', '--pane', 'parent', '--direction', 'left', '--amount', '0.1']);
  assert.equal(JSON.parse(await readFile(join(dag.directory, 'placement.json'))).phase, 'COMPLETE');
  const final = fake.layout();
  assert.equal(isColumnDashboard(final, ids), true);
  assert.equal(rectOf(final, 'parent').width, 40);
  assert.deepEqual(fake.panes(), ['parent', 'todo', 'workers', 'dag']);
});
