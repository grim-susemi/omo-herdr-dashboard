import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CoordinationPane } from './src/controller.mjs';
import { createHerdr, herdrSession } from '../dag/src/herdr.mjs';
import { resolveViewerNode } from '../dag/src/runtime.mjs';
import { readJson } from '../dag/src/storage.mjs';
import { displayOwnerKey } from '../todo/src/display-bridge.mjs';
import { RECOVERY_V1, validScope } from './src/recovery.mjs';
import { languageOf } from './src/i18n.mjs';

// The Todo publisher announces this owner once per process. The reply carries
// the same coordinator object, so a late listener can ask for it by identity.
const CHANNELS = Object.freeze({
  provider: 'omo.herdr.dashboard.provider',
  reply: 'omo.herdr.dashboard.reply',
  query: 'omo.herdr.dashboard.query',
});

// The core coordinator is the scope authority. Its exact todo record supplies
// the epoch/tab, while the live coordinator supplies lifetime and generation.
// Every field is checked with the shared protocol before a query is emitted.
async function ownerScope(owner) {
  if (!owner || typeof owner !== 'object') return null;
  const binding = owner.binding ?? owner;
  let record = null;
  try { record = owner.todoRecord?.path ? await readJson(owner.todoRecord.path) : null; } catch { record = null; }
  let generation = owner.generation ?? record?.generation;
  try { generation ??= owner.actor?.snapshot?.generation; } catch { /* not claimed yet */ }
  const scope = {
    ownerKey: binding.ownerKey ?? record?.ownerKey,
    sessionId: binding.sessionId ?? record?.sessionId,
    lifetimeId: owner.lifetimeId ?? record?.lifetimeId,
    scopeEpoch: record?.scopeEpoch ?? owner.scopeEpoch,
    generation,
    tabId: record?.tabId ?? binding.tabId ?? owner.claim?.tabId,
  };
  return validScope(scope) ? scope : null;
}

// The OmO collaboration pane: one more dashboard cell, left of the workers pane.
// OMO_HERDR_COORDINATION_PANE=0 keeps the connection record but places no pane.
// Placement is event-driven: subscribe to the settled-layout channel first,
// then request the core's last settled row, so a late listener cannot miss it.
export default function extension(pi, { createController = options => new CoordinationPane(options) } = {}) {
  let controller, lifecycle = Promise.resolve(), unsubscribers = [], owner = null;
  let parentPane = null, sessionId = null, replayFor = null;
  const eligible = ctx => {
    if (/[/\\]senpi-task[/\\]children[/\\]/.test(ctx?.sessionManager?.getSessionFile?.() ?? '')) return false;
    return ctx?.hasUI === true && ctx.mode === 'tui' && herdrSession();
  };
  const agentDir = process.env.SENPI_CODING_AGENT_DIR ?? process.env.OMO_CODING_AGENT_DIR ?? join(homedir(), '.omo', 'agent');
  const stateDir = process.env.OMO_HERDR_COORDINATION_STATE_DIR ?? join(agentDir, 'herdr-coordination');
  const dagStateDir = process.env.OMO_HERDR_DAG_STATE_DIR ?? join(agentDir, 'herdr-dag');
  const viewer = join(dirname(fileURLToPath(import.meta.url)), 'src/viewer.mjs');

  const requestReplay = async () => {
    if (!controller || !owner || !pi.events?.emit || replayFor === owner) return;
    const scope = await ownerScope(owner);
    if (!scope) return;
    replayFor = owner;
    pi.events.emit(RECOVERY_V1.layoutQuery, { v: 1, kind: 'layout-query', scope,
      commandId: randomUUID(), requestId: randomUUID() });
  };

  const attach = () => {
    const offs = [];
    const on = pi.events?.on?.bind(pi.events);
    if (!on) return offs;
    offs.push(on(RECOVERY_V1.layout, message => {
      if (!controller || message?.v !== 1 || message.kind !== 'layout') return;
      // The controller coalesces bursts, rejects foreign/stale scopes and
      // performs at most one ensure with one latest-layout rerun.
      void controller.acceptLayout(message).catch(() => {});
    }));
    // The DAG's explicit migration asks this pane to yield before its journal
    // write. Subscribe before any replay request so the yield cannot be missed;
    // the controller proves the scope/pane again and leaves the journal intact
    // unless it can close exactly that proved pane.
    offs.push(on(RECOVERY_V1.yield, message => {
      if (!controller || message?.v !== 1 || message.kind !== 'yield') return;
      try { void Promise.resolve(controller.acceptYield?.(message)).catch(() => {}); }
      catch { /* a detached listener never breaks the emitter */ }
    }));
    const acceptOwner = message => {
      if (!controller || message?.v !== 1 || message.kind !== 'todo-owner' || !message.provider) return;
      owner = message.provider;
      void requestReplay().catch(() => {});
    };
    offs.push(on(CHANNELS.provider, acceptOwner));
    offs.push(on(CHANNELS.reply, acceptOwner));
    return offs;
  };

  const stop = async ({ observe = false } = {}) => {
    const old = controller;
    controller = undefined;
    // The listener must still be attached for the final owned observation.
    if (observe && old) { try { await old.shutdownObserve?.(); } catch { /* unknown */ } }
    for (const off of unsubscribers) { try { off(); } catch { /* detached */ } }
    unsubscribers = [];
    owner = null; replayFor = null;
    await old?.stop();
  };

  const start = (_event, ctx) => {
    if (!eligible(ctx)) return;
    lifecycle = lifecycle.then(async () => {
      await stop();
      let language = 'en';
      try { language = JSON.parse(readFileSync(new URL('./locale.json', import.meta.url), 'utf8')).language; }
      catch { /* English without an installed locale */ }
      language = languageOf(process.env.OMO_HERDR_COORDINATION_LANG ?? language);
      parentPane = process.env.HERDR_PANE_ID;
      sessionId = ctx.sessionManager?.getSessionId?.();
      controller = createController({ stateDir, dagStateDir, viewer, language, cwd: pi.cwd,
        receiptPath: join(agentDir, '.agent-coordination-install', 'receipt.json'),
        activityPath: join(agentDir, 'coordination-activity.jsonl'),
        parentPane, sessionId, events: pi.events,
        herdr: createHerdr(), node: () => resolveViewerNode({ language }) });
      // Subscribe before any replay request or placement action.
      unsubscribers = attach();
      await controller.start();
      if (!pi.events?.emit) return;
      // Ask the Todo owner for its coordinator, then replay its last settled
      // snapshot. The listeners above are already attached.
      const ownerKey = displayOwnerKey(process.env.HERDR_SOCKET_PATH, parentPane, sessionId);
      pi.events.emit(CHANNELS.query, { v: 1, requestId: randomUUID(), kind: 'todo-owner',
        socketPath: process.env.HERDR_SOCKET_PATH, parentPaneId: parentPane, sessionId, ownerKey });
      await requestReplay();
    }).catch(() => {});
    return lifecycle;
  };

  pi.on('session_start', start);
  pi.on('session_tree', start);
  pi.on('session_shutdown', async () => {
    await lifecycle;
    await stop({ observe: true });
  });
}
