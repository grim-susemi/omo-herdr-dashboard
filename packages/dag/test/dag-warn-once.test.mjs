import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DagPane, FixedDagPane } from '../src/controller.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'omo-dag-warn-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const notices = [];
  const pane = new DagPane({ sessionId: 'warn-once', parentPane: 'qa:parent', socket: 'qa:socket',
    stateDir: join(root, 'state'), cwd: root, taskStateDir: join(root, 'tasks'), herdr: async () => ({}),
    notify: message => notices.push(message) });
  const fail = (message, options) => pane.enqueue(async () => { throw new Error(message); }, options).catch(() => {});
  const succeed = () => pane.enqueue(async () => {});
  return { pane, notices, fail, succeed };
}

test('the same failing job three times notifies once', async t => {
  const { notices, fail } = await setup(t);
  for (let i = 0; i < 3; i++) await fail('layout-waiting: gate');
  assert.deepEqual(notices, ['DAG pane: layout-waiting: gate']);
});

test('a success, then the same failure, notifies again', async t => {
  const { notices, fail, succeed } = await setup(t);
  await fail('layout-waiting: gate');
  await fail('layout-waiting: gate');
  await succeed();
  await fail('layout-waiting: gate');
  await fail('layout-waiting: gate');
  assert.equal(notices.length, 2);
  assert.equal(new Set(notices).size, 1);
});

test('a different message notifies and alternating messages notify on every change', async t => {
  const { notices, fail } = await setup(t);
  for (const message of ['one', 'one', 'two', 'two', 'one', 'two']) await fail(message);
  assert.deepEqual(notices, ['one', 'two', 'one', 'two'].map(message => `DAG pane: ${message}`));
});

test('an explicit force call notifies every time', async t => {
  const { notices, fail } = await setup(t);
  await fail('layout-waiting: gate');
  for (let i = 0; i < 3; i++) await fail('layout-waiting: gate', { force: true });
  assert.equal(notices.length, 4);
});

test('repeated fail, succeed, fail cycles notify once per failure run', async t => {
  const { notices, fail, succeed } = await setup(t);
  for (let cycle = 0; cycle < 3; cycle++) {
    await fail('layout-waiting: gate');
    await fail('layout-waiting: gate');
    await succeed();
  }
  assert.equal(notices.length, 3);
});

// open() is what the registered /dashboard handler awaits (packages/dag/extension.mjs).
async function setupFixed(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'omo-dag-warn-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const notices = [];
  const pane = new FixedDagPane({ sessionId: 'warn-open', parentPane: 'qa:parent', socket: 'qa:socket',
    stateDir: join(root, 'state'), cwd: root, taskStateDir: join(root, 'tasks'),
    notify: message => notices.push(message), ...options });
  return { pane, notices };
}

for (const [gate, options] of [
  ['managed coordinator unavailable', { managedAvailable: true, herdr: async () => ({}) }],
  ['layout gate in openPair', { herdr: async () => { throw new Error('layout-waiting: gate'); } }],
]) test(`/dashboard open() reports every time after an automatic warning: ${gate}`, async t => {
  const { pane, notices } = await setupFixed(t, options);
  for (let i = 0; i < 3; i++) await pane.openPair().catch(() => {});
  assert.equal(notices.length, 1, 'automatic path notifies once');
  for (let i = 0; i < 3; i++) await pane.open().catch(() => {});
  assert.equal(notices.length, 4, 'each explicit open notifies');
  assert.equal(new Set(notices).size, 1, 'the same gate produced the same message');
});
