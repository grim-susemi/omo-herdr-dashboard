import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import { normalizeRun } from '../src/model.mjs';
import { renderFrame, runningTarget } from '../src/render.mjs';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/active-tracking/${name}.json`, import.meta.url), 'utf8'));
const render = (state, options = {}) => renderFrame(state, {
  view: 'dag', fixed: true, columns: 54, rows: 18, color: false, ...options,
});

for (const [name, node, label, rows] of [
  ['f1', 'r0', 'RUNNING_PRIMARY', 18],
  ['f2', 'n8', 'FINAL_RUNNING', 48],
  ['f2', 'n8', 'FINAL_RUNNING', 18],
]) {
  test(`${name} ${rows} rows pins running title inside physical top eight`, () => {
    const state = fixture(name);
    const frame = render(state, { rows, runningNodeId: node });
    const top = stripVTControlCharacters(frame.text).split('\n').slice(0, 8);
    assert.ok(top.some(line => line.includes(label) && /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u.test(line)),
      `running status and ${label} must appear together in rows 1-8:\n${frame.text}`);
  });
}

test('final-stage header is the first body row even when the body fits', () => {
  const frame = render(fixture('f2'), { rows: 48, runningNodeId: 'n8' });
  assert.match(frame.text.split('\n')[frame.bodyStart], /Step 9\b/);
});

test('pending is not running even when the task has no unmet edges', () => {
  const state = fixture('f1');
  const normalized = normalizeRun({ ...state.runs[0], runId: state.runs[0].id });
  assert.notEqual(normalized, null, 'fixture must be a valid snapshot');
  for (const node of state.runs[0].nodes) if (['r0', 'r1'].includes(node.id)) node.state = 'completed';
  assert.equal(runningTarget(state), undefined);
});

test('normalization rejects a node with an unknown state or null id', () => {
  const state = fixture('f1');
  const run = { ...state.runs[0], runId: state.runs[0].id };
  assert.notEqual(normalizeRun(run), null);
  for (const invalid of [{ state: 'INVALID_STATE' }, { id: null }]) {
    const malformed = structuredClone(run);
    Object.assign(malformed.nodes[0], invalid);
    assert.equal(normalizeRun(malformed), null);
  }
});

test('existing target survives reorder and retry, then hands off', () => {
  const state = fixture('f1');
  const target = runningTarget(state);
  state.runs[0].nodes.reverse();
  state.runs[0].nodes.find(node => node.id === 'r0').taskId = 'retry';
  assert.equal(runningTarget(state, target).nodeId, 'r0');
  state.runs[0].nodes.find(node => node.id === 'r0').state = 'completed';
  assert.equal(runningTarget(state, target).nodeId, 'r1');
});

test('scheduled fallback displays its actual status in the top eight rows', () => {
  const state = fixture('f3-scheduled-only');
  assert.equal(runningTarget(state), undefined);
  const top = render(state).text.split('\n').slice(0, 8).join('\n');
  assert.match(top, /◷\s+SCHEDULED_TARGET/);
});

test('scheduled title and status appear in the first three body rows', () => {
  const frame = render(fixture('f3-scheduled-only'), { rows: 8 });
  const firstBodyRows = frame.text.split('\n').slice(frame.bodyStart, frame.bodyStart + 3);
  assert.ok(firstBodyRows.some(line => /◷\s+SCHEDULED_TARGET/.test(line)), frame.text);
});

test('older running run takes precedence over a newer completed run', () => {
  const state = fixture('f3');
  assert.equal(runningTarget(state).runId, 'old');
});

test('finished runs do not acquire a running target', () => {
  for (const name of ['f4', 'f4-mixed-results']) {
    const state = fixture(name);
    assert.equal(runningTarget(state), undefined);
    const frame = render(state, { rows: 48 });
    for (const node of state.runs[0].nodes) assert.ok(frame.text.includes(node.label), node.label);
  }
});

test('completed stage spans fold reversibly without changing nodes or edges', () => {
  for (const name of ['f2', 'f4', 'f4-mixed-results']) {
    const state = fixture(name);
    const before = JSON.stringify(state.runs[0]);
    const folded = render(state, { rows: 100, follow: false, dagCompletedExpanded: false });
    const expanded = render(state, { rows: 100, follow: false, dagCompletedExpanded: true });
    const done = state.runs[0].nodes.filter(node => node.state === 'completed');
    if (name === 'f2') {
      assert.match(folded.text, /Completed 8 · Step 1–8/);
      for (const node of done) assert.ok(!folded.text.includes(node.label));
    }
    for (const node of state.runs[0].nodes) {
      assert.ok(expanded.text.includes(node.label), node.label);
      if (node.state !== 'completed') assert.ok(folded.text.includes(node.label), node.label);
    }
    assert.equal(JSON.stringify(state.runs[0]), before);
  }
  const mixed = fixture('f4-mixed-results');
  mixed.runs[0].edges = [];
  const before = JSON.stringify(mixed.runs[0]);
  const frame = render(mixed, { rows: 100, follow: false, dagCompletedExpanded: false });
  assert.doesNotMatch(frame.text, /Completed \d+ · Step/);
  for (const node of mixed.runs[0].nodes) assert.ok(frame.text.includes(node.label), node.label);
  assert.equal(JSON.stringify(mixed.runs[0]), before);
});

test('selecting hidden completed history reveals its span without changing node preferences', () => {
  const state = fixture('f2');
  const viewState = { expanded: { '["run","n2"]': false } };
  const before = JSON.stringify(viewState);
  const frame = render(state, { rows: 100, follow: false, dagCompletedExpanded: false,
    selectedNodeId: 'n2', revealSelection: true, viewState });
  for (const node of state.runs[0].nodes) assert.ok(frame.text.includes(node.label), node.label);
  assert.equal(JSON.stringify(viewState), before);
});

for (const [name, ids, edges, selected, expected] of [
  ['next sibling', ['a', 'b', 'c', 'd'], [], 'b', 'c'],
  ['previous sibling', ['a', 'b', 'c', 'd'], [], 'd', 'c'],
  ['initial selection', ['a', 'b', 'c'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }], 'b', 'a'],
]) test(`viewer selects ${name} when the selected node is removed`, { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dag-selected-fallback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  const state = { sessionId: 'selection-fallback', connected: true, runs: [{
    id: 'selection-run', name: 'SELECTION_RUN', status: 'pending',
    nodes: ids.map(id => ({ id, label: `SELECT_${id.toUpperCase()}`, state: 'pending' })), edges,
  }], tasks: [] };
  await writeFile(file, JSON.stringify(state));
  const viewer = fileURLToPath(new URL('../src/viewer.mjs', import.meta.url));
  const bridge = fileURLToPath(new URL('./windows-pty.mjs', import.meta.url));
  const child = spawn(process.execPath, [bridge, viewer, '--state', file], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HERDR_ENV: '0' },
  });
  const frames = new EventEmitter();
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', line => frames.emit('frame', JSON.parse(line).frame));
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
      child.stdin.write(`${JSON.stringify({ keys: 'q' })}\n`);
      await exited;
    }
  });
  const waitFrame = (predicate, action) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Missing selection frame: ${stderr}`)), 5000);
    const onFrame = text => { if (predicate(text)) finish(null, text); };
    const onExit = code => finish(new Error(`Viewer exited ${code}: ${stderr}`));
    function finish(error, text) {
      clearTimeout(timer); frames.off('frame', onFrame); child.off('exit', onExit);
      if (error) reject(error); else resolve(text);
    }
    frames.on('frame', onFrame); child.on('exit', onExit);
    action?.();
  });
  const send = keys => child.stdin.write(`${JSON.stringify({ keys })}\n`);
  const bold = id => text => text.includes(`\x1b[1m○ SELECT_${id.toUpperCase()}`);
  await waitFrame(bold(ids[0]));
  for (const id of ids.slice(1, ids.indexOf(selected) + 1)) await waitFrame(bold(id), () => send('n'));
  state.runs[0].nodes = state.runs[0].nodes.filter(node => node.id !== selected);
  state.runs[0].edges = edges.filter(edge => edge.from !== selected && edge.to !== selected);
  const recovered = await waitFrame(text => stripVTControlCharacters(text).includes(`[0/${ids.length - 1}]`),
    () => writeFileSync(file, JSON.stringify(state)));
  assert.ok(bold(expected)(recovered), `expected selected ${expected}:\n${recovered}`);
  const expanded = await waitFrame(text => stripVTControlCharacters(text).includes('▌'), () => send(' '));
  assert.match(stripVTControlCharacters(expanded), new RegExp(`▌○ SELECT_${expected.toUpperCase()}\\b`));
});

test('DAG history toggle and selection reveal work in the viewer', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dag-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  await writeFile(file, JSON.stringify(fixture('f4')));
  const viewer = fileURLToPath(new URL('../src/viewer.mjs', import.meta.url));
  const bridge = fileURLToPath(new URL('./windows-pty.mjs', import.meta.url));
  const child = spawn(process.execPath, [bridge, viewer, '--state', file], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HERDR_ENV: '0' },
  });
  const frames = new EventEmitter();
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', line =>
    frames.emit('frame', stripVTControlCharacters(JSON.parse(line).frame)));
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
      child.stdin.write(`${JSON.stringify({ keys: 'q' })}\n`);
      await exited;
    }
  });
  const waitFrame = (predicate, input) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Missing frame after ${JSON.stringify(input)}: ${stderr}`)), 5000);
    const onFrame = text => { if (predicate(text)) finish(null, text); };
    const onExit = code => finish(new Error(`Viewer exited ${code}: ${stderr}`));
    function finish(error, text) {
      clearTimeout(timer); frames.off('frame', onFrame); child.off('exit', onExit);
      if (error) reject(error); else resolve(text);
    }
    frames.on('frame', onFrame); child.on('exit', onExit);
    if (typeof input === 'function') input();
    else if (input) child.stdin.write(`${JSON.stringify({ keys: input })}\n`);
  });
  await waitFrame(text => text.includes('Completed 3 · Step 1–3'));
  await waitFrame(text => text.includes('DONE_A') && text.includes('DONE_B') && text.includes('DONE_C'), 'c');
  await waitFrame(text => text.includes('Completed 3 · Step 1–3'), 'c');
  await waitFrame(text => text.includes('DONE_A') && text.includes('DONE_B') && text.includes('DONE_C'), 'n');
  await waitFrame(text => text.includes('DONE_A') && text.includes('DONE_C'), 'c');
  await waitFrame(text => text.includes('Completed 3 · Step 1–3'), 'c');
  await waitFrame(text => text.includes('DONE_A') && text.includes('DONE_C'), ' ');
  const state = fixture('f4');
  state.runs[0].nodes = Array.from({ length: 40 }, (_, index) =>
    ({ id: `n${index}`, label: `ANCHOR_${String(index).padStart(2, '0')}`, state: 'pending' }));
  state.runs[0].edges = [];
  await waitFrame(text => text.includes('ANCHOR_00'), () => writeFileSync(file, JSON.stringify(state)));
  const scrolled = await waitFrame(text => text.includes('ANCHOR_20'), '\x1b[6~');
  const first = Number(scrolled.match(/[├└].*ANCHOR_(\d\d)/)?.[1]);
  assert.ok(Number.isInteger(first) && first > 0 && first < 39, scrolled);
  state.runs[0].nodes = state.runs[0].nodes.filter(node => node.id !== `n${first}`);
  const next = `ANCHOR_${String(first + 1).padStart(2, '0')}`;
  const updated = await waitFrame(text => !text.includes(`ANCHOR_${String(first).padStart(2, '0')}`) && text.includes(next),
    () => writeFileSync(file, JSON.stringify(state)));
  assert.equal(updated.match(/[├└].*ANCHOR_(\d\d)/)?.[1], String(first + 1).padStart(2, '0'));
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
  child.stdin.write(`${JSON.stringify({ keys: 'q' })}\n`);
  assert.equal((await exited)[0], 0, stderr);
  assert.deepEqual(JSON.parse(readFileSync(`${file}.view.json`, 'utf8')).expanded, {});
});

test('overflow reports the exact running count while keeping scroll truthful', () => {
  const state = fixture('f1-running23');
  const frame = render(state, { runningNodeId: 'r00' });
  assert.match(frame.text, /running 23/i);
  assert.match(frame.text, /\d+–\d+\/\d+/);
  assert.ok(!frame.text.includes('RUN_22'), 'the viewport cannot expose all 23 concurrent runs');
});

test('manual navigation, inspection and pointer input each suspend follow', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'active-tracking-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  const state = fixture('f1');
  for (const node of state.runs[0].nodes) if (node.state === 'running') node.state = 'completed';
  await writeFile(file, JSON.stringify(state));
  const viewer = fileURLToPath(new URL('../src/viewer.mjs', import.meta.url));
  const bridge = fileURLToPath(new URL('./windows-pty.mjs', import.meta.url));
  const child = spawn(process.execPath, [bridge, viewer, '--state', file], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HERDR_ENV: '0' },
  });
  const frames = new EventEmitter();
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', line => {
    frames.emit('frame', stripVTControlCharacters(JSON.parse(line).frame));
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
      child.stdin.write(`${JSON.stringify({ keys: 'q' })}\n`);
      await exited;
    }
  });
  const waitFrame = (predicate, input) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`No frame arrived at all after ${JSON.stringify(input)}: ${stderr}`)), 5000);
    const onFrame = text => { if (predicate(text)) finish(null, text); };
    const onExit = code => finish(new Error(`Viewer exited ${code}: ${stderr}`));
    function finish(error, text) {
      clearTimeout(timer);
      frames.off('frame', onFrame);
      child.off('exit', onExit);
      if (error) reject(error); else resolve(text);
    }
    frames.on('frame', onFrame);
    child.on('exit', onExit);
    if (input) child.stdin.write(`${JSON.stringify({ keys: input })}\n`);
  });
  await waitFrame(text => text.includes('Follow ON'));
  await waitFrame(text => text.includes('Follow OFF'), 'f');
  await waitFrame(text => text.includes('Follow ON'), 'f');
  for (const input of ['j', 'k', '\x1b[B', '\x1b[A', '\x1b[6~', '\x1b[5~', 'n', 'p', '\t',
    '\x1b[Z', ' ', '\r', 'd', '\x1b[C', '\x1b[D',
    '\x1b[<64;5;5M', '\x1b[<65;5;5M', '\x1b[<0;5;5M', '\x1b[<32;5;6M', 'c', 't']) {
    const stopped = await waitFrame(() => true, input);
    assert.match(stopped, /Follow OFF/, `expected Follow OFF after ${JSON.stringify(input)}, got ${stopped.match(/Follow (?:ON|OFF)/)?.[0] ?? 'no follow status'}`);
    const resumed = await waitFrame(() => true, 'f');
    assert.match(resumed, /Follow ON/, `expected Follow ON after "f", got ${resumed.match(/Follow (?:ON|OFF)/)?.[0] ?? 'no follow status'}`);
  }
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
  child.stdin.write(`${JSON.stringify({ keys: 'q' })}\n`);
  assert.equal((await exited)[0], 0, stderr);
});
