import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TodoPane } from '../src/controller.mjs';
import { claimParentSlot } from '../src/parent-slot.mjs';

const recoveryAwaits = /recovery awaits/;
const ackMismatch = () => Object.assign(new Error('ACK_MISMATCH'), { code: 'ACK_MISMATCH', inlineFallback: true });

// The fake exposes only the actor fields the controller reads for managed
// authority. Its health is mutable so a test can block and heal it.
function fakeActor(state = {}) {
  return { leaseHeld: true, blocked: false, draining: false, phase: 'READY', acks: [], diagnosed: [],
    ackError: ackMismatch, ...state,
    get snapshot() {
      return { phase: this.phase, operations: [], closures: [], participants: {},
        roles: { todo: { role: 'todo', paneId: 'qa:todo', statePath: 'todo.json', launchToken: 'launch',
          controlToken: 'control', generation: 1, sessionId: 'session', ack: null } } };
    },
    capability: (participant, role) => ({ participant, role }),
    ackRole(message) { this.acks.push(message.sequence); return Promise.reject(this.ackError(message)); },
    diagnose(branch, error) { this.diagnosed.push({ branch, code: error?.code }); return Promise.resolve(); } };
}
const unavailable = { blocked: { blocked: true, phase: 'BLOCKED' }, draining: { draining: true, phase: 'DRAINING' },
  'lease-lost': { leaseHeld: false } };
const heal = actor => Object.assign(actor, { leaseHeld: true, blocked: false, draining: false, phase: 'READY' });

async function fixture(t, actor) {
  const directory = await mkdtemp(join(tmpdir(), 'todo-warnings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const notices = [];
  let arrived = () => {};
  const todo = new TodoPane({ managed: true, stateDir: directory, cwd: directory,
    environment: { HERDR_SOCKET_PATH: 'qa:socket', HERDR_PANE_ID: 'qa:parent' },
    ctx: { sessionManager: { getSessionId: () => 'session', getSessionFile: () => join(directory, 'source.jsonl') } },
    herdr: async (...args) => { throw new Error(`unexpected native command ${args[0]}`); },
    notify: message => { notices.push(message); arrived(message); } });
  todo.actor = actor;
  todo.status = 'current';
  todo.bridge = { readinessChanged() {}, invalidate() {} };
  todo.presence = { getOwner: () => ({}), isReady: () => true };
  // A membership subscription needs a live Herdr; the latch under test does not.
  todo.watchRecoveryMembership = async () => {};
  const retries = [];
  const reconcileLegacy = todo.reconcileLegacy.bind(todo);
  todo.reconcileLegacy = (...args) => { retries.push(todo.recoveryRetry); return reconcileLegacy(...args); };
  // Subscribe before triggering: resolves when the named notification is delivered.
  const notice = message => new Promise(resolve => { arrived = value => { if (value === message) resolve(); }; });
  return { todo, notices, retries, notice };
}

test('stale paint ACK_MISMATCH rejections neither warn, latch recovery nor change status', { timeout: 10000 }, async t => {
  const actor = fakeActor({ ackError: message => message.sequence === 5 ? new Error('sentinel failure') : ackMismatch() });
  const f = await fixture(t, actor);
  await assert.rejects(f.todo.managedWrite(current => current.ackRole({ sequence: 1 })), { code: 'ACK_MISMATCH' });
  assert.equal(Boolean(f.todo.recoveryBlocked), false);
  assert.equal(f.todo.status, 'current');
  // A restart burst of three stale paints; a later code-less failure is the delivery sentinel.
  for (const sequence of [2, 3, 4]) f.todo.paintManaged({ role: 'todo', sequence });
  const sentinel = f.notice('sentinel failure');
  f.todo.paintManaged({ role: 'todo', sequence: 5 });
  await sentinel;
  assert.deepEqual(f.notices, ['sentinel failure']);
  assert.deepEqual(actor.acks, [1, 2, 3, 4, 5], 'each paint retried against a fresh read');
  assert.equal(Boolean(f.todo.recoveryBlocked), false);
  assert.equal(f.todo.status, 'current');
  assert.deepEqual(actor.diagnosed.map(entry => entry.code),
    ['ACK_MISMATCH', 'ACK_MISMATCH', 'ACK_MISMATCH', 'ACK_MISMATCH', undefined]);
});

test('a healthy READY actor stays unlatched and quiet after one code-less managed-write error', async t => {
  const f = await fixture(t, fakeActor());
  await assert.rejects(f.todo.managedWrite(async () => { throw new Error('transient native read failure'); }));
  assert.equal(Boolean(f.todo.recoveryBlocked), false);
  for (let update = 0; update < 2; update++) await f.todo.schedule();
  assert.deepEqual(f.notices, []);
  assert.equal(Boolean(f.todo.recoveryBlocked), false);
  assert.deepEqual(f.retries, [false, false]);
});

for (const [failure, state] of Object.entries(unavailable))
  test(`a ${failure} actor stays latched and warns exactly once across schedules and paint heartbeats`,
    { timeout: 10000 }, async t => {
      const actor = fakeActor({ ...state, ackError: () => new Error('sentinel failure') });
      const f = await fixture(t, actor);
      const write = await f.todo.managedWrite(async () => {}).then(() => null, error => error);
      for (let update = 0; update < 3; update++) await assert.rejects(f.todo.schedule(), recoveryAwaits);
      assert.equal(f.notices.length, 1);
      assert.match(f.notices[0], recoveryAwaits);
      assert.equal(f.todo.recoveryBlocked, true);
      assert.equal(f.todo.status, 'BLOCKED');
      assert.deepEqual(f.retries, []);
      assert.equal(write?.code, 'MANAGED_UNAVAILABLE');
      // Viewer ACK heartbeats keep arriving while the actor is unavailable.
      for (let sequence = 1; sequence <= 5; sequence++) f.todo.paintManaged({ role: 'todo', sequence });
      await f.todo.managedIdle();
      heal(actor);
      const sentinel = f.notice('sentinel failure');
      f.todo.paintManaged({ role: 'todo', sequence: 6 });
      await sentinel;
      assert.deepEqual(f.notices.slice(1), ['sentinel failure']);
      assert.deepEqual(actor.diagnosed.map(entry => entry.code), ['MANAGED_UNAVAILABLE', undefined],
        'one unavailable actor writes one diagnostic line');
    });

test('a latch left on a healed actor clears and retries once; blocking again latches and warns once', async t => {
  const actor = fakeActor(unavailable.blocked);
  const f = await fixture(t, actor);
  await f.todo.managedWrite(async () => {}).catch(() => {});
  await assert.rejects(f.todo.schedule(), recoveryAwaits);
  assert.equal(f.notices.length, 1);
  heal(actor);
  await f.todo.schedule();
  assert.equal(Boolean(f.todo.recoveryBlocked), false);
  assert.deepEqual(f.retries, [true], 'the stale latch is retried exactly once');
  await f.todo.schedule();
  assert.deepEqual(f.retries, [true, false], 'later updates are ordinary passes');
  assert.equal(f.notices.length, 1);
  Object.assign(actor, unavailable.blocked);
  for (let update = 0; update < 3; update++) await assert.rejects(f.todo.schedule());
  assert.equal(f.todo.recoveryBlocked, true);
  assert.equal(f.notices.length, 2, 'the new latch warns once');
  assert.deepEqual(f.retries, [true, false]);
});

test('three consecutive real failures and recoveries warn once per latch without duplicates', async t => {
  const actor = fakeActor();
  const f = await fixture(t, actor);
  for (let cycle = 1; cycle <= 3; cycle++) {
    Object.assign(actor, unavailable.blocked);
    for (let update = 0; update < 3; update++) await assert.rejects(f.todo.schedule());
    assert.equal(f.todo.recoveryBlocked, true);
    assert.equal(f.notices.length, cycle);
    heal(actor);
    for (let update = 0; update < 2; update++) await f.todo.schedule();
    assert.equal(Boolean(f.todo.recoveryBlocked), false);
    assert.equal(f.notices.length, cycle);
  }
  assert.deepEqual(f.retries, [true, false, true, false, true, false]);
});

test('explicit /dashboard on a blocked actor still reports its failure after the automatic warning', async t => {
  const f = await fixture(t, fakeActor(unavailable.blocked));
  for (let update = 0; update < 2; update++) await assert.rejects(f.todo.schedule());
  assert.equal(f.notices.length, 1);
  await assert.rejects(f.todo.schedule({ forceRoles: ['dag', 'workers', 'todo'] }));
  assert.equal(f.notices.length, 2);
  assert.equal(f.notices[1], f.notices[0]);
  assert.equal(f.todo.recoveryBlocked, true);
});

async function realActor(t) {
  const root = await mkdtemp(join(tmpdir(), 'todo-warnings-slot-'));
  const socketPath = join(root, 'socket');
  await writeFile(socketPath, '');
  const parent = { paneId: 'parent', tabId: 'tab', shell: { pid: 101, birth: 'parent-birth' } };
  const producer = { pid: 202, birth: 'producer-birth', executable: 'node', argvDigest: 'a'.repeat(64) };
  const actor = await claimParentSlot({ stateDir: root, socketPath, parent, producer, sessionId: 'session',
    observe: async ({ target }) => ({ parent, producer, target }) });
  t.after(async () => {
    if (actor.db.isOpen) { if (actor.db.isTransaction) actor.db.exec('ROLLBACK'); actor.db.close(); }
    await rm(root, { recursive: true, force: true });
  });
  await actor.join('todo', 'lifetime');
  const record = { paneId: 'role-pane', tabId: 'tab', shell: { pid: 303, birth: 'role-birth' }, viewer: producer,
    statePath: join(root, 'state.json'), sourcePath: join(root, 'source.json'), cachePath: join(root, 'cache.json'),
    prefsPath: join(root, 'prefs.json'), launchToken: 'launch-secret', controlToken: 'control-secret' };
  await actor.registerRole(actor.capability('todo', 'todo'), record);
  const path = join(actor.paths.directory, 'blocked-diagnostics.jsonl');
  const lines = async () => {
    await actor.diagnostics;
    return (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      .filter(entry => entry.branch === 'controller-write');
  };
  return { actor, record, lines, path };
}

test('an unavailable actor is diagnosed as MANAGED_UNAVAILABLE once for twenty queued writes', async t => {
  const { actor, record, lines } = await realActor(t);
  await assert.rejects(actor.perform(actor.capability('todo', 'todo'), { type: 'arrange', target: record },
    async () => { throw new Error('placement response lost'); }), { code: 'EFFECT_UNKNOWN' });
  assert.equal(actor.blocked, true);
  const f = await fixture(t, actor);
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => f.todo.managedWrite(async () => {})));
  assert.deepEqual((await lines()).map(entry => entry.code), ['MANAGED_UNAVAILABLE']);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'MANAGED_UNAVAILABLE'));
  assert.equal(f.todo.recoveryBlocked, true);
});

test('a rejected paint ACK is diagnosed with the condition that failed and writes nothing', async t => {
  const { actor, record, lines, path } = await realActor(t);
  const f = await fixture(t, actor);
  const ack = overrides => f.todo.managedWrite(current => current.ackRole({ ...current.capability('todo', 'todo'),
    paneId: record.paneId, statePath: record.statePath, launchToken: record.launchToken,
    controlToken: record.controlToken, painted: true, sequence: 1, ...overrides }));
  await ack();
  await assert.rejects(ack(), { code: 'ACK_MISMATCH', reason: 'sequence-stale' });
  await assert.rejects(ack({ sequence: 2, launchToken: 'replaced-launch' }), { code: 'ACK_MISMATCH', reason: 'launchToken' });
  await assert.rejects(ack({ sequence: 2, painted: false }), { code: 'ACK_MISMATCH', reason: 'painted' });
  assert.deepEqual((await lines()).map(entry => [entry.code, entry.reason]),
    [['ACK_MISMATCH', 'sequence-stale'], ['ACK_MISMATCH', 'launchToken'], ['ACK_MISMATCH', 'painted']]);
  assert.doesNotMatch(await readFile(path, 'utf8'), /secret|replaced-launch/);
  assert.deepEqual(actor.snapshot.roles.todo.ack, { sequence: 1, painted: true }, 'rejections publish nothing');
  assert.equal(Boolean(f.todo.recoveryBlocked), false);
  assert.equal(f.todo.status, 'current');
});
