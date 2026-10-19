import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { startViewer, VIEWER_FAILURE_GRACE_MS } from '../packages/todo/src/viewer.mjs';
import { renderFrame, width, strikeRevealCount } from '../packages/todo/src/render.mjs';
import { projectNativeTodo } from '../packages/todo/src/native-todo.mjs';
import { displayOwnerKey } from '../packages/todo/src/display-bridge.mjs';

const project = () => projectNativeTodo([{ type: 'custom', customType: 'senpi.todo-state',
  data: { schema: 'v2', phases: [{ name: 'Build', tasks: [
    { content: 'completed fixture', status: 'completed' },
    { content: 'abandoned fixture', status: 'abandoned' },
    { content: '한글 wide words e\u0301 👩‍💻 long wrapped fixture '.repeat(5), status: 'in_progress' },
    { content: 'pending fixture', status: 'pending' },
  ] }] } }]);
function clock() {
  let now = 0, id = 0;
  const timers = new Map();
  return { now: () => now,
    setTimeout(fn, ms) { const key = ++id; timers.set(key, { fn, at: now + ms }); return key; },
    clearTimeout: key => timers.delete(key),
    setInterval(fn, ms) { const key = ++id; timers.set(key, { fn, ms }); return key; },
    clearInterval: key => timers.delete(key),
    advance(ms) { now += ms; for (const [key, timer] of [...timers]) if (timer.at <= now) {
      timers.delete(key); timer.fn();
    } },
    get size() { return timers.size; },
  };
}
class Output extends EventEmitter {
  columns = 80; rows = 24; isTTY = true;
  write(_text, callback) { queueMicrotask(() => callback?.()); return true; }
}
async function fixture(t) {
  const directory = await mkdtemp(fileURLToPath(new URL('../.b-viewer-', import.meta.url)));
  const statePath = join(directory, 'todo.json'), input = new PassThrough(), output = new Output(), time = clock();
  const state = { schema: 'omo-herdr-dashboard/role/1', role: 'todo',
    ownerKey: displayOwnerKey('fixture-socket', 'fixture-pane', 'fixture-session'),
    sessionId: 'fixture-session', scopeEpoch: 1, paneId: randomUUID(), launchToken: randomUUID(),
    cachePath: join(directory, 'cache.json'), prefsPath: `${statePath}.view.json`, language: 'en' };
  const snapshot = { ...project(), ...state, sequence: 1, availability: 'current' };
  let failure;
  const watcher = new EventEmitter(); watcher.close = () => {};
  const viewer = await startViewer({ statePath, paneId: state.paneId, launchToken: state.launchToken }, {
    input, output, interactive: true, clock: time, watchState: () => watcher,
    readState: async () => { if (failure) throw failure; return state; },
    readCache: async () => ({ snapshot, availability: 'current', error: '' }),
  });
  await viewer.draw();
  t.after(async () => { await viewer.close(false); input.destroy(); assert.equal(time.size, 0);
    await rm(directory, { recursive: true, force: true }); });
  return { viewer, time, watcher, directory, set failure(value) { failure = value; } };
}
for (const code of ['EPERM', 'EBUSY', 'ENOENT', 'SyntaxError']) {
  test(`Todo ${code}: exact grace boundary, identical retained ANSI frame, recovery cancels fallback`, async t => {
    const f = await fixture(t), original = f.viewer.frame.text, target = f.viewer.state.target;
    f.failure = code === 'SyntaxError' ? new SyntaxError('PRIVATE fixture /not/a/logged/path') :
      Object.assign(new Error('PRIVATE fixture /not/a/logged/path'), { code });
    await f.viewer.refresh(); await f.viewer.draw();
    assert.equal(f.viewer.frame.text, original);
    assert.equal(f.viewer.state.availability, 'current');
    assert.deepEqual(f.viewer.state.target, target);
    f.time.advance(VIEWER_FAILURE_GRACE_MS - 1); await f.viewer.draw();
    assert.equal(f.viewer.frame.text, original);
    f.failure = undefined;
    await f.viewer.refresh();
    f.time.advance(1); await f.viewer.draw();
    assert.equal(f.viewer.frame.text, original);
    f.failure = Object.assign(new Error('PRIVATE fixture'), { code: 'EPERM' });
    await f.viewer.refresh();
    f.time.advance(VIEWER_FAILURE_GRACE_MS); await f.viewer.draw();
    assert.equal(f.viewer.state.availability, 'last-known');
    assert.deepEqual(f.viewer.state.target, target);
    assert.equal(f.viewer.frame.taskRanges[target.key].status, 'in_progress');
    assert.notEqual(f.viewer.frame.text, original);
    f.failure = undefined; await f.viewer.refresh(); await f.viewer.draw();
    // A role read after retirement is not a live presence snapshot.
    assert.equal(f.viewer.state.availability, 'last-known');
    assert.equal(f.viewer.state.role.scopeEpoch, 1);
  });
}
test('Todo diagnostics bound their ring and contain only timestamp, branch and error code', async t => {
  const f = await fixture(t);
  f.failure = Object.assign(new Error('PRIVATE task content C:/secret'), { code: 'EPERM' });
  for (let index = 0; index < 210; index++) await f.viewer.refresh();
  // close flushes the serialized diagnostics writer without a timing wait.
  await f.viewer.close(false);
  const path = join(f.directory, 'todo.viewer-diagnostics.jsonl'), raw = await readFile(path, 'utf8');
  const entries = raw.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(entries.length, 200);
  assert.ok(Buffer.byteLength(raw) <= 64 * 1024);
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry), ['time', 'branch', 'code']);
    assert.equal(entry.time, new Date(0).toISOString());
    assert.equal(entry.branch, 'state-read');
    assert.equal(entry.code, 'EPERM');
  }
  assert.ok(!raw.includes('PRIVATE') && !raw.includes('C:/'));
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
});
for (const columns of [24, 30, 40, 54, 80, 120]) for (const language of ['en', 'ko', 'zh-cn']) {
  test(`Todo Pi markers and hanging indent fit ${columns} columns in ${language}`, () => {
    const snapshot = project(), frame = renderFrame(snapshot, { columns, rows: 60, language,
      completedExpanded: true, color: true });
    for (const line of [...frame.lines, ...frame.bodyLines]) assert.ok(width(line) < columns);
    const markers = ['[✓]', '[×]', '[•]', '[ ]'];
    for (const [index, key] of snapshot.phaseSummaries[0].taskKeys.entries()) {
      const range = frame.taskRanges[key], lines = frame.bodyLines.slice(range.start, range.end).map(stripVTControlCharacters);
      assert.equal(lines[0].slice(0, 3), markers[index]);
      for (const line of lines.slice(1)) assert.ok(line.startsWith('    '));
    }
    assert.ok(frame.bodyLines[frame.taskRanges[snapshot.target.key].start].startsWith('\x1b[1;36m'));
  });
}
test('completion strike reveal is a pure bounded frame value across wrapped rows', () => {
  const snapshot = project(), key = snapshot.phaseSummaries[0].taskKeys[0];
  snapshot.phases[0].tasks[0].content = 'completed fixture '.repeat(6);
  assert.deepEqual([0, 1, 2, 3, 14].map(frame => strikeRevealCount('123456789012', frame)), [0, 0, 0, 1, 12]);
  const head = frame => renderFrame(snapshot, { color: true, completionFrames: new Map([[key, frame]]) })
    .bodyLines.find(line => stripVTControlCharacters(line).includes('completed fixture'));
  assert.ok(!head(0).includes('\x1b[9m'));
  assert.ok(head(3).includes('\x1b[9m'));
  assert.equal(stripVTControlCharacters(head(3)), stripVTControlCharacters(head(14)));
  const frame = renderFrame(snapshot, { columns: 24, color: true, completionFrames: new Map([[key, 3]]) });
  const range = frame.taskRanges[key], lines = frame.bodyLines.slice(range.start, range.end);
  assert.ok(lines.length > 1);
  assert.ok(!lines.at(-1).includes('\x1b[9m'));
});
