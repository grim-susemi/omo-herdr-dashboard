import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DagPane, herdrRead, freshReads, bumpProcessQueryEpoch } from '../packages/dag/src/controller.mjs';
import { TodoPane, bumpProcessQueryEpoch as todoBump } from '../packages/todo/src/controller.mjs';

function fake() {
  let spawns = 0;
  const fn = async (...args) => {
    spawns++;
    return args[0] === 'list' ? { panes: [] } : { process_info: {} };
  };
  return { fn, spawns: () => spawns };
}

test('concurrent and repeated list/process-info calls share one spawn until the TTL or the shared epoch', async () => {
  let now = 0;
  const f = fake();
  const read = herdrRead(f.fn, { now: () => now });
  await Promise.all(Array.from({ length: 10 }, () => read('list')));
  assert.equal(f.spawns(), 1, '10 concurrent list calls spawn once');
  await read('list');
  assert.equal(f.spawns(), 1, 'a repeat within 1000 ms spawns nothing');
  await Promise.all(Array.from({ length: 10 }, () => read('process-info', '--pane', 'p1')));
  assert.equal(f.spawns(), 2, 'process-info has its own key');
  await read('process-info', '--pane', 'p1');
  assert.equal(f.spawns(), 2);
  now = 999;
  await read('list');
  assert.equal(f.spawns(), 2);
  now = 1000;
  await read('list');
  assert.equal(f.spawns(), 3, 'the entry expires at 1000 ms');
  todoBump();
  await read('list');
  assert.equal(f.spawns(), 4, 'a Todo-side epoch bump clears the DAG cache');
  bumpProcessQueryEpoch();
  await read('list');
  assert.equal(f.spawns(), 5);
});

test('freshReads bypasses the cache for every call', async () => {
  let now = 0;
  const f = fake();
  const read = herdrRead(f.fn, { now: () => now });
  await Promise.all(Array.from({ length: 10 }, () => freshReads(() => read('list'))));
  assert.equal(f.spawns(), 10, 'every fresh call spawns once');
});

test('layout, get and mutating verbs are never cached, and a mutation clears list entries', async () => {
  let now = 0;
  const f = fake();
  const read = herdrRead(f.fn, { now: () => now });
  for (const args of [['layout', '--pane', 'p'], ['get', 'p']]) {
    await read(...args);
    await read(...args);
  }
  assert.equal(f.spawns(), 4);
  await read('list');
  await read('list');
  assert.equal(f.spawns(), 5);
  await read('split', '--pane', 'p');
  await read('split', '--pane', 'p');
  assert.equal(f.spawns(), 7);
  await read('list');
  assert.equal(f.spawns(), 8, 'the split mutation invalidated the cached list');
});

test('both controllers route list and process-info through the shared cache', async t => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-cache-'));
  const dag = fake();
  const dagController = new DagPane({ sessionId: 's', parentPane: 'p0', socket: 'sock', stateDir: root,
    cwd: root, node: 'node', viewer: 'viewer', herdr: dag.fn, cacheReads: true });
  t.after(async () => {
    await dagController.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all(Array.from({ length: 10 }, () => dagController.herdr('list')));
  assert.equal(dag.spawns(), 1);
  await dagController.herdr('process-info', '--pane', 'p');
  await dagController.herdr('process-info', '--pane', 'p');
  assert.equal(dag.spawns(), 2);

  const todo = fake();
  const todoController = new TodoPane({ ctx: { sessionManager: { getSessionId: () => 's' } },
    environment: { HERDR_SOCKET_PATH: 'sock', HERDR_PANE_ID: 'p0' },
    stateDir: join(root, 'todo'), cwd: root, node: 'node', viewer: 'viewer', herdr: todo.fn, cacheReads: true });
  await Promise.all(Array.from({ length: 10 }, () => todoController.herdr('list')));
  assert.equal(todo.spawns(), 1);
  todoBump();
  await dagController.herdr('list');
  assert.equal(dag.spawns(), 3, 'the Todo epoch clears the DAG controller cache');
});
