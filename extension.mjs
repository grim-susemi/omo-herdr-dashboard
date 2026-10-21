import todo from './todo/extension.mjs';
import dag from './dag/extension.mjs';
import coordination from './coordination/extension.mjs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECOVERY_V1, layoutIssues, resultIssues, sameScope, validScope }
  from './coordination/src/recovery.mjs';

const DEFAULT_COMMAND_TIMEOUT_MS = 5000;
const MAX_TRACKED_LAYOUTS = 16;
const MAX_TRACKED_COMMANDS = 512;
const TIMEOUT = Symbol('dashboard-command-timeout');
const WRAPPED = Symbol.for('omo.herdr.dashboard.composite-command');
const PROVIDER = 'omo.herdr.dashboard.provider';

const copy = value => value === null || value === undefined ? value : structuredClone(value);
const waiting = (scope = null, reason = null) => ({
  v: 1, kind: 'result', scope, commandId: null, status: 'waiting', fourPaneComplete: false,
  core: { ready: false, bindingCurrent: false }, collab: { current: false, paneId: null },
  pending: true, timedOut: false, ...(reason ? { reason } : {}),
});

// The root command response joins the Todo publisher's authoritative result
// with the latest settled layout. A late layout may update this state after a
// bounded response has already returned, but it never produces a second
// terminal response. Only a core READY result and a current Collab cell in the
// same sequence, scope and binding may report 4/4.
export function createDashboardComposite({ timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  setTimeout: schedule = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout,
  scopeProvider } = {}) {
  let scope = null, pinned = null;
  let lastResult = null, lastResultBinding = null, lastResultPass = 0;
  let lastResultCollab = false, lastResultCommand = null, lastResultGeometry = null;
  let lastLayout = null, lastAppliedPass = 0, lastCloseSeq = 0;
  let updates = 0, responses = 0;
  const layouts = new Map();
  const commandPass = new Map();

  function clear() {
    scope = null; lastResult = null; lastResultBinding = null; lastResultPass = 0;
    lastResultCollab = false; lastResultCommand = null; lastResultGeometry = null;
    lastLayout = null; lastAppliedPass = 0; lastCloseSeq = 0;
    layouts.clear(); commandPass.clear();
  }
  function localScope() {
    try { return scopeProvider?.() ?? null; } catch { return null; }
  }
  // A live owner/session/lifetime/tab binding anchors all state. Without one,
  // messages stay pending: the first publisher on the bus is never adopted as
  // the local lifecycle. A changed local scope clears the previous binding in
  // the same call, before the new state can be evaluated.
  function pin(next) {
    if (!validScope(next)) return false;
    pinned = copy(next);
    if (!scope || !sameScope(scope, next)) { clear(); scope = copy(next); }
    return true;
  }
  function sync() {
    const local = localScope();
    // A root without a live owner/session/lifetime/tab binding has no current
    // state. Losing it clears cached completion in the same read/accept; an
    // old pinned scope is never used as a fallback.
    if (!validScope(local)) {
      if (pinned || scope || lastResult || lastLayout) { pinned = null; clear(); }
      return null;
    }
    if (!pinned || !sameScope(pinned, local)) pin(local);
    return local;
  }
  function accepts(next) {
    const binding = sync();
    return validScope(binding) && validScope(next) && sameScope(binding, next);
  }
  function changed() { updates += 1; }
  function liveLayout() {
    return lastLayout && scope && sameScope(lastLayout.scope, scope) ? lastLayout : null;
  }
  function observeLayout(message) {
    if (layoutIssues(message).length || !accepts(message.scope)) return false;
    const sameBinding = lastLayout && sameScope(lastLayout.scope, message.scope) &&
      lastLayout.bindingRevision === message.bindingRevision;
    // A replay or a delayed older pass can never resurrect a newer close, even
    // when it names an older core binding. passSeq is monotonic per lifetime.
    if (lastLayout && sameScope(lastLayout.scope, message.scope) && message.passSeq <= lastAppliedPass)
      return false;
    if (lastLayout && sameScope(lastLayout.scope, message.scope) && !sameBinding) {
      // The core binding changed: drop the old core/Collab status before the
      // new layout is applied, so completion cannot survive a pane rebuild.
      lastResult = null; lastResultBinding = null; lastResultPass = 0;
      lastResultCollab = false; lastResultCommand = null; lastResultGeometry = null;
      layouts.clear(); commandPass.clear();
    }
    lastLayout = copy(message);
    lastAppliedPass = message.passSeq;
    // The close watermark advances for every applied close and is independent
    // of the bounded layout/result maps.
    if (!message.cells.some(cell => cell.role === 'collab'))
      lastCloseSeq = Math.max(lastCloseSeq, message.passSeq);
    commandPass.set(message.commandId, message.passSeq);
    while (commandPass.size > MAX_TRACKED_COMMANDS)
      commandPass.delete(commandPass.keys().next().value);
    layouts.delete(message.commandId);
    layouts.set(message.commandId, copy(message));
    while (layouts.size > MAX_TRACKED_LAYOUTS) layouts.delete(layouts.keys().next().value);
    changed();
    return true;
  }
  function observeResult(message) {
    if (resultIssues(message).length || !accepts(message.scope)) return false;
    const layout = layouts.get(message.commandId) ?? null;
    const pass = layout?.passSeq ?? commandPass.get(message.commandId);
    // A fully evicted pass proof is not evidence. Drop it entirely: it must
    // never overwrite newer core/Collab state, even to negate it.
    if (pass === undefined) return false;
    // Monotonic ordering across retained and evicted history. A result older
    // than the newest applied layout is stale even if its own pass proof is
    // still in commandPass.
    if (pass < lastAppliedPass) return false;
    if (pass < lastResultPass) return false;
    if (pass < lastCloseSeq) return false;
    if (pass === lastResultPass && message.commandId !== lastResultCommand) return false;
    if (pass === lastResultPass && message.commandId === lastResultCommand) return false;
    const currentBinding = lastLayout?.bindingRevision ?? null;
    if (layout && currentBinding && layout.bindingRevision !== currentBinding) return false;
    const layoutHasCollab = Boolean(layout?.cells?.some(cell => cell.role === 'collab'));
    lastResult = copy(message);
    lastResultBinding = layout?.bindingRevision ?? lastResultBinding;
    lastResultGeometry = layout?.geometryRevision ?? null;
    lastResultPass = pass;
    // A result can only contribute a current Collab cell for its own retained
    // layout; no-layout/evicted results never authorize completion.
    lastResultCollab = message.collab?.current === true && layoutHasCollab;
    lastResultCommand = message.commandId;
    changed();
    return true;
  }
  function state(expected = null, commandId = null) {
    const binding = sync();
    const wanted = expected ?? scope;
    if (!validScope(binding) || !scope || !wanted || !sameScope(scope, wanted))
      return waiting(wanted, validScope(binding) ? 'scope-unsettled' : 'lifecycle-unbound');
    const layout = commandId ? layouts.get(commandId) ?? null : liveLayout();
    const result = commandId ? (lastResult?.commandId === commandId ? lastResult : null) : lastResult;
    const resultBinding = result && result === lastResult ? lastResultBinding : null;
    const resultGeometry = result && result === lastResult ? lastResultGeometry : null;
    const failed = Boolean(result) && (result.status === 'failed' || Boolean(result.error) ||
      Boolean(result.core?.error) || result.core?.failed === true ||
      result.collab?.failed === true || Boolean(result.collab?.error) ||
      result.collab?.state === 'failed' || result.collab?.state === 'error' ||
      result.collab?.phase === 'failed' || result.collab?.phase === 'error');
    const coreReady = !failed && result?.core?.ready === true;
    const layoutCollab = layout?.cells?.find(cell => cell.role === 'collab') ?? null;
    // A settled layout newer than the result carries the current Collab cell.
    // Otherwise the result's own Collab status is authoritative, so a close or
    // failure cannot be undone by an older layout cell.
    const layoutNewer = Boolean(layout) && layout.passSeq > (lastResultPass ?? 0);
    // A proof is current only when it was minted for the live settled geometry
    // and after the newest close. A width-only re-settle keeps the binding but
    // changes the geometry, so the earlier result cannot authorize the new row
    // from its Collab cell alone; a fresh result for that geometry is required.
    const proofCurrent = Boolean(result) && Boolean(resultGeometry) &&
      layout?.geometryRevision === resultGeometry && lastResultPass >= lastCloseSeq;
    const collabCurrent = !failed && proofCurrent &&
      (layoutNewer ? Boolean(layoutCollab) : Boolean(result) && lastResultCollab);
    const collabCell = layoutNewer ? layoutCollab : null;
    const bindingCurrent = Boolean(resultBinding) && layout?.bindingRevision === resultBinding;
    const proofReason = !collabCurrent && result
      ? (resultGeometry && layout && layout.geometryRevision !== resultGeometry ? 'geometry-mismatch'
        : layout && lastResultPass < lastCloseSeq ? 'proof-stale' : null)
      : null;
    // A result that itself denies four-pane completion keeps that veto until a
    // newer settled layout supersedes it.
    const resultVeto = Boolean(result) && !layoutNewer && result.fourPaneComplete !== true;
    const fourPaneComplete = !failed && !resultVeto && coreReady && collabCurrent && bindingCurrent;
    let status = 'waiting';
    if (failed) status = 'failed';
    else if (result?.status === 'waiting') status = 'waiting';
    else if (result) status = fourPaneComplete ? 'settled' : 'partial';
    return {
      v: 1, kind: 'result', scope: copy(scope), commandId: result?.commandId ?? commandId ?? null,
      status, fourPaneComplete,
      core: { ready: coreReady, bindingCurrent,
        workers: result?.core?.workers ?? layout?.workers ?? null,
        dag: result?.core?.dag ?? layout?.dag ?? null },
      collab: { current: collabCurrent, paneId: collabCell?.paneId ?? result?.collab?.paneId ?? null,
        ...(failed ? { reason: 'failed' } : proofReason ? { reason: proofReason }
          : result?.collab?.reason ? { reason: result.collab.reason } : {}) },
      bindingRevision: resultBinding ?? layout?.bindingRevision ?? null,
      pending: false, timedOut: false,
    };
  }
  function messageOf(value) {
    const core = value.core?.ready ? 'core READY' : 'core not ready';
    const collab = value.collab?.current ? 'Collab current' : `Collab ${value.collab?.reason ?? 'not current'}`;
    if (value.status === 'settled' && value.fourPaneComplete)
      return `Dashboard 4/4: ${core}; ${collab}.`;
    if (value.status === 'failed')
      return `Dashboard recovery failed: ${core}; ${collab}${value.error?.message ? ` (${value.error.message})` : ''}.`;
    if (value.status === 'waiting')
      return `Dashboard waiting: ${core}; ${collab}. Later updates may converge without another response.`;
    return `Dashboard partial: ${core}; ${collab}. Four-pane completion is not claimed.`;
  }
  function notify(ctx, value) {
    try { ctx?.ui?.notify?.(messageOf(value), value.fourPaneComplete ? 'info' : 'warning'); }
    catch { /* a notification channel must not fail the command */ }
  }
  function finish(setup) {
    return value => {
      if (setup.settled) return;
      setup.settled = true;
      if (setup.timer !== undefined) cancel(setup.timer);
      responses += 1;
      notify(setup.ctx, value);
      setup.resolve(value);
    };
  }
  function fromHandle(handle, result) {
    if (!handle || !validScope(handle.scope)) return waiting(handle?.scope ?? null, handle?.reason ?? 'scope-unsettled');
    const direct = result && typeof result === 'object' && !resultIssues(result).length &&
      validScope(result.scope) && sameScope(result.scope, handle.scope) ? result : null;
    if (direct) observeResult(direct);
    const value = state(handle.scope, handle.commandId);
    // A direct failed/waiting result is truthful for this command even when
    // its pass proof was evicted and current state did not accept it.
    if (direct?.status === 'failed' || direct?.error || direct?.core?.failed === true ||
      direct?.collab?.failed === true || direct?.collab?.error)
      return { ...value, status: 'failed', fourPaneComplete: false, pending: false,
        error: direct.error ?? null };
    if (direct?.status === 'waiting')
      return { ...value, status: 'waiting', fourPaneComplete: false, pending: true };
    if (lastResult?.commandId !== handle.commandId)
      return { ...value, status: 'waiting', fourPaneComplete: false, pending: true };
    return value;
  }
  function failed(handle, error) {
    const value = state(handle?.scope ?? null, handle?.commandId ?? null);
    return { ...value, status: 'failed', fourPaneComplete: false, pending: false,
      error: { code: error?.code ?? 'RECOVERY_FAILED', message: error?.message ?? String(error) } };
  }
  function command(handler, args, ctx) {
    return new Promise(done => {
      const setup = { ctx, settled: false, timer: undefined, resolve: done };
      const finishOnce = finish(setup);
      const deadline = new Promise(resolve => {
        setup.timer = schedule(() => resolve(TIMEOUT), timeoutMs);
      });
      const invoked = Promise.resolve().then(() => handler(args, ctx));
      invoked.then(handle => {
        if (!handle?.pending || typeof handle.pending.then !== 'function') return;
        Promise.resolve(handle.pending).then(result => {
          if (result && typeof result === 'object' && validScope(handle.scope) &&
            sameScope(result.scope, handle.scope)) observeResult(result);
        }, () => {});
      }, () => {});
      invoked.then(async handle => {
        if (setup.settled) return;
        if (!handle || !validScope(handle.scope)) {
          finishOnce(waiting(handle?.scope ?? null, handle?.reason ?? 'scope-unsettled'));
          return;
        }
        if (!handle.pending || typeof handle.pending.then !== 'function') {
          finishOnce(fromHandle(handle, null));
          return;
        }
        try { const result = await handle.pending; if (!setup.settled) finishOnce(fromHandle(handle, result)); }
        catch (error) { if (!setup.settled) finishOnce(failed(handle, error)); }
      }, error => { if (!setup.settled) finishOnce(failed(null, error)); });
      deadline.then(() => {
        if (setup.settled) return;
        const value = state(scope);
        finishOnce({ ...value, status: 'waiting', fourPaneComplete: false, pending: true, timedOut: true });
      });
    });
  }
  return {
    command, observeLayout, observeResult, state, clear, pin,
    get scope() { sync(); return copy(scope); },
    current: (expected = null) => state(expected),
    get updates() { return updates; },
    get responses() { return responses; },
  };
}

export default function dashboard(pi, options = {}) {
  const state = resolve(dirname(fileURLToPath(import.meta.url)), '../../state');
  process.env.OMO_HERDR_TODO_STATE_DIR ??= resolve(state, 'todo');
  process.env.OMO_HERDR_DAG_STATE_DIR ??= resolve(state, 'dag');
  process.env.OMO_HERDR_COORDINATION_STATE_DIR ??= resolve(state, 'coordination');
  let service = null;
  const composite = createDashboardComposite({ timeoutMs: options.commandTimeoutMs,
    setTimeout: options.setTimeout, clearTimeout: options.clearTimeout,
    scopeProvider: () => service?.controller?.recoveryScope?.() });
  const offs = [];
  const on = pi.events?.on?.bind(pi.events);
  if (on) {
    offs.push(on(RECOVERY_V1.layout, message => composite.observeLayout(message)));
    offs.push(on(RECOVERY_V1.result, message => composite.observeResult(message)));
    offs.push(on(PROVIDER, event => {
      if (event?.v !== 2 || event.kind !== 'managed-availability' ||
        event.socketPath !== process.env.HERDR_SOCKET_PATH ||
        event.parentPaneId !== process.env.HERDR_PANE_ID) return;
      service = event.service;
    }));
  }
  // A late or older DAG entry may stop after opening its panes. The root still
  // owns the bounded response, so it asks the live Todo controller for the same
  // explicit recovery pass rather than reporting a replay as success.
  const drive = async (handler, args, ctx) => {
    let handle = await handler(args, ctx);
    const controller = service?.controller;
    let local = null;
    try { local = controller?.recoveryScope?.() ?? null; } catch { local = null; }
    if ((!handle || !validScope(handle?.scope)) && validScope(local)) {
      if (typeof controller.requestRecovery === 'function') {
        const commandId = randomUUID();
        handle = { scope: local, commandId, pending: controller.requestRecovery({ commandId, explicit: true }) };
      }
    } else if (handle && validScope(handle.scope) && !handle.pending &&
      typeof controller?.requestRecovery === 'function') {
      const commandId = handle.commandId ?? randomUUID();
      handle = { ...handle, commandId, pending: controller.requestRecovery({ commandId, explicit: true }) };
    }
    return handle;
  };
  const register = pi.registerCommand?.bind(pi);
  if (register && !pi.registerCommand[WRAPPED]) {
    const wrapped = (name, command) => {
      if (name !== 'dashboard' || typeof command?.handler !== 'function') return register(name, command);
      return register(name, { ...command,
        handler: (args, ctx) => {
          let local = null;
          try { local = service?.controller?.recoveryScope?.() ?? null; } catch { local = null; }
          if (validScope(local)) composite.pin(local);
          return composite.command((a, c) => drive(command.handler, a, c), args, ctx);
        } });
    };
    wrapped[WRAPPED] = true;
    pi.registerCommand = wrapped;
  }
  todo(pi, options.todo);
  dag(pi, options.dag);
  coordination(pi, options.coordination);
  return { composite, unsubscribe: () => { for (const off of offs) off(); } };
}
