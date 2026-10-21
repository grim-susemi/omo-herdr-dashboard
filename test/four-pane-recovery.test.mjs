import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const environment = await mkdtemp(join(tmpdir(), 'four-pane-env-'));
const socket = join(environment, 'synthetic.sock');
const bin = join(environment, 'herdr.exe');
await writeFile(socket, '');
await writeFile(bin, '');
const saved = Object.fromEntries(['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH', 'HERDR_BIN_PATH',
  'OMO_HERDR_TODO_STATE_DIR', 'OMO_HERDR_DAG_STATE_DIR', 'OMO_HERDR_COORDINATION_STATE_DIR'].map(key =>
  [key, process.env[key]]));
Object.assign(process.env, { HERDR_ENV: '1', HERDR_PANE_ID: 'qa:parent',
  HERDR_SOCKET_PATH: socket, HERDR_BIN_PATH: bin,
  OMO_HERDR_DAG_STATE_DIR: join(environment, 'dag'),
  OMO_HERDR_COORDINATION_STATE_DIR: join(environment, 'coordination') });
const dashboard = (await import('../dist/extension.mjs')).default;
const { createDashboardComposite } = await import('../dist/extension.mjs');
const { RECOVERY_V1, bindingRevision, geometryRevision } =
  await import('../dist/coordination/src/recovery.mjs');

after(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(environment, { recursive: true, force: true });
});

// Await a production-provided signal, never a fixed tick budget. The deadline
// is a bound on a stuck test, not a synchronization mechanism.
const within = async (promise, description, ms = 5000) => {
  const controller = new AbortController();
  try {
    return await Promise.race([promise,
      delay(ms, undefined, { signal: controller.signal, ref: false }).then(() => {
        throw new Error(`timed out waiting for ${description}`);
      })]);
  } finally { controller.abort(); }
};

function fakeClock() {
  let now = 0, id = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { const key = ++id; timers.set(key, { fn, at: now + ms }); return key; },
    clearTimeout(key) { timers.delete(key); },
    advance(ms) {
      now += ms;
      for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.fn(); }
    },
    get size() { return timers.size; },
  };
}

const scopeFor = () => ({ ownerKey: 'qa-owner', sessionId: 'qa-session',
  lifetimeId: 'qa-lifetime', scopeEpoch: 1, generation: 1, tabId: 'qa:tab' });
const RECTS = {
  collab: { role: 'collab', paneId: 'qa:collab', rect: { x: 2, y: 20, width: 28, height: 20 } },
  workers: { role: 'workers', paneId: 'qa:workers', rect: { x: 30, y: 20, width: 28, height: 20 } },
  dag: { role: 'dag', paneId: 'qa:dag', rect: { x: 58, y: 20, width: 30, height: 20 } },
};
// The same panes, scope and binding with different widths. The band union is
// identical, so only the cell geometry (and its revision) changes.
const NARROW_RECTS = {
  collab: { role: 'collab', paneId: 'qa:collab', rect: { x: 2, y: 20, width: 24, height: 20 } },
  workers: { role: 'workers', paneId: 'qa:workers', rect: { x: 26, y: 20, width: 30, height: 20 } },
  dag: { role: 'dag', paneId: 'qa:dag', rect: { x: 56, y: 20, width: 32, height: 20 } },
};
let passSeq = 0;
function layoutFor(scope, commandId, { collab = true, geometry = 'wide' } = {}) {
  passSeq += 1;
  const set = geometry === 'narrow' ? NARROW_RECTS : RECTS;
  const cells = collab ? [set.collab, set.workers, set.dag] : [set.workers, set.dag];
  const band = { x: cells[0].rect.x, y: cells[0].rect.y,
    width: cells.at(-1).rect.x + cells.at(-1).rect.width - cells[0].rect.x,
    height: cells[0].rect.height };
  const message = { v: 1, kind: 'layout', scope: { ...scope }, commandId, passSeq,
    explicit: true, todo: 'qa:todo', workers: 'qa:workers', dag: 'qa:dag',
    band, cells: cells.map(cell => ({ ...cell, rect: { ...cell.rect } })) };
  message.bindingRevision = bindingRevision(message);
  message.geometryRevision = geometryRevision(message);
  return message;
}
function resultFor(scope, commandId, { coreReady = true, collab = true, status = 'settled',
  reason = null, error = null } = {}) {
  return { v: 1, kind: 'result', scope: { ...scope }, commandId, status,
    fourPaneComplete: coreReady && collab,
    core: { ready: coreReady, workers: coreReady ? 'qa:workers' : null, dag: coreReady ? 'qa:dag' : null },
    collab: { current: collab, paneId: collab ? 'qa:collab' : null, ...(reason ? { reason } : {}) },
    ...(error ? { error } : {}) };
}

async function harness(t, { timeoutMs = 5000, timers, makePass } = {}) {
  const directory = join(environment, randomUUID());
  process.env.OMO_HERDR_TODO_STATE_DIR = join(directory, 'todo');
  process.env.OMO_HERDR_DAG_STATE_DIR = join(directory, 'dag');
  process.env.OMO_HERDR_COORDINATION_STATE_DIR = join(directory, 'coordination');
  const scope = scopeFor(), startLog = [], notifications = [];
  const bus = new EventEmitter(), handlers = new Map(), commands = new Map();
  const pi = {
    cwd: project,
    events: {
      on(name, callback) { bus.on(name, callback); return () => bus.off(name, callback); },
      emit(name, value) { bus.emit(name, value); },
    },
    on(name, callback) { const list = handlers.get(name) ?? []; list.push(callback); handlers.set(name, list); },
    registerCommand(name, command) { commands.set(name, command); },
  };
  const requestRecovery = typeof makePass === 'function' ? makePass({ scope, bus })
    : async ({ commandId }) => {
      bus.emit(RECOVERY_V1.layout, layoutFor(scope, commandId, { collab: true }));
      const result = resultFor(scope, commandId, { coreReady: true, collab: true });
      bus.emit(RECOVERY_V1.result, result);
      return result;
    };
  const todo = {
    binding: { socketPath: socket, parentPaneId: 'qa:parent', sessionId: scope.sessionId,
      ownerKey: scope.ownerKey },
    lifetimeId: scope.lifetimeId, scopeEpoch: scope.scopeEpoch, stopped: false,
    async start() { startLog.push('todo'); }, async bind() {}, async schedule() {}, async stop() {},
    coordinator() { return { schedule: async () => {} }; },
    recoveryScope: () => scope,
    requestRecovery,
  };
  const dag = {
    binding: todo.binding, lifetimeId: scope.lifetimeId, stopped: false, managedAvailable: true,
    coordinator: { actor: { blocked: false, leaseHeld: true, draining: false }, schedule: async () => {} },
    provider: () => ({ setCoordinator() {} }),
    async start() { startLog.push('dag'); }, async stop() {}, async openPair() {},
    async open() { startLog.push('dag-open'); },
  };
  const coordination = {
    async start() { startLog.push('coordination'); }, async stop() {},
    async acceptLayout() {}, async acceptYield() {}, async shutdownObserve() {},
  };
  const root = dashboard(pi, { commandTimeoutMs: timeoutMs,
    setTimeout: timers?.setTimeout, clearTimeout: timers?.clearTimeout,
    todo: { createController: () => todo },
    dag: { createController: () => dag },
    coordination: { createController: () => coordination } });
  const ctx = { hasUI: true, mode: 'tui',
    ui: { notify(message, level) { notifications.push({ message, level }); } },
    sessionManager: { getSessionFile: () => join(directory, 'parent.jsonl'),
      getSessionId: () => scope.sessionId } };
  const fixture = {
    scope, bus, startLog, notifications, commands, composite: root.composite,
    stopped: false,
    async start() {
      const event = {};
      for (const handler of handlers.get('session_start') ?? []) await handler(event, ctx);
    },
    command() { return commands.get('dashboard').handler('', ctx); },
    async stop() {
      if (fixture.stopped) return;
      fixture.stopped = true;
      for (const handler of handlers.get('session_shutdown') ?? []) await handler();
    },
  };
  t.after(async () => { await fixture.stop(); await rm(directory, { recursive: true, force: true }); });
  return fixture;
}

test('four-pane composite drives the real entry modules and reports 4/4 only from a matching conjunction',
  async t => {
    const f = await harness(t);
    await f.start();
    assert.deepEqual(f.startLog.filter(entry => ['todo', 'dag', 'coordination'].includes(entry)).sort(),
      ['coordination', 'dag', 'todo']);
    const result = await f.command();
    assert.ok(f.startLog.includes('dag-open'), 'the real DAG command opens the core views');
    assert.equal(result.status, 'settled');
    assert.equal(result.fourPaneComplete, true);
    assert.equal(result.core.ready, true);
    assert.equal(result.core.bindingCurrent, true);
    assert.equal(result.collab.current, true);
    assert.equal(result.collab.paneId, 'qa:collab');
    assert.equal(f.composite.responses, 1);
    assert.equal(f.notifications.length, 1);
    assert.match(f.notifications[0].message, /4\/4/);
  });

test('four-pane partial core status and a later current layout converge without a second response',
  async t => {
    const f = await harness(t, { makePass: ({ scope, bus }) => async ({ commandId }) => {
      bus.emit(RECOVERY_V1.layout, layoutFor(scope, commandId, { collab: false }));
      const result = resultFor(scope, commandId, { coreReady: true, collab: false, reason: 'waiting' });
      bus.emit(RECOVERY_V1.result, result);
      return result;
    } });
    await f.start();
    const response = await f.command();
    assert.equal(response.status, 'partial');
    assert.equal(response.fourPaneComplete, false);
    assert.equal(response.core.ready, true);
    assert.equal(response.collab.current, false);
    assert.equal(f.composite.responses, 1);
    // A later settled layout for the same core binding carries the first Collab
    // paint, but it is a different geometry: the earlier result is not a proof
    // for it. Current state stays incomplete until a fresh result for that pass.
    const later = layoutFor(f.scope, randomUUID(), { collab: true });
    f.bus.emit(RECOVERY_V1.layout, later);
    const current = f.composite.current();
    assert.equal(current.fourPaneComplete, false);
    assert.equal(current.core.ready, true);
    assert.equal(current.collab.current, false);
    assert.equal(current.collab.reason, 'geometry-mismatch');
    f.bus.emit(RECOVERY_V1.result, resultFor(f.scope, later.commandId,
      { coreReady: true, collab: true }));
    const fresh = f.composite.current();
    assert.equal(fresh.fourPaneComplete, true);
    assert.equal(fresh.collab.current, true);
    assert.equal(response.fourPaneComplete, false);
    assert.equal(f.composite.responses, 1);
    assert.equal(f.notifications.length, 1);
  });

test('11-h (a) a same-binding width-only change requires a fresh Collab proof for that geometry', () => {
  const local = scopeFor();
  const composite = createDashboardComposite({ scopeProvider: () => local });
  const wide = layoutFor(local, '11h-a-wide', { collab: true });
  composite.observeLayout(wide);
  composite.observeResult(resultFor(local, '11h-a-wide', { coreReady: true, collab: true }));
  const healthy = composite.current();
  assert.equal(healthy.fourPaneComplete, true);
  // The healthy steady state keeps the pre-11-h root status bytes.
  assert.deepEqual({ ...healthy, scope: { ...healthy.scope, lifetimeId: '<lifetime>' } }, {
    v: 1, kind: 'result', scope: { ownerKey: 'qa-owner', sessionId: 'qa-session',
      lifetimeId: '<lifetime>', scopeEpoch: 1, generation: 1, tabId: 'qa:tab' },
    commandId: '11h-a-wide', status: 'settled', fourPaneComplete: true,
    core: { ready: true, bindingCurrent: true, workers: 'qa:workers', dag: 'qa:dag' },
    collab: { current: true, paneId: 'qa:collab' },
    bindingRevision: wide.bindingRevision, pending: false, timedOut: false,
  });
  const narrow = layoutFor(local, '11h-a-narrow', { collab: true, geometry: 'narrow' });
  assert.equal(narrow.bindingRevision, wide.bindingRevision, 'only the widths changed');
  assert.notEqual(narrow.geometryRevision, wide.geometryRevision);
  composite.observeLayout(narrow);
  const stale = composite.current();
  assert.equal(stale.fourPaneComplete, false, 'the previous geometry proof is stale');
  assert.equal(stale.collab.current, false);
  assert.equal(stale.collab.reason, 'geometry-mismatch');
  assert.equal(stale.core.ready, true, 'the core result is still READY');
  // Replaying the old result cannot authorize the new geometry.
  composite.observeResult(resultFor(local, '11h-a-wide', { coreReady: true, collab: true }));
  assert.equal(composite.current().fourPaneComplete, false);
  // A result minted for the new pass is the fresh proof.
  composite.observeResult(resultFor(local, '11h-a-narrow', { coreReady: true, collab: true }));
  const fresh = composite.current();
  assert.equal(fresh.fourPaneComplete, true);
  assert.equal(fresh.collab.current, true);
  assert.equal(fresh.bindingRevision, wide.bindingRevision);
});

for (const [label, options] of [
  ['environment disabled', { coreReady: true, collab: false, reason: 'environment-off' }],
  ['band too narrow', { coreReady: true, collab: false, reason: 'too-narrow' }],
  ['Collab current without core READY', { coreReady: false, collab: true }],
]) {
  test(`four-pane ${label} never reports complete`, async t => {
    const f = await harness(t, { makePass: ({ scope, bus }) => async ({ commandId }) => {
      bus.emit(RECOVERY_V1.layout, layoutFor(scope, commandId, { collab: options.collab }));
      const result = resultFor(scope, commandId, { coreReady: options.coreReady,
        collab: options.collab, reason: options.reason });
      bus.emit(RECOVERY_V1.result, result);
      return result;
    } });
    await f.start();
    const result = await f.command();
    assert.equal(result.fourPaneComplete, false);
    assert.equal(result.status, 'partial');
    assert.equal(result.core.ready, options.coreReady);
    assert.equal(result.collab.current, options.collab);
    if (options.reason) assert.equal(result.collab.reason, options.reason);
  });
}

test('four-pane failed recovery response never reports complete', async t => {
  const f = await harness(t, { makePass: () => async () => {
    throw Object.assign(new Error('owned pane disappeared'), { code: 'pane_not_found' });
  } });
  await f.start();
  const result = await f.command();
  assert.equal(result.status, 'failed');
  assert.equal(result.fourPaneComplete, false);
  assert.equal(result.error.code, 'pane_not_found');
  assert.equal(f.composite.responses, 1);
});

test('four-pane command timeout returns waiting, then a late paint converges without a second response',
  async t => {
    const clock = fakeClock();
    let release, started;
    const requestStarted = new Promise(resolve => { started = resolve; });
    const f = await harness(t, { timeoutMs: 5000, timers: clock,
      makePass: ({ scope, bus }) => ({ commandId }) => {
        started();
        return new Promise(resolve => {
          release = () => {
            bus.emit(RECOVERY_V1.layout, layoutFor(scope, commandId, { collab: true }));
            const result = resultFor(scope, commandId, { coreReady: true, collab: true });
            bus.emit(RECOVERY_V1.result, result);
            resolve(result);
          };
        });
      } });
    await f.start();
    const pending = f.command();
    await within(requestStarted, 'the command to issue its recovery request');
    clock.advance(5000);
    const response = await pending;
    assert.equal(response.status, 'waiting');
    assert.equal(response.pending, true);
    assert.equal(response.timedOut, true);
    assert.equal(response.fourPaneComplete, false);
    assert.equal(f.composite.responses, 1);
    const painted = new Promise(resolve => f.bus.once(RECOVERY_V1.result, resolve));
    release();
    await within(painted, 'the late settled result to be observed');
    assert.equal(f.composite.current().fourPaneComplete, true);
    assert.equal(f.composite.responses, 1, 'the late paint sends no second terminal response');
    assert.equal(f.notifications.length, 1);
    assert.equal(clock.size, 0);
  });

test('four-pane nonparticipating host cannot fabricate a 4/4 reply', async t => {
  const clock = fakeClock();
  const never = new Promise(() => {});
  let started;
  const requestStarted = new Promise(resolve => { started = resolve; });
  const f = await harness(t, { timeoutMs: 5000, timers: clock,
    makePass: () => () => { started(); return never; } });
  await f.start();
  const pending = f.command();
  await within(requestStarted, 'the command to issue its recovery request');
  const foreign = { ...f.scope, sessionId: 'foreign-session', lifetimeId: 'foreign-lifetime' };
  f.bus.emit(RECOVERY_V1.layout, layoutFor(foreign, 'foreign-command', { collab: true }));
  f.bus.emit(RECOVERY_V1.result, resultFor(foreign, 'foreign-command', { coreReady: true, collab: true }));
  assert.equal(f.composite.current().fourPaneComplete, false);
  clock.advance(5000);
  const response = await pending;
  assert.equal(response.status, 'waiting');
  assert.equal(response.fourPaneComplete, false);
  assert.equal(response.pending, true);
  assert.equal(f.composite.current().fourPaneComplete, false);
});

test('four-pane a newer close removes completion without rewriting the terminal response', async t => {
  const f = await harness(t);
  await f.start();
  const response = await f.command();
  assert.equal(response.fourPaneComplete, true);
  assert.equal(f.composite.current().fourPaneComplete, true);
  // The observed close removes the Collab cell from the next settled layout.
  f.bus.emit(RECOVERY_V1.layout, layoutFor(f.scope, randomUUID(), { collab: false }));
  assert.equal(f.composite.current().collab.current, false);
  assert.equal(f.composite.current().fourPaneComplete, false);
  assert.equal(response.fourPaneComplete, true);
  assert.equal(f.composite.responses, 1);
  assert.equal(f.notifications.length, 1);
});

test('four-pane stale replay cannot resurrect a newer close (T9-CURRENT)', async t => {
  let completeLayout;
  const f = await harness(t, { makePass: ({ scope, bus }) => async ({ commandId }) => {
    completeLayout = layoutFor(scope, commandId, { collab: true });
    bus.emit(RECOVERY_V1.layout, completeLayout);
    const result = resultFor(scope, commandId, { coreReady: true, collab: true });
    bus.emit(RECOVERY_V1.result, result);
    return result;
  } });
  await f.start();
  const response = await f.command();
  assert.equal(response.fourPaneComplete, true);
  const close = layoutFor(f.scope, randomUUID(), { collab: false });
  assert.ok(close.passSeq > completeLayout.passSeq);
  f.bus.emit(RECOVERY_V1.layout, close);
  assert.equal(f.composite.current().fourPaneComplete, false);
  // A delayed replay of the older settled pass must not flip completion back.
  f.bus.emit(RECOVERY_V1.layout, completeLayout);
  assert.equal(f.composite.current().fourPaneComplete, false);
  assert.equal(f.composite.current().collab.current, false);
  // It also cannot masquerade as a new binding to clear then restore state.
  const staleOtherBinding = { ...completeLayout, workers: 'qa:workers-old', dag: 'qa:dag-old' };
  staleOtherBinding.bindingRevision = bindingRevision(staleOtherBinding);
  f.bus.emit(RECOVERY_V1.layout, staleOtherBinding);
  assert.equal(f.composite.current().fourPaneComplete, false);
});

test('four-pane unknown-proof result is dropped and cannot overwrite current evidence (T9-EVICTED-PROOF)', async t => {
  const f = await harness(t);
  await f.start();
  const response = await f.command();
  assert.equal(response.fourPaneComplete, true);
  // A result with no retained pass proof is dropped entirely.
  f.bus.emit(RECOVERY_V1.result, resultFor(f.scope, randomUUID(), { coreReady: false, collab: false }));
  assert.equal(f.composite.current().core.ready, true);
  assert.equal(f.composite.current().fourPaneComplete, true);
  // A close is represented by a settled layout; the unknown result cannot stop it.
  f.bus.emit(RECOVERY_V1.layout, layoutFor(f.scope, 'close-layout', { collab: false }));
  assert.equal(f.composite.current().fourPaneComplete, false);
  // Replaying the original known result cannot resurrect the close.
  f.bus.emit(RECOVERY_V1.result, resultFor(f.scope, response.commandId,
    { coreReady: true, collab: true }));
  assert.equal(f.composite.current().fourPaneComplete, false);
});

test('four-pane lifecycle shutdown clears completion immediately (T9-HOST)', () => {
  let local = scopeFor();
  const composite = createDashboardComposite({ scopeProvider: () => local });
  composite.observeLayout(layoutFor(local, 'live', { collab: true }));
  composite.observeResult(resultFor(local, 'live', { coreReady: true, collab: true }));
  assert.equal(composite.current().fourPaneComplete, true);
  const cachedScope = { ...local };
  local = null;
  const lost = composite.current();
  assert.equal(lost.fourPaneComplete, false);
  assert.equal(lost.core.ready, false);
  assert.equal(lost.collab.current, false);
  assert.equal(lost.status, 'waiting');
  // Cached messages from the old lifecycle cannot resurrect the completion.
  composite.observeLayout(layoutFor(cachedScope, 'cached', { collab: true }));
  composite.observeResult(resultFor(cachedScope, 'cached', { coreReady: true, collab: true }));
  assert.equal(composite.current().fourPaneComplete, false);
  // A new live lifecycle starts empty and requires fresh evidence.
  local = { ...scopeFor(), lifetimeId: 'qa-lifetime-new', generation: 2, scopeEpoch: 2 };
  assert.equal(composite.current().fourPaneComplete, false);
  composite.observeLayout(layoutFor(local, 'fresh', { collab: true }));
  composite.observeResult(resultFor(local, 'fresh', { coreReady: true, collab: true }));
  assert.equal(composite.current().fourPaneComplete, true);
});

test('four-pane root after lifecycle shutdown is not complete (T9-HOST)', async t => {
  const f = await harness(t);
  await f.start();
  const response = await f.command();
  assert.equal(response.fourPaneComplete, true);
  await f.stop();
  const after = f.composite.current();
  assert.equal(after.fourPaneComplete, false);
  assert.equal(after.core.ready, false);
  assert.equal(after.collab.current, false);
  // Messages cached before shutdown cannot resurrect the old lifecycle.
  f.bus.emit(RECOVERY_V1.layout, layoutFor(f.scope, 'cached-after-shutdown', { collab: true }));
  f.bus.emit(RECOVERY_V1.result, resultFor(f.scope, 'cached-after-shutdown', { coreReady: true,
    collab: true }));
  assert.equal(f.composite.current().fourPaneComplete, false);
});

test('four-pane stale replay after 200 results cannot resurrect a close (T9-CURRENT)', () => {
  const local = scopeFor();
  const composite = createDashboardComposite({ scopeProvider: () => local });
  composite.observeLayout(layoutFor(local, 'anchor', { collab: true }));
  composite.observeResult(resultFor(local, 'anchor', { coreReady: true, collab: true }));
  const anchor = composite.current().commandId;
  assert.equal(anchor, 'anchor');
  for (let index = 0; index < 200; index += 1) {
    const id = `later-${index}`;
    composite.observeLayout(layoutFor(local, id, { collab: true }));
    composite.observeResult(resultFor(local, id, { coreReady: true, collab: true }));
  }
  assert.equal(composite.current().fourPaneComplete, true);
  composite.observeLayout(layoutFor(local, 'close-layout', { collab: false }));
  assert.equal(composite.current().fourPaneComplete, false);
  // The original result is now far outside every bounded history window.
  composite.observeResult(resultFor(local, anchor, { coreReady: true, collab: true }));
  assert.equal(composite.current().fourPaneComplete, false);
  // The newest valid layout converges only with a proof minted after the close.
  composite.observeLayout(layoutFor(local, 'reopen', { collab: true }));
  assert.equal(composite.current().fourPaneComplete, false);
  composite.observeResult(resultFor(local, 'reopen', { coreReady: true, collab: true }));
  assert.equal(composite.current().fourPaneComplete, true);
});

test('four-pane fully evicted stale result cannot authorize later success (T9-EVICTED-PROOF)', () => {
  const local = scopeFor();
  const composite = createDashboardComposite({ scopeProvider: () => local });
  composite.observeLayout(layoutFor(local, 'old-command', { collab: true }));
  composite.observeResult(resultFor(local, 'old-command', { coreReady: true, collab: true }));
  // 514 pairs exceed both the 512-command proof map and the 16-layout cache.
  for (let index = 0; index < 514; index += 1) {
    const id = `pair-${index}`;
    composite.observeLayout(layoutFor(local, id, { collab: true }));
    composite.observeResult(resultFor(local, id, { coreReady: index !== 513, collab: true }));
  }
  assert.equal(composite.current().core.ready, false, 'newer core-not-ready evidence');
  assert.equal(composite.current().fourPaneComplete, false);
  // The old command's layout and commandPass entry are both evicted.
  composite.observeResult(resultFor(local, 'old-command', { coreReady: true, collab: true }));
  assert.equal(composite.current().core.ready, false, 'evicted stale result is dropped');
  assert.equal(composite.current().fourPaneComplete, false);
  // A later valid layout cannot use the dropped stale result to claim 4/4.
  composite.observeLayout(layoutFor(local, 'later-layout', { collab: true }));
  assert.equal(composite.current().core.ready, false);
  assert.equal(composite.current().fourPaneComplete, false);
});

test('four-pane failed current state never reports complete (T9-FAIL)', async t => {
  const f = await harness(t, { makePass: ({ scope, bus }) => async ({ commandId }) => {
    bus.emit(RECOVERY_V1.layout, layoutFor(scope, commandId, { collab: true }));
    const result = resultFor(scope, commandId, { coreReady: true, collab: true, status: 'failed',
      error: { code: 'COLLAB_FAILED', message: 'viewer exited' } });
    bus.emit(RECOVERY_V1.result, result);
    return result;
  } });
  await f.start();
  const response = await f.command();
  assert.equal(response.status, 'failed');
  assert.equal(response.fourPaneComplete, false);
  assert.equal(f.composite.current().status, 'failed');
  assert.equal(f.composite.current().fourPaneComplete, false);
});

test('four-pane explicit non-complete result vetoes layout completion (T9-FAIL)', () => {
  const local = scopeFor();
  const composite = createDashboardComposite({ scopeProvider: () => local });
  composite.observeLayout(layoutFor(local, 'veto', { collab: true }));
  const result = resultFor(local, 'veto', { coreReady: true, collab: true });
  result.fourPaneComplete = false;
  composite.observeResult(result);
  assert.equal(composite.current().fourPaneComplete, false);
  assert.equal(composite.current().status, 'partial');
});

test('four-pane ownerless root never accepts fabricated completion (T9-HOST)', async t => {
  const scope = scopeFor();
  const composite = createDashboardComposite({ scopeProvider: () => null });
  composite.observeLayout(layoutFor(scope, 'fabricated-layout', { collab: true }));
  composite.observeResult(resultFor(scope, 'fabricated-layout', { coreReady: true, collab: true }));
  const current = composite.current();
  assert.equal(current.fourPaneComplete, false);
  assert.notEqual(current.status, 'settled');
  assert.equal(current.core.ready, false);
  assert.equal(current.collab.current, false);
  // The real root entry with no managed lifecycle behaves the same way.
  const directory = join(environment, `hostless-${randomUUID()}`);
  process.env.OMO_HERDR_TODO_STATE_DIR = directory;
  const bus = new EventEmitter();
  const root = dashboard({
    cwd: project,
    events: { on(name, callback) { bus.on(name, callback); return () => bus.off(name, callback); },
      emit(name, value) { bus.emit(name, value); } },
    on() {}, registerCommand() {},
  });
  try {
    bus.emit(RECOVERY_V1.layout, layoutFor(scope, 'fabricated-entry', { collab: true }));
    bus.emit(RECOVERY_V1.result, resultFor(scope, 'fabricated-entry', { coreReady: true, collab: true }));
    assert.equal(root.composite.current().fourPaneComplete, false);
    assert.equal(root.composite.current().core.ready, false);
  } finally {
    root.unsubscribe();
    await rm(directory, { recursive: true, force: true });
  }
});

test('four-pane scope change clears prior completion immediately (T9-SCOPE)', () => {
  let local = scopeFor();
  const composite = createDashboardComposite({ scopeProvider: () => local });
  composite.observeLayout(layoutFor(local, 'scope-a', { collab: true }));
  composite.observeResult(resultFor(local, 'scope-a', { coreReady: true, collab: true }));
  assert.equal(composite.current().fourPaneComplete, true);
  local = { ...local, lifetimeId: 'qa-lifetime-2', generation: 2 };
  const cleared = composite.current();
  assert.equal(cleared.fourPaneComplete, false);
  assert.equal(cleared.core.ready, false);
  assert.equal(cleared.collab.current, false);
  composite.observeLayout(layoutFor(local, 'scope-b', { collab: true }));
  composite.observeResult(resultFor(local, 'scope-b', { coreReady: true, collab: true }));
  assert.equal(composite.current().fourPaneComplete, true);
  assert.equal(composite.current().scope.lifetimeId, 'qa-lifetime-2');
});

test('four-pane newest valid layout keeps completion past the cache window (T9-CONVERGENCE)', () => {
  const local = scopeFor();
  const composite = createDashboardComposite({ scopeProvider: () => local });
  composite.observeLayout(layoutFor(local, 'pass-0', { collab: true }));
  composite.observeResult(resultFor(local, 'pass-0', { coreReady: true, collab: true }));
  assert.equal(composite.current().fourPaneComplete, true);
  for (let index = 1; index <= 20; index += 1)
    composite.observeLayout(layoutFor(local, `pass-${index}`, { collab: true }));
  assert.equal(composite.current().fourPaneComplete, true);
  composite.observeLayout(layoutFor(local, 'pass-closed', { collab: false }));
  assert.equal(composite.current().fourPaneComplete, false);
  // A re-opened row returns to a previously proven geometry, but that proof
  // predates the close. Completion waits for a result minted after it.
  composite.observeLayout(layoutFor(local, 'pass-reopened', { collab: true }));
  assert.equal(composite.current().fourPaneComplete, false);
  composite.observeResult(resultFor(local, 'pass-reopened', { coreReady: true, collab: true }));
  assert.equal(composite.current().fourPaneComplete, true);
});

test('fixture install ships the shared four-pane protocol and rejects a partial package', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'four-pane-install-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const agent = join(fixture, 'agent'), cli = join(project, 'bin/omo-herdr-dashboard.mjs');
  const env = { ...process.env, HOME: fixture, USERPROFILE: fixture,
    OMO_CODING_AGENT_DIR: agent, SENPI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent };
  const installed = JSON.parse(execFileSync(process.execPath,
    [cli, 'install', '--agent-dir', agent, '--lang', 'en'], { env, encoding: 'utf8' }));
  assert.match(installed.integration, /generation-\d{6}$/);
  assert.equal(installed.extension, join(agent, 'extensions/omo-herdr-dashboard.js'));
  for (const file of ['extension.mjs', 'coordination/src/recovery.mjs', 'coordination/src/proof.mjs']) {
    assert.equal(await readFile(join(installed.integration, file), 'utf8'),
      await readFile(join(project, 'dist', file), 'utf8'), `${file} is installed byte-for-byte`);
  }
  assert.match(await readFile(join(installed.integration, 'extension.mjs'), 'utf8'),
    /coordination\/src\/recovery\.mjs/, 'the entry loads the shared protocol');
  const loaded = await import(pathToFileURL(join(installed.integration, 'extension.mjs')).href +
    `?fixture=${randomUUID()}`);
  assert.equal(typeof loaded.default, 'function');
  assert.equal(typeof loaded.createDashboardComposite, 'function');
  assert.equal(installed.command, '/dashboard',
    'the machine-readable install plan names the command the host registers');

  const partial = join(fixture, 'partial-package');
  await cp(join(project, 'dist'), partial, { recursive: true });
  await rm(join(partial, 'coordination/src/recovery.mjs'));
  const { install } = await import(pathToFileURL(join(partial, 'install.mjs')).href + `?partial=${randomUUID()}`);
  const blocked = join(fixture, 'partial-agent');
  await assert.rejects(install(['--agent-dir', blocked]), /ENOENT|recovery/i);
  await assert.rejects(readdir(blocked), { code: 'ENOENT' });
});
