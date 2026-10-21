// OmO collaboration pane viewer. Read-only: it polls the controller's status file
// (connection and this session's advisor job) and the coordination activity log,
// filtered to `--session`, once a second and repaints only when something changed.
// Missing or corrupt files render empty.
//
// The viewer owns exactly one durable file: <recordFile>.viewer.json. The
// controller owns <recordFile>. They never write each other's file. First paint
// is published only after the frame write callback completes; a heartbeat write
// is coalesced to at most one per second. q/Ctrl-C records a launch-scoped owner
// close in that sidecar before this viewer closes its own pane.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminalInput, enablePointer, disablePointer } from '../../dag/src/terminal-input.mjs';
import { createHerdr } from '../../dag/src/herdr.mjs';
import { readActivity, readAdvisor, readStatus } from './activity.mjs';
import { renderFrame } from './render.mjs';
import { languageOf, t } from './i18n.mjs';

export const VIEWER_PROOF_SUFFIX = '.viewer.json';
export const VIEWER_HEARTBEAT_MS = 1000;
export const viewerProofPath = recordFile => `${recordFile}${VIEWER_PROOF_SUFFIX}`;

export function parseArgs(argv) {
  const value = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
  return { status: value('--status'), activity: value('--activity'), advisor: value('--advisor'),
    session: value('--session'), record: value('--record'), closePane: value('--close-pane'), language: languageOf(value('--lang')),
    launch: value('--launch'), launchAt: value('--launch-at'), binding: value('--binding'), tab: value('--tab'), parent: value('--parent'),
    lifetime: value('--lifetime'), epoch: value('--epoch'), generation: value('--generation'), owner: value('--owner'),
    once: argv.includes('--once'), columns: Number(value('--columns')) || undefined, rows: Number(value('--rows')) || undefined };
}

export function snapshot(options) {
  const status = options.status ? readStatus(options.status) : null;
  return { status,
    events: options.activity ? readActivity(options.activity, { session: options.session }) : [],
    // The controller records this session's advisor job in the status file; an explicit
    // --advisor (manual --once reads) still summarizes the shared advisor log.
    advisor: status?.advisor && typeof status.advisor === 'object' ? status.advisor
      : options.advisor ? readAdvisor(options.advisor) : undefined };
}

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

// Atomic within this single writer. Returns whether the durable sidecar was
// actually written; callers must not treat a boundary I/O failure as success.
function writeProofFile(recordFile, value) {
  const path = viewerProofPath(recordFile);
  const text = JSON.stringify(value);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporary, text, { mode: 0o600 });
      try { renameSync(temporary, path); }
      catch { writeFileSync(path, text, { mode: 0o600 }); }
    } finally { try { rmSync(temporary, { force: true }); } catch { /* already moved */ } }
    return true;
  } catch { return false; }
}

const scopeFrom = options => sanitizeScope({ ownerKey: options.owner ?? null, sessionId: options.session ?? null,
  lifetimeId: options.lifetime ?? null,
  scopeEpoch: options.epoch === undefined ? null : /^\d+$/.test(options.epoch) ? Number(options.epoch) : options.epoch,
  // The shared protocol uses a numeric positive generation; preserve text labels.
  generation: options.generation === undefined ? null
    : /^[1-9]\d*$/.test(options.generation) ? Number(options.generation) : options.generation,
  tabId: options.tab ?? null }) ?? {
  ownerKey: null, sessionId: null, lifetimeId: null, scopeEpoch: null, generation: null, tabId: null };

const localViewer = (deps = {}) => ({ pid: asPid(deps.pid ?? process.pid),
  startedAt: asDate(deps.startedAt) ?? new Date(Date.now() - process.uptime() * 1000).toISOString(),
  parentPid: asPid(deps.parentPid ?? process.ppid) });

export async function runViewer(options, deps = {}) {
  const output = deps.output ?? process.stdout, input = deps.input ?? process.stdin;
  const now = deps.now ?? (() => Date.now());
  const exit = deps.exit ?? (code => process.exit(code));
  const setTimer = deps.setInterval ?? setInterval, clearTimer = deps.clearInterval ?? clearInterval;
  const inputSetup = deps.terminalInput ?? terminalInput;
  const herdrFactory = deps.herdr ?? createHerdr;
  const onSignal = deps.onSignal ?? (handler => {
    process.on('SIGTERM', handler);
    return () => process.off('SIGTERM', handler);
  });
  const size = () => ({ columns: options.columns ?? output.columns ?? 28, rows: options.rows ?? output.rows ?? 30 });
  const scope = scopeFrom(options);
  const viewer = localViewer(deps);
  // Only a launch-scoped pane viewer writes the sidecar; a manual --once read does not.
  const proofEnabled = Boolean(options.record && options.launch && !options.once);
  let proof = null, lastProofWrite = -Infinity, paintSeq = 0, beatSeq = 0;
  let follow = true, offset = 0, last = '', frame, closing = false;
  let timer, resize, disposeInput;
  const baseProof = () => ({ v: 1, scope, bindingRevision: options.binding ?? null, pane: options.closePane ?? null,
    launch: { token: options.launch, at: asDate(options.launchAt) ?? new Date(Date.now()).toISOString() }, viewer,
    firstPaint: null, heartbeat: null, exit: null, ownerClose: null, error: null });
  const writeProof = () => proofEnabled && proof ? writeProofFile(options.record, proof) : false;
  // Liveness is periodic, independent of frame changes: a quiet pane still proves
  // its viewer is alive, while the file is written at most once per second.
  const beat = () => {
    if (!proofEnabled || !proof || closing) return;
    if (now() - lastProofWrite < VIEWER_HEARTBEAT_MS) return;
    const at = new Date(now()).toISOString();
    proof.heartbeat = { seq: ++beatSeq, at };
    writeProof();
    lastProofWrite = now();
  };
  const painted = seq => {
    if (!proofEnabled) return;
    if (!proof) {
      const at = new Date(now()).toISOString();
      beatSeq = 1;
      proof = { ...baseProof(), firstPaint: { seq, at }, heartbeat: { seq: 1, at } };
      writeProof();
      lastProofWrite = now();
      return;
    }
    beat();
  };
  const draw = force => {
    frame = renderFrame(snapshot(options), { ...size(), language: options.language, follow, offset, color: !options.once });
    if (!force && frame.text === last) return undefined;
    last = frame.text;
    const seq = ++paintSeq;
    const chunk = options.once ? `${frame.plain.join('\n')}\n`
      : `\x1b[H${frame.lines.map(line => `${line}\x1b[K`).join('\r\n')}\x1b[J`;
    return new Promise(done => {
      output.write(chunk, error => {
        if (error) recordViewerError(options, error, deps);
        else painted(seq);
        done();
      });
    });
  };
  const close = async reason => {
    if (closing) return;
    closing = true;
    let durable = true;
    if (proofEnabled) {
      const at = new Date(now()).toISOString();
      proof = proof ?? baseProof();
      proof.exit = { reason, at };
      // Only the explicit q/Ctrl-C path writes owner intent. Shutdown, yield or
      // an error exit can never become an owner close through this hook.
      if (reason === 'owner-close') proof.ownerClose = { reason: 'owner-close', at,
        launchToken: options.launch, pane: options.closePane ?? null, bindingRevision: options.binding ?? null,
        sessionId: scope.sessionId, lifetimeId: scope.lifetimeId };
      // Durable intent must precede terminal teardown and the native close.
      durable = writeProof();
    }
    if (reason === 'owner-close' && !durable) {
      // A boundary I/O failure is not a close. Drop the unpublished intent so a
      // later heartbeat cannot publish it, surface the failure, and keep the pane.
      proof.exit = null;
      proof.ownerClose = null;
      closing = false;
      try { output.write('\r\nowner close was not recorded; pane left open\r\n'); } catch { /* pane already gone */ }
      return;
    }
    try { clearTimer(timer); } catch { /* already gone */ }
    try { output.off('resize', resize); } catch { /* already gone */ }
    try { disposeInput?.(); } catch { /* already gone */ }
    try { input.setRawMode?.(false); } catch { /* terminal already gone */ }
    try { output.write(`${disablePointer}\x1b[?25h\x1b[?1049l`); } catch { /* pane already gone */ }
    if (reason === 'owner-close' && options.closePane) {
      try { await herdrFactory()('close', options.closePane); } catch { /* the pane may already be gone */ }
    }
    await exit(0);
  };
  const key = (text, pressed = {}) => {
    const name = pressed.name ?? text;
    const page = Math.max(1, (frame?.height ?? 10) - 2);
    if (pressed.ctrl && name === 'c' || name === 'q') return void close('owner-close');
    if (name === 'up' || name === 'k') scroll(1);
    else if (name === 'down' || name === 'j') scroll(-1);
    else if (name === 'pageup') scroll(page);
    else if (name === 'pagedown') scroll(-page);
    else if (name === 'end' || name === 'f' || name === 'G') { follow = true; offset = 0; draw(true); }
  };
  const scroll = rowsBy => {
    const max = frame?.maxOffset ?? 0;
    offset = Math.min(max, Math.max(0, offset + rowsBy));
    // Scrolling up pauses follow; reaching the newest row again resumes it.
    follow = offset === 0;
    draw(true);
  };
  const pointer = ({ button }) => { if (button === 64) scroll(2); else if (button === 65) scroll(-2); };
  if (options.once || !input.isTTY) { await draw(true); return; }
  output.write(`\x1b[?1049h\x1b[?25l${enablePointer}\x1b]0;${t(options.language, 'title')}\x07`);
  input.setRawMode?.(true); input.resume();
  disposeInput = inputSetup(input, { key, pointer, focus: () => {} });
  resize = () => draw(true);
  output.on('resize', resize);
  timer = setTimer(() => { void draw(false); beat(); }, 1000);
  onSignal(() => void close('shutdown'));
  const firstPaint = draw(true);
  return { firstPaint, stop: reason => close(reason) };
}

// The CLI's error exit records evidence but never owner intent.
export function recordViewerError(options, error, deps = {}) {
  if (!options?.record || !options?.launch) return;
  const existing = readViewerProof(options.record);
  const at = new Date().toISOString();
  const value = existing ?? { v: 1, scope: scopeFrom(options), bindingRevision: options.binding ?? null,
    pane: options.closePane ?? null, launch: { token: options.launch, at: asDate(options.launchAt) ?? at }, viewer: localViewer(deps),
    firstPaint: null, heartbeat: null, exit: null, ownerClose: null, error: null };
  writeProofFile(options.record, { ...value, error: { message: cleanMessage(error?.message ?? error), at } });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  try { await runViewer(options); }
  catch (error) {
    recordViewerError(options, error);
    process.exitCode = 1;
  }
}
