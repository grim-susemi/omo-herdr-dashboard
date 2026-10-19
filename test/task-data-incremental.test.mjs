import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskData } from '../packages/dag/src/task-data.mjs';
import { writeJson } from '../packages/dag/src/storage.mjs';

const sessionId = 'parent-session';
const record = (task_id, extra = {}) => ({ task_id, parent_session_id: sessionId,
  status: 'running', created_at: '2026-09-06T00:00:00Z', updated_at: '2026-09-06T00:00:01Z', ...extra });

async function setup(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'dag-incremental-'));
  const stateDir = join(cwd, '.omo', 'senpi-task');
  const directory = join(stateDir, 'tasks');
  let reads = 0;
  const read = async path => { reads++; return JSON.parse(await readFile(path, 'utf8')); };
  const data = new TaskData({ cwd, sessionId, read, notify: () => {} });
  t.after(async () => { data.stop(); await rm(cwd, { recursive: true, force: true }); });
  const put = async (value, tick) => {
    const path = join(directory, `${value.task_id}.json`);
    await writeJson(path, value);
    if (tick !== undefined) await utimes(path, new Date(tick), new Date(tick));
  };
  return { cwd, stateDir, directory, data, put, reads: () => reads };
}

test('a changed record reads once; tmp, duplicate and filename-less events follow the batch rules', async t => {
  const { data, put, reads } = await setup(t);
  await put(record('st_a'));
  await put(record('st_b'));
  await data.refresh();
  assert.equal(reads(), 2);

  let before = reads();
  await put(record('st_a', { description: 'A2' }), 1700000001000);
  await data.refreshChanged(['st_a.json']);
  assert.equal(reads() - before, 1);

  before = reads();
  await data.refreshChanged(['st_a.json.0000.tmp']);
  assert.equal(reads() - before, 0);

  before = reads();
  await put(record('st_a', { description: 'A3' }), 1700000002000);
  await data.refreshChanged(['st_a.json', 'st_a.json']);
  assert.equal(reads() - before, 1);

  before = reads();
  await data.refreshChanged([undefined]);
  assert.equal(reads() - before, 2, 'a filename-less event reads the whole store');
});

test('a foreign record is read once, then only marked dirty and never merged', async t => {
  const { data, put, reads } = await setup(t);
  await put(record('st_foreign', { parent_session_id: 'foreign-session', description: 'v1' }));
  let before = reads();
  await data.refreshChanged(['st_foreign.json']);
  assert.equal(reads() - before, 1);
  assert.deepEqual(data.snapshot(), []);

  before = reads();
  await put(record('st_foreign', { parent_session_id: 'foreign-session', description: 'v2' }), 1700000100000);
  await data.refreshChanged(['st_foreign.json']);
  assert.equal(reads() - before, 0, 'later foreign events only set dirty');
  assert.deepEqual(data.snapshot(), []);
});

test('a child that arrives before its parent links is promoted and shows its latest content', async t => {
  const { data, put } = await setup(t);
  await put(record('st_child', { parent_session_id: 'child-session', description: 'child v1' }));
  await data.refreshChanged(['st_child.json']);
  assert.deepEqual(data.snapshot(), []);

  await put(record('st_child', { parent_session_id: 'child-session', description: 'child v2' }), 1700000200000);
  await data.refreshChanged(['st_child.json']);
  assert.deepEqual(data.snapshot(), []);

  await put(record('st_parent', { description: 'parent', child_session_id: 'child-session' }));
  await data.refreshChanged(['st_parent.json']);
  const tasks = data.snapshot();
  assert.deepEqual(tasks.map(task => task.id).sort(), ['st_child', 'st_parent']);
  assert.equal(tasks.find(task => task.id === 'st_child').description, 'child v2');
  assert.equal(tasks.find(task => task.id === 'st_child').parentTaskId, 'st_parent');
  assert.equal(data.foreign.size, 0);
});

test('a full refresh re-reads records and refreshes their stat signatures', async t => {
  const { data, put, reads } = await setup(t);
  await put(record('st_a'));
  await data.refresh();
  let before = reads();
  await data.refresh();
  assert.equal(reads() - before, 1, 'full refresh reads every record');
  before = reads();
  await data.refreshChanged(['st_a.json']);
  assert.equal(reads() - before, 0, 'the full refresh stored the current signature');
});
