import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixedDagPane, isColumnDashboard } from '../packages/dag/src/controller.mjs';
import { TodoPane } from '../packages/todo/src/controller.mjs';
import { writeJson } from '../packages/dag/src/storage.mjs';

async function fixture(t, managed) {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-authority-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [], mutations = [];
  const panes = new Set(['parent', 'todo', 'dag', 'workers']);
  let authority = false, serial = 0, temporaryCloses = 0;
  const columns = () => ({
    tab_id: 'tab', focused_pane_id: 'parent', area: { x: 0, y: 0, width: 100, height: 40 },
    panes: [
      { pane_id: 'parent', rect: { x: 0, y: 0, width: 40, height: 40 } },
      { pane_id: 'todo', rect: { x: 40, y: 0, width: 30, height: 20 } },
      { pane_id: 'workers', rect: { x: 40, y: 20, width: 30, height: 20 } },
      { pane_id: 'dag', rect: { x: 70, y: 0, width: 30, height: 40 } },
    ],
  });
  let layout = columns();
  layout.panes.find(pane => pane.pane_id === 'dag').rect.y = 1;
  const herdr = async (...args) => {
    calls.push({ args, authority });
    if (args[0] === 'list') return { panes: [...panes].map(pane_id =>
      ({ pane_id, tab_id: 'tab', focused: pane_id === 'parent' })) };
    if (args[0] === 'layout') return { layout };
    if (args[0] === 'process-info') return { process_info: { shell_pid: 100, foreground_processes: [] } };
    if (args[0] === 'split') {
      const pane_id = `created-${++serial}`;
      panes.add(pane_id);
      layout.panes.push({ pane_id, rect: { x: 0, y: 0, width: 10, height: 10 } });
      return { pane: { pane_id } };
    }
    if (args[0] === 'swap') {
      const source = layout.panes.find(pane => pane.pane_id === args[2]);
      const target = layout.panes.find(pane => pane.pane_id === args[4]);
      [source.pane_id, target.pane_id] = [target.pane_id, source.pane_id];
    }
    if (args[0] === 'close') {
      panes.delete(args[1]);
      layout.panes = layout.panes.filter(pane => pane.pane_id !== args[1]);
      if (authority && ++temporaryCloses === 3) {
        // The final journaled move leaves the Todo/workers swap to the caller.
        layout = columns();
        [layout.panes[1].pane_id, layout.panes[2].pane_id] = ['workers', 'todo'];
      }
    }
    return {};
  };
  const todo = new TodoPane({ managed, stateDir: directory, cwd: directory, herdr,
    environment: { HERDR_SOCKET_PATH: 'qa:socket', HERDR_PANE_ID: 'parent' },
    ctx: { sessionManager: { getSessionId: () => 'session' } }, viewer: join(directory, 'todo-viewer.mjs') });
  todo.scopeEpoch = 1;
  const dag = new FixedDagPane({ managedAvailable: managed, stateDir: directory, cwd: directory, herdr,
    socket: 'qa:socket', parentPane: 'parent', sessionId: 'session', node: 'node',
    viewer: join(directory, 'dag-viewer.mjs'),
    inspectShell: async pid => [{ ProcessId: pid, Birth: 'shell-birth', CreationDate: 'shell-date',
      ExecutablePath: 'shell', CommandLine: 'shell' }] });
  const actor = { snapshot: { ownerNonce: 'owner', generation: 1, operations: [], closures: [] },
    leaseHeld: true };
  const target = async paneId => ({ paneId, tabId: 'tab', shell: { pid: 100, birth: 'shell-birth' } });
  const todoCoordinator = todo.coordinator();
  dag.coordinator = { actor: managed ? actor : null, lifetimeId: todo.lifetimeId,
    inspectTodo: todoCoordinator.inspectTodo, closeTodoForLayout: todoCoordinator.closeTodoForLayout,
    assertCurrent() {}, join: async () => {}, registerRole: async () => {},
    reconcileLegacy: async () => {}, target,
    mutate: async (role, type, nativeTarget, args) => {
      mutations.push({ role, type, target: nativeTarget, args });
      authority = true;
      try { return await herdr(...args); } finally { authority = false; }
    } };
  dag.managedActor = managed ? actor : null;
  dag.nativeTarget = record => target(record.paneId);
  dag.preflightRecovery = async () => {};
  dag.save = async () => {};
  dag.placementFocus = async () => 'parent';
  dag.restorePlacementFocus = async () => {};
  dag.verify = todo.verify = async record => record?.ready && panes.has(record.paneId) ? { pid: 200 } : null;
  // Model the authenticated launch receipt, without spawning a terminal or process.
  dag.launchRole = async record => {
    const ready = { ...record, ready: true, processId: 200 };
    dag.records.set(record.role, ready);
    await writeJson(dag.paneFile(record.role), ready);
    await writeJson(dag.roleFile(record.role), dag.roleState(ready));
    return ready;
  };
  const todoRecord = { schema: 'omo-herdr-dashboard/pane/1', ...todo.binding,
    role: 'todo', paneId: 'todo', tabId: 'tab', scopeEpoch: 1, launchToken: 'todo-launch',
    statePath: todo.stateFile, viewerPath: todo.viewer, ready: true, processId: 200 };
  await writeJson(todo.recordFile, todoRecord);
  todo.ownedRoles.set('todo', todoRecord);
  for (const role of ['dag', 'workers']) {
    const record = { schema: 'omo-herdr-dashboard/pane/1', ...dag.binding,
      role, paneId: role, tabId: 'tab', scopeEpoch: 1, launchToken: `${role}-launch`,
      statePath: dag.roleFile(role), viewerPath: dag.viewer, ready: true, processId: 200 };
    await writeJson(dag.paneFile(role), record);
    dag.records.set(role, record);
  }
  dag.claim = { ...dag.binding, lifetimeId: todo.lifetimeId, tabId: 'tab', layout: 'columns' };
  return { dag, todo, actor, panes, calls, mutations, columns,
    setLayout(value) { layout = value; }, getLayout: () => layout };
}

for (const managed of [true, false]) {
  test(`${managed ? 'managed' : 'unmanaged'} force rebuild respects closure authority`, async t => {
    const f = await fixture(t, managed);
    const pair = await f.dag.openPair({ force: true, forceRoles: ['dag', 'workers'], claim: f.dag.claim });
    const closes = f.calls.filter(call => call.args[0] === 'close');
    if (managed) {
      assert.equal(pair.dag.paneId, 'dag');
      assert.equal(pair.workers.paneId, 'workers');
      assert.deepEqual(closes, []);
      assert.equal(await f.todo.coordinator().closeTodoForLayout(), false);
      assert.equal((JSON.parse(await readFile(f.todo.recordFile))).manualClose, undefined);
      assert.equal(f.calls.filter(call => call.args[0] === 'close').length, 0);
    } else {
      assert.notEqual(pair.dag.paneId, 'dag');
      assert.notEqual(pair.workers.paneId, 'workers');
      assert.deepEqual(closes.map(call => call.args), [['close', 'todo'], ['close', 'dag'], ['close', 'workers']]);
      assert.ok(closes.every(call => !call.authority));
      assert.equal((JSON.parse(await readFile(f.todo.recordFile))).manualClose, true);
    }
  });
}

for (const guard of ['allowed', 'excluded-role', 'force-current', 'new-closure']) {
  test(`managed recreation honors ${guard} force guard without raw close`, async t => {
    const f = await fixture(t, true);
    const file = f.dag.paneFile('workers'), record = JSON.parse(await readFile(file));
    await writeJson(file, { ...record, manualClose: true });
    f.panes.delete('workers');
    f.actor.snapshot.closures.push({ role: 'workers', paneId: 'workers', sessionId: 'session', reason: 'pane_not_found' });
    const gate = Promise.withResolvers();
    f.dag.queue = gate.promise;
    const opening = f.dag.openPair({ force: true, claim: f.dag.claim,
      forceRoles: guard === 'excluded-role' ? ['dag'] : ['workers'],
      forceCurrent: () => guard !== 'force-current' });
    if (guard === 'new-closure') f.dag.closureVersions.set('workers', 1);
    gate.resolve();
    const pair = await opening;
    assert.equal(pair.dag.paneId, 'dag');
    const splits = f.calls.filter(call => call.args[0] === 'split');
    assert.equal(splits.length, guard === 'allowed' ? 1 : 0);
    assert.ok(splits.every(call => call.authority));
    assert.equal(f.calls.filter(call => call.args[0] === 'close').length, 0);
    if (guard === 'allowed') assert.notEqual(pair.workers.paneId, 'workers');
    else assert.equal(pair.workers, undefined);
  });
}

test('managed non-column placement journals temporary closure through actor authority', async t => {
  const f = await fixture(t, true);
  await f.dag.arrangeDashboard();
  assert.deepEqual(f.mutations.map(call => call.args[0]),
    ['split', 'swap', 'close', 'split', 'swap', 'close', 'swap', 'split', 'swap', 'close', 'swap']);
  assert.ok(f.calls.filter(call => ['split', 'swap', 'close'].includes(call.args[0])).every(call => call.authority));
  assert.deepEqual(f.calls.filter(call => call.args[0] === 'close').map(call => call.args[1]),
    ['created-1', 'created-2', 'created-3']);
  assert.equal(JSON.parse(await readFile(join(f.dag.directory, 'placement.json'))).phase, 'COMPLETE');
  assert.equal(isColumnDashboard(f.getLayout(), { parent: 'parent', todo: 'todo', workers: 'workers', dag: 'dag' }), true);
});

test('unmanaged arrangement retains reversible swap and rejects general placement', async t => {
  const f = await fixture(t, false);
  await assert.rejects(f.dag.arrangeDashboard(), /use \/dashboard to rebuild/);
  assert.equal(f.calls.filter(call => ['split', 'swap', 'close', 'move'].includes(call.args[0])).length, 0);
  const reversed = f.columns();
  [reversed.panes[1].pane_id, reversed.panes[2].pane_id] = ['workers', 'todo'];
  f.setLayout(reversed);
  await f.dag.arrangeDashboard();
  assert.deepEqual(f.calls.filter(call => ['split', 'swap', 'close', 'move'].includes(call.args[0])).map(call => call.args[0]), ['swap']);
  assert.equal(f.mutations.length, 0);
});
