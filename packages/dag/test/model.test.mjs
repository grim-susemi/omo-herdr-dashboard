import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messages } from '../src/i18n.mjs';
import { clean, layers, normalizeRun, sessionRuns } from '../src/model.mjs';
import { fit, fitTail, render, renderFrame, standaloneTasks, width } from '../src/render.mjs';
import { TASK_SCOPE, emptyViewState, setExpanded } from '../src/view-state.mjs';
import { payload, sessionId } from './fixtures.mjs';

test('running cards show model liveness: phase, time since the last token, stall warnings and the newest text', () => {
  const now = Date.parse('2026-09-30T00:10:00Z');
  const activity = (phase, extra = {}, age = 0, span = age) => ({ phase, since: now - span, lastAt: now - age, ...extra });
  const tail = `OLD_HEAD ${'한글 words '.repeat(30)}NEWEST_TAIL`;
  const live = { id: 'st_live', status: 'running', progress: 'PROGRESS_LINE', activity: activity('text', { text: tail }) };
  const done = { id: 'st_done', status: 'completed', progress: 'DONE_PROGRESS', activity: activity('text', { text: 'DONE_TAIL' }) };
  const card = (task, options = {}) => {
    const frame = renderFrame({ connected: true, runs: [], tasks: [task] }, { rows: 80, columns: 54, color: false, now, ...options });
    return frame.text.split('\n').slice(2 + frame.taskRanges[task.id].start, 2 + frame.taskRanges[task.id].end);
  };
  const detailOf = (task, options = {}) => render({ connected: true, runs: [], tasks: [task] },
    { rows: 80, columns: 120, color: false, now, selectedTaskId: task.id, verbose: true, ...options });
  // A healthy card has no message row; the detail view keeps the newest characters at the right edge.
  const streaming = card(live);
  assert.equal(streaming.length, 1);
  assert.doesNotMatch(streaming.join('\n'), /✎|NEWEST_TAIL|OLD_HEAD|PROGRESS_LINE/);
  for (const line of streaming) assert.ok(width(line) <= 53, line);
  assert.match(detailOf({ ...live, activity: activity('text', { text: 'x' }, 7000, 9000) }), /✎ 7s ago · x/);
  assert.match(detailOf({ ...live, activity: activity('thinking', { text: 'ponder' }) }), /💭 now · ponder/);
  assert.match(detailOf({ ...live, activity: activity('toolArgs', { tool: 'write', text: '{"path":"a"' }, 1000) }), /⚙ write now · .*"a"/);
  // Phases without tokens show how long the request or tool has taken.
  assert.match(detailOf({ ...live, activity: activity('waiting', {}, 12000) }), /⏳ waiting for model 12s/);
  assert.match(detailOf({ ...live, activity: activity('tool', { tool: 'bash' }, 65000) }), /▶ bash running 1m 5s/);
  assert.equal(card({ ...live, activity: activity('tool', { tool: 'bash' }, 65000) }).length, 1);
  // A retry keeps the card's message row.
  assert.match(card({ ...live, activity: activity('retry', { attempt: 2, maxAttempts: 3 }, 4000) })[1], /↻ retry 2\/3 · 4s/);
  // A silent token phase or a long first-token wait is flagged; a long tool is not.
  assert.match(card({ ...live, activity: activity('text', { text: 'LAST' }, 45000) })[1], /⚠ possibly stalled · 45s ago · LAST/);
  assert.match(card({ ...live, activity: activity('waiting', {}, 95000) })[1], /⚠ possibly stalled · waiting for model 1m 35s/);
  assert.doesNotMatch(card({ ...live, activity: activity('tool', { tool: 'bash' }, 600000) }).join('\n'), /⚠|PROGRESS_LINE/);
  // Korean labels; terminal tasks, malformed activity and missing activity drop the message row.
  assert.match(detailOf({ ...live, activity: activity('text', { text: 'x' }, 7000) }, { language: 'ko' }), /✎ 7s ago · x/);
  assert.match(card({ ...live, activity: activity('waiting', {}, 95000) }, { language: 'ko' })[1], /⚠ possibly stalled · waiting for model 1m 35s/);
  const viewState = emptyViewState('session');
  setExpanded(viewState, TASK_SCOPE, 'st_done', true);
  const finished = card(done, { viewState }).join('\n');
  assert.ok(!finished.includes('DONE_PROGRESS') && !finished.includes('DONE_TAIL'));
  assert.doesNotMatch(card({ ...live, activity: { phase: 'text' } }).join('\n'), /PROGRESS_LINE/);
  assert.doesNotMatch(card({ ...live, activity: undefined }).join('\n'), /PROGRESS_LINE/);
  assert.match(detailOf({ ...live, activity: undefined }), /PROGRESS_LINE/);
  // Detail labels all activity; compact DAG cards retain only alerts.
  const detail = render({ connected: true, runs: [], tasks: [live] }, { rows: 80, columns: 54, color: false, now, selectedTaskId: 'st_live', verbose: true });
  assert.ok(detail.includes(`${messages.en.activity}: ✎ now · OLD_HEAD`) && detail.includes('PROGRESS_LINE'));
  const run = normalizeRun({ run_id: 'dag', status: 'running', nodes: [
    { id: 'live', state: 'running', task_id: 'st_live' }, { id: 'done', state: 'completed', task_id: 'st_done' }], edges: [] });
  const dag = render({ connected: true, runs: [run], tasks: [live, done] }, { rows: 120, columns: 80, color: false, now });
  assert.match(dag, /⠋ live/);
  assert.doesNotMatch(dag, /✎|NEWEST_TAIL|OLD_HEAD/);
  assert.doesNotMatch(dag, /DONE_TAIL/);
  const stalled = { ...live, activity: activity('text', { text: 'LAST' }, 45000) };
  const colored = render({ connected: true, runs: [run], tasks: [stalled, done] }, { rows: 120, columns: 80, color: true, now });
  assert.ok(colored.includes('⚠ possibly stalled · 45s ago · LAST'));
  assert.ok(colored.includes('\x1b[36m▌'), 'the running bar keeps its execution color');
  for (const columns of [12, 20, 35, 54, 120]) for (const line of render({ connected: true, runs: [run], tasks: [live, done] },
    { columns, rows: 48, color: true, now, selectedNodeId: 'live' }).split('\n')) assert.ok(width(line) < columns, `${columns}: ${line}`);
  assert.equal(fitTail('abcdef', 4), '…def');
  assert.equal(width(fitTail('한글한글', 5)), 5);
});

test('standalone tasks are separate from every DAG, respect explicit folds, and expose real metadata and children', () => {
  const state = { connected: true, runs: [], tasks: [
    { id: 'b', status: 'completed', description: 'FINISHED_SENTINEL' },
    { id: 'a', status: 'running', description: 'ROOT_SENTINEL 한글🙂', category: 'visual-engineering',
      model: 'REAL_MODEL', progress: 'LATEST_PROGRESS', startedAt: '2026-09-06T00:00:00Z', turns: 0, toolCalls: 2 },
    { id: 'child', parentTaskId: 'a', status: 'interrupted', description: 'CHILD_SENTINEL' },
    { id: 'grandchild', parentTaskId: 'child', status: 'lost', description: 'GRANDCHILD_SENTINEL' },
    { id: 'c', status: 'error', description: 'ERROR_SENTINEL' },
  ] };
  const original = structuredClone(state);
  assert.deepEqual(standaloneTasks(state).map(task => task.id), ['a', 'b', 'c']);
  const viewState = emptyViewState('session');
  setExpanded(viewState, TASK_SCOPE, 'a', false);
  const options = { rows: 200, columns: 54, color: false, viewState, selectedTaskId: 'a', now: Date.parse('2026-09-06T00:01:02Z') };
  const fresh = renderFrame(state, options);
  assert.equal(fresh.taskRanges.a.end - fresh.taskRanges.a.start, 3, 'lost descendant remains actionable');
  for (const id of ['b','c']) assert.equal(fresh.taskRanges[id].end - fresh.taskRanges[id].start, 1);
  assert.doesNotMatch(fresh.text, /LATEST_PROGRESS|− CHILD_SENTINEL|REAL_MODEL/);
  assert.match(fresh.text, /\? GRANDCHILD_SENTINEL/);
  setExpanded(viewState, TASK_SCOPE, 'c', true);
  const frame = renderFrame(state, { ...options, verbose: true });
  for (const value of ['ROOT_SENTINEL', 'visual-engineering', 'REAL_MODEL', 'LATEST_PROGRESS', '00:01:02',
    'CHILD_SENTINEL', 'GRANDCHILD_SENTINEL', 'ERROR_SENTINEL']) assert.ok(frame.text.includes(value), value);
  assert.ok(frame.taskRanges.a);
  assert.ok(frame.text.includes(`${messages.en.category}: visual-engineering`));
  assert.ok(frame.text.includes(`${messages.en.turns}: 0`));
  for (const token of ['× ERROR_SENTINEL', '− CHILD_SENTINEL', '? GRANDCHILD_SENTINEL']) assert.ok(frame.text.includes(token), token);
  assert.ok(render(state, { ...options, selectedTaskId: 'c', verbose: true }).includes(messages.en.error));
  assert.ok(!frame.text.includes(messages.en.dependencies));
  setExpanded(viewState, TASK_SCOPE, 'a', false);
  const collapsed = render(state, { ...options, viewState });
  assert.ok(collapsed.includes('ROOT_SENTINEL'));
  assert.ok(!collapsed.includes('LATEST_PROGRESS'));
  assert.ok(!collapsed.includes('− CHILD_SENTINEL'));
  assert.match(collapsed, /\? GRANDCHILD_SENTINEL/);
  state.runs = [{ id: 'r1', name: 'ONE', status: 'running', nodes: [{ id: 'n', state: 'running', label: 'NODE', taskId: 'b' }], edges: [] },
    { id: 'r2', name: 'TWO', status: 'running', nodes: [{ id: 'n', state: 'running', label: 'NODE', taskId: 'c' }], edges: [] }];
  assert.deepEqual(standaloneTasks(state).map(task => task.id), ['a']);
  const mixed = render(state, { ...options, view: 'tasks' });
  assert.ok(mixed.includes('ROOT_SENTINEL'));
  assert.ok(!mixed.includes('FINISHED_SENTINEL'));
  assert.ok(!mixed.includes('ERROR_SENTINEL'));
  const dag = render(state, options);
  assert.ok(dag.includes(messages.en.tasks));
  assert.ok(!dag.includes('ROOT_SENTINEL'));
  state.runs = [];
  assert.deepEqual(state, original);
  for (const columns of [8, 20, 35, 54, 80]) for (const language of ['en', 'ko', 'zh-cn']) {
    const text = render(state, { ...options, columns, language });
    assert.ok(text.split('\n').every(line => width(line) < columns), `${language}: ${columns}`);
  }
});

test('several runs show no run list; the footer names the selected run position', () => {
  const state = { connected: true, runs: [
    { id: 'active', name: 'ACTIVE_RUN', status: 'running', nodes: [
      { id: 'a', label: 'A', state: 'running' }, { id: 'b', label: 'B', state: 'pending' }, { id: 'c', label: 'C', state: 'completed' }], edges: [] },
    { id: 'done', name: 'DONE_RUN', status: 'completed', nodes: [
      { id: 'd', label: 'D', state: 'completed' }], edges: [] },
  ] };
  const foot = frame => frame.text.split('\n').at(-1);
  const frame = renderFrame(state, { columns: 54, rows: 40, color: false, runIndex: 0 });
  assert.match(frame.text, /ACTIVE_RUN/);
  assert.doesNotMatch(frame.text, /Active runs|Completed runs|total ·/);
  assert.match(foot(frame), /Run 1\/2$/);
  assert.match(foot(renderFrame(state, { columns: 54, rows: 40, color: false, runIndex: 1 })), /Run 2\/2$/);
  assert.doesNotMatch(renderFrame({ connected: true, runs: [state.runs[0]] }, { columns: 54, rows: 40, color: false }).text, /Run 1\/1/);
  const many = { connected: true, runs: Array.from({ length: 12 }, (_, index) => ({ id: `run-${index}`, name: `RUN_${index}`,
    status: 'running', nodes: [{ id: 'node', label: `NODE_${index}`, state: 'running' }], edges: [] })) };
  const middle = renderFrame(many, { columns: 80, rows: 40, color: false, runIndex: 8 });
  assert.match(middle.text, /RUN_8/);
  assert.doesNotMatch(middle.text, /RUN_7|RUN_9/);
  assert.match(foot(middle), /Run 9\/12$/);
});

test('compact cards share content-height safe lines, localized counts, selected-only detail, and temporary collapse override', () => {
  const progress = `PROGRESS_HEAD ${'한글🙂 useful work '.repeat(20)} PROGRESS_TAIL`;
  const state = { connected: true, runs: [], tasks: [
    { id: 'root-id', status: 'running', description: '\x1b[31mROOT_DESCRIPTION\x1b[0m', agent: 'worker', category: 'visual',
      model: 'opencodex/gpt-5.4 (high)', progress, startedAt: '2026-09-06T00:00:00Z', turns: 20, toolCalls: 65 },
    { id: 'child-id', parentTaskId: 'root-id', status: 'completed', description: 'CHILD_DESCRIPTION' },
    { id: 'other-id', status: 'failed', description: 'OTHER_DESCRIPTION', progress: 'OTHER_PROGRESS' },
  ] };
  const expanded = emptyViewState('session');
  for (const id of ['root-id', 'other-id']) setExpanded(expanded, TASK_SCOPE, id, true);
  for (const id of ['node', 'missing']) setExpanded(expanded, 'run', id, true);
  const options = { columns: 80, rows: 200, color: false, viewState: expanded, selectedTaskId: 'root-id', now: Date.parse('2026-09-06T00:09:05Z') };
  const card = (frame, id, kind = 'taskRanges') => frame.text.split('\n').slice(frame.bodyStart + frame[kind][id].start - frame.scroll, frame.bodyStart + frame[kind][id].end - frame.scroll);
  const compact = renderFrame(state, options);
  const lines = card(compact, 'root-id');
  assert.equal(lines.length, 5, 'three root rows, subtask divider and one child row');
  assert.equal(lines[0], '▌⠋ ROOT_DESCRIPTION · ⧖ 9m 5s');
  assert.doesNotMatch(lines[0], />/);
  assert.match(lines[1], /\[worker\/visual\] gpt-5.4 \(high\)/);
  assert.doesNotMatch(lines.join('\n'), /PROGRESS_HEAD/);
  assert.equal(lines[2], '▌20 turns · 65 tools');
  assert.match(lines[4], /↳ ✓ CHILD_DESCRIPTION/);
  assert.match(card(compact, 'other-id')[0], /× OTHER_DESCRIPTION/);
  assert.doesNotMatch(lines.join('\n'), /root-id|child-id|opencodex\/|PROGRESS_TAIL|2026-09-06/);
  assert.ok(!lines.join('\n').includes('\x1b'));
  const korean = renderFrame(state, { ...options, language: 'ko' });
  assert.match(card(korean, 'root-id')[0], /9m 5s/);
  assert.match(card(korean, 'root-id')[2], /20 turns · 65 tools/);
  const full = renderFrame(state, { ...options, verbose: true });
  const fullRoot = card(full, 'root-id').join('\n');
  for (const token of ['root-id', 'PROGRESS_HEAD', 'PROGRESS_TAIL', '2026-09-06T00:00:00Z', 'gpt-5.4']) assert.ok(fullRoot.includes(token), token);
  assert.doesNotMatch(fullRoot, /opencodex\//);
  assert.equal(card(full, 'other-id').length, 1);
  assert.doesNotMatch(card(full, 'other-id').join('\n'), /OTHER_PROGRESS/);
  assert.equal(card(renderFrame(state, { ...options, selectedTaskId: undefined, verbose: true }), 'root-id').length, 5);
  const viewState = emptyViewState('session');
  setExpanded(viewState, TASK_SCOPE, 'root-id', false);
  const saved = structuredClone(viewState);
  const collapsed = renderFrame(state, { ...options, viewState });
  assert.equal(card(collapsed, 'root-id').length, 1);
  assert.doesNotMatch(card(collapsed, 'root-id').join('\n'), /PROGRESS_HEAD|CHILD_DESCRIPTION/);
  assert.ok(card(renderFrame(state, { ...options, viewState, verbose: true }), 'root-id').join('\n').includes('PROGRESS_TAIL'));
  assert.deepEqual(viewState, saved);
  assert.deepEqual(renderFrame(state, { ...options, viewState }), collapsed);
  state.runs = [{ id: 'run', name: 'RUN', status: 'running', nodes: [
    { id: 'node', label: 'GRAPH_LABEL', state: 'running', taskId: 'root-id' },
    { id: 'missing', label: 'MISSING_LABEL', state: 'pending' },
  ], edges: [{ from: 'node', to: 'missing' }] }];
  const freshDag = renderFrame(state, { ...options, viewState: { expanded: { '["run","node"]': false } } });
  for (const range of Object.values(freshDag.nodeRanges)) assert.equal(range.end - range.start, 1);
  assert.doesNotMatch(freshDag.text, /PROGRESS_HEAD|CHILD_DESCRIPTION/);
  const dag = renderFrame(state, { ...options, selectedNodeId: 'node' });
  const dagCard = card(dag, 'node', 'nodeRanges');
  assert.match(dagCard[0], /^└▌⠋ GRAPH_LABEL/);
  assert.doesNotMatch(dagCard.join('\n'), /PROGRESS_HEAD/);
  const dagRows = dagCard;
  const detailRows = rows => rows.map(row => row.replace(/^[│ ]*▌\s*/, '')).filter(row => /^\[|^↳/.test(row));
  assert.deepEqual(detailRows(lines), detailRows(dagRows));
  assert.ok(dag.stageRanges[0].nodeIds.includes('node') && dag.stageRanges[1].nodeIds.includes('missing'));
  const missing = card(dag, 'missing', 'nodeRanges');
  assert.equal(missing.length, 1);
  assert.match(missing[0], /○ MISSING_LABEL/);
  assert.doesNotMatch(missing.join('\n'), /undefined|null|NaN|0 turns/);
  for (const columns of [8, 20, 35, 54, 80]) for (const color of [false, true]) {
    const narrow = renderFrame(state, { ...options, columns, color, selectedNodeId: 'node' });
    assert.ok(narrow.text.split('\n').every(line => width(line) < columns));
    // Where the badge and the model cannot share a row, the badge keeps its own row and the model follows it.
    const narrowCard = card(narrow, 'node', 'nodeRanges');
    assert.equal(narrowCard.length, columns < 35 ? 6 : 5, `${columns}`);
    if (!color && columns >=20) assert.match(narrowCard[1], /^ ▌\[[^\]]+\]/u, `${columns}`);
  }
});

test('DAG detail borders identify their node without changing card height or standalone borders', () => {
  const label = '검증-node🙂'.repeat(8);
  const node = { id: 'node-id', label, state: 'running', taskId: 'task' };
  const state = { connected: true, runs: [{ id: 'run', name: 'Run', status: 'running', nodes: [node], edges: [] }],
    tasks: [{ id: 'task', description: 'Work' }, { id: 'standalone', description: 'Other work' }] };
  for (const columns of [8, 20, 35, 54, 100]) for (const expanded of [false, true]) {
    const viewState = emptyViewState('session');
    setExpanded(viewState, 'run', node.id, expanded);
    const options = { columns, rows: 100, color: false, viewState, selectedNodeId: node.id };
    const frame = renderFrame(state, options);
    const range = frame.nodeRanges[node.id];
    const card = frame.text.split('\n').slice(frame.bodyStart + range.start, frame.bodyStart + range.end);
    assert.equal(card.length, 1);
    assert.match(card[0], expanded ? /^└▌⠋/ : /^└ ⠋/);
    const detail=renderFrame(state,{...options,verbose:true});
    const border=detail.text.split('\n')[detail.bodyStart+detail.nodeRanges[node.id].start-detail.scroll];
    assert.ok(border.startsWith(`╭─ ${fit(label, columns - 7)} `));
    assert.equal(width(border), columns - 1);
    assert.ok(border.endsWith('─╮'));
    assert.ok(frame.text.split('\n').every(line => width(line) < columns));
    const colored = render(state, { ...options, color: true });
    assert.ok(colored.split('\n').every(line => width(line) < columns));
  }
  const full = render(state, { columns: 200, rows: 100, color: false, selectedNodeId: node.id, verbose: true });
  assert.ok(full.includes(`${label} (${node.id})`));
  node.label = '\x1b]52;c;YQ==\x07safe\x1b[2J\nnode';
  const cleanFrame = renderFrame(state, { columns: 54, rows: 100, color: false,selectedNodeId:node.id,verbose:true });
  assert.ok(cleanFrame.text.split('\n')[cleanFrame.bodyStart + cleanFrame.nodeRanges[node.id].start-cleanFrame.scroll].startsWith('╭─ safe node '));
  assert.ok(!cleanFrame.text.includes('\x1b'));
  const standalone = renderFrame(state, { columns: 54, rows: 100, color: false, view: 'tasks' });
  assert.equal(standalone.text.split('\n')[standalone.bodyStart + standalone.taskRanges.standalone.start], ' ? ▸ Other work');
  const standaloneDetail=renderFrame(state,{columns:54,rows:100,color:false,view:'tasks',selectedTaskId:'standalone',verbose:true});
  assert.equal(standaloneDetail.text.split('\n')[standaloneDetail.bodyStart+standaloneDetail.taskRanges.standalone.start-standaloneDetail.scroll],`╭${'─'.repeat(51)}╮`);
});

test('automatic card ranges and DAG markers use authoritative status, while booleans and detail remain independent', () => {
  for (const dag of [false, true]) for (const status of ['running', 'pending', 'blocked', 'scheduled', 'paused', 'completed', 'failed', 'cancelled', 'skipped', 'error', 'interrupted', 'lost', 'unknown', undefined]) {
    const task = { id: 'task', status: dag ? (status === 'running' ? 'completed' : 'running') : status, description: 'CARD_SENTINEL', progress: 'PROGRESS_SENTINEL',
      agent:'worker',model:'MODEL',turns:2 };
    const state = { connected: true, tasks: [task], runs: dag ? [{ id: 'run', name: 'Run', status: 'running',
      nodes: [{ id: 'node', label: 'NODE_SENTINEL', state: status, taskId: task.id }], edges: [] }] : [] };
    for (const preference of [undefined, false, true]) {
      const viewState = emptyViewState('session');
      if (preference !== undefined) setExpanded(viewState, dag ? 'run' : TASK_SCOPE, dag ? 'node' : 'task', preference);
      const saved = structuredClone(viewState);
      const options = { columns: 80, rows: 100, color: false, viewState, selectedNodeId: 'node', selectedTaskId: 'task' };
      const expanded = preference ?? status === 'running';
      const frame = renderFrame(state, options);
      const range = dag ? frame.nodeRanges.node : frame.taskRanges.task;
      assert.equal(range.end - range.start, expanded ? (status === 'paused' ? 4 : 3) : 1);
      assert.equal(frame.text.includes('PROGRESS_SENTINEL'), expanded && status === 'paused');
      if(!dag) assert.equal(frame.text.includes('▸ CARD_SENTINEL'), !expanded);
      if (dag && (status === 'unknown' || status === undefined)) {
        assert.match(frame.text, /\? NODE_SENTINEL/);
        assert.throws(() => renderFrame(state, { ...options, verbose: true }), /Unknown translation key/);
      } else {
        if (dag) assert.match(frame.text, expanded ? /└▌.*NODE_SENTINEL/ : /└ .*NODE_SENTINEL/);
        assert.ok(renderFrame(state, { ...options, verbose: true }).text.includes('PROGRESS_SENTINEL'));
      }
      assert.deepEqual(renderFrame(state, options), frame);
      assert.deepEqual(viewState, saved);
    }
  }
});

test('native snapshot retains the exact diamond edges and explicit states', () => {
  const [run] = sessionRuns(payload(), sessionId);
  assert.deepEqual(layers(run).map(row => row.map(node => node.id)), [['analyze'], ['server', 'ui'], ['integrate'], ['verify']]);
  assert.deepEqual(run.edges, payload().runs[0].edges);
  assert.equal(run.nodes[1].state, 'running');
});
test('foreign sessions and malformed graphs are never displayed', () => {
  assert.equal(sessionRuns(payload(), 'different-session'), null);
  const bad = payload(); bad.runs[0].edges.push({ from: 'unknown', to: 'ui' });
  assert.throws(() => sessionRuns(bad, sessionId), /snapshot/);
});
test('checkpoint camelCase and terminal failures are supported without exposing prompts', () => {
  const raw = payload().runs[0];
  const run = normalizeRun({ ...raw, run_id: undefined, runId: 'dag_checkpoint', createdAt: '2026-01-01',
    status: 'failed', nodes: [{ id: 'a', state: 'failed', error: { message: 'build failed' }, prompt: 'PRIVATE' }], edges: [] });
  assert.equal(run.nodes[0].error, 'build failed');
  assert.ok(!JSON.stringify(run).includes('PRIVATE'));
});
test('labels cannot inject terminal control sequences', () => {
  const raw = payload().runs[0]; raw.nodes[0].label = '\x1b]52;c;YQ==\x07분석\x1b[2J\nnext';
  const run = normalizeRun(raw);
  assert.equal(run.nodes[0].label, '분석 next');
});
test('narrow, normal, and wide terminals preserve row and display width limits', () => {
  const runs = sessionRuns(payload(), sessionId);
  for (const columns of [8, 12, 20, 35, 54, 81, 120]) for (const rows of [4, 10, 24, 48]) {
    const frame = render({ runs, connected: true }, { columns, rows, color: true });
    assert.equal(frame.split('\n').length, rows);
    for (const line of frame.split('\n')) assert.ok(width(line) < columns, `${columns}: ${line}`);
  }
  assert.equal(width('한글🙂e\u0301'), 7);
  assert.equal(width(fit('한글🙂abcdef', 8, true)), 8);
});
test('scrolling reveals every dependency stage and failure diagnostics', () => {
  const raw = payload(); raw.runs[0].nodes[4].last_error = { message: '검증 실패: timeout' };
  const state = { runs: sessionRuns(raw, sessionId), connected: false };
  const options = { columns: 54, rows: 14, color: false };
  const end = renderFrame(state, { ...options, scroll: 999 });
  const frame = end.text;
  const pages = [];
  for (let scroll = 0; scroll <= end.scroll; scroll++) pages.push(render(state, { ...options, scroll }));
  const traversed=pages.join('\n');
  for(const label of ['Analyze','Server','UI','Integrate','Verify']) assert.ok(traversed.includes(label),label);
  for(const stage of ['Step 1 1/1','Step 2 0/2','Step 3 0/1','Step 4 0/1']) assert.ok(traversed.includes(stage),stage);
  assert.match(frame, /검증 실패: timeout/);
  assert.match(frame, /Disconnected/);
});

test('expanded details wrap full task data and traverse only explicit descendants', () => {
  const run = { id: 'run', name: 'Run', status: 'running', nodes: [
    { id: 'a', label: 'Analyze', state: 'running', taskId: 'task-a' },
    { id: 'b', label: 'Build', state: 'pending', taskId: 'task-b' },
  ], edges: [{ from: 'a', to: 'b' }] };
  const progress = `PROGRESS_START ${'한글🙂 useful work '.repeat(8)} PROGRESS_END`;
  const state = { connected: true, runs: [run], tasks: [
    { id: 'task-a', description: `DESCRIPTION_START ${'readable description '.repeat(8)} DESCRIPTION_END`,
      agent: 'worker', model: 'test-model', progress, turns: 0, toolCalls: 7,
      startedAt: '2026-09-06T01:00:00Z', completedAt: '2026-09-06T01:02:00Z' },
    { id: 'child', parentTaskId: 'task-a', description: 'EXPLICIT_CHILD', status: 'running' },
    { id: 'grandchild', parentTaskId: 'child', description: 'EXPLICIT_GRANDCHILD' },
    { id: 'task-b', description: 'DEPENDENCY_NOT_CHILD' },
    { id: 'stray', description: 'UNRELATED_TASK' },
  ] };
  const frame = render(state, { columns: 54, rows: 200, color: false, selectedNodeId: 'a', verbose: true });
  for (const token of ['PROGRESS_START', 'PROGRESS_END', 'DESCRIPTION_START', 'DESCRIPTION_END',
    'worker', 'test-model', 'EXPLICIT_CHILD', 'EXPLICIT_GRANDCHILD', '2026-09-06T01:00:00Z', '2026-09-06T01:02:00Z']) assert.ok(frame.includes(token), token);
  assert.doesNotMatch(frame, /UNRELATED_TASK/);
  assert.ok(frame.split('\n').every(line => width(line) < 54));
  const a = renderFrame(state, { columns: 54, rows: 200, color: false, selectedNodeId: 'a', verbose: true }).nodeRanges.a;
  const aLines = frame.split('\n').slice(2 + a.start, 2 + a.end).join('\n');
  assert.doesNotMatch(aLines, /DEPENDENCY_NOT_CHILD/);
  assert.ok(aLines.includes(`${messages.en.turns}: 0`));
  assert.ok(aLines.includes(`${messages.en.toolCalls}: 7`));
  const collapsed = render(state, { columns: 54, rows: 200, color: false,
    viewState: { expanded: { '["run","a"]': false } } });
  assert.doesNotMatch(collapsed, /PROGRESS_START|EXPLICIT_CHILD|EXPLICIT_GRANDCHILD/);
  assert.match(collapsed, /DEPENDENCY_NOT_CHILD/);
  assert.ok(collapsed.indexOf('Analyze')<collapsed.indexOf('Step 2') &&
    collapsed.indexOf('Step 2')<collapsed.indexOf('Build'));
});

test('navigation keeps a selected detail header visible and scrolling remains bounded', () => {
  const runs = sessionRuns(payload(), sessionId);
  const state = { runs, connected: true };
  const frame = renderFrame(state, { rows: 14, columns: 54, selectedNodeId: 'verify', revealSelection: true, color: false, viewState: { expanded: { [JSON.stringify([runs[0].id, 'verify'])]: true } } });
  const card = frame.nodeRanges.verify;
  assert.ok(card.start >= frame.scroll && card.start < frame.scroll + frame.bodyRows);
  assert.ok(frame.text.includes(`○ ${runs[0].nodes.find(node => node.id === 'verify').label}`));
  const end = renderFrame(state, { rows: 14, scroll: 99999, color: false });
  assert.ok(end.scroll < 99999);
});

test('missing task metadata is explicit, cyclic subtasks terminate, and text cannot inject terminal controls', () => {
  const run = { id: 'r', name: 'R', status: 'running', nodes: [
    { id: 'missing', label: 'MISSING', state: 'running' },
    { id: 'linked', label: 'LINKED', state: 'running', taskId: 'parent' },
  ], edges: [] };
  const state = { runs: [run], connected: true, tasks: [
    { id: 'parent', parentTaskId: 'child', progress: '\x1b]52;c;YQ==\x07SAFE_PROGRESS\x1b[2J' },
    { id: 'child', parentTaskId: 'parent', description: 'CHILD_ONCE' },
  ] };
  const { text, nodeRanges } = renderFrame(state, { rows: 200, color: false, selectedNodeId: 'missing', verbose: true, viewState: { expanded: { '["r","linked"]': true } } });
  const missing = text.split('\n').slice(3 + nodeRanges.missing.start, 3 + nodeRanges.missing.end).join('\n');
  assert.ok(missing.includes(`${messages.en.task}: ${messages.en.noData}`));
  const linked = render(state, { rows: 200, color: false, selectedNodeId: 'linked', verbose: true });
  assert.ok(linked.includes(`${messages.en.agent}: ${messages.en.noData}`));
  // The progress sentence shows in the selected node's detail view, cleaned of terminal controls.
  assert.ok(linked.includes('SAFE_PROGRESS'));
  assert.ok(!linked.includes('\x1b'));
  assert.equal(text.match(/CHILD_ONCE/g)?.length, 1);
  assert.ok(!text.includes('\x1b'));
});

test('preference errors remain visible while details are scrolled', () => {
  const frame = render({ runs: sessionRuns(payload(), sessionId), connected: true },
    { rows: 14, scroll: 9999, notice: 'PREFERENCE_ERROR_SENTINEL', color: false });
  assert.ok(frame.includes('PREFERENCE_ERROR_SENTINEL'));
});

test('elapsed duration uses injected time, freezes completion, and never invents missing endpoints', () => {
  const startedAt = '2026-09-06T00:00:00.000Z';
  const now = Date.parse('2026-09-06T01:02:03.999Z');
  const state = { connected: true, runs: [{ id: 'r', name: 'R', status: 'running',
    nodes: [{ id: 'a', label: 'A', state: 'running', taskId: 'task' }], edges: [] }],
    tasks: [{ id: 'task', status: 'running', startedAt, turns: 0, toolCalls: 7 }] };
  const frame = (time = now) => render(state, { now: time, color: false, rows: 100, selectedNodeId: 'a', verbose: true });
  const elapsed = value => `${messages.en.elapsed}: ${value}`;
  assert.ok(frame().includes(elapsed('01:02:03')));
  assert.ok(frame(now + 1000).includes(elapsed('01:02:04')));
  const stats = frame().split('\n').find(line => line.includes(elapsed('01:02:03')));
  assert.ok(stats.includes(`${messages.en.turns}: 0`));
  assert.ok(stats.includes(`${messages.en.toolCalls}: 7`));
  // A root can use its actual DAG node state when task status is absent.
  delete state.tasks[0].status;
  assert.ok(frame().includes(elapsed('01:02:03')));
  state.tasks[0].completedAt = '2026-09-06T00:00:09.900Z';
  state.tasks[0].status = 'completed';
  assert.ok(frame().includes(elapsed('00:00:09')));
  assert.equal(frame(), frame(now + 86400000));
  for (const status of ['completed', 'failed', 'cancelled', 'lost', 'paused', 'pending']) {
    state.tasks[0] = { id: 'task', status, startedAt };
    assert.ok(frame().includes(elapsed(messages.en.noData)), status);
  }
  for (const task of [
    { id: 'task', status: 'running' },
    { id: 'task', status: 'running', startedAt: 'invalid' },
    { id: 'task', status: 'running', startedAt, completedAt: 'invalid' },
    { id: 'task', startedAt, completedAt: '2026-09-05T23:59:59Z' },
    { id: 'task', status: 'running', startedAt: '2026-09-07T00:00:00Z' },
  ]) {
    state.tasks[0] = task;
    assert.ok(frame().includes(elapsed(messages.en.noData)), JSON.stringify(task));
  }
  state.tasks[0] = { id: 'task', status: 'running', startedAt };
  state.connected = false;
  assert.ok(frame().includes(elapsed(messages.en.noData)));
  state.updatedAt = '2026-09-06T00:03:04Z';
  assert.ok(frame().includes(elapsed('00:03:04')));
  assert.equal(frame(), frame(now + 86400000));
});

test('elapsed duration follows explicit descendants without borrowing the parent node status', () => {
  const state = { connected: true, runs: [{ id: 'r', name: 'R', status: 'running',
    nodes: [{ id: 'a', label: 'A', state: 'running', taskId: 'parent' }], edges: [] }], tasks: [
    { id: 'parent', startedAt: '2026-09-06T00:00:00Z' },
    { id: 'child', parentTaskId: 'parent', status: 'running', startedAt: '2026-09-06T00:01:00Z' },
    { id: 'unknown', parentTaskId: 'parent', startedAt: '2026-09-06T00:01:00Z' },
  ] };
  const rendered=renderFrame(state,{now:Date.parse('2026-09-06T00:02:03Z'),color:false,rows:100,
    viewState:{expanded:{'["r","a"]':true}}});
  const frame=rendered.text;
  const range=rendered.nodeRanges.a;
  const interior=frame.split('\n').slice(rendered.bodyStart+range.start,rendered.bodyStart+range.end);
  assert.equal(interior.length, 4, 'parent, divider and two children without blank rows');
  assert.match(interior[0], /⧖ 2m 3s/);
  assert.match(interior[2], /⧖ 1m 3s/);
  assert.match(interior[3], /↳ \? -/);
  assert.doesNotMatch(interior[3],/⧖/);
  assert.doesNotMatch(interior[3], /1m 3s|2m 3s/);
});

test('DAG colors use theme ANSI and not fixed light-gray indexes', () => {
  const state = { connected: true, runs: [{ id: 'run', name: 'RUN', status: 'running', nodes: [
    { id: 'done', label: 'DONE_NODE', state: 'completed' },
    { id: 'wait', label: 'WAIT_NODE', state: 'pending' },
  ], edges: [{ from: 'done', to: 'wait' }] }] };
  const text = render(state, { columns: 80, rows: 40, color: true, selectedNodeId: 'wait' });
  const esc = String.fromCharCode(0x1b);
  assert.equal(text.includes(`${esc}[38;5;`), false);
  for (const index of [240, 244, 250, 252]) assert.equal(text.includes(`${esc}[${index}m`), false);
  assert.equal(text.includes(`${esc}[32m`), true);
  assert.equal(text.includes(`${esc}[36m`), true);
  assert.equal(render(state, { columns: 80, rows: 40, color: false, selectedNodeId: 'wait' }).includes(esc), false);
});

test('healthy worker cards have three rows (four when the model takes its own row); stalls, retries and paused tasks keep the message row', () => {
  const now = Date.parse('2026-10-19T00:10:00Z');
  const activity = (phase, extra = {}, age = 0, span = age) => ({ phase, since: now - span, lastAt: now - age, ...extra });
  const base = { id: 'st_card', status: 'running', description: 'CARD_TITLE', agent: 'worker', category: 'visual-engineering',
    model: 'provider/gpt-5.4', reasoningEffort: 'xhigh', progress: '[bash] HEALTHY_PROGRESS', startedAt: '2026-10-19T00:00:00Z',
    turns: 3, toolCalls: 4, metrics: { tokens_per_second: 12, cost_usd: 0.5, cost_status: 'reported' },
    activity: activity('text', { text: 'HEALTHY_TAIL' }) };
  const viewState = emptyViewState('session');
  setExpanded(viewState, TASK_SCOPE, 'st_card', true);
  const own = (task, columns, options = {}) => {
    const frame = renderFrame({ connected: true, runs: [], tasks: [task], ...options.state },
      { rows: 80, columns, color: false, now, viewState, ...options.render });
    const card = frame.text.split('\n').slice(2 + frame.taskRanges[task.id].start, 2 + frame.taskRanges[task.id].end);
    for (const line of frame.text.split('\n')) assert.ok(width(line) <= columns - 1, `${columns}: ${line}`);
    return card;
  };
  for (const columns of [28, 40, 80]) {
    // The role badge and the whole model:effort share a row only when both fit (80 columns here);
    // otherwise the model takes its own row instead of being cut short.
    const split = columns < 80, rows = split ? 4 : 3;
    const healthy = own(base, columns);
    assert.equal(healthy.length, rows, `${columns}: ${healthy.join(' / ')}`);
    assert.doesNotMatch(healthy.join('\n'), /HEALTHY_PROGRESS|HEALTHY_TAIL|✎|\$0\.5/);
    assert.match(healthy[0], /⠋ CARD_TITLE · ⧖ 10m 0s/);
    if (split) assert.ok(healthy[2].includes('gpt-5.4:xhigh') && !healthy[2].includes('…'), healthy[2]);
    else assert.ok(healthy[1].includes('[worker/visual-engineering] gpt-5.4:xhigh'), healthy[1]);
    assert.match(healthy[rows - 1], /12 tok\/s · 3 turns/);
    const stalled = own({ ...base, activity: activity('text', { text: 'STALL_TAIL' }, 45000) }, columns);
    assert.equal(stalled.length, rows + 1, `${columns}: ${stalled.join(' / ')}`);
    assert.match(stalled[rows - 1], /⚠/);
    const retry = own({ ...base, activity: activity('retry', { attempt: 2, maxAttempts: 3 }, 4000) }, columns);
    assert.equal(retry.length, rows + 1, `${columns}: ${retry.join(' / ')}`);
    assert.match(retry[rows - 1], /↻/);
    const offline = own(base, columns, { state: { connected: false } });
    assert.equal(offline.length, rows, `${columns}: ${offline.join(' / ')}`);
    assert.doesNotMatch(offline.join('\n'), /HEALTHY_PROGRESS|HEALTHY_TAIL/);
    const paused = own({ ...base, status: 'paused', progress: 'PAUSED_SENTENCE' }, columns);
    assert.equal(paused.length, rows + 1, `${columns}: ${paused.join(' / ')}`);
    assert.match(paused[rows - 1], /PAUSED/);
    // The selected detail view still shows a healthy card's progress sentence.
    const detail = renderFrame({ connected: true, runs: [], tasks: [base] },
      { rows: 80, columns, color: false, now, viewState, selectedTaskId: 'st_card', verbose: true }).text;
    assert.match(detail.replace(/[│┆\s]+/g, ''), /HEALTHY_PROGRESS/);
  }
});

test('width counts text-presentation pictographs as one cell', () => {
  // Measured Herdr grid cells: text-presentation glyphs take one column.
  const cells = [
    ['A', 1], ['▶', 1], ['⚙', 1], ['⚠', 1], ['©', 1], ['▶\uFE0E', 1], ['▶\uFE0F', 2],
    ['⏳', 2], ['💭', 2], ['한', 2], ['👍🏽', 2], ['👨‍👩‍👧', 2], ['🇰🇷', 2], ['1\uFE0F\u20E3', 2],
  ];
  for (const [glyph, expected] of cells) assert.equal(width(glyph), expected, JSON.stringify(glyph));
});

test('detail box rows with a tool mark keep the right border aligned', () => {
  const now = Date.parse('2026-10-19T00:10:00Z');
  const task = { id: 'st_card', status: 'running', description: 'CARD_TITLE', agent: 'worker', category: 'visual-engineering',
    model: 'provider/gpt-5.4', reasoningEffort: 'xhigh', progress: 'HEALTHY_PROGRESS', startedAt: '2026-10-19T00:00:00Z',
    turns: 3, toolCalls: 4, metrics: { tokens_per_second: 12, cost_usd: 0.5, cost_status: 'reported' },
    activity: { phase: 'tool', tool: 'bash', since: now - 65000, lastAt: now - 65000 } };
  const text = renderFrame({ connected: true, runs: [], tasks: [task] },
    { rows: 80, columns: 40, color: false, language: 'en', now, selectedTaskId: task.id, verbose: true }).text;
  const lines = text.split('\n').map(clean);
  const top = lines.find(line => /^╭─*╮$/.test(line));
  const marked = lines.find(line => line.includes('▶'));
  assert.ok(top && marked, 'detail box and its tool-mark row are visible');
  assert.match(marked, /▶ bash running/);
  assert.equal([...marked].length, [...top].length, JSON.stringify(marked));
});

test('width matches measured Herdr cells for informative sequences', () => {
  // E/task-2/probe-herdr.json gridCells. The bare keycap 1\u20E3 is measured 1 but keeps Todo's
  // pre-existing 2 (listed as still-wrong in E/task-6/sequence-table-r2.json), so it is not asserted.
  const cells = [
    ['A', 1], ['▶', 1], ['⚙', 1], ['⚠', 1], ['⏳', 2], ['💭', 2], ['✓', 1], ['⧖', 1], ['↻', 1],
    ['✎', 1], ['©', 1], ['한', 2], ['▶\uFE0F', 2], ['▶\uFE0E', 1], ['⚙\uFE0F', 2], ['⚙\uFE0E', 1],
    ['⚠\uFE0F', 2], ['👁\u200D🗨', 2], ['👁\uFE0F\u200D🗨\uFE0F', 2], ['1\uFE0F\u20E3', 2],
    ['🇰🇷', 2], ['👍🏽', 2], ['👨‍👩‍👧', 2],
  ];
  for (const [glyph, expected] of cells) assert.equal(width(glyph), expected, JSON.stringify(glyph));
});
