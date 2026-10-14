import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixedDagPane, isColumnDashboard } from '../packages/dag/src/controller.mjs';
import { TodoPane } from '../packages/todo/src/controller.mjs';
import { claimParentSlot } from '../packages/todo/src/parent-slot.mjs';
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

async function legacyUpgradeFixture(t, mismatch = 'viewer') {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-upgrade-'));
  const panes = new Set(['parent']), calls = [], retired = [], records = [];
  let serial = 0, authority = false, failure, actor;
  const herdr = async (...args) => {
    calls.push({ args, authority });
    if (args[0] === 'get') {
      if (panes.has(args[1])) return { pane: { pane_id: args[1] } };
      throw Object.assign(new Error('legacy pane unavailable'), { code: failure ?? 'pane_not_found' });
    }
    if (args[0] === 'list') {
      if (failure === 'membership-unreadable') throw new Error('membership unreadable');
      return { panes: [...panes].map(pane_id => ({ pane_id, tab_id: 'tab' })) };
    }
    if (args[0] === 'layout') return { layout: { tab_id: 'tab',
      panes: [...panes].map(pane_id => ({ pane_id, rect: { x: 0, y: 0, width: 40, height: 20 } })) } };
    if (args[0] === 'split') {
      const pane_id = `new-${++serial}`;
      panes.add(pane_id);
      return { pane: { pane_id } };
    }
    if (args[0] === 'process-info') return { process_info: { shell_pid: 100, foreground_processes: [] } };
    if (args[0] === 'swap') return {};
    throw new Error('Unexpected native command: ' + args[0]);
  };
  const todo = new TodoPane({ managed: true, stateDir: join(directory, 'state', 'todo'), cwd: directory,
    environment: { HERDR_SOCKET_PATH: 'qa:socket', HERDR_PANE_ID: 'parent' }, herdr,
    ctx: { sessionManager: { getSessionId: () => 'session' } }, node: 'node',
    viewer: join(directory, 'generation-000004', 'todo', 'viewer.mjs') });
  const dag = new FixedDagPane({ managedAvailable: true, stateDir: join(directory, 'herdr-dag'), cwd: directory,
    socket: 'qa:socket', parentPane: 'parent', sessionId: 'session', node: 'node', herdr,
    viewer: join(directory, 'generation-000004', 'dag', 'viewer.mjs'),
    inspectShell: async pid => [{ ProcessId: pid, Birth: 'shell-birth', CreationDate: 'shell-date',
      ExecutablePath: 'shell', CommandLine: 'shell' }] });
  const parent = { paneId: 'parent', tabId: 'tab', shell: { pid: 100, birth: 'shell-birth' } };
  const producer = { pid: 200, birth: 'producer-birth', executable: 'node', argvDigest: 'a'.repeat(64) };
  actor = await claimParentSlot({ stateDir: join(directory, 'owner'), socketPath: `\\\\.\\pipe\\${todo.lifetimeId}`,
    parent, producer, sessionId: 'session', observe: async ({ locator, target }) => {
      await todo.membership('parent');
      let missing;
      if (locator) try { await herdr('get', locator.paneId); }
      catch (error) {
        if (error.code !== 'pane_not_found') throw error;
        missing = { code: error.code, paneId: locator.paneId };
      }
      return { parent, producer, target, missing };
    } });
  t.after(async () => {
    if (actor.db.isOpen) { if (actor.db.isTransaction) actor.db.exec('ROLLBACK'); actor.db.close(); }
    await rm(directory, { recursive: true, force: true });
  });
  await actor.join('todo', todo.lifetimeId);
  await actor.join('dag', dag.lifetimeId);
  todo.actor = dag.managedActor = actor;
  todo.scopeEpoch = dag.scopeEpoch = 1;
  todo.storage = { path: join(directory, 'todo-cache.json') };
  todo.presence = { offer: role => ({ ...todo.binding, role, scopeEpoch: 1 }),
    rotateRole: role => ({ ...todo.binding, role, scopeEpoch: 1 }), idle: async () => {} };
  todo.bridge = { invalidate() {}, readinessChanged() {} };
  todo.watchRecoveryMembership = async () => {};
  todo.currentTarget = async paneId => ({ paneId, tabId: 'tab', shell: parent.shell });
  const managedWrite = todo.managedWrite.bind(todo), obsolete = actor.obsoleteLocator.bind(actor);
  todo.managedWrite = job => managedWrite(async current => {
    authority = true;
    try { return await job(current); } finally { authority = false; }
  });
  actor.obsoleteLocator = (capability, record) => {
    assert.equal(authority, true, 'legacy retirement must use the held managed writer');
    retired.push(record.role);
    return obsolete(capability, record);
  };
  todo.mutate = (role, type, target, args) => todo.managedWrite(current =>
    current.perform(current.capability(role === 'todo' ? 'todo' : 'dag', role), { type, target },
      async () => ({ result: await herdr(...args), effects: Promise.resolve() })));
  // Launch authentication and native process observation are synthetic. The
  // actual schedule, discovery, actor tombstone and all creation guards execute.
  todo.launchTodo = async record => {
    const ready = { ...record, ready: true, processId: 300 };
    await writeJson(todo.recordFile, ready);
    todo.ownedRoles.set('todo', ready);
    return ready.paneId;
  };
  dag.launchRole = async record => {
    const ready = { ...record, ready: true, processId: 300 };
    dag.records.set(record.role, ready);
    await writeJson(dag.paneFile(record.role), ready);
    return ready;
  };
  dag.save = async () => {};
  dag.placementFocus = async () => 'parent';
  dag.restorePlacementFocus = async () => {};
  dag.coordinator = todo.coordinator();
  todo.provider = { lifetimeId: dag.lifetimeId, sourceReady: Promise.resolve(),
    preflightRecovery: () => dag.preflightRecovery(), replaceRetained: entries => dag.replaceRetained(entries),
    setOffers: async offers => { dag.offers = offers; }, openPair: options => dag.openPair(options) };
  for (const role of ['todo', 'dag', 'workers']) {
    const owner = role === 'todo' ? todo : dag;
    const path = role === 'todo' ? todo.recordFile : dag.paneFile(role);
    const record = { schema: 'omo-herdr-dashboard/pane/1', ...todo.binding, role, paneId: `old-${role}`,
      tabId: 'tab', scopeEpoch: 1, launchToken: `generation-3-${role}`, processId: 300,
      statePath: role === 'todo' ? todo.stateFile : dag.roleFile(role),
      viewerPath: mismatch === 'node' ? owner.viewer : join(directory, 'generation-000003', role, 'viewer.mjs'),
      nodePath: mismatch === 'node' ? 'old-node' : 'node', ready: true, prepared: true, manualClose: false };
    records.push({ path, record });
    await writeJson(path, record);
  }
  return { todo, dag, actor, calls, panes, retired, records, setFailure(value) { failure = value; } };
}

for (const mismatch of ['viewer', 'node'])
  test(`managed upgrade legacy dead ${mismatch} records recreate all roles through actor tombstones`, async t => {
    const f = await legacyUpgradeFixture(t, mismatch);
    await f.todo.schedule({ forceRoles: ['todo', 'dag', 'workers'] });
    assert.equal(f.actor.snapshot.closures.length, 3);
    for (const { path, record } of f.records) {
      const current = JSON.parse(await readFile(path));
      assert.notEqual(current.paneId, record.paneId);
      assert.notEqual(current.launchToken, record.launchToken);
      assert.equal(current.viewerPath, record.role === 'todo' ? f.todo.viewer : f.dag.viewer);
      assert.equal(current.nodePath, 'node');
      assert.equal(current.ready, true);
      assert.ok(f.retired.filter(role => role === record.role).length >= 2);
    }
    const mutations = f.calls.filter(call => ['split', 'close'].includes(call.args[0]));
    assert.equal(mutations.length, 3);
    assert.ok(mutations.every(call => call.args[0] === 'split' && call.authority));
  });

for (const role of ['todo', 'dag', 'workers'])
  for (const scenario of ['live', 'ambiguous-absence', 'unreadable-membership', 'owner-unheld', 'reappeared'])
    test(`managed upgrade legacy ${role} remains blocked: ${scenario}`, async t => {
      const f = await legacyUpgradeFixture(t);
      if (scenario === 'reappeared') {
        await f.todo.reconcileLegacy(f.todo.stateDir);
        await f.dag.preflightRecovery();
        f.panes.add(`old-${role}`);
      } else if (scenario === 'live') f.panes.add(`old-${role}`);
      else if (scenario === 'ambiguous-absence') f.setFailure('transport_error');
      else if (scenario === 'unreadable-membership') f.setFailure('membership-unreadable');
      else f.todo.actor = undefined;
      await assert.rejects(f.todo.schedule({ forceRoles: ['todo', 'dag', 'workers'] }));
      for (const { path, record } of f.records)
        assert.deepEqual(JSON.parse(await readFile(path)), record);
      assert.equal(f.calls.filter(call => ['split', 'close', 'run'].includes(call.args[0])).length, 0);
    });
