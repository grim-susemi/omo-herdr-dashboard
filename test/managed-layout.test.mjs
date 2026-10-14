import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import { once, EventEmitter } from 'node:events';
import * as filesystem from 'node:fs/promises';
import { mkdtemp, readFile, rm, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
  let serial = 0, authority = false, failure, actor, inspectedPane;
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
    if (args[0] === 'process-info') {
      inspectedPane = args[2];
      return { process_info: { shell_pid: 100, foreground_processes: [{ pid: 100, argv: ['shell'] }] } };
    }
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
  const actorOptions = { stateDir: join(directory, 'owner'), socketPath: `\\\\.\\pipe\\${todo.lifetimeId}`,
    parent, producer, sessionId: 'session', observe: async ({ locator, target }) => {
      await todo.membership('parent');
      let missing;
      if (locator) try { await herdr('get', locator.paneId); }
      catch (error) {
        if (error.code !== 'pane_not_found') throw error;
        missing = { code: error.code, paneId: locator.paneId };
      }
      return { parent, producer, target, missing };
    } };
  actor = await claimParentSlot(actorOptions);
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
    setOffers: async offers => { dag.offers = offers; }, openPair: options => dag.openPair(options),
    observeTarget: target => dag.nativeTarget(target) };
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
  return { todo, dag, get actor() { return actor; }, calls, panes, retired, records, directory,
    setFailure(value) { failure = value; },
    async retainLive() {
      const digest = value => createHash('sha256').update(value).digest('hex');
      const exited = new Set();
      const liveRecords = new Map(records.map(entry => [entry.record.paneId, entry.record]));
      const rows = () => {
        const r = liveRecords.get(inspectedPane);
        const shell = { ProcessId: 100, Birth: 'shell-birth', CreationDate: '2026-10-14T00:00:00.000Z',
          ExecutablePath: 'shell', CommandLine: 'shell' };
        if (!r || exited.has(r.paneId)) return [shell];
        const argv = ['node', r.viewerPath, ...(r.role === 'todo' ? [] : ['--view', r.role === 'dag' ? 'dag' : 'tasks']),
          '--state', r.statePath, '--close-pane', r.paneId, '--launch-token', r.launchToken];
        return [shell, { ProcessId: 300, ParentProcessId: 100, Birth: 'viewer-birth', CreationDate: '2026-10-14T00:00:01.000Z',
          ExecutablePath: 'node', CommandLine: argv.map(value => `"${value}"`).join(' ') }];
      };
      todo.inspectShell = dag.inspectShell = async () => rows();
      todo.ctx.sessionManager.getSessionFile = () => join(directory, 'source.json');
      for (const entry of records) {
        const r = entry.record;
        const owner = r.role === 'todo' ? todo : dag;
        r.viewerPath = join(directory, 'generation-000003', r.role === 'todo' ? 'todo' : 'dag', 'viewer.mjs');
        Object.assign(r, { creationProcessId: 100, creationDate: '2026-10-14T00:00:00.000Z',
          creationBirth: 'shell-birth', viewerBirth: 'viewer-birth' });
        panes.add(r.paneId); inspectedPane = r.paneId;
        const viewer = { pid: 300, birth: 'viewer-birth', executable: 'node', argvDigest: digest(rows()[1].CommandLine) };
        const native = { paneId: r.paneId, tabId: 'tab', shell: parent.shell, viewer,
          statePath: r.statePath, sourcePath: join(directory, 'source.json'),
          cachePath: r.role === 'todo' ? todo.storage.path : r.statePath,
          prefsPath: `${r.statePath}.view.json`, launchToken: r.launchToken, controlToken: 'control' };
        await actor.registerRole(actor.capability(r.role === 'todo' ? 'todo' : 'dag', r.role), native);
        await writeJson(entry.path, r);
        await writeJson(r.statePath, { schema: 'omo-herdr-dashboard/role/1', ...todo.binding,
          role: r.role, paneId: r.paneId, tabId: 'tab', scopeEpoch: 1, launchToken: r.launchToken,
          cachePath: native.cachePath, prefsPath: native.prefsPath,
          managedScope: { generation: actor.snapshot.generation, sessionId: 'session',
            participant: r.role === 'todo' ? 'todo' : 'dag', lifetimeId: owner.lifetimeId } });
      }
      await actor.drain('todo', todo.lifetimeId); await actor.drain('dag', dag.lifetimeId); await actor.release();
      actor = await claimParentSlot(actorOptions);
      await actor.join('todo', todo.lifetimeId); await actor.join('dag', dag.lifetimeId);
      todo.actor = dag.managedActor = actor;
      todo.claimRetired = true;
      todo.retireViewer = async record => {
        assert.equal(authority, true, 'retirement must run inside actor dispatch');
        exited.add(record.paneId);
        return { manual: false };
      };
      const launchTodo = todo.launchTodo, launchRole = dag.launchRole;
      const registerLaunch = async ready => {
        liveRecords.set(ready.paneId, ready); exited.delete(ready.paneId);
        inspectedPane = ready.paneId;
        const old = actor.snapshot.roles[ready.role];
        await actor.registerRole(actor.capability(ready.role === 'todo' ? 'todo' : 'dag', ready.role),
          { ...roleTarget(old), launchToken: ready.launchToken,
            viewer: { pid: ready.processId, birth: 'viewer-birth', executable: 'node',
              argvDigest: digest(rows()[1].CommandLine) } });
      };
      todo.launchTodo = async record => {
        const result = await launchTodo(record);
        await registerLaunch({ ...record, ready: true, processId: 300, viewerBirth: 'viewer-birth' });
        return result;
      };
      dag.launchRole = async record => {
        const result = await launchRole(record);
        await registerLaunch(result);
        return result;
      };
      return exited;
    } };
}

test('registered live generation bump retires all viewers through actor and relaunches current sources', async t => {
  const f = await legacyUpgradeFixture(t);
  const exited = await f.retainLive();
  await f.todo.schedule({ forceRoles: ['todo', 'dag', 'workers'] });
  assert.equal(exited.size, 0, 'all retired shells have replacement viewers');
  const retires = f.actor.snapshot.operations.filter(op => op.type === 'retire');
  assert.equal(retires.length, 3);
  assert.ok(retires.every(op => op.status === 'SETTLED'));
  for (const { path, record } of f.records) {
    const current = JSON.parse(await readFile(path));
    assert.equal(current.paneId, record.paneId, 'verified shell and layout are retained');
    assert.equal(current.viewerPath, record.role === 'todo' ? f.todo.viewer : f.dag.viewer);
    assert.notEqual(current.launchToken, record.launchToken);
    assert.equal(current.nodePath, 'node');
  }
  assert.equal(f.calls.filter(call => ['split', 'close'].includes(call.args[0])).length, 0);
});

test('blocked controller stop closes its handle and owned pipes despite unresolved placement', async t => {
  const f = await legacyUpgradeFixture(t);
  f.todo.ctx.sessionManager.getSessionFile = () => join(f.directory, 'source.json');
  const snapshot = f.actor.snapshot;
  f.todo.publisherScope = { ownerNonce: snapshot.ownerNonce, sessionId: snapshot.sessionId,
    generation: snapshot.generation, lifetimeId: f.todo.lifetimeId, parent: snapshot.parent, producer: snapshot.producer };
  // ownsPublisherClaim also binds the producer PID to the actual controller.
  f.todo.ownsPublisherClaim = () => f.actor.leaseHeld;
  f.todo.provider = null;
  f.todo.presence.close = async () => {};
  f.todo.bridge.remove = () => {};
  let ended = false;
  f.todo.controlSockets.add({ destroy() { ended = true; }, end() { ended = true; } });
  await assert.rejects(f.actor.perform(f.actor.capability('todo', 'todo'),
    { type: 'arrange', target: { paneId: 'old-todo', tabId: 'tab', shell: snapshot.parent.shell } },
    async () => { throw new Error('lost placement'); }));
  await assert.rejects(f.todo.stop());
  assert.equal(f.actor.db.isOpen, false);
  assert.equal(ended, true);
  await rename(f.actor.paths.directory, `${f.actor.paths.directory}.moved`);
  await rename(`${f.actor.paths.directory}.moved`, f.actor.paths.directory);
});

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

const nativeIdentity = row => ({ pid: row.ProcessId, birth: row.Birth, executable: row.ExecutablePath,
  argvDigest: createHash('sha256').update(row.CommandLine).digest('hex') });
const roleTarget = role => Object.fromEntries(['paneId', 'tabId', 'shell', 'viewer', 'statePath',
  'sourcePath', 'cachePath', 'prefsPath', 'launchToken', 'controlToken'].map(key => [key, role[key]]));
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('recovery did not settle')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

async function registeredRecoveryFixture(t, { upgrade = false, managed = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-registered-recovery-'));
  const socketPath = `\\\\.\\pipe\\dashboard-recovery-${directory.split(/[\\/]/).at(-1)}`;
  const panes = new Map(), calls = [], retirements = [], actors = [], controllers = [], pending = [];
  const producerRow = { ProcessId: process.pid, ParentProcessId: 100, Birth: 'producer-birth',
    ExecutablePath: 'node', CommandLine: 'node controller', CreationDate: '2026-10-14T00:00:00.000Z' };
  let serial = 0, getError, listError, duplicateParent = false, failDraining = false;
  const shellRow = pid => ({ ProcessId: pid, ParentProcessId: 1, Birth: `shell-${pid}`,
    ExecutablePath: 'shell', CommandLine: 'shell', CreationDate: '2026-10-13T00:00:00.000Z' });
  panes.set('parent', { shell: shellRow(100), tabId: 'tab' });
  const inspectShell = async pid => {
    if (pid === process.pid) return [producerRow];
    const pane = [...panes.values()].find(value => value.shell.ProcessId === pid);
    return pane ? [pane.shell, ...(pane.viewer ? [pane.viewer] : [])] : [];
  };
  const herdr = async (...args) => {
    calls.push(args);
    if (args[0] === 'get') {
      if (getError) throw Object.assign(new Error('native get failed'), { code: getError });
      if (!panes.has(args[1])) throw Object.assign(new Error('exact pane absent'), { code: 'pane_not_found' });
      return { pane: { pane_id: args[1] } };
    }
    if (args[0] === 'list') {
      if (listError) throw new Error('membership unavailable');
      const members = [...panes].map(([pane_id, pane]) => ({ pane_id, tab_id: pane.tabId }));
      if (duplicateParent) members.push({ pane_id: 'parent', tab_id: 'tab' });
      return { panes: members };
    }
    if (args[0] === 'layout') return { layout: { tab_id: 'tab', focused_pane_id: 'parent',
      area: { x: 0, y: 0, width: 100, height: 40 },
      panes: [...panes].map(([pane_id, pane]) => ({ pane_id, rect: {
        parent: { x: 0, y: 0, width: 40, height: 40 },
        todo: { x: 40, y: 0, width: 30, height: 20 },
        workers: { x: 40, y: 20, width: 30, height: 20 },
        dag: { x: 70, y: 0, width: 30, height: 40 },
      }[pane_id === 'parent' ? 'parent' : pane.role] ?? { x: 0, y: 0, width: 10, height: 10 } })) } };
    if (args[0] === 'process-info') {
      const pane = panes.get(args[2]);
      if (!pane) throw Object.assign(new Error('exact pane absent'), { code: 'pane_not_found' });
      return { process_info: { pane_id: args[2], shell_pid: pane.shell.ProcessId,
        foreground_processes: [{ pid: pane.shell.ProcessId, argv: ['shell'] }] } };
    }
    if (args[0] === 'split') {
      const pane_id = `replacement-${++serial}`;
      panes.set(pane_id, { shell: shellRow(2000 + serial), tabId: 'tab' });
      return { pane: { pane_id } };
    }
    if (args[0] === 'run' || args[0] === 'swap') return {};
    throw new Error('Unexpected native mutation: ' + args[0]);
  };
  const fs = { ...filesystem, rename: async (from, to) => {
    if (failDraining && from.endsWith('.pending') &&
      JSON.parse(await readFile(from, 'utf8')).phase === 'DRAINING')
      throw Object.assign(new Error('DRAINING publication denied'), { code: 'EACCES' });
    return filesystem.rename(from, to);
  } };
  let todo, dag, actor;
  const createControllers = generation => {
    todo = new TodoPane({ managed, stateDir: join(directory, 'todo'), cwd: directory, herdr, inspectShell,
      environment: { HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: 'parent' },
      ctx: { sessionManager: { getSessionId: () => 'session', getSessionFile: () => join(directory, 'session.jsonl') } },
      node: 'node', viewer: join(directory, `generation-${generation}`, 'todo', 'viewer.mjs'),
      retireViewer: async (record, identity) => {
        assert.deepEqual(identity.viewer, nativeIdentity(panes.get(record.paneId).viewer));
        assert.equal(actor.snapshot.operations.at(-1).type, 'retire');
        assert.equal(actor.snapshot.operations.at(-1).status, 'DISPATCHED');
        retirements.push(record.role);
        delete panes.get(record.paneId).viewer;
        return { pid: identity.viewer.pid, birth: identity.viewer.birth, exitCode: 0, manual: false };
      } });
    dag = new FixedDagPane({ managedAvailable: managed, stateDir: join(directory, 'dag'), cwd: directory,
      socket: socketPath, parentPane: 'parent', sessionId: 'session', node: 'node', herdr, inspectShell,
      viewer: join(directory, `generation-${generation}`, 'dag', 'viewer.mjs') });
    controllers.push(todo, dag);
    todo.scopeEpoch = dag.scopeEpoch = 1;
    todo.storage = { path: join(directory, 'todo-cache.json') };
    todo.presence = { events: new EventEmitter(), offer: role => ({ v: 1, ...todo.binding, role, scopeEpoch: 1 }),
      rotateRole: role => ({ v: 1, ...todo.binding, role, scopeEpoch: 1 }), idle: async () => {}, close: async () => {} };
    todo.bridge = { invalidate() {}, readinessChanged() {}, remove() {} };
    todo.watchRecoveryMembership = async () => {};
    todo.publishCustodyBinding = async () => {};
    todo.holdRoleViewer = async () => {};
    dag.sourceSaved();
    dag.save = async () => {};
    dag.placementFocus = async () => 'parent';
    dag.restorePlacementFocus = async () => {};
    todo.provider = dag.provider();
    dag.coordinator = todo.coordinator();
    todo.mutate = (role, type, target, args) => todo.perform(role, type, target,
      async () => ({ result: await herdr(...args), effects: Promise.resolve() }));
    const launch = async (owner, record) => {
      const pane = panes.get(record.paneId), pid = 3000 + ++serial;
      pane.role = record.role;
      const argv = [record.nodePath, record.viewerPath,
        ...(record.role === 'todo' ? [] : ['--view', record.role === 'dag' ? 'dag' : 'tasks']),
        '--state', record.statePath, '--close-pane', record.paneId, '--launch-token', record.launchToken];
      pane.viewer = { ProcessId: pid, ParentProcessId: pane.shell.ProcessId, Birth: `viewer-${pid}`,
        ExecutablePath: record.nodePath, CommandLine: argv.map(value => `"${value}"`).join(' '),
        CreationDate: '2026-10-14T00:00:00.000Z' };
      const ready = { ...record, processId: pid, viewerBirth: pane.viewer.Birth, ready: true };
      const file = record.role === 'todo' ? owner.recordFile : owner.paneFile(record.role);
      await writeJson(file, ready);
      await writeJson(record.statePath, owner.roleState(ready));
      const target = record.role === 'todo' ? await todo.nativePane(record.paneId, ready) : await dag.nativeTarget(ready);
      await actor.registerRole(actor.capability(record.role === 'todo' ? 'todo' : 'dag', record.role), target);
      if (record.role === 'todo') todo.ownedRoles.set('todo', ready);
      else dag.records.set(record.role, ready);
      return ready;
    };
    todo.launchTodo = async record => (await launch(todo, record)).paneId;
    dag.launchRole = record => launch(dag, record);
  };
  const claim = async observePrevious => {
    const observed = await todo.observeManaged({});
    actor = await claimParentSlot({ stateDir: join(directory, 'owner'), socketPath, ...observed,
      sessionId: 'session', observe: request => todo.observeManaged(request), observePrevious, fs });
    actors.push(actor);
    todo.actor = actor; dag.managedActor = managed ? actor : null;
    await actor.join('todo', todo.lifetimeId); await actor.join('dag', dag.lifetimeId);
    todo.publisherScope = { ownerNonce: actor.snapshot.ownerNonce, generation: actor.snapshot.generation,
      sessionId: 'session', lifetimeId: todo.lifetimeId, parent: observed.parent, producer: observed.producer };
    todo.claimRetired = actor.snapshot.generation > 1;
  };
  t.after(async () => {
    for (const gate of pending) gate.resolve();
    for (const controller of controllers) {
      for (const socket of controller.controlSockets) socket.destroy();
      if (controller.control?.listening) await new Promise(resolve => controller.control.close(resolve));
    }
    for (const retained of actors) if (retained.db.isOpen) {
      if (retained.db.isTransaction) retained.db.exec('ROLLBACK');
      retained.db.close();
    }
    await rm(directory, { recursive: true, force: true });
  });
  createControllers(upgrade ? '000003' : '000004');
  await claim();
  for (const role of ['todo', 'dag', 'workers']) {
    const owner = role === 'todo' ? todo : dag, paneId = `original-${role}`, pid = 1000 + ++serial;
    panes.set(paneId, { shell: shellRow(pid), tabId: 'tab' });
    await (role === 'todo' ? todo.launchTodo({ schema: 'omo-herdr-dashboard/pane/1', ...todo.binding, role,
      paneId, tabId: 'tab', scopeEpoch: 1, statePath: todo.stateFile, viewerPath: todo.viewer,
      nodePath: 'node', launchToken: `old-${role}`, creationProcessId: pid,
      creationDate: panes.get(paneId).shell.CreationDate, creationBirth: panes.get(paneId).shell.Birth,
      prepared: true, manualClose: false }) : dag.launchRole({ schema: 'omo-herdr-dashboard/pane/1',
      ...dag.binding, role, paneId, tabId: 'tab', scopeEpoch: 1, statePath: dag.roleFile(role),
      viewerPath: dag.viewer, nodePath: 'node', launchToken: `old-${role}`, creationProcessId: pid,
      creationDate: panes.get(paneId).shell.CreationDate, creationBirth: panes.get(paneId).shell.Birth,
      prepared: true, manualClose: false }));
  }
  if (upgrade) {
    const releasing = actor.release();
    await actor.drain('todo', todo.lifetimeId); await actor.drain('dag', dag.lifetimeId); await releasing;
    createControllers('000004');
    await claim();
  }
  if (!managed) { todo.actor = undefined; dag.managedActor = null; }
  const unknown = async (role = 'dag', type = 'arrange') => {
    const target = roleTarget(actor.snapshot.roles[role]);
    const gate = Promise.withResolvers(); pending.push(gate);
    await assert.rejects(actor.perform(actor.capability(role === 'todo' ? 'todo' : 'dag', role), { type, target },
      async ({ operation }) => {
        todo.effectObservations.set(operation.id, { promise: gate.promise, settled: false,
          ownerNonce: operation.ownerNonce, generation: operation.generation, lifetimeId: operation.lifetimeId });
        throw Object.assign(new Error('transport completion lost'), { code: 'transport_error' });
      }), { code: 'EFFECT_UNKNOWN' });
    return actor.snapshot.operations.at(-1);
  };
  return { directory, panes, calls, retirements, get todo() { return todo; }, get dag() { return dag; },
    get actor() { return actor; }, unknown, async restart() {
      const previousProducer = actor.snapshot.producer;
      producerRow.Birth = 'successor-birth';
      createControllers('000004');
      await claim(async () => ({ state: 'dead', identity: previousProducer }));
    }, setGetError(code) { getError = code; }, setListError(value) { listError = value; },
    setDuplicateParent(value) { duplicateParent = value; }, failDraining() { failDraining = true; } };
}

test('registered old-generation live viewers retire and relaunch all three roles in their original shells', async t => {
  const f = await registeredRecoveryFixture(t, { upgrade: true });
  await f.todo.schedule({ forceRoles: ['todo', 'dag', 'workers'] });
  assert.deepEqual(f.retirements, ['todo', 'dag', 'workers']);
  for (const role of ['todo', 'dag', 'workers']) {
    const file = role === 'todo' ? f.todo.recordFile : f.dag.paneFile(role);
    const record = JSON.parse(await readFile(file));
    assert.equal(record.paneId, `original-${role}`);
    assert.notEqual(record.launchToken, `old-${role}`);
    assert.equal(record.viewerPath, role === 'todo' ? f.todo.viewer : f.dag.viewer);
    assert.equal(record.nodePath, 'node');
    assert.equal(record.ready, true);
    assert.equal(f.actor.snapshot.roles[role].generation, f.actor.snapshot.generation);
  }
  assert.equal(f.calls.filter(args => ['close', 'split'].includes(args[0])).length, 0);
  assert.ok(f.actor.snapshot.operations.every(operation => operation.status === 'SETTLED'));
});

for (const operationRole of ['dag', 'workers']) test(`forced dashboard settles UNKNOWN ${operationRole} arrange after two external role closures without awaiting retained effects`, async t => {
  const f = await registeredRecoveryFixture(t);
  const operation = await f.unknown(operationRole);
  const goneRoles = operationRole === 'dag' ? ['dag', 'workers'] : ['todo', 'workers'];
  const retainedRole = operationRole === 'dag' ? 'todo' : 'dag';
  for (const role of goneRoles) f.panes.delete(`original-${role}`);
  await bounded(f.todo.schedule({ forceRoles: ['todo', 'dag', 'workers'] }));
  const settled = f.actor.snapshot.operations.find(value => value.id === operation.id);
  assert.equal(settled.status, 'SETTLED');
  assert.equal(settled.settlement.reason, 'target_gone');
  assert.equal(f.actor.blocked, false);
  assert.equal(f.actor.snapshot.closures.length, 2);
  assert.equal(f.actor.snapshot.roles[retainedRole].paneId, `original-${retainedRole}`);
  for (const role of goneRoles) assert.notEqual(f.actor.snapshot.roles[role].paneId, `original-${role}`);
  assert.equal(f.calls.filter(args => args[0] === 'split').length, 2);
  assert.equal(f.calls.filter(args => args[0] === 'close').length, 0);
});

for (const type of ['arrange', 'run', 'close']) test(`authoritative missing ${type} target bypasses pending retained effect`, async t => {
  const f = await registeredRecoveryFixture(t);
  const operation = await f.unknown('dag', type);
  f.panes.delete('original-dag');
  const observed = await bounded(f.todo.observeManaged({ target: operation.target, operation }));
  assert.deepEqual(observed.missing, { code: 'pane_not_found', paneId: 'original-dag' });
  assert.equal(observed.target, undefined);
});

for (const guard of ['transport_error', 'pane missing text', 'membership', 'duplicate-parent', 'producer'])
  test(`UNKNOWN target absence remains fail closed for ${guard}`, async t => {
    const f = await registeredRecoveryFixture(t);
    const operation = await f.unknown();
    f.panes.delete('original-dag');
    if (guard === 'membership') f.setListError(true);
    else if (guard === 'duplicate-parent') f.setDuplicateParent(true);
    else if (guard === 'producer') f.todo.inspectShell = async () => [];
    else f.setGetError(guard);
    await assert.rejects(bounded(f.todo.observeManaged({ target: operation.target, operation })));
    assert.equal(f.actor.snapshot.operations.find(value => value.id === operation.id).status, 'UNKNOWN');
    assert.equal(f.calls.filter(args => ['close', 'split', 'run'].includes(args[0])).length, 0);
  });

for (const failure of ['unknown', 'peer-drain', 'presence-close', 'publication'])
  test(`managed stop closes lease and both control pipes after ${failure} failure`, async t => {
    const f = await registeredRecoveryFixture(t);
    await f.todo.startControl(); await f.dag.startControl();
    const sockets = [net.createConnection(f.todo.controlPath), net.createConnection(f.dag.controlPath)];
    t.after(() => sockets.forEach(socket => socket.destroy()));
    await Promise.all(sockets.map(socket => once(socket, 'connect')));
    if (failure === 'unknown') await f.unknown();
    else if (failure === 'peer-drain') {
      const drain = f.todo.provider.drain;
      f.todo.provider.drain = async () => { await drain(); throw new Error('peer drain failed'); };
    }
    else if (failure === 'presence-close') f.todo.presence.close = async () => { throw new Error('presence close failed'); };
    else f.failDraining();
    await assert.rejects(bounded(f.todo.stop()));
    assert.equal(f.actor.db.isOpen, false);
    assert.equal(f.actor.leaseHeld, false);
    assert.equal(f.todo.control.listening, false);
    assert.equal(f.dag.control.listening, false);
  });

test('blocked controller restart recovers an absent UNKNOWN target under the successor lease', async t => {
  const f = await registeredRecoveryFixture(t);
  const operation = await f.unknown();
  f.panes.delete('original-dag'); f.panes.delete('original-workers');
  await assert.rejects(bounded(f.todo.stop()));
  assert.equal(f.actor.db.isOpen, false);
  await bounded(f.restart());
  assert.equal(f.actor.snapshot.operations.find(value => value.id === operation.id).status, 'SETTLED');
  assert.equal(f.actor.blocked, false);
  assert.ok(f.actor.leaseHeld);
  assert.ok(f.actor.snapshot.closures.some(closure => closure.role === 'dag' && closure.paneId === 'original-dag'));
});

test('producer reobservation distinguishes authoritative native absence from unreadable identity', async t => {
  const f = await registeredRecoveryFixture(t), identity = f.actor.snapshot.producer;
  assert.equal(await f.todo.observePreviousProducer(identity), null);
  f.todo.inspectShell = async () => [];
  assert.deepEqual(await f.todo.observePreviousProducer(identity), { identity, state: 'dead' });
  f.todo.inspectShell = async () => { throw new Error('native query unreadable'); };
  await assert.rejects(f.todo.observePreviousProducer(identity));
});

for (const guard of ['unregistered', 'different-product', 'newer-viewer', 'owner', 'session', 'tab', 'launch', 'native-viewer'])
  test(`live generation replacement rejects ${guard} identity without retirement or raw closure`, async t => {
    const f = await registeredRecoveryFixture(t, { upgrade: true });
    const file = f.todo.recordFile, original = JSON.parse(await readFile(file));
    let record = { ...original };
    if (guard === 'unregistered') delete f.actor.record.roles.todo;
    else if (guard === 'different-product') record.viewerPath = join(f.directory, 'other-product', 'generation-000003', 'todo', 'viewer.mjs');
    else if (guard === 'newer-viewer') record.viewerPath = join(f.directory, 'generation-000005', 'todo', 'viewer.mjs');
    else if (guard === 'owner') record.ownerKey = 'other-owner';
    else if (guard === 'session') record.sessionId = 'other-session';
    else if (guard === 'tab') record.tabId = 'other-tab';
    else if (guard === 'launch') record.launchToken = 'other-launch';
    else f.panes.get(record.paneId).viewer.Birth = 'reused-viewer-pid';
    await writeJson(file, record);
    await assert.rejects(f.todo.schedule({ forceRoles: ['todo', 'dag', 'workers'] }));
    assert.deepEqual(JSON.parse(await readFile(file)), record);
    assert.deepEqual(f.retirements, []);
    assert.equal(f.calls.filter(args => ['close', 'split', 'run'].includes(args[0])).length, 0);
  });

test('unmanaged old-generation record cannot borrow registered actor retirement authority', async t => {
  const f = await registeredRecoveryFixture(t, { upgrade: true, managed: false });
  await f.todo.schedule({ forceRoles: ['todo', 'dag', 'workers'] });
  assert.equal(f.todo.status, 'layout-waiting');
  assert.deepEqual(f.retirements, []);
  assert.equal(f.calls.filter(args => ['close', 'split', 'run'].includes(args[0])).length, 0);
});
