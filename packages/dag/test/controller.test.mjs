import { test } from 'node:test';
import { EventEmitter, once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DagPane, FixedDagPane, dagTitle, isDagViewerPane, queryShellProcesses, cachedProcessQuery, observeLegacyCollab, bumpProcessQueryEpoch } from '../src/controller.mjs';
import { RECOVERY_V1 } from '../../coordination/src/recovery.mjs';
import { readJson, writeJson } from '../src/storage.mjs';
import { payload, sessionId } from './fixtures.mjs';
import { normalizeRun } from '../src/model.mjs';

async function setup(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'omo-dag-test-'));
  const controllers = new Set();
  t.after(async () => {
    for (const controller of controllers) await controller.stop();
    await rm(stateDir, { recursive: true, force: true });
  });
  const calls = [], panes = new Set();
  let number = 0;
  const herdr = async (...args) => {
    calls.push(args);
    if (args[0] === 'split') { const pane_id = `test:p${++number}`; panes.add(pane_id); return { pane: { pane_id } }; }
    if (args[0] === 'get' && !panes.has(args[1])) throw new Error('pane_not_found');
    if (args[0] === 'list') return { panes: [
      { pane_id: options.parentPane, tab_id: 'tab0', label: 'OmO' },
      ...[...panes].map(pane_id => ({ pane_id, tab_id: 'tab0', label: dagTitle(sessionId) })),
    ] };
    if (args[0] === 'close') {
      if (!panes.has(args[1])) throw new Error('pane_not_found');
      panes.delete(args[1]);
    }
    return {};
  };
  const options = { sessionId, parentPane: 'test:p0', socket: '/tmp/test.sock', stateDir,
    cwd: "/tmp/project with ' quotes", node: '/usr/bin/node', viewer: '/tmp/viewer.mjs', herdr };
  const controller = new DagPane(options);
  controllers.add(controller);
  return { calls, panes, options, controller, controllers };
}
// CamelCase checkpoint fields and array nodes match the persisted OmO run record.
async function checkpointSetup(t, custom = false) {
  const base = await setup(t);
  const cwd = join(base.options.stateDir, 'project');
  const taskStateDir = custom ? join(base.options.stateDir, 'custom-task-store') : join(cwd, '.omo', 'senpi-task');
  const messages = [];
  const controller = new DagPane({ ...base.options, cwd, ...(custom ? { taskStateDir } : {}),
    notify: message => messages.push(message) });
  base.controllers.add(controller);
  const checkpoint = { schemaVersion: 1, checkpointSeq: 30, runId: 'dag_restored', parentSessionId: sessionId,
    rootSessionId: sessionId, status: 'completed', createdAt: '2026-09-06T01:28:18.600Z',
    updatedAt: '2026-09-06T01:55:44.466Z',
    nodes: Array.from({ length: 4 }, (_, i) => ({ id: `node-${i}`, state: 'completed', attempt: 1, taskId: `st_saved${i}` })),
    edges: [{ from: 'node-0', to: 'node-3' }, { from: 'node-1', to: 'node-3' }, { from: 'node-2', to: 'node-3' }] };
  const directory = join(taskStateDir, 'dag', 'runs');
  const checkpointFile = join(directory, `${checkpoint.runId}.json`);
  await writeJson(checkpointFile, checkpoint);
  for (const node of checkpoint.nodes) await writeJson(join(taskStateDir, 'tasks', `${node.taskId}.json`),
    { task_id: node.taskId, parent_session_id: sessionId, status: 'completed', description: node.id,
      updated_at: checkpoint.updatedAt, terminal_at: checkpoint.updatedAt });
  await writeJson(controller.stateFile, { sessionId, runs: [], tasks: [] });
  return { ...base, controller, checkpoint, checkpointFile, directory, messages, cwd };
}

for (const action of ['start', 'open']) for (const custom of [false, true]) {
  test(`${action} bootstraps four checkpoint nodes and tasks from ${custom ? 'custom' : 'default'} task root`, async t => {
    const { controller, checkpoint, calls, cwd } = await checkpointSetup(t, custom);
    if (custom) await writeJson(join(cwd, '.omo', 'senpi-task', 'dag', 'runs', 'dag_wrong_root.json'),
      { ...checkpoint, runId: 'dag_wrong_root' });
    await controller[action]();
    const state = await readJson(controller.stateFile);
    assert.deepEqual(state.runs, [normalizeRun(checkpoint)]);
    assert.deepEqual(state.tasks.map(task => task.id).sort(), checkpoint.nodes.map(node => node.taskId).sort());
    assert.equal(calls.filter(call => call[0] === 'split').length, 1);
  });
}

test('model activity coalesces into snapshot rewrites, keeps phase start times, and vanishes on completion or stop', async t => {
  const { options, calls } = await setup(t);
  const taskStateDir = join(options.stateDir, 'task-store');
  const controller = new DagPane({ ...options, taskStateDir, streamDelay: 5 });
  const dag = payload(); dag.runs[0].nodes[0].task_id = 'st_root';
  await writeJson(join(taskStateDir, 'tasks', 'st_root.json'), { task_id: 'st_root', parent_session_id: sessionId,
    description: 'Real task', status: 'running', child_session_id: 'child-session' });
  await controller.start();
  await controller.receive(dag);
  const base = await readJson(controller.stateFile);
  const activityOf = async () => (await readJson(controller.stateFile)).tasks.find(task => task.id === 'st_root').activity;
  const flushes = [controller.receiveStream({ taskId: 'st_root', active: true, phase: 'waiting', now: 1000 }),
    controller.receiveStream({ taskId: 'st_root', active: true, phase: 'text', text: 'TAIL_ONE', now: 2000 }),
    controller.receiveStream({ taskId: 'st_root', active: true, phase: 'text', text: 'TAIL_TWO', now: 2500 })];
  assert.equal(flushes[0], flushes[2]);
  await Promise.all(flushes);
  const live = await readJson(controller.stateFile);
  assert.deepEqual(live.runs, base.runs);
  // The token phase began at its first token; lastAt follows the newest one.
  assert.deepEqual(await activityOf(), { phase: 'text', text: 'TAIL_TWO', since: 2000, lastAt: 2500 });
  await controller.receiveStream({ taskId: 'st_root', active: true, phase: 'tool', tool: 'bash', now: 3000 });
  assert.deepEqual(await activityOf(), { phase: 'tool', tool: 'bash', since: 3000, lastAt: 3000 });
  await controller.receiveStream({ taskId: 'st_root', active: true, phase: 'retry', attempt: 2, maxAttempts: 3, now: 4000 });
  assert.deepEqual(await activityOf(), { phase: 'retry', attempt: 2, maxAttempts: 3, since: 4000, lastAt: 4000 });
  await controller.receiveStream({ taskId: 'st_root', active: false });
  const settled = await readJson(controller.stateFile);
  assert.deepEqual(settled.tasks.find(task => task.id === 'st_root'), base.tasks[0]);
  assert.equal(calls.filter(call => call[0] === 'split').length, 1);
  // Terminal tasks never carry activity, even from a late event.
  await controller.receiveTasks({ parent_session_id: sessionId, tasks: [{ task_id: 'st_root', status: 'completed' }] });
  await controller.receiveStream({ taskId: 'st_root', active: true, phase: 'text', text: 'AFTER_TERMINAL', now: 5000 });
  await controller.receiveStream({ taskId: 'st_unknown', active: true, phase: 'text', text: 'UNKNOWN_TASK', now: 5000 });
  const finished = await readJson(controller.stateFile);
  assert.equal(Object.hasOwn(finished.tasks.find(task => task.id === 'st_root'), 'activity'), false);
  assert.ok(!JSON.stringify(finished).includes('AFTER_TERMINAL') && !JSON.stringify(finished).includes('UNKNOWN_TASK'));
  await controller.stop();
  const afterStop = await readJson(controller.stateFile);
  await controller.receiveStream({ taskId: 'st_root', active: true, phase: 'text', text: 'AFTER_STOP', now: 6000 });
  assert.deepEqual(await readJson(controller.stateFile), afterStop);
  await rm(taskStateDir, { recursive: true, force: true });
});

for (const action of ['start', 'open']) {
  test(`${action} prefers authoritative checkpoint over stale viewer cache for the same run`, async t => {
    const { controller, checkpoint } = await checkpointSetup(t);
    const stale = normalizeRun({ ...checkpoint, status: 'running', updatedAt: '2026-09-06T01:30:00Z' });
    await writeJson(controller.stateFile, { sessionId, runs: [stale], tasks: [] });
    await controller[action]();
    assert.deepEqual((await readJson(controller.stateFile)).runs, [normalizeRun(checkpoint)]);
  });
}

test('checkpoint bootstrap excludes foreign sessions and warns for malformed records without hiding valid runs', async t => {
  const { controller, checkpoint, directory, messages } = await checkpointSetup(t);
  await writeJson(join(directory, 'foreign.json'), { ...checkpoint, runId: 'dag_foreign', parentSessionId: 'foreign' });
  await writeJson(join(directory, 'invalid-shape.json'), { ...checkpoint, runId: 'dag_invalid', nodes: {} });
  await writeFile(join(directory, 'invalid-json.json'), '{');
  await writeFile(join(directory, 'ignored.tmp'), '{');
  await controller.start();
  assert.deepEqual((await readJson(controller.stateFile)).runs, [normalizeRun(checkpoint)]);
  assert.equal(messages.length, 2);
});

test('empty RPC lists retain durable runs but still replace ephemeral runs', async t => {
  const { controller, checkpoint } = await checkpointSetup(t);
  await controller.start();
  await controller.receive(payload());
  assert.deepEqual(new Set((await readJson(controller.stateFile)).runs.map(run => run.id)), new Set(['dag_demo', checkpoint.runId]));
  await controller.receive({ parent_session_id: sessionId, runs: [] });
  const state = await readJson(controller.stateFile);
  assert.deepEqual(state.runs, [normalizeRun(checkpoint)]);
  assert.equal(state.tasks.length, 4);
});

test('RPC updates queued during startup take precedence over the bootstrap checkpoint', async t => {
  const { controller, checkpoint, checkpointFile } = await checkpointSetup(t);
  await writeJson(checkpointFile, { ...checkpoint, status: 'running' });
  const starting = controller.start();
  const receiving = controller.receive({ parent_session_id: sessionId, runs: [checkpoint] });
  await Promise.all([starting, receiving]);
  assert.deepEqual((await readJson(controller.stateFile)).runs, [normalizeRun(checkpoint)]);
});

for (const trigger of ['start', 'rpc', 'disk']) {
  test(`standalone ${trigger} opens one pane without a DAG and respects manual close`, { timeout: 5000 }, async t => {
    const { options, calls, panes, controllers } = await setup(t);
    const taskStateDir = join(options.stateDir, 'standalone');
    const controller = new DagPane({ ...options, taskStateDir });
    controllers.add(controller);
    const saved = new EventEmitter();
    const save = controller.save.bind(controller);
    // Observe completion of the real save/activation path, without replacing it.
    controller.save = async connected => {
      const result = await save(connected);
      for (const task of controller.tasks) saved.emit(`${task.id}:${task.status}`);
      return result;
    };
    const record = { task_id: 'st_standalone', parent_session_id: sessionId, status: 'running', description: 'Standalone' };
    const file = join(taskStateDir, 'tasks', `${record.task_id}.json`);
    await writeJson(join(taskStateDir, 'tasks', 'st_foreign.json'), { ...record, task_id: 'st_foreign', parent_session_id: 'foreign' });
    if (trigger === 'start') await writeJson(file, record);
    await controller.start();
    if (trigger !== 'start') {
      assert.equal(calls.length, 0);
      if (trigger === 'rpc') await controller.receiveTasks({ parent_session_id: sessionId, tasks: [record] });
      else {
        const observed = once(saved, 'st_standalone:running', { signal: AbortSignal.timeout(2000) });
        await writeJson(file, record);
        await observed;
      }
    }
    let state = await readJson(controller.stateFile);
    assert.deepEqual(state.runs, []);
    assert.deepEqual(state.tasks.map(task => task.id), ['st_standalone']);
    assert.equal(calls.filter(call => call[0] === 'split').length, 1);
    panes.clear();
    const completed = { ...record, status: 'completed' };
    if (trigger === 'disk') {
      const observed = once(saved, 'st_standalone:completed', { signal: AbortSignal.timeout(2000) });
      await writeJson(file, completed);
      await observed;
    } else await controller.receiveTasks({ parent_session_id: sessionId, tasks: [completed] });
    state = await readJson(controller.stateFile);
    assert.equal(state.tasks[0].status, 'completed');
    assert.equal(calls.filter(call => call[0] === 'split').length, 1);
    await controller.open();
    assert.equal(calls.filter(call => call[0] === 'split').length, 2);
  });
}

test('empty startup and foreign task events never create a pane', async t => {
  const { options, calls, controllers } = await setup(t);
  const controller = new DagPane({ ...options, taskStateDir: join(options.stateDir, 'empty-tasks') });
  controllers.add(controller);
  await controller.start();
  await controller.receiveTasks({ parent_session_id: 'foreign', tasks: [{ task_id: 'st_foreign', status: 'running' }] });
  await controller.receive({ parent_session_id: sessionId, runs: [] });
  assert.equal(calls.length, 0);
});

test('a burst of events creates one pane, preserves focus, updates the same state file', async t => {
  const { calls, controller } = await setup(t);
  await Promise.all(Array.from({ length: 12 }, () => controller.receive(payload())));
  const split = calls.find(c => c[0] === 'split');
  assert.equal(calls.filter(c => c[0] === 'split').length, 1);
  assert.ok(split.includes('--no-focus'));
  assert.ok(split.includes('right'));
  assert.equal(split[split.indexOf('--ratio') + 1], '0.65');
  assert.equal(calls.filter(c => c[0] === 'run').length, 1);
  const next = payload(); next.runs[0].nodes.forEach(n => { n.state = 'completed'; }); next.runs[0].status = 'completed';
  await controller.receive(next);
  assert.equal((await readJson(controller.stateFile)).runs[0].status, 'completed');
  assert.equal((await readJson(controller.stateFile)).language, 'en');
});
test('reload reuses the pane and manual closure is respected until explicit reopen', async t => {
  const { calls, panes, controller, options } = await setup(t);
  await controller.receive(payload());
  await controller.stop();
  assert.equal((await readJson(controller.stateFile)).connected, false);
  const next = new DagPane(options);
  await next.receive(payload());
  panes.clear();
  await next.receive(payload());
  assert.equal(calls.filter(c => c[0] === 'split').length, 1);
  await next.open();
  assert.equal(calls.filter(c => c[0] === 'split').length, 2);
});
test('different sessions cannot affect each other and empty DAG lists do not split', async t => {
  const { calls, controller, options } = await setup(t);
  await controller.receive({ parent_session_id: sessionId, runs: [] });
  await controller.receive({ ...payload(), parent_session_id: 'foreign' });
  assert.equal(calls.length, 0);
  const other = new DagPane({ ...options, sessionId: 'foreign' });
  assert.notEqual(controller.stateFile, other.stateFile);
});
test('a failed split is reported once; later events do not create orphan panes', async t => {
  const { options } = await setup(t); let calls = 0; const messages = [];
  const controller = new DagPane({ ...options, herdr: async () => { calls++; throw new Error('socket timeout'); }, notify: m => messages.push(m) });
  await assert.rejects(controller.receive(payload()), /timeout/);
  const first = calls;
  await controller.receive(payload());
  assert.equal(calls, first); assert.equal(messages.length, 1);
});

test('opening closes leftover DAG panes and reuses a live recorded pane', async t => {
  const { calls, panes, controller } = await setup(t);
  panes.add('test:stale');
  await controller.receive(payload());
  assert.equal(calls.filter(call => call[0] === 'split').length, 1);
  assert.ok(calls.some(call => call[0] === 'close' && call[1] === 'test:stale'));
  assert.equal(panes.has('test:stale'), false);
  const live = [...panes][0];
  panes.add('test:duplicate');
  await controller.open();
  assert.equal(calls.filter(call => call[0] === 'split').length, 1);
  assert.ok(calls.some(call => call[0] === 'close' && call[1] === 'test:duplicate'));
  assert.equal(panes.has(live), true);
  assert.equal(panes.has('test:duplicate'), false);
});

test('DAG viewer panes are identified by title prefix', () => {
  assert.equal(isDagViewerPane({ label: dagTitle(sessionId) }), true);
  assert.equal(isDagViewerPane({ terminal_title: 'DAG · leftover' }), true);
  assert.equal(isDagViewerPane({ terminal_title: 'OmO DAG' }), true);
  assert.equal(isDagViewerPane({ label: 'OmO', terminal_title: 'OmO' }), false);
});

test('the selected language is persisted for the viewer', async t => {
  const { options } = await setup(t);
  const controller = new DagPane({ ...options, language: 'ko' });
  await controller.receive(payload());
  assert.equal((await readJson(controller.stateFile)).language, 'ko');
});

test('runtime failure creates no pane or attempt record and can be retried', async t => {
  const { options, calls } = await setup(t);
  let available = false, probes = 0;
  const node = async () => { probes++; if (!available) throw new Error('Node unavailable'); return '/opt/Node Runtime/node'; };
  const controller = new DagPane({ ...options, node });
  await assert.rejects(controller.open(), /Node unavailable/);
  assert.equal(calls.length, 0);
  assert.equal(await readJson(controller.recordFile), null);
  available = true;
  await controller.open();
  assert.match(calls.find(c => c[0] === 'run')[2], /^(?:& )?'\/opt\/Node Runtime\/node' '\/tmp\/viewer.mjs' '--state'/);
  await controller.open();
  assert.equal(probes, 2);
  assert.equal(calls.filter(c => c[0] === 'split').length, 1);
});

test('task-only events update snapshots; reload restores completed details without another DAG event', async t => {
  const { options, calls } = await setup(t);
  const taskStateDir = join(options.stateDir, 'task-store');
  const controller = new DagPane({ ...options, taskStateDir });
  const dag = payload(); dag.runs[0].nodes[0].task_id = 'st_root';
  await writeJson(join(taskStateDir, 'tasks', 'st_root.json'), { task_id: 'st_root', parent_session_id: sessionId,
    description: 'Real task', status: 'running', child_session_id: 'child-session' });
  await controller.start();
  await controller.receive(dag);
  assert.equal((await readJson(controller.stateFile)).tasks[0].description, 'Real task');
  const beforeProgress = await readJson(controller.stateFile);
  for (const excerpt of ['PROGRESS_EXCERPT_ONE', 'PROGRESS_EXCERPT_TWO']) {
    await controller.receiveTasks({ parent_session_id: sessionId, tasks: [{ task_id: 'st_root', status: 'running',
      live_progress: { activity: 'running', last_assistant_line: excerpt, current_tool: 'bash', turns: 1, tool_calls: 1 },
      spawn_spec: { prompt: 'PRIVATE_PROMPT' }, output: 'PRIVATE_FULL_OUTPUT', final_response: 'PRIVATE_FINAL_RESPONSE' }] });
    const live = await readJson(controller.stateFile);
    assert.equal(live.tasks[0].progress, `[bash] ${excerpt}`);
    assert.deepEqual(live.runs, beforeProgress.runs);
    assert.doesNotMatch(JSON.stringify(live), /PRIVATE_|spawn_spec|final_response/);
  }
  await controller.receiveTasks({ parent_session_id: sessionId, tasks: [{ task_id: 'st_root',
    status: 'completed', updated_at: '2026-09-06T00:02:00Z', run_stats: { turns: 3, tool_calls: 7 },
    final_response: 'PRIVATE OUTPUT' }] });
  const snapshot = await readJson(controller.stateFile);
  assert.equal(snapshot.tasks[0].toolCalls, 7);
  assert.equal(snapshot.tasks[0].completedAt, '2026-09-06T00:02:00.000Z');
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE OUTPUT'));
  assert.equal(calls.filter(call => call[0] === 'split').length, 1);
  await controller.stop();
  const disconnected = await readJson(controller.stateFile);
  await controller.receiveTasks({ parent_session_id: sessionId, tasks: [{ task_id: 'st_root',
    live_progress: { last_assistant_line: 'AFTER_STOP' } }] });
  assert.deepEqual(await readJson(controller.stateFile), disconnected);
  await rm(taskStateDir, { recursive: true, force: true });
  const reloaded = new DagPane({ ...options, taskStateDir });
  await reloaded.start();
  assert.deepEqual((await readJson(reloaded.stateFile)).tasks, snapshot.tasks);
  await reloaded.stop();
  assert.equal((await readJson(reloaded.stateFile)).connected, false);
});

test('process query fails closed on invalid PIDs and re-queries one empty output', async () => {
  const runner = outputs => {
    const calls = [];
    const run = async (...args) => { calls.push(args); return { stdout: outputs[Math.min(calls.length - 1, outputs.length - 1)] }; };
    run.calls = calls; return run;
  };
  // (a) an invalid pid never reaches PowerShell
  for (const pid of [undefined, null, NaN, Infinity, 0, -1, 1.5, '42']) {
    const run = runner(['[]']);
    await assert.rejects(queryShellProcesses(pid, run), { code: 'SHELL_QUERY_INVALID_PID' });
    assert.equal(run.calls.length, 0);
  }
  // (b) one empty output is re-queried once
  const second = runner(['', '[{"ProcessId":42}]']);
  assert.deepEqual(await queryShellProcesses(42, second), [{ ProcessId: 42 }]);
  assert.equal(second.calls.length, 2);
  // (c) two empty outputs fail as an empty query, not as a JSON syntax error
  const empty = runner(['']);
  await assert.rejects(queryShellProcesses(42, empty), error => error.code === 'SHELL_QUERY_EMPTY' && !/Unexpected end of JSON input/.test(error.message));
  assert.equal(empty.calls.length, 2);
  // (d) whitespace-only output counts as empty
  const blank = runner(['\r\n']);
  await assert.rejects(queryShellProcesses(42, blank), { code: 'SHELL_QUERY_EMPTY' });
  assert.equal(blank.calls.length, 2);
  // (e) a good first output is not re-queried
  const good = runner(['[{"ProcessId":42}]']);
  assert.deepEqual(await queryShellProcesses(42, good), [{ ProcessId: 42 }]);
  assert.equal(good.calls.length, 1);
  // (f) malformed JSON still rejects, without a re-query
  const broken = runner(['[{']);
  await assert.rejects(queryShellProcesses(42, broken), SyntaxError);
  assert.equal(broken.calls.length, 1);
  // (g) the cache evicts a rejected query and asks again
  const cachedRun = runner(['']);
  const cached = cachedProcessQuery(pid => queryShellProcesses(pid, cachedRun));
  await assert.rejects(cached(42), { code: 'SHELL_QUERY_EMPTY' });
  await assert.rejects(cached(42), { code: 'SHELL_QUERY_EMPTY' });
  assert.equal(cachedRun.calls.length, 4);
});

// --- todo 6: read-only legacy Collab proof and scoped yield ---------------
const legacyRecord = overrides => ({ v: 1, paneId: 'qa:collab', parentPaneId: 'qa:parent',
  sessionId: 'synthetic-session', tabId: 'qa:tab', viewer: '/agent/coordination/viewer.mjs',
  createdAt: '2026-10-20T00:00:02.000Z', phase: 'running', workers: 'qa:workers', dag: 'qa:dag',
  ...overrides });
const legacyOptions = overrides => ({ parentPane: 'qa:parent', sessionId: 'synthetic-session',
  tabId: 'qa:tab', stateDir: '/state', activityPath: '/agent/coordination-activity.jsonl',
  language: 'en', lifetimeId: 'core-lifetime', ...overrides });
const legacyShell = overrides => ({ ProcessId: 456, ExecutablePath: 'powershell.exe',
  CommandLine: 'powershell.exe', CreationDate: '2026-10-20T00:00:00.000Z',
  Birth: '133000000000000000', ...overrides });
const legacyCommand = overrides => {
  const value = { node: 'node.exe', viewer: '/agent/coordination/viewer.mjs',
    status: '/state/qa_parent.status.json', activity: '/agent/coordination-activity.jsonl',
    session: 'synthetic-session', record: '/state/qa_parent.pane.json', lang: 'en',
    pane: 'qa:collab', ...overrides };
  return `"${value.node}" "${value.viewer}" --status "${value.status}" --activity "${value.activity}"` +
    ` --session "${value.session}" --record "${value.record}" --lang "${value.lang}"` +
    ` --close-pane "${value.pane}"`;
};
const legacyChild = overrides => ({ ProcessId: 123, ParentProcessId: 456,
  ExecutablePath: 'node.exe', CommandLine: legacyCommand(), CreationDate: '2026-10-20T00:00:03.000Z',
  Birth: '133000000030000000', ...overrides });
const legacyInfo = overrides => ({ process_info: { pane_id: 'qa:collab', shell_pid: 456,
  foreground_processes: [{ pid: 456, argv: ['powershell.exe'] }], ...overrides } });

test('the legacy Collab proof accepts only the exact shell, Node child argv and birth interval', async () => {
  const rows = async () => [legacyShell(), legacyChild()];
  const proof = await observeLegacyCollab(legacyInfo(), legacyRecord(), legacyOptions(), rows);
  assert.equal(proof.paneId, 'qa:collab');
  assert.equal(proof.parentPaneId, 'qa:parent');
  assert.equal(proof.sessionId, 'synthetic-session');
  assert.equal(proof.tabId, 'qa:tab');
  assert.equal(proof.shellPid, 456);
  assert.equal(proof.shellBirth, '133000000000000000');
  assert.equal(proof.viewerPid, 123);
  assert.equal(proof.viewerBirth, '133000000030000000');
  assert.equal(proof.language, 'en');
  assert.match(proof.argvDigest, /^[0-9a-f]{64}$/);
  // v1 stores no nodePath: none is required, and an unrelated stored one is not used.
  const withoutNodePath = legacyRecord(); delete withoutNodePath.nodePath;
  assert.ok(await observeLegacyCollab(legacyInfo(), withoutNodePath, legacyOptions(), rows));
  assert.ok(await observeLegacyCollab(legacyInfo(), legacyRecord({ nodePath: '/foreign/node' }), legacyOptions(), rows));
  // A foreground report naming the Node child instead of the shell is equivalent evidence.
  assert.ok(await observeLegacyCollab(legacyInfo({ foreground_processes: [{ pid: 123, argv: ['node.exe'] }] }),
    legacyRecord(), legacyOptions(), rows));
  // Non-Windows: the default PowerShell query is never used as evidence, while an
  // injected equivalent Herdr argv inspector is validated by the same rules.
  assert.equal(await observeLegacyCollab(legacyInfo(), legacyRecord(), legacyOptions({ platform: 'linux' })), null);
  assert.ok(await observeLegacyCollab(legacyInfo(), legacyRecord(), legacyOptions({ platform: 'linux' }), rows));
});

test('the legacy Collab proof rejects any foreign scope, argv, process, birth or time identity', async () => {
  const rows = async () => [legacyShell(), legacyChild()];
  const reject = async (label, info, record, options, inspect = rows) =>
    assert.equal(await observeLegacyCollab(info, record, options, inspect), null, label);
  await reject('foreign parent', legacyInfo(), legacyRecord(), legacyOptions({ parentPane: 'qa:other' }));
  await reject('foreign session', legacyInfo(), legacyRecord(), legacyOptions({ sessionId: 'foreign' }));
  await reject('foreign tab', legacyInfo(), legacyRecord(), legacyOptions({ tabId: 'qa:other' }));
  await reject('record without tab', legacyInfo(), legacyRecord({ tabId: undefined }), legacyOptions());
  await reject('foreign pane', legacyInfo({ pane_id: 'qa:other' }), legacyRecord(), legacyOptions());
  await reject('closed record', legacyInfo(), legacyRecord({ manualClose: true }), legacyOptions());
  await reject('v2 record is not legacy evidence', legacyInfo(), legacyRecord({ v: 2 }), legacyOptions());
  await reject('unmanaged locale', legacyInfo(), legacyRecord(), legacyOptions({ language: 'fr' }));
  await reject('shell born after the record', legacyInfo(), legacyRecord(), legacyOptions(),
    async () => [legacyShell({ CreationDate: '2026-10-20T00:00:03.000Z' }), legacyChild()]);
  await reject('child born before the record', legacyInfo(), legacyRecord({ createdAt: '2026-10-20T00:00:04.000Z' }),
    legacyOptions(), rows);
  await reject('unparseable record time', legacyInfo(), legacyRecord({ createdAt: 'not-a-date' }), legacyOptions());
  for (const [label, command] of [
    ['foreign viewer', legacyCommand({ viewer: '/agent/foreign.mjs' })],
    ['status flag', legacyCommand().replace('--status', '--state')],
    ['status path', legacyCommand({ status: '/state/foreign.status.json' })],
    ['activity path', legacyCommand({ activity: '/agent/foreign.jsonl' })],
    ['session value', legacyCommand({ session: 'foreign-session' })],
    ['record path', legacyCommand({ record: '/state/foreign.pane.json' })],
    ['language', legacyCommand({ lang: 'ko' })],
    ['close pane', legacyCommand({ pane: 'qa:other' })],
    ['extra argument', legacyCommand() + ' --launch token'],
    ['missing argument', legacyCommand().replace(' --session "synthetic-session"', '')],
  ]) await reject(label, legacyInfo(), legacyRecord(), legacyOptions(),
    async () => [legacyShell(), legacyChild({ CommandLine: command })]);
  for (const [label, output] of [
    ['empty rows', []],
    ['shell only', [legacyShell()]],
    ['two children', [legacyShell(), legacyChild(), legacyChild({ ProcessId: 124 })]],
    ['unrelated row', [legacyShell(), legacyChild(), { ...legacyChild({ ProcessId: 125 }), ParentProcessId: 999 }]],
    ['foreign child', [legacyShell(), legacyChild({ ParentProcessId: 999 })]],
    ['non-Node child', [legacyShell(), legacyChild({ ExecutablePath: 'python.exe' })]],
    ['missing shell birth', [{ ...legacyShell(), Birth: '' }, legacyChild()]],
    ['missing child birth', [legacyShell(), legacyChild({ Birth: '' })]],
    ['missing shell row', [legacyChild({ ParentProcessId: 456 })]],
    ['duplicate pid', [legacyShell(), legacyChild(), legacyChild()]],
    ['shell birth after child birth', [{ ...legacyShell(), Birth: '133000000090000000' }, legacyChild()]],
    ['child creation before shell', [legacyShell(), legacyChild({ CreationDate: '2026-10-19T23:59:59.000Z' })]],
  ]) await reject(label, legacyInfo(), legacyRecord(), legacyOptions(), async () => output);
  await reject('failed query', legacyInfo(), legacyRecord(), legacyOptions(),
    async () => { throw new Error('CIM failed'); });
  await reject('foreign foreground process', legacyInfo({ foreground_processes: [{ pid: 999, argv: ['foreign.exe'] }] }),
    legacyRecord(), legacyOptions());
});

test('the legacy proof memo reuses only the freshly re-read native identity', async () => {
  let calls = 0;
  const inspect = async () => { calls += 1; return [legacyShell(), legacyChild()]; };
  const cache = new Map();
  const at = (info, record, options) => observeLegacyCollab(info, record, { ...options, cache }, inspect);
  const first = await at(legacyInfo(), legacyRecord(), legacyOptions());
  assert.ok(first);
  assert.deepEqual(await at(legacyInfo(), legacyRecord(), legacyOptions()), first);
  assert.equal(calls, 2, 'each call re-reads the native identity before serving the memo');
  assert.deepEqual(await at(legacyInfo(), legacyRecord(), legacyOptions({ fresh: true })), first);
  assert.equal(calls, 3, 'the pre-close recheck bypasses memo reuse');
  assert.equal(await at(legacyInfo({ shell_pid: 457 }), legacyRecord(), legacyOptions()), null);
  assert.equal(calls, 4, 'a changed shell PID is a new native identity');
  assert.ok(await at(legacyInfo(), legacyRecord({ createdAt: '2026-10-20T00:00:02.500Z' }), legacyOptions()));
  assert.equal(calls, 5, 'a changed record time invalidates the tuple');
  assert.ok(await at(legacyInfo(), legacyRecord(), legacyOptions({ lifetimeId: 'other-lifetime' })));
  assert.equal(calls, 6, 'a changed lifetime never reuses the memo');
});

test('a cached legacy proof is invalidated by a changed native birth or foreign argv', async () => {
  const cache = new Map();
  let state = { shellBirth: '133000000000000000', childBirth: '133000000030000000', command: legacyCommand() };
  let calls = 0;
  const inspect = async () => {
    calls += 1;
    return [legacyShell({ Birth: state.shellBirth }),
      legacyChild({ Birth: state.childBirth, CommandLine: state.command })];
  };
  const at = (options = {}) => observeLegacyCollab(legacyInfo(), legacyRecord(),
    { ...legacyOptions(), cache, ...options }, inspect);
  const first = await at();
  assert.ok(first);
  // Same pane, PIDs and argv: only the shell's native Birth changed. The memo
  // must not serve the old proof; the fresh observe carries the new birth.
  state = { ...state, shellBirth: '133000000000000001' };
  const reborn = await at();
  assert.ok(reborn);
  assert.equal(reborn.shellBirth, '133000000000000001');
  assert.notDeepEqual(reborn, first);
  assert.equal(calls, 2);
  // Same PIDs and birth: a foreign child argv is not a usable legacy identity.
  state = { ...state, command: legacyCommand({ viewer: '/agent/foreign.mjs' }) };
  assert.equal(await at(), null);
  assert.equal(calls, 3);
  assert.equal(cache.size, 0, 'the invalid identity entry is removed');
  // The verifier's exact shape: process epoch bump plus changed birth and argv.
  state = { shellBirth: '133000000000000000', childBirth: '133000000030000000', command: legacyCommand() };
  assert.ok(await at());
  state = { ...state, shellBirth: '133000000000000001', command: legacyCommand({ viewer: '/agent/foreign.mjs' }) };
  bumpProcessQueryEpoch();
  const stale = await at();
  const fresh = await at({ fresh: true });
  assert.equal(stale, null, 'process/native identity change must invalidate the legacy proof cache');
  assert.equal(fresh, null);
  assert.equal(cache.size, 0);
});

test('an unchanged native identity reuses the proof without another process scan', async () => {
  let scans = 0;
  const run = async () => {
    scans += 1;
    return { stdout: JSON.stringify([legacyShell(), legacyChild()]) };
  };
  const inspect = cachedProcessQuery(pid => queryShellProcesses(pid, run));
  const cache = new Map();
  const first = await observeLegacyCollab(legacyInfo(), legacyRecord(), { ...legacyOptions(), cache }, inspect);
  const second = await observeLegacyCollab(legacyInfo(), legacyRecord(), { ...legacyOptions(), cache }, inspect);
  assert.ok(first);
  assert.deepEqual(second, first);
  assert.equal(scans, 1, 'the cached process query serves the unchanged identity without a new native scan');
});

// A four-area band plus a stale Collab pane elsewhere in the same tab. The
// Collab is neither leftmost nor proved as a current cell, so an explicit pass
// must yield it before the four-area planner may write a placement journal.
function bandPanes(withCollab) {
  const area = { x: 0, y: 0, width: 172, height: 46 };
  const panes = [
    { pane_id: 'qa:parent', rect: { x: 0, y: 0, width: 86, height: 46 } },
    { pane_id: 'qa:todo', rect: { x: 86, y: 0, width: 86, height: 16 } },
    { pane_id: 'qa:workers', rect: { x: 86, y: 16, width: 43, height: 30 } },
    { pane_id: 'qa:dag', rect: { x: 129, y: 16, width: 43, height: 30 } },
  ];
  if (withCollab === 'stale') panes.push({ pane_id: 'qa:collab', rect: { x: 150, y: 40, width: 20, height: 4 } });
  if (withCollab === 'band') {
    panes.splice(2, 0, { pane_id: 'qa:collab', rect: { x: 86, y: 16, width: 28, height: 30 } });
    panes[3].rect = { x: 114, y: 16, width: 29, height: 30 };
    panes[4].rect = { x: 143, y: 16, width: 29, height: 30 };
  }
  return { tab_id: 'qa:tab', focused_pane_id: 'qa:parent', area, panes, splits: [
    { direction: 'right', ratio: 0.5, rect: area },
    { direction: 'down', ratio: 16 / 46, rect: { x: 86, y: 0, width: 86, height: 46 } },
    { direction: 'right', ratio: 0.5, rect: { x: 86, y: 16, width: 86, height: 30 } },
  ] };
}

async function yieldOwner(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'omo-dag-yield-'));
  const events = new EventEmitter(), calls = [], yields = [];
  let layout = overrides.layout ?? bandPanes('stale');
  const timers = { setTimeout(fn) { timers.fn = fn; return 1; }, clearTimeout() { timers.fn = null; } };
  const binding = { socketPath: 'qa:socket', parentPaneId: 'qa:parent',
    sessionId: 'synthetic-session', ownerKey: 'qa:owner' };
  const todo = { ...binding, role: 'todo', paneId: 'qa:todo', tabId: 'qa:tab', scopeEpoch: 1, ready: true };
  const pair = { dag: { ...binding, role: 'dag', paneId: 'qa:dag' },
    workers: { ...binding, role: 'workers', paneId: 'qa:workers' } };
  await writeJson(join(directory, 'dag.pane.json'), pair.dag);
  await writeJson(join(directory, 'workers.pane.json'), pair.workers);
  const owner = {
    binding, parentPane: 'qa:parent', sessionId: 'synthetic-session', scopeEpoch: 1,
    lifetimeId: 'dag-life', managedAvailable: true, stopped: false, status: 'waiting',
    claim: { layout: 'band', tabId: 'qa:tab' }, directory, events, timers, yieldTimeoutMs: 5000,
    legacyCollabCache: new Map(), coordinationStateDir: '/state',
    coordinationActivityPath: '/agent/coordination-activity.jsonl', coordinationLanguage: 'en',
    inspectLegacyCollab: overrides.inspectLegacyCollab,
    coordinationRecord: FixedDagPane.prototype.coordinationRecord,
    coordinationRecordPath: FixedDagPane.prototype.coordinationRecordPath,
    enqueue: job => job(),
    records: new Map(),
    paneFile: role => join(directory, `${role}.pane.json`),
    recordMatches: (record, role) => record?.paneId === pair[role]?.paneId,
    paneGone: async paneId => !(layout.panes ?? []).some(pane => pane?.pane_id === paneId),
    roleWrite: job => job(),
    herdr: async (...args) => {
      calls.push(args);
      if (args[0] === 'layout') return { layout };
      if (args[0] === 'process-info') return { process_info: { pane_id: 'qa:collab', shell_pid: 456,
        foreground_processes: [{ pid: 456, argv: ['powershell.exe'] }] } };
      throw new Error(`unexpected herdr ${args[0]}`);
    },
    membership: async () => {},
    verify: async () => true,
    placementFocus: async () => 'qa:parent',
    restorePlacementFocus: async () => {},
    mutate: async (...args) => { calls.push(['mutate', ...args]); },
    inspectPair: async () => pair,
    coordinator: { binding, lifetimeId: 'todo-life',
      actor: { snapshot: { generation: 1, operations: [] } },
      inspectTodo: async () => todo, gate: overrides.gate ?? (async () => null),
      target: async id => ({ paneId: id }) },
    readCoordinationRecord: overrides.readCoordinationRecord ?? (async () => overrides.record ?? {
      v: 2, paneId: 'qa:collab', parentPaneId: 'qa:parent', sessionId: 'synthetic-session',
      tabId: 'qa:tab', manualClose: false, launch: { token: 'launch-1' } }),
  };
  const setLayout = value => { layout = value; };
  events.on(RECOVERY_V1.yield, message => {
    yields.push(message);
    if (overrides.onYield) return overrides.onYield(message, { setLayout, events, timers });
    setLayout(bandPanes(false));
    events.emit(RECOVERY_V1.layout, { v: 1, kind: 'layout', scope: message.scope,
      commandId: message.commandId, cells: [{ role: 'workers', paneId: 'qa:workers' },
        { role: 'dag', paneId: 'qa:dag' }] });
  });
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  return { owner, directory, events, calls, yields, timers, setLayout, binding, pair, todo };
}

test('an explicit stale-Collab migration yields once, observes native disappearance, then promotes the four-area band', async t => {
  const f = await yieldOwner(t);
  const result = await FixedDagPane.prototype.arrangeDashboard.call(f.owner);
  assert.deepEqual(result, { layout: 'band' });
  assert.equal(f.yields.length, 1);
  const [message] = f.yields;
  assert.equal(message.kind, 'yield');
  assert.equal(message.paneId, 'qa:collab');
  assert.equal(message.reason, 'layout-migration');
  assert.equal(message.scope.lifetimeId, 'todo-life');
  assert.equal(message.scope.tabId, 'qa:tab');
  assert.equal(message.scope.sessionId, 'synthetic-session');
  assert.equal(f.calls.some(call => ['close', 'split', 'swap', 'move', 'resize', 'run'].includes(call[0])), false,
    'core never closes or runs the collaboration pane');
  assert.equal(f.calls.some(call => call[0] === 'mutate'), false, 'the four-area plan was already settled');
  assert.equal(await readJson(join(f.directory, 'placement.json')), null, 'no journal is written');
  const claim = await readJson(join(f.directory, 'layout.json'));
  assert.equal(claim.layout, 'band');
  assert.equal(f.owner.claim.layout, 'band');
  assert.equal(f.owner.status, 'current');
});

test('an acknowledgment without native disappearance never authorizes the migration journal', async t => {
  const f = await yieldOwner(t, { onYield: (message, { events, timers }) => {
    events.emit(RECOVERY_V1.layout, { v: 1, kind: 'layout', scope: message.scope, commandId: message.commandId });
    timers.fn?.();
  } });
  await assert.rejects(FixedDagPane.prototype.arrangeDashboard.call(f.owner),
    error => error.code === 'LAYOUT_WAIT' && /has not yielded/.test(error.message));
  assert.equal(f.yields.length, 1);
  assert.equal(f.calls.some(call => call[0] === 'mutate'), false);
  assert.equal(await readJson(join(f.directory, 'placement.json')), null);
});

test('a missing yield reply leaves the original panes and writes no placement journal', async t => {
  const f = await yieldOwner(t, { onYield: (_message, { timers }) => { timers.fn?.(); } });
  await assert.rejects(FixedDagPane.prototype.arrangeDashboard.call(f.owner),
    error => error.code === 'LAYOUT_WAIT' && /has not yielded/.test(error.message));
  assert.equal(f.yields.length, 1);
  assert.equal(f.calls.some(call => call[0] === 'mutate'), false);
  assert.equal(await readJson(join(f.directory, 'placement.json')), null);
});

test('without a recovery bus an explicit Collab migration yields nothing and mutates nothing', async t => {
  const f = await yieldOwner(t);
  f.owner.events = undefined;
  await assert.rejects(FixedDagPane.prototype.arrangeDashboard.call(f.owner),
    error => error.code === 'LAYOUT_WAIT' && /no recovery bus/.test(error.message));
  assert.equal(f.yields.length, 0);
  assert.equal(f.calls.some(call => call[0] === 'close'), false);
  assert.equal(f.calls.some(call => call[0] === 'mutate'), false);
  assert.equal(await readJson(join(f.directory, 'placement.json')), null);
});

test('an automatic pass is refused before it can enqueue a yield', async t => {
  const f = await yieldOwner(t, { gate: async () => 'layout-waiting: an automatic dashboard pass does not rearrange' });
  await assert.rejects(FixedDagPane.prototype.arrangeDashboard.call(f.owner), { code: 'LAYOUT_WAIT' });
  assert.equal(f.yields.length, 0);
  assert.equal(f.calls.some(call => call[0] === 'mutate'), false);
  assert.equal(await readJson(join(f.directory, 'placement.json')), null);
});

test('a foreign legacy argv gives zero yields and zero closes and remains legacy-waiting', async t => {
  const f = await yieldOwner(t, { record: legacyRecord(), inspectLegacyCollab: async () =>
    [legacyShell(), legacyChild({ CommandLine: legacyCommand({ viewer: '/agent/foreign.mjs' }) })] });
  await assert.rejects(FixedDagPane.prototype.arrangeDashboard.call(f.owner),
    error => error.code === 'LAYOUT_WAIT' && /legacy collaboration pane cannot be proved/.test(error.message));
  assert.equal(f.yields.length, 0);
  assert.equal(f.calls.some(call => call[0] === 'close'), false);
  assert.equal(await readJson(join(f.directory, 'placement.json')), null);
});

test('a proved legacy Collab travels with the scoped yield and is never adopted by record id', async t => {
  const f = await yieldOwner(t, { record: legacyRecord(), inspectLegacyCollab: async () =>
    [legacyShell(), legacyChild()] });
  const result = await FixedDagPane.prototype.arrangeDashboard.call(f.owner);
  assert.deepEqual(result, { layout: 'band' });
  assert.equal(f.yields.length, 1);
  const proof = f.yields[0].legacyProof;
  assert.ok(proof);
  assert.equal(proof.paneId, 'qa:collab');
  assert.equal(proof.parentPaneId, 'qa:parent');
  assert.equal(proof.shellPid, 456);
  assert.equal(proof.viewerPid, 123);
  assert.equal(proof.language, 'en');
  assert.equal(f.calls.some(call => call[0] === 'close'), false, 'core never closes the proved legacy pane');
  assert.equal(await readJson(join(f.directory, 'placement.json')), null);
});

test('a second parent pane in the same tab cannot contribute its Collab pane or proof', async t => {
  const columns = { tab_id: 'qa:tab', focused_pane_id: 'qa:parent',
    area: { x: 0, y: 0, width: 172, height: 46 },
    panes: [
      { pane_id: 'qa:parent', rect: { x: 0, y: 0, width: 68, height: 46 } },
      { pane_id: 'qa:todo', rect: { x: 68, y: 0, width: 52, height: 23 } },
      { pane_id: 'qa:workers', rect: { x: 68, y: 23, width: 52, height: 23 } },
      { pane_id: 'qa:dag', rect: { x: 120, y: 0, width: 52, height: 46 } },
      { pane_id: 'qa:collab', rect: { x: 150, y: 40, width: 20, height: 4 } },
    ], splits: [] };
  const f = await yieldOwner(t, { layout: columns, record: legacyRecord({ parentPaneId: 'qa:other' }) });
  await assert.rejects(FixedDagPane.prototype.arrangeDashboard.call(f.owner),
    error => error.code === 'LAYOUT_WAIT' && /does not own/.test(error.message));
  assert.equal(f.yields.length, 0);
  assert.equal(f.calls.some(call => call[0] === 'close'), false);
  assert.equal(await readJson(join(f.directory, 'placement.json')), null);
});

test('a correct five-area band is a no-op and never yields or flickers', async t => {
  const f = await yieldOwner(t, { layout: bandPanes('band') });
  await FixedDagPane.prototype.arrangeDashboard.call(f.owner);
  assert.equal(f.yields.length, 0);
  assert.equal(f.calls.some(call => call[0] === 'process-info'), false, 'a healthy pass never runs the legacy query');
  assert.equal(f.calls.some(call => call[0] === 'mutate'), false);
  assert.equal(await readJson(join(f.directory, 'placement.json')), null);
});

const placementSchema = 'omo-herdr-dashboard/temporary-placement/1';
function stuckJournal(binding) {
  return { schema: placementSchema, ...binding, lifetimeId: 'dag-life', ownerNonce: 'nonce', generation: 1,
    source: { paneId: 'qa:dag' }, anchor: { paneId: 'qa:todo' }, direction: 'down',
    selected: 'qa:parent', phase: 'SWAP_SETTLED', beforeLayout: bandPanes(false),
    temporary: { paneId: 'qa:temp', tabId: 'qa:tab' } };
}

test('an explicit stuck five-pane band yields before the no-op and then completes the four-area migration', async t => {
  const f = await yieldOwner(t, { layout: bandPanes('band') });
  const seeded = stuckJournal(f.binding), seededBytes = JSON.stringify(seeded);
  await writeJson(join(f.directory, 'placement.json'), seeded);
  let journalAtYield;
  f.events.removeAllListeners(RECOVERY_V1.yield);
  f.events.on(RECOVERY_V1.yield, message => {
    f.yields.push(message);
    journalAtYield = readFileSync(join(f.directory, 'placement.json'), 'utf8');
    f.setLayout(bandPanes(false));
    f.events.emit(RECOVERY_V1.layout, { v: 1, kind: 'layout', scope: message.scope,
      commandId: message.commandId, cells: [{ role: 'workers', paneId: 'qa:workers' },
        { role: 'dag', paneId: 'qa:dag' }] });
  });
  const result = await FixedDagPane.prototype.arrangeDashboard.call(f.owner);
  assert.equal(f.yields.length, 1, 'exactly one yield for the recorded Collab pane');
  assert.equal(f.yields[0].paneId, 'qa:collab');
  assert.equal(journalAtYield, seededBytes, 'placement.json is untouched before native disappearance');
  assert.deepEqual(result, { layout: 'band' });
  const journal = await readJson(join(f.directory, 'placement.json'));
  assert.equal(journal.phase, 'COMPLETE', 'the unchanged planner completed the four-area migration after the yield');
  assert.equal(f.owner.claim.layout, 'band');
  assert.equal(f.calls.some(call => call[0] === 'close'), false);
  assert.equal(f.calls.some(call => call[0] === 'mutate'), false);
});

test('an automatic pass with an unresolved journal never yields or mutates the journal', async t => {
  const f = await yieldOwner(t, { layout: bandPanes('band'),
    gate: async () => 'layout-waiting: an automatic dashboard pass does not rearrange' });
  const seeded = stuckJournal(f.binding), seededBytes = JSON.stringify(seeded);
  await writeJson(join(f.directory, 'placement.json'), seeded);
  await assert.rejects(FixedDagPane.prototype.arrangeDashboard.call(f.owner), { code: 'LAYOUT_WAIT' });
  assert.equal(f.yields.length, 0);
  assert.equal(readFileSync(join(f.directory, 'placement.json'), 'utf8'), seededBytes);
  assert.equal(f.calls.some(call => call[0] === 'mutate'), false);
});

test('a resolved journal keeps the five-area no-op path', async t => {
  const f = await yieldOwner(t, { layout: bandPanes('band') });
  await writeJson(join(f.directory, 'placement.json'), { ...stuckJournal(f.binding), phase: 'COMPLETE' });
  await FixedDagPane.prototype.arrangeDashboard.call(f.owner);
  assert.equal(f.yields.length, 0);
  assert.equal(f.calls.some(call => call[0] === 'process-info'), false);
  assert.equal(f.calls.some(call => call[0] === 'mutate'), false);
});
