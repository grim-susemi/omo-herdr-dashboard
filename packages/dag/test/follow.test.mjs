import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { messages } from '../src/i18n.mjs';
import { renderFrame, runningTarget, width } from '../src/render.mjs';

test('execution colors emphasize unselected graph and task titles, borders and status independently of selection', () => {
  const colors = { running: '36', completed: '32', failed: '31', error: '31', paused: '33', blocked: '33' };
  const nodes = [...Object.keys(colors), 'pending'].map(state => ({ id: state, label: `N_${state}`, state, taskId: state }));
  const state = { connected: true, runs: [{ id: 'r', name: 'Run', status: 'running', nodes, edges: [] }],
    tasks: nodes.map(node => ({ id: node.id, status: node.state === 'running' ? 'completed' : 'running', description: `T_${node.id}` })) };
  const frame = renderFrame(state, { columns: 35, rows: 200, color: true, selectedNodeId: 'completed' });
  const lines = frame.text.split('\n');
  for (const [id, color] of Object.entries(colors)) {
    const graph = lines.slice(frame.bodyStart + frame.graphRanges[id].start, frame.bodyStart + frame.graphRanges[id].end);
    const card = lines.slice(frame.bodyStart + frame.nodeRanges[id].start, frame.bodyStart + frame.nodeRanges[id].end);
    assert.ok(graph[0].startsWith(`\x1b[${color}m╭`), id);
    assert.ok(id === 'completed' ? graph[1].includes(`\x1b[1;${color}m`) : graph[1].includes(`\x1b[${color}m`) && !graph[1].includes('\x1b[1;'), id);
    assert.ok(graph[2].includes(`\x1b[${color}m`), id);
    assert.ok(graph[3].startsWith(`\x1b[${color}m╰`), id);
    assert.ok(card[0].startsWith(`\x1b[${color}m╭`), id);
    assert.ok(id === 'completed' ? card[1].includes(`\x1b[1;${color}m`) : card[1].includes(`\x1b[${color}m`) && !card[1].includes('\x1b[1;'), id);
    assert.ok(card.at(-1).startsWith(`\x1b[${color}m╰`), id);
  }
  const pending = lines.slice(3 + frame.graphRanges.pending.start, 3 + frame.graphRanges.pending.end).join('\n');
  assert.ok(!pending.includes('\x1b[36m'));
  state.runs = [];
  state.tasks = nodes.map(node => ({ id: node.id, status: node.state, description: `T_${node.id}` }));
  const standalone = renderFrame(state, { columns: 35, rows: 200, color: true, selectedTaskId: 'completed' });
  for (const [id, color] of Object.entries(colors)) {
    const range = standalone.taskRanges[id];
    const card = standalone.text.split('\n').slice(standalone.bodyStart + range.start, standalone.bodyStart + range.end);
    if (id === 'completed') {
      assert.equal(range.end-range.start,1);
      assert.ok(card[0].includes(`\x1b[1;${color}m✓ [+] T_completed`),id);
    } else {
      assert.ok(card[0].startsWith(`\x1b[${color}m╭`), id);
      assert.ok(card[1].includes(`\x1b[${color}m`) && !card[1].includes('\x1b[1;'), id);
    }
    if (id === 'completed') assert.ok(!card.join('\n').includes('\x1b[36m'));
  }
  assert.ok(!renderFrame(state, { color: false, rows: 200 }).text.includes('\x1b'));
});

test('running target stays stable across parallel reorders and retries, then hands off after completion or removal', () => {
  const state = { connected: true, runs: [
    { id: 'r', nodes: [{ id: 'a', state: 'running', taskId: 'ta' }, { id: 'b', state: 'running', taskId: 'tb' }] },
    { id: 'other', nodes: [{ id: 'a', state: 'running', taskId: 'other' }] },
  ], tasks: [{ id: 'root', status: 'running' }] };
  let target = runningTarget(state);
  assert.deepEqual(target, { view: 'dag', runId: 'r', nodeId: 'a', taskId: 'ta' });
  state.runs.reverse();
  const run = state.runs.find(run => run.id === 'r');
  run.nodes.reverse();
  run.nodes.push({ id: 'new', state: 'running', taskId: 'new' });
  assert.deepEqual(runningTarget(state, target), target);
  run.nodes.find(node => node.id === 'a').taskId = 'retry';
  target = runningTarget(state, target);
  assert.equal(target.nodeId, 'a');
  assert.equal(target.taskId, 'retry');
  run.nodes.find(node => node.id === 'a').state = 'completed';
  target = runningTarget(state, target);
  assert.equal(target.runId, 'other');
  state.runs.shift();
  target = runningTarget(state, target);
  assert.equal(target.nodeId, 'b');
  run.nodes.forEach(node => { node.state = 'completed'; });
  assert.deepEqual(runningTarget(state, target), { view: 'tasks', taskId: 'root' });
  state.connected = false;
  assert.equal(runningTarget(state, target), undefined);
});

test('new running tasks and DAGs arrive after empty state and linked targets transfer between views without hopping', () => {
  const state = { connected: true, runs: [], tasks: [] };
  assert.equal(runningTarget(state), undefined);
  state.tasks.push({ id: 'z', status: 'running' });
  let target = runningTarget(state);
  state.tasks.unshift({ id: 'a', status: 'running' });
  assert.deepEqual(runningTarget(state, target), target);
  state.runs.push({ id: 'r', nodes: [
    { id: 'parallel', state: 'running', taskId: 'parallel' },
    { id: 'linked', state: 'running', taskId: 'z' },
  ] });
  target = runningTarget(state, target);
  assert.equal(target.view, 'dag');
  assert.equal(target.nodeId, 'linked');
  state.runs = [];
  target = runningTarget(state, target);
  assert.deepEqual(target, { view: 'tasks', taskId: 'z' });
  state.tasks.find(task => task.id === 'z').status = 'completed';
  target = runningTarget(state, target);
  assert.deepEqual(target, { view: 'tasks', taskId: 'a' });
  state.tasks[0].status = 'completed';
  assert.equal(runningTarget(state, target), undefined);
});

test('follow reveals the running card, leaves visible targets still and preserves narrow CJK widths', () => {
  const nodes = Array.from({ length: 10 }, (_, i) => ({
    id: `n${i}`, label: i === 8 ? 'TARGET_한글中文' : `NODE_${i}`, state: i === 8 ? 'running' : 'completed', taskId: `t${i}`,
  }));
  const state = { connected: true, runs: [{ id: 'r', name: 'Run', status: 'running', nodes,
    edges: nodes.slice(1).map((node, i) => ({ from: nodes[i].id, to: node.id })) }],
  tasks: nodes.map(node => ({ id: node.taskId, status: node.state, description: `DETAIL_${node.id}`, progress: 'TOKEN_HEAD' })) };
  const shown = (frame, range) => range.start >= frame.scroll && range.end <= frame.scroll + frame.bodyRows;
  for (const language of ['en', 'ko', 'zh-cn']) for (const columns of [12, 20, 35, 54, 81]) {
    const options = { columns, rows: 18, color: true, language, selectedNodeId: 'n0', runningNodeId: 'n8' };
    const frame = renderFrame(state, options);
    assert.ok(shown(frame, frame.graphRanges.n8), `${language} ${columns} running card on screen`);
    assert.ok(frame.text.split('\n').every(line => width(line) < columns));
    if (frame.scroll > 0 && shown({ ...frame, scroll: frame.scroll - 1 }, frame.graphRanges.n8)) {
      assert.equal(renderFrame(state, { ...options, scroll: frame.scroll - 1 }).scroll, frame.scroll - 1);
    }
    state.tasks[8].progress = 'TOKEN_TAIL';
    assert.equal(renderFrame(state, { ...options, scroll: frame.scroll }).scroll, frame.scroll);
    const manual = renderFrame(state, { ...options, follow: false, scroll: 0 });
    assert.equal(manual.scroll, 0);
    const detail = renderFrame(state, { ...options, selectedNodeId: 'n8', revealSelection: true, verbose: true });
    assert.ok(detail.nodeRanges.n8.start >= detail.scroll && detail.nodeRanges.n8.start < detail.scroll + detail.bodyRows);
    if (columns >= 35) assert.ok(detail.text.includes('DETAIL_n8'));
  }
});

test('standalone follow reveals the running card without changing selection; disconnected frames have no live activity', () => {
  const tasks = ['a', 'b', 'c', 'z'].map(id => ({ id, status: 'running', description: `TASK_${id}_한글中文`,
    activity: { phase: 'text', since: 1000, lastAt: 1000, text: 'LIVE_TOKEN' } }));
  const state = { connected: true, runs: [], tasks, updatedAt: new Date(1000).toISOString() };
  for (const language of ['en', 'ko', 'zh-cn']) {
    const frame = renderFrame(state, { rows: 18, columns: 35, color: true, language, selectedTaskId: 'a', runningTaskId: 'z', now: 1000 });
    assert.ok(frame.scroll > 0 && frame.scroll <= frame.taskRanges.z.start);
    assert.ok(frame.text.includes('TASK_z'));
    assert.ok(frame.text.includes('\x1b[36m⠋ TASK_z') && !frame.text.includes('\x1b[1;36m⠋ TASK_z'));
    assert.ok(frame.text.includes(messages[language].followShortOn));
    assert.ok(frame.text.split('\n').every(line => width(line) < 35));
    const disconnected = renderFrame({ ...state, connected: false }, { rows: 80, columns: 54, color: false, language, now: 1000 });
    assert.ok(disconnected.text.includes(messages[language].followOff));
    assert.ok(!disconnected.text.includes('LIVE_TOKEN'));
    assert.ok(disconnected.text.includes(messages[language].disconnected));
  }
});

test('titles start without a marker column and only the selected title is bold', () => {
  const nodes = [{ id: 'b', label: 'N_B', state: 'completed', taskId: 'tb' }, { id: 'a', label: 'N_A', state: 'failed', taskId: 'ta' },
    { id: 'c', label: 'N_C', state: 'running', taskId: 'tc' }];
  const tasks = [{ id: 'tb', status: 'completed', description: 'T_B' }, { id: 'ta', status: 'failed', description: 'T_A' },
    { id: 'tc', status: 'running', description: 'T_C' }];
  const run = { id: 'r', name: 'Run', status: 'running', nodes, edges: [{ from: 'b', to: 'a' }, { from: 'a', to: 'c' }] };
  for (const color of [false, true]) {
    const graph = renderFrame({ connected: true, runs: [run], tasks }, { columns: 40, rows: 60, color, frame: 0, view: 'dag', selectedNodeId: 'b' });
    const graphRow = id => graph.text.split('\n')[graph.bodyStart + graph.graphRanges[id].start - graph.scroll];
    // Collapsed nodes in the stage list: the status icon follows the tree mark and the blank bar cell, selected or not.
    assert.ok(stripVTControlCharacters(graphRow('b')).startsWith('└ ✓ N_B'), graphRow('b'));
    assert.ok(stripVTControlCharacters(graphRow('a')).startsWith('└ × N_A'), graphRow('a'));
    assert.ok(stripVTControlCharacters(graphRow('c')).includes('⠋ N_C'), graphRow('c'));
    const workers = renderFrame({ connected: true, runs: [], tasks }, { columns: 40, rows: 60, color, frame: 0, view: 'tasks', selectedTaskId: 'tb' });
    const workerRow = id => workers.text.split('\n')[workers.bodyStart + workers.taskRanges[id].start - workers.scroll];
    // One cell of bar (or its blank) and then the status icon, for the selected and the unselected cards alike.
    assert.ok(stripVTControlCharacters(workerRow('tb')).slice(1).startsWith('✓ ▸ T_B'), workerRow('tb'));
    assert.ok(stripVTControlCharacters(workerRow('ta')).slice(1).startsWith('× ▸ T_A'), workerRow('ta'));
    assert.ok(stripVTControlCharacters(workerRow('tc')).slice(1).startsWith('⠋ T_C'), workerRow('tc'));
    if (!color) {
      assert.ok(!graph.text.includes('\x1b') && !workers.text.includes('\x1b'));
      continue;
    }
    assert.ok(graphRow('b').includes('\x1b[1;32m✓ N_B'), graphRow('b'));
    assert.ok(graphRow('a').includes('\x1b[31m× N_A') && !graphRow('a').includes('\x1b[1;'), graphRow('a'));
    assert.ok(graphRow('c').includes('\x1b[36m⠋ N_C') && !graphRow('c').includes('\x1b[1;'), graphRow('c'));
    assert.ok(workerRow('tb').includes('\x1b[1;32m✓ ▸ T_B'), workerRow('tb'));
    assert.ok(workerRow('ta').includes('\x1b[31m× ▸ T_A') && !workerRow('ta').includes('\x1b[1;'), workerRow('ta'));
    assert.ok(workerRow('tc').includes('\x1b[36m⠋ T_C') && !workerRow('tc').includes('\x1b[1;'), workerRow('tc'));
  }
});
