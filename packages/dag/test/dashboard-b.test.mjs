import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messages } from '../src/i18n.mjs';
import { renderFrame, spinnerFrames, width } from '../src/render.mjs';
import { TaskData, normalizeTask } from '../src/task-data.mjs';
import { createAnimation, createReadGrace, renderFixedFrame } from '../src/viewer.mjs';

function fakeClock() {
  let now = 0, id = 0;
  const timers = new Map();
  const schedule = (callback, delay, repeat) => {
    timers.set(++id, { callback, at: now + delay, delay, repeat });
    return id;
  };
  return {
    timers, now: () => now,
    setInterval: (callback, delay) => schedule(callback, delay, true),
    setTimeout: (callback, delay) => schedule(callback, delay, false),
    clearInterval: handle => timers.delete(handle),
    clearTimeout: handle => timers.delete(handle),
    advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        const [handle, timer] = next;
        now = timer.at;
        if (timer.repeat) timer.at += timer.delay;
        else timers.delete(handle);
        timer.callback();
      }
      now = end;
    },
  };
}

test('running-only animation starts, cycles, stops, restarts and disposes on an injected clock', () => {
  const clock = fakeClock(), painted = [];
  const animation = createAnimation(() => painted.push(animation.frame), clock);
  animation.update({ connected: true, tasks: [{ status: 'pending' }] });
  assert.equal(clock.timers.size, 0);
  animation.update({ connected: true, tasks: [{ status: 'running' }] });
  animation.update({ connected: true, tasks: [{ status: 'running' }] });
  assert.equal(clock.timers.size, 1);
  clock.advance(124);
  assert.deepEqual(painted, []);
  clock.advance(1126);
  assert.deepEqual(painted, Array.from({ length: 10 }, (_, index) => index + 1));
  animation.update({ connected: true, tasks: [{ status: 'completed' }] });
  assert.equal(clock.timers.size, 0);
  clock.advance(1000);
  assert.equal(painted.length, 10);
  animation.update({ connected: true, runs: [{ nodes: [{ state: 'running' }] }] });
  clock.advance(125);
  assert.equal(painted.at(-1), 11);
  animation.update({ connected: false, tasks: [{ status: 'running' }] });
  assert.equal(clock.timers.size, 0);
  animation.update({ connected: true, tasks: [{ parentTaskId: 'root', status: 'running' }] });
  assert.equal(clock.timers.size, 1);
  animation.stop();
  assert.equal(clock.timers.size, 0);
});

test('transient read gaps cancel before 2s while sustained gaps report at the first deadline', () => {
  const clock = fakeClock(), reported = [];
  const grace = createReadGrace(error => reported.push(error), clock);
  grace.fail('missing');
  clock.advance(1999);
  assert.deepEqual(reported, []);
  grace.clear();
  clock.advance(1);
  assert.deepEqual(reported, []);
  grace.fail('first');
  clock.advance(1000);
  grace.fail('latest');
  clock.advance(999);
  assert.deepEqual(reported, []);
  clock.advance(1);
  assert.deepEqual(reported, ['latest']);
  grace.fail('cancelled');
  grace.clear();
  assert.equal(clock.timers.size, 0);
});

const raw = extra => ({ task_id: 'st_root', parent_session_id: 'root-session', status: 'running', ...extra });
test('resolved model ID and explicit reasoning precedence normalize and survive restore without variant guesses', () => {
  const task = normalizeTask(raw({
    resolved_model: { model_id: 'Provider/MODEL-ID', display: 'Display', reasoning_effort: 'high', variant: 'other' },
    requested_model: { reasoning_effort: 'medium' }, effective_model: { reasoning_effort: 'low' }, model: 'fallback',
  }));
  assert.equal(task.model, 'provider/model-id');
  assert.equal(task.reasoningEffort, 'high');
  assert.equal(normalizeTask(raw({ requested_model: { reasoning_effort: 'medium' },
    effective_model: { reasoning_effort: 'low' } })).reasoningEffort, 'medium');
  assert.equal(normalizeTask(raw({ effective_model: { reasoning_effort: 'low' } })).reasoningEffort, 'low');
  assert.equal(normalizeTask(raw({ resolved_model: { variant: 'high', display: 'Display' } })).model, 'Display');
  assert.equal(normalizeTask(raw({ resolved_model: { variant: 'high' } })).reasoningEffort, undefined);
  assert.equal(normalizeTask(raw({ model: 'Fallback' })).model, 'Fallback');
  const supplied = normalizeTask(raw({ resolved_model: { model_id: 'gpt-6.1-sol',
    display: 'GPT-6.1 Sol', reasoning_effort: 'xhigh', variant: 'high' }, effective_model: {} }));
  assert.equal(supplied.model, 'gpt-6.1-sol');
  assert.equal(supplied.reasoningEffort, 'xhigh');
  const data = new TaskData({ cwd: '/unused', sessionId: 'root-session' });
  data.restore([task]);
  assert.deepEqual(data.snapshot(), [task]);
  data.stop();
});

test('all ten width-one frames reach running root, descendants, graph and detail without mutating state', () => {
  const state = { connected: true, tasks: [
    { id: 'st_root', status: 'running', description: 'ROOT' },
    { id: 'st_child', parentTaskId: 'st_root', status: 'running', description: 'CHILD' },
    { id: 'st_grand', parentTaskId: 'st_child', status: 'running', description: 'GRAND' },
  ], runs: [] };
  const before = structuredClone(state);
  assert.equal(new Set(spinnerFrames).size, 10);
  for (const [frame, glyph] of spinnerFrames.entries()) {
    assert.equal(width(glyph), 1);
    const options = { frame, now: 0, columns: 80, rows: 100, color: false };
    const workers = renderFrame(state, options).text;
    for (const label of ['ROOT', 'CHILD', 'GRAND']) assert.ok(workers.includes(`${glyph} ${label}`));
    const run = { id: 'run', name: 'RUN', status: 'running',
      nodes: [{ id: 'node', label: 'NODE', state: 'running', taskId: 'st_root' }], edges: [] };
    const dag = renderFrame({ ...state, runs: [run] }, { ...options, selectedNodeId: 'node', verbose: true }).text;
    assert.equal(dag.split(`${glyph} ${messages.en.running}`).length - 1, 2);
    assert.doesNotMatch(workers + dag, /●/);
  }
  assert.deepEqual(state, before);
});

test('depth-two session ownership, localized child markers and model suffix survive the width sweep', () => {
  const data = new TaskData({ cwd: '/unused', sessionId: 'root-session' });
  data.merge(raw({ child_session_id: 'child-session',
    description: `DESCRIPTION_HEAD ${'wrapped description words '.repeat(12)}DESCRIPTION_TAIL`,
    resolved_model: { model_id: 'PROVIDER/A-VERY-LONG-MODEL-NAME', reasoning_effort: 'xhigh' } }));
  data.merge({ task_id: 'st_child', parent_session_id: 'child-session', child_session_id: 'grand-session',
    status: 'running', description: 'CHILD' });
  data.merge({ task_id: 'st_grand', parent_session_id: 'grand-session', status: 'running', description: 'GRAND' });
  const tasks = data.snapshot();
  assert.equal(tasks.find(task => task.id === 'st_grand').parentTaskId, 'st_child');
  const state = { connected: true, runs: [], tasks };
  for (const language of ['en', 'ko', 'zh-cn']) for (const columns of [24, 30, 40, 54, 80, 120]) {
    const options = { language, columns, rows: 100, color: false, frame: 9, now: 0, selectedTaskId: 'st_root' };
    const frame = renderFrame(state, options);
    assert.ok(frame.text.split('\n').every(line => width(line) < columns));
    assert.ok(frame.text.includes(':xhigh'));
    assert.doesNotMatch(frame.text, /provider\//i);
    const children = frame.text.split('\n').filter(line => line.includes('↳'));
    assert.equal(children.length, 2);
    for (const line of children) assert.ok(line.includes(messages[language].subtask));
    assert.ok(children[1].indexOf('↳') > children[0].indexOf('↳'));
    const detail = renderFrame(state, { ...options, verbose: true }).text;
    assert.doesNotMatch(detail, /provider\//i);
    assert.ok(detail.includes(':xhigh'));
    const content = detail.replace(/[\s│]/gu, '');
    assert.ok(content.includes('DESCRIPTION_HEAD'));
    assert.ok(content.includes('DESCRIPTION_TAIL'));
    assert.ok(detail.split('\n').every(line => width(line) < columns));
    for (const view of ['tasks', 'dag']) {
      const source = view === 'dag' ? { ...state, runs: [{ id: 'run', name: 'RUN', status: 'running',
        nodes: [{ id: 'node', label: 'NODE', state: 'running', taskId: 'st_root' }], edges: [] }] } : state;
      const fixed = renderFixedFrame({ ...source, language }, options, view);
      assert.ok(fixed.text.split('\n').every(line => width(line) < columns));
    }
  }
  data.stop();
});

test('labelled worker details wrap with a stable hanging indent while compact cards retain five lines', () => {
  const task = { id: 'root', status: 'running', description: 'HEAD '.repeat(14) + 'TAIL',
    progress: 'PROGRESS '.repeat(8) + 'END' };
  const state = { connected: true, tasks: [task], runs: [] };
  const options = { columns: 30, rows: 100, color: false, selectedTaskId: 'root', frame: 0, now: 0 };
  const frame = renderFrame(state, options), range = frame.taskRanges.root;
  const lines = frame.text.split('\n').slice(frame.bodyStart + range.start, frame.bodyStart + range.end);
  assert.equal(lines.length, 7);
  const detail = renderFrame(state, { ...options, verbose: true }).text.split('\n');
  const label = `${messages.en.description}: `;
  const at = detail.findIndex(line => line.includes(label));
  assert.ok(at >= 0);
  assert.ok(detail[at + 1].startsWith(`│ ${' '.repeat(width(label))}`));
  const content = detail.join('').replace(/[\s│]/gu, '');
  assert.ok(content.includes('TAIL') && content.includes('END'));
  assert.ok(detail.every(line => width(line) < options.columns));
});
