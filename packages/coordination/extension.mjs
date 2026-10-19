import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { CoordinationPane } from './src/controller.mjs';
import { createHerdr, herdrSession } from '../dag/src/herdr.mjs';
import { resolveViewerNode } from '../dag/src/runtime.mjs';
import { languageOf } from './src/i18n.mjs';

// The OmO collaboration pane: one more dashboard cell, left of the workers pane.
// OMO_HERDR_COORDINATION_PANE=0 keeps the connection record but places no pane.
export default function extension(pi, { createController = options => new CoordinationPane(options) } = {}) {
  let controller, lifecycle = Promise.resolve();
  const eligible = ctx => {
    if (/[/\\]senpi-task[/\\]children[/\\]/.test(ctx?.sessionManager?.getSessionFile?.() ?? '')) return false;
    return ctx?.hasUI === true && ctx.mode === 'tui' && herdrSession();
  };
  const agentDir = process.env.SENPI_CODING_AGENT_DIR ?? process.env.OMO_CODING_AGENT_DIR ?? join(homedir(), '.omo', 'agent');
  const stateDir = process.env.OMO_HERDR_COORDINATION_STATE_DIR ?? join(agentDir, 'herdr-coordination');
  const dagStateDir = process.env.OMO_HERDR_DAG_STATE_DIR ?? join(agentDir, 'herdr-dag');
  const viewer = join(dirname(fileURLToPath(import.meta.url)), 'src/viewer.mjs');
  const stop = async () => { const old = controller; controller = undefined; await old?.stop(); };
  const start = (_event, ctx) => {
    if (!eligible(ctx)) return;
    lifecycle = lifecycle.then(async () => {
      await stop();
      let language = 'en';
      try { language = JSON.parse(readFileSync(new URL('./locale.json', import.meta.url), 'utf8')).language; }
      catch { /* English without an installed locale */ }
      language = languageOf(process.env.OMO_HERDR_COORDINATION_LANG ?? language);
      controller = createController({ stateDir, dagStateDir, viewer, language, cwd: pi.cwd,
        receiptPath: join(agentDir, '.agent-coordination-install', 'receipt.json'),
        activityPath: join(agentDir, 'coordination-activity.jsonl'),
        parentPane: process.env.HERDR_PANE_ID, sessionId: ctx.sessionManager?.getSessionId?.(),
        herdr: createHerdr(), node: () => resolveViewerNode({ language }) });
      // Placement waits for the dashboard panes in the background; a failure never reaches the session.
      void controller.start().catch(() => {});
    }).catch(() => {});
    return lifecycle;
  };
  pi.on('session_start', start);
  pi.on('session_tree', start);
  pi.on('session_shutdown', async () => { await lifecycle; await stop(); });
}
