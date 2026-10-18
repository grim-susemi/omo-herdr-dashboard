// OmO collaboration pane controller (in the OmO process). It records the
// coordination connection for the viewer and places one pane as the leftmost
// cell of the dashboard's lower row: collab | workers | DAG (v4: 28 | 28 | 30 of 86).
// Only Herdr CLI calls are made; no process-identity (PowerShell/WMI) query is
// ever started here, so no mutate path can spawn one.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJson } from '../../dag/src/storage.mjs';
import { shellCommand } from '../../dag/src/herdr.mjs';

export const API_KEY = Symbol.for('omo.agent-coordination.api.v1');
// The mod publishes its broker lazily through this accessor (its public-api getCoordinationBroker).
export const API_READY_KEY = Symbol.for('omo.agent-coordination.api-ready.v1');
// Owner-confirmed v4 widths of the lower row, measured on a 172x46 window.
export const LOWER_ROW = Object.freeze({ collab: 28, workers: 28, dag: 30 });
export const PLACE_INTERVAL_MS = 2000;
export const PLACE_ATTEMPTS = 30;

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

export class CoordinationPane {
  constructor({ stateDir, dagStateDir, receiptPath, activityPath, advisorPath, parentPane, sessionId, cwd,
    herdr, node, viewer, language = 'en', host = globalThis, env = process.env,
    interval = PLACE_INTERVAL_MS, attempts = PLACE_ATTEMPTS, timers = { setTimeout, clearTimeout } }) {
    Object.assign(this, { stateDir, dagStateDir, receiptPath, activityPath, advisorPath, parentPane, sessionId, cwd,
      herdr, node, viewer, language, host, env, interval, attempts, timers });
    this.statusFile = join(stateDir, `${safeKey(parentPane)}.status.json`);
    this.recordFile = join(stateDir, `${safeKey(parentPane)}.pane.json`);
    this.stopped = false;
    this.state = 'waiting';
  }
  async writeStatus(override) {
    const status = override ?? await connectionStatus({ host: this.host, env: this.env, receiptPath: this.receiptPath });
    await writeJson(this.statusFile, { v: 1, ...status, sessionId: this.sessionId, parentPaneId: this.parentPane,
      pid: process.pid, at: new Date().toISOString() });
    return status;
  }
  async start() {
    await this.writeStatus();
    if (this.env.OMO_HERDR_COORDINATION_PANE === '0') { this.state = 'disabled'; return; }
    let left = this.attempts;
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.writeStatus();
        if (await this.placeOnce()) return;
      } catch (error) { this.lastError = error?.message ?? String(error); }
      if (--left > 0 && !this.stopped) this.timer = this.timers.setTimeout(() => { void tick(); }, this.interval);
      else if (!this.stopped) this.state = 'waiting-timeout';
    };
    await tick();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) this.timers.clearTimeout(this.timer);
    try { await this.writeStatus({ state: 'closed', protocol: null, baseline: (await readJson(this.statusFile).catch(() => null))?.baseline ?? null }); }
    catch { /* the viewer shows the last state */ }
  }
  // Workers and DAG pane ids from the DAG controller's own records whose panes are in this tab.
  async dashboardIds(layout) {
    const live = new Set((layout?.panes ?? []).map(pane => pane?.pane_id));
    const found = {};
    let keys = [];
    try { keys = (await readdir(this.dagStateDir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); }
    catch { return found; }
    for (const key of keys) for (const role of ['workers', 'dag']) {
      const record = await readJson(join(this.dagStateDir, key, `${role}.pane.json`)).catch(() => null);
      if (record?.role === role && record.ready === true && !record.manualClose && live.has(record.paneId) &&
        (!record.tabId || record.tabId === layout.tab_id)) found[role] = record.paneId;
    }
    return found;
  }
  // One placement attempt: true when the pane is (already) in place or must not be placed.
  async placeOnce() {
    const layout = (await this.herdr('layout', '--pane', this.parentPane))?.layout;
    if (!layout?.panes) return false;
    const record = await readJson(this.recordFile).catch(() => null);
    const live = id => layout.panes.some(pane => pane?.pane_id === id);
    if (record?.paneId && live(record.paneId)) { this.state = 'current'; return true; }
    // An owner close holds for the session that saw it; the next session reopens the pane.
    if (record?.manualClose && record.sessionId === this.sessionId) { this.state = 'closed-by-owner'; return true; }
    const ids = await this.dashboardIds(layout);
    const row = ids.workers && ids.dag && lowerRow(layout, ids);
    if (!row) { this.state = 'waiting-dashboard'; return false; }
    // Split only once the dashboard pass has settled: the same lower row on two consecutive ticks.
    const settled = JSON.stringify([ids, row]);
    if (this.lastRow !== settled) { this.lastRow = settled; this.state = 'waiting-settle'; return false; }
    const widths = lowerRowWidths(row.total);
    if (widths.collab < 12 || widths.dag < 12) { this.state = 'too-narrow'; return true; }
    const created = await this.herdr('split', '--pane', ids.workers, '--direction', 'right', '--ratio', '0.5',
      '--cwd', this.cwd, '--no-focus');
    const paneId = created?.pane?.pane_id;
    if (!paneId) throw new Error('collaboration split returned no pane id');
    const next = { v: 1, paneId, tabId: layout.tab_id, parentPaneId: this.parentPane, sessionId: this.sessionId,
      workers: ids.workers, dag: ids.dag, createdAt: new Date().toISOString(), phase: 'split' };
    await writeJson(this.recordFile, next);
    // The split opened right of the workers pane; the swap makes collaboration the leftmost cell.
    await this.herdr('swap', '--source-pane', paneId, '--target-pane', ids.workers);
    // Grow the (collab | workers) group so the DAG keeps its v4 share; the inner split stays 1:1.
    const current = row.workers.width / row.total, desired = (widths.collab + widths.workers) / row.total;
    if (Math.abs(current - desired) * row.total >= 1)
      await this.herdr('resize', '--pane', ids.workers, '--direction', desired > current ? 'right' : 'left',
        '--amount', String(Math.abs(current - desired)));
    await this.herdr('run', paneId, shellCommand([await this.node(), this.viewer, '--status', this.statusFile,
      '--activity', this.activityPath, '--advisor', this.advisorPath, '--record', this.recordFile,
      '--lang', this.language, '--close-pane', paneId]));
    // The chat keeps the input: if the new cell took the focus, hand it back to the chat on its left.
    if ((await this.herdr('get', paneId).catch(() => null))?.pane?.focused === true)
      await this.herdr('focus', '--pane', paneId, '--direction', 'left').catch(() => {});
    const placed = (await this.herdr('layout', '--pane', this.parentPane))?.layout;
    const rect = placed?.panes?.find(pane => pane.pane_id === paneId)?.rect;
    await writeJson(this.recordFile, { ...next, phase: 'running', rect: rect ?? null, expected: widths });
    this.state = 'current';
    return true;
  }
}
