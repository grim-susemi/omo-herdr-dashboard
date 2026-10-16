// Todo 9: readiness and masking after a band arrangement, with the real Todo
// controller start(): the real presence pipe and publisher, the readiness adapter,
// the display bridge over a host UI and the parent-slot actor (no fake actor and
// no fake presence). Only Herdr (the calibrated split-tree fake) and the viewer
// processes are simulated; the viewers behave like the real ones.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync, watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isBandDashboard, isColumnDashboard } from '../packages/dag/src/controller.mjs';
import { createRoleClient } from '../packages/todo/src/presence.mjs';
import { dashboardChannels } from '../packages/todo/src/controller.mjs';
import { createBandDashboard, NATIVE_MUTATIONS, readRecord } from './helpers/band-dashboard.mjs';

const KEYS = ['omo-dag', 'omo-task', 'todo-sidebar'];
// Without a native Todo only the worker and DAG lines have something to replace.
const WORKER_KEYS = ['omo-dag', 'omo-task'];
const DASHBOARD = { forceRoles: ['dag', 'workers', 'todo'] };
// The selected branch holds a native Todo (a todo tool result); it never changes here.
const BRANCH = Object.freeze([{ type: 'message', id: 'todo-entry', message: { role: 'toolResult', toolName: 'todo',
  isError: false, details: { todos: [{ content: 'Migrate the dashboard', status: 'in_progress' }] } } }]);
// A conversation without a native Todo: the bridge publishes a waiting snapshot.
const NO_TODO = Object.freeze([{ type: 'message', id: 'chat-entry', message: { role: 'user', content: 'Arrange the dashboard' } }]);
const NATIVE_LINES = { 'todo-sidebar': ['native todo'], 'omo-task': ['worker line'], 'omo-dag': ['dag line'] };

// The host UI under the input box: what the owner sees. The bridge wraps setWidget.
// observe(key, shown), when set, sees each change as it is made.
function hostUi() {
  const events = new EventEmitter(), visible = new Map(), history = [], host = { visible, history, events };
  host.ui = { setWidget(key, content) {
    visible.set(key, content); history.push({ key, shown: content !== undefined });
    host.observe?.(key, content !== undefined);
    events.emit('change');
  } };
  return host;
}
// The OmO plugin and the native Todo draw their lines, as after a start or reload.
function drawNativeLines(host) {
  for (const key of KEYS) host.ui.setWidget(key, NATIVE_LINES[key], { placement: 'belowEditor' });
}
// Resolves on the first change event after which done() holds; bounded.
function when(events, done, failure, ms = 20000) {
  return new Promise((resolve, reject) => {
    if (done()) { resolve(); return; }
    const timer = setTimeout(() => {
      events.off('change', check);
      reject(new Error(failure()));
    }, ms);
    function check() {
      if (!done()) return;
      clearTimeout(timer); events.off('change', check); resolve();
    }
    events.on('change', check);
  });
}
// Resolves on the host UI change that hides the last of the keys; bounded.
function hidden(host, keys, label, ms = 20000) {
  return when(host.events, () => keys.every(key => host.visible.has(key) && host.visible.get(key) === undefined),
    () => `${label}: still shown ${keys.filter(key => host.visible.get(key) !== undefined)}`, ms);
}

// A viewer as the real ones bind presence (packages/dag/src/viewer.mjs bindPresence,
// packages/todo/src/viewer.mjs connect): it watches its role state file, connects
// with the presence offer the controller wrote there, and ACKs each snapshot it
// painted: a current, empty or waiting (no native Todo) source. With paints false
// it receives snapshots but paints only on paintAgain(); seen hears each receipt.
function startViewer(statePath, { paints = true, seen } = {}) {
  let key, client, paintAgain, received, closed = false, tail = Promise.resolve();
  const bind = async () => {
    if (closed) return;
    let state;
    try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch { return; }
    const offer = state?.connected ? state.presenceOffer ?? null : null;
    if (closed || JSON.stringify(offer) === key) return;
    key = JSON.stringify(offer); client?.close(); client = undefined;
    if (!offer) return;
    const next = createRoleClient({ offer, onSnapshot: (snapshot, message) => {
      received = message.sequence;
      if (['current', 'empty', 'waiting'].includes(snapshot.availability)) {
        paintAgain = () => next.painted(message);
        if (paints) setImmediate(paintAgain);
      }
      seen?.emit('change');
    } });
    client = next;
  };
  const watcher = watch(dirname(statePath), (_event, name) => {
    if (name && basename(String(name)) !== basename(statePath)) return;
    tail = tail.then(bind);
  });
  tail = tail.then(bind);
  return { get received() { return received; }, paintAgain() { assert.ok(paintAgain); paintAgain(); },
    close() { closed = true; watcher.close(); client?.close(); } };
}

// The placement journal's phase, read synchronously so that observing it does not
// let the observed step move on.
function journalPhase(f) {
  try { return JSON.parse(readFileSync(join(f.dag.directory, 'placement.json'), 'utf8')).phase; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// READY only with completed geometry, settled effects and fresh paints, for every
// READY the actor publishes during the /dashboard pass, not only the last one:
// before the first native mutation the columns dashboard is complete; after it,
// only the band with a COMPLETE journal and every role's painted ACK of a sequence
// committed after the last mutation. The bridge's coverage follows it: no key is
// masked at any native effect, nor again until the band is complete and READY.
function assertArrangedReadiness({ mutations, ready, masking }) {
  assert.ok(mutations.length > 0, 'the migration mutated the native layout');
  const last = Math.max(...mutations.map(entry => entry.sequence));
  for (const entry of ready) {
    const at = JSON.stringify(entry);
    assert.ok(entry.settled, `READY with settled effects: ${at}`);
    if (entry.mutations === 0) {
      assert.ok(entry.columns && [null, 'COMPLETE'].includes(entry.journal), `READY before the migration only on complete columns: ${at}`);
      continue;
    }
    assert.ok(entry.band && entry.journal === 'COMPLETE', `READY only with completed geometry: ${at}`);
    assert.ok(entry.sequence > last, `READY only with paints newer than the last mutation: ${at}`);
    for (const role of ['todo', 'dag', 'workers'])
      assert.deepEqual(entry.acks[role], { sequence: entry.sequence, painted: true }, `${role} painted: ${at}`);
  }
  assert.ok(ready.some(entry => entry.mutations === mutations.length), 'READY after the last mutation');
  for (const entry of mutations) assert.deepEqual(entry.masked, [], `nothing masked at the native ${entry.verb}`);
  for (const entry of masking.filter(change => !change.shown && change.mutations > 0))
    assert.ok(entry.band && entry.journal === 'COMPLETE' && entry.phase === 'READY', `masked only after the arrangement: ${JSON.stringify(entry)}`);
}

async function ackMismatches(f) {
  await f.todo.managedIdle();
  await f.actor.diagnostics;
  let text = '';
  try { text = await readFile(join(f.actor.paths.directory, 'blocked-diagnostics.jsonl'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.code === 'ACK_MISMATCH').length;
}

// The dashboard over the real Todo controller start() and a host UI, with one
// viewer per launched role (paints(role) false: that viewer never paints by
// itself). source.error, when set, makes every branch read throw.
async function open(t, { branch = BRANCH, paints = () => true } = {}) {
  const host = hostUi(), viewers = new Map(), seen = new EventEmitter(), source = { error: null };
  const f = await createBandDashboard({ generation: '000007', display: { ui: host.ui,
    getBranch: () => { if (source.error) throw source.error; return branch; }, getLeafId: () => branch.at(-1).id } });
  t.after(async () => {
    for (const viewer of viewers.values()) viewer.close();
    await f.dispose();
  });
  f.hooks.launch = async (role, phase) => {
    if (phase !== 'after') return;
    viewers.get(role)?.close();
    viewers.set(role, startViewer(role === 'todo' ? f.todo.stateFile : f.dag.roleFile(role), { paints: paints(role), seen }));
  };
  return { f, host, viewers, seen, source };
}

// Generation 7 opened columns (liveColumns in test/managed-layout.test.mjs, 172x46),
// the conversation reloads, then the owner runs /dashboard. Returns after the
// migration's native mutations, before any assertion about readiness. keys: the
// native lines masked at each startup.
async function migrate(t, { interrupt = false, branch, keys = KEYS } = {}) {
  const { f, host, viewers, source } = await open(t, { branch });
  const provider = f.todo.provider, band = provider.bandLayout;
  delete provider.bandLayout;
  try { await f.todo.schedule(); } finally { provider.bandLayout = band; }
  const ids = await f.ids(), root = f.layout().splits[0];
  await f.fake.herdr('resize', '--pane', 'parent', '--direction', 'left', '--amount', String(root.ratio - 69 / 172));
  assert.equal(isColumnDashboard(f.layout(), ids), true, 'generation 7 opened columns');
  drawNativeLines(host);
  await hidden(host, keys, 'first startup');
  assert.equal(f.actor.snapshot.phase, 'READY');
  const startups = [await ackMismatches(f)];
  // /reload: the controller stops and a new one claims the slot and adopts the live panes.
  await f.restart();
  await f.todo.schedule();
  drawNativeLines(host);
  await hidden(host, keys, 'after the reload');
  assert.equal(f.actor.snapshot.phase, 'READY');
  const before = f.todo.presence.state.snapshot, fromHistory = host.history.length;
  // From the /dashboard pass on: every native mutation, every READY the actor
  // publishes and every mask change of the bridge, with the dashboard's state then.
  const mutations = [], ready = [], masking = [];
  const moment = () => ({ mutations: mutations.length, band: isBandDashboard(f.layout(), ids),
    columns: isColumnDashboard(f.layout(), ids), journal: journalPhase(f) });
  const slot = new EventEmitter(), publish = f.actor.publish.bind(f.actor);
  f.actor.publish = next => {
    if (next.phase === 'READY') ready.push({ ...moment(), sequence: f.todo.presence.state.snapshot.sequence,
      settled: next.operations.every(operation => operation.status === 'SETTLED'),
      acks: Object.fromEntries(['todo', 'dag', 'workers'].map(role => [role, next.roles[role]?.ack])) });
    const result = publish(next);
    result.then(() => slot.emit('change'), () => {});
    return result;
  };
  host.observe = (key, shown) => masking.push({ key, shown, ...moment(), phase: f.actor.snapshot.phase });
  // Herdr answers each layout read the arrangement makes between its native steps
  // only once the actor has accepted all three roles' paints of the step's repaint,
  // so every step's fresh paints are accepted while the arrangement still runs.
  const accepted = () => ['todo', 'dag', 'workers'].every(role => {
    const ack = f.actor.snapshot.roles[role]?.ack;
    return ack?.painted === true && ack.sequence === f.todo.presence.state.snapshot.sequence;
  });
  let arranging = true, interrupted = false;
  const after = async args => {
    if (NATIVE_MUTATIONS.includes(args[0])) mutations.push({ verb: args[0], sequence: f.todo.presence.state.snapshot.sequence,
      masked: KEYS.filter(key => host.visible.get(key) === undefined) });
    else if (arranging && mutations.length && args[0] === 'layout' && args[2] === 'parent' && !f.todo.layoutActive) {
      await when(slot, accepted, () => `paints not accepted after the native ${mutations.at(-1).verb}`);
      if (interrupt && !interrupted && mutations.length === 4 && journalPhase(f) === 'COMPLETE') {
        interrupted = true;
        await f.fake.herdr('focus', '--pane', 'parent', '--direction', 'right');
      }
    }
  };
  const retry = async () => {
    arranging = true;
    f.hooks.after = after;
    try { await f.todo.schedule(DASHBOARD); }
    finally { arranging = false; f.hooks.after = undefined; }
  };
  await retry();
  return { f, host, ids, startups, before, fromHistory, mutations, ready, masking, viewers, retry, source };
}

test('band_ready_geometry_and_fresh_paints: after /dashboard migrates columns to the band, fresh paints make the slot READY and the bridge masks todo-sidebar, omo-task and omo-dag without a Todo change', async t => {
  const run = await migrate(t), { f, host, ids, startups, before, fromHistory, mutations } = run;
  // Completed geometry and settled effects.
  assert.ok(mutations.length > 0, 'the migration mutated the native layout');
  assert.equal(isBandDashboard(f.layout(), ids), true);
  assert.deepEqual(await f.ids(), ids, 'the same panes');
  assert.equal((await readRecord(join(f.dag.directory, 'placement.json'))).phase, 'COMPLETE');
  assert.equal(f.fake.focused(), 'parent');
  assert.equal(await f.claimLayout(), 'band');
  // No Todo change: the host draws nothing and the branch stays the same; only the
  // readiness flow runs from here.
  await hidden(host, KEYS, 'after the migration');
  assertArrangedReadiness(run);
  const slot = f.actor.snapshot, published = f.todo.presence.state.snapshot;
  assert.equal(slot.phase, 'READY');
  assert.ok(slot.operations.every(operation => operation.status === 'SETTLED'));
  // Fresh paints: every role ACKed the sequence the publisher committed after the
  // last arrangement, newer than any sequence a migration mutation was issued under.
  assert.ok(published.sequence > Math.max(before.sequence, ...mutations.map(entry => entry.sequence)));
  for (const role of ['todo', 'dag', 'workers'])
    assert.deepEqual(slot.roles[role].ack, { sequence: published.sequence, painted: true }, role);
  assert.equal(f.todo.bridge.status.publication.sequence, published.sequence);
  assert.deepEqual(published.phases, before.phases, 'the same native Todo');
  // The bridge masks all three keys; while the migration ran it had restored them.
  assert.deepEqual(f.todo.bridge.status.masked.sort(), KEYS);
  const during = host.history.slice(fromHistory);
  for (const key of KEYS) {
    assert.ok(during.some(entry => entry.key === key && entry.shown), `${key} restored during the migration`);
    assert.deepEqual(during.filter(entry => entry.key === key).at(-1), { key, shown: false }, `${key} masked at the end`);
  }
  // At most two rejected stale ACKs per startup.
  startups.push(await ackMismatches(f));
  assert.ok(startups.every(count => count <= 2), `ACK_MISMATCH per startup: ${startups}`);
  assert.deepEqual(f.warnings, []);
});

test('band_ready_geometry_and_fresh_paints: with readiness forced false after the migration the native lines are restored, and masked again once it returns', async t => {
  const run = await migrate(t), { f, host, masking } = run;
  await hidden(host, KEYS, 'after the migration');
  assertArrangedReadiness(run);
  assert.equal(f.actor.snapshot.phase, 'READY');
  const from = masking.length;
  f.todo.recoveryBlocked = true;
  f.todo.bridge.readinessChanged();
  for (const key of KEYS) assert.deepEqual(host.visible.get(key), NATIVE_LINES[key], `${key} restored`);
  assert.deepEqual(f.todo.bridge.status.masked, []);
  await f.actor.diagnostics;
  const diagnostics = (await readFile(join(f.actor.paths.directory, 'blocked-diagnostics.jsonl'), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line));
  const denied = diagnostics.filter(entry => entry.branch === 'display' && entry.reason === 'recovery-blocked');
  assert.ok(denied.some(entry => entry.role === 'workers' &&
    entry.sequence === f.todo.bridge.status.publication.sequence && entry.phase === 'READY'));
  f.todo.recoveryBlocked = false;
  f.todo.bridge.readinessChanged();
  for (const key of KEYS) assert.equal(host.visible.get(key), undefined, `${key} masked again`);
  assert.deepEqual(f.todo.bridge.status.masked.sort(), KEYS);
  for (const key of KEYS) assert.deepEqual(masking.slice(from).filter(change => change.key === key).map(change => change.shown),
    [true, false], `${key} restored once, then masked once`);
});

test('content-only worker updates keep healthy native widgets hidden and retain viewer offers', async t => {
  const { f, host } = await open(t);
  const provider = f.todo.provider, bus = new EventEmitter();
  f.todo.provider = undefined;
  const pi = { events: {
    on(name, callback) { bus.on(name, callback); return () => bus.off(name, callback); },
    emit: (name, event) => bus.emit(name, event),
  } };
  f.todo.bind(pi);
  pi.events.emit(dashboardChannels.provider, {
    v: 1, kind: 'dag-provider', ...f.todo.binding, provider,
  });
  await f.todo.tail;
  drawNativeLines(host);
  await hidden(host, KEYS, 'before content update');
  const sequence = f.todo.bridge.status.publication.sequence;
  const offers = Object.fromEntries(['todo', 'dag', 'workers'].map(role => [role, f.todo.presence.offer(role)]));
  const before = host.history.length;
  f.dag.sourceEvents.emit('source', { ...f.dag.source(), tasks: [
    { id: 'worker-1', status: 'running', description: 'A worker progress update' },
  ] });
  assert.equal(host.visible.get('omo-task'), undefined, 'content progress is not loss of the healthy viewer');
  await f.todo.tail;
  await f.todo.managedIdle();
  assert.equal(f.todo.bridge.status.publication.sequence, sequence);
  for (const role of ['todo', 'dag', 'workers'])
    assert.deepEqual(f.todo.presence.offer(role), offers[role], `${role} keeps its presence identity`);
  assert.ok(host.history.slice(before).every(entry => !entry.shown), 'no native widget flashes during content progress');
  f.dag.sourceEvents.emit('source', { ...f.dag.source(), runs: [
    { id: 'dag-coverage', nodes: [{ id: 'node', taskId: 'worker-1' }] },
  ] });
  assert.equal(f.todo.sourceRefreshing, true, 'DAG coverage changes still require fresh paint');
  assert.deepEqual(host.visible.get('omo-task'), NATIVE_LINES['omo-task']);
  await f.todo.tail;
  await hidden(host, KEYS, 'after changed DAG coverage is painted');
  for (const role of ['todo', 'dag', 'workers'])
    assert.notEqual(f.todo.presence.offer(role).token, offers[role].token, `${role} reauthorizes changed DAG coverage`);
});

test('band interrupted arrangement: viewer paint renewals keep native lines visible until an explicit retry completes', async t => {
  const run = await migrate(t, { interrupt: true });
  const { f, host, ids, startups, before, mutations, ready, masking, viewers, retry } = run;
  await f.todo.managedIdle();
  assert.equal(mutations.length, 4, 'selection changed after the first completed move');
  assert.equal(journalPhase(f), 'COMPLETE');
  assert.equal(isBandDashboard(f.layout(), ids), false);
  assert.equal(isColumnDashboard(f.layout(), ids), false);
  assert.equal(f.todo.status, 'layout-waiting');
  assert.ok(f.actor.snapshot.operations.every(operation => operation.status === 'SETTLED'));
  assert.deepEqual(f.todo.bridge.status.masked, []);
  const sequence = f.todo.presence.state.snapshot.sequence, readyBefore = ready.length, masksBefore = masking.length;
  // Real viewers renew successful frames without a new publication. Subscribe
  // before requesting those authenticated, same-sequence paints.
  const renewed = new Promise((resolve, reject) => {
    const roles = new Set();
    const timer = setTimeout(() => { f.todo.presence.events.off('event', onEvent); reject(new Error('paint renewal ACKs not observed')); }, 5000);
    function onEvent(event) {
      if (event.type !== 'ack' || event.sequence !== sequence) return;
      roles.add(event.role);
      if (roles.size === 3) { clearTimeout(timer); f.todo.presence.events.off('event', onEvent); resolve(); }
    }
    f.todo.presence.events.on('event', onEvent);
  });
  for (const viewer of viewers.values()) viewer.paintAgain();
  await renewed;
  await f.todo.managedIdle();
  await f.todo.roleTail;
  assert.equal(f.todo.presence.state.snapshot.sequence, sequence);
  for (const role of ['todo', 'dag', 'workers'])
    assert.deepEqual(f.actor.snapshot.roles[role].ack, { sequence, painted: true }, role);
  assert.notEqual(f.actor.snapshot.phase, 'READY', 'incomplete geometry cannot regain READY on renewal');
  assert.equal(ready.length, readyBefore);
  assert.deepEqual(f.todo.bridge.status.masked, [], 'incomplete geometry cannot gain coverage on renewal');
  assert.ok(masking.slice(masksBefore).every(change => change.shown));
  for (const key of KEYS) assert.deepEqual(host.visible.get(key), NATIVE_LINES[key]);
  // Restore rightful chat selection, then use the same explicit /dashboard path.
  await f.fake.herdr('focus', '--pane', f.fake.focused(), '--direction', 'left');
  assert.equal(f.fake.focused(), 'parent');
  const remasked = hidden(host, KEYS, 'after the explicit retry');
  await retry();
  await remasked;
  assert.equal(isBandDashboard(f.layout(), ids), true);
  assert.deepEqual(await f.ids(), ids);
  assert.equal(journalPhase(f), 'COMPLETE');
  assert.equal(await f.claimLayout(), 'band');
  assert.equal(f.fake.focused(), 'parent');
  assert.equal(f.actor.snapshot.phase, 'READY');
  assertArrangedReadiness(run);
  assert.deepEqual(f.todo.bridge.status.masked.sort(), KEYS);
  assert.deepEqual(f.todo.presence.state.snapshot.phases, before.phases);
  startups.push(await ackMismatches(f));
  assert.ok(startups.every(count => count <= 2), `ACK_MISMATCH per startup: ${startups}`);
});

test('band_no_todo_masks_workers_and_dag: without a native Todo, painted waiting frames make the slot READY at startup, after the reload and after /dashboard; the bridge masks omo-task and omo-dag, never todo-sidebar', async t => {
  const run = await migrate(t, { branch: NO_TODO, keys: WORKER_KEYS }), { f, host, ids, startups, before, source } = run;
  assert.equal(before.availability, 'waiting', 'no native Todo');
  // Completed geometry and settled effects.
  assert.equal(isBandDashboard(f.layout(), ids), true);
  assert.deepEqual(await f.ids(), ids, 'the same panes');
  assert.equal(journalPhase(f), 'COMPLETE');
  assert.equal(await f.claimLayout(), 'band');
  await hidden(host, WORKER_KEYS, 'after the migration');
  assertArrangedReadiness(run);
  const slot = f.actor.snapshot, published = f.todo.presence.state.snapshot;
  assert.equal(slot.phase, 'READY');
  assert.ok(slot.operations.every(operation => operation.status === 'SETTLED'));
  assert.equal(published.availability, 'waiting');
  for (const role of ['todo', 'dag', 'workers'])
    assert.deepEqual(slot.roles[role].ack, { sequence: published.sequence, painted: true }, role);
  assert.deepEqual(f.todo.bridge.status.masked.sort(), WORKER_KEYS);
  // There is no native Todo to replace: todo-sidebar is never masked.
  assert.deepEqual(host.visible.get('todo-sidebar'), NATIVE_LINES['todo-sidebar']);
  assert.ok(host.history.every(entry => entry.key !== 'todo-sidebar' || entry.shown), 'todo-sidebar never masked');
  startups.push(await ackMismatches(f));
  assert.ok(startups.every(count => count <= 2), `ACK_MISMATCH per startup: ${startups}`);
  assert.deepEqual(f.warnings, []);
  // A branch read that throws still fails closed: every native line returns.
  source.error = new Error('session branch unreadable');
  f.todo.bridge.readinessChanged();
  assert.deepEqual(f.todo.bridge.status.masked, []);
  for (const key of KEYS) assert.deepEqual(host.visible.get(key), NATIVE_LINES[key], `${key} restored on a read error`);
});

test('band_no_todo_unpainted_role_not_masked: at a fresh band startup without a native Todo, a role that never painted keeps every native line shown; its paint then masks omo-task and omo-dag', async t => {
  const { f, host, viewers, seen } = await open(t, { branch: NO_TODO, paints: role => role !== 'dag' });
  // Subscribe before the startup: the latest sequence each role's paint was accepted for.
  const presence = f.todo.presence, acked = new Map();
  presence.events.on('event', event => {
    if (event.type === 'ack') acked.set(event.role, event.sequence);
    seen.emit('change');
  });
  await f.todo.schedule();
  drawNativeLines(host);
  const ids = await f.ids();
  assert.equal(isBandDashboard(f.layout(), ids), true, 'a fresh managed startup opens the band');
  // The todo and workers viewers painted the current waiting frame and presence
  // accepted their paints; the DAG viewer received it and never painted.
  const sequence = () => presence.state.snapshot?.sequence;
  const painted = () => sequence() !== undefined && viewers.get('dag')?.received === sequence() &&
    acked.get('todo') === sequence() && acked.get('workers') === sequence();
  await when(seen, painted, () => `waiting paints not accepted: ${JSON.stringify({ sequence: sequence(),
    received: viewers.get('dag')?.received, acked: [...acked] })}`);
  await f.todo.managedIdle();
  await f.todo.roleTail;
  assert.ok(painted(), 'no newer publication');
  assert.equal(presence.state.snapshot.availability, 'waiting');
  for (const role of ['todo', 'workers'])
    assert.deepEqual(f.actor.snapshot.roles[role].ack, { sequence: sequence(), painted: true }, role);
  assert.notEqual(f.actor.snapshot.roles.dag.ack?.painted, true, 'the DAG never painted');
  assert.notEqual(f.actor.snapshot.phase, 'READY');
  assert.deepEqual(f.todo.bridge.status.masked, []);
  for (const key of KEYS) assert.deepEqual(host.visible.get(key), NATIVE_LINES[key], `${key} shown`);
  // The DAG viewer paints the frame it received: only the worker and DAG lines are masked.
  const masked = hidden(host, WORKER_KEYS, 'after the DAG paint');
  viewers.get('dag').paintAgain();
  await masked;
  await f.todo.managedIdle();
  assert.equal(f.actor.snapshot.phase, 'READY');
  assert.deepEqual(f.actor.snapshot.roles.dag.ack, { sequence: sequence(), painted: true });
  assert.deepEqual(f.todo.bridge.status.masked.sort(), WORKER_KEYS);
  assert.deepEqual(host.visible.get('todo-sidebar'), NATIVE_LINES['todo-sidebar']);
  assert.deepEqual(f.warnings, []);
});
