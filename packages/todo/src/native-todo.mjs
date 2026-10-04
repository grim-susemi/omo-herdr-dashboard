// Read-only projection of a supplied, selected root-to-leaf native branch.
// No scheduler, native task IDs, session writer or private SDK imports.
const record = value => typeof value === 'object' && value !== null;
const statuses = new Set(['pending', 'in_progress', 'completed', 'abandoned']);

function parsePayload(value) {
  if (!record(value)) return undefined;
  const phased = value.schema === 'v2' || Array.isArray(value.phases);
  const source = phased ? value.phases : Array.isArray(value.todos)
    ? [{ name: 'Tasks', tasks: value.todos }] : undefined;
  if (!Array.isArray(source)) return undefined;
  const phases = [];
  for (const phase of source) {
    if (!record(phase) || typeof phase.name !== 'string' || !Array.isArray(phase.tasks)) return undefined;
    const tasks = [];
    for (const task of phase.tasks) {
      if (!record(task) || typeof task.content !== 'string') return undefined;
      const status = task.status === 'cancelled' ? 'abandoned'
        : statuses.has(task.status) ? task.status : phased ? undefined : 'pending';
      if (!status) return undefined;
      tasks.push({ content: task.content, status });
    }
    phases.push({ name: phase.name, tasks });
  }
  const ask = record(value.ask) && typeof value.ask.entryId === 'string' &&
    typeof value.ask.text === 'string' && typeof value.ask.capturedAt === 'number'
    ? structuredClone(value.ask) : undefined;
  return { phases, ask };
}

function countTasks(tasks) {
  const counts = { total: 0, closed: 0, open: 0, completed: 0, dropped: 0, inProgress: 0, pending: 0 };
  for (const task of tasks) {
    counts.total++;
    if (task.status === 'completed') counts.completed++;
    else if (task.status === 'abandoned') counts.dropped++;
    else if (task.status === 'in_progress') counts.inProgress++;
    else counts.pending++;
  }
  counts.closed = counts.completed + counts.dropped;
  counts.open = counts.inProgress + counts.pending;
  return counts;
}

/**
 * Latest eligible payload replaces phases AND ask, including explicit [].
 * Unlike stock replay, failed tool results are excluded even with valid details.
 * Compaction snapshots, proposals and restore requests are never native state.
 */
export function projectNativeTodo(branch) {
  if (!Array.isArray(branch)) throw new TypeError('Expected a selected root-to-leaf branch array');
  let state = { phases: [], ask: undefined };
  let sourceEntryId = null;
  let found = false;
  for (const entry of branch) {
    if (!record(entry)) continue;
    let payload;
    if (entry.type === 'custom' && entry.customType === 'senpi.todo-state') {
      payload = entry.data;
    } else if (entry.type === 'message' && record(entry.message) &&
      entry.message.role === 'toolResult' &&
      (entry.message.toolName === 'todo' || entry.message.toolName === 'todowrite') &&
      !entry.message.isError) {
      payload = entry.message.details;
    } else continue;
    const parsed = parsePayload(payload);
    if (!parsed) continue;
    state = parsed;
    sourceEntryId = typeof entry.id === 'string' ? entry.id : null;
    found = true;
  }
  const phaseOccurrences = new Map();
  const phaseSummaries = state.phases.map((phase, phaseIndex) => {
    const occurrence = phaseOccurrences.get(phase.name) ?? 0;
    phaseOccurrences.set(phase.name, occurrence + 1);
    // JSON tuples are local display keys, not IDs supplied by the engine.
    const key = JSON.stringify([phase.name, occurrence]);
    const taskOccurrences = new Map();
    const taskKeys = phase.tasks.map(task => {
      const taskOccurrence = taskOccurrences.get(task.content) ?? 0;
      taskOccurrences.set(task.content, taskOccurrence + 1);
      return JSON.stringify([phase.name, occurrence, task.content, taskOccurrence]);
    });
    return { key, phaseIndex, taskKeys, counts: countTasks(phase.tasks) };
  });
  let target = null;
  for (const status of ['in_progress', 'pending']) {
    for (const [phaseIndex, phase] of state.phases.entries()) {
      const taskIndex = phase.tasks.findIndex(task => task.status === status);
      if (taskIndex !== -1) {
        target = {
          phaseIndex, taskIndex, phaseName: phase.name,
          key: phaseSummaries[phaseIndex].taskKeys[taskIndex],
          ...phase.tasks[taskIndex],
        };
        break;
      }
    }
    if (target) break;
  }
  const counts = countTasks(state.phases.flatMap(phase => phase.tasks));
  return {
    ...state, sourceEntryId, counts, phaseSummaries, target,
    availability: !found ? 'waiting' : counts.total === 0 ? 'empty' : 'current',
  };
}

/**
 * Caller explicitly rebases on session_start, session_tree or rebind.
 * Append/compaction observations change only the leaf revision. No UI prefs are
 * stored here, so duplicate observations cannot reset cursor, folds or follow.
 */
export function createNativeTodoProjection() {
  let scopeEpoch = 0;
  let scope = null;
  let snapshot = { ...projectNativeTodo([]), scopeEpoch, scope, leafRevision: null };
  return {
    get snapshot() { return structuredClone(snapshot); },
    rebase(nextScope) {
      scope = structuredClone(nextScope);
      scopeEpoch++;
      snapshot = { ...projectNativeTodo([]), scopeEpoch, scope, leafRevision: null };
      return scopeEpoch;
    },
    observe({ scopeEpoch: epoch, branch, leafRevision = null }) {
      if (epoch !== scopeEpoch || scopeEpoch === 0) return false;
      const next = { ...projectNativeTodo(branch), scopeEpoch, scope, leafRevision };
      if (JSON.stringify(next) === JSON.stringify(snapshot)) return false;
      snapshot = next;
      return true;
    },
    read(sessionManager, epoch) {
      if (epoch !== scopeEpoch || scopeEpoch === 0) return false;
      return this.observe({
        scopeEpoch: epoch,
        branch: sessionManager.getBranch(),
        leafRevision: sessionManager.getLeafId(),
      });
    },
  };
}
