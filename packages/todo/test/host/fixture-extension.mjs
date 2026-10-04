// Test-only observation probe.
//
// Loaded by the real DefaultResourceLoader AFTER the stock builtin Todo
// extension, so the host tests can prove builtin-first ordering, native factory
// capture at the exact native key, restoration through the original setter and
// dispose/remove semantics. This is not product code: the task-4 display bridge
// is a later, separately verified implementation.
import { hostContextEligible } from '../../src/child-guard.mjs';

export const PROBE_HOST_KEY = Symbol.for('omo-herdr-todo.host-probe');
export const PROBE_WIDGET_KEY = 'todo-sidebar';

export default function fixtureExtension(pi) {
  const host = globalThis[PROBE_HOST_KEY];
  if (!host) return;
  pi.on('session_start', (_event, ctx) => host.install(ctx));
  pi.on('session_shutdown', () => host.remove());
}

export function installProbe(ctx, host) {
  const gate = hostContextEligible(ctx, host);
  if (!gate.eligible) return undefined;
  const ui = ctx.ui;
  const original = ui.setWidget;
  let captured;
  let recovery;
  let ready = false;
  let masked = false;
  let disposed = false;
  const captures = [];
  const failures = [];

  function refresh() {
    try {
      const state = host.read();
      if (!state || !Array.isArray(state.phases)) throw new Error('Recovery unavailable');
      recovery = structuredClone(state);
      return true;
    } catch (error) {
      failures.push(error.message);
      return false;
    }
  }

  // Always bypass the facade wrapper: masking, restoration and labelled
  // recovery calls are never captured as native factories.
  function own(content, options) {
    return original.call(ui, PROBE_WIDGET_KEY, content, options);
  }

  function restore() {
    if (captured) own(captured.content, captured.options);
    else if (recovery && recovery.phases.length > 0) own(recoveryLines(recovery));
    else if (recovery) own(undefined);
    masked = false;
  }

  function hide() {
    if (!ready || !refresh() || (!captured && !recovery)) return false;
    try {
      own(undefined);
      masked = true;
      return true;
    } catch (error) {
      ready = false;
      failures.push(error.message);
      return false;
    }
  }

  function wrapper(key, content, options) {
    if (key !== PROBE_WIDGET_KEY) return original.call(ui, key, content, options);
    captured = { content, options };
    captures.push({ content, options, entry: host.leaf() });
    const published = refresh();
    if (!published) ready = false;
    if (content === undefined) {
      masked = false;
      return original.call(ui, key, content, options);
    }
    if (ready && published) {
      try {
        own(undefined);
        masked = true;
        return undefined;
      } catch (error) {
        // A mask failure must not turn a committed native update into no UI.
        ready = false;
        failures.push(error.message);
      }
    }
    masked = false;
    return original.call(ui, key, content, options);
  }

  refresh();
  ui.setWidget = wrapper;

  return {
    ui,
    original,
    wrapper,
    captures,
    failures,
    gate,
    get captured() { return captured; },
    get recovery() { return recovery; },
    get masked() { return masked; },
    get ready() { return ready; },
    // Readiness gate over the shared surface. The paint signal belongs to the
    // harness scope here; a real painted PTY frame is proven by the task-1 host
    // probe and by later IPC/live tasks, not claimed by this harness.
    acceptReady(ack) {
      const owner = host.owner;
      if (disposed || !ack || ack.v !== 1 || ack.token !== owner.token ||
          ack.ownerKey !== owner.ownerKey || ack.session !== owner.session ||
          ack.scope !== owner.scope || ack.role !== 'todo' ||
          ack.sequence !== host.sequence || !host.painted(ack.marker)) return false;
      ready = true;
      return hide();
    },
    maskKey(key) { return key === PROBE_WIDGET_KEY ? hide() : false; },
    close() {
      ready = false;
      if (masked) restore();
    },
    remove() {
      if (disposed) return;
      ready = false;
      if (masked) restore();
      if (ui.setWidget === wrapper) ui.setWidget = original;
      disposed = true;
    },
  };
}

/** Labelled owned recovery lines derived from the current native branch. */
export function recoveryLines(state) {
  const lines = ['[owned recovery: native Todo branch; not native renderer]'];
  if (state.ask) lines.push(`Ask: ${state.ask.text}`);
  for (const phase of state.phases) {
    const count = { completed: 0, abandoned: 0, in_progress: 0, pending: 0 };
    for (const task of phase.tasks) count[task.status]++;
    const closed = count.completed + count.abandoned;
    lines.push(`${phase.name}: ${closed}/${phase.tasks.length} closed; completed=${count.completed}; dropped=${count.abandoned}; active=${count.in_progress}; pending=${count.pending}`);
    for (const task of phase.tasks) lines.push(`${task.status}: ${task.content}`);
  }
  return lines;
}
