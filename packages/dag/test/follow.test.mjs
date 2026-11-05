import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { messages } from '../src/i18n.mjs';
import { renderFrame, runningTarget, width } from '../src/render.mjs';
import { isExpanded, setExpanded } from '../src/view-state.mjs';

test('execution colors emphasize unselected graph and task titles and bars independently of selection', () => {
  const colors = { running: '36', completed: '32', failed: '31', error: '31', paused: '33', blocked: '33' };
  const nodes = [...Object.keys(colors), 'pending'].map(state => ({ id: state, label: `N_${state}`, state, taskId: state }));
  const state = { connected: true, runs: [{ id: 'r', name: 'Run', status: 'running', nodes, edges: [] }],
    tasks: nodes.map(node => ({ id: node.id, status: node.state === 'running' ? 'completed' : 'running', description: `T_${node.id}` })) };
  const frame = renderFrame(state, { columns: 35, rows: 200, color: true, selectedNodeId: 'completed' });
  const lines = frame.text.split('\n');
  for (const [id, color] of Object.entries(colors)) {
    const graph = lines.slice(frame.bodyStart + frame.graphRanges[id].start, frame.bodyStart + frame.graphRanges[id].end);
    const card = lines.slice(frame.bodyStart + frame.nodeRanges[id].start, frame.bodyStart + frame.nodeRanges[id].end);
    assert.match(stripVTControlCharacters(graph[0]), new RegExp(`N_${id}`));
    assert.ok(id === 'completed' ? graph[0].includes(`\x1b[1;${color}m`) :
      graph[0].includes(`\x1b[${color}m`) && !graph[0].includes('\x1b[1;'), id);
    if (id === 'running') assert.ok(graph[0].includes(`\x1b[${color}m▌`), id);
    assert.deepEqual(card, graph, 'the stage node owns its compact card');
  }
  const pending = lines.slice(frame.bodyStart + frame.graphRanges.pending.start, frame.bodyStart + frame.graphRanges.pending.end).join('\n');
  assert.ok(!pending.includes('\x1b[36m'));
  state.runs = [];
  state.tasks = nodes.map(node => ({ id: node.id, status: node.state, description: `T_${node.id}` }));
  const standalone = renderFrame(state, { columns: 35, rows: 200, color: true, selectedTaskId: 'completed' });
  for (const [id, color] of Object.entries(colors)) {
    const range = standalone.taskRanges[id];
    const card = standalone.text.split('\n').slice(standalone.bodyStart + range.start, standalone.bodyStart + range.end);
    if (id === 'completed') {
      assert.equal(range.end-range.start,1);
      assert.ok(card[0].includes(`\x1b[1;${color}m✓ ▸ T_completed`),id);
    } else {
      assert.ok(card[0].includes(`\x1b[${color}m`) && !card[0].includes('\x1b[1;'), id);
      assert.match(stripVTControlCharacters(card[0]), new RegExp(`T_${id}`));
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
  for (const language of ['en', 'ko', 'zh-cn']) for (const columns of [12, 20, 35, 54, 81]) {
    const options = { columns, rows: 18, color: true, language, selectedNodeId: 'n0', runningNodeId: 'n8' };
    const frame = renderFrame(state, options);
    assert.equal(frame.scroll, frame.stageRanges.find(stage => stage.nodeIds.includes('n8')).start,
      `${language} ${columns} stage header at viewport top`);
    assert.equal(frame.graphRanges.n8.start - frame.scroll, 1, 'running title immediately follows its stage header');
    assert.ok(frame.bodyStart + frame.graphRanges.n8.start - frame.scroll + 1 <= 8, 'title within physical top eight');
    assert.ok(frame.text.split('\n').every(line => width(line) < columns));
    assert.equal(renderFrame(state, { ...options, scroll: Math.max(0, frame.scroll - 1) }).scroll, frame.scroll,
      'follow re-pins a target that was already visible');
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
  const tasks = [...'abcdefghijklmnopqrstuvw', 'z'].map(id => ({ id, status: 'running', description: `TASK_${id}_한글中文`,
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

function pointerViewer() {
  const state = JSON.parse(readFileSync(new URL('./fixtures/active-tracking/f1.json', import.meta.url), 'utf8'));
  let closing = false, view = 'dag', follow = true, revealSelection = false, scrollAnchor, dragY, headerDrag = false, scroll = 0, lastFrame;
  const selectedNodes = new Map(), selectedId = state.runs[0].id, viewState = { expanded: {} };
  const captureScrollAnchor = () => undefined;
  function draw() {
    lastFrame = renderFrame(state, { view, fixed: true, columns: 54, rows: 8, color: false, follow, scroll,
      viewState, runningNodeId: follow ? 'r0' : undefined });
    scroll = lastFrame.scroll;
  }
  draw();
  // Execute the actual input owner without a test-only export from the viewer.
  const source = readFileSync(new URL('../src/viewer.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('pointer: mouse => {') + 9;
  const end = source.indexOf('} });\ndisposeFocus', start) + 1;
  const pointer = eval(`(${source.slice(start, end)})`);
  return { pointer, snapshot: () => ({ scroll, dragY, headerDrag, frame: lastFrame }) };
}

for (const [name, release] of [['SGR', { button: 0, release: true }], ['button', { button: 3 }]]) {
  test(`pinned header drag stays still until ${name} release`, () => {
    const viewer = pointerViewer(), y = viewer.snapshot().frame.pinnedHeader.row + 1;
    const positions = [viewer.snapshot().scroll], offsets = [viewer.snapshot().dragY];
    for (const [button, row] of [[0, y], [32, y + 1], [32, y + 2], [32, y + 3]]) {
      viewer.pointer({ button, y: row, x: 5 });
      positions.push(viewer.snapshot().scroll); offsets.push(viewer.snapshot().dragY);
    }
    assert.deepEqual(positions, [6, 6, 6, 6, 6]);
    assert.deepEqual(offsets, Array(5).fill(undefined), 'header movement never arms a body drag');
    viewer.pointer({ ...release, y: y + 3, x: 5 });
    assert.equal(viewer.snapshot().headerDrag, false, 'release ends header suppression');
  });
}

test('body drag keeps its existing row deltas below the pinned header', () => {
  const viewer = pointerViewer(), y = viewer.snapshot().frame.bodyStart + 1;
  const positions = [viewer.snapshot().scroll];
  for (const [button, row] of [[0, y], [32, y + 1], [32, y + 2], [32, y + 3]]) {
    viewer.pointer({ button, y: row, x: 5 }); positions.push(viewer.snapshot().scroll);
  }
  assert.deepEqual(positions, [6, 6, 5, 4, 3]);
  assert.equal(viewer.snapshot().dragY, y + 3);
});

test('wheel reports are not mistaken for button release', () => {
  const viewer = pointerViewer();
  viewer.pointer({ button: 67, y: 3, x: 5 });
  assert.equal(viewer.snapshot().scroll, 9);
  assert.match(viewer.snapshot().frame.text, /Follow OFF/);
});
