// Dependency-free viewer-proof reader. The coordination controller owns the
// durable record; the viewer owns <recordFile>.viewer.json. Todo and the
// controller both need the same exact shape and staleness rule, so this small
// module keeps that verdict out of the (DAG-dependent) controller module.
import { readFileSync } from 'node:fs';

export const VIEWER_PROOF_SUFFIX = '.viewer.json';
export const VIEWER_HEARTBEAT_LIMIT_MS = 3000;
export const viewerProofPath = recordFile => `${recordFile}${VIEWER_PROOF_SUFFIX}`;

const SCOPE_KEYS = ['ownerKey', 'sessionId', 'lifetimeId', 'scopeEpoch', 'generation', 'tabId'];
const asText = (value, max = 200) => typeof value === 'string' && value.length >= 1 && value.length <= max &&
  !/[\r\n\u0000]/.test(value) ? value : null;
const asDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const asSeq = value => Number.isInteger(value) && value >= 1 ? value : null;
const asPid = value => Number.isInteger(value) && value > 0 ? value : null;
const asEpoch = value => Number.isInteger(value) && value >= 0 ? value : asText(value, 40);
const asGeneration = value => Number.isInteger(value) && value > 0 ? value : asText(value, 80);
const cleanMessage = value => (typeof value === 'string' ? value : String(value ?? ''))
  .replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f]/g, ' ').slice(0, 300) || null;

const sanitizeScope = value => value && typeof value === 'object' ? {
  ownerKey: asText(value.ownerKey), sessionId: asText(value.sessionId),
  lifetimeId: asText(value.lifetimeId), scopeEpoch: asEpoch(value.scopeEpoch),
  generation: asGeneration(value.generation), tabId: asText(value.tabId) } : null;

// Fixed fields only: activity text, events or other arbitrary content is never
// imported into the proof. Any unreadable mandatory identity rejects the file.
export function sanitizeViewerProof(value) {
  if (!value || typeof value !== 'object' || value.v !== 1) return null;
  const pane = asText(value.pane), scope = sanitizeScope(value.scope);
  const launch = value.launch && typeof value.launch === 'object'
    ? { token: asText(value.launch.token), at: asDate(value.launch.at) } : null;
  if (!pane || !scope || !launch?.token) return null;
  const viewer = value.viewer && typeof value.viewer === 'object' ? value.viewer : {};
  const firstPaint = value.firstPaint ? { seq: asSeq(value.firstPaint.seq), at: asDate(value.firstPaint.at) } : null;
  const heartbeat = value.heartbeat ? { seq: asSeq(value.heartbeat.seq), at: asDate(value.heartbeat.at) } : null;
  const exit = value.exit && typeof value.exit === 'object' &&
    ['owner-close', 'shutdown', 'error', 'yield', 'retirement'].includes(value.exit.reason) && asDate(value.exit.at)
    ? { reason: value.exit.reason, at: value.exit.at } : null;
  const ownerClose = value.ownerClose && typeof value.ownerClose === 'object' &&
    value.ownerClose.reason === 'owner-close' && asDate(value.ownerClose.at) &&
    asText(value.ownerClose.launchToken) && asText(value.ownerClose.pane)
    ? { reason: 'owner-close', at: value.ownerClose.at, launchToken: value.ownerClose.launchToken,
      pane: value.ownerClose.pane, bindingRevision: asText(value.ownerClose.bindingRevision),
      sessionId: asText(value.ownerClose.sessionId), lifetimeId: asText(value.ownerClose.lifetimeId) } : null;
  const error = value.error && typeof value.error === 'object' && asDate(value.error.at)
    ? { message: cleanMessage(value.error.message), at: value.error.at } : null;
  return { v: 1, scope, bindingRevision: asText(value.bindingRevision), pane, launch,
    viewer: { pid: asPid(viewer.pid), startedAt: asDate(viewer.startedAt), parentPid: asPid(viewer.parentPid) },
    firstPaint: firstPaint?.seq && firstPaint.at ? firstPaint : null,
    heartbeat: heartbeat?.seq && heartbeat.at ? heartbeat : null,
    exit, ownerClose, error };
}

export function readViewerProof(recordFile) {
  if (!recordFile) return null;
  try { return sanitizeViewerProof(JSON.parse(readFileSync(viewerProofPath(recordFile), 'utf8'))); }
  catch { return null; }
}

// The first identity difference between the controller record and the viewer
// sidecar, or null when they describe the same launch/scope/binding/pane.
export function proofMismatch(record, proof) {
  if ((record?.launch?.token ?? null) !== (proof?.launch?.token ?? null)) return 'launch-mismatch';
  if ((record?.paneId ?? null) !== (proof?.pane ?? null)) return 'pane-mismatch';
  if ((record?.revisions?.binding ?? record?.binding?.revision ?? null) !== (proof?.bindingRevision ?? null))
    return 'binding-mismatch';
  for (const key of SCOPE_KEYS) {
    const left = record?.scope?.[key] ?? null, right = proof?.scope?.[key] ?? null;
    // The shared protocol makes generation/scopeEpoch numeric; an older text
    // form (or the CLI round trip) must compare by value, not by JS type.
    const same = key === 'generation' || key === 'scopeEpoch'
      ? (left == null ? null : String(left)) === (right == null ? null : String(right))
      : left === right;
    if (!same) return 'scope-mismatch';
  }
  return null;
}

// Readiness is a proof verdict, never a placement verdict. Legacy v1 records
// remain readable but have no launch token, so they are explicitly unproven.
export function inspectViewerProof(record, proof, { now = Date.now(), heartbeatMs = VIEWER_HEARTBEAT_LIMIT_MS } = {}) {
  const base = { ready: false, state: 'no-record', record: record ?? null, proof: proof ?? null };
  if (!record || typeof record !== 'object') return base;
  if (record.v !== 2 || typeof record.launch?.token !== 'string') return { ...base, state: 'legacy-unproven' };
  if (!proof) return { ...base, state: 'no-proof' };
  const mismatch = proofMismatch(record, proof);
  if (mismatch) return { ...base, state: mismatch };
  if (!(proof.viewer?.pid >= 1) || !Number.isFinite(Date.parse(proof.viewer?.startedAt ?? '')))
    return { ...base, state: 'viewer-identity-missing' };
  if (proof.ownerClose) return { ...base, state: 'owner-closed' };
  if (proof.exit) return { ...base, state: 'exited' };
  if (proof.error) return { ...base, state: 'error' };
  if (!(proof.firstPaint?.seq >= 1)) return { ...base, state: 'first-paint-pending' };
  const beat = Date.parse(proof.heartbeat?.at ?? '');
  if (!Number.isFinite(beat) || now - beat > heartbeatMs) return { ...base, state: 'stale' };
  return { ...base, ready: true, state: 'current', firstPaintSeq: proof.firstPaint.seq, heartbeatAt: proof.heartbeat.at };
}
