// OmO collaboration pane controller (in the OmO process). It records the
// coordination connection for the viewer and places one pane as the leftmost
// cell of the dashboard's lower row: collab | workers | DAG (v4: 28 | 28 | 30 of 86).
// Only Herdr CLI calls are made; no process-identity (PowerShell/WMI) query is
// ever started here, so no mutate path can spawn one.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJson } from '../../dag/src/storage.mjs';
import { shellCommand } from '../../dag/src/herdr.mjs';
import { VIEWER_HEARTBEAT_LIMIT_MS, inspectViewerProof, proofMismatch, readViewerProof, viewerProofPath } from './proof.mjs';
import { layoutIssues, resultIssues, sameScope, scopeKey, validScope, yieldIssues } from './recovery.mjs';
import { RECOVERY_V1 } from './recovery.mjs';
import { legacyCollabCommand, observeLegacyCollab } from '../../dag/src/controller.mjs';

export const API_KEY = Symbol.for('omo.agent-coordination.api.v1');
// The mod publishes its broker lazily through this accessor (its public-api getCoordinationBroker).
export const API_READY_KEY = Symbol.for('omo.agent-coordination.api-ready.v1');
// Owner-confirmed v4 widths of the lower row, measured on a 172x46 window.
export const LOWER_ROW = Object.freeze({ collab: 28, workers: 28, dag: 30 });
// The oracle-advisor extension's registration in this process (its REGISTRATION_KEY).
export const ADVISOR_KEY = Symbol.for('omo.oracle-advisor.v1');
// Advisor ledger events are coalesced into one status write per this window.
export const ADVISOR_WRITE_MS = 500;
// Per-tool bookkeeping entries of an active job; they are not advisor activity.
const ADVISOR_BOOKKEEPING = new Set(['trigger_state_recorded', 'progress_recorded']);

export const safeKey = value => String(value ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');

// Connection as this process sees it: the mod's public broker, the off switch,
// and the baseline the live adapter install was accepted against.
export async function connectionStatus({ host = globalThis, env = process.env, receiptPath } = {}) {
  let baseline = null;
  if (receiptPath) try {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    if (/^[0-9a-f]{64}$/i.test(receipt?.adapter?.baseline_sha256 ?? '')) baseline = receipt.adapter.baseline_sha256;
  } catch { /* unknown baseline */ }
  if (env.OMO_AGENT_COORDINATION === '0') return { state: 'disabled', protocol: null, baseline };
  let broker = host[API_KEY];
  if (!broker && typeof host[API_READY_KEY] === 'function') try { broker = host[API_READY_KEY](); } catch { broker = undefined; }
  if (broker && typeof broker === 'object' && broker.version === 1 && typeof broker.getClient === 'function')
    return { state: 'connected', protocol: `api v${broker.version}`, baseline };
  return { state: 'no-carrier', protocol: null, baseline };
}

// This session's advisor job as the oracle-advisor extension in this process holds it:
// each pane shows its own session's job, not the newest job of any session.
export function advisorSummary(host = globalThis, last = null) {
  const registration = host[ADVISOR_KEY];
  if (registration?.disabled) return { state: 'off', consults: 0, stops: 0, last: null };
  let job = null;
  try {
    const runtime = registration?.runtime;
    if (runtime?.getSessionStatus?.() === 'lead') job = runtime.ledger?.jobFacts ?? null;
  } catch { job = null; }
  if (!job) return { state: 'none', consults: 0, stops: 0, last: null };
  return { state: job.status === 'active' ? 'on' : 'off', job: job.job_id ?? null,
    consults: job.counters?.consults ?? 0,
    stops: Object.values(job.stops ?? {}).filter(stop => stop?.status === 'open').length,
    last: last ?? job.opened_at ?? null };
}

// Widths for a lower row of `total` columns, scaled from the measured 28|28|30.
export function lowerRowWidths(total) {
  const sum = LOWER_ROW.collab + LOWER_ROW.workers + LOWER_ROW.dag;
  const collab = Math.round(total * LOWER_ROW.collab / sum);
  return { collab, workers: collab, dag: total - 2 * collab };
}

// The dashboard's lower row: workers immediately left of the DAG, same top and height.
export function lowerRow(layout, ids) {
  const rect = id => layout?.panes?.find(pane => pane?.pane_id === id)?.rect;
  const workers = rect(ids.workers), dag = rect(ids.dag);
  if (!workers || !dag || workers.y !== dag.y || workers.height !== dag.height || workers.x + workers.width !== dag.x) return null;
  return { workers, dag, total: workers.width + dag.width };
}

// A settled message without a Collab cell reports the core lower band. The
// measured 28|28|30 rule is applied to that full band width, so Collab is
// carved from the existing row rather than added on top of it. Once a Collab
// cell is present, its width still comes from the full band.width, never the
// Workers+DAG subtotal.
export function bandWidths(band) {
  return Number.isSafeInteger(band?.width) && band.width > 0 ? lowerRowWidths(band.width) : null;
}

const sameWidths = (left, right) => Boolean(left && right) && left.collab === right.collab &&
  left.workers === right.workers && left.dag === right.dag;
const layoutMeta = message => ({ commandId: message.commandId, passSeq: message.passSeq,
  bindingRevision: message.bindingRevision, geometryRevision: message.geometryRevision });

// --- Collab v2 lifecycle -----------------------------------------------------
// The controller owns <recordFile>; the viewer owns <recordFile>.viewer.json.
// Neither process ever writes the other's file. A pane that exists (a shell)
// proves nothing about its viewer: only a matching first-paint proof does.
export { VIEWER_HEARTBEAT_LIMIT_MS, VIEWER_PROOF_SUFFIX, inspectViewerProof, proofMismatch,
  viewerProofPath } from './proof.mjs';

const SCOPE_KEYS = ['ownerKey', 'sessionId', 'lifetimeId', 'scopeEpoch', 'generation', 'tabId'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const recordIdentity = record => record ? createHash('sha256').update(JSON.stringify(record)).digest('hex') : null;
const sameScopeTuple = (a, b) => Boolean(a && b) && SCOPE_KEYS.every(key =>
  key === 'generation' || key === 'scopeEpoch'
    ? String(a[key] ?? null) === String(b[key] ?? null)
    : a[key] === b[key]);
const recordBinding = record => ({
  workers: record?.workers ?? null,
  dag: record?.dag ?? null,
  revision: record?.revisions?.binding ?? record?.binding?.revision ?? null,
});
const sameBinding = (a, b) => Boolean(a && b) && a.workers === b.workers && a.dag === b.dag &&
  a.revision === b.revision;

// Stable binding identity: changes only for scope or exact core-pane identity,
// never for a rectangle-only change (a resize keeps the same launch).
export function bindingRevision(scope, { workers, dag } = {}) {
  return digest([...(SCOPE_KEYS.map(key => scope?.[key] ?? null)), workers ?? null, dag ?? null]);
}

export function geometryRevision(paneId, rect) {
  return paneId && rect ? digest([paneId, rect]) : null;
}

const ownerIntentMatches = (record, proof) => {
  const intent = proof?.ownerClose;
  if (!intent || intent.reason !== 'owner-close') return false;
  if (intent.launchToken !== record?.launch?.token || intent.pane !== record?.paneId) return false;
  if (intent.bindingRevision !== (record?.revisions?.binding ?? record?.binding?.revision ?? null)) return false;
  if (intent.sessionId !== record?.scope?.sessionId || intent.lifetimeId !== record?.scope?.lifetimeId) return false;
  return proofMismatch(record, proof) === null;
};
// Readiness is a proof verdict, never a placement verdict. Legacy v1 records
// remain readable but have no launch token, so they are explicitly unproven.

export class CoordinationPane {
  constructor({ stateDir, dagStateDir, receiptPath, activityPath, parentPane, sessionId, cwd,
    herdr, node, viewer, language = 'en', host = globalThis, env = process.env,
    events = null, inspectLegacyCollab, legacyCollabCache = new Map(),
    timers = { setTimeout, clearTimeout },
    fileSystem = { closeSync, existsSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync },
    ownerKey = null, lifetimeId = null, generation = null, scopeEpoch = null, now = () => Date.now(),
    heartbeatMs = VIEWER_HEARTBEAT_LIMIT_MS, launchToken = randomUUID }) {
    Object.assign(this, { stateDir, dagStateDir, receiptPath, activityPath, parentPane, sessionId, cwd,
      herdr, node, viewer, language, host, env, events, inspectLegacyCollab, legacyCollabCache,
      timers, fileSystem,
      ownerKey, lifetimeId, generation, scopeEpoch, now, heartbeatMs });
    this.newLaunchToken = launchToken;
    this.advisorLast = null;
    // The status record is refreshed on startup and on post-bind lifecycle
    // events. Its timestamp is not semantic, so an unchanged snapshot is not
    // rewritten; statusWrites counts real file replacements for tests.
    this.lastStatus = null;
    this.statusWrites = 0;
    this.statusFile = join(stateDir, `${safeKey(parentPane)}.status.json`);
    this.recordFile = join(stateDir, `${safeKey(parentPane)}.pane.json`);
    this.stopped = false;
    this.state = 'waiting';
    // Event-driven placement state. There is no startup attempt loop, timer or
    // global scheduler: one settled layout event drives one ensure, and events
    // arriving while it runs collapse into one latest-layout rerun.
    this.scope = null;
    this.queuedLayout = null;
    this.ensureRunning = null;
    this.passSeqs = new Map();
    this.collabCurrent = false;
    this.geometryCurrent = false;
    this.band = null;
    this.cells = null;
    this.yieldRunning = null;
  }
  async writeStatus(override) {
    const status = override ?? await connectionStatus({ host: this.host, env: this.env, receiptPath: this.receiptPath });
    const record = { v: 1, ...status, advisor: advisorSummary(this.host, this.advisorLast),
      sessionId: this.sessionId, parentPaneId: this.parentPane, pid: process.pid, at: new Date().toISOString() };
    // `at` only records when this snapshot was written, so two polls of the
    // same carrier state are one write, not a stream of byte changes.
    const comparable = JSON.stringify({ ...record, at: null });
    if (comparable === this.lastStatus) return status;
    await writeJson(this.statusFile, record);
    this.lastStatus = comparable;
    this.statusWrites += 1;
    return status;
  }
  // Advisor ledger events rewrite the status file (coalesced) so the pane follows this
  // session's job. The listener runs inside the advisor's own append: it only sets a timer
  // and never throws.
  watchAdvisor() {
    const ledger = this.host[ADVISOR_KEY]?.runtime?.ledger;
    if (this.unwatchAdvisor || typeof ledger?.subscribe !== 'function') return;
    this.unwatchAdvisor = ledger.subscribe(event => {
      try {
        if (this.stopped) return;
        if (!ADVISOR_BOOKKEEPING.has(event?.type)) this.advisorLast = new Date().toISOString();
        if (this.advisorTimer) return;
        // The returned promise is ignored by real timers; tests await it.
        this.advisorTimer = this.timers.setTimeout(() => {
          this.advisorTimer = undefined;
          return this.stopped ? undefined : this.writeStatus().catch(() => {});
        }, ADVISOR_WRITE_MS);
      } catch { /* the pane is advisory; the advisor's append must not fail */ }
    });
  }
  async start() {
    await this.writeStatus();
    this.watchAdvisor();
    // A stored-launch owner close is recovered before any cold-start
    // classification, even when this controller did not witness the close
    // and even if the previous controller died.
    await this.consumeOwnerClose();
    if (this.env.OMO_HERDR_COORDINATION_PANE === '0') { this.state = 'disabled'; return; }
    // Placement is driven by a current settled layout, not by a startup poll.
    // The extension subscribes first, then asks the core to replay its last
    // settled snapshot so a late listener cannot miss the sole notification.
    this.state = 'waiting-layout';
  }
  async stop() {
    this.stopped = true;
    if (this.advisorTimer) this.timers.clearTimeout(this.advisorTimer);
    this.unwatchAdvisor?.();
    this.unwatchAdvisor = undefined;
    try { await this.writeStatus({ state: 'closed', protocol: null, baseline: (await readJson(this.statusFile).catch(() => null))?.baseline ?? null }); }
    catch { /* the viewer shows the last state */ }
  }
  stamp() { return new Date(this.now()).toISOString(); }
  scopeFor(tabId) {
    if (this.scope) return { ...this.scope, tabId: tabId ?? this.scope.tabId };
    return { ownerKey: this.ownerKey ?? null, sessionId: this.sessionId ?? null,
      lifetimeId: this.lifetimeId ?? null, scopeEpoch: this.scopeEpoch ?? null,
      generation: this.generation ?? null, tabId: tabId ?? null };
  }
  // The core is the scope authority. A settled layout is accepted only for this
  // conversation's session; its exact owner/lifetime/epoch/generation/tab scope
  // is then used for every record, proof and mutation.
  adoptScope(scope) {
    if (!validScope(scope)) throw new Error('collab recovery scope is invalid');
    this.scope = { ...scope };
    return this.scope;
  }
  // The owner/session/tab are the controller's pinned custody identity. A
  // lifetime/epoch/generation change may be a legitimate core restart, but a
  // different owner or tab is foreign and can never authorize an effect.
  recordScopeMatches(record) {
    const scope = this.scope;
    if (!record?.scope || !scope) return false;
    if (record.parentPaneId !== undefined && record.parentPaneId !== this.parentPane) return false;
    if (record.tabId !== undefined && record.tabId !== scope.tabId) return false;
    return record.scope.ownerKey === scope.ownerKey &&
      record.scope.sessionId === scope.sessionId &&
      record.scope.tabId === scope.tabId;
  }
  ownsPinnedScope(scope) {
    if (!this.scope) return true;
    return scope.ownerKey === this.scope.ownerKey && scope.sessionId === this.scope.sessionId &&
      scope.tabId === this.scope.tabId;
  }
  // Readiness reads both files but writes neither. A live pane is not a viewer.
  async viewerStatus() {
    const record = await readJson(this.recordFile).catch(() => null);
    const proof = record ? readViewerProof(this.recordFile) : null;
    return inspectViewerProof(record, proof, { now: this.now(), heartbeatMs: this.heartbeatMs });
  }
  // Consume the viewer's own exact identity into the controller record. Only the
  // controller writes this file; only the viewer writes the sidecar.
  async observeViewer() {
    const status = await this.viewerStatus();
    const { record, proof } = status;
    if (!record || !proof || proofMismatch(record, proof)) return status;
    const identity = { paneId: record.paneId, shellPid: proof.viewer?.parentPid ?? null,
      viewerPid: proof.viewer?.pid ?? null, viewerStartedAt: proof.viewer?.startedAt ?? null };
    const current = record.identity ?? {};
    if (current.paneId === identity.paneId && current.shellPid === identity.shellPid &&
      current.viewerPid === identity.viewerPid && current.viewerStartedAt === identity.viewerStartedAt) return status;
    const next = { ...record, identity };
    if (!(await this.commitRecord(next, record.launch?.token ?? null))) return this.viewerStatus();
    return { ...status, record: next };
  }
  // An explicit q/Ctrl-C intent is launch-scoped proof, not a heuristic. Match
  // the exact stored launch/scope/binding/pane before mirroring manualClose.
  // A v1 record stores no launch token and therefore cannot authorize a close.
  async consumeOwnerClose() {
    const record = await readJson(this.recordFile).catch(() => null);
    if (!record || record.v !== 2 || typeof record.launch?.token !== 'string') return null;
    if (record.sessionId !== this.sessionId) return null;
    const proof = readViewerProof(this.recordFile);
    if (!ownerIntentMatches(record, proof)) return null;
    if (!(proof.viewer?.pid >= 1) || !Number.isFinite(Date.parse(proof.viewer?.startedAt ?? ''))) return null;
    // A fresh explicit command that already overrode this exact older intent
    // leaves the durable sidecar in place; it must not re-suppress the repair.
    const overriddenAt = Date.parse(record.closure?.overriddenAt ?? '');
    const intentAt = Date.parse(proof.ownerClose.at);
    if (Number.isFinite(overriddenAt) && (!Number.isFinite(intentAt) || intentAt <= overriddenAt)) return null;
    // Authority is the exact launch-scoped intent, not liveness: a heartbeat is
    // never close authority. The intent stays durable so a later startup can
    // recover it even when the prior controller died.
    const at = proof.ownerClose.at;
    const closure = { reason: 'owner-close', at, launchToken: record.launch.token,
      sessionId: record.sessionId ?? null, lifetimeId: record.scope?.lifetimeId ?? null };
    if (record.manualClose === true && record.phase === 'closed' && record.closure?.reason === 'owner-close' &&
      record.closure?.at === at && record.pendingEffect === null) return record;
    const next = { ...record, phase: 'closed', manualClose: true, closure, pendingEffect: null };
    await writeJson(this.recordFile, next);
    return next;
  }
  // Every controller commit re-reads the durable record and a matching viewer
  // intent immediately before writing. A newer applicable close wins over an
  // older repair snapshot; a different-session close is not applicable.
  async commitRecord(next, ownedLaunchToken = null) {
    const current = await readJson(this.recordFile).catch(() => null);
    const applicable = Boolean(current) && (current.sessionId === this.sessionId ||
      (ownedLaunchToken !== null && (current.launch?.token ?? null) === ownedLaunchToken));
    if (current?.manualClose === true) return false;
    if (applicable && current.v === 2) {
      const proof = readViewerProof(this.recordFile);
      if (proof?.ownerClose?.reason === 'owner-close' && !proofMismatch(current, proof) &&
        proof.ownerClose.launchToken === current.launch?.token && proof.ownerClose.pane === current.paneId) {
        const consumed = await this.consumeOwnerClose();
        if (consumed?.manualClose === true) return false;
      }
    }
    await writeJson(this.recordFile, next);
    return true;
  }
  // Compare-and-swap over the durable record. Retirement must never overwrite
  // a record that a foreign writer replaced or updated after capture.
  async commitRecordIfUnchanged(next, expected, ownedLaunchToken = null) {
    const current = await readJson(this.recordFile).catch(() => null);
    if (!current || recordIdentity(current) !== expected) return false;
    if (current.manualClose === true) return false;
    if (!this.recordScopeMatches(current)) return false;
    const applicable = current.sessionId === this.sessionId ||
      (ownedLaunchToken !== null && (current.launch?.token ?? null) === ownedLaunchToken);
    if (applicable && current.v === 2) {
      const proof = readViewerProof(this.recordFile);
      if (proof?.ownerClose?.reason === 'owner-close' && !proofMismatch(current, proof) &&
        proof.ownerClose.launchToken === current.launch?.token && proof.ownerClose.pane === current.paneId) {
        const consumed = await this.consumeOwnerClose();
        if (consumed?.manualClose === true) return false;
      }
    }
    return this.commitRecordWrite(next, expected);
  }
  // Conditional durable write. A lock serializes this controller's own
  // read-check-replace sequence; the temp/backup/link sequence keeps a foreign
  // record that appears between the identity check and the replacement.
  commitRecordWrite(next, expected) {
    const io = this.fileSystem;
    const lock = this.recordFile + '.lock';
    const token = randomUUID();
    const temp = this.recordFile + '.' + token + '.tmp';
    const backup = this.recordFile + '.' + token + '.bak';
    const nextIdentity = recordIdentity(next);
    let lockFd = null, locked = false, keepBackup = false;
    try {
      lockFd = io.openSync(lock, 'wx');
      locked = true;
      const read = () => JSON.parse(io.readFileSync(this.recordFile, 'utf8'));
      let current;
      try { current = read(); } catch { return false; }
      if (recordIdentity(current) !== expected) return false;
      if (!this.recordScopeMatches(current)) return false;
      io.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
      // Re-read immediately before replacing the durable path.
      try { current = read(); } catch { return false; }
      if (recordIdentity(current) !== expected) return false;
      io.renameSync(this.recordFile, backup);
      let moved = null;
      try { moved = JSON.parse(io.readFileSync(backup, 'utf8')); } catch { moved = null; }
      if (!moved || recordIdentity(moved) !== expected) {
        // The record moved aside is not the captured one. Put it back only if
        // the durable path is still free, with an exclusive create so a newer
        // foreign record at the restore boundary is never overwritten.
        try {
          io.writeFileSync(this.recordFile, io.readFileSync(backup, 'utf8'),
            { flag: 'wx', mode: 0o600 });
        } catch {
          // A newer record holds the path. Keep it and discard the older copy;
          // if the path is unexpectedly absent, retain the only copy.
          keepBackup = !io.existsSync(this.recordFile);
        }
        return false;
      }
      try { io.linkSync(temp, this.recordFile); }
      catch {
        // A foreign writer created the record after the rename; keep it.
        return false;
      }
      let landed = null;
      try { landed = JSON.parse(io.readFileSync(this.recordFile, 'utf8')); } catch { landed = null; }
      return Boolean(landed) && recordIdentity(landed) === nextIdentity &&
        sameScopeTuple(landed.scope, next.scope);
    } catch { return false; }
    finally {
      if (locked) {
        try { io.closeSync(lockFd); } catch { /* already closed */ }
        try { io.unlinkSync(lock); } catch { /* already gone */ }
      }
      try { io.unlinkSync(temp); } catch { /* already linked/removed */ }
      if (!keepBackup) try { io.unlinkSync(backup); } catch { /* already restored/removed */ }
    }
  }
  // Expired-run retirement is a single custody decision point. The captured
  // record identity is compared after the native revalidation, immediately
  // before journaling and again immediately before the close. Any foreign
  // replacement/update aborts without writing or closing.
  async commitRetirement(record, expected, message) {
    const capturedOwnerIntent = readViewerProof(this.recordFile)?.ownerClose ?? null;
    if (!this.recordScopeMatches(record) || !sameScopeTuple(record.scope, message.scope) ||
      !sameScopeTuple(record.scope, this.scope)) { this.state = 'foreign-scope'; return null; }
    if (!(await this.revalidate(message, { collab: record.paneId }))) {
      this.state = 'stale-layout';
      return null;
    }
    let current = await readJson(this.recordFile).catch(() => null);
    if (!current || recordIdentity(current) !== expected ||
      !this.recordScopeMatches(current) || !sameScopeTuple(current.scope, record.scope) ||
      current.paneId !== record.paneId ||
      (current.launch?.token ?? null) !== (record.launch?.token ?? null)) {
      this.state = 'foreign-scope';
      return null;
    }
    const at = this.stamp();
    const retired = { ...current, phase: 'retiring',
      pendingEffect: { kind: 'close', at, launchToken: current.launch?.token ?? null,
        paneId: current.paneId, reason: 'retirement' } };
    if (!(await this.commitRecordIfUnchanged(retired, expected, current.launch?.token ?? null))) {
      this.state = 'foreign-scope';
      return null;
    }
    let after = await readJson(this.recordFile).catch(() => null);
    if (!after || after.phase !== 'retiring' || after.pendingEffect?.kind !== 'close' ||
      after.pendingEffect?.paneId !== record.paneId ||
      (after.launch?.token ?? null) !== (record.launch?.token ?? null) ||
      !this.recordScopeMatches(after) || !sameScopeTuple(after.scope, record.scope) ||
      !sameScopeTuple(this.scope, record.scope) ||
      recordIdentity(after) !== recordIdentity(retired) ||
      !sameBinding(recordBinding(after), recordBinding(retired))) {
      this.state = 'foreign-scope';
      return null;
    }
    if (!(await this.revalidate(message, { collab: record.paneId }))) {
      this.state = 'stale-layout';
      return null;
    }
    after = await readJson(this.recordFile).catch(() => null);
    if (!after || after.phase !== 'retiring' || after.pendingEffect?.kind !== 'close' ||
      after.pendingEffect?.paneId !== record.paneId ||
      (after.launch?.token ?? null) !== (record.launch?.token ?? null) ||
      !this.recordScopeMatches(after) || !sameScopeTuple(after.scope, record.scope) ||
      !sameScopeTuple(this.scope, record.scope) ||
      recordIdentity(after) !== recordIdentity(retired) ||
      !sameBinding(recordBinding(after), recordBinding(retired))) {
      this.state = 'foreign-scope';
      return null;
    }
    const finalProof = readViewerProof(this.recordFile);
    const ownerClose = finalProof?.ownerClose;
    const newerOwnerClose = ownerClose && (capturedOwnerIntent === null ||
      ownerClose.at !== capturedOwnerIntent.at ||
      ownerClose.launchToken !== capturedOwnerIntent.launchToken ||
      ownerClose.pane !== capturedOwnerIntent.pane);
    if (newerOwnerClose && ownerIntentMatches(after, finalProof)) {
      // The close the owner actually requested wins only when it is exact and
      // fresh. A rejected, already-overridden or otherwise non-applicable
      // intent must not suppress this independently valid retirement.
      const consumed = await this.consumeOwnerClose();
      if (consumed?.manualClose === true && consumed.phase === 'closed') {
        this.state = 'owner-closed';
        return null;
      }
    }
    return retired;
  }
  // One settled layout event at a time. A burst collapses to its latest event,
  // and a duplicate/stale passSeq never becomes a second reconciliation.
  async acceptLayout(message) {
    if (this.stopped) return this.status();
    // Environment-off is terminal for every path, including an explicit
    // restore. No split/run/close can be issued while the controller is off.
    if (this.env?.OMO_HERDR_COORDINATION_PANE === '0') { this.state = 'disabled'; return this.status(); }
    const issues = layoutIssues(message);
    if (issues.length) {
      this.lastError = issues.join('; ');
      this.state = 'invalid-layout';
      return this.status();
    }
    if (this.sessionId && message.scope.sessionId !== this.sessionId) {
      this.state = 'foreign-scope';
      return this.status();
    }
    if (!this.ownsPinnedScope(message.scope)) {
      this.state = 'foreign-scope';
      return this.status();
    }
    if (!this.scope) this.scope = { ...message.scope };
    const key = scopeKey(message.scope);
    const seen = this.passSeqs.get(key) ?? 0;
    if (message.passSeq <= seen) return this.status();
    this.passSeqs.set(key, message.passSeq);
    // A request's ordering starts when it is accepted, not when a coalesced
    // pass later reaches it. Capture the close intent visible at acceptance.
    const acceptedAt = this.now();
    const closeSnapshot = readJson(this.recordFile).catch(() => null);
    this.queuedLayout = { message, acceptedAt, closeSnapshot };
    if (this.ensureRunning) return this.ensureRunning;
    this.ensureRunning = this.runQueue().finally(() => { this.ensureRunning = null; });
    return this.ensureRunning;
  }
  async runQueue() {
    let result;
    while (this.queuedLayout && !this.stopped) {
      const item = this.queuedLayout;
      this.queuedLayout = null;
      try {
        const current = await item.closeSnapshot;
        const acceptedCloseAt = current?.manualClose === true ? (current.closure?.at ?? null) : null;
        result = await this.ensure(item.message, { acceptedAt: item.acceptedAt, acceptedCloseAt });
      }
      catch (error) { this.lastError = error?.message ?? String(error); this.state = 'error'; }
    }
    return result ?? this.status();
  }
  async idle() {
    while (this.ensureRunning) await this.ensureRunning.catch(() => {});
    return this.status();
  }
  // Readiness is a proof verdict, never a placement verdict.
  async status() {
    const viewer = await this.viewerStatus().catch(() => ({ ready: false, state: 'no-record', record: null, proof: null }));
    const record = viewer.record ?? null;
    const pendingEffect = record?.pendingEffect ?? null;
    const current = Boolean(viewer.ready === true && this.geometryCurrent && !pendingEffect &&
      record?.manualClose !== true);
    this.collabCurrent = current;
    return { state: this.state, ready: current, collabCurrent: current, viewerState: viewer.state,
      record, pendingEffect, scope: this.scope, band: this.band, cells: this.cells,
      firstPaintSeq: viewer.firstPaintSeq ?? null };
  }
  async observeLayout() {
    try {
      const layout = (await this.herdr('layout', '--pane', this.parentPane))?.layout;
      return Array.isArray(layout?.panes) ? layout : null;
    } catch { return null; }
  }
  // Exact current custody and live-row check before a mutation. It does not
  // enumerate role directories: the settled event supplied the exact IDs.
  async revalidate(message, { collab = null } = {}) {
    const layout = await this.observeLayout();
    if (!layout || layout.tab_id !== message.scope.tabId) return null;
    const ids = new Set(layout.panes.map(pane => pane?.pane_id));
    if (!ids.has(this.parentPane) || !ids.has(message.workers) || !ids.has(message.dag)) return null;
    if (collab && !ids.has(collab)) return null;
    const workers = layout.panes.find(pane => pane?.pane_id === message.workers)?.rect;
    const dag = layout.panes.find(pane => pane?.pane_id === message.dag)?.rect;
    if (!workers || !dag || workers.y !== dag.y || workers.height !== dag.height ||
      workers.x + workers.width !== dag.x) return null;
    return layout;
  }
  layoutFromObservation(message, layout) {
    const lower = this.bandFromPanes(layout, { workers: message.workers, dag: message.dag });
    return lower ? { ...message, band: lower.band, cells: lower.cells } : null;
  }
  // --- scoped Collab yield (todo 6b) -----------------------------------------
  // One in-flight yield at a time. The DAG may coalesce, but two deliveries can
  // never close the same pane twice or interleave their record commits.
  acceptYield(message) {
    const run = (this.yieldRunning ?? Promise.resolve()).catch(() => {})
      .then(() => this.handleYield(message));
    this.yieldRunning = run;
    return run.finally(() => { if (this.yieldRunning === run) this.yieldRunning = null; });
  }
  // A rejection is a truthful wait: the pane and the durable record stay as
  // they were. A same-scope wait is published so the core waiter re-reads the
  // native row and decides again; a foreign scope is not echoed.
  yieldWaiting(message, state, paneId = null) {
    this.state = state;
    const result = message && validScope(message.scope) && this.scope && sameScope(message.scope, this.scope)
      ? this.publishYieldResult(message, { status: 'waiting', paneId })
      : null;
    return { state, status: 'waiting', waiting: true, commandId: message?.commandId ?? null,
      paneId, result };
  }
  publishYieldResult(message, { status, paneId, workers = null, dag = null, band = null, cells = null } = {}) {
    if (!message || !validScope(message.scope)) return null;
    const result = { v: 1, kind: 'result', scope: { ...message.scope }, commandId: message.commandId,
      status, fourPaneComplete: false,
      core: { ready: false, workers, dag, ...(band ? { band } : {}), ...(cells ? { cells } : {}) },
      collab: { current: false, paneId: paneId ?? null, yielded: status === 'settled' } };
    if (resultIssues(result).length) return null;
    try { this.events?.emit?.(RECOVERY_V1.result, result); }
    catch { return null; }
    return result;
  }
  // v1 has no launch token: the proof supplied with the yield must name the
  // exact legacy viewer argv for this record/path/locale. When an equivalent
  // injected process inspector is available (tests, non-Windows), the proof is
  // re-derived with fresh:true and every identity field is compared. Otherwise
  // the fresh Herdr process-info check below is the pre-close revalidation; no
  // PowerShell/WMI query is ever started from this controller.
  async proveLegacyYield(record, proof) {
    if (!proof || typeof proof !== 'object' || proof.v !== 1) return 'yield-proof-missing';
    if (proof.paneId !== record.paneId) return 'yield-pane-mismatch';
    if (proof.parentPaneId !== this.parentPane || proof.sessionId !== this.sessionId ||
      proof.tabId !== this.scope?.tabId) return 'yield-scope-mismatch';
    if (!Number.isFinite(Date.parse(record.createdAt ?? '')) || proof.createdAt !== record.createdAt)
      return 'yield-proof-stale';
    if (proof.language !== this.language) return 'yield-language-mismatch';
    if (!Number.isSafeInteger(proof.shellPid) || proof.shellPid < 1 ||
      !Number.isSafeInteger(proof.viewerPid) || proof.viewerPid < 1 ||
      proof.shellPid === proof.viewerPid ||
      !/^[1-9]\d*$/.test(String(proof.shellBirth ?? '')) ||
      !/^[1-9]\d*$/.test(String(proof.viewerBirth ?? ''))) return 'yield-proof-identity';
    const expected = legacyCollabCommand(record, { record: this.recordFile, status: this.statusFile,
      activity: this.activityPath }, this.language);
    const sameArgv = value => Array.isArray(value) && Array.isArray(expected) &&
      value.length === expected.length && value.every((item, index) => item === expected[index]);
    if (!sameArgv(proof.expected) || !sameArgv(proof.argv) ||
      !/^[0-9a-f]{64}$/.test(proof.argvDigest ?? '')) return 'yield-proof-argv';
    if (typeof this.inspectLegacyCollab === 'function') {
      let info = null;
      try { info = await this.herdr('process-info', '--pane', record.paneId); } catch { info = null; }
      if (!info) return 'yield-native-unavailable';
      let fresh = null;
      try {
        fresh = await observeLegacyCollab(info, record, { parentPane: this.parentPane,
          sessionId: this.sessionId, tabId: this.scope.tabId, stateDir: this.stateDir,
          recordPath: this.recordFile, statusPath: this.statusFile, activityPath: this.activityPath,
          language: this.language, lifetimeId: this.scope.lifetimeId, cache: this.legacyCollabCache,
          fresh: true }, this.inspectLegacyCollab);
      } catch { fresh = null; }
      if (!fresh) return 'yield-proof-unconfirmed';
      const keys = ['paneId', 'parentPaneId', 'sessionId', 'tabId', 'createdAt', 'shellPid',
        'shellBirth', 'viewerPid', 'viewerBirth', 'language', 'argvDigest'];
      if (keys.some(key => fresh[key] !== proof[key]) ||
        JSON.stringify(fresh.argv) !== JSON.stringify(proof.argv)) return 'yield-proof-changed';
    }
    return null;
  }
  // The immediate pre-close native check. It uses Herdr layout/process-info
  // only: the pane, shell pid and foreground viewer pid/argv must still agree
  // with the proof that authorized the effect.
  async recheckYieldNative(record, proof) {
    const scope = this.scope;
    if (!validScope(scope)) return { ok: false, state: 'yield-no-scope' };
    if (record.v === 2 && (!record.scope || !sameScope(record.scope, scope)))
      return { ok: false, state: 'yield-scope-mismatch' };
    const layout = await this.observeLayout();
    if (!layout || layout.tab_id !== scope.tabId) return { ok: false, state: 'yield-stale-tab' };
    if (!layout.panes?.some(pane => pane?.pane_id === record.paneId))
      return { ok: false, state: 'yield-pane-absent' };
    let info = null;
    try { info = await this.herdr('process-info', '--pane', record.paneId); } catch { info = null; }
    const details = info?.process_info;
    if (!details) return { ok: false, state: 'yield-native-unavailable' };
    if (details.pane_id !== undefined && details.pane_id !== record.paneId)
      return { ok: false, state: 'yield-pane-mismatch' };
    if (!Number.isSafeInteger(details.shell_pid) || details.shell_pid < 1)
      return { ok: false, state: 'yield-shell-missing' };
    const foreground = details.foreground_processes;
    if (!Array.isArray(foreground) || foreground.length !== 1)
      return { ok: false, state: 'yield-foreground-ambiguous' };
    const row = foreground[0];
    if (record.v === 1) {
      if (!proof) return { ok: false, state: 'yield-proof-missing' };
      if (details.shell_pid !== proof.shellPid) return { ok: false, state: 'yield-shell-changed' };
      // A shell-only foreground report cannot prove the Node child identity or
      // its argv. The pre-close read must name the exact child; a missing,
      // ambiguous or foreign child aborts with zero closes.
      if (row?.pid !== proof.viewerPid) return { ok: false, state: 'yield-child-missing' };
      const argv = row.argv;
      if (!Array.isArray(argv) || argv.length !== proof.argv.length + 1 ||
        !/^(node|node\.exe|nodejs|nodejs\.exe)$/i.test(String(argv[0] ?? '').split(/[\\/]/).pop()) ||
        argv.slice(1).some((value, index) => value !== proof.argv[index]))
        return { ok: false, state: 'yield-child-changed' };
    } else {
      const shellPid = record.identity?.shellPid ?? proof?.viewer?.parentPid;
      const viewerPid = record.identity?.viewerPid ?? proof?.viewer?.pid;
      if (!Number.isSafeInteger(shellPid) || shellPid < 1)
        return { ok: false, state: 'yield-shell-missing' };
      if (details.shell_pid !== shellPid) return { ok: false, state: 'yield-shell-changed' };
      if (!Number.isSafeInteger(viewerPid) || viewerPid < 1 ||
        (row?.pid !== viewerPid && row?.pid !== shellPid))
        return { ok: false, state: 'yield-viewer-changed' };
    }
    return { ok: true, layout };
  }
  // A layout answers only for this session's parent pane. A different tab (or
  // a listing without that anchor) is not evidence about the owned pane, even
  // when the old pane id is absent there.
  sameTabLayout(layout, tabId) {
    return Boolean(layout && tabId && layout.tab_id === tabId && Array.isArray(layout.panes) &&
      layout.panes.some(pane => pane?.pane_id === this.parentPane));
  }
  async commitYield(next, expected, current) {
    if (current.v === 2)
      return this.commitRecordIfUnchanged(next, expected, current.launch?.token ?? null);
    const durable = await readJson(this.recordFile).catch(() => null);
    if (!durable || recordIdentity(durable) !== expected || durable.manualClose === true ||
      durable.v !== 1 || durable.paneId !== current.paneId ||
      durable.parentPaneId !== this.parentPane || durable.sessionId !== this.sessionId ||
      durable.tabId !== current.tabId) return false;
    await writeJson(this.recordFile, next);
    return true;
  }
  async handleYield(message) {
    if (this.stopped) return { state: 'stopped', status: 'waiting', waiting: true };
    if (this.env?.OMO_HERDR_COORDINATION_PANE === '0') {
      this.state = 'disabled';
      return { state: 'disabled', status: 'waiting', waiting: true };
    }
    const issues = yieldIssues(message);
    if (issues.length) {
      this.lastError = issues.join('; ');
      this.state = 'invalid-yield';
      return { state: 'invalid-yield', status: 'waiting', waiting: true,
        commandId: message?.commandId ?? null };
    }
    if (!validScope(this.scope) || !sameScope(message.scope, this.scope) ||
      !this.ownsPinnedScope(message.scope) ||
      (this.sessionId && message.scope.sessionId !== this.sessionId))
      return this.yieldWaiting(message, 'foreign-scope', message.paneId ?? null);
    if (typeof message.paneId !== 'string' || !message.paneId)
      return this.yieldWaiting(message, 'yield-pane-invalid');
    const record = await readJson(this.recordFile).catch(() => null);
    if (!record || record.manualClose === true || record.paneId !== message.paneId)
      return this.yieldWaiting(message, 'yield-record-mismatch', message.paneId);
    if (record.v !== 1 && record.v !== 2)
      return this.yieldWaiting(message, 'yield-record-version', record.paneId);
    const scoped = record.v === 1
      ? record.parentPaneId === this.parentPane && record.sessionId === this.sessionId &&
        record.tabId === message.scope.tabId
      : this.recordScopeMatches(record) && sameScope(record.scope, message.scope);
    if (!scoped) return this.yieldWaiting(message, 'yield-record-mismatch', record.paneId);
    if (record.pendingEffect)
      return this.yieldWaiting(message, 'yield-effect-pending', record.paneId);
    const expected = recordIdentity(record);

    let proof = null;
    if (record.v === 1) {
      const proofState = await this.proveLegacyYield(record, message.legacyProof);
      if (proofState) return this.yieldWaiting(message, proofState, record.paneId);
      proof = message.legacyProof;
    } else {
      const viewer = await this.viewerStatus();
      if (viewer.ready !== true || viewer.record?.paneId !== record.paneId)
        return this.yieldWaiting(message, viewer.state === 'current' ? 'yield-viewer-unproven' : viewer.state,
          record.paneId);
      proof = viewer.proof;
    }

    let native = await this.recheckYieldNative(record, proof);
    if (!native.ok) return this.yieldWaiting(message, native.state, record.paneId);
    // The proof reads yielded; the record must still be the one that was proved.
    let current = await readJson(this.recordFile).catch(() => null);
    if (!current || recordIdentity(current) !== expected || current.manualClose === true ||
      current.paneId !== record.paneId)
      return this.yieldWaiting(message, 'yield-record-changed', record.paneId);
    native = await this.recheckYieldNative(current, proof);
    if (!native.ok) return this.yieldWaiting(message, native.state, current.paneId);

    // Journal the intentional yield before the close. This is a yield closure,
    // never the owner-close/absence suppression: manualClose stays false.
    const at = this.stamp();
    const closure = { reason: 'yield', at, commandId: message.commandId,
      launchToken: current.launch?.token ?? null, paneId: current.paneId,
      sessionId: current.sessionId ?? this.sessionId ?? null,
      lifetimeId: current.scope?.lifetimeId ?? message.scope.lifetimeId ?? null };
    const yielding = { ...current, phase: 'yielding', manualClose: false, closure,
      pendingEffect: { kind: 'close', at, launchToken: current.launch?.token ?? null,
        paneId: current.paneId, reason: 'yield' } };
    if (!(await this.commitYield(yielding, expected, current)))
      return this.yieldWaiting(message, 'yield-record-changed', current.paneId);

    let closeError = null;
    try { await this.herdr('close', current.paneId); }
    catch (error) { closeError = error; }
    const layout = await this.observeLayout();
    const sameTab = this.sameTabLayout(layout, message.scope.tabId);
    const gone = sameTab && !layout.panes.some(pane => pane?.pane_id === current.paneId);
    if (closeError || !gone) {
      this.state = closeError ? 'effect-unknown'
        : sameTab ? 'yield-close-unconfirmed' : 'yield-stale-tab';
      this.publishYieldResult(message, { status: 'waiting', paneId: current.paneId });
      return { state: this.state, status: 'waiting', waiting: true,
        commandId: message.commandId, paneId: current.paneId };
    }
    const cleared = { ...yielding, paneId: null, phase: 'yielded', pendingEffect: null, rect: null,
      identity: { paneId: null, shellPid: null, viewerPid: null, viewerStartedAt: null } };
    if (!(await this.commitYield(cleared, recordIdentity(yielding), yielding))) {
      this.state = 'effect-unknown';
      this.publishYieldResult(message, { status: 'waiting', paneId: null });
      return { state: 'effect-unknown', status: 'waiting', waiting: true,
        commandId: message.commandId, paneId: null };
    }
    // Publish the next lower row (Workers+DAG) so the core planner can settle
    // the four-area layout and re-place against the new IDs.
    const workers = current.workers ?? null, dag = current.dag ?? null;
    const next = workers && dag ? this.bandFromPanes(layout, { workers, dag }) : null;
    this.band = next?.band ?? null;
    this.cells = next?.cells ?? null;
    this.collabCurrent = false;
    this.geometryCurrent = false;
    this.state = 'yielded';
    const result = this.publishYieldResult(message, { status: 'settled', paneId: null,
      workers, dag, band: next?.band ?? null, cells: next?.cells ?? null });
    return { state: 'yielded', status: 'settled', waiting: false, commandId: message.commandId,
      paneId: null, result, band: next?.band ?? null, cells: next?.cells ?? null };
  }
  bandFromPanes(layout, { collab = null, workers, dag } = {}) {
    const rect = id => layout?.panes?.find(pane => pane?.pane_id === id)?.rect;
    const workersRect = rect(workers), dagRect = rect(dag), collabRect = collab ? rect(collab) : null;
    if (!workersRect || !dagRect || workersRect.y !== dagRect.y || workersRect.height !== dagRect.height ||
      workersRect.x + workersRect.width !== dagRect.x) return null;
    const cells = [{ role: 'workers', paneId: workers, rect: { ...workersRect } }];
    let band = { x: workersRect.x, y: workersRect.y,
      width: dagRect.x + dagRect.width - workersRect.x, height: workersRect.height };
    if (collabRect && collabRect.y === workersRect.y && collabRect.height === workersRect.height &&
      collabRect.x + collabRect.width === workersRect.x) {
      cells.unshift({ role: 'collab', paneId: collab, rect: { ...collabRect } });
      band = { x: collabRect.x, y: workersRect.y,
        width: band.x + band.width - collabRect.x, height: workersRect.height };
    }
    cells.push({ role: 'dag', paneId: dag, rect: { ...dagRect } });
    return { band, cells };
  }
  async viewerCommand(paneId, launch, revision) {
    const scope = this.scope ?? {};
    return shellCommand([await this.node(), this.viewer, '--status', this.statusFile,
      '--activity', this.activityPath, ...(this.sessionId ? ['--session', this.sessionId] : []),
      '--record', this.recordFile, '--lang', this.language,
      '--launch', launch.token, '--launch-at', launch.at, '--binding', revision, '--parent', String(this.parentPane),
      ...(scope.tabId ? ['--tab', String(scope.tabId)] : []),
      ...(scope.lifetimeId ? ['--lifetime', String(scope.lifetimeId)] : []),
      ...(scope.scopeEpoch !== null && scope.scopeEpoch !== undefined ? ['--epoch', String(scope.scopeEpoch)] : []),
      ...(scope.generation !== null && scope.generation !== undefined ? ['--generation', String(scope.generation)] : []),
      ...(scope.ownerKey ? ['--owner', String(scope.ownerKey)] : []),
      '--close-pane', String(paneId)]);
  }
  // A fresh explicit command may override an older recorded close, but never a
  // close recorded after that command began.
  async overrideRecord(next, closedAt, requestedAt) {
    const current = await readJson(this.recordFile).catch(() => null);
    if (!current || current.sessionId !== this.sessionId) return false;
    if (current?.manualClose === true) {
      const at = Date.parse(current.closure?.at ?? current.closedAt ?? closedAt ?? '');
      if (!Number.isFinite(at) || at > requestedAt) return false;
    }
    await writeJson(this.recordFile, next);
    return true;
  }
  // The record file is keyed by the parent pane, not the session. A record
  // left by a previous session in this reused pane can never authorize this
  // one: keep it as evidence and start a fresh placement.
  async archiveForeignRecord(record) {
    const target = this.recordFile + '.foreign-' + this.stamp().replace(/[:.]/g, '-') +
      '-' + randomUUID().slice(0, 8) + '.json';
    await writeJson(target, { v: 1, reason: 'foreign-session', archivedAt: this.stamp(),
      record, viewerProof: readViewerProof(this.recordFile) ?? null });
    try { unlinkSync(this.recordFile); } catch { /* already gone */ }
    try { unlinkSync(viewerProofPath(this.recordFile)); } catch { /* already gone */ }
  }
  async ensure(message, { acceptedAt = this.now(), acceptedCloseAt = null } = {}) {
    if (this.stopped) return this.status();
    if (this.env?.OMO_HERDR_COORDINATION_PANE === '0') { this.state = 'disabled'; return this.status(); }
    if (!this.ownsPinnedScope(message.scope)) { this.state = 'foreign-scope'; return this.status(); }
    const scope = this.adoptScope(message.scope);
    this.band = message.band;
    this.cells = message.cells;
    this.geometryCurrent = false;
    const explicitAt = acceptedAt;
    // A record is keyed by the parent pane, not the session. A previous
    // session's record in this reused pane is never this session's custody:
    // archive it once its pane is gone, or hold while it is still visible.
    let record = await readJson(this.recordFile).catch(() => null);
    if (this.sessionId && record?.sessionId && record.sessionId !== this.sessionId) {
      const layout = await this.observeLayout().catch(() => null);
      if (!layout) { this.state = 'layout-unavailable'; return this.status(); }
      if (layout.panes?.some(pane => pane?.pane_id === record.paneId)) {
        this.state = 'foreign-pane-live';
        return this.status();
      }
      await this.archiveForeignRecord(record);
      record = null;
    }
    await this.consumeOwnerClose();
    record = await readJson(this.recordFile).catch(() => null);

    // A recorded owner or unknown-absence close is a pane-level suppression:
    // a lifecycle/session change never clears it.
    if (record?.manualClose === true) {
      const closureAt = record.closure?.at ?? null;
      const closedAt = Date.parse(closureAt ?? '');
      // The close visible when the command was accepted is the older close the
      // command may override. A close that appeared after acceptance (different
      // revision) always wins, even if the coalesced pass runs later.
      const sameClose = closureAt === acceptedCloseAt;
      const older = !Number.isFinite(closedAt) || closedAt <= explicitAt;
      const fresh = message.explicit === true && sameClose && older;
      if (!fresh) {
        this.state = 'closed-by-owner';
        return this.status();
      }
      const cleared = { ...record, manualClose: false, phase: 'rebinding', pendingEffect: null,
        closure: { ...(record.closure ?? {}), overriddenAt: this.stamp(), overrideCommandId: message.commandId } };
      if (!(await this.overrideRecord(cleared, record.closure?.at ?? null, explicitAt))) {
        this.state = 'closed-by-owner';
        return this.status();
      }
      record = cleared;
    }

    const cell = role => message.cells.find(item => item.role === role) ?? null;
    let collabCell = cell('collab');
    const workersCell = cell('workers'), dagCell = cell('dag');

    if (record?.pendingEffect) {
      const outcome = await this.resolveEffect(record, message, { collabCell, workersCell, dagCell });
      record = outcome.record ?? record;
      if (!outcome.clear) return this.status();
      if (outcome.closed) {
        collabCell = null;
        if (outcome.layout) {
          const clean = this.layoutFromObservation(message, outcome.layout);
          if (clean) message = clean;
        }
      }
    }

    if (collabCell) {
      if (!record || record.paneId !== collabCell.paneId) {
        this.state = 'foreign-cell';
        return this.status();
      }
      if (record.v !== 2 || typeof record.launch?.token !== 'string') {
        this.state = 'legacy-waiting';
        return this.status();
      }
      const revision = bindingRevision(scope, { workers: message.workers, dag: message.dag });
      const bindingChanged = record.workers !== message.workers || record.dag !== message.dag ||
        (record.revisions?.binding ?? record.binding?.revision) !== revision;
      if (bindingChanged) {
        const viewer = await this.viewerStatus();
        if (viewer.ready) {
          await this.replace(record, message, 'rebinding');
          return this.status();
        }
        if (viewer.state === 'exited' || viewer.state === 'error') {
          await this.relaunchInPlace(record, message, revision);
          return this.status();
        }
        this.state = viewer.state === 'stale' ? 'viewer-stale' : 'viewer-unproven';
        return this.status();
      }
      // A recovered swap/resize leaves the record staged but not yet launched.
      if (record.phase === 'split' || record.phase === 'staged') {
        await this.finishPlacement(record, message, lowerRowWidths(message.band.width), revision);
        return this.status();
      }
      const desired = lowerRowWidths(message.band.width);
      const actual = { collab: collabCell.rect.width, workers: workersCell.rect.width, dag: dagCell.rect.width };
      if (!desired || !sameWidths(actual, desired)) {
        await this.resize(record, message, desired);
        return this.status();
      }
      // Geometry-only changes keep the same pane and launch. Refresh durable
      // metadata only; no split, swap or run is issued for a rectangle change.
      const geometry = geometryRevision(collabCell.paneId, collabCell.rect);
      const meta = layoutMeta(message);
      if (record.layout?.geometryRevision !== message.geometryRevision ||
        JSON.stringify(record.layout ?? null) !== JSON.stringify(meta) ||
        record.rect?.x !== collabCell.rect.x || record.rect?.width !== collabCell.rect.width) {
        const next = { ...record, rect: collabCell.rect, tabId: scope.tabId, workers: message.workers,
          dag: message.dag, scope, expected: desired,
          binding: { workers: message.workers, dag: message.dag, revision },
          revisions: { ...record.revisions, binding: revision, geometry }, layout: meta };
        if (!(await this.commitRecord(next, record.launch.token))) {
          this.state = 'closed-by-owner';
          return this.status();
        }
        record = next;
      }
      this.geometryCurrent = true;
      const viewer = await this.viewerStatus();
      // Proven viewer death/exit in an owned live shell repairs in place. A
      // stale/unproven heartbeat is not death and waits instead.
      if (viewer.state === 'exited' || viewer.state === 'error') {
        await this.relaunchInPlace(record, message, revision);
        return this.status();
      }
      this.state = viewer.ready && !record.pendingEffect ? 'current'
        : viewer.state === 'owner-closed' ? 'closed-by-owner' : viewer.state;
      return this.status();
    }

    if (record?.paneId) {
      const layout = await this.observeLayout();
      if (!layout) { this.state = 'layout-unavailable'; return this.status(); }
      if (!this.sameTabLayout(layout, record.tabId ?? scope.tabId)) {
        this.state = 'stale-layout';
        return this.status();
      }
      const live = layout.panes.some(pane => pane?.pane_id === record.paneId);
      if (!live) {
        const overriddenAt = Date.parse(record.closure?.overriddenAt ?? '');
        const createdAt = Date.parse(record.createdAt ?? '');
        // An explicit override is consumed by the launch created after it. A
        // later native absence of that new launch is a new absence; only the
        // pre-restore record (created before the override) skips this step.
        const freshLaunch = !Number.isFinite(overriddenAt) ||
          (Number.isFinite(createdAt) && createdAt >= overriddenAt);
        if (record.v === 2 && record.sessionId === this.sessionId && freshLaunch) {
          // A native disappearance without owner intent is unknown absence:
          // persist a manualClose-compatible closure before any reload can
          // treat it as an unmarked cold start.
          const at = this.stamp();
          const next = { ...record, phase: 'closed', manualClose: true,
            closure: { reason: 'absence', at, launchToken: record.launch?.token ?? null,
              sessionId: record.sessionId ?? null, lifetimeId: record.scope?.lifetimeId ?? null },
            pendingEffect: null };
          this.state = (await this.commitRecord(next, record.launch?.token ?? null))
            ? 'closed-by-absence' : 'closed-by-owner';
          return this.status();
        }
        // A legacy record or an explicitly restored older close: its old pane
        // is gone, so this is a fresh owned placement, not a new suppression.
        record = { ...record, paneId: null, rect: null, pendingEffect: null,
          identity: { paneId: null, shellPid: null, viewerPid: null, viewerStartedAt: null } };
      } else if (record.v !== 2 || typeof record.launch?.token !== 'string') {
        this.state = 'legacy-waiting';
        return this.status();
      } else {
        await this.replace(record, message, 'replacement', layout);
        return this.status();
      }
    }

    await this.place(message, record);
    return this.status();
  }
  // Verb-specific effect resolution. A lost reply is effect-unknown; it is
  // never cleared by a timeout, a command or a lifetime change.
  async resolveEffect(record, message, { collabCell, workersCell, dagCell }) {
    const effect = record.pendingEffect;
    if (!effect || typeof effect !== 'object') return { clear: true, record };
    if (effect.kind === 'split') {
      // No returned pane id: never split again and never adopt an unidentified
      // new pane. A layout with no new IDs does not prove a delayed split away.
      this.state = 'effect-unknown';
      return { clear: false, record };
    }
    if (effect.kind === 'close') {
      const layout = await this.observeLayout();
      const tabId = record.tabId ?? this.scope?.tabId;
      if (!this.sameTabLayout(layout, tabId)) { this.state = 'effect-unknown'; return { clear: false, record }; }
      const live = layout.panes.some(pane => pane?.pane_id === effect.paneId) ||
        (record.paneId && layout.panes.some(pane => pane?.pane_id === record.paneId));
      if (live) { this.state = 'effect-unknown'; return { clear: false, record }; }
      const next = { ...record, paneId: null, phase: 'replaced', pendingEffect: null, rect: null,
        identity: { paneId: null, shellPid: null, viewerPid: null, viewerStartedAt: null } };
      if (!(await this.commitRecord(next, record.launch?.token ?? null))) {
        this.state = 'closed-by-owner';
        return { clear: false, record };
      }
      return { clear: true, record: next, closed: true, layout };
    }
    if (effect.kind === 'swap') {
      if (!collabCell || !workersCell || !dagCell) { this.state = 'effect-unknown'; return { clear: false, record }; }
      const collab = collabCell.rect, workers = workersCell.rect;
      if (!(collab.y === workers.y && collab.height === workers.height && collab.x + collab.width === workers.x)) {
        // A delayed swap can still arrive; never blindly repeat it.
        this.state = 'effect-unknown';
        return { clear: false, record };
      }
      const next = { ...record, pendingEffect: null, phase: 'staged' };
      if (!(await this.commitRecord(next, record.launch?.token ?? null))) {
        this.state = 'closed-by-owner';
        return { clear: false, record };
      }
      return { clear: true, record: next };
    }
    if (effect.kind === 'resize') {
      if (!collabCell || !workersCell || !dagCell) { this.state = 'effect-unknown'; return { clear: false, record }; }
      const desired = lowerRowWidths(message.band.width);
      const actual = { collab: collabCell.rect.width, workers: workersCell.rect.width, dag: dagCell.rect.width };
      if (!desired || !sameWidths(actual, desired)) {
        await this.resize(record, message, desired);
        return { clear: false, record };
      }
      const next = { ...record, pendingEffect: null,
        phase: record.phase === 'running' ? 'running' : 'staged',
        rect: collabCell.rect, expected: desired,
        revisions: { ...record.revisions, geometry: geometryRevision(collabCell.paneId, collabCell.rect) } };
      if (!(await this.commitRecord(next, record.launch?.token ?? null))) {
        this.state = 'closed-by-owner';
        return { clear: false, record };
      }
      return { clear: true, record: next };
    }
    if (effect.kind === 'run') {
      const viewer = await this.viewerStatus();
      if (viewer.ready === true && (viewer.proof?.launch?.token ?? null) === (record.launch?.token ?? null)) {
        const next = { ...record, pendingEffect: null, phase: 'running' };
        if (!(await this.commitRecord(next, record.launch?.token ?? null))) {
          this.state = 'closed-by-owner';
          return { clear: false, record };
        }
        return { clear: true, record: next };
      }
      if (effect.deadlineAt && this.now() >= effect.deadlineAt) {
        // The exact paint did not arrive within the launch window. The run is
        // still effect-unknown: never type a second run. Retirement closes a
        // native pane, so the pinned owner and a fresh current-tab row must be
        // re-proven first; a foreign or wrong-tab record leaves it untouched.
        if (collabCell && collabCell.paneId !== record.paneId) {
          this.state = 'foreign-cell';
          return { clear: false, record };
        }
        const expected = recordIdentity(record);
        const retired = await this.commitRetirement(record, expected, message);
        if (retired) {
          try { await this.herdr('close', record.paneId); } catch { /* effect-unknown */ }
          this.state = 'run-unconfirmed';
        }
        return { clear: false, record };
      }
      this.state = 'run-pending';
      return { clear: false, record };
    }
    return { clear: true, record };
  }
  async place(message, record) {
    if (record?.scope && !this.recordScopeMatches(record)) { this.state = 'foreign-scope'; return this.status(); }
    const checked = await this.revalidate(message);
    if (!checked) { this.state = 'stale-layout'; return this.status(); }
    if (message.cells.some(cell => cell.role === 'collab')) { this.state = 'waiting'; return this.status(); }
    // No Collab cell: the settled band is the full lower row. Apply the
    // measured 28|28|30 rule to band.width so Collab is carved from that row.
    const widths = bandWidths(message.band);
    if (!widths || widths.collab < 12 || widths.dag < 12) { this.state = 'too-narrow'; return this.status(); }
    const scope = this.scope;
    const createdAt = this.stamp();
    const launch = { token: this.newLaunchToken(), at: createdAt };
    const revision = bindingRevision(scope, { workers: message.workers, dag: message.dag });
    const preIds = checked.panes.map(pane => pane?.pane_id).filter(Boolean);
    const base = { v: 2, paneId: null, tabId: scope.tabId, parentPaneId: this.parentPane,
      sessionId: this.sessionId, viewer: this.viewer, workers: message.workers, dag: message.dag,
      createdAt, phase: 'placing', rect: null, expected: widths, scope,
      binding: { workers: message.workers, dag: message.dag, revision },
      revisions: { binding: revision, geometry: null }, launch,
      identity: { paneId: null, shellPid: null, viewerPid: null, viewerStartedAt: null },
      closure: record?.closure ?? null, manualClose: false, layout: layoutMeta(message),
      pendingEffect: { kind: 'split', at: createdAt, launchToken: launch.token, paneIds: preIds } };
    if (!(await this.commitRecord(base, launch.token))) {
      this.state = 'closed-by-owner';
      return this.status();
    }
    let created;
    try {
      created = await this.herdr('split', '--pane', message.workers, '--direction', 'right', '--ratio', '0.5',
        '--cwd', this.cwd, '--no-focus');
    } catch {
      this.state = 'effect-unknown';
      return this.status();
    }
    const paneId = created?.pane?.pane_id;
    if (!paneId) { this.state = 'effect-unknown'; return this.status(); }
    // Persist the returned split id before any subsequent effect.
    const split = { ...base, paneId, phase: 'split', identity: { ...base.identity, paneId },
      pendingEffect: { kind: 'swap', at: this.stamp(), launchToken: launch.token } };
    if (!(await this.commitRecord(split, launch.token))) {
      this.state = 'closed-by-owner';
      return this.status();
    }
    const afterSplit = await this.observeLayout();
    if (!afterSplit || afterSplit.tab_id !== scope.tabId ||
      !afterSplit.panes.some(pane => pane?.pane_id === paneId) ||
      !afterSplit.panes.some(pane => pane?.pane_id === message.workers) ||
      !afterSplit.panes.some(pane => pane?.pane_id === message.dag)) {
      this.state = 'effect-unknown';
      return this.status();
    }
    try { await this.herdr('swap', '--source-pane', paneId, '--target-pane', message.workers); }
    catch { this.state = 'effect-unknown'; return this.status(); }
    const afterSwap = await this.observeLayout();
    const collabRect = afterSwap?.panes.find(pane => pane?.pane_id === paneId)?.rect;
    const workersRect = afterSwap?.panes.find(pane => pane?.pane_id === message.workers)?.rect;
    const dagRect = afterSwap?.panes.find(pane => pane?.pane_id === message.dag)?.rect;
    if (!collabRect || !workersRect || !dagRect || collabRect.y !== workersRect.y ||
      collabRect.height !== workersRect.height || collabRect.x + collabRect.width !== workersRect.x ||
      workersRect.x + workersRect.width !== dagRect.x) {
      // The swap may be delayed; keep the journaled effect and never repeat it.
      this.state = 'effect-unknown';
      return this.status();
    }
    const staged = { ...split, phase: 'staged', rect: collabRect,
      pendingEffect: { kind: 'resize', at: this.stamp(), launchToken: launch.token } };
    if (!(await this.commitRecord(staged, launch.token))) {
      this.state = 'closed-by-owner';
      return this.status();
    }
    await this.resize(staged, message, widths);
    const afterResize = await readJson(this.recordFile).catch(() => null);
    if (afterResize?.pendingEffect) { this.state = 'resize-pending'; return this.status(); }
    await this.finishPlacement(afterResize, message, widths, revision);
    return this.status();
  }
  // Finish a persisted placement (possibly resumed after a lost swap/resize)
  // without splitting again. The run is issued only when no run is pending.
  async finishPlacement(record, message, desired, revision) {
    if (!record?.paneId) { this.state = 'waiting-layout'; return; }
    if (record.phase !== 'split' && record.phase !== 'staged') {
      const viewer = await this.viewerStatus();
      this.state = viewer.ready ? 'current' : viewer.state === 'stale' ? 'stale' : 'viewer-unproven';
      return;
    }
    if (!this.recordScopeMatches(record)) { this.state = 'foreign-scope'; return; }
    const checked = await this.revalidate(message, { collab: record.paneId });
    if (!checked) { this.state = 'stale-layout'; return; }
    const collab = checked.panes.find(pane => pane?.pane_id === record.paneId)?.rect;
    const workers = checked.panes.find(pane => pane?.pane_id === message.workers)?.rect;
    const dag = checked.panes.find(pane => pane?.pane_id === message.dag)?.rect;
    if (!collab || !workers || !dag) { this.state = 'stale-layout'; return; }
    const target = desired ?? (message.cells.some(cell => cell.role === 'collab')
      ? lowerRowWidths(message.band.width) : bandWidths(message.band));
    if (!target) { this.state = 'too-narrow'; return; }
    if (!sameWidths({ collab: collab.width, workers: workers.width, dag: dag.width }, target)) {
      const settledNow = await this.resize(record, message, target);
      if (!settledNow) return;
      record = await readJson(this.recordFile).catch(() => record);
      if (record?.pendingEffect) return;
    }
    const viewer = await this.viewerStatus();
    if (viewer.ready === true && (viewer.proof?.launch?.token ?? null) === (record.launch?.token ?? null)) {
      const next = { ...record, phase: 'running', pendingEffect: null, rect: collab, expected: target };
      if (!(await this.commitRecord(next, record.launch?.token ?? null))) { this.state = 'closed-by-owner'; return; }
      this.geometryCurrent = true;
      this.state = 'running';
      return;
    }
    if (record.pendingEffect) {
      this.state = record.pendingEffect.kind === 'run' ? 'run-pending' : 'effect-unknown';
      return;
    }
    const bound = revision ?? record.revisions?.binding ??
      bindingRevision(this.scope, { workers: message.workers, dag: message.dag });
    const at = this.stamp();
    const launched = { ...record, phase: 'launching', rect: collab, expected: target,
      pendingEffect: { kind: 'run', at, launchToken: record.launch?.token ?? null, deadlineAt: this.now() + 30000 } };
    if (!(await this.commitRecord(launched, record.launch?.token ?? null))) { this.state = 'closed-by-owner'; return; }
    try { await this.herdr('run', record.paneId, await this.viewerCommand(record.paneId, record.launch, bound)); }
    catch { this.state = 'run-pending'; return; }
    // The chat keeps the input: if the new cell took the focus, hand it back.
    if ((await this.herdr('get', record.paneId).catch(() => null))?.pane?.focused === true)
      await this.herdr('focus', '--pane', record.paneId, '--direction', 'left').catch(() => {});
    const placed = await this.observeLayout();
    const rect = placed?.panes.find(pane => pane?.pane_id === record.paneId)?.rect ?? null;
    // 'running' means the launch command was issued; readiness still needs the
    // matching first-paint proof in the sidecar.
    const final = { ...launched, phase: 'running', rect, expected: target,
      revisions: { ...launched.revisions, geometry: geometryRevision(record.paneId, rect ?? collab) },
      pendingEffect: null };
    if (!(await this.commitRecord(final, record.launch?.token ?? null))) { this.state = 'closed-by-owner'; return; }
    this.geometryCurrent = true;
    this.state = 'running';
  }
  // Resize is idempotent only after observing the expected postcondition. A
  // lost reply leaves the journaled effect; the same unchanged geometry is
  // never resized twice (a changed geometry may be corrected once more).
  async resize(record, message, desired) {
    if (!record?.paneId || !desired) return false;
    if (!this.recordScopeMatches(record)) { this.state = 'foreign-scope'; return false; }
    const checked = await this.revalidate(message, { collab: record.paneId });
    if (!checked) { this.state = 'stale-layout'; return false; }
    const collab = checked.panes.find(pane => pane?.pane_id === record.paneId)?.rect;
    const workers = checked.panes.find(pane => pane?.pane_id === message.workers)?.rect;
    const dag = checked.panes.find(pane => pane?.pane_id === message.dag)?.rect;
    if (!collab || !workers || !dag) { this.state = 'stale-layout'; return false; }
    const actual = { collab: collab.width, workers: workers.width, dag: dag.width };
    if (sameWidths(actual, desired)) {
      const next = { ...record, pendingEffect: null, rect: collab, expected: desired,
        revisions: { ...record.revisions, geometry: geometryRevision(record.paneId, collab) } };
      if (!(await this.commitRecord(next, record.launch?.token ?? null))) { this.state = 'closed-by-owner'; return false; }
      this.geometryCurrent = true;
      this.state = 'resized';
      return true;
    }
    const effect = record.pendingEffect;
    if (effect?.lastObserved && sameWidths(actual, effect.lastObserved)) {
      this.state = 'resize-pending';
      return false;
    }
    const total = collab.width + workers.width + dag.width;
    // Grow or shrink the (Collab | Workers) group; the inner split keeps its
    // ratio, and DAG receives the remainder. The full band.width is used as the
    // denominator, never the Workers+DAG subtotal.
    const delta = (desired.collab + desired.workers) - (collab.width + workers.width);
    if (!total || !delta) { this.state = 'resize-pending'; return false; }
    const at = this.stamp();
    const staged = { ...record, rect: collab, expected: desired,
      pendingEffect: { ...(effect ?? {}), kind: 'resize', at, launchToken: record.launch?.token ?? null,
        target: message.workers, lastObserved: actual } };
    if (!(await this.commitRecord(staged, record.launch?.token ?? null))) { this.state = 'closed-by-owner'; return false; }
    try {
      await this.herdr('resize', '--pane', message.workers, '--direction', delta > 0 ? 'right' : 'left',
        '--amount', String(Math.abs(delta) / total));
    } catch { this.state = 'effect-unknown'; return false; }
    const after = await this.observeLayout();
    const ac = after?.panes.find(pane => pane?.pane_id === record.paneId)?.rect;
    const aw = after?.panes.find(pane => pane?.pane_id === message.workers)?.rect;
    const ad = after?.panes.find(pane => pane?.pane_id === message.dag)?.rect;
    if (ac && aw && ad && sameWidths({ collab: ac.width, workers: aw.width, dag: ad.width }, desired)) {
      const next = { ...staged, pendingEffect: null, rect: ac,
        revisions: { ...staged.revisions, geometry: geometryRevision(record.paneId, ac) } };
      if (!(await this.commitRecord(next, record.launch?.token ?? null))) { this.state = 'closed-by-owner'; return false; }
      this.geometryCurrent = true;
      this.state = 'resized';
      return true;
    }
    this.state = 'resize-pending';
    return false;
  }
  // Closing is an owned replacement, not an owner close. A matching proof is
  // required before a live pane can be closed.
  async replace(record, message, reason, observed = null) {
    if (!record?.paneId) return;
    if (record.v !== 2 || typeof record.launch?.token !== 'string') { this.state = 'legacy-waiting'; return; }
    const proof = readViewerProof(this.recordFile);
    if (!proof || proofMismatch(record, proof)) { this.state = 'viewer-unproven'; return; }
    if (!this.recordScopeMatches(record)) { this.state = 'foreign-scope'; return; }
    const checked = await this.revalidate(message, { collab: record.paneId });
    if (!checked) { this.state = 'stale-layout'; return; }
    const at = this.stamp();
    const next = { ...record, phase: 'replacing',
      closure: { reason, at, launchToken: record.launch.token, sessionId: record.sessionId ?? null,
        lifetimeId: record.scope?.lifetimeId ?? null },
      pendingEffect: { kind: 'close', at, launchToken: record.launch.token, paneId: record.paneId, reason } };
    if (!(await this.commitRecord(next, record.launch.token))) { this.state = 'closed-by-owner'; return; }
    try { await this.herdr('close', record.paneId); }
    catch { this.state = 'effect-unknown'; return; }
    const layout = await this.observeLayout();
    if (!this.sameTabLayout(layout, record.tabId ?? message.scope.tabId) ||
      layout.panes.some(pane => pane?.pane_id === record.paneId)) {
      this.state = 'effect-unknown';
      return;
    }
    const cleared = { ...next, paneId: null, phase: 'replaced', pendingEffect: null,
      identity: { paneId: null, shellPid: null, viewerPid: null, viewerStartedAt: null } };
    if (!(await this.commitRecord(cleared, record.launch.token))) { this.state = 'closed-by-owner'; return; }
    const clean = this.layoutFromObservation(message, layout);
    if (!clean) { this.state = 'layout-unavailable'; return; }
    await this.place(clean, cleared);
  }
  // A proven viewer exit/error in an owned, live shell is repaired in place.
  // A stale heartbeat with a live/unverified pid is not death and never gets
  // a second viewer typed into it.
  async relaunchInPlace(record, message, revision) {
    if (!record?.paneId) return;
    if (!this.recordScopeMatches(record)) { this.state = 'foreign-scope'; return; }
    const checked = await this.revalidate(message, { collab: record.paneId });
    if (!checked) { this.state = 'stale-layout'; return; }
    const at = this.stamp();
    const launch = { token: this.newLaunchToken(), at };
    const collab = message.cells.find(cell => cell.role === 'collab')?.rect ?? record.rect ?? null;
    const next = { ...record, phase: 'launching', launch, workers: message.workers, dag: message.dag,
      scope: this.scope, tabId: this.scope.tabId, rect: collab,
      binding: { workers: message.workers, dag: message.dag, revision },
      revisions: { ...record.revisions, binding: revision,
        geometry: geometryRevision(record.paneId, collab) },
      expected: lowerRowWidths(message.band.width),
      pendingEffect: { kind: 'run', at, launchToken: launch.token, deadlineAt: this.now() + 30000 } };
    if (!(await this.commitRecord(next, record.launch?.token ?? null))) { this.state = 'closed-by-owner'; return; }
    try { await this.herdr('run', record.paneId, await this.viewerCommand(record.paneId, launch, revision)); }
    catch { this.state = 'run-pending'; return; }
    // The run reply proves the command was issued in the retained shell. A
    // lost reply above remains effect-unknown; readiness still needs paint.
    const placed = await this.observeLayout();
    const rect = placed?.panes.find(pane => pane?.pane_id === record.paneId)?.rect ?? collab;
    const final = { ...next, phase: 'running', rect, pendingEffect: null,
      revisions: { ...next.revisions, geometry: geometryRevision(record.paneId, rect) } };
    if (!(await this.commitRecord(final, record.launch?.token ?? null))) { this.state = 'closed-by-owner'; return; }
    this.geometryCurrent = true;
    this.state = 'running';
  }
  // One final owned observation on shutdown. A query failure is unknown, not
  // evidence of pane death. A same-lifetime native absence is persisted so a
  // reload cannot mistake it for an unmarked cold start.
  async shutdownObserve() {
    if (this.stopped) return null;
    if (this.env?.OMO_HERDR_COORDINATION_PANE === '0') { this.state = 'disabled'; return null; }
    const record = await readJson(this.recordFile).catch(() => null);
    if (!record?.paneId || record.v !== 2) return null;
    if (!this.sessionId || record.sessionId !== this.sessionId) return null;
    let layout;
    try { layout = (await this.herdr('layout', '--pane', this.parentPane))?.layout; }
    catch { return null; }
    if (!Array.isArray(layout?.panes)) return null;
    if (!this.sameTabLayout(layout, record.tabId)) return null;
    if (layout.panes.some(pane => pane?.pane_id === record.paneId)) return null;
    const at = this.stamp();
    const next = { ...record, phase: 'closed', manualClose: true,
      closure: { reason: 'absence', at, launchToken: record.launch?.token ?? null,
        sessionId: record.sessionId ?? null, lifetimeId: record.scope?.lifetimeId ?? null },
      pendingEffect: null };
    if (!(await this.commitRecord(next, record.launch?.token ?? null))) return null;
    this.state = 'closed-by-absence';
    return next;
  }
}
