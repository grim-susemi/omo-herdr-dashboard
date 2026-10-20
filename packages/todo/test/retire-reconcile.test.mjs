import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimParentSlot } from '../src/parent-slot.mjs';

const parent = { paneId: 'parent', tabId: 'tab', shell: { pid: 101, birth: 'parent-birth' } };
const producer = { pid: 202, birth: 'producer-birth', executable: 'node', argvDigest: 'a'.repeat(64) };
const owner = role => role === 'todo' ? 'todo' : 'dag';

// A READY actor whose observation reports every target unchanged and never
// records an effect: the shape of a retire/run whose native effect never ran.
async function readyActor(t) {
  const root = await filesystem.mkdtemp(join(tmpdir(), 'todo-retire-reconcile-'));
  const socketPath = join(root, 'socket');
  await filesystem.writeFile(socketPath, '');
  const actor = await claimParentSlot({ stateDir: root, socketPath, parent, producer, sessionId: 'session',
    delay: async () => {}, observe: async ({ target }) => ({ parent, producer, target }) });
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
  return { actor, roles };
}

// Drives a dispatch that throws before any effect: the actor latches the
// operation UNKNOWN and blocks, exactly as the three stuck sessions did.
async function latch(actor, roles, type) {
  await assert.rejects(actor.perform(actor.capability('todo', 'todo'), { type, target: roles.todo },
    async () => { throw new Error('dispatch refused before any native effect'); }), { code: 'EFFECT_UNKNOWN' });
  const operation = actor.snapshot.operations.find(op => op.type === type);
  assert.equal(operation.status, 'UNKNOWN');
  assert.equal(actor.blocked, true);
  return operation;
}

test('a retire whose target is unchanged and recorded no effect settles instead of latching forever', async t => {
  const { actor, roles } = await readyActor(t);
  const operation = await latch(actor, roles, 'retire');
  await actor.reconcile(operation.id);
  assert.equal(actor.snapshot.operations.find(op => op.id === operation.id).status, 'SETTLED');
  assert.equal(actor.blocked, false);
  assert.notEqual(actor.snapshot.phase, 'BLOCKED');
});

test('an unchanged run target with no recorded effect still stays unknown (negative control)', async t => {
  const { actor, roles } = await readyActor(t);
  const operation = await latch(actor, roles, 'run');
  await assert.rejects(actor.reconcile(operation.id), { code: 'EFFECT_UNKNOWN' });
  assert.equal(actor.snapshot.operations.find(op => op.id === operation.id).status, 'UNKNOWN');
  assert.equal(actor.blocked, true);
});
