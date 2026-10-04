// Actual native Todo callbacks and packaged extensions in owned Herdr panes.
// All subprocess HOME/agent/cache roots are isolated. ANSI captures are real
// terminal snapshots; rendering those snapshots to PNG is an external QA step.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { promisify, stripVTControlCharacters } from 'node:util';

const args = process.argv.slice(2);
const options = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!['--senpi-root', '--dag-root', '--evidence', '--session', '--herdr-bin', '--todo-package', '--dag-package', '--static-agent-dir'].includes(args[i]) ||
      options.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid QA option: ' + args[i]);
  options.set(args[i], args[i + 1]);
}
for (const name of ['--senpi-root', '--dag-root', '--evidence']) if (!options.has(name)) throw new Error('Required QA option: ' + name);
const W = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const D = resolve(options.get('--dag-root'));
const S = resolve(options.get('--senpi-root'));
const A0 = options.get('--static-agent-dir') ? resolve(options.get('--static-agent-dir')) : null;
const E = resolve(options.get('--evidence'));
await mkdir(E, { recursive: true });
const { createNativeHost, applyHostEnvironment } = await import(pathToFileURL(`${W}/src/native-host.mjs`));
const { displayOwnerKey } = await import(pathToFileURL(`${W}/src/display-bridge.mjs`));
const { snapshotAgentIdentity, compareIdentitySnapshots } = await import(pathToFileURL(`${W}/src/static-identity.mjs`));
const { parseLaunchCommand } = await import(pathToFileURL(`${W}/src/controller.mjs`));
const { t } = await import(pathToFileURL(`${D}/src/i18n.mjs`));
const { width } = await import(pathToFileURL(`${D}/src/render.mjs`));
const execute = promisify(execFile), events = new EventEmitter();
const bin = options.get('--herdr-bin') || process.env.HERDR_BIN_PATH || (process.platform === 'win32' ? 'herdr.exe' : 'herdr');
const sessionName = options.get('--session') || 'piomo';
const originalHerdr = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('HERDR_')));
const run = `${process.pid}-${randomUUID()}`;
const root = await mkdtemp(join(tmpdir(), 'omo-todo-qa-'));
const isolatedHome = join(root, 'home'), isolatedAgent = join(isolatedHome, 'agent'), isolatedTmp = join(root, 'tmp');
for (const path of [isolatedHome, isolatedAgent, isolatedTmp]) await mkdir(path, { recursive: true });
const outerEnvironment = applyHostEnvironment({ home: isolatedHome, tmp: isolatedTmp, agentDir: isolatedAgent });
const oldNpmCache = process.env.npm_config_cache;
process.env.npm_config_cache = join(root, 'npm-cache');
let installed = {};
const resources = { schema: 'todo-qa-joint-resources/1', status: 'before-allocation', launcherPid: process.pid,
  descriptors: [{ kind: 'fixture-directory', path: root }],
  allocated: [], cleaned: [], ownerPaneActions: 0, focusActions: 0, rootGeometryActions: 0 };
const ledger = [], captures = [], cases = [], observedSockets = new Set();
const key = Symbol.for('omo-herdr-owned-live-qa');
let serial = 0, active, fault, resultCode = 1;
const sha = value => createHash('sha256').update(value).digest('hex');
const save = async (name, value) => writeFile(join(E, name), JSON.stringify(value, null, 2));
const manifest = () => save('joint-resource-manifest.json', resources);
function record(type, fields = {}) {
  const value = { n: ++serial, type, ...fields };
  ledger.push(value); events.emit('event', value);
  console.log(`QA_EVENT ${JSON.stringify(value)}`);
  return value;
}
function signal(type, predicate = () => true, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Missing owned event ${type}`)), timeout);
    const listener = value => { if (value.type === type && predicate(value)) finish(null, value); };
    function finish(error, value) {
      clearTimeout(timer); events.off('event', listener);
      error ? reject(error) : resolve(value);
    }
    events.on('event', listener);
  });
}
async function cli(args, raw = false) {
  const { stdout } = await execute(bin, args, { env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    timeout: 40000, maxBuffer: 8 * 1024 * 1024, encoding: raw ? 'buffer' : 'utf8' });
  if (raw) return stdout;
  if (!stdout.trim()) return {};
  const reply = JSON.parse(stdout);
  if (reply.error) throw new Error(reply.error.message);
  return reply.result;
}
const herdr = (...args) => cli(['pane', ...args]);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
async function identity() {
  const values = {};
  for (const [repo, directory] of [['W', W], ['D', D]]) {
    for (const folder of ['src', 'dist', 'scripts', 'config']) {
      const walk = async path => {
        let entries;
        try { entries = await readdir(path, { withFileTypes: true }); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        for (const entry of entries) {
          const full = join(path, entry.name);
          if (entry.isDirectory()) await walk(full);
          else if (entry.isFile()) values[repo + '/' + full.slice(directory.length + 1).replaceAll('\\\\', '/')] = sha(await readFile(full));
        }
      };
      await walk(join(directory, folder));
    }
    for (const file of ['extension.mjs', 'package.json']) values[repo + '/' + file] = sha(await readFile(join(directory, file)));
  }
  const declared = await json(join(W, 'config/native-source-manifest.json'));
  assert.equal((await json(join(S, 'package.json'))).version, declared.sdkVersion);
  for (const file of declared.files) {
    const actual = sha(await readFile(join(S, file.path)));
    assert.equal(actual, file.sha256, 'Native SDK identity mismatch: ' + file.path);
    values['SDK/' + file.path] = actual;
  }
  return values;
}
async function installCandidates() {
  const npmCli = process.env.npm_execpath;
  if ((!options.has('--todo-package') || !options.has('--dag-package')) && !npmCli) throw new Error('Run qa:live through npm, or provide both package paths.');
  for (const [role, repo, supplied] of [['todo', W, '--todo-package'], ['dag', D, '--dag-package']]) {
    const folder = join(root, role + '-package'); await mkdir(folder);
    let archive = options.get(supplied);
    if (!archive) {
      await execute(process.execPath, [npmCli, 'run', 'build'], { cwd: repo, env: process.env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
      const output = await execute(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', folder], { cwd: repo, env: process.env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
      const packed = JSON.parse(output.stdout);
      archive = join(folder, packed[0].filename);
    }
    archive = resolve(archive);
    await copyFile(archive, join(folder, 'candidate.tgz'));
    await execute('tar', ['-xzf', 'candidate.tgz'], { cwd: folder, env: process.env, timeout: 30000 });
    const entry = join(folder, 'package/bin', role === 'todo' ? 'omo-herdr-todo.mjs' : 'omo-herdr-dag.mjs');
    const output = await execute(process.execPath, [entry, 'install', '--agent-dir', isolatedAgent, '--lang', 'ko'], { env: process.env, timeout: 30000 });
    const plan = JSON.parse(output.stdout);
    installed[role] = { archive, archiveSHA256: sha(await readFile(archive)), ...plan };
    const modules = {};
    const verifyRuntime = async relative => {
      for (const entry of await readdir(join(plan.integration, relative), { withFileTypes: true })) {
        const file = join(relative, entry.name);
        if (entry.isDirectory()) await verifyRuntime(file);
        else if (entry.isFile()) {
          modules[file] = sha(await readFile(join(plan.integration, file)));
          assert.equal(modules[file], sha(await readFile(join(repo, 'dist', file))), 'Installed runtime drift: ' + role + '/' + file);
        }
      }
    };
    await verifyRuntime('src');
    modules['extension.mjs'] = sha(await readFile(join(plan.integration, 'extension.mjs')));
    assert.equal(modules['extension.mjs'], sha(await readFile(join(repo, 'dist/extension.mjs'))));
    installed[role].modules = modules;
    await mkdir(join(E, 'packs'), { recursive: true });
    await copyFile(archive, join(E, 'packs', role + '-candidate.tgz'));
  }
  await save('installed-runtime.json', installed);
  function observer(pi) {
    const qa = globalThis[Symbol.for('omo-herdr-owned-live-qa')], off = [], seen = new Set();
    qa.bus = pi.events;
    for (const channel of ['omo.herdr.dashboard.provider', 'omo.herdr.dashboard.reply']) off.push(pi.events.on(channel, message => {
      if (message?.ownerKey !== qa.binding.ownerKey) return;
      qa.providers.set(message.kind, message.provider);
      qa.record('provider', { kind: message.kind, lifetimeId: message.provider.lifetimeId });
      if (message.kind === 'dag-provider' && !seen.has(message.provider.lifetimeId)) {
        seen.add(message.provider.lifetimeId);
        off.push(message.provider.subscribeSource(source => qa.record('source-update', { source })));
      }
    }));
    pi.on('session_start', (_event, ctx) => { qa.ctx = ctx; qa.record('native-session-start', { sessionId: ctx.sessionManager.getSessionId(), mode: ctx.mode, hasUI: ctx.hasUI }); });
    pi.on('session_shutdown', () => { for (const stop of off) stop(); });
  }
  await writeFile(join(root, 'qa-observer.mjs'), 'export default ' + observer.toString());
}
function pipeObserver({ socket }) {
  observedSockets.add(socket);
  let buffer = '';
  const data = chunk => {
    buffer += chunk.toString();
    if (buffer.length > 4 * 1024 * 1024) { buffer = ''; return; }
    let cut;
    while ((cut = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (!active || message.ownerKey !== active.binding.ownerKey ||
        !['hello', 'ack', 'register', 'close'].includes(message.type)) continue;
      if (message.pipePath && !resources.allocated.some(value => value.kind === 'owned-pipe' && value.path === message.pipePath)) {
        resources.allocated.push({ kind: 'owned-pipe', path: message.pipePath, ownerKey: message.ownerKey,
          role: message.role, scopeEpoch: message.scopeEpoch, tokenHash: sha(String(message.token)) });
        void manifest();
      }
      record(`wire-${message.type}`, { ownerKey: message.ownerKey, sessionId: message.sessionId,
        scopeEpoch: message.scopeEpoch, role: message.role, sequence: message.sequence,
        pid: message.pid, paneId: message.paneId, launchToken: message.launchToken,
        tokenHash: sha(String(message.token)) });
      if (message.type === 'register') {
        const binding = { ...message };
        void herdr('process-info', '--pane', binding.paneId).then(info =>
          record('registration-process-info', { role: binding.role, pid: binding.pid,
            paneId: binding.paneId, launchToken: binding.launchToken, info }));
      }
    }
  };
  socket.on('data', data);
  socket.once('close', () => { socket.off('data', data); observedSockets.delete(socket); });
}
async function roleRecords(qa, requestedRoles = ['dag', 'workers', 'todo']) {
  const records = {};
  for (const role of requestedRoles) {
    const directory = role === 'todo' ? qa.wState : qa.dState;
    const path = join(directory, qa.binding.ownerKey, `${role}.pane.json`);
    records[role] = await json(path);
    const state = await json(records[role].statePath);
    assert.equal(records[role].ownerKey, qa.binding.ownerKey);
    assert.equal(records[role].role, role);
    assert.equal(records[role].tabId, qa.tabId);
    assert.equal(records[role].launchToken, state.launchToken);
    assert.equal(records[role].scopeEpoch, state.scopeEpoch);
    assert.equal(records[role].ready, true);
    const info = await herdr('process-info', '--pane', records[role].paneId);
    let matches = info.process_info.foreground_processes.filter(process => process.pid === records[role].processId);
    if (!matches.length && process.platform === 'win32') {
      const pid = records[role].processId, shellPid = info.process_info.shell_pid;
      assert.equal(info.process_info.shell_pid, records[role].creationProcessId);
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $ErrorActionPreference = 'Stop'; $rows = @(Get-CimInstance Win32_Process -Filter "ProcessId = ${shellPid} OR ParentProcessId = ${shellPid}" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}}); ConvertTo-Json -InputObject $rows -Compress`],
      { timeout: 5000, maxBuffer: 65536 });
      const rows = JSON.parse(stdout);
      const shells = rows.filter(row => row.ProcessId === shellPid);
      const children = rows.filter(row => row.ParentProcessId === shellPid);
      assert.equal(shells.length, 1); assert.equal(children.length, 1);
      assert.equal(shells[0].CreationDate, records[role].creationDate);
      const native = children[0];
      assert.equal(native.ProcessId, pid); assert.equal(native.ParentProcessId, info.process_info.shell_pid);
      assert.ok(Date.parse(shells[0].CreationDate) <= Date.parse(native.CreationDate));
      assert.equal(native.ExecutablePath.toLowerCase(), records[role].nodePath.toLowerCase());
      const argv = parseLaunchCommand(native.CommandLine);
      assert.deepEqual(argv, [records[role].nodePath, records[role].viewerPath,
        ...(role === 'todo' ? [] : ['--view', role === 'dag' ? 'dag' : 'tasks']),
        '--state', records[role].statePath, '--close-pane', records[role].paneId, '--launch-token', records[role].launchToken]);
      matches = [{ pid, argv, native, nativeShell: shells[0], nativeObservation: rows,
        provenance: 'Official Herdr pane/shell plus complete public native live shell/direct-child observation' }];
    }
    assert.equal(matches.length, 1, `Current actual PID missing for ${role}`);
    const argv = matches[0].argv;
    assert.ok(argv.includes(records[role].launchToken));
    assert.ok(argv.includes(records[role].statePath));
    assert.ok(argv.includes(records[role].viewerPath));
    if (!resources.allocated.some(value => value.kind === 'verified-role-binding' &&
      value.role === role && value.paneId === records[role].paneId &&
      value.scopeEpoch === records[role].scopeEpoch && value.launchToken === records[role].launchToken))
      resources.allocated.push({ kind: 'verified-role-binding', order: qa.order, role, ...records[role],
        moduleSHA256: sha(await readFile(records[role].viewerPath)), process: matches[0] });
  }
  await manifest();
  return records;
}
async function frame(qa, role, marker, name, action) {
  const records = await roleRecords(qa), recordValue = records[role];
  const state = await json(recordValue.statePath);
  const cache = await json((await json(records.todo.statePath)).cachePath);
  const offer = state.presenceOffer;
  const ack = signal('wire-ack', value => value.role === role && value.scopeEpoch === state.scopeEpoch &&
    value.sequence === cache.snapshot.sequence && value.tokenHash === sha(offer.token));
  // Official visible source excludes old pane history. Register before input.
  const appeared = cli(['pane', 'wait-output', recordValue.paneId, '--source', 'visible', '--match', marker, '--timeout', '30000']);
  if (action) await action(recordValue);
  await appeared;
  const painted = await ack;
  const current = await roleRecords(qa);
  assert.equal(current[role].processId, recordValue.processId);
  assert.equal(current[role].launchToken, recordValue.launchToken);
  assert.equal(current[role].scopeEpoch, state.scopeEpoch);
  const raw = await cli(['pane', 'read', recordValue.paneId, '--source', 'visible', '--format', 'ansi'], true);
  const text = stripVTControlCharacters(raw.toString('utf8'));
  assert.ok(text.includes(marker), `Current visible frame missing ${marker}: ${text}`);
  const layout = await herdr('layout', '--pane', recordValue.paneId);
  const pane = (await herdr('list')).panes.find(value => value.pane_id === recordValue.paneId);
  const rect = layout.layout.panes.find(value => value.pane_id === recordValue.paneId).rect;
  const entry = { name, order: qa.order, role, paneId: recordValue.paneId, pid: recordValue.processId,
    launchToken: recordValue.launchToken, scopeEpoch: state.scopeEpoch, sequence: cache.snapshot.sequence,
    ackOrdinal: painted.n, rawSHA256: sha(raw), raw: raw.toString('utf8'), text, layout, paneRevision: pane.revision,
    sourceIdentity: { nativeSourceEntryId: cache.snapshot.sourceEntryId, nativeTarget: cache.snapshot.target,
      activeNodes: (state.runs ?? []).flatMap(run => run.nodes.filter(node => node.state === 'running').map(node => ({ runId: run.id, nodeId: node.id, label: node.label }))),
      activeWorkerIds: (state.tasks ?? []).filter(task => task.status === 'running').map(task => task.id) },
    cols: rect.width, rows: pane.scroll.viewport_rows };
  const widths = text.replaceAll('\r', '').split('\n').map(width);
  assert.ok(widths.every(value => value <= entry.cols), 'Actual terminal width overflow: ' + name);
  entry.maxWidth = Math.max(...widths);
  captures.push(entry);
  await writeFile(join(E, `${name}.ansi`), raw);
  await writeFile(join(E, `${name}.txt`), text);
  await save(`${name}.frame.json`, { ...entry, raw: undefined, text: undefined });
  record('actual-frame', { ...entry, raw: undefined, text: undefined });
  return entry;
}
async function noDuplicates(qa, records) {
  const list = (await herdr('list')).panes.filter(pane => pane.tab_id === qa.tabId);
  assert.equal(list.length, 4, `Expected chat parent plus three current roles: ${JSON.stringify(list)}`);
  assert.deepEqual(new Set(list.map(pane => pane.pane_id)), new Set([qa.parentPane, ...Object.values(records).map(value => value.paneId)]));
  return list;
}
async function composition(qa, records, name) {
  const reply = await herdr('layout', '--pane', records.dag.paneId);
  const geometry = Object.fromEntries(Object.entries(records).map(([role, record]) => [role, reply.layout.panes.find(pane => pane.pane_id === record.paneId).rect]));
  const parent = reply.layout.panes.find(pane => pane.pane_id === qa.parentPane).rect;
  const total = parent.height;
  for (const [role, ratio] of [['dag', 0.4], ['workers', 0.3], ['todo', 0.3]]) {
    assert.ok(Math.abs(geometry[role].height - total * ratio) <= 1, role + ' composition drift: ' + JSON.stringify(geometry));
    assert.equal(geometry[role].x, parent.x + parent.width);
    assert.equal(geometry[role].width, geometry.dag.width);
  }
  assert.equal(geometry.workers.y, geometry.dag.y + geometry.dag.height);
  assert.equal(geometry.todo.y, geometry.workers.y + geometry.workers.height);
  record('owned-composition', { name, order: qa.order, geometry, parent, total });
  await save(`${qa.order}-${name}-composition.json`, { geometry, parent, total });
}
async function sourceFixture(qa, host) {
  const sessionId = host.session.getSessionId(), reported = new Date().toISOString();
  const raw = { schemaVersion: 1, checkpointSeq: 1, runId: `dag_owned_${qa.order}`,
    parentSessionId: sessionId, rootSessionId: sessionId, name: `QA_DAG_${qa.order}`, status: 'running',
    createdAt: reported, updatedAt: reported,
    nodes: [{ id: 'first', label: 'OWNED_FIRST', state: 'completed', attempt: 1 },
      { id: 'second', label: 'OWNED_SECOND', state: 'running', attempt: 1, taskId: 'st_linked_fixture' }],
    edges: [{ from: 'first', to: 'second' }] };
  const directory = join(qa.taskState, 'dag/runs'), tasks = join(qa.taskState, 'tasks');
  resources.descriptors.push({ kind: 'reported-source-fixtures', paths: [join(directory, 'owned.json'),
    join(tasks, 'st_ordinary_fixture.json'), join(tasks, 'st_linked_fixture.json')] });
  await manifest(); await mkdir(directory, { recursive: true }); await mkdir(tasks, { recursive: true });
  await writeFile(join(directory, 'owned.json'), JSON.stringify(raw));
  const metrics = { cost_usd: 0.4493, cost_status: 'reported', output_tokens: 2100, generation_ms: 100000,
    tokens_per_second: 21, input_tokens: 4000, total_tokens: 6100, token_status: 'complete' };
  for (const [id, description] of [['st_ordinary_fixture', `QA_WORKER_${qa.order}`], ['st_linked_fixture', 'LINKED_ONLY']])
    await writeFile(join(tasks, `${id}.json`), JSON.stringify({ task_id: id, parent_session_id: sessionId,
      status: 'running', description, updated_at: reported, created_at: reported, run_stats: metrics }));
  for (let index = 0; index < 8; index++) await writeFile(join(tasks, `st_done_${index}.json`), JSON.stringify({
    task_id: `st_done_${index}`, parent_session_id: sessionId, status: 'completed', description: `QA_DONE_${index}`,
    updated_at: reported, created_at: reported }));
  qa.checkpoint = join(directory, 'owned.json');
  qa.todoMarker = `QA_TODO_${qa.order}`;
  await host.toolAction({ op: 'init', list: [{ phase: 'Owned source',
    items: [qa.todoMarker, `QA_NEXT_${qa.order}`] }] });
  record('actual-native-init', { order: qa.order, function: host.calls.at(-1).function,
    entry: host.session.getLeafId(), phases: host.readState().phases });
}
async function closeRole(qa, role) {
  const before = await roleRecords(qa, [role]), recordValue = before[role];
  const request = signal('wire-close', value => value.role === role && value.pid === recordValue.processId &&
    value.launchToken === recordValue.launchToken && value.scopeEpoch === recordValue.scopeEpoch);
  await herdr('send-keys', recordValue.paneId, 'q');
  await request;
  // Explicit command waits for the actual close job through the controller queue.
  await qa.providers.get('todo-owner').schedule();
  const list = (await herdr('list')).panes;
  assert.ok(!list.some(pane => pane.pane_id === recordValue.paneId));
  const closed = await json(join(role === 'todo' ? qa.wState : qa.dState, qa.binding.ownerKey, `${role}.pane.json`));
  assert.equal(closed.manualClose, true);
  record('manual-close-verified', { order: qa.order, role, paneId: recordValue.paneId,
    pid: recordValue.processId, launchToken: recordValue.launchToken, scopeEpoch: recordValue.scopeEpoch });
  return before;
}
async function runOrder(order) {
  const directory = join(root, order), home = join(directory, 'home'), cwd = join(home, 'project');
  const agentDir = join(home, 'agent'), tmp = join(directory, 'tmp');
  const qa = { order, directory, wState: join(directory, 'w-state'), dState: join(directory, 'd-state'),
    taskState: join(directory, 'reported-tasks'), providers: new Map(), record };
  resources.descriptors.push({ kind: 'case-fixture', directory, home, cwd, agentDir, tmp },
    { kind: 'owned-tab-create', order, argv: ['tab', 'create', '--cwd', cwd, '--label', `todo-qa-${order}`, '--no-focus'] });
  await manifest();
  for (const path of [cwd, agentDir, tmp]) await mkdir(path, { recursive: true });
  const tab = await cli(['tab', 'create', '--cwd', cwd, '--label', `todo-qa-${order}`, '--no-focus']);
  record('tab-created', { order, reply: tab });
  qa.tabId = tab.tab?.tab_id ?? tab.tab_id;
  qa.parentPane = tab.pane?.pane_id ?? tab.pane_id;
  resources.allocated.push({ kind: 'owned-tab-reply', order, reply: tab });
  await manifest();
  if (qa.tabId && !qa.parentPane) {
    const roots = (await herdr('list')).panes.filter(pane => pane.tab_id === qa.tabId);
    assert.equal(roots.length, 1, 'New owned tab must have exactly one original parent');
    qa.parentPane = roots[0].pane_id;
  }
  assert.ok(qa.tabId && qa.parentPane, `Official owned tab identity absent: ${JSON.stringify(tab)}`);
  resources.allocated.push({ kind: 'owned-tab', tabId: qa.tabId, parentPane: qa.parentPane, order });
  await manifest();
  const saved = applyHostEnvironment({ home, tmp, agentDir });
  Object.assign(process.env, originalHerdr, { HERDR_ENV: '1', HERDR_PANE_ID: qa.parentPane,
    OMO_HERDR_TODO_STATE_DIR: qa.wState, OMO_HERDR_DAG_STATE_DIR: qa.dState,
    OMO_HERDR_DAG_TASK_STATE_DIR: qa.taskState, OMO_HERDR_TODO_NODE: process.execPath, OMO_HERDR_DAG_NODE: process.execPath });
  let host;
  try {
    const paths = order === 'w-first' ? [installed.todo.extension, installed.dag.extension] : [installed.dag.extension, installed.todo.extension];
    host = await createNativeHost({ senpiRoot: S, cwd, agentDir, home, tmp, isolateEnvironment: false,
      extensionPaths: [] });
    record('runtime-loaded', { root: host.info.root, version: host.info.version,
      publicModules: Object.fromEntries(await Promise.all(Object.entries(host.info.modules).map(async ([name, path]) =>
        [name, { path: join(host.info.root, path), sha256: sha(await readFile(join(host.info.root, path))) }]))) });
    qa.binding = { socketPath: originalHerdr.HERDR_SOCKET_PATH, parentPaneId: qa.parentPane,
      sessionId: host.session.getSessionId() };
    qa.binding.ownerKey = displayOwnerKey(qa.binding.socketPath, qa.parentPane, qa.binding.sessionId);
    resources.descriptors.push({ kind: 'owned-role-layout', order, ...qa.binding,
      states: ['dag', 'workers', 'todo'].map(role => ({
        role, statePath: join(role === 'todo' ? qa.wState : qa.dState, qa.binding.ownerKey, `${role}.json`),
        recordPath: join(role === 'todo' ? qa.wState : qa.dState, qa.binding.ownerKey, `${role}.pane.json`),
        preferencesPath: join(role === 'todo' ? qa.wState : qa.dState, qa.binding.ownerKey, `${role}.json.view.json`),
        viewerPath: role === 'todo' ? join(installed.todo.integration, 'src/viewer.mjs') : join(installed.dag.integration, 'src/viewer.mjs'),
        executable: process.execPath,
      })),
      initialSplits: [{ role: 'dag', originalParent: qa.parentPane, direction: 'right', ratio: '0.65', noFocus: true },
        { role: 'workers', verifiedAnchorRole: 'dag', direction: 'down', ratio: '0.4', noFocus: true },
        { role: 'todo', verifiedAnchorRole: 'workers', direction: 'down', ratio: '0.5', noFocus: true }],
      pipeDescriptors: ['W extension-lifetime control UUID pipe', 'W task5 presence UUID pipe', 'D extension-lifetime control UUID pipe'],
      caches: [1, 2].map(epoch => join(qa.wState, qa.binding.ownerKey, `scope-${epoch}`, 'todo.cache.json')),
    });
    await manifest();
    active = qa; globalThis[key] = qa;
    // The observer resolves its holder during factory load; reload this actual
    // final extension set now that the fixture SessionManager identity exists.
    await host.loadFinalExtensionSet([join(root, 'qa-observer.mjs'), ...paths]); host.bindRunner();
    assert.ok(host.extensions[0].path.startsWith('<builtin:'), 'Actual builtin-first ordering changed');
    await sourceFixture(qa, host);
    const acks = ['dag', 'workers', 'todo'].map(role => signal('wire-ack', value =>
      value.ownerKey === qa.binding.ownerKey && value.scopeEpoch === 1 && value.sequence === 1 && value.role === role));
    // Keep independently subscribed failures handled until the joint await.
    for (const ack of acks) ack.catch(() => {});
    await host.emitSessionStart();
    assert.ok(qa.providers.has('todo-owner') && qa.providers.has('dag-provider'));
    await qa.providers.get('todo-owner').schedule();
    await Promise.all(acks);
    let records = await roleRecords(qa);
    await noDuplicates(qa, records);
    const first = Object.fromEntries(Object.entries(records).map(([role, value]) => [role, {
      paneId: value.paneId, processId: value.processId, launchToken: value.launchToken }]));
    await frame(qa, 'dag', `QA_DAG_${order}`, `${order}-dag`);
    await frame(qa, 'workers', `QA_WORKER_${order}`, `${order}-workers`);
    await frame(qa, 'todo', qa.todoMarker, `${order}-todo`);
    assert.equal(host.surface.nativeWidget(), undefined, 'Matching actual Todo paint did not mask inline');
    await Promise.all(Array.from({ length: 5 }, () => qa.providers.get('todo-owner').schedule()));
    records = await roleRecords(qa); await noDuplicates(qa, records);
    await composition(qa, records, 'initial');
    for (const role of ['dag', 'workers', 'todo']) assert.equal(records[role].paneId, first[role].paneId);
    for (const role of ['dag', 'workers']) {
      const state = await json(records[role].statePath);
      await frame(qa, role, t(state.language, 'followOff'), `${order}-${role}-t-locked`, recordValue =>
        herdr('send-text', recordValue.paneId, 'tf'));
      const locked = captures.at(-1).text;
      assert.ok(locked.includes(role === 'dag' ? 'OMO  /  DAG' : `OMO  /  ${t(state.language, 'tasks')}`));
      assert.ok(!locked.includes(role === 'dag' ? `QA_WORKER_${order}` : `QA_DAG_${order}`));
      await frame(qa, role, t(state.language, 'followOn'), `${order}-${role}-follow`, recordValue =>
        herdr('send-text', recordValue.paneId, 'f'));
    }
    await frame(qa, 'workers', 'QA_DONE_0', `${order}-completed-summary-green`, recordValue => herdr('send-text', recordValue.paneId, 'cjjjjjjj'));
    assert.match(captures.at(-1).raw, /\x1b\[(?:32|38;5;2)m[^\n]*QA_DONE_0/, 'Completed summary lost its actual green ANSI color');
    await frame(qa, 'workers', `QA_WORKER_${order}`, `${order}-completed-fold-restored`, recordValue => herdr('send-text', recordValue.paneId, 'cf'));
    await frame(qa, 'workers', '$0.4493', `${order}-workers-metrics`, recordValue =>
      herdr('send-text', recordValue.paneId, 'djjjjjjjjjj'));
    const nativeAck = signal('wire-ack', value => value.role === 'todo' && value.scopeEpoch === 1 && value.sequence === 2);
    await host.commandAction(`done ${qa.todoMarker}`);
    await nativeAck;
    await frame(qa, 'todo', '1/2', `${order}-todo-completed`);
    assert.ok(captures.at(-1).text.includes(`QA_NEXT_${order}`));
    record('actual-native-command', { order, function: host.calls.at(-1).function,
      entry: host.session.getLeafId(), phases: host.readState().phases });
    await closeRole(qa, 'todo');
    assert.ok(host.surface.nativeWidget(), 'Closure failed to restore actual current native Todo');
    await host.commandAction(`start QA_NEXT_${order}`);
    await qa.providers.get('todo-owner').schedule();
    const stillClosed = await json(join(qa.wState, qa.binding.ownerKey, 'todo.pane.json'));
    assert.equal(stillClosed.manualClose, true);
    const reopenedAck = signal('wire-ack', value => value.role === 'todo' && value.scopeEpoch === 1);
    await host.runner.getCommand('todo-pane').handler('', host.runner.createCommandContext());
    await reopenedAck;
    records = await roleRecords(qa);
    assert.notEqual(records.todo.launchToken, first.todo.launchToken);
    assert.equal(records.dag.paneId, first.dag.paneId); assert.equal(records.workers.paneId, first.workers.paneId);
    await closeRole(qa, 'workers');
    const pairAck = signal('wire-ack', value => value.role === 'workers' && value.scopeEpoch === 1);
    await host.runner.getCommand('dag-pane').handler('', host.runner.createCommandContext());
    await pairAck;
    records = await roleRecords(qa); await noDuplicates(qa, records);
    await composition(qa, records, 'workers-reopened');
    await frame(qa, 'workers', `QA_WORKER_${order}`, `${order}-workers-reopened`, recordValue => herdr('send-text', recordValue.paneId, 'df'));
    for (const rolesToClose of [['dag'], ['dag', 'workers']]) {
      const preservedTodo = records.todo.paneId;
      for (const role of rolesToClose) await closeRole(qa, role);
      const currentAck = signal('wire-ack', value => value.role === 'dag' && value.scopeEpoch === 1);
      await host.runner.getCommand('dag-pane').handler('', host.runner.createCommandContext());
      await currentAck;
      records = await roleRecords(qa); await noDuplicates(qa, records);
      assert.equal(records.todo.paneId, preservedTodo);
      await composition(qa, records, rolesToClose.length === 1 ? 'dag-reopened' : 'pair-reopened');
      await frame(qa, 'dag', `QA_DAG_${order}`, `${order}-${rolesToClose.length === 1 ? 'dag' : 'pair'}-reopened`);
    }
    const preserved = Object.fromEntries(Object.entries(records).map(([role, value]) => [role, value.paneId]));
    await host.runner.emit({ type: 'session_shutdown' });
    host.disposeRunner();
    qa.providers.clear();
    await host.loadFinalExtensionSet([join(root, 'qa-observer.mjs'), ...paths]); host.bindRunner();
    const rebased = ['dag', 'workers', 'todo'].map(role => signal('wire-ack', value =>
      value.role === role && value.scopeEpoch === 2 && value.sequence === 1));
    await host.emitSessionStart(); await qa.providers.get('todo-owner').schedule(); await Promise.all(rebased);
    records = await roleRecords(qa); await noDuplicates(qa, records);
    for (const role of ['dag', 'workers', 'todo']) assert.equal(records[role].paneId, preserved[role]);
    await frame(qa, 'todo', `QA_NEXT_${order}`, `${order}-reloaded-todo`);
    // Real checkpoint removal plus public reported RPC yields a genuine empty DAG.
    await rm(qa.checkpoint);
    const sourceSaved = signal('source-update', value => value.source.runs.length === 0);
    qa.bus.emit('senpi:extension-rpc-event', { name: 'omo.dag.updated',
      data: { parent_session_id: qa.binding.sessionId, runs: [] } });
    await sourceSaved; await qa.providers.get('todo-owner').schedule();
    await frame(qa, 'dag', 'DAG (0)', `${order}-empty-dag`);
    assert.ok(!captures.at(-1).text.includes(`OMO  /  ${t((await json(records.dag.statePath)).language, 'tasks')}`));
    const restoredRun = { schemaVersion: 1, checkpointSeq: 2, runId: `dag_owned_${order}`, parentSessionId: qa.binding.sessionId,
      rootSessionId: qa.binding.sessionId, name: `QA_DAG_${order}`, status: 'running', updatedAt: new Date().toISOString(),
      nodes: [{ id: 'second', label: 'OWNED_SECOND', state: 'running', taskId: 'st_linked_fixture' }], edges: [] };
    await writeFile(qa.checkpoint, JSON.stringify(restoredRun));
    const restoredSource = signal('source-update', value => value.source.runs.length === 1);
    qa.bus.emit('senpi:extension-rpc-event', { name: 'omo.dag.updated', data: { parent_session_id: qa.binding.sessionId, runs: [restoredRun] } });
    await restoredSource; await qa.providers.get('todo-owner').schedule();
    for (const role of ['dag', 'workers', 'todo']) await frame(qa, role,
      role === 'dag' ? `QA_DAG_${order}` : role === 'workers' ? `QA_WORKER_${order}` : `QA_NEXT_${order}`, `${order}-final-active-${role}`);
    await composition(qa, await roleRecords(qa), 'final-active');
    if (order === 'd-first') {
      const roles = await roleRecords(qa);
      const currentDag = await json(roles.dag.statePath);
      assert.equal(currentDag.runs.length, 1); assert.equal(currentDag.runs[0].nodes.length, 1);
      assert.equal(currentDag.runs[0].nodes[0].id, 'second'); assert.equal(currentDag.runs[0].nodes[0].label, 'OWNED_SECOND');
      const currentCache = await json((await json(roles.todo.statePath)).cachePath);
      assert.equal(currentCache.snapshot.target.content, `QA_NEXT_${order}`);
      assert.equal(currentCache.snapshot.target.status, 'in_progress');
      const initialLayout = await herdr('layout', '--pane', roles.dag.paneId);
      const parent = initialLayout.layout.panes.find(pane => pane.pane_id === qa.parentPane).rect;
      const initialWidth = initialLayout.layout.panes.find(pane => pane.pane_id === roles.dag.paneId).rect.width;
      let currentWidth = initialWidth;
      for (const columns of [80, 40, 24, initialWidth]) {
        if (columns !== currentWidth) {
          await herdr('resize', '--pane', roles.dag.paneId, '--direction', columns > currentWidth ? 'left' : 'right',
            '--amount', String(Math.abs(columns - currentWidth) / (parent.width + initialWidth)));
        }
        const actualLayout = await herdr('layout', '--pane', roles.dag.paneId);
        currentWidth = actualLayout.layout.panes.find(pane => pane.pane_id === roles.dag.paneId).rect.width;
        assert.ok(Math.abs(currentWidth - columns) <= 1, 'Owned column resize mismatch');
        for (const role of ['dag', 'workers', 'todo']) await frame(qa, role,
          role === 'dag' ? (columns === 24 ? 'OWNED_' : 'OWNED_SECOND') : role === 'workers' ? 'QA_WORKER_' : (columns === 24 ? 'QA_NEXT_' : `QA_NEXT_${order}`),
          `${order}-width-${columns}-${role}`);
      }
      await composition(qa, roles, 'final-restored');
    }
    cases.push({ order, status: 'passed', ownerKey: qa.binding.ownerKey, tabId: qa.tabId,
      parentPane: qa.parentPane, roles: records, nativeCalls: host.calls,
      scopeEpoch: 2, noDuplicates: true, registrationOrder: paths,
      scope: 'Actual SDK callbacks and isolated installed package extensions in owned Herdr role processes; no user conversation mutation.' });
    if (order === 'd-first' && process.env.OMO_HERDR_QA_INSPECTION_PIPE) {
      assert.deepEqual(await identity(), before, 'Source changed before final live inspection');
      const payload = { schema: 'omo-herdr-todo/inspection/1', run, root, sessionName, socketPath: originalHerdr.HERDR_SOCKET_PATH, herdrBin: bin, tabId: qa.tabId, roles: records, installed, sourceHashes: before, captures: captures.map(({ raw, text, ...value }) => value) };
      await save('FINAL-ROLE-INSPECTION-READY.json', payload);
      await new Promise((resolveInspection, rejectInspection) => {
        const socket = net.createConnection(process.env.OMO_HERDR_QA_INSPECTION_PIPE);
        const timer = setTimeout(() => socket.destroy(new Error('Private inspection timed out')), 180000);
        socket.once('error', rejectInspection);
        let completed = false;
        socket.once('close', () => { clearTimeout(timer); if (!completed) rejectInspection(new Error('Private inspection disconnected before continue')); });
        socket.once('data', bytes => {
          if (bytes.toString().trim() !== 'continue') return socket.destroy(new Error('Invalid private inspection response'));
          completed = true; socket.end(); resolveInspection();
        });
        socket.once('connect', () => { socket.write(JSON.stringify(payload) + '\n'); record('FINAL_ROLE_INSPECTION_READY', { tabId: qa.tabId, path: join(E, 'FINAL-ROLE-INSPECTION-READY.json') }); });
      });
    }
  } catch (error) {
    const failure = { order, error: error.stack, binding: qa.binding, notes: host?.surface?.notes,
      nativeErrors: host?.errors, records: {}, panes: [] };
    failure.panes = (await herdr('list')).panes.filter(pane => pane.tab_id === qa.tabId);
    for (const pane of failure.panes) {
      const info = await herdr('process-info', '--pane', pane.pane_id);
      const raw = await cli(['pane', 'read', pane.pane_id, '--source', 'visible', '--format', 'ansi'], true);
      failure.records[pane.pane_id] = { info, visibleText: stripVTControlCharacters(raw.toString('utf8')) };
      await writeFile(join(E, `${order}-failed-${pane.pane_id.replaceAll(':', '-')}.ansi`), raw);
    }
    for (const role of ['dag', 'workers', 'todo']) {
      try {
        const directory = role === 'todo' ? qa.wState : qa.dState;
        const recordPath = join(directory, qa.binding.ownerKey, `${role}.pane.json`);
        const paneRecord = await json(recordPath);
        failure.records[role] = { paneRecord, state: await json(paneRecord.statePath) };
      } catch (missing) { failure.records[role] = { unavailable: missing.message }; }
    }
    await save('joint-failure-current.json', failure);
    console.error(`QA_FAILURE_BINDING ${JSON.stringify(failure)}`);
    throw error;
  } finally {
    try {
      if (host) {
        try { await host.runner.emit({ type: 'session_shutdown' }); }
        finally { host.close(); }
      }
    } finally {
      saved.restore(); active = null; delete globalThis[key];
      if (qa.tabId) {
        await cli(['tab', 'close', qa.tabId]);
        const remaining = (await herdr('list')).panes;
        assert.ok(!remaining.some(pane => pane.tab_id === qa.tabId));
        resources.cleaned.push({ kind: 'owned-tab', tabId: qa.tabId, verifiedAbsent: true });
      }
      await manifest();
    }
  }
}
let before, authoredBefore, staticBefore, initialPanes = [];
const authoredIdentity = value => Object.fromEntries(Object.entries(value).filter(([name]) => !/^([WD])\/dist[\\/]/.test(name)));
try {
  await manifest();
  before = await identity();
  authoredBefore = authoredIdentity(before);
  staticBefore = A0 ? snapshotAgentIdentity(A0) : null;
  const discoveryEnvironment = { ...process.env };
  for (const [name, value] of Object.entries(outerEnvironment.saved)) {
    if (value === undefined) delete discoveryEnvironment[name]; else discoveryEnvironment[name] = value;
  }
  let socketPath = originalHerdr.HERDR_SOCKET_PATH;
  if (!socketPath) {
    const status = await execute(bin, ['--session', sessionName, 'status', 'server'], { env: discoveryEnvironment, timeout: 10000 });
    socketPath = /^socket:\s*(.+)$/m.exec(status.stdout)?.[1]?.trim();
  }
  assert.ok(socketPath, 'Running Herdr session socket unavailable');
  Object.assign(originalHerdr, { HERDR_BIN_PATH: bin, HERDR_SOCKET_PATH: socketPath, HERDR_SESSION: sessionName });
  Object.assign(process.env, originalHerdr);
  initialPanes = (await herdr('list')).panes;
  await installCandidates();
  const builtIdentity = await identity();
  assert.deepEqual(authoredIdentity(builtIdentity), authoredBefore, 'Authored source changed during intended build');
  before = builtIdentity;
  console.log(`QA_JOINT_DESCRIPTOR ${JSON.stringify(resources)}`);
  // The short owned fixture was allocated before subprocess isolation.
  resources.allocated.push({ kind: 'fixture-directory', path: root }); await manifest();
  subscribe('net.server.socket', pipeObserver);
  for (const order of ['w-first', 'd-first']) await runOrder(order);

  resultCode = 0;
} catch (error) {
  fault = error;
  console.error(`QA_JOINT_ERROR ${error.stack}`);
} finally {
  try {
  unsubscribe('net.server.socket', pipeObserver);
  await rm(root, { recursive: true, force: true });
  let removed = false;
  try { await stat(root); } catch (error) { removed = error.code === 'ENOENT'; }
  const after = before ? await identity() : null, currentPanes = initialPanes.length ? (await herdr('list')).panes : [];
  const initialPanesPreserved = initialPanes.every(pane => currentPanes.some(current =>
    current.pane_id === pane.pane_id && current.tab_id === pane.tab_id));
  const focusPreserved = initialPanes.every(pane => currentPanes.find(current =>
    current.pane_id === pane.pane_id)?.focused === pane.focused);
  const staticAfter = staticBefore ? snapshotAgentIdentity(A0) : null;
  const staticComparison = staticBefore ? compareIdentitySnapshots(staticBefore, staticAfter) : { checked: false, reason: 'Static baseline not captured' };
  if (staticBefore) assert.equal(staticComparison.staticUnchanged, true);
  const cleanup = { fixtureRemoved: removed, ownedTabs: resources.cleaned.filter(value =>
    value.kind === 'owned-tab'), initialPanesPreserved, focusPreserved, initialPanes, currentPanes,
    sourceUnchanged: JSON.stringify(before) === JSON.stringify(after),
    staticA0Unchanged: staticComparison.staticUnchanged, observedSocketCount: observedSockets.size,
    retainedDevDependencyTree: `${D}/node_modules`, note: 'Locked phase-local dev tree remains until all joint/gate consumers finish; it is not a live install.' };
  if (!initialPanesPreserved || !focusPreserved || !cleanup.sourceUnchanged) resultCode = 1;
  resources.status = resultCode === 0 ? 'JOINT_PRODUCER_QA_COMPLETED' : 'JOINT_PRODUCER_QA_FAILED';
  resources.cleanup = cleanup; await manifest();
  await save('source-hashes.json', { authoredBefore, before, after });
  await save('owned-pane-map.json', { cases, resources: resources.allocated.filter(value => value.kind === 'verified-role-binding') });
  await save('events.json', ledger);
  await save('cases.json', cases);
  await writeFile(join(E, 'events.log'), ledger.map(value => JSON.stringify(value)).join('\n') + '\n'); await save('cleanup.json', cleanup);
  await writeFile(join(E, 'fixed-views.log'), captures.map(value =>
    `${JSON.stringify({ ...value, raw: undefined, text: undefined })}\n${value.text}\n`).join('\n'));
  await save('result.json', { exitCode: resultCode, task12Accepted: false, evidenceScope: 'Current owned native/Herdr QA; remote publication excluded.', cases, captures: captures.map(({ raw, text, ...value }) => value),
    cleanup, staticComparison, error: fault?.stack ?? null });
  console.log(`QA_JOINT_RESULT ${JSON.stringify({ exitCode: resultCode, cases: cases.length, captures: captures.length, cleanup, error: fault?.message })}`);
  // Persist exact receipts even when an external focus change fails this check.
  for (const pane of initialPanes) {
    const current = currentPanes.find(value => value.pane_id === pane.pane_id);
    assert.ok(current, `Unowned original pane disappeared: ${pane.pane_id}`);
    assert.equal(current.tab_id, pane.tab_id);
    assert.equal(current.focused, pane.focused);
  }
  process.exitCode = resultCode;
  } finally {
    outerEnvironment.restore();
    if (oldNpmCache === undefined) delete process.env.npm_config_cache; else process.env.npm_config_cache = oldNpmCache;
  }
}
