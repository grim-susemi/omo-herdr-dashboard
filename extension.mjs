import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { languageOf } from './src/i18n.mjs';
import { isChildSession } from './src/child-guard.mjs';
import { bindDisplayBridgeSignals } from './src/display-bridge.mjs';
import { resolveDashboardNode, TodoPane } from './src/controller.mjs';

export function installedLanguage(environment = process.env) {
  let selected = 'en';
  try { selected = JSON.parse(readFileSync(new URL('./locale.json', import.meta.url), 'utf8')).language; }
  catch (error) { if (error.code !== 'ENOENT') console.warn('Todo pane: Cannot read locale configuration: '+error.message); }
  return languageOf(environment.OMO_HERDR_TODO_LANG ?? selected);
}

export default function extension(pi) {
  let controller;
  let generation = 0;
  const eligible = ctx => {
    if (isChildSession(ctx?.sessionManager?.getSessionFile?.())) return false;
    return ctx?.hasUI === true && ctx.mode === 'tui' && process.env.HERDR_ENV === '1' &&
      Boolean(process.env.HERDR_PANE_ID && process.env.HERDR_SOCKET_PATH);
  };
  async function stop() {
    generation++;
    const old = controller; controller = undefined;
    await old?.stop();
  }
  bindDisplayBridgeSignals(pi, () => controller?.bridge);
  pi.on('session_start', async (_event, ctx) => {
    // Child identity precedes UI, ownership, filesystem and process work.
    if (!eligible(ctx)) return;
    await stop();
    const current = generation;
    const next = new TodoPane({ ctx, cwd: pi.cwd,
      stateDir: process.env.OMO_HERDR_TODO_STATE_DIR ?? join(homedir(), '.omo', 'agent', 'herdr-todo'),
      viewer: join(dirname(fileURLToPath(import.meta.url)), 'src/viewer.mjs'),
      node: () => resolveDashboardNode(),
      language: installedLanguage(),
      notify: message => ctx.ui.notify(message, 'warning') });
    controller = next;
    try { await next.start(); }
    catch (error) {
      if (controller === next) controller = undefined;
      await next.stop();
      ctx.ui.notify(error.message, 'warning');
      return;
    }
    if (current !== generation || controller !== next) return next.stop();
    next.bind(pi);
    // Do not await a peer's lifecycle handler or viewer from native dispatch.
    void next.schedule().catch(() => {});
  });
  pi.on('session_tree', (_event, ctx) => {
    if (!eligible(ctx) || !controller) return;
    void controller.rebase(ctx).catch(error => ctx.ui.notify(error.message, 'warning'));
  });
  pi.on('session_shutdown', stop);
}
