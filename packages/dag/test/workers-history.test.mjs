import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { TaskData, normalizeTask } from '../src/task-data.mjs';
import { standaloneTasks, width, workersSections } from '../src/render.mjs';
import { renderFixedFrame } from '../src/viewer.mjs';
import { writeJson } from '../src/storage.mjs';

const sessionId = 'history-parent';
const base = Date.parse('2026-10-01T00:00:00.000Z');
const at = minutes => new Date(base + minutes * 60000).toISOString();
const work = index => `st_work${String(index).padStart(3, '0')}`;
const stop = index => `st_stop${index}`;

// 122 completed and 5 cancelled dated roots interleave by createdAt, not by
// status or ID. Two undated legacy roots sit before them, and two same-instant
// roots prove the ID tie-break. Active roots include a completed and a paused
// parent with a live descendant, which must stay above history.
function happyState() {
  const tasks = [];
  for (let index = 0; index < 122; index++) {
    tasks.push({ id: work(index), status: 'completed', createdAt: at(index * 2), description: `DONE_${index}` });
    if (index < 5) tasks.push({ id: stop(index), status: 'cancelled', createdAt: at(index * 2 + 1) });
  }
  tasks.push(
    { id: 'st_pause0', status: 'paused', createdAt: at(300) },
    { id: 'st_pause1', status: 'paused', createdAt: at(301) },
    { id: 'st_legacy0', status: 'completed' },
    { id: 'st_legacy1', status: 'completed' },
    { id: 'st_tie_b', status: 'skipped', createdAt: at(500) },
    { id: 'st_tie_a', status: 'error', createdAt: at(500) },
    { id: 'st_run0', status: 'running', createdAt: at(400) },
    { id: 'st_run1', status: 'running', createdAt: at(401) },
    { id: 'st_pending0', status: 'pending', createdAt: at(402) },
    { id: 'st_scheduled0', status: 'scheduled', createdAt: at(403) },
    { id: 'st_blocked0', status: 'blocked', createdAt: at(404) },
    { id: 'st_resume0', status: 'completed', createdAt: at(405) },
    { id: 'st_child_running', parentTaskId: 'st_resume0', status: 'running' },
    { id: 'st_pause_parent', status: 'paused', createdAt: at(406) },
    { id: 'st_child_pending', parentTaskId: 'st_pause_parent', status: 'pending' },
    { id: 'st_mystery', status: 'quarantined', createdAt: at(407) },
    { id: 'st_child_done', parentTaskId: work(0), status: 'completed' },
    { id: 'st_dag_owned', status: 'running', createdAt: at(408) },
  );
  const runs = [{ id: 'dag', nodes: [{ id: 'n', taskId: 'st_dag_owned' }], edges: [] }];
  return { connected: true, runs, tasks };
}

const historyKey = task => {
  const created = Date.parse(task.createdAt ?? '');
  const started = Date.parse(task.startedAt ?? '');
  return Number.isFinite(created) ? created : Number.isFinite(started) ? started : undefined;
};

test('122 completed + 5 cancelled + mixed active/paused roots form disjoint ordered sections covering exactly the eligible roots', () => {
  const state = happyState();
  const original = structuredClone(state);
  const sections = workersSections(state);

  const dated = [];
  for (let index = 0; index < 122; index++) {
    dated.push(work(index));
    if (index < 5) dated.push(stop(index));
  }
  const expectedActive = ['st_run0', 'st_run1', 'st_blocked0', 'st_mystery', 'st_pause_parent',
    'st_pending0', 'st_resume0', 'st_scheduled0'];
  const expectedHistory = ['st_legacy0', 'st_legacy1', ...dated, 'st_pause0', 'st_pause1', 'st_tie_a', 'st_tie_b'];
  const expectedRoots = [...expectedActive, ...expectedHistory];

  assert.deepEqual(sections.active.map(task => task.id), expectedActive);
  assert.deepEqual(sections.history.map(task => task.id), expectedHistory);
  assert.deepEqual(sections.roots.map(task => task.id), expectedRoots);
  assert.deepEqual(standaloneTasks(state).map(task => task.id), expectedRoots);

  const ids = sections.roots.map(task => task.id);
  const linked = new Set(state.runs.flatMap(run => run.nodes.map(node => node.taskId)));
  const eligible = [...new Map(state.tasks.map(task => [task.id, task])).values()]
    .filter(task => !task.parentTaskId && !linked.has(task.id)).map(task => task.id).sort();
  assert.deepEqual([...ids].sort(), eligible, 'the union is exactly the eligible root ID set');
  assert.equal(new Set(ids).size, ids.length, 'one task ID has one card');
  assert.equal(new Set(sections.active.map(task => task.id)).size, sections.active.length);
  assert.equal(new Set(sections.history.map(task => task.id)).size, sections.history.length);
  const activeIds = new Set(sections.active.map(task => task.id));
  for (const task of sections.history) assert.equal(activeIds.has(task.id), false, `${task.id} is only in one group`);

  // Classification facts, not just the count.
  const group = id => sections.active.some(task => task.id === id) ? 'active' :
    sections.history.some(task => task.id === id) ? 'history' : 'missing';
  for (const id of expectedActive) assert.equal(group(id), 'active', id);
  for (const id of expectedHistory) assert.equal(group(id), 'history', id);
  for (const id of ['st_child_running', 'st_child_pending', 'st_child_done', 'st_dag_owned']) assert.equal(group(id), 'missing', id);
  assert.equal(group('st_resume0'), 'active', 'completed root with a running descendant stays active');
  assert.equal(group('st_pause_parent'), 'active', 'paused root with a pending descendant stays active');
  assert.equal(group('st_pause0'), 'history', 'paused root without active descendants is explicit history');
  assert.equal(group('st_mystery'), 'active', 'unknown status is attention-visible');
  assert.equal(sections.history.find(task => task.id === 'st_pause0').status, 'paused');
  assert.equal(sections.history.find(task => task.id === 'st_tie_b').status, 'skipped');
  assert.equal(sections.history.find(task => task.id === 'st_tie_a').status, 'error');
  assert.equal(sections.history.find(task => task.id === work(3)).status, 'completed');
  assert.equal(sections.history.find(task => task.id === stop(0)).status, 'cancelled');

  // Undated bucket first, then one ascending chronology, ties by ID.
  assert.equal(historyKey(sections.history[0]), undefined);
  assert.equal(historyKey(sections.history[1]), undefined);
  for (let index = 2; index < sections.history.length; index++) {
    const previous = historyKey(sections.history[index - 1]);
    const current = historyKey(sections.history[index]);
    assert.notEqual(current, undefined, sections.history[index].id);
    if (previous !== undefined) assert.ok(previous <= current, `${sections.history[index - 1].id} <= ${sections.history[index].id}`);
    if (previous === current) assert.ok(sections.history[index - 1].id < sections.history[index].id);
  }
  assert.deepEqual(state, original, 'grouping does not mutate the snapshot');
});

test('a resumed task moves the same ID from history to active without a second card', () => {
  const state = happyState();
  const before = workersSections(state);
  assert.equal(before.history.some(task => task.id === work(0)), true);
  const resumed = structuredClone(state);
  resumed.tasks.find(task => task.id === work(0)).status = 'running';
  const after = workersSections(resumed);
  assert.equal(after.active.filter(task => task.id === work(0)).length, 1);
  assert.equal(after.history.some(task => task.id === work(0)), false);
  assert.equal(after.roots.filter(task => task.id === work(0)).length, 1);
  assert.equal(after.roots.length, before.roots.length);
  // Inactivity is not pause: a paused root keeps its explicit state.
  assert.equal(after.history.find(task => task.id === 'st_pause0').status, 'paused');
});

test('duplicate IDs collapse to one current card and malformed entries cannot break grouping', () => {
  const state = { runs: [], tasks: [
    { id: 'st_dup', status: 'completed', createdAt: at(1) },
    { id: 'st_keep', status: 'running' },
    { id: 'st_dup', status: 'running', createdAt: at(2) },
    { id: 'st_weird', status: 'unknown-state' },
    { status: 'running' },
    null,
  ] };
  const sections = workersSections(state);
  assert.deepEqual(sections.roots.map(task => task.id), ['st_dup', 'st_keep', 'st_weird']);
  assert.equal(sections.active.find(task => task.id === 'st_dup').status, 'running');
  assert.equal(sections.history.some(task => task.id === 'st_dup'), false);
  assert.deepEqual(workersSections({}).roots, []);
  assert.deepEqual(workersSections(undefined), { active: [], history: [], roots: [] });
  assert.deepEqual(workersSections({ tasks: {}, runs: 'nope' }), { active: [], history: [], roots: [] });
  assert.deepEqual(workersSections({ tasks: 'nope', runs: [null] }).roots, []);
});

test('native removal, truncated RPC and metrics-only updates cannot delete, duplicate or misclassify roots', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'dag-workers-history-'));
  const stateDir = join(cwd, '.omo', 'senpi-task');
  const messages = [];
  const data = new TaskData({ cwd, sessionId, notify: message => messages.push(message) });
  t.after(async () => { data.stop(); await rm(cwd, { recursive: true, force: true }); });
  const save = value => writeJson(join(stateDir, 'tasks', `${value.task_id}.json`), value);
  const runs = [{ id: 'dag', nodes: [{ id: 'n', taskId: 'st_dag' }], edges: [] }];
  await Promise.all([
    save({ task_id: 'st_done', parent_session_id: sessionId, status: 'completed', child_session_id: 'kid-session',
      created_at: '2026-10-01T00:01:00Z', terminal_at: '2026-10-01T00:02:00Z', updated_at: '2026-10-01T00:02:00Z',
      live_progress: { started_at: '2026-10-01T00:01:30Z' }, run_stats: { turns: 3 },
      spawn_spec: { prompt: 'PRIVATE_PROMPT' }, final_response: 'PRIVATE_FINAL', transcript: ['PRIVATE_TRANSCRIPT'] }),
    save({ task_id: 'st_kid', parent_session_id: 'kid-session', status: 'completed',
      created_at: '2026-10-01T00:03:00Z', terminal_at: '2026-10-01T00:03:30Z', updated_at: '2026-10-01T00:03:30Z' }),
    save({ task_id: 'st_stop', parent_session_id: sessionId, status: 'cancelled',
      created_at: '2026-10-01T00:04:00Z', terminal_at: '2026-10-01T00:04:30Z', updated_at: '2026-10-01T00:04:30Z' }),
    save({ task_id: 'st_hold', parent_session_id: sessionId, status: 'paused',
      created_at: '2026-10-01T00:05:00Z', updated_at: '2026-10-01T00:05:30Z' }),
    save({ task_id: 'st_live', parent_session_id: sessionId, status: 'running',
      created_at: '2026-10-01T00:06:00Z', updated_at: '2026-10-01T00:06:30Z' }),
    save({ task_id: 'st_dag', parent_session_id: sessionId, status: 'running',
      created_at: '2026-10-01T00:07:00Z', updated_at: '2026-10-01T00:07:30Z' }),
  ]);
  const first = await data.refresh(runs);
  const before = workersSections({ runs, tasks: first });
  assert.deepEqual(before.roots.map(task => task.id), ['st_live', 'st_done', 'st_stop', 'st_hold']);
  assert.equal(before.history.find(task => task.id === 'st_done').createdAt, '2026-10-01T00:01:00.000Z');
  assert.equal(before.history.find(task => task.id === 'st_done').startedAt, '2026-10-01T00:01:30.000Z');
  assert.deepEqual(before.active.map(task => task.id), ['st_live']);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_/);
  assert.deepEqual(messages, []);

  // Native source removal plus a truncated RPC must not remove cached roots.
  await rm(join(stateDir, 'tasks'), { recursive: true });
  assert.equal(data.receive({ parent_session_id: sessionId, tasks: [], truncated_tasks: 6 }), true);
  const second = await data.refresh(runs);
  assert.deepEqual(workersSections({ runs, tasks: second }).roots.map(task => task.id),
    before.roots.map(task => task.id));

  // A metrics-only update changes no membership, order or state.
  data.receive({ parent_session_id: sessionId, tasks: [{ task_id: 'st_done', updated_at: '2026-10-01T00:10:00Z',
    run_stats: { turns: 9, tool_calls: 2 } }] });
  const third = await data.refresh(runs);
  const after = workersSections({ runs, tasks: third });
  assert.deepEqual(after.roots.map(task => task.id), before.roots.map(task => task.id));
  assert.deepEqual(after.active.map(task => task.id), before.active.map(task => task.id));
  assert.deepEqual(after.history.map(task => task.id), before.history.map(task => task.id));
  assert.equal(after.history.find(task => task.id === 'st_done').status, 'completed');
  assert.equal(after.history.find(task => task.id === 'st_done').createdAt, '2026-10-01T00:01:00.000Z');
  assert.equal(after.history.find(task => task.id === 'st_done').turns, 9);
  assert.equal(after.history.some(task => task.id === 'st_kid' || task.id === 'st_dag'), false);
});

test('restore -> snapshot -> restore keeps created and started distinct and the total order transitive', () => {
  const source = [
    { id: 'st_running', status: 'running', description: 'R', createdAt: at(10), startedAt: at(11), reportedAt: at(12) },
    { id: 'st_late_completed', status: 'completed', description: 'C', createdAt: at(20), startedAt: at(21), completedAt: at(22) },
    { id: 'st_legacy', status: 'completed', description: 'L', startedAt: at(30), completedAt: at(31) },
    { id: 'st_created_only', status: 'cancelled', description: 'X', createdAt: at(40), completedAt: at(41) },
  ];
  const first = new TaskData({ cwd: '/unused', sessionId });
  first.restore(source);
  const snapshot = first.snapshot();
  first.stop();
  assert.equal(snapshot.find(task => task.id === 'st_running').createdAt, at(10));
  assert.equal(snapshot.find(task => task.id === 'st_running').startedAt, at(11));
  assert.equal(snapshot.find(task => task.id === 'st_legacy').createdAt, undefined);
  assert.equal(snapshot.find(task => task.id === 'st_legacy').startedAt, at(30));
  assert.equal(snapshot.find(task => task.id === 'st_created_only').createdAt, at(40));
  assert.equal(snapshot.find(task => task.id === 'st_created_only').startedAt, at(40));

  const second = new TaskData({ cwd: '/unused', sessionId });
  second.restore(snapshot);
  const roundTrip = second.snapshot();
  second.stop();
  assert.deepEqual(roundTrip, snapshot);
  assert.equal(roundTrip.find(task => task.id === 'st_legacy').createdAt, undefined);

  const state = { tasks: snapshot };
  const history = workersSections(state).history;
  assert.deepEqual(history.map(task => task.id), ['st_late_completed', 'st_legacy', 'st_created_only']);
  for (let index = 0; index < history.length; index++) for (let other = index + 1; other < history.length; other++) {
    const first = historyKey(history[index]), later = historyKey(history[other]);
    if (first === undefined) assert.equal(later, undefined, `${history[other].id} stays in the undated bucket`);
    else assert.ok(later !== undefined && first <= later, `${history[index].id} <= ${history[other].id}`);
  }
});

test('normalize keeps created_at distinct from a later live start and never invents it', () => {
  const raw = { task_id: 'st_projection', parent_session_id: sessionId, status: 'running',
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:10Z',
    live_progress: { started_at: '2026-10-01T00:00:05Z', activity: 'thinking' } };
  const projected = normalizeTask(raw);
  assert.equal(projected.createdAt, '2026-10-01T00:00:00.000Z');
  assert.equal(projected.startedAt, '2026-10-01T00:00:05.000Z');
  assert.equal(normalizeTask({ task_id: 'st_legacy_live', live_progress: { started_at: '2026-10-01T00:00:05Z' } }).createdAt,
    undefined);
  assert.equal(normalizeTask({ task_id: 'st_no_dates' }).createdAt, undefined);
});

function onlyHistoryState() {
  const tasks = [];
  for (let index = 0; index < 122; index++) {
    tasks.push({ id: work(index), status: 'completed', createdAt: at(index * 2), description: `DONE_${index}` });
    if (index < 5) tasks.push({ id: stop(index), status: 'cancelled', createdAt: at(index * 2 + 1), description: `STOP_${index}` });
  }
  return { connected: true, runs: [], language: 'en', tasks };
}

test('renderer paints every eligible history root at 54 and 25 columns with a bounded viewport', () => {
  const state = onlyHistoryState();
  const sections = workersSections(state);
  const ids = sections.roots.map(task => task.id);
  assert.equal(ids.length, 127);
  assert.deepEqual(ids, sections.history.map(task => task.id));

  for (const columns of [54, 25]) {
    const frame = renderFixedFrame(state, { columns, rows: 20, color: false }, 'tasks');
    assert.deepEqual(Object.keys(frame.taskRanges), ids, `${columns}: taskRanges follow the single root index`);
    assert.equal(new Set(Object.keys(frame.taskRanges)).size, 127);
    const lines = frame.text.split('\n');
    assert.ok(lines.length <= 20, `${columns}: viewport is bounded`);
    assert.ok(lines.every(line => width(line) <= columns - 1), `${columns}: no line overflows`);
    const plain = stripVTControlCharacters(frame.text);
    assert.match(plain, /\[122\/127\]/);
    assert.match(plain, /History \(127\)/);
    if (columns === 54) assert.match(plain, /Completed tasks \(122\)/);
    // The newest cards are outside this viewport but still have ranges.
    assert.ok(frame.taskRanges[ids.at(-1)].start >= frame.bodyRows);
    assert.doesNotMatch(plain, /DONE_121/);
  }

  const last = ids.at(-1);
  const tail = renderFixedFrame(state, { columns: 25, rows: 20, color: false, scroll: 10_000 }, 'tasks');
  assert.match(stripVTControlCharacters(tail.text), /DONE_121/);
  assert.ok(tail.taskRanges[last].start > tail.scroll);
  const selected = renderFixedFrame(state, { columns: 25, rows: 20, color: false,
    selectedTaskId: last, revealSelection: true }, 'tasks');
  assert.match(stripVTControlCharacters(selected.text), /DONE_121/);
  assert.deepEqual(Object.keys(selected.taskRanges), ids);
});

test('selection and detail toggles change card depth but never history membership', () => {
  const state = { connected: true, runs: [], tasks: [
    { id: 'st_done', status: 'completed', description: 'DONE_STATS', turns: 3 },
    { id: 'st_cancelled', status: 'cancelled', description: 'CANCELLED_ROOT' },
    { id: 'st_live', status: 'running', description: 'LIVE_ROOT' },
  ] };
  const ids = workersSections(state).roots.map(task => task.id);
  assert.deepEqual(ids, ['st_live', 'st_cancelled', 'st_done']);
  const base = renderFixedFrame(state, { columns: 54, rows: 30, color: false }, 'tasks');
  assert.deepEqual(Object.keys(base.taskRanges), ids);
  assert.equal(base.taskRanges.st_done.end - base.taskRanges.st_done.start, 1);
  for (const options of [
    { viewState: { expanded: { '[null,"st_done"]': true } } },
    { selectedTaskId: 'st_done', revealSelection: true },
    { completedExpanded: true },
    { selectedTaskId: 'st_done', verbose: true },
  ]) {
    const frame = renderFixedFrame(state, { columns: 54, rows: 40, color: false, ...options }, 'tasks');
    assert.deepEqual(Object.keys(frame.taskRanges), ids, JSON.stringify(options));
    assert.match(stripVTControlCharacters(frame.text), /CANCELLED_ROOT/);
  }
  const detail = renderFixedFrame(state, { columns: 54, rows: 40, color: false, completedExpanded: true }, 'tasks');
  assert.ok(detail.taskRanges.st_done.end - detail.taskRanges.st_done.start > 1, 'detail depth grows');
});

test('failed descendants stay visible and nested or DAG-linked tasks never become history roots', () => {
  const state = { connected: true,
    runs: [{ id: 'run', status: 'running', nodes: [{ id: 'n', taskId: 'st_dag_linked' }], edges: [] }],
    tasks: [
      { id: 'st_parent', status: 'completed', description: 'PARENT_ROOT' },
      { id: 'st_failed_child', parentTaskId: 'st_parent', status: 'failed', description: 'FAILED_CHILD' },
      { id: 'st_dag_linked', status: 'running', description: 'DAG_LINKED' },
      { id: 'st_cancelled', status: 'cancelled', description: 'CANCELLED_ROOT' },
    ] };
  assert.deepEqual(workersSections(state).roots.map(task => task.id), ['st_cancelled', 'st_parent']);
  for (const completedExpanded of [false, true]) {
    const frame = renderFixedFrame(state, { columns: 54, rows: 30, color: false, completedExpanded }, 'tasks');
    const plain = stripVTControlCharacters(frame.text);
    assert.deepEqual(Object.keys(frame.taskRanges), ['st_cancelled', 'st_parent']);
    assert.match(plain, /FAILED_CHILD/);
    assert.equal(frame.taskRanges.st_failed_child, undefined);
    assert.equal(frame.taskRanges.st_dag_linked, undefined);
  }
});

test('explicit collapse keeps failed and actionable descendants visible at 54 and 25 columns', () => {
  const state = { connected: true, runs: [], tasks: [
    { id: 'st_history_parent', status: 'completed', description: 'HISTORY_PARENT' },
    { id: 'st_failed_child', parentTaskId: 'st_history_parent', status: 'failed', description: 'FAILED_CHILD' },
    { id: 'st_active_parent', status: 'completed', description: 'ACTIVE_PARENT' },
    { id: 'st_running_child', parentTaskId: 'st_active_parent', status: 'running', description: 'RUNNING_CHILD' },
  ] };
  const viewState = { expanded: { '[null,"st_history_parent"]': false, '[null,"st_active_parent"]': false } };
  const roots = ['st_active_parent', 'st_history_parent'];
  for (const columns of [54, 25]) for (const completedExpanded of [false, true]) for (const selectedTaskId of [undefined, 'st_history_parent']) {
    const frame = renderFixedFrame(state, { columns, rows: 40, color: false, viewState, completedExpanded, selectedTaskId }, 'tasks');
    const plain = stripVTControlCharacters(frame.text);
    const label = `${columns}/${completedExpanded}/${Boolean(selectedTaskId)}`;
    assert.deepEqual(Object.keys(frame.taskRanges), roots, label);
    assert.match(plain, /FAILED_CHILD/, label);
    assert.match(plain, /RUNNING_CHILD/, label);
    assert.equal(plain.split('FAILED_CHILD').length - 1, 1, `${label}: failed child appears once`);
    assert.equal(plain.split('RUNNING_CHILD').length - 1, 1, `${label}: running child appears once`);
    assert.equal(frame.taskRanges.st_failed_child, undefined, label);
    assert.equal(frame.taskRanges.st_running_child, undefined, label);
    assert.ok(frame.taskRanges.st_history_parent.end - frame.taskRanges.st_history_parent.start > 1, label);
    assert.ok(frame.taskRanges.st_active_parent.end - frame.taskRanges.st_active_parent.start > 1, label);
  }
});

test('replacing a healthy child with a failed task invalidates collapsed history formatting', () => {
  for (const columns of [54, 25]) {
    let reads = 0;
    const parent = { id: 'st_cache_parent', status: 'completed',
      get description() { reads++; return 'CACHE_PARENT'; } };
    const state = { connected: true, runs: [], tasks: [parent,
      { id: 'st_cache_child', parentTaskId: 'st_cache_parent', status: 'completed', description: 'HEALTHY_CHILD' }] };
    const viewState = { expanded: { '[null,"st_cache_parent"]': false } };
    const draw = options => renderFixedFrame(state, { columns, rows: 16, color: false, ...options, viewState }, 'tasks');

    const healthy = draw({ now: 1000, frame: 0 });
    const healthyPlain = stripVTControlCharacters(healthy.text);
    assert.doesNotMatch(healthyPlain, /FAILED_CHILD/, `${columns}: no failed attention before the replacement`);
    assert.equal(healthy.taskRanges.st_cache_parent.end - healthy.taskRanges.st_cache_parent.start, 1, `${columns}: healthy child folds`);
    const readsAfterHealthy = reads;
    const clock = draw({ now: 9000, frame: 7 });
    assert.equal(reads, readsAfterHealthy, `${columns}: clock-only frame reuses the card`);
    assert.equal(clock.text, healthy.text);

    // The parent and the task array keep their identity; only the child object
    // and its status change, as an incremental snapshot replacement does.
    state.tasks[1] = { id: 'st_cache_child', parentTaskId: 'st_cache_parent', status: 'failed', description: 'FAILED_CHILD' };
    const failed = draw({ now: 9000, frame: 7 });
    const failedPlain = stripVTControlCharacters(failed.text);
    assert.match(failedPlain, /FAILED_CHILD/, `${columns}: replaced failed child must invalidate collapsed history formatting`);
    assert.equal(failedPlain.split('FAILED_CHILD').length - 1, 1, `${columns}: failed child appears once`);
    assert.ok(failed.taskRanges.st_cache_parent.end - failed.taskRanges.st_cache_parent.start > 1, `${columns}: attention line grows the card`);
    assert.equal(failed.taskRanges.st_cache_child, undefined, `${columns}: child is not a root`);
    assert.ok(reads > readsAfterHealthy, `${columns}: changed descendant invalidates the cache`);
    const readsAfterFailed = reads;
    const clockAfter = draw({ now: 50000, frame: 9 });
    assert.equal(reads, readsAfterFailed, `${columns}: clock-only frame after the change still reuses`);
    assert.equal(clockAfter.text, failed.text);
  }
});

test('selected verbose history detail invalidates on a replaced child and collapsed cards still reuse', () => {
  const viewState = { expanded: { '[null,"st_verbose_parent"]': false, '[null,"st_collapsed_parent"]': false } };
  for (const columns of [54, 25]) {
    let reads = 0;
    const parent = { id: 'st_verbose_parent', status: 'completed',
      get description() { reads++; return 'VERBOSE_PARENT'; } };
    let state = { connected: true, runs: [], tasks: [parent,
      { id: 'st_verbose_child', parentTaskId: 'st_verbose_parent', status: 'completed', description: 'OLD_CHILD' }] };
    const draw = options => renderFixedFrame(state, { columns, rows: 60, color: false, follow: false,
      viewState, selectedTaskId: 'st_verbose_parent', verbose: true, ...options }, 'tasks');

    const first = draw({ now: 1000, frame: 0 });
    const firstPlain = stripVTControlCharacters(first.text);
    assert.match(firstPlain, /OLD_CHILD/, `${columns}: verbose detail starts with the old child`);
    const readsAfterFirst = reads;
    const clock = draw({ now: 9000, frame: 7 });
    assert.equal(reads, readsAfterFirst, `${columns}: verbose clock tick reuses`);
    assert.equal(clock.text, first.text);

    // Keep the parent object; replace the child object and the task array.
    state = { ...state, tasks: [parent,
      { id: 'st_verbose_child', parentTaskId: 'st_verbose_parent', status: 'completed', description: 'NEW_CHILD' }] };
    const changed = draw({ now: 9000, frame: 7 });
    const changedPlain = stripVTControlCharacters(changed.text);
    assert.match(changedPlain, /NEW_CHILD/, `${columns}: verbose detail must rerender the replaced child`);
    assert.doesNotMatch(changedPlain, /OLD_CHILD/, `${columns}: stale child text must be gone`);
    assert.equal(changedPlain.split('NEW_CHILD').length - 1, 1, `${columns}: new child appears once`);
    assert.equal(changed.taskRanges.st_verbose_child, undefined, `${columns}: child is not a root`);
    assert.ok(reads > readsAfterFirst, `${columns}: verbose detail invalidates on the new task array`);
    const readsAfterChanged = reads;
    const clockAfter = draw({ now: 50000, frame: 9 });
    assert.equal(reads, readsAfterChanged, `${columns}: verbose clock tick after the change reuses`);
    assert.equal(clockAfter.text, changed.text);

    // The collapsed non-selected history card keeps its own clock-only cache hit.
    let collapsedReads = 0;
    const collapsedParent = { id: 'st_collapsed_parent', status: 'completed',
      get description() { collapsedReads++; return 'COLLAPSED_PARENT'; } };
    const collapsedState = { connected: true, runs: [], tasks: [collapsedParent,
      { id: 'st_collapsed_child', parentTaskId: 'st_collapsed_parent', status: 'completed', description: 'SAFE_CHILD' }] };
    const collapsedDraw = options => renderFixedFrame(collapsedState, { columns, rows: 16, color: false,
      follow: false, viewState, ...options }, 'tasks');
    const collapsed = collapsedDraw({ now: 1000, frame: 0 });
    const collapsedReadsAfter = collapsedReads;
    const collapsedClock = collapsedDraw({ now: 9000, frame: 7 });
    assert.equal(collapsedReads, collapsedReadsAfter, `${columns}: collapsed clock tick reuses`);
    assert.equal(collapsedClock.text, collapsed.text);
  }
});

test('clock-only frames reuse unchanged history formatting and fresh empty runs arrays do not invalidate it', () => {
  let descriptionReads = 0;
  const history = { id: 'st_cached', status: 'completed', turns: 2,
    get description() { descriptionReads++; return 'CACHED_HISTORY'; } };
  const state = { connected: true, runs: [], tasks: [history] };
  const options = { columns: 54, rows: 12, color: false, now: 1000, frame: 0 };
  const first = renderFixedFrame(state, options, 'tasks');
  const reads = descriptionReads;
  assert.ok(reads > 0);
  assert.match(stripVTControlCharacters(first.text), /CACHED_HISTORY/);

  const clockOnly = renderFixedFrame(state, { ...options, now: 9000, frame: 7 }, 'tasks');
  assert.equal(descriptionReads, reads, 'clock tick must not rebuild unchanged history cards');
  assert.equal(clockOnly.text, first.text);

  const freshRuns = renderFixedFrame({ ...state, runs: [] }, { ...options, now: 50000, frame: 3, scroll: 0 }, 'tasks');
  assert.equal(descriptionReads, reads, 'a fresh empty runs array must not invalidate history cards');
  assert.deepEqual(Object.keys(freshRuns.taskRanges), ['st_cached']);

  const narrow = renderFixedFrame(state, { ...options, columns: 25, now: 9000, frame: 7 }, 'tasks');
  assert.ok(descriptionReads > reads, 'width is a real formatting input');
  assert.match(stripVTControlCharacters(narrow.text), /CACHED_HISTORY/);

  const changed = renderFixedFrame({ connected: true, runs: [], tasks: [
    { id: 'st_cached', status: 'completed', turns: 2, description: 'CHANGED_HISTORY' }] }, options, 'tasks');
  assert.match(stripVTControlCharacters(changed.text), /CHANGED_HISTORY/);
  assert.doesNotMatch(stripVTControlCharacters(changed.text), /CACHED_HISTORY/);
});

test('1270 history roots keep one ordered range per root and expose oldest, middle and newest', () => {
  const tasks = Array.from({ length: 1270 }, (_, index) => ({ id: `st_big${String(index).padStart(4, '0')}`,
    status: 'completed', createdAt: at(index), description: `ROOT_${String(index).padStart(4, '0')}` }));
  const state = { connected: true, runs: [], tasks };
  const sections = workersSections(state);
  const ids = sections.roots.map(task => task.id);
  assert.equal(ids.length, 1270);
  assert.deepEqual(ids, sections.history.map(task => task.id));
  const all = renderFixedFrame(state, { columns: 25, rows: 20, color: false, follow: false }, 'tasks');
  assert.deepEqual(Object.keys(all.taskRanges), ids);
  assert.equal(new Set(Object.keys(all.taskRanges)).size, 1270);
  for (const index of [0, 635, 1269]) {
    const id = ids[index];
    const frame = renderFixedFrame(state, { columns: 25, rows: 20, color: false, follow: false,
      scroll: all.taskRanges[id].start }, 'tasks');
    assert.ok(frame.taskRanges[id].start < frame.scroll + frame.bodyRows &&
      frame.taskRanges[id].end > frame.scroll, `${index}: target is reachable in the viewport`);
    assert.match(stripVTControlCharacters(frame.text), new RegExp(`ROOT_${String(index).padStart(4, '0')}`));
  }
});
