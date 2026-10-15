import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter, once } from 'node:events';
import fs, { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TodoPane, dashboardChannels, readRoleState, registerRoleViewer, requestRoleClose, viewerProcess, paneViewerProcess, canCleanupPane, parseLaunchCommand } from '../src/controller.mjs';
import net from 'node:net';
import extension from '../extension.mjs';

const snapshot = { type: 'custom', customType: 'senpi.todo-state', data: {
  schema: 'v2', phases: [{ name: 'Build', tasks: [{ content: 'Native work', status: 'in_progress' }] }],
} };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, branch = [snapshot]) {
  const directory = join(tmpdir(), `todo-controller-${process.pid}-${randomUUID()}`);
  console.log(JSON.stringify({ event: 'resource-planned', pid: process.pid, directory }));
  await mkdir(directory);
  const environment = { HERDR_SOCKET_PATH: 'synthetic-socket', HERDR_PANE_ID: 'qa:parent' };
  const events = new EventEmitter();
  const calls = [], panes = new Map([['qa:parent', { pane_id: 'qa:parent', tab_id: 'qa:tab' }],
    ['qa:dag', { pane_id: 'qa:dag', tab_id: 'qa:tab' }], ['qa:workers', { pane_id: 'qa:workers', tab_id: 'qa:tab' }]]);
  const processes = new Map();
  const ctx = { hasUI: true, mode: 'tui', ui: { setWidget() {} },
    sessionManager: { getSessionFile: () => 'selected.jsonl', getSessionId: () => 'synthetic-session',
      getBranch: () => branch, getLeafId: () => 'leaf' } };
  let number = 0;
  const herdr = async (...args) => {
    calls.push(args);
    if (args[0] === 'list') return { panes: [...panes.values()] };
    if (args[0] === 'split') {
      const pane_id = `qa:todo${++number}`; panes.set(pane_id, { pane_id, tab_id: 'qa:tab' }); return { pane: { pane_id } };
    }
    if (args[0] === 'process-info') return { process_info: { foreground_processes: processes.get(args[2]) ?? [] } };
    if (args[0] === 'close') { panes.delete(args[1]); events.emit(`closed:${args[1]}`); return {}; }
    if (args[0] === 'run') {
      const argv = [...args[2].matchAll(/'((?:''|[^'])*)'/g)].map(match => match[1].replaceAll("''", "'"));
      const file = argv[argv.indexOf('--state') + 1], state = await readRoleState(file);
      processes.set(args[1], [{ pid: 5000 + number, argv }]);
      assert.equal(await registerRoleViewer({ state, paneId: args[1], launchToken: state.launchToken, pid: 5000 + number }), true);
      return {};
    }
    return {};
  };
  const controller = new TodoPane({ ctx, environment, stateDir: directory, cwd: directory,
    node: 'node', viewer: join(directory, 'viewer.mjs'), herdr });
  console.log(JSON.stringify({ event: 'resource-planned', pid: process.pid, controlPipe: controller.controlPath,
    presencePipe: controller.presencePath }));
  t.after(async () => {
    await controller.stop(); await rm(directory, { recursive: true, force: true });
    console.log(JSON.stringify({ event: 'resource-cleaned', pid: process.pid, directory, controlPipe: controller.controlPath,
      presencePipe: controller.presence?.offer('todo').pipePath }));
  });
  await controller.start();
  const source = new EventEmitter(), ready = deferred();
  const provider = {
    lifetimeId: 'synthetic-d-lifetime', binding: controller.binding, sourceReady: ready.promise,
    getSource: () => ({ connected: true, runs: [], tasks: [], updatedAt: 'reported-time' }),
    setCoordinator(value) { this.coordinator = value; },
    subscribeSource(callback) { source.on('source', callback); return () => source.off('source', callback); },
    async openPair({ offers, claim }) {
      assert.equal(controller.presence.state.snapshot?.sequence, 1);
      assert.equal(offers.dag.scopeEpoch, controller.scopeEpoch);
      assert.equal(claim.tabId, 'qa:tab');
      return { dag: { ...controller.binding, role: 'dag', tabId: 'qa:tab', paneId: 'qa:dag' },
        workers: { ...controller.binding, role: 'workers', tabId: 'qa:tab', paneId: 'qa:workers' } };
    },
  };
  const bus = new EventEmitter();
  const pi = { events: { on(name, callback) { bus.on(name, callback); return () => bus.off(name, callback); },
    emit: (name, value) => bus.emit(name, value) } };
  return { controller, calls, panes, processes, events, directory, provider, ready, source, pi, bus };
}

test('fresh native branch opens a waiting Todo and later native commit updates the same pane', async t => {
  const branch = [];
  const f = await fixture(t, branch);
  assert.equal(f.controller.presence.state.snapshot.availability, 'waiting');
  assert.deepEqual(f.controller.bridge.status.masked, []);
  f.ready.resolve(); f.controller.bind(f.pi);
  f.pi.events.emit(dashboardChannels.provider, { v: 1, kind: 'dag-provider', ...f.controller.binding, provider: f.provider });
  await f.controller.schedule();
  const before = await readRoleState(f.controller.stateFile);
  assert.equal(f.calls.filter(call => call[0] === 'split').length, 1);
  branch.push(snapshot);
  f.controller.bridge.observe({ type: 'tool_execution_end' }, f.controller.ctx);
  await f.controller.presence.idle();
  assert.equal(f.controller.presence.state.snapshot.availability, 'current');
  assert.equal(f.controller.presence.state.snapshot.counts.total, 1);
  assert.equal((await readRoleState(f.controller.stateFile)).paneId, before.paneId);
  assert.equal(f.calls.filter(call => call[0] === 'split').length, 1);
});

for (const order of ['provider-first', 'todo-first']) test(`${order}: source readiness, query/reply and concurrent layout create one Todo`, async t => {
  const f = await fixture(t), { controller, pi, bus, provider, ready } = f;
  const reply = event => {
    if (event.kind === 'dag-provider') pi.events.emit(dashboardChannels.reply,
      { v: 1, requestId: event.requestId, kind: 'dag-provider', ...controller.binding, provider });
  };
  if (order === 'provider-first') bus.on(dashboardChannels.query, reply);
  controller.bind(pi);
  if (order === 'todo-first') {
    bus.on(dashboardChannels.query, reply);
    pi.events.emit(dashboardChannels.provider, { v: 1, kind: 'dag-provider', ...controller.binding, provider });
  }
  assert.equal(f.calls.filter(call => call[0] === 'split').length, 0);
  ready.resolve();
  await Promise.all(Array.from({ length: 6 }, () => controller.schedule()));
  assert.equal(f.calls.filter(call => call[0] === 'split').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'run').length, 1);
  const split = f.calls.find(call => call[0] === 'split');
  assert.equal(split[split.indexOf('--pane') + 1], 'qa:workers');
  assert.ok(split.includes('--no-focus'));
  assert.equal(split[split.indexOf('--ratio') + 1], '0.5');
  assert.equal(controller.presence.state.snapshot.sequence, 1, 'layout must not republish the baseline');
  assert.equal(controller.status, 'current');
});

test('verified Todo pending readiness remains an owned anchor instead of pretending it is absent', async t => {
  const f = await fixture(t);
  f.ready.resolve(); f.controller.bind(f.pi);
  f.pi.events.emit(dashboardChannels.provider, { v: 1, kind: 'dag-provider', ...f.controller.binding, provider: f.provider });
  await f.controller.schedule();
  const record = JSON.parse(await readFile(f.controller.recordFile, 'utf8'));
  await writeFile(f.controller.recordFile, JSON.stringify({ ...record, ready: false }));
  const anchor = await f.controller.coordinator().inspectTodo();
  assert.equal(anchor?.paneId, record.paneId);
  assert.equal(anchor.ready, false);
});

test('manual close is authenticated, durable and reopened only by an explicit command', async t => {
  const f = await fixture(t);
  f.ready.resolve(); f.controller.bind(f.pi);
  f.pi.events.emit(dashboardChannels.provider, { v: 1, kind: 'dag-provider', ...f.controller.binding, provider: f.provider });
  await f.controller.schedule();
  let state = await readRoleState(f.controller.stateFile);
  assert.equal(await requestRoleClose({ state, paneId: 'foreign:pane', launchToken: state.launchToken }), false);
  const closed = once(f.events, `closed:${state.paneId}`, { signal: AbortSignal.timeout(2000) });
  assert.equal(await requestRoleClose({ state, paneId: state.paneId, launchToken: state.launchToken, pid: 5001 }), true);
  await closed;
  assert.equal(JSON.parse(await readFile(f.controller.recordFile, 'utf8')).manualClose, true);
  await f.controller.schedule();
  assert.equal(f.calls.filter(call => call[0] === 'split').length, 1);
  await f.controller.schedule({ forceRoles: ['todo'] });
  state = await readRoleState(f.controller.stateFile);
  assert.equal(state.paneId, 'qa:todo2');
  await f.controller.schedule({ forceRoles: ['todo'] });
  assert.equal(f.calls.filter(call => call[0] === 'split').length, 2);
});

test('a concurrent layout adoption cannot overwrite a committed manual close', { timeout: 7000 }, async t => {
  const f = await fixture(t); f.ready.resolve(); f.controller.bind(f.pi);
  f.pi.events.emit(dashboardChannels.provider, { v: 1, kind: 'dag-provider', ...f.controller.binding, provider: f.provider });
  await f.controller.schedule();
  const state = await readRoleState(f.controller.stateFile);
  const entered = new EventEmitter(), release = deferred();
  const original = f.controller.herdr;
  let paused = false;
  f.controller.herdr = async (...args) => {
    if (args[0] === 'process-info' && !paused) {
      paused = true; entered.emit('adoption'); await release.promise;
    }
    return original(...args);
  };
  const adopting = once(entered, 'adoption', { signal: AbortSignal.timeout(2000) });
  const updating = f.controller.schedule();
  await adopting;
  const closed = once(f.events, `closed:${state.paneId}`, { signal: AbortSignal.timeout(2000) });
  try {
    assert.equal(await requestRoleClose({ state, paneId: state.paneId, launchToken: state.launchToken, pid: 5001 }), true);
    await closed;
  } finally { release.resolve(); }
  await updating;
  assert.equal(JSON.parse(await readFile(f.controller.recordFile, 'utf8')).manualClose, true);
  assert.equal(f.calls.filter(call => call[0] === 'split').length, 1);
});

test('foreign and ambiguous anchors cannot create, close or resize panes', async t => {
  const f = await fixture(t);
  f.ready.resolve(); f.controller.bind(f.pi);
  f.panes.set('qa:workers', { pane_id: 'qa:workers', tab_id: 'foreign:tab' });
  f.pi.events.emit(dashboardChannels.provider, { v: 1, kind: 'dag-provider', ...f.controller.binding, provider: f.provider });
  await assert.rejects(f.controller.schedule(), /layout-waiting/);
  assert.equal(f.calls.filter(call => ['split', 'close', 'resize'].includes(call[0])).length, 0);
});

test('enqueue tail keeps a placement wait layout-waiting and an inline-fallback block BLOCKED', async t => {
  const f = await fixture(t);
  const notices = []; f.controller.notify = message => notices.push(message);
  const wait = 'layout-waiting: synthetic placement wait';
  await assert.rejects(f.controller.enqueue(async () => { throw new Error(wait); }), /^Error: layout-waiting: /);
  await f.controller.tail;
  assert.equal(f.controller.status, 'layout-waiting');
  assert.equal(notices.length, 1);
  assert.ok(notices[0].startsWith('layout-waiting: '));
  const block = Object.assign(new Error('BLOCKED: synthetic'),
    { inlineFallback: true });
  await assert.rejects(f.controller.enqueue(async () => { throw block; }), /^Error: BLOCKED: /);
  await f.controller.tail;
  assert.equal(f.controller.status, 'BLOCKED');
  assert.equal(notices.length, 2);
});

test('process adoption requires exact PID, state, token and unambiguous argv', () => {
  const record = { paneId: 'qa:pane', statePath: '/synthetic/state.json', viewerPath: '/synthetic/viewer.mjs',
    nodePath: 'node', launchToken: 'launch', processId: 123 };
  const good = { pid: 123, argv: ['node', record.viewerPath, '--state', record.statePath,
    '--close-pane', record.paneId, '--launch-token', record.launchToken] };
  assert.equal(viewerProcess({ process_info: { foreground_processes: [good] } }, record), good);
  for (const processes of [[{ ...good, pid: 124 }], [{ ...good, argv: good.argv.slice(0, -2) }],
    [{ ...good, argv: ['node', '/foreign/launcher.mjs', ...good.argv.slice(1)] }], [good, good]])
    assert.equal(viewerProcess({ process_info: { foreground_processes: processes } }, record), null);
});

test('retired provider and old scope offers cannot affect the current layout', async t => {
  const f = await fixture(t); f.ready.resolve(); f.controller.bind(f.pi);
  f.pi.events.emit(dashboardChannels.provider, { v: 1, kind: 'dag-provider', ...f.controller.binding, provider: f.provider });
  await f.controller.schedule();
  const mutations = () => f.calls.filter(call => ['split', 'run', 'close', 'resize'].includes(call[0])).length;
  const before = mutations();
  f.pi.events.emit(dashboardChannels.retired, { v: 1, ...f.controller.binding, lifetimeId: f.provider.lifetimeId });
  f.source.emit('source', { runs: [{ nodes: [] }], tasks: [] });
  await f.controller.schedule();
  assert.equal(mutations(), before);
  assert.equal(f.controller.status, 'layout-waiting');
});

test('Windows shell-only report verifies only the exact native Node child', async () => {
  if (process.platform !== 'win32') return;
  const record = { paneId: 'qa:pane', statePath: 'C:\\QA space\\state.json',
    viewerPath: 'C:\\QA space\\viewer.mjs', nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    launchToken: 'launch', processId: 123, creationProcessId: 456, creationDate: '2026-10-03T00:00:00.000Z' };
  const info = { process_info: { shell_pid: 456, foreground_processes: [{ pid: 456, argv: ['powershell.exe'] }] } };
  const shell = { ProcessId: 456, ExecutablePath: 'powershell.exe', CommandLine: 'powershell.exe',
    CreationDate: record.creationDate };
  const native = { ProcessId: 123, ParentProcessId: 456, ExecutablePath: record.nodePath,
    CreationDate: '2026-10-03T00:00:01.000Z',
    CommandLine: `"${record.nodePath}" "${record.viewerPath}" --state "${record.statePath}" --close-pane qa:pane --launch-token launch` };
  assert.equal((await paneViewerProcess(info, record, 123, async () => [shell, native])).pid, 123);
  for (const child of [null, { ...native, ProcessId: 124 }, { ...native, ParentProcessId: 457 },
    { ...native, ExecutablePath: 'C:\\foreign.exe' },
    { ...native, CommandLine: native.CommandLine.replace('--launch-token launch', '--launch-token stale') },
    { ...native, CommandLine: native.CommandLine.replace('qa:pane', 'qa:foreign') },
    { ...native, CommandLine: native.CommandLine.replace('state.json', 'foreign.json') }])
    assert.equal(await paneViewerProcess(info, record, 123, async () => child ? [shell, child] : [shell]), null);
  let inspected = false;
  for (const report of [{ process_info: { ...info.process_info, shell_pid: 457 } },
    { process_info: { ...info.process_info, foreground_processes: [{ pid: 456 }, { pid: 789 }] } }])
    assert.equal(await paneViewerProcess(report, record, 123, async () => { inspected = true; return native; }), null);
  assert.equal(inspected, false);
  for (const command of [native.CommandLine + ' --once', native.CommandLine + ' --launch-token launch',
    native.CommandLine + ' extra', native.CommandLine.replace('token launch', 'token "launchx'),
    native.CommandLine.replace('"C:\\QA space\\viewer.mjs"', '"C:\\QA space\\"viewer.mjs')]) {
    const child = { ...native, CommandLine: command };
    assert.equal(await paneViewerProcess(info, record, 123, async () => [shell, child]), null);
    assert.equal(await canCleanupPane(info, record, async () => [shell, child]), false);
  }
  assert.equal(parseLaunchCommand('--launch-token "launchx'), null);
  assert.equal(parseLaunchCommand('"node\\" --state state'), null);
  assert.equal(await canCleanupPane(info, record, async () => [shell]), true);
  assert.equal(await canCleanupPane(info, record, async () => [shell, native]), true);
  for (const rows of [[], [native], [shell, { ...native, ExecutablePath: 'foreign.exe' }],
    [shell, native, { ...native, ProcessId: 789 }], [shell, { ...native, CreationDate: undefined }],
    [{ ...shell, CreationDate: '2026-10-03T00:00:02.000Z' }, native]])
    assert.equal(await canCleanupPane(info, record, async () => rows), false);
  assert.equal(await canCleanupPane(info, record, async () => { throw new Error('CIM failed'); }), false);
  assert.equal(await paneViewerProcess(info, record, 123, async () =>
    [{ ...shell, CreationDate: '2026-10-03T00:00:02.000Z' }, native]), null);
});

test('scope rebinding updates an existing Todo even when the DAG provider has retired', async t => {
  const f = await fixture(t); f.ready.resolve(); f.controller.bind(f.pi);
  f.pi.events.emit(dashboardChannels.provider, { v: 1, kind: 'dag-provider', ...f.controller.binding, provider: f.provider });
  await f.controller.schedule();
  const before = await readRoleState(f.controller.stateFile);
  f.pi.events.emit(dashboardChannels.retired, { v: 1, ...f.controller.binding, lifetimeId: f.provider.lifetimeId });
  await f.controller.rebase(f.controller.ctx);
  const current = await readRoleState(f.controller.stateFile);
  assert.equal(current.scopeEpoch, 2);
  assert.equal(current.presenceOffer.scopeEpoch, 2);
  assert.equal(current.controlOffer.scopeEpoch, 2);
  assert.equal(current.paneId, before.paneId);
  assert.equal(current.launchToken, before.launchToken);
  assert.notEqual(current.cachePath, before.cachePath);
  assert.equal(JSON.parse(await readFile(current.cachePath, 'utf8')).snapshot.scopeEpoch, 2);
  assert.equal(f.calls.filter(call => call[0] === 'split').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'run').length, 1);
});

test('shell/native child proof supports real registration, reuse and manual close', async t => {
  const f = await fixture(t), original = f.controller.herdr;
  f.controller.herdr = async (...args) => args[0] === 'process-info'
    ? { process_info: { shell_pid: 7100, foreground_processes: [{ pid: 7100, argv: ['powershell.exe'] }] } }
    : original(...args);
  f.controller.inspectShell = async () => [{ ProcessId: 7100, ExecutablePath: 'powershell.exe',
    CommandLine: 'powershell.exe', CreationDate: '2026-10-03T00:00:00.000Z' },
  ...[...f.processes.values()].flat().map(row => ({ ProcessId: row.pid, ParentProcessId: 7100,
    ExecutablePath: row.argv[0], CommandLine: row.argv.map(value => `"${value}"`).join(' '),
    CreationDate: '2026-10-03T00:00:01.000Z' }))];
  f.ready.resolve(); f.controller.bind(f.pi);
  f.pi.events.emit(dashboardChannels.provider, { v: 1, kind: 'dag-provider', ...f.controller.binding, provider: f.provider });
  await f.controller.schedule();
  const state = await readRoleState(f.controller.stateFile);
  await f.controller.schedule();
  assert.equal(f.calls.filter(call => call[0] === 'split').length, 1);
  const closed = once(f.events, `closed:${state.paneId}`, { signal: AbortSignal.timeout(2000) });
  assert.equal(await requestRoleClose({ state, paneId: state.paneId, launchToken: state.launchToken, pid: 5001 }), true);
  await closed;
  assert.equal(JSON.parse(await readFile(f.controller.recordFile, 'utf8')).manualClose, true);
});

test('managed state rejects malformed role or owner identity', async t => {
  const f = await fixture(t), path = join(f.directory, 'invalid.json');
  assert.equal(await readRoleState(path), null);
  await writeFile(path, JSON.stringify({ schema: 'omo-herdr-dashboard/role/1', role: 'todo' }));
  await assert.rejects(readRoleState(path), /Invalid managed/);
});

test('an authenticated protocol ACK without verified pane creation cannot hide native Todo', async t => {
  const f = await fixture(t), offer = f.controller.presence.offer('todo');
  const events = new EventEmitter();
  const ack = once(events, 'ack', { signal: AbortSignal.timeout(2000) });
  const trace = event => { if (event.type === 'ack') events.emit('ack', event); };
  f.controller.presence.events.on('event', trace);
  const socket = net.createConnection(offer.pipePath);
  t.after(() => { socket.destroy(); f.controller.presence.events.off('event', trace); });
  socket.on('error', () => {});
  socket.once('connect', () => socket.write(`${JSON.stringify({ ...offer, type: 'hello' })}\n`));
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    const cut = buffer.indexOf('\n');
    if (cut < 0) return;
    const message = JSON.parse(buffer.slice(0, cut)); buffer = buffer.slice(cut + 1);
    if (message.type === 'snapshot') {
      // Adversarial input: valid protocol fields, deliberately no actual viewer.
      socket.write(`${JSON.stringify({ ...offer, type: 'ack', sequence: message.sequence })}\n`);
    }
  });
  const [received] = await ack;
  const receipt = { ...offer, sequence: received.sequence };
  assert.equal(f.controller.presence.isReady(receipt), true, 'protocol layer alone accepts the bound ACK');
  assert.equal(f.controller.adapter.isReady(receipt), false, 'controller also requires a proven owned role process');
  assert.deepEqual(f.controller.bridge.status.masked, []);
  assert.equal(f.calls.filter(call => call[0] === 'split').length, 0);
});

test('initial native source failure creates no pane and stop closes all local listeners', async t => {
  const directory = join(tmpdir(), `todo-source-failure-${process.pid}-${randomUUID()}`);
  console.log(JSON.stringify({ event: 'resource-planned', pid: process.pid, directory }));
  await mkdir(directory);
  const calls = [];
  const ctx = { hasUI: true, mode: 'tui', ui: { setWidget() {} }, sessionManager: {
    getSessionFile: () => 'parent.jsonl', getSessionId: () => 'source-failure',
    getBranch() { throw new Error('Native branch unavailable'); }, getLeafId: () => 'leaf',
  } };
  const owner = new TodoPane({ ctx, environment: { HERDR_SOCKET_PATH: 'qa:socket', HERDR_PANE_ID: 'qa:parent' },
    stateDir: directory, cwd: directory, viewer: join(directory, 'viewer.mjs'),
    herdr: async (...args) => { calls.push(args); return {}; } });
  t.after(async () => { await owner.stop(); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(owner.start(), /Initial native source save failed/);
  await owner.stop();
  assert.equal(owner.control.listening, false);
  assert.equal(calls.length, 0);
});

test('child exclusion precedes UI getters; noninteractive lifecycle and commands create no owner', async () => {
  const handlers = new Map(), commands = new Map();
  const pi = { on(type, handler) { handlers.set(type, handler); return () => {}; },
    registerCommand(name, command) { commands.set(name, command); } };
  extension(pi);
  const child = { sessionManager: { getSessionFile: () => '/synthetic/senpi-task/children/child/session.jsonl' },
    get hasUI() { throw new Error('UI must not be read'); } };
  await handlers.get('session_start')({}, child);
  assert.equal(commands.size, 0, 'the integrated DAG entry owns the one dashboard command');
  await handlers.get('session_start')({}, { hasUI: true, mode: 'rpc',
    sessionManager: { getSessionFile: () => '/synthetic/parent.jsonl' } });
});

// Windows denies replacing todo.json while a reader (a viewer or the controller
// itself) holds it open, so the denial is injected at the real rename of the
// existing state file. The retry is win32-only, as for the slot and DAG writers.
const win32 = process.platform === 'win32';
const denial = code => Object.assign(new Error(`${code}: rename denied`), { code });
async function adoptedTodo(t) {
  const f = await fixture(t);
  f.ready.resolve(); f.controller.bind(f.pi);
  f.pi.events.emit(dashboardChannels.provider, { v: 1, kind: 'dag-provider', ...f.controller.binding, provider: f.provider });
  await f.controller.schedule();
  return f;
}
function armStateRename(t, controller, fault) {
  const rename = fs.rename, attempts = [];
  const mocked = t.mock.method(fs, 'rename', async (from, to) => {
    if (to !== controller.stateFile) return rename(from, to);
    const error = fault(attempts.length);
    attempts.push(error?.code ?? 'ok');
    if (error) throw error;
    return rename(from, to);
  });
  syncBuiltinESMExports();
  return { attempts, restore() { mocked.mock.restore(); syncBuiltinESMExports(); } };
}
const noTemporaries = async controller => (await readdir(controller.directory)).filter(name => name.endsWith('.tmp'));

test('one transient EPERM replacing the existing Todo state file is retried and the update lands', async t => {
  const f = await adoptedTodo(t), before = await readFile(f.controller.stateFile, 'utf8');
  const fault = armStateRename(t, f.controller, index => index === 0 ? denial('EPERM') : null);
  try {
    if (win32) await f.controller.schedule();
    else await assert.rejects(f.controller.schedule(), { code: 'EPERM' });
  } finally { fault.restore(); }
  assert.deepEqual(fault.attempts, win32 ? ['EPERM', 'ok'] : ['EPERM']);
  assert.equal((await readRoleState(f.controller.stateFile)).paneId, JSON.parse(before).paneId);
  assert.deepEqual(await noTemporaries(f.controller), []);
});

test('a persistent EPERM replacing the Todo state file is bounded, surfaces and leaves the old file intact', async t => {
  const f = await adoptedTodo(t), before = await readFile(f.controller.stateFile, 'utf8');
  const fault = armStateRename(t, f.controller, () => denial('EPERM'));
  try { await assert.rejects(f.controller.schedule(), { code: 'EPERM' }); } finally { fault.restore(); }
  assert.deepEqual(fault.attempts, Array(win32 ? 6 : 1).fill('EPERM'));
  assert.equal(await readFile(f.controller.stateFile, 'utf8'), before);
  assert.deepEqual(await noTemporaries(f.controller), []);
});

test('a non-transient error replacing the Todo state file is not retried', async t => {
  const f = await adoptedTodo(t), before = await readFile(f.controller.stateFile, 'utf8');
  // Fails once only: a retry would succeed, so a rejection proves there was none.
  const fault = armStateRename(t, f.controller, index => index === 0 ? denial('ENOSPC') : null);
  try { await assert.rejects(f.controller.schedule(), { code: 'ENOSPC' }); } finally { fault.restore(); }
  assert.deepEqual(fault.attempts, ['ENOSPC']);
  assert.equal(await readFile(f.controller.stateFile, 'utf8'), before);
  assert.deepEqual(await noTemporaries(f.controller), []);
});
