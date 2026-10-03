import net from 'node:net';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { displayOwnerKey, installDisplayBridge } from './display-bridge.mjs';
import { createPresence } from './presence.mjs';
import { createSnapshotStorage, sameSnapshotScope } from './storage.mjs';

const execute = promisify(execFile);
export const dashboardChannels = Object.freeze({
  query: 'omo.herdr.dashboard.query', reply: 'omo.herdr.dashboard.reply',
  provider: 'omo.herdr.dashboard.provider', retired: 'omo.herdr.dashboard.retired',
});
export const sameDashboardOwner = (a, b) => a && b &&
  ['socketPath', 'parentPaneId', 'sessionId', 'ownerKey'].every(key => a[key] === b[key]);
const roles = new Set(['todo', 'dag', 'workers']);
const send = (socket, message) => socket.write(`${JSON.stringify(message)}\n`);
const pathKey = path => process.platform === 'win32' ? String(path).replaceAll('\\', '/').toLowerCase() : String(path);
const controlKeys = ['token', 'ownerKey', 'sessionId', 'scopeEpoch', 'role', 'launchToken', 'paneId', 'statePath'];
const sameControl = (a, b) => a?.v === 1 && b?.v === 1 && controlKeys.every(key => a[key] === b[key]);

function receive(socket, callback) {
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 65536) return socket.destroy();
    let cut;
    while ((cut = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1);
      try { callback(JSON.parse(line)); } catch { socket.destroy(); }
    }
  });
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}
export async function readRoleState(path) {
  const state = await readJson(path);
  if (state === null) return null;
  if (state.schema !== 'omo-herdr-dashboard/role/1' || !roles.has(state.role) ||
    !['socketPath', 'parentPaneId', 'tabId', 'sessionId', 'ownerKey'].every(key =>
      typeof state[key] === 'string' && state[key]) ||
    state.ownerKey !== displayOwnerKey(state.socketPath, state.parentPaneId, state.sessionId) ||
    !Number.isSafeInteger(state.scopeEpoch) || state.scopeEpoch < 1 ||
    typeof state.launchToken !== 'string' || !state.launchToken ||
    typeof state.paneId !== 'string' || !state.paneId) throw new TypeError('Invalid managed role state');
  return state;
}
function requestControl(type, { state, paneId, launchToken, pid = process.pid }) {
  const offer = state?.controlOffer;
  if (!offer?.pipePath?.startsWith('\\\\.\\pipe\\') || state.paneId !== paneId ||
    state.launchToken !== launchToken || offer.paneId !== paneId ||
    offer.launchToken !== launchToken || !sameSnapshotScope(offer, state) ||
    offer.role !== state.role) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(offer.pipePath);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Role control response timed out')); }, 10000);
    socket.once('connect', () => send(socket, { ...offer, type, pid }));
    receive(socket, message => {
      const accepted = sameControl(message, offer) && message.type === (type === 'register' ? 'registered' : 'closed');
      clearTimeout(timer); socket.end(); resolve(accepted);
    });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.once('close', () => { clearTimeout(timer); resolve(false); });
  });
}
export const registerRoleViewer = options => requestControl('register', options);
export const requestRoleClose = options => requestControl('close', options);

export function createDashboardHerdr(environment = process.env) {
  return async (...args) => {
    const { stdout } = await execute(environment.HERDR_BIN_PATH || (process.platform === 'win32' ? 'herdr.exe' : 'herdr'),
      ['pane', ...args], { env: environment, timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
    if (!stdout.trim()) return {};
    const reply = JSON.parse(stdout);
    if (reply.error) throw new Error(reply.error.message);
    return reply.result;
  };
}
export async function resolveDashboardNode(environment = process.env) {
  const candidates = environment.OMO_HERDR_TODO_NODE ? [environment.OMO_HERDR_TODO_NODE] :
    [...(/^node(?:js)?(?:\.exe)?$/i.test(basename(process.execPath)) ? [process.execPath] : []), 'node'];
  for (const candidate of new Set(candidates)) {
    try {
      const { stdout } = await execute(candidate, ['--eval',
        'console.log(JSON.stringify({version:process.versions.node,bun:!!process.versions.bun,path:process.execPath}))'],
      { env: environment, timeout: 5000, maxBuffer: 16384 });
      const result = JSON.parse(stdout.trim());
      if (!result.bun && Number(result.version?.split('.')[0]) >= 24 && isAbsolute(result.path)) return result.path;
    } catch { /* Probe the next declared interpreter. */ }
  }
  throw new Error('Todo pane requires a Node >= 24 interpreter');
}
function shellCommand(args) {
  return process.platform === 'win32'
    ? `& ${args.map(value => `'${String(value).replaceAll("'", "''")}'`).join(' ')}`
    : args.map(value => `'${String(value).replaceAll("'", "'\\''")}'`).join(' ');
}
export function viewerProcess(info, record, expectedPid) {
  const matches = (info?.process_info?.foreground_processes ?? []).filter(process => {
    const argv = process.argv ?? [];
    return argv.length === 8 && pathKey(argv[0]) === pathKey(record.nodePath) && pathKey(argv[1]) === pathKey(record.viewerPath) &&
      argv[2] === '--state' && pathKey(argv[3]) === pathKey(record.statePath) &&
      argv[4] === '--close-pane' && argv[5] === record.paneId &&
      argv[6] === '--launch-token' && argv[7] === record.launchToken &&
      (expectedPid === undefined || process.pid === expectedPid) &&
      (record.processId === undefined || process.pid === record.processId);
  });
  return matches.length === 1 ? matches[0] : null;
}
export function parseLaunchCommand(command) {
  if (typeof command !== 'string') return null;
  const argv = [];
  let at = 0;
  while (at < command.length) {
    while (/[ \t]/.test(command[at] ?? '') && at < command.length) at++;
    if (at === command.length) break;
    let value;
    if (command[at] === '"') {
      const end = command.indexOf('"', at + 1);
      if (end < 0 || command[end - 1] === '\\') return null;
      value = command.slice(at + 1, end); at = end + 1;
      if (at < command.length && !/[ \t]/.test(command[at])) return null;
    } else {
      const start = at;
      while (at < command.length && !/[ \t]/.test(command[at])) at++;
      value = command.slice(start, at);
      if (/["\r\n]/.test(value)) return null;
    }
    if (!value || /[\r\n]/.test(value)) return null;
    argv.push(value);
  }
  return argv;
}
async function nativeShellProcesses(pid) {
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $ErrorActionPreference = 'Stop'; $rows = @(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid} OR ParentProcessId = ${pid}" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}}); ConvertTo-Json -InputObject $rows -Compress`],
  { timeout: 5000, maxBuffer: 65536 });
  return JSON.parse(stdout);
}
export async function observePaneShell(info, record, inspect = nativeShellProcesses) {
  const pid = info?.process_info?.shell_pid;
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid < 1 ||
    pid !== record.creationProcessId || info.process_info.pane_id && info.process_info.pane_id !== record.paneId) return null;
  let rows;
  try { rows = await inspect(pid); } catch { return null; }
  if (!Array.isArray(rows) || rows.filter(row => row.ProcessId === pid).length !== 1 ||
    new Set(rows.map(row => row.ProcessId)).size !== rows.length) return null;
  const shell = rows.find(row => row.ProcessId === pid), born = Date.parse(shell.CreationDate);
  if (!Number.isFinite(born) || !shell.ExecutablePath || !shell.CommandLine ||
    record.creationDate && shell.CreationDate !== record.creationDate) return null;
  const reported = info.process_info.foreground_processes?.find(row => row.pid === pid);
  if (reported && pathKey(reported.argv?.[0]) !== pathKey(shell.ExecutablePath)) return null;
  const children = rows.filter(row => row !== shell);
  if (children.some(child => !Number.isSafeInteger(child.ProcessId) || child.ProcessId < 1 ||
    child.ParentProcessId !== pid || !child.ExecutablePath || !child.CommandLine ||
    !Number.isFinite(Date.parse(child.CreationDate)) || Date.parse(child.CreationDate) < born)) return null;
  return { shell, children };
}
export async function paneViewerProcess(info, record, expectedPid, inspect) {
  const foreground = viewerProcess(info, record, expectedPid);
  if (foreground) return foreground;
  const shell = info?.process_info?.shell_pid, pid = expectedPid ?? record.processId;
  // Windows Herdr reports the PowerShell shell, not its foreground Node child.
  // Only the shell returned for this exact split can anchor a native PID query.
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid < 1 ||
    !record.creationDate || !Number.isSafeInteger(record.creationProcessId) || shell !== record.creationProcessId ||
    info.process_info.foreground_processes?.length !== 1 ||
    info.process_info.foreground_processes[0].pid !== shell) return null;
  const observation = await observePaneShell(info, record, inspect);
  if (!observation || observation.children.length !== 1) return null;
  const child = observation.children[0];
  if (child.ProcessId !== pid ||
    pathKey(child.ExecutablePath) !== pathKey(record.nodePath)) return null;
  const argv = parseLaunchCommand(child.CommandLine);
  if (!argv) return null;
  return viewerProcess({ process_info: { foreground_processes: [{ pid, argv }] } }, record, pid);
}
export async function canCleanupPane(info, record, inspect) {
  if (info?.process_info?.shell_pid !== record.creationProcessId) return false;
  if (process.platform !== 'win32') return (info.process_info.foreground_processes ?? [])
    .every(row => row.pid === record.creationProcessId) || Boolean(viewerProcess(info, record));
  if (!record.creationDate) return false;
  const observation = await observePaneShell(info, record, inspect);
  if (!observation) return false;
  if (!observation.children.length) return true;
  if (observation.children.length !== 1) return false;
  const child = observation.children[0], argv = parseLaunchCommand(child.CommandLine);
  return pathKey(child.ExecutablePath) === pathKey(record.nodePath) && argv !== null &&
    Boolean(viewerProcess({ process_info: { foreground_processes: [{ pid: child.ProcessId, argv }] } }, record));
}

export class TodoPane {
  constructor({ ctx, environment = process.env, stateDir, cwd, node = process.execPath,
    viewer, herdr = createDashboardHerdr(environment), inspectShell, language = 'en', notify = () => {} }) {
    Object.assign(this, { ctx, environment, cwd, node, viewer, herdr, inspectShell, language, notify });
    this.binding = { socketPath: environment.HERDR_SOCKET_PATH, parentPaneId: environment.HERDR_PANE_ID,
      sessionId: ctx.sessionManager.getSessionId() };
    this.binding.ownerKey = displayOwnerKey(this.binding.socketPath, this.binding.parentPaneId, this.binding.sessionId);
    this.directory = join(stateDir, this.binding.ownerKey);
    this.stateFile = join(this.directory, 'todo.json');
    this.recordFile = join(this.directory, 'todo.pane.json');
    this.lifetimeId = randomUUID();
    this.events = new EventEmitter();
    this.tail = Promise.resolve();
    this.roleTail = Promise.resolve();
    this.controlJobs = new Set();
    this.stopSignal = new AbortController();
    this.stopped = false;
    this.provider = null;
    this.source = null;
    this.ownedRoles = new Map();
    this.unsubscribers = [];
    this.controlToken = randomBytes(32).toString('hex');
    this.controlPath = `\\\\.\\pipe\\omo-herdr-todo-control-${randomUUID()}`;
    this.presencePath = `\\\\.\\pipe\\omo-herdr-todo-${randomUUID()}`;
    this.controlSockets = new Set();
    this.status = 'waiting';
  }
  enqueue(job) {
    const lifetime = this.lifetimeId;
    const result = this.tail.then(() => {
      if (this.stopped || lifetime !== this.lifetimeId) return;
      return job();
    });
    this.tail = result.catch(error => { if (!this.stopped) { this.status = 'layout-waiting'; this.notify(error.message); } });
    return result;
  }
  roleWrite(job) {
    const result = this.roleTail.then(job);
    this.roleTail = result.catch(() => {});
    return result;
  }
  async start() {
    const old = await readJson(this.recordFile);
    this.scopeEpoch = Math.max(0, old?.scopeEpoch ?? 0) + 1;
    let cache;
    const directory = this.directory;
    this.storage = {
      get path() { return cache.path; },
      rebase(next) {
        cache?.rebase(next); // Invalidate an old in-flight write before changing its path.
        cache = createSnapshotStorage({ path: join(directory, `scope-${next.scopeEpoch}`, 'todo.cache.json') });
        cache.rebase(next);
      },
      write(snapshot) { return cache.write(snapshot); },
    };
    this.presence = createPresence({ ...this.binding, scopeEpoch: this.scopeEpoch, storage: this.storage, pipePath: this.presencePath,
      hasDagOwnedTasks: () => this.source !== null && this.source.runs.some(run => run.nodes.some(node => node.taskId)) });
    await this.startControl();
    await this.presence.start();
    if (this.stopped) return;
    this.adapter = {
      getOwner: () => this.presence.getOwner(),
      publish: snapshot => this.presence.publish(snapshot),
      settings: this.presence.settings,
      hasDagOwnedTasks: () => this.presence.hasDagOwnedTasks(),
      isReady: receipt => {
        const record = this.ownedRoles.get(receipt?.role);
        return record?.scopeEpoch === this.scopeEpoch && record.ready === true && record.manualClose !== true &&
          Number.isSafeInteger(record.processId) && this.presence.isReady(receipt);
      },
    };
    this.onPresenceEvent = event => {
      if (event.type === 'disconnected') this.ownedRoles.delete(event.role);
    };
    this.presence.events.on('event', this.onPresenceEvent);
    this.bridge = installDisplayBridge(this.ctx, this.adapter, { environment: this.environment });
    if (!this.bridge) throw new Error('Native display bridge is unavailable for this owner');
    this.offReadiness = this.presence.subscribeReadiness(() => {
      if (!this.stopped) this.bridge?.readinessChanged();
    });
    await this.presence.idle();
    if (!this.presence.state.snapshot) throw new Error('Initial native source save failed');
    this.status = 'layout-waiting';
  }
  async startControl() {
    this.control = net.createServer(socket => {
      this.controlSockets.add(socket);
      socket.once('close', () => this.controlSockets.delete(socket));
      socket.on('error', () => {});
      receive(socket, message => {
        const job = this.handleControl(message, socket);
        this.controlJobs.add(job);
        void job.catch(() => socket.destroy()).finally(() => this.controlJobs.delete(job));
      });
    });
    await new Promise((resolve, reject) => {
      this.control.once('error', reject); this.control.once('listening', resolve); this.control.listen(this.controlPath);
    });
  }
  async membership(paneId) {
    const panes = (await this.herdr('list'))?.panes ?? [];
    const parents = panes.filter(pane => pane.pane_id === this.binding.parentPaneId);
    const matches = panes.filter(pane => pane.pane_id === paneId);
    if (parents.length !== 1 || matches.length !== 1 || !parents[0].tab_id ||
      matches[0].tab_id !== parents[0].tab_id) throw new Error('layout-waiting: missing or ambiguous owned anchor');
    return { pane: matches[0], tabId: parents[0].tab_id };
  }
  recordMatches(record) {
    return record?.schema === 'omo-herdr-dashboard/pane/1' && record.role === 'todo' &&
      sameDashboardOwner(record, this.binding) && pathKey(record.statePath) === pathKey(this.stateFile) &&
      pathKey(record.viewerPath) === pathKey(this.viewer) && typeof record.launchToken === 'string';
  }
  async verify(record, pid) {
    if (!this.recordMatches(record) || !record.paneId) return null;
    const member = await this.membership(record.paneId);
    if (record.tabId !== member.tabId) return null;
    const state = await readRoleState(this.stateFile);
    if (!state || !sameDashboardOwner(state, record) || state.launchToken !== record.launchToken ||
      state.paneId !== record.paneId || state.role !== record.role) return null;
    return paneViewerProcess(await this.herdr('process-info', '--pane', record.paneId), record, pid, this.inspectShell);
  }
  async handleControl(message, socket) {
    if (this.stopped || !['register', 'close'].includes(message?.type)) return socket.destroy();
    return this.roleWrite(async () => {
      const record = await readJson(this.recordFile);
      const state = await readRoleState(this.stateFile);
      if (!sameControl(message, state?.controlOffer) || message.scopeEpoch !== this.scopeEpoch ||
        !this.recordMatches(record) || record.launchToken !== message.launchToken ||
        !Number.isSafeInteger(message.pid) || !(await this.verify(record, message.pid))) return socket.destroy();
      if (this.stopped || message.scopeEpoch !== this.scopeEpoch) return socket.destroy();
      if (message.type === 'register') {
        const ready = { ...record, processId: message.pid, ready: true };
        await writeJson(this.recordFile, ready);
        this.ownedRoles.set('todo', ready);
        send(socket, { ...state.controlOffer, type: 'registered' });
        this.events.emit(`created:${message.launchToken}`, record.paneId);
        this.bridge?.readinessChanged();
      } else {
        await writeJson(this.recordFile, { ...record, manualClose: true });
        this.ownedRoles.delete('todo');
        this.bridge?.readinessChanged();
        await new Promise((resolve, reject) => {
          socket.end(`${JSON.stringify({ ...state.controlOffer, type: 'closed' })}\n`, () => {
            this.herdr('close', record.paneId).then(resolve, reject);
          });
        });
      }
    });
  }
  roleState(record, connected = true) {
    return { schema: 'omo-herdr-dashboard/role/1', ...this.binding, scopeEpoch: this.scopeEpoch,
      role: 'todo', tabId: record.tabId, launchToken: record.launchToken, paneId: record.paneId,
      connected, language: this.language, updatedAt: new Date().toISOString(), availability: 'waiting',
      cachePath: this.storage.path, prefsPath: `${this.stateFile}.view.json`,
      presenceOffer: connected ? this.presence.offer('todo') : null,
      controlOffer: connected ? { pipePath: this.controlPath, v: 1, token: this.controlToken,
        ownerKey: this.binding.ownerKey, sessionId: this.binding.sessionId, scopeEpoch: this.scopeEpoch,
        role: 'todo', launchToken: record.launchToken, paneId: record.paneId, statePath: this.stateFile } : null };
  }
  bind(pi) {
    const accept = event => {
      if (this.stopped || event?.v !== 1 || event.kind !== 'dag-provider' ||
        !sameDashboardOwner(event, this.binding) || !event.provider) return;
      if (this.provider?.lifetimeId === event.provider.lifetimeId) return;
      this.offSource?.();
      this.provider = event.provider;
      const provider = this.provider;
      this.source = provider.getSource();
      this.offSource = provider.subscribeSource(source => {
        if (this.stopped || this.provider !== provider) return;
        this.source = source;
        this.bridge?.readinessChanged();
        void this.schedule().catch(() => {});
      });
      provider.setCoordinator(this.coordinator());
      void this.schedule().catch(() => {});
    };
    this.unsubscribers.push(pi.events.on(dashboardChannels.provider, accept),
      pi.events.on(dashboardChannels.reply, accept),
      pi.events.on(dashboardChannels.query, event => {
        if (!this.stopped && event?.v === 1 && event.kind === 'todo-owner' && sameDashboardOwner(event, this.binding))
          pi.events.emit(dashboardChannels.reply, { v: 1, requestId: event.requestId, kind: 'todo-owner',
            ...this.binding, provider: this.coordinator() });
      }),
      pi.events.on(dashboardChannels.retired, event => {
        if (sameDashboardOwner(event, this.binding) && event.lifetimeId === this.provider?.lifetimeId) {
          this.offSource?.(); this.provider = null; this.source = null; this.status = 'layout-waiting';
          this.ownedRoles.delete('dag'); this.ownedRoles.delete('workers');
          this.bridge?.readinessChanged();
        }
      }));
    this.pi = pi;
    pi.events.emit(dashboardChannels.provider, { v: 1, kind: 'todo-owner', ...this.binding, provider: this.coordinator() });
    pi.events.emit(dashboardChannels.query, { v: 1, requestId: randomUUID(), kind: 'dag-provider', ...this.binding });
  }
  coordinator() {
    return { lifetimeId: this.lifetimeId, binding: this.binding,
      claim: { ...this.binding, lifetimeId: this.lifetimeId },
      schedule: options => this.schedule(options) };
  }
  schedule({ forceRoles = [] } = {}) {
    return this.enqueue(async () => {
      // Existing Todo must receive a new scope/offer even if a sibling role
      // was manually closed. Layout anchors only govern creation, not rebinding.
      const existing = await this.ensureTodo(null, false);
      const provider = this.provider;
      if (!provider) { this.status = 'layout-waiting'; return; }
      await provider.sourceReady;
      if (this.stopped || this.provider !== provider) return;
      const { tabId } = await this.membership(this.binding.parentPaneId);
      const claim = { ...this.binding, tabId, lifetimeId: this.lifetimeId };
      this.claim = claim;
      const offers = { dag: this.presence.offer('dag'), workers: this.presence.offer('workers') };
      const pair = await provider.openPair({ force: forceRoles.includes('dag') || forceRoles.includes('workers'), offers, claim });
      if (this.stopped || this.provider !== provider) return;
      for (const role of ['dag', 'workers']) {
        const record = pair?.[role];
        if (record?.role === role && sameDashboardOwner(record, this.binding) &&
          record.scopeEpoch === this.scopeEpoch && record.tabId === tabId && record.ready === true &&
          record.manualClose !== true && Number.isSafeInteger(record.processId)) this.ownedRoles.set(role, record);
        else this.ownedRoles.delete(role);
      }
      this.bridge?.readinessChanged();
      if (!pair?.workers || pair.workers.role !== 'workers' || !sameDashboardOwner(pair.workers, this.binding) ||
        pair.workers.tabId !== tabId) {
        this.status = 'layout-waiting'; return;
      }
      await this.membership(pair.workers.paneId);
      if (!existing || forceRoles.includes('todo')) await this.ensureTodo(pair.workers, forceRoles.includes('todo'));
    });
  }
  async ensureTodo(anchor, force) {
    if (force) await this.roleTail;
    let record = await readJson(this.recordFile);
    if (record && !this.recordMatches(record)) { this.status = 'layout-waiting'; return; }
    if (record?.manualClose && !force) return;
    if (record?.paneId) {
      let process;
      try { process = await this.verify(record); } catch (error) {
        if (!/missing or ambiguous/.test(error.message)) throw error;
      }
      if (process) {
        record = await this.roleWrite(async () => {
          const current = await readJson(this.recordFile);
          if (this.stopped || current.launchToken !== record.launchToken || current.manualClose && !force) return null;
          const next = { ...current, scopeEpoch: this.scopeEpoch, layoutClaim: this.claim,
            processId: process.pid, ready: true, manualClose: false };
          await writeJson(this.recordFile, next);
          await writeJson(this.stateFile, this.roleState(next));
          return next;
        });
        if (!record) return;
        this.ownedRoles.set('todo', record);
        this.bridge?.readinessChanged();
        this.status = 'current'; return record.paneId;
      }
      const panes = (await this.herdr('list'))?.panes ?? [];
      if (panes.some(pane => pane.pane_id === record.paneId)) { this.status = 'layout-waiting'; return; }
      if (!force) { await writeJson(this.recordFile, { ...record, manualClose: true }); return; }
    } else if (record?.attempted && !force) return;
    if (!anchor) return;
    const { tabId } = await this.membership(anchor.paneId);
    if (tabId !== anchor.tabId) { this.status = 'layout-waiting'; return; }
    if (typeof this.node === 'function') this.node = await this.node();
    const launchToken = randomBytes(24).toString('hex');
    record = { schema: 'omo-herdr-dashboard/pane/1', ...this.binding, scopeEpoch: this.scopeEpoch, role: 'todo',
      statePath: this.stateFile, viewerPath: this.viewer, tabId, launchToken,
      nodePath: this.node, layoutClaim: this.claim, attempted: true, ready: false, manualClose: false };
    await writeJson(this.recordFile, record);
    if (this.stopped) return;
    const split = await this.herdr('split', '--pane', anchor.paneId, '--direction', 'down', '--ratio', '0.5',
      '--cwd', this.cwd, '--no-focus');
    if (!split?.pane?.pane_id) throw new Error('Owned Todo split returned no pane ID');
    record.paneId = split.pane.pane_id;
    await this.membership(record.paneId);
    const createdInfo = await this.herdr('process-info', '--pane', record.paneId);
    record.creationProcessId = createdInfo?.process_info?.shell_pid;
    const shell = await observePaneShell(createdInfo, record, this.inspectShell);
    if (shell) record.creationDate = shell.shell.CreationDate;
    await writeJson(this.recordFile, record);
    await writeJson(this.stateFile, this.roleState(record));
    const abort = new AbortController();
    const creation = once(this.events, `created:${launchToken}`,
      { signal: AbortSignal.any([abort.signal, this.stopSignal.signal, AbortSignal.timeout(10000)]) });
    creation.catch(() => {});
    try {
      await this.herdr('run', record.paneId, shellCommand([this.node, this.viewer, '--state', this.stateFile,
        '--close-pane', record.paneId, '--launch-token', launchToken]));
      await creation;
      if (!this.stopped) this.status = 'current';
      return record.paneId;
    } catch (error) {
      const current = await readJson(this.recordFile);
      if (!this.stopped && current?.launchToken === launchToken && Number.isSafeInteger(record.creationProcessId)) {
        await this.membership(record.paneId);
        const info = await this.herdr('process-info', '--pane', record.paneId);
        if (await canCleanupPane(info, record, this.inspectShell)) {
          await this.herdr('close', record.paneId);
          await writeJson(this.recordFile, { ...current, paneId: null, ready: false, failed: true });
        }
      }
      throw error;
    } finally { abort.abort(); }
  }
  rebase(ctx) {
    return this.enqueue(async () => {
      await this.roleWrite(() => {
        if (this.stopped) return;
        this.bridge?.observe({ type: 'session_tree' }, ctx);
        this.ctx = ctx;
        this.scopeEpoch++;
        this.ownedRoles.clear();
        this.presence.rebase({ ...this.binding, scopeEpoch: this.scopeEpoch });
        this.bridge?.observe(null, ctx);
      });
      await this.presence.idle();
    }).then(() => this.schedule());
  }
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.stopSignal.abort();
    this.offSource?.(); this.offReadiness?.();
    this.ownedRoles.clear();
    if (this.onPresenceEvent) this.presence?.events.off('event', this.onPresenceEvent);
    for (const off of this.unsubscribers) off();
    this.pi?.events.emit(dashboardChannels.retired, { v: 1, ...this.binding, lifetimeId: this.lifetimeId });
    this.bridge?.remove();
    await this.tail;
    await Promise.allSettled([...this.controlJobs]);
    await this.roleTail;
    try {
      const record = await readJson(this.recordFile);
      if (this.storage && this.recordMatches(record) && record.paneId)
        await writeJson(this.stateFile, this.roleState(record, false));
    } finally {
      for (const socket of this.controlSockets) socket.destroy();
      if (this.control?.listening) await new Promise(resolve => this.control.close(resolve));
      await this.presence?.close();
    }
  }
}
