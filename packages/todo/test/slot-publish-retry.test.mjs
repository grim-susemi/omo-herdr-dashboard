import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TodoPane } from '../src/controller.mjs';
import { claimParentSlot } from '../src/parent-slot.mjs';

// Windows denies replacing slot.json while any reader holds it open; the
// retry is win32-only, so elsewhere one denial still blocks the actor.
const win32 = process.platform === 'win32';
const parent = { paneId: 'parent', tabId: 'tab', shell: { pid: 101, birth: 'parent-birth' } };
const producer = { pid: 202, birth: 'producer-birth', executable: 'node', argvDigest: 'a'.repeat(64) };
const owner = role => role === 'todo' ? 'todo' : 'dag';
const denial = code => Object.assign(new Error(`${code}: rename denied`), { code });

// A READY actor (three painted roles) whose slot renames pass until a fault is
// armed; `renames` records every attempt after arming and `waits` each backoff.
async function readyActor(t) {
  const root = await filesystem.mkdtemp(join(tmpdir(), 'todo-publish-retry-'));
  const socketPath = join(root, 'socket');
  await filesystem.writeFile(socketPath, '');
  const renames = [], waits = [];
  let fault = null;
  const fs = { ...filesystem, rename: async (from, to) => {
    if (fault) {
      const error = fault(renames.length);
      renames.push(error?.code ?? 'ok');
      if (error) throw error;
    }
    return filesystem.rename(from, to);
  } };
  const actor = await claimParentSlot({ stateDir: root, socketPath, parent, producer, sessionId: 'session', fs,
    delay: async ms => { waits.push(ms); }, observe: async ({ target }) => ({ parent, producer, target }) });
  t.after(async () => {
    if (actor.db.isOpen) { if (actor.db.isTransaction) actor.db.exec('ROLLBACK'); actor.db.close(); }
    await filesystem.rm(root, { recursive: true, force: true });
  });
  await actor.join('todo', 'todo-lifetime');
  await actor.join('dag', 'dag-lifetime');
  const roles = {};
  for (const [index, role] of ['todo', 'dag', 'workers'].entries()) {
    roles[role] = { paneId: `${role}-pane`, tabId: 'tab', shell: { pid: 300 + index, birth: `${role}-birth` },
      viewer: producer, statePath: join(root, `${role}-state.json`), sourcePath: join(root, `${role}-source.json`),
      cachePath: join(root, `${role}-cache.json`), prefsPath: join(root, `${role}-prefs.json`),
      launchToken: `${role}-launch`, controlToken: `${role}-control` };
    await actor.registerRole(actor.capability(owner(role), role), roles[role]);
  }
  for (const [role, record] of Object.entries(roles)) await actor.ackRole({ ...actor.capability(owner(role), role),
    paneId: record.paneId, statePath: record.statePath, launchToken: record.launchToken,
    controlToken: record.controlToken, painted: true, sequence: 1 });
  await actor.ready();
  assert.equal(actor.snapshot.phase, 'READY');
  const notices = [];
  const todo = new TodoPane({ managed: true, stateDir: join(root, 'todo'), cwd: root,
    environment: { HERDR_SOCKET_PATH: 'qa:socket', HERDR_PANE_ID: 'qa:parent' },
    ctx: { sessionManager: { getSessionId: () => 'session', getSessionFile: () => join(root, 'source.jsonl') } },
    herdr: async (...args) => { throw new Error(`unexpected native command ${args[0]}`); },
    notify: message => notices.push(message) });
  Object.assign(todo, { actor, status: 'current', bridge: { readinessChanged() {}, invalidate() {} },
    presence: { getOwner: () => ({}), isReady: () => true }, watchRecoveryMembership: async () => {} });
  const diagnostics = async () => {
    await actor.diagnostics;
    const bytes = await filesystem.readFile(join(actor.paths.directory, 'blocked-diagnostics.jsonl'), 'utf8')
      .catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    return bytes.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).map(entry => [entry.branch, entry.code]);
  };
  return { actor, roles, todo, notices, renames, waits, diagnostics, arm: next => { fault = next; } };
}

// Each Todo update reaches the slot as the viewer's paint ACK. A write counts
// as recorded only when slot.json on disk carries its sequence afterwards.
async function todoUpdates(f, count) {
  let recorded = 0, sequence = f.actor.snapshot.roles.todo.ack.sequence;
  for (let index = 0; index < count; index++) {
    sequence++;
    f.todo.paintManaged({ role: 'todo', sequence });
    await f.todo.managedIdle();
    // The paint chain reports a failure in microtasks after the write settles.
    await new Promise(resolve => setImmediate(resolve));
    const persisted = JSON.parse(await filesystem.readFile(f.actor.paths.slotPath, 'utf8'));
    if (persisted.roles.todo.ack?.sequence === sequence) recorded++;
  }
  return recorded;
}

const unavailable = error => error?.code === 'MANAGED_UNAVAILABLE' && error.message.startsWith('BLOCKED: ') &&
  error.message.includes('/dashboard');

test('one transient EPERM slot rename keeps the actor READY and twenty later Todo writes pass', async t => {
  const f = await readyActor(t);
  f.arm(index => index === 0 ? denial('EPERM') : null);
  const recorded = await todoUpdates(f, 21);
  if (!win32) {
    assert.equal(f.actor.blocked, true);
    assert.equal(recorded, 0);
    return;
  }
  assert.equal(recorded, 21);
  assert.deepEqual(f.renames.slice(0, 2), ['EPERM', 'ok']);
  assert.equal(f.renames.length, 22);
  assert.deepEqual(f.waits, [10]);
  assert.equal(f.actor.blocked, false);
  assert.equal(f.actor.snapshot.phase, 'READY');
  assert.equal(JSON.parse(await filesystem.readFile(f.actor.paths.slotPath, 'utf8')).phase, 'READY');
  assert.deepEqual(f.notices, []);
  assert.equal(Boolean(f.todo.recoveryBlocked), false);
  assert.deepEqual(await f.diagnostics(), []);
});

test('three single EPERM denials across twenty Todo writes are each retried once', async t => {
  const f = await readyActor(t);
  // Attempt indexes 0, 7 and 14 fall on the 1st, 7th and 13th update.
  f.arm(index => [0, 7, 14].includes(index) ? denial('EPERM') : null);
  const recorded = await todoUpdates(f, 20);
  if (!win32) return assert.equal(f.actor.blocked, true);
  assert.equal(recorded, 20);
  assert.equal(f.renames.filter(code => code === 'EPERM').length, 3);
  assert.deepEqual(f.waits, [10, 10, 10]);
  assert.equal(f.actor.blocked, false);
  assert.deepEqual(f.notices, []);
});

test('a persistent EPERM is bounded, still blocks and warns exactly once with the owner action', async t => {
  const f = await readyActor(t);
  f.arm(() => denial('EPERM'));
  const recorded = await todoUpdates(f, 20);
  for (let pass = 0; pass < 2; pass++) await assert.rejects(f.todo.schedule(), { code: 'RECOVERY_BLOCKED' });
  assert.equal(recorded, 0);
  assert.equal(f.actor.blocked, true);
  assert.equal(f.renames.length, win32 ? 6 : 1, 'only the first write reaches the rename; it is retried a bounded number of times');
  assert.deepEqual(f.waits, win32 ? [10, 20, 40, 80, 160] : []);
  assert.equal(f.notices.length, 1);
  assert.ok(f.notices[0].startsWith('BLOCKED: ') && f.notices[0].includes('/dashboard'));
  await assert.rejects(f.todo.managedWrite(async () => {}), unavailable);
  assert.equal(f.notices.length, 1);
  assert.deepEqual(await f.diagnostics(), [['publish', 'PUBLISH_FAILED'], ['controller-write', 'PUBLISH_FAILED']]);
});

test('a non-transient rename error is not retried and blocks the actor', async t => {
  const f = await readyActor(t);
  // Fails once only: a retry would succeed, so a block proves there was none.
  f.arm(index => index === 0 ? denial('ENOSPC') : null);
  const recorded = await todoUpdates(f, 20);
  assert.equal(recorded, 0);
  assert.deepEqual(f.renames, ['ENOSPC']);
  assert.deepEqual(f.waits, []);
  assert.equal(f.actor.blocked, true);
  assert.equal(f.notices.length, 1);
  assert.ok(f.notices[0].startsWith('BLOCKED: ') && f.notices[0].includes('/dashboard'));
});

test('a persistent EPERM in a control-path write gives one restart-first warning before any /dashboard', async t => {
  const f = await readyActor(t);
  f.arm(() => denial('EPERM'));
  // The coordinator's closeRole is a managed write whose failure latches recovery silently.
  await assert.rejects(f.todo.coordinator().closeRole('todo', 'todo-pane'), { code: 'PUBLISH_FAILED' });
  assert.deepEqual(f.notices, []);
  for (let pass = 0; pass < 3; pass++) await assert.rejects(f.todo.schedule(), { code: 'RECOVERY_BLOCKED' });
  assert.equal(f.actor.blocked, true);
  assert.ok(f.actor.snapshot.operations.every(operation => operation.status === 'SETTLED'), 'nothing to reconcile');
  assert.equal(f.renames.length, win32 ? 6 : 1);
  assert.equal(f.notices.length, 1, 'exactly one automatic warning');
  const [first] = f.notices;
  assert.ok(first.startsWith('BLOCKED: '));
  const restart = first.indexOf('restart'), dashboard = first.indexOf('/dashboard');
  assert.ok(restart >= 0, 'the first warning names the restart action');
  assert.ok(dashboard === -1 || restart < dashboard, 'the first warning does not lead with /dashboard');
  await assert.rejects(f.todo.schedule({ forceRoles: ['dag', 'workers', 'todo'] }), { code: 'MANAGED_UNAVAILABLE' });
  assert.equal(f.actor.blocked, true);
});

test('a blocked actor with an unresolved operation keeps the reconcilable recovery warning', async t => {
  const f = await readyActor(t);
  await assert.rejects(f.actor.perform(f.actor.capability('todo', 'todo'), { type: 'arrange', target: f.roles.todo },
    async () => { throw new Error('placement response lost'); }), { code: 'EFFECT_UNKNOWN' });
  assert.ok(f.actor.snapshot.operations.some(operation => operation.status === 'UNKNOWN'), 'something to reconcile');
  await assert.rejects(f.todo.managedWrite(async () => {}), { code: 'MANAGED_UNAVAILABLE' });
  await assert.rejects(f.todo.schedule(), { code: 'RECOVERY_BLOCKED' });
  assert.equal(f.notices.length, 1);
  assert.ok(f.notices[0].startsWith('BLOCKED: ') && !f.notices[0].includes('restart'));
});

test('an explicit /dashboard cannot rebuild an actor blocked by a publish failure', async t => {
  const f = await readyActor(t);
  f.arm(() => denial('ENOSPC'));
  await todoUpdates(f, 1);
  assert.equal(f.actor.blocked, true);
  assert.ok(f.actor.snapshot.operations.every(operation => operation.status === 'SETTLED'), 'nothing to reconcile');
  await assert.rejects(f.todo.schedule({ forceRoles: ['dag', 'workers', 'todo'] }), unavailable);
  assert.equal(f.actor.blocked, true);
  assert.equal(f.notices.length, 2, 'the explicit command still gets its answer');
  assert.equal(f.notices[1], f.notices[0]);
});
