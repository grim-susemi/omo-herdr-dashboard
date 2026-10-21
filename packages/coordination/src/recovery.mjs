// Shared v1 recovery protocol for the four-pane dashboard.
//
// One small, dependency-free module owns the namespaced message names, the
// scope/identity comparison, shape validation, revision derivation and the
// single-flight command coordinator. Todo, DAG and the Collab satellite import
// this module instead of re-deriving strings or revision rules.
import { createHash, randomUUID } from 'node:crypto';

export const RECOVERY_V1 = Object.freeze({
  layout: 'omo.herdr.dashboard.layout.v1',
  layoutQuery: 'omo.herdr.dashboard.layout-query.v1',
  yield: 'omo.herdr.dashboard.yield.v1',
  result: 'omo.herdr.dashboard.result.v1',
});

export const RECOVERY_SCOPE_KEYS = Object.freeze([
  'ownerKey', 'sessionId', 'lifetimeId', 'scopeEpoch', 'generation', 'tabId',
]);
export const RECOVERY_ROLES = Object.freeze(['collab', 'workers', 'dag']);
export const CORE_ORDER = Object.freeze(['todo', 'workers', 'dag']);
export const RESULT_STATUSES = Object.freeze(['settled', 'waiting', 'partial', 'failed', 'coalesced']);
// Measured v4 shares of the lower row: collab | workers | DAG.
export const LOWER_BAND_PROPORTIONS = Object.freeze({ collab: 28, workers: 28, dag: 30 });

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.length > 0;
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isPositive = value => Number.isSafeInteger(value) && value > 0;
const isRect = value => isObject(value) && Number.isSafeInteger(value.x) && Number.isSafeInteger(value.y) &&
  isPositive(value.width) && isPositive(value.height);
const hasRevision = value => typeof value === 'string' && /^[0-9a-f]{16,64}$/.test(value);

export class RecoveryProtocolError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.name = 'RecoveryProtocolError';
    this.code = code;
    this.details = details;
  }
}

export function protocolError(code, message, details = []) {
  return new RecoveryProtocolError(code, message, details);
}

export function scopeIssues(scope) {
  if (!isObject(scope)) return ['scope must be an object'];
  const issues = [];
  for (const key of ['ownerKey', 'sessionId', 'lifetimeId', 'tabId'])
    if (!isText(scope[key])) issues.push(`scope.${key} must be a non-empty string`);
  if (!isCount(scope.scopeEpoch)) issues.push('scope.scopeEpoch must be a non-negative integer');
  if (!isPositive(scope.generation)) issues.push('scope.generation must be a positive integer');
  return issues;
}

export function validScope(scope) {
  return scopeIssues(scope).length === 0;
}

export function assertScope(scope) {
  const issues = scopeIssues(scope);
  if (issues.length) throw protocolError('RECOVERY_SCOPE_INVALID', 'invalid recovery scope', issues);
  return scope;
}

export function sameScope(a, b) {
  return validScope(a) && validScope(b) && RECOVERY_SCOPE_KEYS.every(key => a[key] === b[key]);
}

export function scopeKey(scope) {
  return validScope(scope) ? JSON.stringify(RECOVERY_SCOPE_KEYS.map(key => scope[key])) : null;
}

const orderedScope = scope => Object.fromEntries(RECOVERY_SCOPE_KEYS.map(key => [key, scope[key]]));

export function bindingRevision({ scope, todo, workers, dag, order = CORE_ORDER } = {}) {
  assertScope(scope);
  if (![todo, workers, dag].every(isText))
    throw protocolError('RECOVERY_BINDING_INVALID', 'binding requires exact todo, workers and dag pane ids');
  if (!Array.isArray(order) || order.length !== CORE_ORDER.length || CORE_ORDER.some(role => !order.includes(role)))
    throw protocolError('RECOVERY_BINDING_INVALID', 'binding requires the core role order');
  const identity = { scope: orderedScope(scope), todo, workers, dag, order: [...order] };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

const rectFields = rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });

export function geometryRevision({ band, cells } = {}) {
  if (!isRect(band)) throw protocolError('RECOVERY_GEOMETRY_INVALID', 'band must be a full rectangle');
  if (!Array.isArray(cells) || !cells.length)
    throw protocolError('RECOVERY_GEOMETRY_INVALID', 'cells must be a non-empty array');
  const canonical = [...cells].sort((a, b) => RECOVERY_ROLES.indexOf(a?.role) - RECOVERY_ROLES.indexOf(b?.role));
  const identity = { band: rectFields(band), cells: canonical.map(cell => [cell.role, rectFields(cell.rect)]) };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export function lowerRowWidths(total) {
  if (!isPositive(total)) return null;
  const sum = LOWER_BAND_PROPORTIONS.collab + LOWER_BAND_PROPORTIONS.workers + LOWER_BAND_PROPORTIONS.dag;
  const collab = Math.round(total * LOWER_BAND_PROPORTIONS.collab / sum);
  return { collab, workers: collab, dag: total - 2 * collab };
}

// The publisher may only name panes it owns in this tab: the three core panes
// and a Collab pane that equals the scoped coordination record. Every other
// pane in the tab is excluded from the band and from the cells.
export function deriveLowerBand({ panes = [], todo, workers, dag, collab } = {}) {
  for (const id of [todo, workers, dag]) if (!isText(id)) return null;
  const byId = new Map();
  for (const pane of panes) if (isText(pane?.pane_id) && isRect(pane.rect)) byId.set(pane.pane_id, pane);
  const workersRect = byId.get(workers)?.rect, dagRect = byId.get(dag)?.rect;
  if (!workersRect || !dagRect) return null;
  if (workersRect.y !== dagRect.y || workersRect.height !== dagRect.height ||
    workersRect.x + workersRect.width !== dagRect.x) return null;
  const cells = [
    { role: 'workers', paneId: workers, rect: rectFields(workersRect) },
    { role: 'dag', paneId: dag, rect: rectFields(dagRect) },
  ];
  let band = { x: workersRect.x, y: workersRect.y,
    width: dagRect.x + dagRect.width - workersRect.x, height: workersRect.height };
  if (collab) {
    const collabRect = byId.get(collab)?.rect;
    // A Collab cell is authoritative only when it is the leftmost cell of the
    // same lower row. A pane elsewhere in the tab never enlarges the band.
    if (collabRect && collabRect.y === workersRect.y && collabRect.height === workersRect.height &&
      collabRect.x + collabRect.width === workersRect.x) {
      cells.unshift({ role: 'collab', paneId: collab, rect: rectFields(collabRect) });
      band = { x: collabRect.x, y: workersRect.y,
        width: band.x + band.width - collabRect.x, height: workersRect.height };
    }
  }
  return { band, cells };
}

export function cellsIssues(cells) {
  if (!Array.isArray(cells) || cells.length < 2 || cells.length > RECOVERY_ROLES.length)
    return ['cells must contain two or three owned cells'];
  const issues = [], seen = new Set();
  for (const [index, cell] of cells.entries()) {
    if (!isObject(cell) || !RECOVERY_ROLES.includes(cell.role))
      issues.push(`cells[${index}].role must be collab, workers or dag`);
    else if (seen.has(cell.role)) issues.push(`cells[${index}] duplicates ${cell.role}`);
    else seen.add(cell.role);
    if (!isText(cell?.paneId)) issues.push(`cells[${index}].paneId must be a non-empty string`);
    if (!isRect(cell?.rect)) issues.push(`cells[${index}].rect must be a full rectangle`);
  }
  for (const role of ['workers', 'dag']) if (!seen.has(role)) issues.push(`cells must contain ${role}`);
  return issues;
}

export function layoutIssues(layout) {
  if (!isObject(layout)) return ['layout must be an object'];
  const issues = [];
  if (layout.v !== 1) issues.push('layout.v must be 1');
  if (layout.kind !== 'layout') issues.push('layout.kind must be layout');
  issues.push(...scopeIssues(layout.scope));
  if (!isText(layout.commandId)) issues.push('layout.commandId must be a non-empty string');
  if (!isPositive(layout.passSeq)) issues.push('layout.passSeq must be a positive integer');
  for (const key of ['bindingRevision', 'geometryRevision'])
    if (!hasRevision(layout[key])) issues.push(`layout.${key} must be a 16-64 character lowercase hex digest`);
  for (const key of ['todo', 'workers', 'dag'])
    if (!isText(layout[key])) issues.push(`layout.${key} must be a non-empty string`);
  if (typeof layout.explicit !== 'boolean') issues.push('layout.explicit must be a boolean');
  if (!isRect(layout.band)) issues.push('layout.band must be a full rectangle');
  issues.push(...cellsIssues(layout.cells));
  // The payload is authoritative only when its revisions and band agree.
  if (!issues.length) {
    try {
      if (layout.bindingRevision !== bindingRevision(layout))
        issues.push('layout.bindingRevision does not match the scoped core identity');
      if (layout.geometryRevision !== geometryRevision(layout))
        issues.push('layout.geometryRevision does not match band/cells');
    } catch (error) { issues.push(error.message); }
    if (!issues.length) {
      const xs = layout.cells.map(cell => cell.rect.x).sort((a, b) => a - b);
      const right = Math.max(...layout.cells.map(cell => cell.rect.x + cell.rect.width));
      const y = layout.cells[0].rect.y, height = layout.cells[0].rect.height;
      if (layout.cells.some(cell => cell.rect.y !== y || cell.rect.height !== height))
        issues.push('cells must share one lower-row y and height');
      if (xs[0] !== layout.band.x || right !== layout.band.x + layout.band.width ||
        y !== layout.band.y || height !== layout.band.height)
        issues.push('band must be the exact union of the owned cells');
      for (let index = 1; index < layout.cells.length; index += 1)
        if (layout.cells[index].rect.x !== layout.cells[index - 1].rect.x + layout.cells[index - 1].rect.width)
          issues.push('cells must be contiguous');
    }
  }
  return issues;
}

export function assertLayout(layout) {
  const issues = layoutIssues(layout);
  if (issues.length) throw protocolError('RECOVERY_LAYOUT_INVALID', 'invalid settled layout', issues);
  return layout;
}

export function queryIssues(message) {
  if (!isObject(message)) return ['layout-query must be an object'];
  const issues = [];
  if (message.v !== 1) issues.push('layout-query.v must be 1');
  if (message.kind !== 'layout-query') issues.push('layout-query.kind must be layout-query');
  issues.push(...scopeIssues(message.scope));
  if (!isText(message.commandId)) issues.push('layout-query.commandId must be a non-empty string');
  if (message.requestId !== undefined && !isText(message.requestId))
    issues.push('layout-query.requestId must be a non-empty string when present');
  return issues;
}

export function assertQuery(message) {
  const issues = queryIssues(message);
  if (issues.length) throw protocolError('RECOVERY_QUERY_INVALID', 'invalid layout query', issues);
  return message;
}

export function yieldIssues(message) {
  if (!isObject(message)) return ['yield must be an object'];
  const issues = [];
  if (message.v !== 1) issues.push('yield.v must be 1');
  if (message.kind !== 'yield') issues.push('yield.kind must be yield');
  issues.push(...scopeIssues(message.scope));
  if (!isText(message.commandId)) issues.push('yield.commandId must be a non-empty string');
  if (message.reason !== undefined && typeof message.reason !== 'string')
    issues.push('yield.reason must be a string when present');
  return issues;
}

export function resultIssues(message) {
  if (!isObject(message)) return ['result must be an object'];
  const issues = [];
  if (message.v !== 1) issues.push('result.v must be 1');
  if (message.kind !== 'result') issues.push('result.kind must be result');
  issues.push(...scopeIssues(message.scope));
  if (!isText(message.commandId)) issues.push('result.commandId must be a non-empty string');
  if (!RESULT_STATUSES.includes(message.status)) issues.push('result.status is not a known status');
  if (typeof message.fourPaneComplete !== 'boolean') issues.push('result.fourPaneComplete must be a boolean');
  if (!isObject(message.core)) issues.push('result.core must be an object');
  if (!isObject(message.collab)) issues.push('result.collab must be an object');
  return issues;
}

export function assertResult(message) {
  const issues = resultIssues(message);
  if (issues.length) throw protocolError('RECOVERY_RESULT_INVALID', 'invalid recovery result', issues);
  return message;
}

const clone = value => value === null || value === undefined ? value : structuredClone(value);

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

// One reconciliation at a time, at most one coalesced rerun queued, and a
// command id joins the waiter that already owns it while this lifetime lives.
// The coordinator is per controller lifetime; a new lifetime gets a new one.
export function createRecoveryCoordinator({ publish = () => {}, makeCommandId = randomUUID } = {}) {
  let passSeq = 0;
  let last = null;
  let active = null;
  let queued = null;
  const commands = new Map();

  function settle(scope, candidate, { commandId } = {}) {
    assertScope(scope);
    const id = commandId ?? makeCommandId();
    if (!isText(id)) throw protocolError('RECOVERY_COMMAND_INVALID', 'commandId must be a non-empty string');
    const message = {
      v: 1, kind: 'layout', scope: orderedScope(scope), commandId: id,
      passSeq: passSeq + 1, explicit: Boolean(candidate?.explicit),
      todo: candidate?.todo, workers: candidate?.workers, dag: candidate?.dag,
      band: clone(candidate?.band), cells: clone(candidate?.cells),
    };
    message.bindingRevision = bindingRevision(message);
    message.geometryRevision = geometryRevision(message);
    assertLayout(message);
    passSeq = message.passSeq;
    last = message;
    publish(message);
    return message;
  }

  function replay(scope) {
    return sameScope(scope, last?.scope) ? clone(last) : null;
  }

  function finish(entries, output) {
    for (const entry of entries) entry.resolve({ ...output, commandId: entry.commandId });
  }

  function start(entries) {
    const batch = entries;
    const intent = batch[batch.length - 1];
    const running = (async () => {
      try {
        const output = await intent.reconcile({ commandId: intent.commandId, scope: clone(intent.scope) });
        finish(batch, output ?? { status: 'waiting', layout: null });
      } catch (error) {
        for (const entry of batch) entry.reject(error);
      } finally {
        active = null;
        const next = queued;
        queued = null;
        if (next?.length) start(next);
      }
    })();
    active = running;
    return running;
  }

  function request({ commandId, scope, reconcile } = {}) {
    assertScope(scope);
    if (!isText(commandId)) throw protocolError('RECOVERY_COMMAND_INVALID', 'commandId must be a non-empty string');
    if (typeof reconcile !== 'function')
      throw protocolError('RECOVERY_COMMAND_INVALID', 'reconcile must be a function');
    const key = scopeKey(scope);
    const existing = commands.get(commandId);
    if (existing) {
      if (existing.key !== key)
        return Promise.reject(protocolError('RECOVERY_COMMAND_SCOPE_MISMATCH',
          'command id was already used by a different scope'));
      return existing.deferred.promise;
    }
    const waiter = deferred();
    const entry = { commandId, key, scope: clone(scope), reconcile, ...waiter };
    commands.set(commandId, { key, deferred: waiter });
    if (!active) {
      start([entry]);
    } else {
      queued ??= [];
      queued.push(entry);
    }
    return waiter.promise;
  }

  function inspect() {
    return { passSeq, last: clone(last), active: Boolean(active), queued: queued?.length ?? 0, commands: commands.size };
  }

  return { settle, replay, request, inspect };
}
