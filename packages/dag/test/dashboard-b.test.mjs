import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { messages, t } from '../src/i18n.mjs';
import { laneLines, renderFrame, spinnerFrames, width } from '../src/render.mjs';
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
    assert.ok(dag.includes(`${glyph} NODE`), 'flow line and card carry the spinner');
    assert.equal(dag.split(`${glyph} ${messages.en.running}`).length - 1, 1);
    assert.doesNotMatch(workers + dag, /●/);
  }
  assert.deepEqual(state, before);
});

test('depth-two session ownership, localized child groups and aligned arrows survive the width sweep', () => {
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
    for (const line of children) assert.ok(!line.includes(`↳ ${messages[language].subtask}`));
    assert.equal(children[1].indexOf('↳'), children[0].indexOf('↳'));
    assert.ok(frame.text.includes(t(language, 'subtasksCount', { count: 2 })));
    const detail = renderFrame(state, { ...options, verbose: true }).text;
    assert.doesNotMatch(detail, /provider\//i);
    assert.ok(detail.includes(':xhigh'));
    const content = detail.replace(/[\s│┆]/gu, '');
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

test('labelled worker details wrap with a stable hanging indent while compact cards keep only content rows', () => {
  const task = { id: 'root', status: 'running', description: 'HEAD '.repeat(14) + 'TAIL',
    progress: 'PROGRESS '.repeat(8) + 'END' };
  const state = { connected: true, tasks: [task], runs: [] };
  const options = { columns: 30, rows: 100, color: false, selectedTaskId: 'root', frame: 0, now: 0 };
  const frame = renderFrame(state, options), range = frame.taskRanges.root;
  const lines = frame.text.split('\n').slice(frame.bodyStart + range.start, frame.bodyStart + range.end);
  assert.equal(lines.length, 3);
  assert.doesNotMatch(lines.join('\n'), /PROGRESS/);
  const detail = renderFrame(state, { ...options, verbose: true }).text.split('\n');
  const label = `${messages.en.description}: `;
  const at = detail.findIndex(line => line.includes(label));
  assert.ok(at >= 0);
  assert.ok(detail[at + 1].startsWith(`│ ${' '.repeat(width(label) - 2)}┆ `));
  const content = detail.join('').replace(/[\s│]/gu, '');
  assert.ok(content.includes('TAIL') && content.includes('END'));
  assert.ok(detail.every(line => width(line) < options.columns));
});

const cardNow = Date.parse('2026-10-14T00:01:00.000Z');
const cardState = () => ({ connected: true, updatedAt: '2026-10-14T00:01:00.000Z', runs: [], tasks: [
  { id: 'root', description: 'ROOT_TITLE', agent: 'deep-high', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh',
    status: 'running', startedAt: '2026-10-14T00:00:00.000Z', progress: 'ROOT_PROGRESS' },
  { id: 'child', parentTaskId: 'root', description: 'CHILD_TITLE', agent: 'deep-low', model: 'gpt-6.1-sol',
    reasoningEffort: 'medium', status: 'running' },
  { id: 'grandchild', parentTaskId: 'child', description: 'GRAND_TITLE', agent: 'quick', model: 'gpt-6.1-sol',
    reasoningEffort: 'low', status: 'pending' },
] });
const cardRun = { id: 'run', name: 'RUN', status: 'running', edges: [],
  nodes: [{ id: 'node', label: 'NODE', state: 'running', taskId: 'root' }] };
const cardLines = (frame, range) => frame.text.split('\n')
  .slice(frame.bodyStart + range.start - frame.scroll, frame.bodyStart + range.end - frame.scroll);

test('approved child cards retain their group and arrows without extra indentation; a finished child folds to its title', () => {
  const state = cardState();
  Object.assign(state.tasks[0], { agent: 'deep-low', turns: 41, toolCalls: 11 });
  Object.assign(state.tasks[1], { agent: 'unspecified-low', model: 'claude-sonnet-5-5',
    status: 'completed', startedAt: new Date(cardNow - 60000).toISOString(),
    completedAt: new Date(cardNow - 32000).toISOString(), turns: 5, toolCalls: 3,
    metrics: { cost_usd: 0.1242, cost_status: 'reported', tokens_per_second: 604 } });
  const before = structuredClone(state);
  for (const language of ['en', 'ko', 'zh-cn']) for (const columns of [24, 30, 32, 40, 54, 80, 120]) {
    for (const view of ['tasks', 'dag']) {
      const source = { ...state, runs: view === 'dag' ? [cardRun] : [] };
      const options = { language, columns, rows: 160, color: false, frame: 0,
        now: cardNow, view, selectedTaskId: 'root', selectedNodeId: 'node' };
      const frame = renderFrame(source, options);
      const lines = cardLines(frame, view === 'dag' ? frame.nodeRanges.node : frame.taskRanges.root);
      if (view === 'dag') {
        // A DAG card lists the subtasks as the worker card does; the finished child shows no role or cost.
        assert.ok(lines.some(line => line.includes('↳ ✓ CHILD')) && lines.some(line => line.includes('↳ ○ GRAND')));
        assert.ok(!lines.some(line => line.includes('$0.1242')));
        continue;
      }
      const group = t(language, 'subtasksCount', { count: 2 });
      assert.equal(lines.filter(line => line.includes(group)).length, 1);
      // A narrow title gives way to the elapsed time at its end, so match the start of each name.
      const childAt = lines.findIndex(line => line.includes('↳ ✓ CHILD'));
      const grandAt = lines.findIndex(line => line.includes('↳ ○ GRAND'));
      assert.ok(childAt >= 0 && grandAt > childAt);
      const contentAt = lines.find(line => line.includes('[deep-low]')).indexOf('[');
      assert.equal(lines[childAt].indexOf('↳'), contentAt);
      assert.equal(lines[grandAt].indexOf('↳'), contentAt);
      // The completed child is one title row: its role and cost fold away and its elapsed time ends the title.
      const child = lines.slice(childAt, grandAt);
      assert.equal(child.length, 1, `${language} ${columns} ${view}`);
      assert.ok(!child.some(line => /\$0\.1242|unspecified-low/.test(line)));
      // The pending grandchild keeps its metadata, aligned under the arrows.
      const badge = lines.slice(grandAt + 1).find(line => line.includes('['));
      assert.equal(badge.indexOf('['), contentAt);
      if (columns >= 32) assert.ok(badge.includes('[quick]'));
      for (const line of lines.slice(childAt)) assert.ok(!line.includes(`↳ ${messages[language].subtask}`));
      assert.ok(frame.text.split('\n').every(line => width(line) < columns));
      const colored = renderFrame(source, { ...options, color: true });
      assert.equal(stripVTControlCharacters(colored.text), frame.text);
    }
  }
  assert.deepEqual(state, before);
});

test('worker and DAG cards follow their content with role badges, a time mark and no blank rows', () => {
  for (const language of ['en', 'ko']) for (const columns of [40, 80]) for (const view of ['tasks', 'dag']) {
    const state = { ...cardState(), runs: view === 'dag' ? [cardRun] : [] };
    const options = { language, columns, rows: 100, color: false, frame: 0, now: cardNow, view,
      selectedTaskId: 'root', selectedNodeId: 'node' };
    const frame = renderFrame(state, options);
    const card = cardLines(frame, view === 'dag' ? frame.nodeRanges.node : frame.taskRanges.root);
    const sub = messages[language].subtask;
    const rows = card.slice(1, -1).map(line => line.slice(2, -2).trimEnd());
    // Worker cards drop a healthy task's message row; DAG node cards still show it.
    const divider = view === 'dag' ? 4 : 3;
    assert.deepEqual([...rows.slice(0, divider), ...rows.slice(divider + 1)], ['⠋ ROOT_TITLE', '[deep-high] gpt-6.1-sol:xhigh',
      ...(view === 'dag' ? ['ROOT_PROGRESS'] : []), `⧖ ${language === 'en' ? '1m 0s' : '1분 0초'}`, `  ↳ ${sub} ⠋ CHILD_TITLE`,
      '  [deep-low] gpt-6.1-sol:medium', `    ↳ ${sub} ○ GRAND_TITLE`, '    [quick] gpt-6.1-sol:low'], `${view} ${columns}`);
    if (view !== 'dag') assert.doesNotMatch(card.join('\n'), /ROOT_PROGRESS/);
    assert.ok(rows[divider].startsWith(`─ ${t(language, 'subtasksCount', { count: 2 })} ─`), rows[divider]);
    assert.ok(rows.every(row => row.trim()), 'no blank row inside the card');
    assert.equal(card.join('\n').split('⧖').length - 1, 1);
    assert.ok(card.every(line => width(line) === columns - 1 && line.endsWith('│') || /^[╭╰]/.test(line) &&
      width(line) === columns - 1), 'card borders align');
    assert.ok(frame.text.split('\n').every(line => width(line) < columns));
    const colored = renderFrame(state, { ...options, color: true });
    assert.equal(stripVTControlCharacters(colored.text), frame.text);
    for (const badge of ['[deep-high]', '[deep-low]', '[quick]']) assert.ok(colored.text.includes(`\x1b[36m${badge}\x1b[0m`), badge);
  }
});

test('wrapped detail lines keep the hanging indent and start with a dim continuation mark', () => {
  const task = { id: 'root', status: 'running', description: 'HEAD '.repeat(14) + 'TAIL',
    progress: 'PROGRESS '.repeat(8) + 'END' };
  const state = { connected: true, tasks: [task], runs: [] };
  for (const columns of [40, 80]) {
    const options = { columns, rows: 100, color: false, selectedTaskId: 'root', verbose: true, frame: 0, now: 0 };
    const lines = renderFrame(state, options).text.split('\n');
    const label = `${messages.en.description}: `;
    const at = lines.findIndex(line => line.includes(label));
    const end = lines.findIndex(line => line.includes(`${messages.en.agent}: `));
    assert.ok(at >= 0 && end > at + 1, 'the description wraps');
    assert.ok(!lines[at].includes('┆'));
    // The mark sits in the hanging indent, so continuation text stays aligned with the value.
    for (const line of lines.slice(at + 1, end)) assert.ok(line.startsWith(`│ ${' '.repeat(width(label) - 2)}┆ `), line);
    assert.ok(lines.every(line => width(line) < columns));
    assert.ok(lines.join('').replace(/[\s│┆]/gu, '').includes('HEAD'.repeat(14) + 'TAIL'));
    const colored = renderFrame(state, { ...options, color: true }).text;
    assert.equal(stripVTControlCharacters(colored), lines.join('\n'));
    assert.ok(colored.split('\n')[at + 1].includes('\x1b[2m┆\x1b[0m'));
  }
});

test('card marks measure one cell, mark only elapsed time and leave the scheduled icon alone', () => {
  for (const glyph of ['┆', '⧖']) assert.equal(width(glyph), 1, glyph);
  const tasks = [{ id: 'later', status: 'scheduled', description: 'LATER' },
    { id: 'turns', status: 'running', description: 'TURNS_ONLY', turns: 3 }];
  const text = renderFrame({ connected: true, runs: [], tasks }, { columns: 40, rows: 30, color: false, frame: 0, now: cardNow }).text;
  assert.match(text, /◷ \[\+\] LATER/);
  assert.match(text, /^│ 3 turns +│$/m);
  assert.doesNotMatch(text, /⧖/);
});

test('long CJK titles, long models and roles, and empty roles stay inside the card and truncate with an ellipsis', () => {
  const startedAt = '2026-10-14T00:00:00.000Z';
  const tasks = [
    { id: 'a-cjk', status: 'running', startedAt, description: '한글中文タイトル'.repeat(12), agent: 'r'.repeat(60),
      model: `provider/${'m'.repeat(90)}`, reasoningEffort: 'xhigh', progress: '進捗'.repeat(50) },
    { id: 'b-empty', status: 'running', description: 'EMPTY_ROLE', agent: '', category: '', model: 'gpt-6.1-sol' },
    { id: 'c-control', status: 'running', description: 'CONTROL_ROLE', agent: '\x1b[31m', category: '\x07', model: 'gpt-6.1-sol' },
    { id: 'd-role', status: 'running', description: 'ROLE_ONLY', category: 'c'.repeat(80) },
  ];
  for (const columns of [24, 40, 80]) for (const color of [false, true]) {
    const frame = renderFrame({ connected: true, runs: [], tasks }, { columns, rows: 200, color, frame: 0, now: cardNow });
    const plain = stripVTControlCharacters(frame.text).split('\n');
    assert.ok(plain.every(line => width(line) < columns), `${columns}`);
    const card = id => plain.slice(frame.bodyStart + frame.taskRanges[id].start, frame.bodyStart + frame.taskRanges[id].end);
    for (const id of ['a-cjk', 'b-empty', 'c-control', 'd-role']) {
      assert.ok(card(id).every(line => width(line) === columns - 1), `${id} ${columns}`);
      assert.ok(card(id).slice(1, -1).every(line => line.replace(/[│\s]/gu, '')), `${id} ${columns}`);
    }
    const cjk = card('a-cjk');
    assert.match(cjk[1], /…\s*│$/);
    // The truncated role badge always survives; the model shares its row when it fits and follows it otherwise.
    assert.match(cjk[2], /^│ \[r+…?\]/);
    const modelAt = /:xhigh\s*│$/.test(cjk[2]) ? 2 : 3;
    assert.match(cjk[modelAt], /:xhigh\s*│$/);
    assert.match(cjk[modelAt + 1], /^│ ⧖ 1m 0s\s+│$/);
    assert.doesNotMatch(cjk.join('\n'), /進捗/);
    assert.doesNotMatch(cjk.join('\n'), /provider\//);
    for (const id of ['b-empty', 'c-control']) {
      assert.equal(card(id).length, 4, id);
      assert.match(card(id)[2], /^│ gpt-6\.1-sol\s+│$/);
    }
    assert.match(card('d-role')[2], /^│ \[c+…\]\s*│$/);
  }
});

test('a populated role or category keeps its coloured badge before the model at every width', () => {
  const base = { status: 'running', description: 'TITLE', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' };
  const tasks = [{ ...base, id: 'p-both', agent: 'deep-high', category: 'visual-engineering' },
    { ...base, id: 'p-long', agent: 'r'.repeat(60) }, { ...base, id: 'p-cjk', agent: '한글中文'.repeat(10), category: '設計' }];
  for (const columns of [24, 40, 80]) {
    const colored = renderFrame({ connected: true, runs: [], tasks }, { columns, rows: 200, color: true, frame: 0, now: cardNow });
    const frame = renderFrame({ connected: true, runs: [], tasks }, { columns, rows: 200, color: false, frame: 0, now: cardNow });
    assert.equal(stripVTControlCharacters(colored.text), frame.text);
    for (const task of tasks) {
      const card = cardLines(frame, frame.taskRanges[task.id]);
      assert.ok(card.every(line => width(line) === columns - 1), `${task.id} ${columns}`);
      const badgeAt = card.findIndex(line => /^│ \[.+\]\s*(?:\S.*)?│$/u.test(line));
      assert.ok(badgeAt > 0, `badge missing ${task.id} ${columns}`);
      const modelAt = card.findIndex(line => /:xhigh/.test(line));
      assert.ok(modelAt >= badgeAt, `model before badge ${task.id} ${columns}`);
      const raw = colored.text.split('\n').slice(colored.bodyStart + colored.taskRanges[task.id].start,
        colored.bodyStart + colored.taskRanges[task.id].end)[badgeAt];
      assert.match(raw, /\x1b\[36m\[[^\x1b]*\]\x1b\[0m/u, `badge colour ${task.id} ${columns}`);
    }
  }
  const narrow = renderFrame({ connected: true, runs: [], tasks }, { columns: 40, rows: 200, color: false, frame: 0, now: cardNow });
  const both = cardLines(narrow, narrow.taskRanges['p-both']);
  assert.match(both[2], /^│ \[deep-high\/visual-engineering\] +│$/);
  assert.match(both[3], /^│ gpt-6\.1-sol:xhigh +│$/);
  const long = cardLines(narrow, narrow.taskRanges['p-long']);
  assert.match(long[2], /^│ \[r+…\] +│$/);
  assert.match(long[3], /^│ gpt-6\.1-sol:xhigh +│$/);
});

test('DAG runs draw no boxes: a lane graph with stage headers and a barred card per open node', () => {
  const nodes = (...specs) => specs.map(([id, state, label]) => ({ id, state, label: label ?? id.toUpperCase(), taskId: `t_${id}` }));
  const cases = {
    single: { id: 'r', status: 'running', nodes: nodes(['n', 'running']), edges: [] },
    wideFrontier: { id: 'r', status: 'running', nodes: nodes(['a', 'completed'], ['b', 'running'], ['c', 'pending']), edges: [] },
    cjk: { id: 'r', status: 'running', nodes: nodes(['n', 'running', '한글中文タイトル'.repeat(8)]), edges: [] },
    chain: { id: 'r', status: 'running', nodes: nodes(['a', 'completed'], ['b', 'running'], ['c', 'pending']),
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] },
    merge: { id: 'r', status: 'running', nodes: nodes(['a', 'completed'], ['b', 'completed'], ['c', 'running'], ['d', 'pending']),
      edges: [{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }] },
  };
  const timing = { now: cardNow, connected: true, frame: 0 };
  for (const [name, run] of Object.entries(cases)) for (const columns of [39, 79]) {
    const { rows, ranges } = laneLines(run, columns, false, 'en', { timing });
    const colored = laneLines(run, columns, true, 'en', { timing }).rows;
    assert.equal(colored.map(stripVTControlCharacters).join('\n'), rows.join('\n'), `${name} colour ${columns}`);
    assert.ok(rows.every(line => width(line) <= columns), `${name} width ${columns}`);
    assert.ok(!rows.some(line => /[╭╮╰╯▼]/u.test(line)), `${name} draws no box ${columns}`);
    for (const node of run.nodes) {
      const title = rows[ranges[node.id].start];
      // The lane carries a dot; an open (running) node keeps its card bar and the spinner beside the name.
      assert.match(title, /^[│ ]*•/u, `${name} ${node.id} dot`);
      if (node.state === 'running') assert.ok(title.includes(`▌${spinnerFrames[0]} `), `${name} card`);
      else assert.ok(!title.includes('▌'), `${name} ${node.id} has no card`);
    }
  }
  const chain = laneLines(cases.chain, 79, false, 'en', { timing }).rows;
  assert.match(chain[0], /^─ Step 1 1\/1 ─+$/u);
  assert.equal(chain.filter(row => /Step \d [01]\/1 ─/u.test(row)).length, 3);
  const merge = laneLines(cases.merge, 79, false, 'en', { timing }).rows;
  assert.ok(merge.some(row => /^├─┘ +Step 2 0\/1 ─+$/u.test(row)), 'the merge row carries the stage header');
  const pair = laneLines({ id: 'r', status: 'running', nodes: nodes(['a', 'running'], ['b', 'running']), edges: [] }, 40, false, 'en', { timing }).rows;
  assert.ok(pair.some(row => /┈{10}/u.test(row)), 'neighbouring cards are parted by a dotted row');
  const frame = renderFrame({ connected: true, runs: [cases.single], tasks: [] }, { columns: 40, rows: 60, color: false, frame: 0, now: cardNow, view: 'dag' });
  assert.equal(frame.graphRanges.n.start, 1, 'stage header, then the running node');
});

test('the DAG pane lists each stage under its header, so a wide parallel stage keeps a one-cell margin', () => {
  const nodes = (...specs) => specs.map(([id, state, label]) => ({ id, state, label: label ?? id.toUpperCase(), taskId: `t_${id}` }));
  const draw = (run, columns) => renderFrame({ connected: true, runs: [run], tasks: [] },
    { columns, rows: 200, color: false, frame: 0, now: cardNow, view: 'dag' });
  const title = (frame, id) => frame.text.split('\n')[frame.bodyStart + frame.graphRanges[id].start - frame.scroll];
  // 23 parallel nodes merging into one: as lanes they took 45 cells of a 34-column pane and hid the names.
  const roots = Array.from({ length: 23 }, (_, i) => [`h${i + 1}`, i < 4 ? 'completed' : 'pending', `harvest i${i + 1}`]);
  const fanIn = { id: 'r', status: 'running', nodes: nodes(...roots, ['syn', 'pending', 'synthesize']),
    edges: roots.map(([id]) => ({ from: id, to: 'syn' })) };
  const wide = draw(fanIn, 34);
  for (const node of fanIn.nodes) {
    assert.match(title(wide, node.id), /^[├└] [✓○] /u, `${node.id} sits one cell in`);
    assert.ok(title(wide, node.id).includes(node.label), `${node.id} keeps its whole name`);
  }
  assert.ok(title(wide, 'h22').startsWith('├') && title(wide, 'h23').startsWith('└'), 'the last node closes its stage');
  assert.ok(!title(wide, 'syn').includes('←'), 'a node fed by its whole previous stage needs no hint');
  assert.ok(wide.text.split('\n').every(line => width(line) <= 34));
  // Eight pairs a→b plus one node fed by two of the eight: each names the parent it waits for.
  const pairs = Array.from({ length: 8 }, (_, i) => i + 1);
  const chains = { id: 'r', status: 'running', nodes: nodes(...pairs.map(k => [`a${k}`, 'running']), ...pairs.map(k => [`b${k}`, 'pending']), ['m', 'pending']),
    edges: [...pairs.map(k => ({ from: `a${k}`, to: `b${k}` })), { from: 'a1', to: 'm' }, { from: 'a2', to: 'm' }] };
  const narrow = draw(chains, 27);
  for (const k of pairs) assert.ok(title(narrow, `b${k}`).includes(`B${k}  ← A${k}`), title(narrow, `b${k}`));
  assert.ok(title(narrow, 'm').includes('M  ← A1 +1'), title(narrow, 'm'));
  assert.ok(narrow.text.split('\n').every(line => width(line) <= 27));
  // Neighbouring open (running) nodes keep their bar and the dotted parting row.
  const rows = narrow.text.split('\n');
  assert.match(title(narrow, 'a1'), /^├▌/u);
  assert.match(rows[narrow.bodyStart + narrow.graphRanges.a1.end - narrow.scroll], /^│ ┈{10}/u);
});

test('worker and DAG cards share three rows, and role and model split onto two whole rows when they do not fit one', () => {
  const make = (agent, model, reasoningEffort) => ({ id: 'w', status: 'running', description: 'WORK', agent, model, reasoningEffort,
    startedAt: new Date(cardNow - 125000).toISOString(), turns: 12, toolCalls: 30,
    metrics: { tokens_per_second: 80, cost_usd: 0.0123, cost_status: 'reported' } });
  const run = { id: 'r', status: 'running', edges: [], nodes: [{ id: 'n', label: 'NODE', state: 'running', taskId: 'w' }] };
  const draw = (task, view, columns) => {
    const frame = renderFrame({ connected: true, runs: view === 'dag' ? [run] : [], tasks: [task] },
      { columns, rows: 60, color: false, frame: 0, now: cardNow, view, language: 'ko' });
    const range = view === 'dag' ? frame.graphRanges.n : frame.taskRanges.w;
    const lines = frame.text.split('\n').slice(frame.bodyStart + range.start - frame.scroll, frame.bodyStart + range.end - frame.scroll);
    // Strip the card bar (worker) or the tree mark and bar (DAG) to compare the card contents.
    return { frame, rows: lines.map(line => line.slice(view === 'dag' ? 2 : 1).trimEnd()) };
  };
  const short = make('quick', 'gpt-6.1-sol', 'low'), long = make('unspecified-high', 'claude-opus-5-5', 'xhigh');
  for (const columns of [28, 34, 54]) for (const [task, split] of [[short, false], [long, columns < 54]]) {
    const cards = { tasks: draw(task, 'tasks', columns), dag: draw(task, 'dag', columns) };
    for (const [view, { frame, rows }] of Object.entries(cards)) {
      const at = `${view} ${columns} ${task.agent}`;
      assert.equal(rows.length, split ? 4 : 3, `${at}: ${rows.join(' / ')}`);
      assert.ok(rows[0].endsWith('⧖ 2m 5s'), `${at}: ${rows[0]}`);
      if (split) {
        assert.equal(rows[1], `[${task.agent}]`, at);
        assert.equal(rows[2], `${task.model}:${task.reasoningEffort}`, at);
      } else assert.equal(rows[1], `[${task.agent}] ${task.model}:${task.reasoningEffort}`, at);
      assert.ok(rows.at(-1).startsWith('80 tok/s · 12 turns'), `${at}: ${rows.at(-1)}`);
      assert.ok(!rows.some(row => row.includes('$')), at);
      assert.ok(frame.text.split('\n').every(line => width(line) < columns), at);
      assert.ok(frame.text.includes('Follow ON · LIVE'), at);
    }
    if (columns === 54) assert.deepEqual(cards.dag.rows.slice(1), cards.tasks.rows.slice(1), 'the same rows under the title');
    assert.ok(cards.tasks.frame.text.startsWith('Workers [0/1]  run 1'), cards.tasks.frame.text.split('\n')[0]);
  }
});

test('a card one column narrower than its longest line truncates with an ellipsis instead of overflowing', () => {
  const task = { id: 'wide', status: 'running', description: 'D'.repeat(32), agent: 'deep-high', model: 'gpt-6.1-sol',
    reasoningEffort: 'xhigh', startedAt: '2026-10-14T00:00:00.000Z', progress: 'PROGRESS' };
  const draw = columns => {
    const frame = renderFrame({ connected: true, runs: [], tasks: [task] },
      { columns, rows: 50, color: false, frame: 0, now: cardNow, selectedTaskId: 'wide' });
    return { frame, card: cardLines(frame, frame.taskRanges.wide) };
  };
  // The title row, '⠋ ' plus 32 cells, is the widest; 39 columns leave exactly 34 interior cells.
  const exact = draw(39);
  assert.ok(exact.card[1].endsWith(`⠋ ${'D'.repeat(32)} │`));
  assert.doesNotMatch(exact.frame.text, /…/);
  const narrow = draw(38);
  assert.ok(narrow.card[1].endsWith(`⠋ ${'D'.repeat(30)}… │`));
  assert.ok(narrow.card.every(line => width(line) === 37));
  assert.ok(narrow.frame.text.split('\n').every(line => width(line) < 38));
});

test('consecutive worker cards and DAG detail cards are not separated by blank rows', () => {
  const tasks = [{ id: 'a', status: 'running', description: 'FIRST', progress: 'FIRST_PROGRESS' },
    { id: 'b', status: 'pending', description: 'SECOND' }, { id: 'c', status: 'failed', description: 'THIRD' }];
  const workers = renderFrame({ connected: true, runs: [], tasks }, { columns: 40, rows: 60, color: false, frame: 0, now: 0 });
  assert.equal(workers.taskRanges.b.start, workers.taskRanges.a.end);
  assert.equal(workers.taskRanges.c.start, workers.taskRanges.b.end);
  const run = { id: 'run', name: 'RUN', status: 'running', edges: [{ from: 'one', to: 'two' }], nodes: [
    { id: 'one', label: 'ONE', state: 'running', taskId: 'a' }, { id: 'two', label: 'TWO', state: 'pending', taskId: 'b' }] };
  const dag = renderFrame({ connected: true, runs: [run], tasks }, { columns: 40, rows: 80, color: false, frame: 0, now: 0 });
  assert.equal(dag.nodeRanges.two.start, dag.nodeRanges.one.end);
  assert.equal(dag.text.split('\n')[dag.bodyStart + dag.nodeRanges.one.start - 1], messages.en.details);
});

test('every row of a bar card starts right after the bar at every depth', () => {
  const metrics = { tokens_per_second: 212, cost_usd: 0.0421, cost_status: 'reported' };
  const tasks = [
    { id: 'root', status: 'running', description: 'ROOT', agent: 'deep-low', model: 'gpt-6.1-sol',
      reasoningEffort: 'medium', turns: 4, toolCalls: 7, metrics },
    { id: 'child', parentTaskId: 'root', status: 'running', description: 'CHILD', agent: 'deep-low',
      model: 'gpt-6.1-sol', reasoningEffort: 'medium', metrics },
    { id: 'grand', parentTaskId: 'child', status: 'running', description: 'GRAND' },
  ];
  const run = { id: 'run', name: 'RUN', status: 'running', edges: [],
    nodes: [{ id: 'node', label: 'NODE', state: 'running', taskId: 'root' }] };
  const cardLines = (frame, range) => frame.text.split('\n')
    .slice(frame.bodyStart + range.start - frame.scroll, frame.bodyStart + range.end - frame.scroll)
    .map(stripVTControlCharacters);
  const assertFlush = (lines, label) => {
    for (const line of lines) {
      const bar = line.indexOf('▌');
      assert.ok(bar >= 0, `${label}: no bar in ${JSON.stringify(line)}`);
      assert.notEqual(line[bar + 1], ' ', `${label}: indent after bar in ${JSON.stringify(line)}`);
    }
  };
  for (const columns of [28, 40, 80]) for (const color of [false, true]) {
    const workers = renderFrame({ connected: true, runs: [], tasks },
      { columns, rows: 120, color, frame: 0, now: 0, selectedTaskId: 'root' });
    const card = cardLines(workers, workers.taskRanges.root);
    const divider = card.find(line => line.includes(t('en', 'subtasksCount', { count: 2 })));
    const childTitle = card.find(line => line.includes('↳'));
    assert.ok(divider && childTitle, `${columns} ${color}: divider and child title`);
    assert.equal(divider.indexOf('─'), divider.indexOf('▌') + 1, `${columns} ${color}: divider follows the bar`);
    assert.equal(childTitle.indexOf('↳'), childTitle.indexOf('▌') + 1, `${columns} ${color}: child follows the bar`);
    assertFlush(card, `workers ${columns} ${color}`);
    assert.doesNotMatch(card.join('\n'), /▌ +[^ ]/, `${columns} ${color}: no body indent`);
    for (const line of workers.text.split('\n')) assert.ok(width(line) <= columns - 1, `${columns} ${color}: ${line}`);

    const dag = renderFrame({ connected: true, runs: [run], tasks },
      { columns, rows: 120, color, frame: 0, now: 0, view: 'dag', selectedNodeId: 'node' });
    const dagCard = cardLines(dag, dag.nodeRanges.node);
    assert.ok(dagCard.length > 1, `${columns} ${color}: DAG card rows`);
    assert.equal(dagCard[0].indexOf('⠋'), dagCard[0].indexOf('▌') + 1, `${columns} ${color}: DAG title follows the bar`);
    const badge = dagCard.find(line => line.includes('[deep-low]'));
    assert.ok(badge, `${columns} ${color}: DAG badge row`);
    assert.equal(badge.indexOf('['), badge.indexOf('▌') + 1, `${columns} ${color}: DAG badge follows the bar`);
    assertFlush(dagCard, `dag ${columns} ${color}`);
  }
});
