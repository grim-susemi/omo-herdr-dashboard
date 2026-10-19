import { watch, existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { clean } from './model.mjs';
import { readJson } from './storage.mjs';

const taskId = value => typeof value === 'string' && /^st_[A-Za-z0-9_-]{1,253}$/.test(value);
const terminal = new Set(['completed', 'error', 'cancelled', 'interrupted', 'lost']);
const text = (value, limit = 2000) => typeof value === 'string' && value.trim() ? clean(value).slice(0, limit) : undefined;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
function iso(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

const metricCounts = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'total_tokens'];
const metricNumbers = ['generation_ms', 'runtime_ms', 'tokens_per_second', 'cost_usd'];
const metricQuality = {
  token_status: ['complete', 'partial', 'unavailable'],
  cost_status: ['reported', 'estimated', 'unavailable', 'invalid'],
  duration_status: ['monotonic', 'wall_clock', 'unavailable'],
};
// Native TaskRunStats and task-rpc-codec.liveProgressSnapshot only. Do not
// spread either payload: it may contain unrelated or private fields.
function metrics(stats, live, reportedAt, restoredSource) {
  const result = {};
  const sources = new Set();
  for (const key of [...metricCounts, ...metricNumbers]) {
    const valid = value => metricCounts.includes(key) ? count(value) !== undefined :
      typeof value === 'number' && Number.isFinite(value) && value >= 0;
    if (valid(stats?.[key])) { result[key] = stats[key]; sources.add('run_stats'); }
    else if (['output_tokens', 'total_tokens', 'tokens_per_second'].includes(key) && valid(live?.[key])) {
      result[key] = live[key]; sources.add('live_progress');
    }
  }
  for (const [key, allowed] of Object.entries(metricQuality)) {
    if (allowed.includes(stats?.[key])) { result[key] = stats[key]; sources.add('run_stats'); }
  }
  if (!sources.size) return undefined;
  result.source = ['run_stats', 'live_progress', 'run_stats+live_progress'].includes(restoredSource) ?
    restoredSource : ['run_stats', 'live_progress'].filter(source => sources.has(source)).join('+');
  const timestamp = iso(reportedAt);
  if (timestamp) result.reportedAt = timestamp;
  return result;
}

// Installed OmO beta.42: omo-senpi/components/task/task-rpc-codec.ts and
// senpi-task/state/types.ts. Only the selected latest assistant line is exposed;
// never retain spawn_spec, full output, final responses, or transcripts.
export function normalizeTask(raw) {
  if (!raw || !taskId(raw.task_id)) return null;
  const live = raw.live_progress;
  const stats = raw.run_stats;
  const tool = text(live?.current_tool, 128);
  const line = text(live?.last_assistant_line, 512);
  const progress = [tool ? `[${tool}]` : undefined, line].filter(Boolean).join(' ');
  const values = { id: raw.task_id,
    description: text(raw.description) ?? text(raw.task_summary) ?? text(raw.name),
    agent: text(raw.agent_type, 128) ?? text(raw.category, 128),
    model: text(raw.resolved_model?.model_id, 256)?.toLowerCase() ??
      text(raw.resolved_model?.display, 256) ?? text(raw.model, 256),
    reasoningEffort: text(raw.resolved_model?.reasoning_effort ?? raw.requested_model?.reasoning_effort ??
      raw.effective_model?.reasoning_effort, 64),
    status: text(raw.status, 64), startedAt: iso(live?.started_at) ?? iso(raw.created_at),
    completedAt: iso(raw.terminal_at) ?? (terminal.has(raw.status) ? iso(raw.updated_at) : undefined),
    progress: terminal.has(raw.status) ? undefined : text(progress, 512) ?? text(live?.activity, 512),
    turns: count(live?.turns) ?? count(stats?.turns), toolCalls: count(live?.tool_calls) ?? count(stats?.tool_calls),
    reportedAt: iso(raw.updated_at), metrics: metrics(stats, live, raw.updated_at) };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

export class TaskData {
  constructor({ cwd, sessionId, stateDir = join(cwd, '.omo', 'senpi-task'),
    notify = message => console.warn(message), onChange = () => {},
    read = readJson, statFile = stat }) {
    Object.assign(this, { sessionId, notify, onChange, read, statFile });
    this.directory = join(stateDir, 'tasks');
    this.entries = new Map();
    this.disk = new Map();
    this.statSignatures = new Map();
    this.foreign = new Map();
    this.pendingChanges = new Set();
    this.promotionQueue = [];
    this.promotionJob = undefined;
    this.stopped = false;
  }

  restore(tasks = []) {
    for (const raw of tasks) {
      const task = normalizeTask({ task_id: raw.id, description: raw.description, agent_type: raw.agent,
        model: raw.model, resolved_model: { reasoning_effort: raw.reasoningEffort },
        status: raw.status, created_at: raw.startedAt, terminal_at: raw.completedAt,
        updated_at: raw.reportedAt,
        live_progress: { activity: raw.progress, turns: raw.turns, tool_calls: raw.toolCalls } });
      if (!task) continue;
      const restoredMetrics = metrics(raw.metrics, undefined, raw.metrics?.reportedAt, raw.metrics?.source);
      if (restoredMetrics) task.metrics = restoredMetrics;
      this.entries.set(task.id, { task, parentSessionId: taskId(raw.parentTaskId) ? undefined : this.sessionId,
        ...(task.reportedAt ?? task.completedAt ? { updatedAt: task.reportedAt ?? task.completedAt } : {}),
        ...(taskId(raw.parentTaskId) ? { parentTaskId: raw.parentTaskId } : {}) });
    }
  }

  merge(raw, parentSessionId = raw.parent_session_id) {
    const task = normalizeTask(raw);
    if (!task || typeof parentSessionId !== 'string') return;
    const previous = this.entries.get(task.id);
    if (previous?.parentSessionId && previous.parentSessionId !== parentSessionId) return;
    const updatedAt = iso(raw.updated_at);
    if (previous?.updatedAt && updatedAt && updatedAt < previous.updatedAt) return;
    const merged = { ...previous?.task, ...task };
    if (terminal.has(merged.status)) {
      delete merged.progress;
      // Residency RPC updates lack terminal_at; updated_at must not move a known endpoint.
      if (!iso(raw.terminal_at) && previous?.task.completedAt) merged.completedAt = previous.task.completedAt;
    } else if (task.status) delete merged.completedAt;
    const childSessionId = typeof raw.child_session_id === 'string' ? raw.child_session_id : undefined;
    this.entries.set(task.id, { ...previous, task: merged, parentSessionId,
      ...(updatedAt ? { updatedAt } : {}),
      ...(childSessionId ? { childSessionId } : {}) });
    if (childSessionId && previous?.childSessionId !== childSessionId) this.schedulePromotion(childSessionId);
  }

  receive(payload) {
    if (this.stopped || !payload || !Array.isArray(payload.tasks)) return false;
    const session = payload.parent_session_id;
    if (session !== this.sessionId && ![...this.entries.values()].some(entry => entry.childSessionId === session)) return false;
    for (const raw of payload.tasks) {
      if (raw && (raw.parent_session_id === undefined || raw.parent_session_id === session)) this.merge(raw, session);
    }
    return true;
  }

  // Re-reads one task record when its (mtimeMs, size) signature changed. A record
  // whose parent session is not this one or a linked child session is parked in
  // `foreign`; later events only mark it dirty until a child link promotes it.
  async readRecord(file, { force = false, skipStat = true } = {}) {
    const path = join(this.directory, file);
    let metadata;
    try { metadata = await this.statFile(path); }
    catch (error) {
      if (error.code === 'ENOENT') { this.statSignatures.delete(file); this.disk.delete(file); this.foreign.delete(file); return; }
      this.notify(`DAG pane: Cannot read task record ${file}: ${error.message}`);
      return;
    }
    const signature = `${metadata.mtimeMs}:${metadata.size}`;
    if (!force && skipStat && this.statSignatures.get(file) === signature) return;
    let raw;
    try { raw = await this.read(path); }
    catch (error) { this.notify(`DAG pane: Cannot read task record ${file}: ${error.message}`); return; }
    if (raw === null) { this.statSignatures.delete(file); this.disk.delete(file); this.foreign.delete(file); return; }
    const task = normalizeTask(raw);
    if (!task) { this.notify(`DAG pane: Invalid task record ${file}`); this.statSignatures.set(file, signature); return; }
    const parentSessionId = raw.parent_session_id;
    if (typeof parentSessionId === 'string' && parentSessionId !== this.sessionId &&
      !this.childSessions().has(parentSessionId)) {
      this.foreign.set(file, { parentSessionId, dirty: this.foreign.get(file)?.dirty === true });
      this.statSignatures.set(file, signature);
      return;
    }
    this.foreign.delete(file);
    const diskSignature = JSON.stringify([task, parentSessionId, raw.child_session_id, raw.updated_at]);
    if (diskSignature === this.disk.get(file)) { this.statSignatures.set(file, signature); return; }
    this.disk.set(file, diskSignature);
    this.statSignatures.set(file, signature);
    this.merge(raw);
  }

  childSessions() {
    const sessions = new Set();
    for (const entry of this.entries.values()) if (entry.childSessionId) sessions.add(entry.childSessionId);
    return sessions;
  }

  schedulePromotion(childSessionId) {
    this.promotionQueue.push(childSessionId);
    this.drainPromotions();
  }

  drainPromotions() {
    if (this.promotionJob || !this.promotionQueue.length) return;
    this.promotionJob = (async () => {
      while (this.promotionQueue.length) {
        const childSessionId = this.promotionQueue.shift();
        const files = [...this.foreign].filter(([, meta]) => meta.parentSessionId === childSessionId).map(([file]) => file);
        for (const file of files) await this.readRecord(file, { force: true });
      }
    })().finally(() => { this.promotionJob = undefined; this.drainPromotions(); });
    this.promotionJob.catch(() => {});
  }

  async idle() {
    while (this.promotionJob) await this.promotionJob;
    if (this.promotionQueue.length) this.drainPromotions();
  }

  async refresh(runs) {
    let files;
    try { files = await readdir(this.directory); }
    catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
    // readdir names deliberately includes symlinked .json records, just like OmO's store.
    await Promise.all(files.filter(file => file.endsWith('.json')).map(file => this.readRecord(file, { skipStat: false })));
    await this.idle();
    return this.snapshot(runs);
  }

  // Watcher path: only record names in the coalesced batch are re-read. Invalid
  // names (.tmp and everything else) are ignored; a filename-less event is a full
  // refresh because the change cannot be attributed to one record.
  async refreshChanged(names) {
    const batch = new Set([...this.pendingChanges, ...(names == null ? [] : typeof names === 'string' ? [names] : [...names])]);
    this.pendingChanges.clear();
    if (!batch.size) { await this.idle(); return this.snapshot(); }
    if ([...batch].some(name => typeof name !== 'string' || !name)) return this.refresh();
    const files = [...new Set([...batch].filter(name => /^st_[A-Za-z0-9_-]+\.json$/.test(name)))];
    await Promise.all(files.map(async file => {
      const foreign = this.foreign.get(file);
      if (foreign) { foreign.dirty = true; return; }
      await this.readRecord(file);
    }));
    await this.idle();
    return this.snapshot();
  }

  snapshot() {
    const selected = new Map();
    // DAG membership is a presentation concern; every own-session task is a root.
    for (const [id, entry] of this.entries) {
      if (entry.parentSessionId === this.sessionId && !entry.parentTaskId) selected.set(id, { ...entry.task });
    }
    // A task owns a child session, not a DAG successor. Traverse only those explicit links.
    for (const [parentId] of selected) {
      const parent = this.entries.get(parentId);
      for (const [id, entry] of this.entries) {
        if (selected.has(id)) continue;
        if (entry.parentTaskId === parentId || (parent.childSessionId && entry.parentSessionId === parent.childSessionId)) {
          selected.set(id, { ...entry.task, parentTaskId: parentId });
        }
      }
    }
    return [...selected.values()];
  }

  start() {
    this.armWatcher();
  }

  armWatcher() {
    if (this.stopped) return;
    let directory = this.directory;
    while (!existsSync(directory) && dirname(directory) !== directory) directory = dirname(directory);
    if (directory === this.watchedDirectory) return;
    this.watcher?.close();
    this.watchedDirectory = directory;
    const next = relative(directory, this.directory).split(/[\\/]/)[0];
    this.watcher = watch(directory, { persistent: false }, (_event, filename) => {
      if (this.stopped || (next && filename && String(filename) !== next)) return;
      try {
        this.armWatcher();
        const name = (next || filename == null) ? '' : String(filename);
        this.pendingChanges.add(name);
        this.onChange(name || undefined);
      } catch (error) { this.notify(`DAG pane: Task watcher: ${error.message}`); }
    });
    this.watcher.on('error', error => {
      this.notify(`DAG pane: Task watcher: ${error.message}`);
      if (this.stopped) return;
      this.pendingChanges.add('');
      try { this.onChange(); }
      catch (callbackError) { this.notify(`DAG pane: Task watcher: ${callbackError.message}`); }
    });
    // mkdir can create the next component between existsSync and watch. Subscribe
    // before checking again so that a newly created task directory cannot be missed.
    this.armWatcher();
  }

  stop() {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = undefined;
    this.watchedDirectory = undefined;
  }
}
