import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DagPane, FixedDagPane } from '../packages/dag/src/controller.mjs';
import { readJson, writeJson } from '../packages/dag/src/storage.mjs';

const sessionId = 'session';
const record = (task_id, extra = {}) => ({ task_id, parent_session_id: sessionId,
  status: 'running', created_at: '2026-09-06T00:00:00Z', updated_at: '2026-09-06T00:00:01Z', ...extra });

const herdr = async (...args) => {
  if (args[0] === 'list') return { panes: [{ pane_id: 'p0', tab_id: 'tab' }] };
  if (args[0] === 'split') return { pane: { pane_id: 'pane1' } };
  return {};
};

async function setup(t, { now = () => new Date().toISOString() } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dag-write-'));
  const stateDir = join(root, 'state'), taskStateDir = join(root, 'tasks');
  const directory = join(taskStateDir, 'tasks');
  let reads = 0;
  const read = async path => { reads++; return JSON.parse(await readFile(path, 'utf8')); };
  const writes = [];
  const write = async (path, value) => { writes.push(path); await writeJson(path, value); };
  const saved = new EventEmitter();
  const controller = new DagPane({ sessionId, parentPane: 'p0', socket: 'socket', stateDir, taskStateDir,
    cwd: root, node: 'node', viewer: 'viewer', herdr, read, write, now, streamDelay: 5, notify: () => {} });
  const original = controller.save.bind(controller);
  controller.save = async (connected, mode) => {
    const before = reads;
    const result = await original(connected, mode);
    saved.emit('saved', reads - before);
    return result;
  };
  t.after(async () => { try { await controller.stop(); } catch {} await rm(root, { recursive: true, force: true }); });
  const put = async (value, tick) => {
    const path = join(directory, `${value.task_id}.json`);
    await writeJson(path, value);
    if (tick !== undefined) await utimes(path, new Date(tick), new Date(tick));
  };
  return { root, stateDir, taskStateDir, directory, controller, saved, put, writes,
    reads: () => reads };
}

test('D6 callers read all, changed or no records as observed through the reader', async t => {
  const f = await setup(t);
  await f.put(record('st_a'));
  await f.put(record('st_b'));
  await f.controller.start();
  assert.equal(f.reads(), 2, 'start is a full read');

  let before = f.reads();
  await f.controller.receive({ parent_session_id: sessionId, runs: [] });
  assert.equal(f.reads(), before, 'receive reads no task record');

  before = f.reads();
  await f.controller.receiveTasks({ parent_session_id: sessionId, tasks: [record('st_c')] });
  assert.equal(f.reads(), before, 'receiveTasks merges the payload only');
  assert.ok((await readJson(f.controller.stateFile)).tasks.some(task => task.id === 'st_c'));

  before = f.reads();
  await f.controller.receiveStream({ taskId: 'st_c', active: true, phase: 'text', text: 'TOKEN', now: 1 });
  assert.equal(f.reads(), before, 'receiveStream reads no task record');

  before = f.reads();
  await f.controller.open();
  assert.equal(f.reads() - before, 2, 'open is a full read');

  const changedRead = new Promise(resolve => {
    const listener = delta => {
      if (delta === 1) { f.saved.off('saved', listener); resolve(); }
    };
    f.saved.on('saved', listener);
  });
  await f.put(record('st_a', { description: 'A2' }), 1700000300000);
  await changedRead;
  assert.equal(f.reads(), 5, 'the watcher reads only the changed record');

  // No later watcher event may blur the read count of stop.
  f.controller.taskData.stop();
  await f.controller.queue;
  before = f.reads();
  await f.controller.stop();
  assert.equal(f.reads(), before, 'stop reads no task record');
});

test('fixed save advances updatedAt only on content change and skips identical writes', async t => {
  let tick = 0;
  const f = await setup(t, { now: () => new Date(++tick * 1000).toISOString() });
  await f.put(record('st_a'));
  await f.controller.start();
  const stateWrites = () => f.writes.filter(path => path === f.controller.stateFile).length;
  assert.equal(stateWrites(), 1);
  await f.controller.save(false, 'none');
  assert.equal(stateWrites(), 2, 'the connected flag change is a real write');
  const first = await readJson(f.controller.stateFile);

  await f.controller.save(false, 'none');
  assert.equal(stateWrites(), 2, 'an unchanged save writes no state file');
  assert.equal((await readJson(f.controller.stateFile)).updatedAt, first.updatedAt);

  await f.controller.receiveTasks({ parent_session_id: sessionId,
    tasks: [record('st_a', { description: 'changed' })] });
  assert.equal(stateWrites(), 3);
  assert.notEqual((await readJson(f.controller.stateFile)).updatedAt, first.updatedAt);
});

test('managed save writes state, pane and role files only when their content changes', async t => {
  let tick = 0;
  const root = await mkdtemp(join(tmpdir(), 'dag-managed-write-'));
  const writes = [];
  const write = async (path, value) => { writes.push(path); await writeJson(path, value); };
  const controller = new FixedDagPane({ sessionId, parentPane: 'p0', socket: 'socket',
    stateDir: join(root, 'state'), cwd: root, node: 'node', viewer: 'viewer', herdr,
    write, now: () => new Date(++tick * 1000).toISOString() });
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  controller.records.set('dag', { role: 'dag', paneId: 'pane1', tabId: 'tab', launchToken: 'token' });
  const statePath = controller.stateFile, panePath = controller.paneFile('dag'), rolePath = controller.roleFile('dag');
  const count = path => writes.filter(value => value === path).length;

  await controller.save(false, 'none');
  assert.deepEqual([count(statePath), count(panePath), count(rolePath)], [1, 1, 1]);
  const updatedAt = (await readJson(statePath)).updatedAt;

  await controller.save(false, 'none');
  assert.deepEqual([count(statePath), count(panePath), count(rolePath)], [1, 1, 1]);
  assert.equal((await readJson(statePath)).updatedAt, updatedAt);

  controller.records.set('dag', { role: 'dag', paneId: 'pane1', tabId: 'tab2', launchToken: 'token' });
  await controller.save(false, 'none');
  assert.deepEqual([count(statePath), count(panePath), count(rolePath)], [1, 2, 2],
    'only the changed pane and role content is rewritten');
  assert.equal((await readJson(statePath)).updatedAt, updatedAt);
});
