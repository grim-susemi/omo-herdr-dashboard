import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import { once, EventEmitter } from 'node:events';
import * as filesystem from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, rm, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixedDagPane, isBandDashboard, isColumnDashboard } from '../packages/dag/src/controller.mjs';
import { TodoPane } from '../packages/todo/src/controller.mjs';
import { claimParentSlot } from '../packages/todo/src/parent-slot.mjs';
import { writeJson } from '../packages/dag/src/storage.mjs';
import { createSplitTreeHerdr } from './helpers/split-tree-herdr.mjs';
import { createBandDashboard, NATIVE_MUTATIONS, readRecord } from './helpers/band-dashboard.mjs';

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

// Converted by todo 7 (task-7-test-mapping.md): an explicit managed placement now
// re-places a columns dashboard as the band, with the same journaled temporary
// split/swap/close moves through the coordinator; every temporary pane closes again.
test('managed placement journals temporary closure through actor authority and re-places columns as the band', async t => {
  const f = await bandPair(t, { direction: 'right', ratio: 0.4, first: 'parent', second: { direction: 'right', ratio: 0.5,
    first: { direction: 'down', ratio: 0.5, first: 'todo', second: 'workers' }, second: 'dag' } });
  for (const role of ['dag', 'workers']) {
    const record = f.record(f.dag, role, role, { layoutClaim: f.claim('columns') });
    await writeJson(f.dag.paneFile(role), record);
    f.dag.records.set(role, record);
  }
  f.dag.claim = f.claim('columns');
  const ids = { parent: 'parent', todo: 'todo', workers: 'workers', dag: 'dag' };
  const chat = () => f.fake.layout().panes.find(pane => pane.pane_id === 'parent').rect;
  assert.equal(isColumnDashboard(f.fake.layout(), ids), true);
  assert.deepEqual(chat(), { x: 0, y: 0, width: 69, height: 46 });
  await f.dag.arrangeDashboard();
  assert.deepEqual(f.mutations.map(args => args[0]),
    ['split', 'swap', 'focus', 'close', 'split', 'swap', 'focus', 'focus', 'close', 'swap', 'focus', 'resize', 'resize']);
  assert.equal(f.fake.calls.filter(args => NATIVE_MUTATIONS.includes(args[0])).length, f.mutations.length,
    'every native mutation went through the coordinator');
  assert.deepEqual(f.mutations.filter(args => args[0] === 'close').map(args => args[1]), ['created-1', 'created-2']);
  assert.equal(JSON.parse(await readFile(join(f.dag.directory, 'placement.json'))).phase, 'COMPLETE');
  assert.equal(isBandDashboard(f.fake.layout(), ids), true);
  assert.deepEqual(chat(), { x: 0, y: 0, width: 69, height: 46 });
  assert.deepEqual(f.fake.panes(), ['parent', 'todo', 'workers', 'dag']);
  assert.equal(f.dag.claim.layout, 'band');
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
    inspectShell: async pid => [{ ProcessId: pid, Birth: 'shell-birth', CreationDate: '2026-10-14T00:00:00.000Z',
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
  // Narrowed by todo 7 (task-7-test-mapping.md): an explicit /dashboard may re-place
  // panes through journaled temporary splits; the upgrade never splits or closes a role pane.
  assertNoRolePaneSplitOrClose(f.calls.map(call => call.args), f.records.map(({ record }) => record.paneId));
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
  // Narrowed by todo 7 (task-7-test-mapping.md), as above.
  assertNoRolePaneSplitOrClose(f.calls, ['todo', 'dag', 'workers'].map(role => `original-${role}`));
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

// Band layout for new managed dashboards, on the calibrated split-tree fake.
// Expected rects follow the measured split rule (task-1 S2): first child =
// round(fround(length * fround(ratio))). Fresh managed creation splits the chat
// once at chatShare 0.5 (derived, not measured natively), Todo keeps the top
// 0.35 and workers the left 0.4 of the row below it:
//   172x46 -> chat 86, Todo 86x16, workers 34x30, DAG 52x30
//   120x40 -> chat 60, Todo 60x14, workers 24x26, DAG 36x26
//   100x30 -> dashboard 50 wide, workers 20 < 24 columns: layout-waiting
const FRESH_BAND = {
  '172x46': { parent: [0, 0, 86, 46], todo: [86, 0, 86, 16], workers: [86, 16, 34, 30], dag: [120, 16, 52, 30] },
  '120x40': { parent: [0, 0, 60, 40], todo: [60, 0, 60, 14], workers: [60, 14, 24, 26], dag: [84, 14, 36, 26] },
};
const DASHBOARD = { forceRoles: ['todo', 'dag', 'workers'] };
const PARENT_SLOT_TYPES = ['split', 'run', 'close', 'arrange', 'retire'];
const head = call => call.args.slice(0, 7);
async function bandDashboard(t, options) {
  const f = await createBandDashboard(options);
  t.after(f.dispose);
  return f;
}
function assertActorOnly(f) {
  assert.ok(f.mutations().every(call => call.authority), 'every native mutation runs inside actor dispatch');
  assert.ok(f.actor.snapshot.operations.every(op => PARENT_SLOT_TYPES.includes(op.type)));
}

for (const size of Object.keys(FRESH_BAND)) test(`band_from_parent ${size}: fresh managed creation splits the chat once and ends as the band`, async t => {
  const [width, height] = size.split('x').map(Number);
  const f = await bandDashboard(t, { width, height });
  await f.todo.schedule();
  const ids = await f.ids();
  assert.equal(isBandDashboard(f.layout(), ids), true);
  assert.deepEqual(f.rects(ids), FRESH_BAND[size]);
  assert.deepEqual(f.mutations().map(head), [
    ['split', '--pane', 'parent', '--direction', 'right', '--ratio', '0.5'],
    ['split', '--pane', ids.todo, '--direction', 'down', '--ratio', '0.35'],
    ['split', '--pane', ids.workers, '--direction', 'right', '--ratio', '0.4'],
  ]);
  assertActorOnly(f);
  assert.deepEqual(f.actor.snapshot.operations.map(op => [op.type, op.role, op.status]),
    [['split', 'todo', 'SETTLED'], ['split', 'workers', 'SETTLED'], ['split', 'dag', 'SETTLED']]);
  assert.equal(f.fake.focused(), 'parent');
  assert.equal(await f.claimLayout(), 'band');
  await f.todo.schedule();
  assert.equal(f.mutations().length, 3, 'a matching band makes no further mutation');
  assert.deepEqual(f.warnings, []);
});

for (const [role, moment] of [['todo', 'before'], ['todo', 'after'], ['workers', 'before'], ['workers', 'after'],
  ['dag', 'before'], ['dag', 'after']]) test(`band_resume_each_receipt_stage: interrupted ${moment} the ${role} viewer launch, a restarted controller completes the band`, async t => {
  const f = await bandDashboard(t);
  f.hooks.launch = async (launched, at) => {
    if (launched === role && at === moment) throw Object.assign(new Error('QA interruption'), { code: 'QA_INTERRUPT' });
  };
  await assert.rejects(f.todo.schedule(), /QA interruption/);
  const before = await f.ids();
  delete f.hooks.launch;
  await f.restart();
  await f.todo.schedule();
  const ids = await f.ids();
  for (const key of Object.keys(before)) if (before[key]) assert.equal(ids[key], before[key], `${key} pane survives`);
  assert.equal(isBandDashboard(f.layout(), ids), true);
  assert.deepEqual(f.rects(ids), FRESH_BAND['172x46']);
  const splits = f.mutations().filter(call => call.args[0] === 'split');
  assert.equal(splits.length, 3, 'no split is replayed');
  assert.equal(splits.filter(call => call.args[2] === 'parent').length, 1, 'the chat is split once');
  assertActorOnly(f);
  assert.ok(f.actor.snapshot.operations.every(op => op.status === 'SETTLED'));
  assert.equal(await f.claimLayout(), 'band');
  assert.equal(f.fake.focused(), 'parent');
});

test('band_reopen_missing_role: a closed workers pane reopens by splitting the live DAG right and swapping workers left', async t => {
  const f = await bandDashboard(t);
  await f.todo.schedule();
  const before = await f.ids();
  await f.exitPane(before.workers);
  const count = f.mutations().length;
  await f.todo.schedule();
  assert.equal(f.mutations().length, count, 'an automatic pass never reopens a closed role');
  await f.todo.schedule(DASHBOARD);
  const ids = await f.ids();
  assert.notEqual(ids.workers, before.workers);
  assert.equal(ids.todo, before.todo);
  assert.equal(ids.dag, before.dag);
  const added = f.mutations().slice(count);
  assert.deepEqual(head(added[0]), ['split', '--pane', before.dag, '--direction', 'right', '--ratio', '0.4']);
  assert.deepEqual(added[1].args, ['swap', '--source-pane', ids.workers, '--target-pane', before.dag]);
  assert.ok(added.length > 2 && added.slice(2).every(call => call.args[0] === 'focus'), 'only focus restoration follows the swap');
  assertActorOnly(f);
  assert.equal(isBandDashboard(f.layout(), ids), true);
  assert.deepEqual(f.rects(ids), FRESH_BAND['172x46']);
  assert.equal(f.fake.focused(), 'parent');
});

test('band_reopen_missing_role: a closed DAG reopens right of the live workers without a swap', async t => {
  const f = await bandDashboard(t);
  await f.todo.schedule();
  const before = await f.ids();
  await f.exitPane(before.dag);
  const count = f.mutations().length;
  await f.todo.schedule(DASHBOARD);
  const ids = await f.ids();
  assert.notEqual(ids.dag, before.dag);
  assert.equal(ids.workers, before.workers);
  assert.deepEqual(f.mutations().slice(count).map(head),
    [['split', '--pane', before.workers, '--direction', 'right', '--ratio', '0.4']]);
  assertActorOnly(f);
  assert.equal(isBandDashboard(f.layout(), ids), true);
  assert.deepEqual(f.rects(ids), FRESH_BAND['172x46']);
});

test('band_reopen_missing_role: after every role pane is gone, /dashboard reopens the band like a fresh one', async t => {
  const f = await bandDashboard(t);
  await f.todo.schedule();
  const before = await f.ids();
  for (const role of ['todo', 'workers', 'dag']) await f.exitPane(before[role]);
  const count = f.mutations().length;
  await f.todo.schedule();
  assert.equal(f.mutations().length, count, 'an automatic pass never reopens a closed dashboard');
  await f.todo.schedule(DASHBOARD);
  const ids = await f.ids();
  assert.deepEqual(f.mutations().slice(count).map(head), [
    ['split', '--pane', 'parent', '--direction', 'right', '--ratio', '0.5'],
    ['split', '--pane', ids.todo, '--direction', 'down', '--ratio', '0.35'],
    ['split', '--pane', ids.workers, '--direction', 'right', '--ratio', '0.4'],
  ]);
  assertActorOnly(f);
  assert.equal(isBandDashboard(f.layout(), ids), true);
  assert.deepEqual(f.rects(ids), FRESH_BAND['172x46']);
});

async function bandPair(t, tree) {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-band-pair-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fake = createSplitTreeHerdr({ tree, area: { x: 0, y: 0, width: 172, height: 46 }, focused: 'parent' });
  const mutations = [];
  const todo = new TodoPane({ managed: true, stateDir: directory, cwd: directory, herdr: fake.herdr,
    environment: { HERDR_SOCKET_PATH: 'qa:socket', HERDR_PANE_ID: 'parent' },
    ctx: { sessionManager: { getSessionId: () => 'session' } }, viewer: join(directory, 'todo-viewer.mjs') });
  todo.scopeEpoch = 1;
  const dag = new FixedDagPane({ managedAvailable: true, stateDir: directory, cwd: directory, herdr: fake.herdr,
    socket: 'qa:socket', parentPane: 'parent', sessionId: 'session', node: 'node', viewer: join(directory, 'dag-viewer.mjs'),
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
  dag.verify = todo.verify = async record => record?.ready && fake.panes().includes(record.paneId) ? { pid: 200 } : null;
  dag.launchRole = async record => {
    const ready = { ...record, ready: true, processId: 200 };
    dag.records.set(record.role, ready);
    await writeJson(dag.paneFile(record.role), ready);
    await writeJson(dag.roleFile(record.role), dag.roleState(ready));
    return ready;
  };
  const record = (owner, role, paneId, extra = {}) => ({ schema: 'omo-herdr-dashboard/pane/1', ...owner.binding,
    role, paneId, tabId: 'tab', scopeEpoch: 1, launchToken: `${role}-launch`,
    statePath: role === 'todo' ? owner.stateFile : owner.roleFile(role), viewerPath: owner.viewer, nodePath: 'node',
    ready: true, processId: 200, ...extra });
  await writeJson(todo.recordFile, record(todo, 'todo', 'todo'));
  const claim = layout => ({ ...dag.binding, lifetimeId: todo.lifetimeId, tabId: 'tab', ...(layout ? { layout } : {}) });
  return { fake, todo, dag, actor, mutations, record, claim };
}
const todoAlone = { direction: 'right', ratio: 0.5, first: 'parent', second: 'todo' };

for (const layout of ['band', 'columns']) test(`band_reopen_missing_role: a manually closed DAG ${layout === 'band' ? 'no longer prevents workers from opening in the band' : 'still stops the columns pair'}`, async t => {
  const f = await bandPair(t, todoAlone);
  await writeJson(f.dag.paneFile('dag'), f.record(f.dag, 'dag', 'closed-dag', { manualClose: true, ready: false }));
  const pair = await f.dag.openPair({ claim: f.claim(layout) });
  assert.equal(pair.dag, undefined);
  if (layout === 'columns') {
    assert.deepEqual(f.mutations, []);
    assert.equal(pair.workers, undefined);
    return;
  }
  assert.deepEqual(f.mutations.map(args => args.slice(0, 7)), [['split', '--pane', 'todo', '--direction', 'down', '--ratio', '0.35']]);
  const rect = id => f.fake.layout().panes.find(pane => pane.pane_id === id).rect;
  assert.deepEqual(rect('todo'), { x: 86, y: 0, width: 86, height: 16 });
  assert.deepEqual(rect(pair.workers.paneId), { x: 86, y: 16, width: 86, height: 30 });
});

test('a band claim with legacy records never enters the legacy stacked branch', async t => {
  const f = await bandPair(t, { direction: 'right', ratio: 0.5, first: 'parent',
    second: { direction: 'down', ratio: 0.35, first: 'todo', second: 'workers' } });
  const legacy = { layoutClaim: f.claim() }; // a pre-columns claim: no layout field
  await writeJson(f.dag.paneFile('workers'), f.record(f.dag, 'workers', 'workers', legacy));
  await writeJson(f.dag.paneFile('dag'), f.record(f.dag, 'dag', 'gone-dag', { ...legacy, manualClose: true, ready: false }));
  await writeJson(f.dag.legacyRecordFile, { paneId: 'legacy-dag', sessionId: 'session' });
  f.actor.snapshot.closures.push({ role: 'dag', paneId: 'gone-dag', sessionId: 'session', reason: 'pane_not_found' });
  const pair = await f.dag.openPair({ force: true, forceRoles: ['dag'], claim: f.claim('band') });
  assert.deepEqual(f.mutations.map(args => args.slice(0, 7)), [['split', '--pane', 'workers', '--direction', 'right', '--ratio', '0.4']]);
  assert.equal(f.fake.calls.filter(args => ['resize', 'swap', 'move'].includes(args[0])).length, 0);
  const ids = { parent: 'parent', todo: 'todo', workers: 'workers', dag: pair.dag.paneId };
  assert.equal(isBandDashboard(f.fake.layout(), ids), true);
  assert.deepEqual(f.fake.layout().panes.find(pane => pane.pane_id === ids.dag).rect, { x: 120, y: 16, width: 52, height: 30 });
});

test('an unknown layout claim is refused before any mutation instead of using the legacy stacked branch', async t => {
  const f = await bandPair(t, todoAlone);
  await assert.rejects(f.dag.openPair({ claim: f.claim('rows') }), error => /^layout-waiting: /.test(error.message));
  assert.deepEqual(f.mutations, []);
  assert.deepEqual(f.fake.panes(), ['parent', 'todo']);
});

test('band_dashboard_widths_40_80_99_100_200: the 24-column workers floor refuses only the 40-column dashboard', async t => {
  // chatShare 0.5: a terminal 2d columns wide opens a dashboard area d columns wide.
  // Workers = round(fround(d * fround(0.4))); readableWorkersColumns 40 is reporting only.
  const workersAt = { 80: 32, 99: 40, 100: 40, 200: 80 };
  for (const d of [40, 80, 99, 100, 200]) {
    const f = await bandDashboard(t, { width: 2 * d, height: 46 });
    await f.todo.schedule();
    if (d === 40) {
      assert.equal(f.mutations().length, 0, 'workers would be 16 columns');
      assert.equal(f.todo.status, 'layout-waiting');
      assert.equal(f.warnings.length, 1);
      assert.match(f.warnings[0], /^layout-waiting: /);
      continue;
    }
    const ids = await f.ids(), workers = workersAt[d];
    assert.equal(isBandDashboard(f.layout(), ids), true, `dashboard ${d}`);
    assert.deepEqual(f.rects(ids), { parent: [0, 0, d, 46], todo: [d, 0, d, 16],
      workers: [d, 16, workers, 30], dag: [d + workers, 16, d - workers, 30] }, `dashboard ${d}`);
    assert.deepEqual(f.warnings, [], `dashboard ${d}`);
  }
});

for (const [width, height] of [[100, 30], [172, 21]]) test(`band below the minimum at ${width}x${height}: layout-waiting, zero mutations, one notify`, async t => {
  const f = await bandDashboard(t, { width, height });
  await f.todo.schedule();
  await f.todo.schedule();
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'size waiting is not a recovery block');
  assert.equal(f.mutations().length, 0);
  assert.deepEqual(f.actor.snapshot.operations, []);
  assert.equal(await readRecord(f.todo.recordFile), null);
  assert.equal(await readRecord(join(f.dag.directory, 'placement.json')), null);
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /^layout-waiting: /);
  await f.todo.schedule(DASHBOARD);
  assert.equal(f.mutations().length, 0);
  assert.equal(f.warnings.length, 2, 'an explicit /dashboard always answers');
  assert.match(f.warnings[1], /^layout-waiting: /);
});

test('band_height_resize_retry: a short terminal waits once, and a geometry-only enlargement opens the band', async t => {
  const f = await bandDashboard(t, { width: 172, height: 21, events: true });
  await f.todo.schedule();
  assert.equal(f.mutations().length, 0);
  assert.equal(f.todo.status, 'layout-waiting');
  await bounded(f.subscribed);
  const schedule = f.todo.schedule.bind(f.todo);
  let next = Promise.withResolvers();
  f.todo.schedule = options => { const pass = schedule(options); next.resolve(pass); return pass; };
  const retried = async () => {
    const pass = await bounded(next.promise);
    next = Promise.withResolvers();
    await bounded(pass);
  };
  f.resize({ width: 150, height: 21 });
  f.emitLayout();
  await retried();
  assert.equal(f.mutations().length, 0, 'still too short: nothing is created');
  assert.equal(f.warnings.length, 1, 'the same wait is not announced again');
  f.resize({ width: 172, height: 22 });
  f.emitLayout();
  await retried();
  const ids = await f.ids();
  assert.equal(isBandDashboard(f.layout(), ids), true);
  assert.deepEqual(f.rects(ids), { parent: [0, 0, 86, 22], todo: [86, 0, 86, 8], workers: [86, 8, 34, 14], dag: [120, 8, 52, 14] });
  assertActorOnly(f);
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /^layout-waiting: /);
});

test('band_unknown_split_no_replay: a workers split whose receipt was lost is never replayed', async t => {
  const f = await bandDashboard(t);
  f.hooks.lose = args => args[0] === 'split' && args[args.indexOf('--direction') + 1] === 'down';
  await assert.rejects(f.todo.schedule(), { code: 'EFFECT_UNKNOWN' });
  delete f.hooks.lose;
  const splits = () => f.mutations().filter(call => call.args[0] === 'split').length;
  assert.equal(splits(), 2);
  const unknown = f.actor.snapshot.operations.filter(op => op.status === 'UNKNOWN');
  assert.deepEqual(unknown.map(op => [op.type, op.role]), [['split', 'workers']]);
  await assert.rejects(f.todo.schedule());
  await assert.rejects(f.todo.schedule(DASHBOARD));
  assert.equal(splits(), 2, 'no split is replayed after an unknown effect');
  assert.equal(f.mutations().filter(call => call.args[0] === 'close').length, 0);
  assert.equal(f.actor.snapshot.operations.find(op => op.id === unknown[0].id).status, 'UNKNOWN');
  assert.equal(f.fake.panes().length, 3, 'the unconfirmed pane is left for recovery, never raw-closed');
});

test('band unmanaged regression: fresh unmanaged creation keeps its columns order, claim and geometry', async t => {
  const f = await bandDashboard(t, { managed: false });
  await f.todo.schedule();
  const ids = await f.ids();
  assert.deepEqual(f.mutations().map(call => call.args[0] === 'split' ? head(call) : call.args), [
    ['split', '--pane', 'parent', '--direction', 'right', '--ratio', '0.4'],
    ['split', '--pane', ids.dag, '--direction', 'right', '--ratio', '0.5'],
    ['swap', '--source-pane', ids.workers, '--target-pane', ids.dag],
    ['focus', '--pane', ids.workers, '--direction', 'left'],
    ['split', '--pane', ids.workers, '--direction', 'down', '--ratio', '0.5'],
    ['swap', '--source-pane', ids.todo, '--target-pane', ids.workers],
    ['focus', '--pane', ids.todo, '--direction', 'left'],
  ]);
  assert.equal(isColumnDashboard(f.layout(), ids), true);
  assert.deepEqual(f.rects(ids), { parent: [0, 0, 69, 46], todo: [69, 0, 52, 23], workers: [69, 23, 52, 23], dag: [121, 0, 51, 46] });
  assert.equal(await f.claimLayout(), 'columns');
  assert.equal(f.fake.focused(), 'parent');
});

// A conversation change keeps the parent's live role panes. The new
// conversation has no Todo record of its own, yet its dashboard region is not
// new: it keeps the layout its role records were created with, and no automatic
// pass splits or resizes its chat (G2). The old conversation's Todo is absent:
// a columns pair opened without one, or a band whose Todo was closed.
for (const [layout, width, chat] of [['columns', 400, 160], ['columns', 172, 69], ['band', 400, 200], ['band', 172, 86]])
  test(`band_session_transition ${layout} ${width}x46: an inherited region without a Todo record keeps its chat and its ${layout} claim`, async t => {
    const f = await bandDashboard(t, { width, sessionId: 'old-conversation' });
    if (layout === 'columns') {
      await f.dag.openPair({ force: true, claim: { ...f.todo.binding, tabId: 'tab', lifetimeId: f.todo.lifetimeId, layout: 'columns' } });
    } else {
      await f.todo.schedule();
      await f.exitPane((await f.ids()).todo);
    }
    const before = { ...await f.ids(), todo: undefined }, rects = f.rects(before);
    assert.deepEqual(rects.parent, [0, 0, chat, 46]);
    await f.restart({ sessionId: 'new-conversation' });
    const count = f.mutations().length, operations = f.actor.snapshot.operations.map(op => op.id);
    await f.todo.schedule();
    await f.todo.schedule();
    const ids = await f.ids();
    assert.deepEqual(ids, before, 'the same workers and DAG panes, no Todo pane');
    assert.deepEqual(f.rects(ids), rects, 'the chat and both role panes keep their rects');
    assert.deepEqual(f.mutations().slice(count).map(head), [], 'no split, swap, resize or close: the chat is never split');
    assert.equal(f.todo.claim.layout, layout);
    for (const role of ['workers', 'dag'])
      assert.equal((await readRecord(f.dag.paneFile(role))).layoutClaim?.layout, layout, `${role} keeps its claim`);
    assert.deepEqual(f.actor.snapshot.operations.filter(op => !operations.includes(op.id))
      .map(op => [op.type, op.role, op.status]).sort(), [['retire', 'dag', 'SETTLED'], ['retire', 'workers', 'SETTLED']],
    'the inherited viewers are only relaunched in place');
    assert.deepEqual(f.warnings, []);
  });

test('band_session_transition: inherited role records with mixed layout claims wait without any mutation', async t => {
  const f = await bandDashboard(t, { width: 400, sessionId: 'old-conversation' });
  await f.dag.openPair({ force: true, claim: { ...f.todo.binding, tabId: 'tab', lifetimeId: f.todo.lifetimeId, layout: 'columns' } });
  const file = f.dag.paneFile('dag'), record = await readRecord(file);
  await writeJson(file, { ...record, layoutClaim: { ...record.layoutClaim, layout: 'band' } });
  const rects = f.rects(await f.ids());
  await f.restart({ sessionId: 'new-conversation' });
  const count = f.mutations().length;
  await f.todo.schedule();
  await f.todo.schedule();
  assert.deepEqual(f.mutations().slice(count).map(head), []);
  assert.deepEqual(f.rects(await f.ids()), rects);
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'an undetermined layout is a wait, not a recovery block');
  assert.equal(f.warnings.length, 1, 'one notice across two automatic passes');
  assert.match(f.warnings[0], /^layout-waiting: /);
  assert.ok(f.warnings[0].includes('/dashboard'));
});

// Fresh creation needs a provably empty region (G2): no owned role pane may have
// a row in the native list. A row that does not place the pane in the parent's
// tab is no proof of absence, so the pass waits once and mutates nothing.
// 'missing tab identity' is the exact case of the second gate review.
const unverifiableRows = {
  'missing tab identity': (rows, owned) => rows.map(row => owned.has(row.pane_id) ? { ...row, tab_id: undefined } : row),
  'duplicate rows': (rows, owned) => rows.flatMap(row => owned.has(row.pane_id)
    ? [{ ...row, tab_id: 'other-tab' }, { ...row, tab_id: 'other-tab' }] : [row]),
  'unreadable pane identity': (rows, owned) => rows.map(row => owned.has(row.pane_id) ? { ...row, pane_id: undefined } : row),
  'another tab': (rows, owned) => rows.map(row => owned.has(row.pane_id) ? { ...row, tab_id: 'other-tab' } : row),
};
for (const [name, rows] of Object.entries(unverifiableRows)) test(`band_unverified_region ${name}: live role panes without a provable tab membership wait without splitting the chat`, async t => {
  const f = await bandDashboard(t, { width: 400 });
  await f.dag.openPair({ force: true, claim: { ...f.todo.binding, tabId: 'tab', lifetimeId: f.todo.lifetimeId, layout: 'columns' } });
  const ids = await f.ids(), rects = f.rects(ids), owned = new Set([ids.workers, ids.dag]), herdr = f.fake.herdr;
  assert.deepEqual(rects.parent, [0, 0, 160, 46]);
  f.fake.herdr = async (...args) => {
    const result = await herdr(...args);
    return args[0] === 'list' ? { ...result, panes: rows(result.panes, owned) } : result;
  };
  const count = f.mutations().length;
  await f.todo.schedule();
  await f.todo.schedule();
  assert.deepEqual(f.mutations().slice(count).map(head), [], 'no split, swap, resize or close: the chat is never split');
  assert.deepEqual(f.rects(ids), rects, 'the chat and both role panes keep their rects');
  assert.equal(await readRecord(f.todo.recordFile), null, 'no Todo is created');
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'an unverifiable region is a wait, not a recovery block');
  assert.equal(f.warnings.length, 1, 'one notice across two automatic passes');
  assert.match(f.warnings[0], /^layout-waiting: /);
  assert.ok(f.warnings[0].includes('/dashboard'));
});

test('band_unverified_region: inherited role records with an unknown layout claim wait without any mutation', async t => {
  const f = await bandDashboard(t, { width: 400, sessionId: 'old-conversation' });
  await f.dag.openPair({ force: true, claim: { ...f.todo.binding, tabId: 'tab', lifetimeId: f.todo.lifetimeId, layout: 'columns' } });
  for (const role of ['workers', 'dag']) {
    const file = f.dag.paneFile(role), record = await readRecord(file);
    await writeJson(file, { ...record, layoutClaim: { ...record.layoutClaim, layout: 'rows' } });
  }
  const rects = f.rects(await f.ids());
  await f.restart({ sessionId: 'new-conversation' });
  const count = f.mutations().length;
  await f.todo.schedule();
  await f.todo.schedule();
  assert.equal(f.todo.binding.sessionId, 'new-conversation');
  assert.deepEqual(f.mutations().slice(count).map(head), []);
  assert.deepEqual(f.rects(await f.ids()), rects);
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'an undetermined layout is a wait, not a recovery block');
  assert.equal(f.warnings.length, 1, 'one notice across two automatic passes');
  assert.match(f.warnings[0], /^layout-waiting: /);
});

// Only owned role panes decide: unrelated panes in the tab, readable or not,
// leave the region empty, and the band opens inside the chat's own rectangle.
for (const tabless of [false, true]) test(`band_foreign_panes${tabless ? ' without a tab identity' : ''}: a tab holding only unrelated panes still gets the fresh band`, async t => {
  const f = await bandDashboard(t, { width: 400 });
  // A pane opened outside the dashboard, not through the controllers.
  const foreign = (await f.fake.herdr('split', '--pane', 'parent', '--direction', 'right', '--ratio', '0.5', '--no-focus')).pane.pane_id;
  if (tabless) {
    const herdr = f.fake.herdr;
    f.fake.herdr = async (...args) => {
      const result = await herdr(...args);
      return args[0] === 'list'
        ? { ...result, panes: result.panes.map(row => row.pane_id === foreign ? { ...row, tab_id: undefined } : row) } : result;
    };
  }
  await f.todo.schedule();
  const ids = await f.ids();
  assert.deepEqual(f.rects({ ...ids, foreign }), { parent: [0, 0, 100, 46], todo: [100, 0, 100, 16],
    workers: [100, 16, 40, 30], dag: [140, 16, 60, 30], foreign: [200, 0, 200, 46] });
  assert.deepEqual(f.mutations().map(head), [
    ['split', '--pane', 'parent', '--direction', 'right', '--ratio', '0.5'],
    ['split', '--pane', ids.todo, '--direction', 'down', '--ratio', '0.35'],
    ['split', '--pane', ids.workers, '--direction', 'right', '--ratio', '0.4'],
  ]);
  assertActorOnly(f);
  assert.equal(f.fake.focused(), 'parent');
  assert.equal(await f.claimLayout(), 'band');
  assert.deepEqual(f.warnings, []);
});

// FRESH also needs a fully readable list: a row without a pane id could be an
// owned role pane whose record and registration are gone, so it proves nothing.
test('band_foreign_panes with an unreadable row: a list row without a pane id is no proof of an empty region, so the band waits', async t => {
  const f = await bandDashboard(t, { width: 400 });
  const foreign = (await f.fake.herdr('split', '--pane', 'parent', '--direction', 'right', '--ratio', '0.5', '--no-focus')).pane.pane_id;
  const herdr = f.fake.herdr;
  f.fake.herdr = async (...args) => {
    const result = await herdr(...args);
    return args[0] === 'list'
      ? { ...result, panes: result.panes.map(row => row.pane_id === foreign ? { ...row, pane_id: undefined } : row) } : result;
  };
  const rects = f.rects({ parent: 'parent', foreign });
  await f.todo.schedule();
  await f.todo.schedule();
  assert.deepEqual(f.mutations().map(head), [], 'no split: the chat is never split');
  assert.deepEqual(f.rects({ parent: 'parent', foreign }), rects);
  assert.equal(await readRecord(f.todo.recordFile), null, 'no Todo is created');
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery block');
  assert.equal(f.warnings.length, 1, 'one notice across two automatic passes');
  assert.match(f.warnings[0], /^layout-waiting: .*\/dashboard/);
});

// Attempt 4 (verify-task-6-r3.md B1): an inherited region is decided by a whitelist.
// Each role's evidence comes from its pane record, its parent-slot registration
// and the native list rows of every pane either one names. Only a role that is
// consistent in all three, or one with no signal in any source, lets a
// conversation change go on; every other combination waits before any mutation.
const MATRIX_ROLES = ['workers', 'dag'];
const MATRIX_STATES = ['absent-everywhere', 'consistent', 'record-missing', 'record-malformed', 'slot-missing',
  'slot-pane-id-mismatch', 'list-missing', 'list-no-tab', 'list-other-tab', 'list-duplicate'];
// The whitelist oracle, written from the plan rather than from the controller.
// todo: the claim of a live, consistent Todo (attempt 5), else undefined.
function whitelistOutcome(states, claims, todo) {
  const signalled = MATRIX_ROLES.filter(role => states[role] !== 'absent-everywhere');
  if (!signalled.length && !todo) return 'FRESH';
  const layouts = new Set([...signalled.map(role => claims[role]), ...todo ? [todo] : []]);
  return signalled.every(role => states[role] === 'consistent') && layouts.size === 1 &&
    ['band', 'columns'].includes([...layouts][0]) ? 'INHERITED' : 'WAIT';
}
// The region decision as the Todo controller consumes it: null opens fresh, a
// layout keeps the inherited region, anything else waits.
const regionOutcome = region => region === null ? 'FRESH' : region?.layout ? 'INHERITED' : 'WAIT';
const matrixRows = {
  'list-missing': (rows, id) => rows.filter(row => row.pane_id !== id),
  'list-no-tab': (rows, id) => rows.map(row => row.pane_id === id ? { ...row, tab_id: undefined } : row),
  'list-other-tab': (rows, id) => rows.map(row => row.pane_id === id ? { ...row, tab_id: 'other-tab' } : row),
  'list-duplicate': (rows, id) => rows.flatMap(row => row.pane_id === id ? [row, { ...row }] : [row]),
};
// Attempt 5 (verify-task-6-r4.md B1): a record file that exists but holds no
// record (false, null, 0, '', {}, [] or nothing) is a malformed signal, never absence.
const recordTexts = { 'record-false': 'false', 'record-null': 'null', 'record-zero': '0', 'record-empty-string': '""',
  'record-empty-object': '{}', 'record-array': '[]', 'record-empty-file': '' };
const FALSY_STATES = Object.keys(recordTexts);
const hideRegistration = (roles, role, id) => { if (roles[role]?.paneId === id) delete roles[role]; };
const matrixSlot = {
  'absent-everywhere': hideRegistration,
  'slot-missing': hideRegistration,
  'slot-pane-id-mismatch': (roles, role, id) => { if (roles[role]?.paneId === id) roles[role].paneId = 'stale-pane'; },
};
// One conversation change at 400x46, shaped like the verify-task-6-r3.md
// reproduction: the old conversation leaves a workers/DAG pair (columns, or a
// band whose Todo was closed), each role's evidence is altered, and restart({
// sessionId }) hands the parent slot to a new conversation without a Todo record.
// The slot registration is altered in the view the controllers read; the actor's
// stored slot is never edited. With 'after' the evidence changes only once the
// new conversation has adopted the region, so its next automatic passes decide.
// Attempt 5 options: base 'todo-band' keeps a live band Todo (todo: its claim);
// transition 'none' alters the evidence of the running conversation instead of
// changing conversation, 'session' then restarts the same conversation (r4 B2); a state may combine parts with '+'.
async function whitelistCell(t, { states, claims, base = 'columns', after = false, transition = 'conversation', todo,
  expected = whitelistOutcome(states, claims, todo) }) {
  const f = await createBandDashboard({ width: 400, sessionId: 'old-conversation' });
  const parts = role => states[role].split('+');
  try {
    if (base === 'band') { await f.todo.schedule(); await f.exitPane((await f.ids()).todo); }
    else if (base === 'todo-band') await f.todo.schedule();
    else await f.dag.openPair({ force: true, claim: { ...f.todo.binding, tabId: 'tab', lifetimeId: f.todo.lifetimeId, layout: 'columns' } });
    const old = await f.ids();
    const recorded = base === 'todo-band' ? 'band' : base;
    for (const role of MATRIX_ROLES) if (claims[role] !== recorded) {
      const file = f.dag.paneFile(role), record = await readRecord(file);
      await writeJson(file, { ...record, layoutClaim: { ...record.layoutClaim, layout: claims[role] } });
    }
    if (todo && todo !== 'band') {
      const record = await readRecord(f.todo.recordFile);
      await writeJson(f.todo.recordFile, { ...record, layoutClaim: { ...record.layoutClaim, layout: todo } });
    }
    const alter = async () => {
      for (const role of MATRIX_ROLES) for (const state of parts(role)) {
        if (state === 'absent-everywhere') { await f.exitPane(old[role]); await rm(f.dag.roleFile(role), { force: true }); }
        if (state === 'closed') await f.exitPane(old[role]);
        if (['absent-everywhere', 'record-missing'].includes(state)) await rm(f.dag.paneFile(role), { force: true });
        if (state === 'record-malformed')
          await writeJson(f.dag.paneFile(role), { schema: 'omo-herdr-dashboard/pane/1', role, paneId: old[role] });
        if (state in recordTexts) await filesystem.writeFile(f.dag.paneFile(role), recordTexts[state]);
      }
      const herdr = f.fake.herdr;
      f.fake.herdr = async (...args) => {
        const result = await herdr(...args);
        if (args[0] !== 'list') return result;
        let rows = result.panes;
        for (const role of MATRIX_ROLES) for (const state of parts(role)) rows = matrixRows[state]?.(rows, old[role]) ?? rows;
        return { ...result, panes: rows };
      };
    };
    if (transition === 'none') await alter();
    else if (transition === 'session') { await alter(); await f.restart(); }
    else {
      if (!after) await alter();
      await f.restart({ sessionId: 'new-conversation' });
      assert.equal(f.todo.binding.sessionId, 'new-conversation');
    }
    if (after) {
      await f.todo.schedule();
      assert.equal(regionOutcome(await f.dag.ownedRegion()), 'INHERITED', 'the new conversation adopted the region');
      await alter();
    }
    const actor = f.actor, snapshot = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(actor), 'snapshot').get;
    Object.defineProperty(actor, 'snapshot', { configurable: true, get() {
      const value = snapshot.call(this);
      for (const role of MATRIX_ROLES) for (const state of parts(role)) matrixSlot[state]?.(value.roles, role, old[role]);
      return value;
    } });
    const decisions = [], ownedRegion = f.dag.ownedRegion.bind(f.dag);
    f.dag.ownedRegion = async (...args) => { const region = await ownedRegion(...args); decisions.push(region); return region; };
    const before = { chat: f.rects({ parent: 'parent' }).parent, focus: f.fake.focused(), panes: new Set(f.fake.panes()),
      mutations: f.mutations().length, warnings: f.warnings.length };
    const errors = [];
    for (let pass = 0; pass < 2; pass++) await f.todo.schedule().catch(error => errors.push(error.message));
    const added = f.mutations().slice(before.mutations).map(head), live = new Set(f.fake.panes());
    const notices = f.warnings.slice(before.warnings);
    // No decision: refused earlier (the pass threw) or never consulted (it did not).
    const outcome = decisions.length ? regionOutcome(decisions[0]) : errors.length ? 'WAIT' : 'UNDECIDED';
    t.diagnostic(JSON.stringify({ expected, outcome, decided: decisions.length > 0, added: added.length,
      status: f.todo.status, latch: Boolean(f.todo.recoveryBlocked), notices: notices.length, errors }));
    assert.equal(outcome, expected, 'the outcome class follows the whitelist');
    assert.equal(f.fake.focused(), before.focus, 'input focus is unchanged');
    if (expected === 'FRESH') {
      assert.equal(todo, undefined);
      const ids = await f.ids();
      assert.deepEqual(before.chat, [0, 0, 400, 46]);
      assert.deepEqual(f.rects({ parent: 'parent' }).parent, [0, 0, 200, 46], 'first creation splits the chat once');
      assert.deepEqual(added, [
        ['split', '--pane', 'parent', '--direction', 'right', '--ratio', '0.5'],
        ['split', '--pane', ids.todo, '--direction', 'down', '--ratio', '0.35'],
        ['split', '--pane', ids.workers, '--direction', 'right', '--ratio', '0.4'],
      ]);
    } else assert.deepEqual(f.rects({ parent: 'parent' }).parent, before.chat, 'the chat rect is unchanged');
    for (const role of MATRIX_ROLES) {
      const recorded = (await readRecord(f.dag.paneFile(role)).catch(() => undefined))?.paneId, registered = actor.record.roles[role]?.paneId;
      const panes = new Set([old[role], recorded, registered].filter(id => id && live.has(id)));
      assert.ok(panes.size <= 1, `at most one live ${role} pane: ${[...panes]}`);
      if (live.has(old[role])) assert.ok(![recorded, registered].some(id => id && !before.panes.has(id)),
        `${role} is not registered to a new pane while its old pane lives`);
    }
    assert.ok(notices.length <= 1, 'at most one automatic notice');
    if (expected === 'WAIT') {
      assert.deepEqual(added, [], 'a wait makes zero mutations');
      if (decisions.length) {
        assert.equal(f.todo.status, 'layout-waiting');
        assert.ok(!f.todo.recoveryBlocked, 'a region wait is not a recovery block');
        assert.equal(notices.length, 1, 'one notice across two automatic passes');
        assert.match(notices[0], /^layout-waiting: .*\/dashboard/);
      }
    }
    if (expected === 'INHERITED') {
      const layout = todo ?? [...new Set(MATRIX_ROLES.filter(role => states[role] === 'consistent').map(role => claims[role]))][0];
      if (!layout) throw new Error('an INHERITED cell needs a consistent role');
      assert.equal(regionOutcome(decisions.at(-1)), 'INHERITED');
      assert.equal(f.todo.claim.layout, layout, 'the inherited claim is kept');
      assert.ok(added.every(args => args[0] === 'split' && args[2] !== 'parent'),
        'only a role with no signal anywhere is reopened, by a split beside the chat');
      if (!todo) assert.equal(await readRecord(f.todo.recordFile), null, 'the inherited Todo stays absent until /dashboard');
      else assert.equal((await f.ids()).todo, old.todo, 'the live Todo stays');
    }
  } finally { await f.dispose(); }
}
const COLUMNS = { workers: 'columns', dag: 'columns' }, BAND = { workers: 'band', dag: 'band' };
const crossProduct = (claims, base, after) => MATRIX_STATES.flatMap(workers => MATRIX_STATES.map(dag =>
  ({ name: `workers ${workers} x dag ${dag}`, states: { workers, dag }, claims, base, after })));
for (const [label, cells] of [
  ['columns pair', crossProduct(COLUMNS, 'columns', false)],
  ['band without Todo', crossProduct(BAND, 'band', false)],
  ['columns pair, evidence changed after adoption', crossProduct(COLUMNS, 'columns', true)],
]) test(`band_whitelist_matrix ${label}: a conversation change at 400x46 over every workers x DAG evidence state`,
  { concurrency: 8 }, async t => {
    await Promise.all(cells.map(cell => t.test(`band_whitelist_matrix ${label}: ${cell.name}`, c => whitelistCell(c, cell))));
  });
test('band_whitelist_matrix claims: only one band or columns claim across the consistent roles is inherited', { concurrency: 8 }, async t => {
  const both = { workers: 'consistent', dag: 'consistent' };
  const cells = [
    [both, BAND, 'band'], [both, COLUMNS, 'columns'],
    [both, { workers: 'columns', dag: 'band' }, 'columns'], [both, { workers: 'band', dag: 'columns' }, 'columns'],
    [both, { workers: 'rows', dag: 'rows' }, 'columns'], [both, { workers: 'columns', dag: 'rows' }, 'columns'],
    [{ workers: 'consistent', dag: 'absent-everywhere' }, BAND, 'band'],
    [{ workers: 'absent-everywhere', dag: 'consistent' }, BAND, 'band'],
    [{ workers: 'consistent', dag: 'absent-everywhere' }, { workers: 'rows', dag: 'columns' }, 'columns'],
    [{ workers: 'absent-everywhere', dag: 'consistent' }, { workers: 'columns', dag: 'rows' }, 'columns'],
  ];
  await Promise.all(cells.map(([states, claims, base]) => t.test(
    `band_whitelist_matrix claims: workers ${states.workers}/${claims.workers} x dag ${states.dag}/${claims.dag}`,
    c => whitelistCell(c, { states, claims, base }))));
});

// A closed role: its pane really exited, its record and slot registration stay.
// Closed in the old conversation, it leaves only a registration naming a gone pane
// (records live per conversation), so it is like a role with no signal. Closed
// after the new conversation adopted the region, its record is this conversation's:
// an automatic pass then never opens a fresh dashboard over it (only /dashboard).
test('band_whitelist_matrix closed roles: a closed role counts as no signal, but never lets an automatic pass reopen a closed dashboard', { concurrency: 8 }, async t => {
  const cells = [
    [{ workers: 'closed', dag: 'consistent' }, false, 'INHERITED'],
    [{ workers: 'consistent', dag: 'closed' }, false, 'INHERITED'],
    [{ workers: 'closed', dag: 'closed' }, false, 'FRESH'],
    [{ workers: 'closed', dag: 'record-missing' }, false, 'WAIT'],
    [{ workers: 'closed', dag: 'consistent' }, true, 'INHERITED'],
    [{ workers: 'consistent', dag: 'closed' }, true, 'INHERITED'],
    [{ workers: 'closed', dag: 'closed' }, true, 'WAIT'],
    [{ workers: 'closed', dag: 'list-no-tab' }, true, 'WAIT'],
  ];
  await Promise.all(cells.map(([states, after, expected]) => t.test(
    `band_whitelist_matrix closed roles${after ? ', closed after adoption' : ''}: workers ${states.workers} x dag ${states.dag}`,
    c => whitelistCell(c, { states, claims: COLUMNS, after, expected }))));
});
test('band_whitelist closed dashboard: after the adopted workers and DAG panes close, an automatic pass waits and /dashboard reopens the band', async t => {
  const f = await bandDashboard(t, { width: 400, sessionId: 'old-conversation' });
  await f.dag.openPair({ force: true, claim: { ...f.todo.binding, tabId: 'tab', lifetimeId: f.todo.lifetimeId, layout: 'columns' } });
  const old = await f.ids();
  await f.restart({ sessionId: 'new-conversation' });
  await f.todo.schedule();
  for (const role of MATRIX_ROLES) await f.exitPane(old[role]);
  const count = f.mutations().length;
  await f.todo.schedule();
  await f.todo.schedule();
  assert.deepEqual(f.mutations().slice(count).map(head), [], 'an automatic pass never reopens a closed dashboard');
  assert.equal(await readRecord(f.todo.recordFile), null, 'no Todo is created');
  assert.deepEqual(f.rects({ parent: 'parent' }).parent, [0, 0, 400, 46]);
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery block');
  assert.equal(f.warnings.length, 1, 'one notice across two automatic passes');
  assert.match(f.warnings[0], /^layout-waiting: .*\/dashboard/);
  await f.todo.schedule(DASHBOARD);
  const ids = await f.ids();
  assert.deepEqual(f.mutations().slice(count).map(head), [
    ['split', '--pane', 'parent', '--direction', 'right', '--ratio', '0.5'],
    ['split', '--pane', ids.todo, '--direction', 'down', '--ratio', '0.35'],
    ['split', '--pane', ids.workers, '--direction', 'right', '--ratio', '0.4'],
  ], '/dashboard reopens the band like a fresh one');
  assert.equal(isBandDashboard(f.layout(), ids), true);
  assert.deepEqual(f.rects(ids), { parent: [0, 0, 200, 46], todo: [200, 0, 200, 16], workers: [200, 16, 80, 30], dag: [280, 16, 120, 30] });
  assertActorOnly(f);
  assert.equal(f.fake.focused(), 'parent');
});

// Attempt 5 (verify-task-6-r4.md): the same whitelist with a live Todo, and with
// record files that exist but hold no record. A live Todo is one more role in the
// decision; it is consulted on every managed pass, Todo live or not (B2).
const BAND_TODO = { base: 'todo-band', transition: 'none', todo: 'band' };
test('band_whitelist_matrix live Todo: evidence of a live band changes, then two automatic passes, over every workers x DAG state',
  { concurrency: 8 }, async t => {
    await Promise.all(crossProduct(BAND, 'todo-band', false).map(cell => t.test(
      `band_whitelist_matrix live Todo: ${cell.name}`, c => whitelistCell(c, { ...cell, ...BAND_TODO }))));
  });
test('band_whitelist_matrix live Todo claims: the Todo claim must agree with every consistent role', { concurrency: 8 }, async t => {
  const both = { workers: 'consistent', dag: 'consistent' };
  const cells = [
    ['band', BAND], ['columns', BAND], ['columns', { workers: 'band', dag: 'rows' }], ['band', COLUMNS],
    ['band', { workers: 'band', dag: 'columns' }], ['rows', BAND], ['columns', COLUMNS],
    ['columns', { workers: 'columns', dag: 'band' }],
  ];
  await Promise.all(cells.map(([todo, claims]) => t.test(
    `band_whitelist_matrix live Todo claims: todo ${todo} x workers ${claims.workers} x dag ${claims.dag}`,
    c => whitelistCell(c, { states: both, claims, ...BAND_TODO, transition: 'session', todo }))));
});
test('band_whitelist_matrix falsy records: a record file that exists but holds no record always waits', { concurrency: 8 }, async t => {
  const cells = [];
  for (const value of FALSY_STATES) {
    cells.push([`same conversation, both ${value}+slot-missing`, { workers: `${value}+slot-missing`, dag: `${value}+slot-missing` },
      { transition: 'none' }]);
    cells.push([`same conversation, both ${value}`, { workers: value, dag: value }, { transition: 'none' }]);
    cells.push([`same conversation, workers ${value}+slot-missing, dag consistent`,
      { workers: `${value}+slot-missing`, dag: 'consistent' }, { transition: 'none' }]);
    cells.push([`conversation change, both ${value}`, { workers: value, dag: value }, {}]);
    cells.push([`live Todo, both ${value}+slot-missing`, { workers: `${value}+slot-missing`, dag: `${value}+slot-missing` },
      BAND_TODO]);
    cells.push([`live Todo, workers ${value}, dag consistent`, { workers: value, dag: 'consistent' }, BAND_TODO]);
  }
  await Promise.all(cells.map(([name, states, options]) => t.test(`band_whitelist_matrix falsy records: ${name}`,
    c => whitelistCell(c, { states, claims: options.todo ? BAND : COLUMNS, ...options }))));
});

// The four verify-task-6-r4.md reproductions, unchanged, as assertions.
const columnsClaim = f => ({ ...f.todo.binding, tabId: 'tab', lifetimeId: f.todo.lifetimeId, layout: 'columns' });
for (const value of ['false', 'null', '0', '""']) test(`band_whitelist r4-B1 FALSY_RECORDS_WITH_LIVE_REGION ${value}: present records holding ${value} wait; the chat is never split`, async t => {
  const f = await bandDashboard(t, { width: 400 });
  await f.dag.openPair({ force: true, claim: columnsClaim(f) });
  const old = await f.ids(), before = f.rects(old);
  const files = new Set([f.dag.paneFile('workers'), f.dag.paneFile('dag')]), read = fs.promises.readFile;
  fs.promises.readFile = async (path, ...rest) => files.has(String(path)) ? value : read(path, ...rest);
  syncBuiltinESMExports();
  t.after(() => { fs.promises.readFile = read; syncBuiltinESMExports(); });
  const get = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(f.actor), 'snapshot').get;
  Object.defineProperty(f.actor, 'snapshot', { get() { const s = get.call(this); delete s.roles.workers; delete s.roles.dag; return s; } });
  const region = await f.dag.ownedRegion(), n = f.mutations().length;
  assert.notEqual(region, null, 'a present record is a signal, not absence');
  assert.equal(region.layout, undefined);
  assert.match(region.waiting, /^layout-waiting: /);
  let error;
  try { await f.todo.schedule(); } catch (caught) { error = caught.message; }
  assert.equal(error, undefined, 'a wait, not a throw');
  assert.deepEqual(f.mutations().slice(n).map(head), [], 'no split: the chat is never halved');
  assert.deepEqual(f.rects(old), before);
  assert.equal(f.fake.panes().length, 3);
  assert.equal(f.fake.focused(), 'parent');
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery block');
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /^layout-waiting: .*\/dashboard/);
});
test('band_whitelist r4-B2 THREE_WAY_CLAIMS: a live Todo with columns/band/rows claims waits; no automatic rearrangement', async t => {
  const f = await bandDashboard(t, { width: 172 });
  await f.todo.schedule();
  const ids = await f.ids();
  for (const [role, layout] of [['todo', 'columns'], ['workers', 'band'], ['dag', 'rows']]) {
    const file = role === 'todo' ? f.todo.recordFile : f.dag.paneFile(role), record = await readRecord(file);
    await writeJson(file, { ...record, layoutClaim: { ...record.layoutClaim, layout } });
  }
  await f.restart();
  const before = f.rects(ids), n = f.mutations().length;
  await f.todo.schedule();
  assert.deepEqual(f.mutations().slice(n).map(head), [], 'no split, swap, close, resize or focus');
  assert.deepEqual(f.rects(ids), before, 'chat [0,0,86,46] and every role rect unchanged');
  assert.equal(f.fake.focused(), 'parent');
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery block');
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /^layout-waiting: .*\/dashboard/);
});
test('band_whitelist r4-B3 TOCTOU: an owned region that arrives after the FRESH decision stops the chat split', async t => {
  const f = await bandDashboard(t, { width: 400 });
  const query = f.dag.ownedRegion.bind(f.dag);
  let armed = true, old, before, n;
  f.dag.ownedRegion = async o => {
    const decision = await query(o);
    if (armed) {
      armed = false;
      await f.dag.openPair({ force: true, claim: columnsClaim(f) });
      old = await f.ids(); before = f.rects(old); n = f.mutations().length;
    }
    return decision;
  };
  await f.todo.schedule();
  assert.deepEqual(before.parent, [0, 0, 160, 46]);
  assert.deepEqual(f.mutations().slice(n).map(head), [], 'the stale FRESH decision splits nothing');
  assert.deepEqual(f.rects(old), before, 'chat [0,0,160,46] and the arrived pair unchanged');
  assert.equal((await f.ids()).todo, undefined, 'no Todo pane');
  assert.equal(f.fake.focused(), 'parent');
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery block');
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /^layout-waiting: .*\/dashboard/);
});
test('band_whitelist TOCTOU live Todo: evidence that changes after the decision stops the reopening split', async t => {
  const f = await bandDashboard(t, { width: 400 });
  await f.todo.schedule();
  const ids = await f.ids();
  await f.exitPane(ids.dag);
  await rm(f.dag.paneFile('dag'), { force: true });
  await rm(f.dag.roleFile('dag'), { force: true });
  const get = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(f.actor), 'snapshot').get;
  Object.defineProperty(f.actor, 'snapshot', { get() {
    const s = get.call(this); if (s.roles.dag?.paneId === ids.dag) delete s.roles.dag; return s; } });
  const query = f.dag.ownedRegion.bind(f.dag);
  let armed = true;
  f.dag.ownedRegion = async o => {
    const decision = await query(o);
    if (armed) {
      armed = false;
      const record = await readRecord(f.todo.recordFile);
      await writeJson(f.todo.recordFile, { ...record, layoutClaim: { ...record.layoutClaim, layout: 'columns' } });
    }
    return decision;
  };
  const before = f.rects({ parent: 'parent', todo: ids.todo, workers: ids.workers }), n = f.mutations().length;
  await f.todo.schedule();
  assert.deepEqual(f.mutations().slice(n).map(head), [], 'the DAG is not reopened on the stale decision');
  assert.deepEqual(f.rects({ parent: 'parent', todo: ids.todo, workers: ids.workers }), before);
  assert.equal(f.fake.focused(), 'parent');
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery block');
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /^layout-waiting: .*\/dashboard/);
});
test('band_whitelist TOCTOU explicit: a role record lost after the decision does not split a registered live role again', async t => {
  const f = await bandDashboard(t, { width: 400 });
  await f.todo.schedule();
  const ids = await f.ids(), query = f.dag.ownedRegion.bind(f.dag);
  let armed = true;
  f.dag.ownedRegion = async o => {
    const decision = await query(o);
    if (armed) { armed = false; await rm(f.dag.paneFile('dag'), { force: true }); }
    return decision;
  };
  const n = f.mutations().length;
  await f.todo.schedule(DASHBOARD).catch(() => {});
  assert.deepEqual(f.mutations().slice(n).map(head).filter(args => args[0] === 'split'), [], 'no second DAG pane');
  assert.equal(f.fake.panes().length, 4);
  assert.ok(f.fake.panes().includes(ids.dag), 'the registered DAG pane stays');
});
for (const explicit of [true, false]) test(`band_whitelist r4-B4 REAL_UNDERSIZE_WAIT${explicit ? '' : ' automatic'}: a minimum refusal while reopening makes no mutation and creates no Todo`, async t => {
  const f = await bandDashboard(t, { width: 172 });
  await f.todo.schedule();
  const ids = await f.ids();
  await f.exitPane(ids.todo);
  await f.exitPane(ids.dag);
  await f.fake.herdr('resize', '--pane', 'parent', '--direction', 'right', '--amount', '0.3');
  const before = f.rects(ids), n = f.mutations().length;
  assert.deepEqual([before.parent, before.workers], [[0, 0, 138, 46], [138, 0, 34, 46]]);
  await f.todo.schedule(explicit ? DASHBOARD : undefined);
  assert.deepEqual(f.mutations().slice(n).map(head), [], 'zero mutations below the floor');
  assert.deepEqual(f.rects(ids), before);
  assert.deepEqual(f.fake.panes().sort(), ['parent', ids.workers].sort(), 'no Todo pane is created');
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery block');
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /^layout-waiting: .*larger terminal/);
});

// Attempt 6 (verify-task-6-r5.md): the authority is the dispatcher's last await
// before the native command, inside the parent-slot dispatch. Evidence or size that
// changes after the controller gate, inside the actor, still stops the mutation.
const failedOperations = f => f.actor.snapshot.operations.filter(op => op.status !== 'SETTLED');
test('band_whitelist r5-A1 RESUME_CHANGED_AFTER_GATE: evidence changed inside the parent-slot dispatch stops the split', async t => {
  const f = await bandDashboard(t, { width: 400 });
  f.hooks.launch = async (role, moment) => {
    if (role === 'workers' && moment === 'after') throw Object.assign(new Error('QA interruption'), { code: 'QA_INTERRUPT' });
  };
  await f.todo.schedule().catch(() => {});
  delete f.hooks.launch;
  await f.restart();
  const ids = await f.ids(), before = f.rects(ids), n = f.mutations().length, w = f.warnings.length;
  const original = f.todo.invalidateCustodyEffect.bind(f.todo);
  let region;
  f.todo.invalidateCustodyEffect = async operation => {
    await original(operation);
    if (operation.type === 'split' && operation.role === 'dag') {
      const record = await readRecord(f.todo.recordFile);
      await writeJson(f.todo.recordFile, { ...record, layoutClaim: { ...record.layoutClaim, layout: 'columns' } });
      region = await f.dag.ownedRegion();
    }
  };
  await f.todo.schedule();
  assert.match(region?.waiting ?? '', /^layout-waiting: /, 'the region is WAIT immediately before the native split');
  assert.deepEqual(f.mutations().slice(n).map(head), [], 'no DAG split');
  assert.deepEqual(f.rects(ids), before, 'workers keeps [200,16,200,30]');
  assert.equal((await f.ids()).dag, undefined);
  assert.equal(f.fake.focused(), 'parent');
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery block');
  assert.equal(f.actor.blocked, false, 'the actor is not latched');
  assert.deepEqual(failedOperations(f), [], 'the refused split settled without effect, never UNKNOWN');
  const notices = f.warnings.slice(w);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /^layout-waiting: .*\/dashboard/);
});
for (const seam of ['preflight', 'dispatch']) test(`band_whitelist r5-A2 SIZE_CHANGED_AFTER_${seam.toUpperCase()}: a geometry-only shrink to 80x46 stops the first chat split; enlarging creates the band`, async t => {
  const f = await bandDashboard(t, { width: 172, height: 46 });
  let once = true, atResize;
  const shrink = () => { once = false; f.resize({ width: 80, height: 46 }); atResize = f.mutations().length; };
  if (seam === 'preflight') {
    const preflight = f.dag.bandPreflight.bind(f.dag);
    f.dag.bandPreflight = async () => {
      const result = await preflight();
      if (once) { assert.equal(result, null, 'the preflight passed at 172x46'); shrink(); }
      return result;
    };
  } else {
    const original = f.todo.invalidateCustodyEffect.bind(f.todo);
    f.todo.invalidateCustodyEffect = async operation => {
      await original(operation);
      if (once && operation.type === 'split' && operation.role === 'todo') shrink();
    };
  }
  await f.todo.schedule();
  await f.todo.schedule();
  assert.equal(atResize, 0, 'the shrink came before any mutation');
  assert.deepEqual(f.mutations().map(head), [], 'zero mutations below the floor');
  assert.deepEqual(f.rects({ parent: 'parent' }).parent, [0, 0, 80, 46]);
  assert.equal(f.fake.focused(), 'parent');
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery block');
  assert.equal(f.actor.blocked, false, 'the actor is not latched');
  assert.deepEqual(failedOperations(f), [], 'no UNKNOWN operation');
  assert.equal(f.warnings.length, 1, 'one notice across both passes');
  assert.match(f.warnings[0], /^layout-waiting: .*larger terminal/);
  f.resize({ width: 172, height: 46 });
  await f.todo.schedule();
  assert.deepEqual(f.mutations().filter(call => call.args[0] === 'split').length, 3, 'the band is created once the terminal is large enough');
  assert.equal(f.todo.status, 'current');
});

// Attempt 7 (verify-task-6-r6.md): the final authorization gathers all evidence
// and the current geometry first, then decides and issues herdr in one
// synchronous run. Both tests drive the PRODUCTION TodoPane.mutate dispatcher.
async function interruptedAfterWorkers(t) {
  const f = await bandDashboard(t, { width: 400 });
  f.hooks.launch = async (role, moment) => {
    if (role === 'workers' && moment === 'after') throw Object.assign(new Error('QA interruption'), { code: 'QA_INTERRUPT' });
  };
  await f.todo.schedule().catch(() => {});
  delete f.hooks.launch;
  await f.restart();
  delete f.todo.mutate; // the production prototype dispatcher, not the fixture's
  return f;
}
const assertDispatchWait = async (f, { ids, before, n, w }) => {
  assert.deepEqual(f.mutations().slice(n).map(head), [], 'no DAG split');
  assert.deepEqual(f.rects(ids), before, 'workers keeps [200,16,200,30]');
  assert.equal((await f.ids()).dag, undefined);
  assert.equal(f.fake.focused(), 'parent');
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery block');
  assert.equal(f.actor.blocked, false, 'the actor is not latched');
  assert.deepEqual(f.actor.snapshot.operations.filter(op => op.status !== 'SETTLED'), [], 'never UNKNOWN');
  assert.deepEqual([...f.todo.effectObservations.values()].filter(entry => !entry.settled), [],
    'no unsettled effect observation is left by the refused operation');
  const notices = f.warnings.slice(w);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /^layout-waiting: .*\/dashboard/);
};
test('band_whitelist r6-A1 CLAIM_CHANGED_INSIDE_FINAL_LAYOUT_READ: a claim written while the final authorization reads the layout stops the split', async t => {
  const f = await interruptedAfterWorkers(t);
  const ids = await f.ids(), before = f.rects(ids), n = f.mutations().length, w = f.warnings.length;
  let armed = false, changed = false, atChange;
  const custody = f.todo.invalidateCustodyEffect.bind(f.todo);
  f.todo.invalidateCustodyEffect = async op => { await custody(op); if (op.type === 'split' && op.role === 'dag') armed = true; };
  const native = f.fake.herdr;
  f.fake.herdr = async (...args) => {
    const result = await native(...args);
    if (armed && !changed && args[0] === 'layout') {
      changed = true;
      const record = await readRecord(f.todo.recordFile);
      await writeJson(f.todo.recordFile, { ...record, layoutClaim: { ...record.layoutClaim, layout: 'columns' } });
      atChange = { region: await f.dag.ownedRegion(), mutations: f.mutations().length - n };
    }
    return result;
  };
  await f.todo.schedule();
  assert.ok(changed, 'the claim changed inside the final layout read');
  assert.match(atChange.region?.waiting ?? '', /^layout-waiting: /);
  assert.equal(atChange.mutations, 0);
  await assertDispatchWait(f, { ids, before, n, w });
});
test('band_whitelist r6-C PRODUCTION_DISPATCH_REFUSAL: a no-effect refusal in the production dispatcher leaves no unsettled effect observation', async t => {
  const f = await interruptedAfterWorkers(t);
  const ids = await f.ids(), before = f.rects(ids), n = f.mutations().length, w = f.warnings.length;
  const custody = f.todo.invalidateCustodyEffect.bind(f.todo);
  f.todo.invalidateCustodyEffect = async op => {
    await custody(op);
    if (op.type === 'split' && op.role === 'dag') {
      const record = await readRecord(f.todo.recordFile);
      await writeJson(f.todo.recordFile, { ...record, layoutClaim: { ...record.layoutClaim, layout: 'columns' } });
    }
  };
  await f.todo.schedule();
  await assertDispatchWait(f, { ids, before, n, w });
});

// Report one old role record as ENOENT at the filesystem read boundary, exactly
// like the verify-task-6-r3.md reproduction; everything else stays intact.
function hideRecord(t, file) {
  const read = fs.promises.readFile;
  fs.promises.readFile = async (path, ...rest) => {
    if (String(path) === file) throw Object.assign(new Error('fixture old role record absent'), { code: 'ENOENT' });
    return read(path, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.promises.readFile = read; syncBuiltinESMExports(); });
}

// verify-task-6-r3.md B1, LIVE_SLOT_MISSING_RECORD_TRANSITION: the old role's
// pane, slot registration and viewer live on, only its record is unreadable.
for (const role of MATRIX_ROLES) test(`band_whitelist B1 LIVE_SLOT_MISSING_RECORD_TRANSITION ${role}: a live registered ${role} pane without its record waits; no split, swap or focus change`, async t => {
  const f = await bandDashboard(t, { width: 400, sessionId: 'old-conversation' });
  await f.dag.openPair({ force: true, claim: { ...f.todo.binding, tabId: 'tab', lifetimeId: f.todo.lifetimeId, layout: 'columns' } });
  const oldIds = await f.ids(), before = f.rects(oldIds), file = f.dag.paneFile(role), old = await readRecord(file);
  hideRecord(t, file);
  await f.restart({ sessionId: 'new-conversation' });
  assert.equal(f.todo.binding.sessionId, 'new-conversation');
  const count = f.mutations().length;
  await f.todo.schedule();
  await f.todo.schedule();
  assert.deepEqual(f.mutations().slice(count).map(head), [], 'no split, swap or focus');
  assert.deepEqual(f.rects(oldIds), before, 'the chat and both role panes keep their rects');
  assert.deepEqual(f.fake.panes().sort(), [oldIds.workers, oldIds.dag, 'parent'].sort(), 'one pane per role');
  assert.equal(f.fake.focused(), 'parent');
  assert.equal(f.actor.record.roles[role].paneId, oldIds[role], 'the slot still registers the original pane');
  assert.ok((await f.dag.inspectShell(old.creationProcessId)).some(row => row.ProcessId === old.processId),
    'the original viewer is untouched');
  assert.equal(await readRecord(f.todo.recordFile), null, 'no Todo is created');
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery block');
  assert.equal(f.warnings.length, 1, 'one notice across two automatic passes');
  assert.match(f.warnings[0], /^layout-waiting: .*\/dashboard/);
});

// Defense in depth: with the Todo live the region decision never runs, so
// ensureRole itself refuses to split or swap for a role whose slot registration
// still names a live pane, whatever its record says, on automatic and explicit passes.
for (const role of MATRIX_ROLES) test(`band_role_guard ${role}: while Todo is live, a registered live ${role} pane whose record is missing is never split, swapped or duplicated`, async t => {
  const f = await bandDashboard(t);
  await f.todo.schedule();
  const ids = await f.ids(), rects = f.rects(ids);
  assert.deepEqual(rects, FRESH_BAND['172x46']);
  hideRecord(t, f.dag.paneFile(role));
  const count = f.mutations().length;
  await f.todo.schedule();
  assert.deepEqual(f.mutations().slice(count).map(head), [], 'an automatic pass makes no mutation');
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery block');
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /^layout-waiting: .*\/dashboard/);
  await f.todo.schedule(DASHBOARD).catch(() => {});
  assert.deepEqual(f.mutations().slice(count).map(head), [], 'an explicit /dashboard makes no mutation either');
  assert.deepEqual(f.rects(ids), rects);
  assert.deepEqual(f.fake.panes().sort(), Object.values(ids).sort(), 'one pane per role');
  assert.equal(f.fake.focused(), 'parent');
  assert.equal(f.actor.record.roles[role].paneId, ids[role], 'the slot still registers the original pane');
});

// ---- Todo 7: an explicit /dashboard migrates a live columns dashboard to the band in place ----

// The measured band (task-1-tree.md section 2) for a chat at 40 percent.
const BAND_TARGET = {
  '172x46': { parent: [0, 0, 69, 46], todo: [69, 0, 103, 16], workers: [69, 16, 41, 30], dag: [110, 16, 62, 30] },
  '120x40': { parent: [0, 0, 48, 40], todo: [48, 0, 72, 14], workers: [48, 14, 29, 26], dag: [77, 14, 43, 26] },
  '100x30': { parent: [0, 0, 40, 30], todo: [40, 0, 60, 11], workers: [40, 11, 24, 19], dag: [64, 11, 36, 19] },
};
const COLUMNS_SOURCE = {
  '172x46': { parent: [0, 0, 69, 46], todo: [69, 0, 52, 23], workers: [69, 23, 52, 23], dag: [121, 0, 51, 46] },
  '120x40': { parent: [0, 0, 48, 40], todo: [48, 0, 36, 20], workers: [48, 20, 36, 20], dag: [84, 0, 36, 40] },
  '100x30': { parent: [0, 0, 40, 30], todo: [40, 0, 30, 15], workers: [40, 15, 30, 15], dag: [70, 0, 30, 30] },
};
const nextGeneration = generation => String(Number(generation) + 1).padStart(6, '0');
const roleFiles = f => [f.todo.recordFile, f.dag.paneFile('workers'), f.dag.paneFile('dag')];
const claims = async f => Promise.all(roleFiles(f).map(async file => (await readRecord(file))?.layoutClaim?.layout));
const actorType = verb => ({ split: 'split', close: 'close' })[verb] ?? 'arrange';

// G3, narrowed G2: no role pane is split off or closed and the chat is never split;
// every split pane is a temporary placement pane that is closed again.
function assertNoRolePaneSplitOrClose(calls, roleIds) {
  const closes = calls.filter(args => args[0] === 'close').map(args => args[1]);
  const splits = calls.filter(args => args[0] === 'split');
  assert.ok(closes.every(id => !roleIds.includes(id)), 'no role pane is closed');
  assert.ok(splits.every(args => args[args.indexOf('--pane') + 1] !== 'parent'), 'the chat is never split');
  assert.equal(splits.length, closes.length, 'every split pane is a temporary placement pane, closed again');
}
// G2: no dashboard mutation targets the chat or a divider it shares (task-1 S4).
function assertChatUntouched(calls, ids) {
  for (const args of calls) {
    const pane = args[0] === 'swap' ? [args[2], args[4]] : args[0] === 'close' ? [args[1]] : [args[args.indexOf('--pane') + 1]];
    if (args[0] !== 'focus') assert.ok(!pane.includes('parent'), `the chat is never a ${args[0]} target`);
    if (args[0] === 'resize') assert.ok(!([ids.workers, ids.todo].includes(pane[0]) &&
      args[args.indexOf('--direction') + 1] === 'left'), 'never resize workers or Todo left (the chat divider)');
  }
}
// Snapshot the chat after every native mutation took effect, then run 'also'.
function watchPhases(f, also) {
  const phases = [];
  f.hooks.after = async args => {
    if (NATIVE_MUTATIONS.includes(args[0])) {
      const layout = f.layout();
      phases.push({ verb: args[0], area: layout.area, root: layout.splits[0],
        chat: layout.panes.find(pane => pane.pane_id === 'parent').rect });
    }
    await also?.(args);
  };
  return phases;
}
const rectArray = rect => [rect.x, rect.y, rect.width, rect.height];
// The three viewers paint: their paint ACKs reach the production paintManaged
// as the presence channel would report them; the actor turns READY on its own.
async function paintAll(f, sequence) {
  Object.assign(f.todo.presence, { getOwner: () => ({}), isReady: () => true });
  for (const role of ['todo', 'dag', 'workers']) f.todo.paintManaged({ role, sequence });
  await f.todo.managedIdle();
}

// Install generation 7 as it ran: the same controllers without the band
// (provider.bandLayout absent) open Todo by splitting the chat right 0.6, the
// DAG right of Todo and workers below Todo. The 40 percent chat of the
// documented fixture (R/VERIFICATION.md:59) came from that generation's parent
// resize; it is applied natively here, as fixture setup.
async function liveColumns(t, { width = 172, height = 46, ...options } = {}) {
  const f = await bandDashboard(t, { width, height, generation: '000007', ...options });
  const provider = f.todo.provider, band = provider.bandLayout;
  delete provider.bandLayout;
  try { await f.todo.schedule(); } finally { provider.bandLayout = band; }
  const ids = await f.ids();
  assert.equal(isColumnDashboard(f.layout(), ids), true, 'generation 7 opened columns');
  assert.deepEqual(await claims(f), ['columns', 'columns', 'columns']);
  const root = f.layout().splits[0], desired = Math.round(width * 0.4);
  await f.fake.herdr('resize', '--pane', 'parent', '--direction', 'left', '--amount', String(root.ratio - desired / width));
  assert.deepEqual(f.rects(ids), COLUMNS_SOURCE[`${width}x${height}`]);
  return { f, ids };
}
// The measured migration (task-1 b2): 9 mutations and 4 focus restorations.
async function assertMigrated(f, ids, size, { phases, from, operations }) {
  const added = f.mutations().slice(from).map(call => call.args);
  const [t1, t2] = added.filter(args => args[0] === 'close').map(args => args[1]);
  const [height, region] = [Number(size.split('x')[1]), BAND_TARGET[size].todo[2]];
  const todoRows = BAND_TARGET[size].todo[3], workersColumns = BAND_TARGET[size].workers[2];
  assert.deepEqual(added.map(args => args[0] === 'split' ? args.slice(0, 7) : args), [
    ['split', '--pane', ids.todo, '--direction', 'down', '--ratio', '0.5'],
    ['swap', '--source-pane', ids.dag, '--target-pane', t1],
    ['focus', '--pane', ids.dag, '--direction', 'left'],
    ['close', t1],
    ['split', '--pane', ids.dag, '--direction', 'right', '--ratio', '0.5'],
    ['swap', '--source-pane', ids.workers, '--target-pane', t2],
    ['focus', '--pane', ids.workers, '--direction', 'left'],
    ['focus', '--pane', ids.dag, '--direction', 'left'],
    ['close', t2],
    ['swap', '--source-pane', ids.workers, '--target-pane', ids.dag],
    ['focus', '--pane', ids.workers, '--direction', 'left'],
    ['resize', '--pane', ids.todo, '--direction', 'up', '--amount', String(Math.abs(0.5 - todoRows / height))],
    ['resize', '--pane', ids.dag, '--direction', 'left', '--amount', String(Math.abs(0.5 - workersColumns / region))],
  ], 'the task-1 b2 sequence: amounts from the stored ratio of the split being changed');
  assert.equal(phases.length, added.length, 'one phase snapshot per native mutation');
  for (const phase of phases) assert.deepEqual(rectArray(phase.chat), BAND_TARGET[size].parent, `the chat rect is identical after ${phase.verb}`);
  assertChatUntouched(added, ids);
  assertActorOnly(f);
  const settled = f.actor.snapshot.operations.filter(op => !operations.has(op.id));
  assert.deepEqual(settled.map(op => op.type), added.map(args => actorType(args[0])), 'one actor operation per mutation');
  assert.ok(settled.every(op => op.status === 'SETTLED'));
  assert.deepEqual(await f.ids(), ids, 'the same pane ids');
  assert.deepEqual(f.fake.panes().sort(), Object.values(ids).sort(), 'no temporary pane remains');
  assert.equal(isBandDashboard(f.layout(), ids), true);
  assert.deepEqual(f.rects(ids), BAND_TARGET[size]);
  assert.equal((await readRecord(join(f.dag.directory, 'placement.json'))).phase, 'COMPLETE');
  assert.equal(f.fake.focused(), 'parent', 'focus ends on the chat');
  assert.deepEqual(await claims(f), ['band', 'band', 'band'], 'the claim becomes band after success');
  assert.equal(f.todo.claim.layout, 'band');
}

test('band_live_columns_generation 172x46: an upgrade, /reload and scheduled passes keep generation 7 columns untouched; explicit /dashboard migrates the same panes in place', async t => {
  const { f, ids } = await liveColumns(t);
  const splits = JSON.stringify(f.layout().splits);
  // The next install generation relaunches the live viewers in place (retire, then run in the same shell).
  await f.restart({ generation: nextGeneration('000007') });
  const n = f.mutations().length, known = new Set(f.actor.snapshot.operations.map(op => op.id));
  await f.todo.schedule();
  assert.deepEqual(f.actor.snapshot.operations.filter(op => !known.has(op.id)).map(op => [op.type, op.role, op.status]).sort(),
    [['retire', 'dag', 'SETTLED'], ['retire', 'todo', 'SETTLED'], ['retire', 'workers', 'SETTLED']]);
  for (const file of roleFiles(f)) assert.ok((await readRecord(file)).viewerPath.includes(`generation-${nextGeneration('000007')}`));
  await paintAll(f, 1);
  assert.equal(f.actor.snapshot.phase, 'READY', 'the slot reaches READY after the upgrade');
  await f.restart(); // /reload
  await f.todo.schedule();
  await f.todo.schedule(); // scheduled reconciliation
  await paintAll(f, 1);
  assert.deepEqual(f.mutations().slice(n).map(head), [], 'no split, swap, close, resize, focus or run');
  assert.deepEqual(await f.ids(), ids);
  assert.deepEqual(f.rects(ids), COLUMNS_SOURCE['172x46']);
  assert.equal(JSON.stringify(f.layout().splits), splits, 'the split tree is unchanged');
  assert.equal(f.fake.focused(), 'parent', 'no automatic focus change');
  assert.deepEqual(await claims(f), ['columns', 'columns', 'columns']);
  assert.equal(f.actor.snapshot.phase, 'READY');
  assert.deepEqual(f.warnings, []);
  const phases = watchPhases(f), from = f.mutations().length, operations = new Set(f.actor.snapshot.operations.map(op => op.id));
  await f.todo.schedule(DASHBOARD);
  await assertMigrated(f, ids, '172x46', { phases, from, operations });
  assert.deepEqual(f.warnings, []);
  await paintAll(f, 2);
  assert.equal(f.actor.snapshot.phase, 'READY', 'fresh paints after the migration make the slot READY again');
  const settled = f.mutations().length;
  await f.todo.schedule(DASHBOARD);
  await f.todo.schedule();
  await f.restart();
  await f.todo.schedule();
  assert.deepEqual(f.mutations().slice(settled).map(head), [], 'a second /dashboard and later passes make zero mutations');
  assert.deepEqual(f.rects(ids), BAND_TARGET['172x46']);
  assert.deepEqual(f.warnings, []);
});

for (const size of ['120x40', '100x30']) test(`band_live_columns_generation ${size}: explicit /dashboard migrates the measured columns fixture to the measured band`, async t => {
  const [width, height] = size.split('x').map(Number);
  const { f, ids } = await liveColumns(t, { width, height });
  const phases = watchPhases(f), from = f.mutations().length, operations = new Set(f.actor.snapshot.operations.map(op => op.id));
  await f.todo.schedule(DASHBOARD);
  await assertMigrated(f, ids, size, { phases, from, operations });
  const settled = f.mutations().length;
  await f.todo.schedule(DASHBOARD);
  assert.equal(f.mutations().length, settled, 'a second /dashboard makes zero mutations');
  assert.deepEqual(f.warnings, []);
});

// Every source the plan names ends in the band (or an explicit wait): the same
// panes, the chat rect identical in every phase, focus on the chat at the end.
const SOURCES = {
  'reversed columns': (ids, share) => ({ direction: 'right', ratio: share, first: 'parent', second: { direction: 'right', ratio: 0.5,
    first: { direction: 'down', ratio: 0.5, first: ids.workers, second: ids.todo }, second: ids.dag } }),
  'legacy stacked, DAG on top': (ids, share) => ({ direction: 'right', ratio: share, first: 'parent', second: { direction: 'down',
    ratio: 0.4, first: ids.dag, second: { direction: 'down', ratio: 0.5, first: ids.workers, second: ids.todo } } }),
  'stacked, Todo on top': (ids, share) => ({ direction: 'right', ratio: share, first: 'parent', second: { direction: 'down',
    ratio: 0.34, first: ids.todo, second: { direction: 'down', ratio: 0.5, first: ids.workers, second: ids.dag } } }),
  'band with workers and DAG swapped': (ids, share) => ({ direction: 'right', ratio: share, first: 'parent', second: {
    direction: 'down', ratio: 0.35, first: ids.todo, second: { direction: 'right', ratio: 0.4, first: ids.dag, second: ids.workers } } }),
};
for (const [name, tree] of Object.entries(SOURCES)) test(`band_migration_sources ${name}: automatic passes wait once without mutating; /dashboard ends in the band`, async t => {
  const { f, ids } = await liveColumns(t);
  f.arrange(tree(ids, f.layout().splits[0].ratio));
  const before = f.rects(ids), n = f.mutations().length;
  await f.todo.schedule();
  await f.todo.schedule();
  assert.deepEqual(f.mutations().slice(n).map(head), [], 'an automatic pass never rearranges');
  assert.deepEqual(f.rects(ids), before);
  assert.equal(f.fake.focused(), 'parent');
  assert.equal(f.warnings.length, 1, 'one notice across two automatic passes');
  assert.match(f.warnings[0], /^layout-waiting: .*\/dashboard/);
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery block');
  const phases = watchPhases(f), from = f.mutations().length;
  await f.todo.schedule(DASHBOARD);
  const added = f.mutations().slice(from).map(call => call.args);
  for (const phase of phases) assert.deepEqual(rectArray(phase.chat), BAND_TARGET['172x46'].parent);
  assertChatUntouched(added, ids);
  assertNoRolePaneSplitOrClose(added, Object.values(ids));
  assertActorOnly(f);
  assert.deepEqual(await f.ids(), ids);
  assert.equal(isBandDashboard(f.layout(), ids), true);
  assert.deepEqual(f.rects(ids), BAND_TARGET['172x46']);
  assert.equal(f.fake.focused(), 'parent');
  assert.deepEqual(await claims(f), ['band', 'band', 'band']);
  assert.equal(f.warnings.length, 1, 'the migration itself adds no notice');
});

// A role closed (its pane exited) and then /dashboard: the closed role reopens
// and the dashboard ends in the band (verify-task-6.md ruling (c)).
for (const [base, closed] of [['band', ['todo']], ['band', ['todo', 'workers']], ['band', ['todo', 'dag']], ['columns', ['todo']]])
  test(`band_migration_sources ${base} with ${closed.join(' and ')} closed: /dashboard reopens and ends in the band`, async t => {
    let f, ids;
    if (base === 'band') { f = await bandDashboard(t); await f.todo.schedule(); ids = await f.ids(); }
    else ({ f, ids } = await liveColumns(t));
    for (const role of closed) await f.exitPane(ids[role]);
    const n = f.mutations().length;
    await f.todo.schedule();
    assert.deepEqual(f.mutations().slice(n).map(head), [], 'an automatic pass reopens nothing');
    const phases = watchPhases(f), from = f.mutations().length;
    await f.todo.schedule(DASHBOARD);
    const now = await f.ids(), chat = base === 'band' ? FRESH_BAND['172x46'] : BAND_TARGET['172x46'];
    for (const role of ['todo', 'workers', 'dag']) {
      if (closed.includes(role)) assert.notEqual(now[role], ids[role], `${role} reopened`);
      else assert.equal(now[role], ids[role], `${role} kept`);
    }
    for (const phase of phases) assert.deepEqual(rectArray(phase.chat), chat.parent, 'the chat is never split again');
    assertChatUntouched(f.mutations().slice(from).map(call => call.args), now);
    assertActorOnly(f);
    assert.equal(isBandDashboard(f.layout(), now), true);
    assert.deepEqual(f.rects(now), chat);
    assert.equal(f.fake.focused(), 'parent');
    assert.deepEqual(await claims(f), ['band', 'band', 'band']);
  });

test('band_migration_sources inherited columns without a Todo: /dashboard opens Todo and migrates the region in place', async t => {
  const f = await bandDashboard(t, { sessionId: 'old-conversation' });
  await f.dag.openPair({ force: true, claim: { ...f.todo.binding, tabId: 'tab', lifetimeId: f.todo.lifetimeId, layout: 'columns' } });
  const old = await f.ids();
  await f.restart({ sessionId: 'new-conversation' });
  const n = f.mutations().length;
  await f.todo.schedule();
  assert.deepEqual(f.mutations().slice(n).map(head), [], 'the inherited region is kept by automatic passes');
  const phases = watchPhases(f);
  await f.todo.schedule(DASHBOARD);
  const ids = await f.ids();
  assert.equal(ids.workers, old.workers);
  assert.equal(ids.dag, old.dag);
  for (const phase of phases) assert.deepEqual(rectArray(phase.chat), [0, 0, 69, 46], 'the inherited chat is never split');
  assert.equal(isBandDashboard(f.layout(), ids), true);
  assert.deepEqual(f.rects(ids), BAND_TARGET['172x46']);
  assertActorOnly(f);
  assert.equal(f.fake.focused(), 'parent');
  assert.deepEqual(await claims(f), ['band', 'band', 'band']);
});

test('band_migration_resume: a migration interrupted between its moves resumes from the geometry on the next /dashboard', async t => {
  const { f, ids } = await liveColumns(t);
  let armed = false;
  f.hooks.after = args => {
    if (args[0] === 'close') armed = true;
    else if (armed && args[0] === 'layout') { armed = false; throw Object.assign(new Error('QA interruption'), { code: 'QA_INTERRUPT' }); }
  };
  await assert.rejects(f.todo.schedule(DASHBOARD), /QA interruption/);
  delete f.hooks.after;
  assert.equal((await readRecord(join(f.dag.directory, 'placement.json'))).phase, 'COMPLETE', 'the first move finished');
  assert.deepEqual(await claims(f), ['columns', 'columns', 'columns'], 'the claim is still columns');
  await f.restart();
  const phases = watchPhases(f), from = f.mutations().length;
  await f.todo.schedule(DASHBOARD);
  const added = f.mutations().slice(from).map(call => call.args);
  assert.ok(!added.some(args => args[0] === 'split' && args[2] === ids.todo), 'the finished move is not replayed');
  assert.equal(added.filter(args => args[0] === 'split').length, 1, 'only the second move remains');
  for (const phase of phases) assert.deepEqual(rectArray(phase.chat), BAND_TARGET['172x46'].parent);
  assert.equal(isBandDashboard(f.layout(), ids), true);
  assert.deepEqual(f.rects(ids), BAND_TARGET['172x46']);
  assert.equal((await readRecord(join(f.dag.directory, 'placement.json'))).phase, 'COMPLETE');
  assert.equal(f.fake.focused(), 'parent');
  assert.deepEqual(await claims(f), ['band', 'band', 'band']);
});

test('band_foreign_identity: a pane the dashboard does not own in the tab stops /dashboard before any mutation', async t => {
  const { f, ids } = await liveColumns(t);
  await f.fake.herdr('split', '--pane', ids.dag, '--direction', 'down', '--ratio', '0.5', '--no-focus'); // the owner's own pane
  const before = f.rects(ids), n = f.mutations().length;
  await f.todo.schedule(DASHBOARD);
  assert.deepEqual(f.mutations().slice(n).map(head), [], 'zero mutations');
  assert.deepEqual(f.rects(ids), before);
  assert.equal(f.fake.focused(), 'parent');
  assert.equal(await readRecord(join(f.dag.directory, 'placement.json')), null, 'no journal is written');
  assert.deepEqual(await claims(f), ['columns', 'columns', 'columns']);
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery block');
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /^layout-waiting: .*\/dashboard/);
});

test('band_foreign_identity: a temporary pane that gains a foreign process is never closed and the journal stays unresolved', async t => {
  const { f, ids } = await liveColumns(t);
  let temporary;
  const phases = watchPhases(f, args => {
    if (args[0] === 'split') temporary = f.layout().panes.find(pane => !Object.values(ids).includes(pane.pane_id)).pane_id;
    if (args[0] === 'swap' && temporary) f.foreignProcess(temporary);
  });
  const from = f.mutations().length, diagnostics = (await placementDiagnostics(f)).length;
  // Todo 8: a known stop inside a move waits; its journal stays unresolved for the next /dashboard.
  await f.todo.schedule(DASHBOARD);
  const added = f.mutations().slice(from).map(call => call.args);
  assert.deepEqual(added.map(args => args[0]), ['split', 'swap', 'focus'], 'nothing after the foreign process appeared');
  assert.ok(f.fake.panes().includes(temporary), 'the foreign pane is never closed');
  assert.equal((await readRecord(join(f.dag.directory, 'placement.json'))).phase, 'BLOCKED');
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery latch');
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /^layout-waiting: .*\/dashboard/);
  assert.deepEqual((await placementDiagnostics(f)).slice(diagnostics).map(entry => entry.code), ['IDENTITY_MISMATCH'], 'one diagnostics entry');
  for (const phase of phases) assert.deepEqual(rectArray(phase.chat), BAND_TARGET['172x46'].parent);
  assert.deepEqual(await claims(f), ['columns', 'columns', 'columns']);
});

test('band_foreign_identity: a role viewer replaced by a foreign process between moves stops the migration with no further mutation', async t => {
  const { f, ids } = await liveColumns(t);
  const phases = watchPhases(f, args => { if (args[0] === 'close') f.foreignProcess(ids.workers); });
  const from = f.mutations().length;
  await f.todo.schedule(DASHBOARD);
  const added = f.mutations().slice(from).map(call => call.args);
  assert.deepEqual(added.map(args => args[0]), ['split', 'swap', 'focus', 'close'], 'only the first move');
  assert.equal((await readRecord(join(f.dag.directory, 'placement.json'))).phase, 'COMPLETE');
  for (const phase of phases) assert.deepEqual(rectArray(phase.chat), BAND_TARGET['172x46'].parent);
  assert.deepEqual(await claims(f), ['columns', 'columns', 'columns']);
  assert.equal(f.fake.focused(), 'parent');
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery block');
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /^layout-waiting: .*\/dashboard/);
});

test('band_owned_resize: under a columns claim a band-shaped region makes zero mutations; /dashboard only promotes the claim (G9)', async t => {
  const { f, ids } = await liveColumns(t);
  f.arrange({ direction: 'right', ratio: f.layout().splits[0].ratio, first: 'parent', second: { direction: 'down', ratio: 0.25,
    first: ids.todo, second: { direction: 'right', ratio: 0.3, first: ids.workers, second: ids.dag } } });
  assert.equal(isBandDashboard(f.layout(), ids), true, 'the owned panes already have the band shape');
  const before = f.rects(ids), from = f.mutations().length;
  await f.todo.schedule();
  await f.todo.schedule();
  assert.deepEqual(f.mutations().slice(from).map(head), [], 'automatic passes leave a matching shape alone');
  assert.deepEqual(await claims(f), ['columns', 'columns', 'columns'], 'an automatic pass writes no claim');
  assert.deepEqual(f.warnings, [], 'a matching shape is not a wait');
  await f.todo.schedule(DASHBOARD);
  assert.deepEqual(f.mutations().slice(from).map(head), [], 'no split, swap, close, focus or ratio resize (G9)');
  assert.deepEqual(f.rects(ids), before);
  assert.equal(f.fake.focused(), 'parent');
  assert.deepEqual(await claims(f), ['band', 'band', 'band'], 'only the claim follows the shape');
  assert.equal(f.todo.claim.layout, 'band');
  assert.deepEqual(f.warnings, []);
  await f.todo.schedule(DASHBOARD);
  assert.deepEqual(f.mutations().slice(from).map(head), [], 'a second /dashboard makes zero mutations');
});

// The gate reviewer's G9_MATCHING_SHAPE_COLUMNS_CLAIM reproduction (verify-task-7.md A1), as a regression.
test('band_owned_resize G9_MATCHING_SHAPE_COLUMNS_CLAIM: a band-shaped region still claiming columns takes no ratio resize on /dashboard', async t => {
  const f = await bandDashboard(t);
  const provider = f.todo.provider, band = provider.bandLayout;
  delete provider.bandLayout;
  try { await f.todo.schedule(); } finally { provider.bandLayout = band; }
  const ids = await f.ids(), root = f.layout().splits[0];
  await f.fake.herdr('resize', '--pane', 'parent', '--direction', 'left', '--amount', String(root.ratio - 69 / 172));
  f.arrange({ direction: 'right', ratio: f.layout().splits[0].ratio, first: 'parent', second: { direction: 'down', ratio: 0.25,
    first: ids.todo, second: { direction: 'right', ratio: 0.3, first: ids.workers, second: ids.dag } } });
  const before = f.rects(ids), n = f.mutations().length;
  assert.deepEqual(before, { parent: [0, 0, 69, 46], todo: [69, 0, 103, 12], workers: [69, 12, 31, 34], dag: [100, 12, 72, 34] });
  assert.equal(isBandDashboard(f.layout(), ids), true);
  assert.deepEqual(await claims(f), ['columns', 'columns', 'columns']);
  await f.todo.schedule(DASHBOARD);
  assert.deepEqual(f.mutations().slice(n).map(call => call.args), [], 'no resize of Todo or workers');
  assert.deepEqual(f.rects(ids), before);
  assert.deepEqual(await claims(f), ['band', 'band', 'band']);
  assert.deepEqual(f.warnings, []);
});

test('band_owned_resize: a band the owner resized keeps its sizes; /dashboard makes zero mutations (G9)', async t => {
  const f = await bandDashboard(t);
  await f.todo.schedule();
  const ids = await f.ids();
  await f.fake.herdr('resize', '--pane', ids.todo, '--direction', 'down', '--amount', '0.1');
  await f.fake.herdr('resize', '--pane', ids.workers, '--direction', 'right', '--amount', '0.1');
  const before = f.rects(ids), n = f.mutations().length;
  assert.notDeepEqual(before, FRESH_BAND['172x46']);
  await f.todo.schedule(DASHBOARD);
  await f.todo.schedule();
  assert.deepEqual(f.mutations().slice(n).map(head), []);
  assert.deepEqual(f.rects(ids), before);
  assert.deepEqual(f.warnings, []);
});

test('band_resize_during_effect: a terminal resize while a migration swap takes effect keeps the chat share and completes the band for the new size', async t => {
  const { f, ids } = await liveColumns(t);
  const share = f.layout().splits[0].ratio;
  let once = true;
  const phases = watchPhases(f, args => { if (args[0] === 'swap' && once) { once = false; f.resizeTerminal({ width: 160, height: 44 }); } });
  const from = f.mutations().length;
  await f.todo.schedule(DASHBOARD);
  assert.ok(!once, 'the terminal was resized during the migration');
  for (const phase of phases) {
    assert.equal(phase.root.ratio, share, 'the chat keeps its share in every phase');
    assert.deepEqual(rectArray(phase.chat), [0, 0, Math.round(Math.fround(phase.area.width * Math.fround(share))), phase.area.height]);
  }
  assertChatUntouched(f.mutations().slice(from).map(call => call.args), ids);
  assert.equal(isBandDashboard(f.layout(), ids), true);
  assert.deepEqual(f.rects(ids), { parent: [0, 0, 64, 44], todo: [64, 0, 96, 15], workers: [64, 15, 38, 29], dag: [102, 15, 58, 29] });
  assert.equal((await readRecord(join(f.dag.directory, 'placement.json'))).phase, 'COMPLETE');
  assert.equal(f.fake.focused(), 'parent');
  assert.deepEqual(await claims(f), ['band', 'band', 'band']);
  assert.deepEqual(f.warnings, []);
});

test('band_resize_during_effect: a shrink below the floor during the migration ends in one wait without ratios; /dashboard after enlarging promotes the claim without re-applying ratios (G9)', async t => {
  const { f, ids } = await liveColumns(t);
  let splits = 0;
  watchPhases(f, args => { if (args[0] === 'split' && ++splits === 2) f.resizeTerminal({ width: 80, height: 46 }); });
  await f.todo.schedule(DASHBOARD);
  assert.equal(f.mutations().filter(call => call.args[0] === 'resize').length, 0, 'no ratio is applied below the floor');
  assert.equal(isBandDashboard(f.layout(), ids), true, 'the moves completed');
  assert.equal((await readRecord(join(f.dag.directory, 'placement.json'))).phase, 'COMPLETE');
  assert.deepEqual(await claims(f), ['columns', 'columns', 'columns'], 'the claim waits for success');
  assert.equal(f.fake.focused(), 'parent');
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery block');
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /^layout-waiting: .*larger terminal/);
  f.resizeTerminal({ width: 172, height: 46 });
  delete f.hooks.after;
  const from = f.mutations().length, enlarged = f.rects(ids);
  await f.todo.schedule(DASHBOARD);
  assert.deepEqual(f.mutations().slice(from).map(head), [], 'the band shape already matches and this pass moves nothing: no ratio (G9)');
  assert.deepEqual(f.rects(ids), enlarged);
  assert.equal(isBandDashboard(f.layout(), ids), true);
  assert.deepEqual(await claims(f), ['band', 'band', 'band']);
});

test('band_migration_automatic: a band whose panes were rearranged waits once on automatic passes; /dashboard restores it in place', async t => {
  const f = await bandDashboard(t);
  await f.todo.schedule();
  const ids = await f.ids();
  f.arrange({ direction: 'right', ratio: f.layout().splits[0].ratio, first: 'parent', second: { direction: 'down', ratio: 0.35,
    first: ids.todo, second: { direction: 'right', ratio: 0.4, first: ids.dag, second: ids.workers } } });
  const before = f.rects(ids), n = f.mutations().length;
  await f.todo.schedule();
  await f.todo.schedule();
  assert.deepEqual(f.mutations().slice(n).map(head), [], 'an automatic pass never rearranges a band');
  assert.deepEqual(f.rects(ids), before);
  assert.equal(f.fake.focused(), 'parent');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery block');
  assert.equal(f.warnings.length, 1, 'one notice across two automatic passes');
  assert.match(f.warnings[0], /^layout-waiting: .*\/dashboard/);
  await f.todo.schedule(DASHBOARD);
  assert.deepEqual(f.mutations().slice(n).map(call => call.args), [
    ['swap', '--source-pane', ids.workers, '--target-pane', ids.dag],
    ['focus', '--pane', ids.workers, '--direction', 'left'],
  ], 'only the swap the band still needs; its ratios already match');
  assertActorOnly(f);
  assert.deepEqual(f.rects(ids), FRESH_BAND['172x46']);
  assert.equal(f.fake.focused(), 'parent');
  assert.deepEqual(await claims(f), ['band', 'band', 'band']);
});

test('band_resize_during_effect: the owner moving the chat divider during the migration stops it before the next mutation', async t => {
  const { f, ids } = await liveColumns(t);
  let moved = false;
  watchPhases(f, async args => {
    if (args[0] === 'close' && !moved) {
      moved = true;
      await f.fake.herdr('resize', '--pane', 'parent', '--direction', 'right', '--amount', '0.05'); // the owner, not the dashboard
    }
  });
  const from = f.mutations().length;
  await f.todo.schedule(DASHBOARD);
  assert.ok(moved);
  assert.deepEqual(f.mutations().slice(from).map(call => call.args[0]), ['split', 'swap', 'focus', 'close'], 'nothing after the chat changed');
  assert.equal((await readRecord(join(f.dag.directory, 'placement.json'))).phase, 'COMPLETE');
  assert.deepEqual(await claims(f), ['columns', 'columns', 'columns']);
  assert.equal(f.fake.focused(), 'parent');
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery block');
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /^layout-waiting: the chat pane changed during placement.*\/dashboard/);
  assert.deepEqual(await f.ids(), ids);
});

// The gate reviewer's PRODUCTION_DISPATCH_FOCUS_CHANGED_AFTER_GUARD reproduction (verify-task-7.md A2),
// through the production TodoPane.prototype.mutate: the owner moves focus inside the actor's custody
// callback, after the migration guard accepted the step and before the native split.
test('band_dispatch_authorization: a focus change inside the custody callback refuses the temporary split at the final authorization; the journal stays resumable', async t => {
  const f = await bandDashboard(t);
  const provider = f.todo.provider, band = provider.bandLayout;
  delete provider.bandLayout;
  try { await f.todo.schedule(); } finally { provider.bandLayout = band; }
  const ids = await f.ids(), root = f.layout().splits[0];
  await f.fake.herdr('resize', '--pane', 'parent', '--direction', 'left', '--amount', String(root.ratio - 69 / 172));
  const journalPath = join(f.dag.directory, 'placement.json'), journal = await readRecord(journalPath);
  const fixtureMutate = f.todo.mutate, custody = f.todo.invalidateCustodyEffect;
  delete f.todo.mutate;
  assert.equal(f.todo.mutate, TodoPane.prototype.mutate, 'the production dispatcher');
  const n = f.mutations().length;
  let atChange;
  f.todo.invalidateCustodyEffect = async operation => {
    await custody.call(f.todo, operation);
    if (!atChange && operation.type === 'split') {
      await f.fake.herdr('focus', '--pane', 'parent', '--direction', 'right'); // the owner
      atChange = { focus: f.fake.focused(), added: f.mutations().length - n, journal: (await readRecord(journalPath))?.phase };
    }
  };
  await f.todo.schedule(DASHBOARD);
  assert.deepEqual(atChange, { focus: ids.todo, added: 0, journal: 'PREPARED' }, 'focus moved after the guard, before the split');
  assert.deepEqual(f.mutations().slice(n).map(call => call.args), [], 'the temporary split is never issued');
  assert.deepEqual(await readRecord(journalPath), journal, 'the journal is back to its previous state');
  const [refused] = f.actor.snapshot.operations.slice(-1);
  assert.deepEqual([refused.type, refused.status], ['split', 'SETTLED'], 'a known no-effect refusal');
  assert.equal(f.todo.effectObservations.has(refused.id), false, 'no pending effect observation');
  assert.equal(f.actor.blocked, false);
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery latch');
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /^layout-waiting: input selection changed during placement.*\/dashboard/);
  assert.equal(f.fake.focused(), ids.todo, 'the owner keeps the focus they chose');
  assert.deepEqual(await f.ids(), ids);
  assert.deepEqual(f.fake.panes().sort(), Object.values(ids).sort(), 'no temporary pane');
  assert.deepEqual(await claims(f), ['columns', 'columns', 'columns']);
  // The owner selects the chat again and repeats /dashboard: the migration resumes from the geometry.
  f.todo.invalidateCustodyEffect = custody;
  f.todo.mutate = fixtureMutate;
  await f.fake.herdr('focus', '--pane', ids.todo, '--direction', 'left');
  assert.equal(f.fake.focused(), 'parent');
  await f.todo.schedule(DASHBOARD);
  assert.equal(isBandDashboard(f.layout(), ids), true);
  assert.equal((await readRecord(journalPath)).phase, 'COMPLETE');
  assert.deepEqual(await f.ids(), ids);
  assert.equal(f.fake.focused(), 'parent');
  assert.deepEqual(await claims(f), ['band', 'band', 'band']);
});

test('band_dispatch_authorization: a focus change inside the custody callback of a ratio resize refuses it; the settled moves stay and the next /dashboard moves nothing (G9)', async t => {
  const { f, ids } = await liveColumns(t);
  const custody = f.todo.invalidateCustodyEffect, from = f.mutations().length;
  let changed = false;
  f.todo.invalidateCustodyEffect = async operation => {
    await custody.call(f.todo, operation);
    if (!changed && operation.type === 'arrange' && f.mutations().length - from === 11) { // the first ratio resize
      changed = true;
      await f.fake.herdr('focus', '--pane', 'parent', '--direction', 'right'); // the owner
    }
  };
  await f.todo.schedule(DASHBOARD);
  assert.ok(changed);
  assert.deepEqual(f.mutations().slice(from).map(call => call.args[0]),
    ['split', 'swap', 'focus', 'close', 'split', 'swap', 'focus', 'focus', 'close', 'swap', 'focus'], 'the moves, no resize');
  assert.equal(isBandDashboard(f.layout(), ids), true);
  assert.equal((await readRecord(join(f.dag.directory, 'placement.json'))).phase, 'COMPLETE');
  const [refused] = f.actor.snapshot.operations.slice(-1);
  assert.deepEqual([refused.type, refused.status], ['arrange', 'SETTLED'], 'a known no-effect refusal');
  assert.equal(f.actor.blocked, false);
  assert.deepEqual(await claims(f), ['columns', 'columns', 'columns'], 'the claim waits for success');
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery latch');
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /^layout-waiting: input selection changed during placement.*\/dashboard/);
  f.todo.invalidateCustodyEffect = custody;
  await f.fake.herdr('focus', '--pane', ids.todo, '--direction', 'left');
  assert.equal(f.fake.focused(), 'parent');
  const moved = f.mutations().length, banded = f.rects(ids);
  await f.todo.schedule(DASHBOARD);
  assert.deepEqual(f.mutations().slice(moved).map(head), [], 'a matching shape makes zero mutations');
  assert.deepEqual(f.rects(ids), banded);
  assert.deepEqual(await claims(f), ['band', 'band', 'band']);
});

test('band_dispatch_authorization: a focus change inside the custody callback of a move\'s swap refuses the swap; the temporary placement stays unresolved like a failed guard (todo 8)', async t => {
  const { f, ids } = await liveColumns(t);
  const custody = f.todo.invalidateCustodyEffect, from = f.mutations().length;
  let changed = false;
  f.todo.invalidateCustodyEffect = async operation => {
    await custody.call(f.todo, operation);
    if (!changed && operation.type === 'arrange' && f.mutations().length - from === 1) { // the first move's swap
      changed = true;
      await f.fake.herdr('focus', '--pane', 'parent', '--direction', 'right'); // the owner
    }
  };
  // Todo 8: the refusal waits; the journal stays unresolved for the next /dashboard.
  await f.todo.schedule(DASHBOARD);
  assert.ok(changed);
  assert.deepEqual(f.mutations().slice(from).map(call => call.args[0]), ['split'], 'no swap, close or focus after the change');
  const journal = await readRecord(join(f.dag.directory, 'placement.json'));
  assert.equal(journal.phase, 'BLOCKED');
  assert.ok(f.fake.panes().includes(journal.temporary.paneId), 'the temporary pane is left for journal recovery');
  const [refused] = f.actor.snapshot.operations.slice(-1);
  assert.deepEqual([refused.type, refused.status], ['arrange', 'SETTLED'], 'a known no-effect refusal');
  assert.equal(f.actor.blocked, false);
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery latch (todo 8)');
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /^layout-waiting: .*\/dashboard/);
  assert.deepEqual(await claims(f), ['columns', 'columns', 'columns']);
  assert.deepEqual(rectArray(f.layout().panes.find(pane => pane.pane_id === 'parent').rect), COLUMNS_SOURCE['172x46'].parent);
});

// The gate reviewer's PRODUCTION_OWNER_SWAPS_ROW_BEFORE_GUARD_GATHER reproduction (verify-task-7-r2.md A3),
// through the production TodoPane.prototype.mutate: after the moves and the Todo resize, the owner swaps
// the lower row inside the row resize's guard, before any of its geometry reads. The resize was computed
// on the band, where DAG left moves the row divider; on the swapped row it would move the chat's (G2).
test('band_dispatch_authorization A3 PRODUCTION_OWNER_SWAPS_ROW_BEFORE_GUARD_GATHER: a row resize computed on the band is refused once the owner swapped the row; the chat keeps its rect', async t => {
  const f = await bandDashboard(t, { events: true });
  const provider = f.todo.provider, band = provider.bandLayout;
  delete provider.bandLayout;
  try { await f.todo.schedule(); } finally { provider.bandLayout = band; }
  const ids = await f.ids(), root = f.layout().splits[0];
  await f.fake.herdr('resize', '--pane', 'parent', '--direction', 'left', '--amount', String(root.ratio - 69 / 172));
  const fixtureMutate = f.todo.mutate, placementFocus = f.dag.placementFocus.bind(f.dag), n = f.mutations().length;
  let atChange, productionDispatch = false;
  f.dag.placementFocus = async (...args) => {
    const selected = await placementFocus(...args);
    if (!atChange && f.mutations().length - n === 12) { // the moves and the Todo resize settled: the row resize's guard
      await f.fake.herdr('swap', '--source-pane', ids.workers, '--target-pane', ids.dag); // the owner
      await f.fake.herdr('focus', '--pane', ids.workers, '--direction', 'left');
      await f.fake.herdr('focus', '--pane', ids.dag, '--direction', 'left');
      atChange = { rects: f.rects(ids), focus: f.fake.focused() };
      delete f.todo.mutate;
      productionDispatch = f.todo.mutate === TodoPane.prototype.mutate;
    }
    return selected;
  };
  const failure = await f.todo.schedule(DASHBOARD).then(() => undefined, error => error);
  assert.deepEqual(atChange, { rects: { parent: [0, 0, 69, 46], todo: [69, 0, 103, 16], workers: [121, 16, 51, 30],
    dag: [69, 16, 52, 30] }, focus: 'parent' }, 'the owner swapped the row after the Todo resize');
  assert.ok(productionDispatch, 'the production dispatcher');
  assert.deepEqual(f.mutations().slice(n + 12).map(head), [], 'the resize computed on the band is never issued');
  assert.deepEqual(f.rects(ids), atChange.rects, 'the chat keeps [0, 0, 69, 46]');
  assert.equal(failure, undefined, 'a wait, not a failure');
  const [refused] = f.actor.snapshot.operations.slice(-1);
  assert.deepEqual([refused.type, refused.status], ['arrange', 'SETTLED'], 'a known no-effect refusal');
  assert.equal(f.todo.effectObservations.has(refused.id), false, 'no pending effect observation');
  assert.equal(f.actor.blocked, false);
  assert.equal((await readRecord(join(f.dag.directory, 'placement.json'))).phase, 'COMPLETE');
  assert.deepEqual(await claims(f), ['columns', 'columns', 'columns'], 'the claim waits for success');
  assert.equal(f.fake.focused(), 'parent');
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery latch');
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /^layout-waiting: the dashboard panes changed during placement.*\/dashboard/);
  assert.deepEqual(await f.ids(), ids);
  // /dashboard again re-plans from the owner's row: one swap back, then the row ratio.
  f.todo.mutate = fixtureMutate;
  const resumed = f.mutations().length;
  await f.todo.schedule(DASHBOARD);
  assert.deepEqual(f.mutations().slice(resumed).map(call => call.args[0]), ['swap', 'focus', 'resize']);
  assertChatUntouched(f.mutations().slice(n).map(call => call.args), ids);
  assert.deepEqual(f.rects(ids), BAND_TARGET['172x46']);
  assert.equal(f.fake.focused(), 'parent');
  assert.deepEqual(await claims(f), ['band', 'band', 'band']);
});

// A3, the same class for the planned moves: their targets and directions were decided on the tree read
// before the first move. The owner swaps two dashboard panes before that move's guard reads the tree.
test('band_dispatch_authorization A3: a planned move decided on the columns tree is never issued once the owner swapped two dashboard panes; /dashboard re-plans from their geometry', async t => {
  const { f, ids } = await liveColumns(t);
  const placementFocus = f.dag.placementFocus.bind(f.dag), from = f.mutations().length;
  const journalPath = join(f.dag.directory, 'placement.json'), journal = await readRecord(journalPath);
  let reads = 0, atChange;
  f.dag.placementFocus = async (...args) => {
    const selected = await placementFocus(...args);
    if (++reads === 2) { // the first move's guard; the first read was the preflight
      await f.fake.herdr('swap', '--source-pane', ids.workers, '--target-pane', ids.dag); // the owner
      await f.fake.herdr('focus', '--pane', ids.workers, '--direction', 'left');
      await f.fake.herdr('focus', '--pane', f.fake.focused(), '--direction', 'left');
      atChange = { mutations: f.mutations().length - from, rects: f.rects(ids), focus: f.fake.focused() };
    }
    return selected;
  };
  await f.todo.schedule(DASHBOARD);
  assert.deepEqual(atChange, { mutations: 0, rects: { parent: [0, 0, 69, 46], todo: [69, 0, 52, 23], workers: [121, 0, 51, 46],
    dag: [69, 23, 52, 23] }, focus: 'parent' }, 'the owner swapped workers and the DAG before the first move');
  assert.deepEqual(f.mutations().slice(from).map(head), [], 'no split on a tree the plan was not decided on');
  assert.deepEqual(f.rects(ids), atChange.rects);
  assert.deepEqual(await readRecord(journalPath), journal, 'no journal write');
  assert.deepEqual(await claims(f), ['columns', 'columns', 'columns']);
  assert.equal(f.fake.focused(), 'parent');
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery latch');
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /^layout-waiting: the dashboard panes changed during placement.*\/dashboard/);
  assert.deepEqual(await f.ids(), ids);
  // /dashboard again: the b2 suffix that the owner's arrangement still needs (move workers, swap).
  const resumed = f.mutations().length;
  await f.todo.schedule(DASHBOARD);
  assert.equal(f.mutations().slice(resumed).filter(call => call.args[0] === 'split').length, 1, 'only the workers move');
  assertChatUntouched(f.mutations().slice(from).map(call => call.args), ids);
  assert.deepEqual(f.rects(ids), BAND_TARGET['172x46']);
  assert.equal((await readRecord(journalPath)).phase, 'COMPLETE');
  assert.equal(f.fake.focused(), 'parent');
  assert.deepEqual(await claims(f), ['band', 'band', 'band']);
});

// A3, the same class for the row resize's own reading: the owner swaps the lower row right after the
// Todo resize took effect, before the row is read. DAG left is the row divider only in the band.
test('band_dispatch_authorization A3: the owner swapping the lower row before it is read stops the migration before the row resize; the chat keeps its rect', async t => {
  const { f, ids } = await liveColumns(t);
  const from = f.mutations().length;
  let atChange;
  watchPhases(f, async args => {
    if (!atChange && args[0] === 'resize' && args[2] === ids.todo) {
      await f.fake.herdr('swap', '--source-pane', ids.workers, '--target-pane', ids.dag); // the owner
      await f.fake.herdr('focus', '--pane', ids.workers, '--direction', 'left');
      await f.fake.herdr('focus', '--pane', ids.dag, '--direction', 'left');
      atChange = { rects: f.rects(ids), focus: f.fake.focused() };
    }
  });
  await f.todo.schedule(DASHBOARD);
  assert.deepEqual(atChange, { rects: { parent: [0, 0, 69, 46], todo: [69, 0, 103, 16], workers: [121, 16, 51, 30],
    dag: [69, 16, 52, 30] }, focus: 'parent' }, 'the owner swapped the row as the Todo resize took effect');
  assert.deepEqual(f.mutations().slice(from).map(call => call.args[0]),
    ['split', 'swap', 'focus', 'close', 'split', 'swap', 'focus', 'focus', 'close', 'swap', 'focus', 'resize'], 'nothing after the Todo resize');
  assert.deepEqual(f.rects(ids), atChange.rects, 'the chat keeps [0, 0, 69, 46]');
  assert.equal((await readRecord(join(f.dag.directory, 'placement.json'))).phase, 'COMPLETE');
  assert.deepEqual(await claims(f), ['columns', 'columns', 'columns']);
  assert.equal(f.fake.focused(), 'parent');
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery latch');
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /^layout-waiting: the dashboard panes changed during placement.*\/dashboard/);
  assert.deepEqual(await f.ids(), ids);
});

test('band unmanaged columns: an explicit /dashboard never enters the band path', async t => {
  const f = await bandDashboard(t, { managed: false });
  await f.todo.schedule();
  const ids = await f.ids(), before = f.rects(ids), n = f.mutations().length;
  await f.todo.schedule(DASHBOARD);
  assert.deepEqual(f.mutations().slice(n).map(head), [], 'a matching unmanaged columns dashboard is left alone');
  assert.deepEqual(f.rects(ids), before);
  f.arrange({ direction: 'right', ratio: f.layout().splits[0].ratio, first: 'parent', second: { direction: 'right', ratio: 0.5,
    first: { direction: 'down', ratio: 0.5, first: ids.workers, second: ids.todo }, second: ids.dag } });
  await f.todo.schedule(DASHBOARD);
  assert.deepEqual(f.mutations().slice(n).map(call => call.args[0]), ['swap', 'focus'], 'only the reversible swap');
  assert.equal(isColumnDashboard(f.layout(), ids), true);
  assert.equal(isBandDashboard(f.layout(), ids), false);
  assert.equal(await f.claimLayout(), 'columns');
});

// ---- Todo 8: an unresolved placement journal is resolved through the actor ----

const placementPath = f => join(f.dag.directory, 'placement.json');
// The parent slot's blocked-diagnostics entries written for placement waits.
async function placementDiagnostics(f) {
  const text = await readFile(join(f.actor.paths.directory, 'blocked-diagnostics.jsonl'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.branch === 'placement');
}
// The owner moves the input selection inside the custody callback of the native mutation
// that follows `index` others from now, when its actor type is `type`: that step is
// refused at its final authorization.
function ownerFocusesAt(f, type, index) {
  const custody = f.todo.invalidateCustodyEffect, from = f.mutations().length;
  const owner = { changed: false, restore() { f.todo.invalidateCustodyEffect = custody; } };
  f.todo.invalidateCustodyEffect = async operation => {
    await custody.call(f.todo, operation);
    if (!owner.changed && operation.type === type && f.mutations().length - from === index) {
      owner.changed = true;
      await f.fake.herdr('focus', '--pane', 'parent', '--direction', 'right');
    }
  };
  return owner;
}
// The owner selects the chat again.
async function selectChat(f) {
  for (let step = 0; step < 4 && f.fake.focused() !== 'parent'; step++)
    await f.fake.herdr('focus', '--pane', f.fake.focused(), '--direction', 'left');
  assert.equal(f.fake.focused(), 'parent');
}
// A live columns dashboard whose explicit migration stopped inside its first move (the DAG
// below Todo), right after the temporary split ('split') or after the swap ('swap'): the
// owner moved the selection, so the next step was refused at its final authorization.
async function stuckMove(t, after) {
  const { f, ids } = await liveColumns(t);
  const owner = after === 'split' ? ownerFocusesAt(f, 'arrange', 1) : ownerFocusesAt(f, 'close', 3);
  const from = f.mutations().length, diagnostics = (await placementDiagnostics(f)).length;
  const failure = await f.todo.schedule(DASHBOARD).then(() => undefined, error => error);
  owner.restore();
  assert.ok(owner.changed, 'the owner moved the selection inside the move');
  const journal = await readRecord(placementPath(f));
  return { f, ids, from, diagnostics, failure, journal, temporary: journal?.temporary?.paneId };
}
// The controller stopped right after the first move's SPLIT_SETTLED write: the journal keeps
// that phase, and the next controller claims the slot under a newer generation.
async function stoppedAfterSplit(t) {
  const { f, ids } = await liveColumns(t);
  const placementFocus = f.dag.placementFocus.bind(f.dag);
  let journal;
  f.dag.placementFocus = async (...args) => {
    const current = await readRecord(placementPath(f));
    if (!journal && current?.phase === 'SPLIT_SETTLED') {
      journal = current;
      throw Object.assign(new Error('QA stop'), { code: 'QA_INTERRUPT' });
    }
    return placementFocus(...args);
  };
  await f.todo.schedule(DASHBOARD).catch(() => {});
  assert.equal(journal?.phase, 'SPLIT_SETTLED');
  await writeJson(placementPath(f), journal); // its later journal writes never happened
  await f.restart();
  assert.ok(f.actor.snapshot.generation > journal.generation, 'a newer slot generation');
  return { f, ids, journal, temporary: journal.temporary.paneId };
}
// The migration's remaining steps after its first move (task-1 b2).
const AFTER_FIRST_MOVE = ['split', 'swap', 'focus', 'focus', 'close', 'swap', 'focus', 'resize', 'resize'];
async function assertBand(f, ids, phases, added) {
  for (const phase of phases) assert.deepEqual(rectArray(phase.chat), BAND_TARGET['172x46'].parent, `the chat rect is identical after ${phase.verb}`);
  assertChatUntouched(added, ids);
  assertActorOnly(f);
  assert.equal((await readRecord(placementPath(f))).phase, 'COMPLETE');
  assert.deepEqual(await f.ids(), ids, 'the same pane ids');
  assert.deepEqual(f.fake.panes().sort(), Object.values(ids).sort(), 'no temporary pane remains');
  assert.deepEqual(f.rects(ids), BAND_TARGET['172x46']);
  assert.equal(f.fake.focused(), 'parent', 'focus ends on the chat');
  assert.deepEqual(await claims(f), ['band', 'band', 'band']);
  assert.ok(!f.todo.recoveryBlocked);
}

test('band_stuck_journal_temp_present: a focus change after SPLIT_SETTLED waits with the temporary pane kept; the next /dashboard resumes the move to COMPLETE and the band', async t => {
  const { f, ids, from, diagnostics, failure, journal, temporary } = await stuckMove(t, 'split');
  assert.equal(failure, undefined, 'a wait, not a failure');
  assert.deepEqual(f.mutations().slice(from).map(call => call.args[0]), ['split'], 'zero further mutations after the refusal');
  assert.deepEqual([journal.phase, journal.failedStage], ['BLOCKED', 'SPLIT_SETTLED']);
  assert.ok(f.fake.panes().includes(temporary), 'the temporary pane is kept');
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery latch');
  assert.equal(f.actor.blocked, false);
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /^layout-waiting: .*\/dashboard/);
  assert.deepEqual((await placementDiagnostics(f)).slice(diagnostics).map(entry => [entry.code, entry.role]),
    [['LAYOUT_WAIT', 'dag']], 'one diagnostics entry');
  assert.deepEqual(await claims(f), ['columns', 'columns', 'columns']);
  // Automatic passes never resolve a journal.
  const stuck = f.mutations().length;
  await f.todo.schedule();
  await f.todo.schedule();
  assert.deepEqual(f.mutations().slice(stuck).map(head), [], 'automatic passes make no mutation');
  assert.deepEqual(await readRecord(placementPath(f)), journal);
  await selectChat(f);
  const phases = watchPhases(f), resumed = f.mutations().length;
  await f.todo.schedule(DASHBOARD);
  const added = f.mutations().slice(resumed).map(call => call.args);
  assert.deepEqual(added.map(args => args[0]), ['swap', 'focus', 'close', ...AFTER_FIRST_MOVE],
    'the move resumes at its swap, then the migration continues');
  assert.deepEqual(added[0], ['swap', '--source-pane', ids.dag, '--target-pane', temporary]);
  assert.deepEqual(added[2], ['close', temporary]);
  await assertBand(f, ids, phases, added);
  assert.ok(f.warnings.every(message => /^layout-waiting: /.test(message)), 'no BLOCKED warning');
});

test('band_stuck_journal_temp_present: a journal left at SPLIT_SETTLED by a stopped controller resumes under the next slot generation to COMPLETE and the band', async t => {
  const { f, ids, journal, temporary } = await stoppedAfterSplit(t);
  assert.ok(f.fake.panes().includes(temporary));
  assert.notEqual(journal.ownerNonce, f.actor.snapshot.ownerNonce, 'written by the previous owner');
  const phases = watchPhases(f), from = f.mutations().length, w = f.warnings.length;
  await f.todo.schedule(DASHBOARD);
  const added = f.mutations().slice(from).map(call => call.args);
  assert.deepEqual(added.map(args => args[0]), ['swap', 'focus', 'close', ...AFTER_FIRST_MOVE]);
  assert.deepEqual(added[0], ['swap', '--source-pane', ids.dag, '--target-pane', temporary]);
  assert.deepEqual(added[2], ['close', temporary]);
  await assertBand(f, ids, phases, added);
  assert.equal(f.warnings.length, w, 'no new notice');
});

test('band_stuck_journal_resolved: a verified temporary pane left after the swap is closed through the actor and the migration continues to the band', async t => {
  const { f, ids, journal, temporary } = await stuckMove(t, 'swap');
  assert.deepEqual([journal.phase, journal.failedStage], ['BLOCKED', 'SWAP_SETTLED']);
  assert.ok(f.fake.panes().includes(temporary));
  await selectChat(f);
  const phases = watchPhases(f), from = f.mutations().length;
  await f.todo.schedule(DASHBOARD);
  const added = f.mutations().slice(from).map(call => call.args);
  assert.deepEqual(added.map(args => args[0]), ['close', ...AFTER_FIRST_MOVE], 'only the close of the finished swap, then the remaining steps');
  assert.deepEqual(added[0], ['close', temporary]);
  await assertBand(f, ids, phases, added);
});

test('band_target_gone band_stuck_journal_pre_swap_gone: the temporary pane gone after SPLIT_SETTLED and before the swap restarts the same move and completes it', async t => {
  const { f, ids, journal, temporary } = await stuckMove(t, 'split');
  assert.deepEqual([journal.phase, journal.failedStage], ['BLOCKED', 'SPLIT_SETTLED']);
  await f.exitPane(temporary);
  await selectChat(f);
  const phases = watchPhases(f), from = f.mutations().length, w = f.warnings.length;
  await f.todo.schedule(DASHBOARD);
  const added = f.mutations().slice(from).map(call => call.args);
  assert.deepEqual(added.map(args => args[0]), ['split', 'swap', 'focus', 'close', ...AFTER_FIRST_MOVE],
    'the move starts again from its first step, then the migration continues');
  assert.deepEqual(added[0].slice(0, 7), ['split', '--pane', ids.todo, '--direction', 'down', '--ratio', '0.5']);
  assert.equal(added[1][2], ids.dag, 'the same pane moves');
  assert.notEqual(added[3][1], temporary, 'through a new temporary pane');
  await assertBand(f, ids, phases, added);
  assert.equal(f.warnings.length, w, 'no new notice');
});

test('band_target_gone band_stuck_journal_post_swap_gone: the temporary pane gone after the swap completes the move from the recorded swap and the geometry without a native mutation', async t => {
  const { f, ids, from: start, journal, temporary } = await stuckMove(t, 'swap');
  assert.deepEqual(f.mutations().slice(start).map(call => call.args[0]), ['split', 'swap', 'focus'], 'zero further mutations after the refusal');
  assert.deepEqual([journal.phase, journal.failedStage], ['BLOCKED', 'SWAP_SETTLED']);
  await f.exitPane(temporary);
  await selectChat(f);
  const phases = watchPhases(f), from = f.mutations().length;
  await f.todo.schedule(DASHBOARD);
  const added = f.mutations().slice(from).map(call => call.args);
  assert.deepEqual(added.map(args => args[0]), AFTER_FIRST_MOVE, 'the finished move is not replayed');
  assert.deepEqual(added[0].slice(0, 7), ['split', '--pane', ids.dag, '--direction', 'right', '--ratio', '0.5']);
  await assertBand(f, ids, phases, added);
});

test('band_target_gone: only an authoritative pane_not_found makes the temporary pane gone; an unreadable answer waits', async t => {
  const { f, ids, journal, temporary } = await stuckMove(t, 'split');
  await f.exitPane(temporary);
  await selectChat(f);
  f.hooks.before = args => {
    if (args[0] === 'get' && args[1] === temporary) throw Object.assign(new Error('transport lost'), { code: 'transport_error' });
  };
  const from = f.mutations().length, diagnostics = (await placementDiagnostics(f)).length;
  await f.todo.schedule(DASHBOARD);
  delete f.hooks.before;
  assert.deepEqual(f.mutations().slice(from).map(head), [], 'zero mutations');
  assert.deepEqual(await readRecord(placementPath(f)), journal);
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery latch');
  assert.match(f.warnings.at(-1), /^layout-waiting: .*\/dashboard/);
  assert.deepEqual((await placementDiagnostics(f)).slice(diagnostics).map(entry => entry.code), ['IDENTITY_MISMATCH']);
  await f.todo.schedule(DASHBOARD);
  assert.equal((await readRecord(placementPath(f))).phase, 'COMPLETE');
  assert.deepEqual(f.rects(ids), BAND_TARGET['172x46']);
  assert.deepEqual(await claims(f), ['band', 'band', 'band']);
});

test('band_stuck_journal_failure a refused temporary split: the restarted move is refused at its split; the unresolved journal stays and the next /dashboard retries it', async t => {
  const { f, ids, journal, temporary } = await stuckMove(t, 'split');
  await f.exitPane(temporary);
  await selectChat(f);
  const owner = ownerFocusesAt(f, 'split', 0);
  const from = f.mutations().length, diagnostics = (await placementDiagnostics(f)).length, w = f.warnings.length;
  const failure = await f.todo.schedule(DASHBOARD).then(() => undefined, error => error);
  owner.restore();
  assert.ok(owner.changed);
  assert.equal(failure, undefined, 'a wait, not a failure');
  assert.deepEqual(f.mutations().slice(from).map(head), [], 'the new temporary split is never issued');
  assert.deepEqual(await readRecord(placementPath(f)), journal, 'the unresolved journal stays as it was');
  const [refused] = f.actor.snapshot.operations.slice(-1);
  assert.deepEqual([refused.type, refused.status], ['split', 'SETTLED'], 'a known no-effect refusal');
  assert.equal(f.actor.blocked, false);
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery latch');
  assert.equal(f.warnings.length, w + 1);
  assert.match(f.warnings.at(-1), /^layout-waiting: .*\/dashboard/);
  assert.deepEqual((await placementDiagnostics(f)).slice(diagnostics).map(entry => entry.code), ['LAYOUT_WAIT'], 'one diagnostics entry');
  // The next /dashboard applies the same rules again: the move restarts and completes.
  await selectChat(f);
  const resumed = f.mutations().length;
  await f.todo.schedule(DASHBOARD);
  const added = f.mutations().slice(resumed).map(call => call.args);
  assert.deepEqual(added[0].slice(0, 7), ['split', '--pane', ids.todo, '--direction', 'down', '--ratio', '0.5']);
  assert.equal((await readRecord(placementPath(f))).phase, 'COMPLETE');
  assert.deepEqual(f.rects(ids), BAND_TARGET['172x46']);
  assert.equal(f.fake.focused(), 'parent');
  assert.deepEqual(await claims(f), ['band', 'band', 'band']);
});

for (const [variant, change] of Object.entries({
  'a different shell birth': (f, journal) => writeJson(placementPath(f),
    { ...journal, temporary: { ...journal.temporary, shell: { ...journal.temporary.shell, birth: 'another-shell-birth' } } }),
  'a viewer process': async (f, journal) => f.foreignProcess(journal.temporary.paneId),
  'another tab': (f, journal) => writeJson(placementPath(f), { ...journal, temporary: { ...journal.temporary, tabId: 'another-tab' } }),
  'another owner nonce': (f, journal) => writeJson(placementPath(f), { ...journal, ownerNonce: randomUUID() }),
})) test(`band_stuck_journal_failure ${variant}: the temporary pane's identity does not verify, so /dashboard waits without closing it`, async t => {
  const { f, ids, journal, temporary } = await stuckMove(t, 'split');
  await change(f, journal);
  const recorded = await readRecord(placementPath(f)), rects = f.rects({ ...ids, temporary });
  await selectChat(f);
  for (const attempt of [1, 2]) { // a later explicit /dashboard applies the same rules again
    const from = f.mutations().length, diagnostics = (await placementDiagnostics(f)).length, w = f.warnings.length;
    const failure = await f.todo.schedule(DASHBOARD).then(() => undefined, error => error);
    assert.equal(failure, undefined, `attempt ${attempt}: a wait, not a failure`);
    assert.deepEqual(f.mutations().slice(from).map(head), [], `attempt ${attempt}: zero mutations`);
    assert.ok(f.fake.panes().includes(temporary), 'the unverified pane is never closed');
    assert.deepEqual(f.rects({ ...ids, temporary }), rects);
    assert.deepEqual(await readRecord(placementPath(f)), recorded);
    assert.equal(f.todo.status, 'layout-waiting');
    assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery latch');
    assert.equal(f.actor.blocked, false);
    assert.equal(f.warnings.length, w + 1, 'an explicit /dashboard always answers');
    assert.match(f.warnings.at(-1), /^layout-waiting: .*\/dashboard/);
    assert.deepEqual((await placementDiagnostics(f)).slice(diagnostics).map(entry => entry.code), ['IDENTITY_MISMATCH'],
      'one diagnostics entry');
  }
  // The owner closes that pane: it is authoritatively gone, so the move starts again and completes.
  await f.exitPane(temporary);
  await f.todo.schedule(DASHBOARD);
  assert.equal((await readRecord(placementPath(f))).phase, 'COMPLETE');
  assert.deepEqual(f.rects(ids), BAND_TARGET['172x46']);
  assert.equal(f.fake.focused(), 'parent');
  assert.deepEqual(await claims(f), ['band', 'band', 'band']);
});

test('band_stuck_journal_failure a focus change before the resumed swap: the resolution stops at its guard with zero mutations; the journal stays for the next /dashboard', async t => {
  const { f, ids, journal, temporary } = await stuckMove(t, 'split');
  await selectChat(f);
  const placementFocus = f.dag.placementFocus.bind(f.dag);
  let reads = 0;
  f.dag.placementFocus = async (...args) => {
    if (++reads === 2) await f.fake.herdr('focus', '--pane', 'parent', '--direction', 'right'); // the owner, at the resumed swap's guard
    return placementFocus(...args);
  };
  const from = f.mutations().length, diagnostics = (await placementDiagnostics(f)).length, w = f.warnings.length;
  const failure = await f.todo.schedule(DASHBOARD).then(() => undefined, error => error);
  f.dag.placementFocus = placementFocus;
  assert.equal(reads >= 2, true);
  assert.equal(failure, undefined, 'a wait, not a failure');
  assert.deepEqual(f.mutations().slice(from).map(head), [], 'zero mutations');
  assert.ok(f.fake.panes().includes(temporary));
  assert.deepEqual(await readRecord(placementPath(f)), journal, 'the unresolved journal stays as it was');
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery latch');
  assert.equal(f.warnings.length, w + 1);
  assert.match(f.warnings.at(-1), /^layout-waiting: .*\/dashboard/);
  assert.deepEqual((await placementDiagnostics(f)).slice(diagnostics).map(entry => entry.code), ['LAYOUT_WAIT'], 'one diagnostics entry');
  await selectChat(f);
  await f.todo.schedule(DASHBOARD);
  assert.equal((await readRecord(placementPath(f))).phase, 'COMPLETE');
  assert.deepEqual(f.rects(ids), BAND_TARGET['172x46']);
  assert.equal(f.fake.focused(), 'parent');
  assert.deepEqual(await claims(f), ['band', 'band', 'band']);
});

// The phase a journal recorded and the panes must agree before anything is issued.
test('band_stuck_journal_failure the recorded phase disagrees with the panes: a journal that recorded its swap while the panes show it undone waits without a mutation', async t => {
  const { f, ids, journal, temporary } = await stuckMove(t, 'swap');
  assert.deepEqual([journal.phase, journal.failedStage], ['BLOCKED', 'SWAP_SETTLED']);
  await f.fake.herdr('swap', '--source-pane', ids.dag, '--target-pane', temporary); // the owner undoes the swap
  await selectChat(f);
  const from = f.mutations().length, diagnostics = (await placementDiagnostics(f)).length;
  await f.todo.schedule(DASHBOARD);
  assert.deepEqual(f.mutations().slice(from).map(head), [], 'zero mutations');
  assert.ok(f.fake.panes().includes(temporary));
  assert.deepEqual(await readRecord(placementPath(f)), journal);
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked);
  assert.match(f.warnings.at(-1), /^layout-waiting: .*\/dashboard/);
  assert.deepEqual((await placementDiagnostics(f)).slice(diagnostics).map(entry => entry.code), ['OPERATION_MISMATCH']);
  // The owner closes the extra pane: nothing temporary is left and the swap was recorded, so the
  // journal is COMPLETE and the migration plans again from the panes.
  await f.exitPane(temporary);
  await f.todo.schedule(DASHBOARD);
  assert.equal((await readRecord(placementPath(f))).phase, 'COMPLETE');
  assert.deepEqual(f.rects(ids), BAND_TARGET['172x46']);
  assert.equal(f.fake.focused(), 'parent');
  assert.deepEqual(await claims(f), ['band', 'band', 'band']);
});

test('band_stuck_journal_failure the recorded phase disagrees with the panes: a journal stopped before its swap while the panes show it done waits without a mutation', async t => {
  const { f, ids, journal, temporary } = await stoppedAfterSplit(t);
  await f.fake.herdr('swap', '--source-pane', ids.dag, '--target-pane', temporary); // the owner made the swap
  await selectChat(f);
  const from = f.mutations().length, diagnostics = (await placementDiagnostics(f)).length;
  await f.todo.schedule(DASHBOARD);
  assert.deepEqual(f.mutations().slice(from).map(head), [], 'zero mutations');
  assert.ok(f.fake.panes().includes(temporary));
  assert.deepEqual(await readRecord(placementPath(f)), journal);
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked);
  assert.match(f.warnings.at(-1), /^layout-waiting: .*\/dashboard/);
  assert.deepEqual((await placementDiagnostics(f)).slice(diagnostics).map(entry => entry.code), ['OPERATION_MISMATCH']);
  // The owner closes the extra pane: the geometry proves the move, so the journal is COMPLETE.
  await f.exitPane(temporary);
  const resumed = f.mutations().length;
  await f.todo.schedule(DASHBOARD);
  assert.deepEqual(f.mutations().slice(resumed).map(call => call.args[0]), AFTER_FIRST_MOVE, 'the move is not replayed');
  assert.equal((await readRecord(placementPath(f))).phase, 'COMPLETE');
  assert.deepEqual(f.rects(ids), BAND_TARGET['172x46']);
  assert.deepEqual(await claims(f), ['band', 'band', 'band']);
});

for (const [variant, write] of Object.entries({
  'an unreadable journal': f => writeFile(placementPath(f), '{"phase":'),
  'a journal that recorded no temporary pane': f => writeJson(placementPath(f), { schema: 'omo-herdr-dashboard/temporary-placement/1',
    ...f.dag.binding, phase: 'BLOCKED', failedStage: 'PREPARED', temporary: null }),
})) test(`band_stuck_journal_failure ${variant}: any other unresolved state waits with one diagnostics entry, never BLOCKED`, async t => {
  const { f, ids } = await liveColumns(t);
  await write(f);
  const bytes = await readFile(placementPath(f), 'utf8'), rects = f.rects(ids);
  const from = f.mutations().length, diagnostics = (await placementDiagnostics(f)).length;
  const failure = await f.todo.schedule(DASHBOARD).then(() => undefined, error => error);
  assert.equal(failure, undefined, 'a wait, not a failure');
  assert.deepEqual(f.mutations().slice(from).map(head), [], 'zero mutations');
  assert.deepEqual(f.rects(ids), rects);
  assert.equal(await readFile(placementPath(f), 'utf8'), bytes);
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked, 'a wait, not a recovery latch');
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /^layout-waiting: .*\/dashboard/);
  assert.deepEqual((await placementDiagnostics(f)).slice(diagnostics).map(entry => entry.code), ['OPERATION_MISMATCH']);
  assert.deepEqual(await claims(f), ['columns', 'columns', 'columns']);
});

test('band_stuck_journal_failure EFFECT_UNKNOWN on a resize: the controller waits with one placement diagnostic while the actor stays UNKNOWN and nothing is replayed', async t => {
  const { f, temporary } = await stuckMove(t, 'split');
  await selectChat(f);
  let lost = false;
  f.hooks.lose = args => !lost && args[0] === 'resize' && (lost = true);
  const from = f.mutations().length, diagnostics = (await placementDiagnostics(f)).length;
  await f.todo.schedule(DASHBOARD);
  delete f.hooks.lose;
  assert.deepEqual(f.mutations().slice(from).map(call => call.args[0]),
    ['swap', 'focus', 'close', ...AFTER_FIRST_MOVE.slice(0, -1)], 'nothing after the unknown resize');
  assert.ok(!f.fake.panes().includes(temporary));
  assert.equal((await readRecord(placementPath(f))).phase, 'COMPLETE', 'no unresolved journal is left');
  assert.equal(f.actor.blocked, true, 'the unknown effect stays fail-closed');
  assert.equal(f.actor.snapshot.operations.at(-1).status, 'UNKNOWN');
  assert.equal(f.todo.recoveryBlocked, true, 'the actor recovery latch stays set');
  assert.equal(f.todo.status, 'layout-waiting');
  assert.deepEqual((await placementDiagnostics(f)).slice(diagnostics).map(row => row.code), ['EFFECT_UNKNOWN']);
  assert.deepEqual(await claims(f), ['columns', 'columns', 'columns']);
  const settled = f.mutations().length, operations = f.actor.snapshot.operations;
  await f.todo.schedule(DASHBOARD);
  assert.deepEqual(f.mutations().slice(settled).map(head), [], 'nothing is replayed after the unknown effect');
  assert.deepEqual(f.actor.snapshot.operations, operations, 'no mutation or fabricated settlement');
  assert.equal(f.actor.blocked, true);
  assert.equal(f.todo.recoveryBlocked, true);
  assert.equal(f.todo.status, 'layout-waiting');
  assert.deepEqual((await placementDiagnostics(f)).slice(diagnostics).map(row => row.code), ['EFFECT_UNKNOWN']);
});

// Generation 7's first move put the DAG right of the chat through a temporary split of the
// chat. Both live journals stopped there (warnings-diagnosis.md W6, W12): BLOCKED at
// SPLIT_SETTLED by an older slot generation. Built through the real actor, so the slot
// records the temporary split with the journal's owner nonce.
async function generation7Journal(t, error) {
  const { f, ids } = await liveColumns(t);
  const beforeLayout = f.layout(), coordinator = f.todo.coordinator();
  const created = await coordinator.passScope(true, () => f.dag.mutate('dag', 'split', 'parent',
    ['split', '--pane', 'parent', '--direction', 'right', '--ratio', '0.5', '--cwd', f.directory, '--no-focus']));
  const temporary = created.pane.pane_id, slot = f.actor.snapshot;
  const journal = { schema: 'omo-herdr-dashboard/temporary-placement/1', ...f.dag.binding, lifetimeId: f.dag.lifetimeId,
    ownerNonce: slot.ownerNonce, generation: slot.generation, source: await coordinator.target(ids.dag),
    anchor: await coordinator.target('parent'), direction: 'right', selected: 'parent', phase: 'BLOCKED', beforeLayout,
    temporary: await coordinator.target(temporary), operations: slot.operations, createdPaneId: temporary,
    splitReceipt: created, failedStage: 'SPLIT_SETTLED', error, failureLayout: f.layout() };
  await writeJson(placementPath(f), journal);
  await f.restart();
  assert.ok(f.actor.snapshot.generation > journal.generation, 'an older slot generation wrote the journal');
  return { f, ids, journal, temporary };
}

test('band_stuck_journal_resolved generation-7 journal with its temporary pane (W12): /dashboard completes that move through the actor without changing the chat', async t => {
  const { f, ids, temporary } = await generation7Journal(t, { message: 'layout-waiting: placement requires the selected owned tab' });
  const chat = rectArray(f.layout().panes.find(pane => pane.pane_id === 'parent').rect);
  const phases = watchPhases(f), from = f.mutations().length, w = f.warnings.length;
  await f.todo.schedule(DASHBOARD);
  const added = f.mutations().slice(from).map(call => call.args);
  assert.deepEqual(added.map(args => args[0]), ['swap', 'focus', 'close']);
  assert.deepEqual(added[0], ['swap', '--source-pane', ids.dag, '--target-pane', temporary]);
  assert.deepEqual(added[2], ['close', temporary]);
  for (const phase of phases) assert.deepEqual(rectArray(phase.chat), chat, 'the chat keeps its rect');
  assertChatUntouched(added, ids);
  assertActorOnly(f);
  assert.equal((await readRecord(placementPath(f))).phase, 'COMPLETE');
  assert.deepEqual(await f.ids(), ids);
  assert.deepEqual(f.fake.panes().sort(), Object.values(ids).sort());
  assert.equal(f.fake.focused(), 'parent');
  // The generation-7 arrangement it completes is no band source: an explicit wait, not a latch.
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(!f.todo.recoveryBlocked);
  assert.equal(f.warnings.length, w + 1);
  assert.match(f.warnings.at(-1), /^layout-waiting: .*\/dashboard/);
  assert.deepEqual(await claims(f), ['columns', 'columns', 'columns']);
});

test('band_target_gone generation-7 journal left with EFFECT_UNKNOWN (W6): its temporary pane and its moved DAG pane are gone, so /dashboard records it COMPLETE and opens the band', async t => {
  const { f, ids, temporary } = await generation7Journal(t, { code: 'EFFECT_UNKNOWN', message: 'EFFECT_UNKNOWN' });
  await f.exitPane(temporary);
  await f.exitPane(ids.dag); // that conversation's DAG pane was replaced later (W6)
  const phases = watchPhases(f), from = f.mutations().length;
  await f.todo.schedule(DASHBOARD);
  const now = await f.ids(), added = f.mutations().slice(from).map(call => call.args);
  assert.notEqual(now.dag, ids.dag, 'the DAG reopened');
  assert.ok(!added.some(args => args[0] === 'close'), 'nothing of the journal is left to close');
  assert.equal((await readRecord(placementPath(f))).phase, 'COMPLETE');
  for (const phase of phases) assert.deepEqual(rectArray(phase.chat), BAND_TARGET['172x46'].parent);
  assertChatUntouched(added, now);
  assertActorOnly(f);
  assert.equal(isBandDashboard(f.layout(), now), true);
  assert.equal(f.fake.focused(), 'parent');
  assert.deepEqual(await claims(f), ['band', 'band', 'band']);
  assert.ok(!f.todo.recoveryBlocked);
});

test('band_target_gone generation-7 journal whose temporary pane is gone while its DAG lives: the move that split the chat is not repeated, and /dashboard migrates the columns without touching the chat', async t => {
  const { f, ids, temporary } = await generation7Journal(t, { code: 'EFFECT_UNKNOWN', message: 'EFFECT_UNKNOWN' });
  await f.exitPane(temporary); // the chat takes its space back (task-1 S7)
  assert.deepEqual(f.rects(ids), COLUMNS_SOURCE['172x46'], 'the panes before the move');
  const phases = watchPhases(f), from = f.mutations().length;
  await f.todo.schedule(DASHBOARD);
  const added = f.mutations().slice(from).map(call => call.args);
  assert.ok(!added.some(args => args[0] === 'split' && args[2] === 'parent'), 'the chat is never split again');
  for (const phase of phases) assert.deepEqual(rectArray(phase.chat), BAND_TARGET['172x46'].parent);
  assertChatUntouched(added, ids);
  assertActorOnly(f);
  assert.equal((await readRecord(placementPath(f))).phase, 'COMPLETE');
  assert.deepEqual(f.rects(ids), BAND_TARGET['172x46']);
  assert.equal(f.fake.focused(), 'parent');
  assert.deepEqual(await claims(f), ['band', 'band', 'band']);
});

test('band_reopen_missing_role prepared receipt: a reopen stopped between the workers split and its swap resumes from the persisted receipt without a second split', async t => {
  const f = await bandDashboard(t);
  await f.todo.schedule();
  const before = await f.ids();
  await f.exitPane(before.workers);
  let moved = false;
  f.hooks.after = async args => { // the owner moves the selection as the new workers pane appears
    if (!moved && args[0] === 'split') { moved = true; await f.fake.herdr('focus', '--pane', 'parent', '--direction', 'right'); }
  };
  const count = f.mutations().length;
  await f.todo.schedule(DASHBOARD).catch(() => {}); // the todo-6 reopen stops before its swap
  delete f.hooks.after;
  assert.ok(moved);
  assert.deepEqual(f.mutations().slice(count).map(call => call.args[0]), ['split'], 'no swap after the selection changed');
  const record = await readRecord(f.dag.paneFile('workers'));
  assert.equal(record.prepared, true, 'the prepared receipt is persisted before the swap');
  assert.ok(f.fake.panes().includes(record.paneId));
  assert.equal(record.processId, undefined);
  await selectChat(f);
  const resumed = f.mutations().length;
  await f.todo.schedule(DASHBOARD);
  const added = f.mutations().slice(resumed).map(call => call.args);
  assert.ok(!added.some(args => args[0] === 'split'), 'no second split');
  const ids = await f.ids();
  assert.equal(ids.workers, record.paneId, 'the prepared pane is launched');
  assert.deepEqual(f.fake.panes().sort(), Object.values(ids).sort(), 'one pane per role');
  assertActorOnly(f);
  assert.equal(isBandDashboard(f.layout(), ids), true);
  assert.deepEqual(f.rects(ids), FRESH_BAND['172x46']);
  assert.equal(f.fake.focused(), 'parent');
});

test('band_reopen_missing_role prepared receipt: one failed new-shell observation keeps the split without swap or launch, including a later explicit retry', async t => {
  const f = await bandDashboard(t);
  await f.todo.schedule();
  const before = await f.ids();
  await f.exitPane(before.workers);
  const inspect = f.dag.inspectShell;
  let pid, failed = false;
  f.hooks.after = async args => {
    if (args[0] === 'split' && !pid) {
      const pane = f.layout().panes.find(row => !Object.values(before).includes(row.pane_id));
      pid = (await f.todo.nativePane(pane.pane_id)).shell.pid;
    }
  };
  f.dag.inspectShell = async value => {
    if (value === pid && !failed) { failed = true; throw new Error('shell observation unavailable once'); }
    return inspect(value);
  };
  const from = f.mutations().length;
  await f.todo.schedule(DASHBOARD);
  assert.ok(failed);
  assert.deepEqual(f.mutations().slice(from).map(call => call.args[0]), ['split']);
  const record = await readRecord(f.dag.paneFile('workers'));
  assert.ok(f.fake.panes().includes(record.paneId), 'the split is retained with its locator');
  assert.equal(record.processId, undefined);
  assert.equal(f.todo.status, 'layout-waiting');
  assert.equal(f.actor.blocked, false);
  assert.ok(!f.todo.recoveryBlocked);
  const retry = f.mutations().length;
  await f.todo.schedule(DASHBOARD);
  assert.deepEqual(f.mutations().slice(retry).map(head), [], 'a later observation cannot invent the missing birth checkpoint');
  assert.equal(f.todo.status, 'layout-waiting');
  assert.equal(f.actor.blocked, false);
  assert.ok(!f.todo.recoveryBlocked);
  assert.deepEqual(await readRecord(f.dag.paneFile('workers')), record);
  // Only authoritative absence releases an unverified split; normal observations resume for the next shell.
  await f.exitPane(record.paneId);
  delete f.hooks.after;
  await f.todo.schedule(DASHBOARD);
  const ids = await f.ids();
  assert.notEqual(ids.workers, record.paneId);
  assert.equal(isBandDashboard(f.layout(), ids), true);
  assert.deepEqual(f.fake.panes().sort(), Object.values(ids).sort());
  assertActorOnly(f);
});
