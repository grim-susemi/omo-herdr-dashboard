import { t } from './i18n.mjs';
import { clean, layers, terminal } from './model.mjs';
import { TASK_SCOPE, isExpanded } from './view-state.mjs';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function width(text) {
  let result = 0;
  for (const { segment } of segmenter.segment(clean(text))) {
    const cp = segment.codePointAt(0);
    result += /\p{Extended_Pictographic}/u.test(segment) || cp >= 0x1100 &&
      (cp <= 0x115f || cp === 0x2329 || cp === 0x232a || cp >= 0x2e80 && cp <= 0xa4cf ||
       cp >= 0xac00 && cp <= 0xd7a3 || cp >= 0xf900 && cp <= 0xfaff ||
       cp >= 0xfe10 && cp <= 0xfe6f || cp >= 0xff01 && cp <= 0xff60 || cp >= 0xffe0 && cp <= 0xffe6 ||
       cp >= 0x20000) ? 2 : 1;
  }
  return result;
}
export function fit(text, columns, pad = false) {
  text = clean(text);
  if (columns <= 0) return '';
  let out = '', used = 0;
  const truncated = width(text) > columns;
  for (const { segment } of segmenter.segment(text)) {
    const size = width(segment);
    if (used + size > columns - (truncated ? 1 : 0)) break;
    out += segment; used += size;
  }
  if (truncated) { out += '…'; used += 1; }
  return out + (pad ? ' '.repeat(Math.max(0, columns - used)) : '');
}
// Streamed output grows at its end, so keep the newest characters visible.
export function fitTail(text, columns) {
  text = clean(text);
  if (columns <= 0) return '';
  if (width(text) <= columns) return text;
  const kept = [];
  let used = 1;
  for (const segment of [...segmenter.segment(text)].map(part => part.segment).reverse()) {
    const size = width(segment);
    if (used + size > columns) break;
    kept.unshift(segment); used += size;
  }
  return `…${kept.join('')}`;
}
// A token phase with no new token, or a request with no first token, for this
// long suggests a stalled model call. Tools may legitimately run for minutes.
export const STALL_TOKEN_MS = 30000;
export const STALL_WAIT_MS = 90000;
const activityMarks = { text: '✎', thinking: '💭', toolArgs: '⚙', waiting: '⏳', tool: '▶', retry: '↻' };
const tokenPhases = new Set(['text', 'thinking', 'toolArgs']);
function compactDuration(language, ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return [hours ? t(language, 'compactHours', { count: hours }) : '',
    hours || minutes ? t(language, 'compactMinutes', { count: minutes }) : '',
    t(language, 'compactSeconds', { count: seconds % 60 })].filter(Boolean).join(' ');
}
// Liveness of a running task's model call: which phase it is in, how long ago
// it last produced output, and whether that gap looks stalled.
export function activitySummary(task, language, now = Date.now()) {
  const activity = task?.status === 'running' ? task.activity : undefined;
  if (!activity || !activityMarks[activity.phase] || !Number.isFinite(activity.since) || !Number.isFinite(activity.lastAt)) return null;
  const tokens = tokenPhases.has(activity.phase);
  const gap = now - activity.lastAt, span = now - activity.since;
  const stalled = tokens ? gap >= STALL_TOKEN_MS : activity.phase === 'waiting' && span >= STALL_WAIT_MS;
  const tool = activity.tool ? clean(activity.tool) : '';
  let label;
  if (tokens) label = [activity.phase === 'toolArgs' ? tool : '', gap < 2000 ? t(language, 'activityNow') :
    t(language, 'activityAgo', { time: compactDuration(language, gap) })].filter(Boolean).join(' ');
  else if (activity.phase === 'waiting') label = t(language, 'activityWaiting', { time: compactDuration(language, span) });
  else if (activity.phase === 'tool') label = t(language, 'activityTool', { tool: tool || '?', time: compactDuration(language, span) });
  else label = t(language, 'activityRetry', { attempt: activity.attempt ?? '?', max: activity.maxAttempts ?? '?', time: compactDuration(language, span) });
  return { head: stalled ? `⚠ ${t(language, 'activityStalled')} · ${label}` : `${activityMarks[activity.phase]} ${label}`,
    text: tokens && typeof activity.text === 'string' ? clean(activity.text) : '', stalled };
}
const icons = { pending: '○', blocked: '◌', scheduled: '◷', running: '⠋', paused: 'Ⅱ', completed: '✓', failed: '×', cancelled: '−', skipped: '·', error: '×', interrupted: '−', lost: '?' };
export const spinnerFrames = Object.freeze(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']);
const statusIcon = (status, frame = 0) => status === 'running' ?
  spinnerFrames[((Number.isInteger(frame) ? frame : 0) % spinnerFrames.length + spinnerFrames.length) % spinnerFrames.length] :
  icons[status] ?? '?';
function modelLabel(task, columns = Infinity) {
  const model = clean(task.model ?? '').replace(/^[^/\s]+\//u, '');
  const suffix = task.reasoningEffort ? `:${clean(task.reasoningEffort)}` : '';
  return fit(model, Math.max(0, columns - width(suffix))) + suffix;
}
const colors = { running: '36', completed: '32', failed: '31', blocked: '33', paused: '33', scheduled: '36', error: '31' };
const accent = '36';
// Card rows under the title: role badge, model, elapsed time and the counts after it.
const roleColors = { badge: '35', model: '32', time: '33', counts: '90' };
// Dim marks wrapped rows. Both marks measure one cell in width() and in a Herdr pane.
const dim = '2', wrapMark = '┆', timeMark = '⧖';
const paint = (text, color, enabled, heading = false) => enabled && (color || heading) ?
  `\x1b[${heading ? `1${color ? `;${color}` : ''}` : color}m${text}\x1b[0m` : text;
// Colour a known run inside an already sized plain line without changing its width.
const paintAt = (line, at, text, color, enabled) => enabled && line.startsWith(text, at) ?
  `${line.slice(0, at)}${paint(text, color, enabled)}${line.slice(at + text.length)}` : line;
const taskStatuses = new Set([...Object.keys(icons), 'error', 'interrupted', 'lost']);

export function standaloneTasks(state) {
  const linked = new Set((state?.runs ?? []).flatMap(run => run.nodes.map(node => node.taskId)));
  return (state?.tasks ?? []).filter(task => !task.parentTaskId && !linked.has(task.id))
    .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || a.id.localeCompare(b.id));
}

// Follow execution identity, not array order or the user's detail selection.
export function runningTarget(state, previous) {
  if (!state?.connected) return undefined;
  const targets = (state.runs ?? []).flatMap(run => run.nodes.filter(node => node.state === 'running')
    .map(node => ({ view: 'dag', runId: run.id, nodeId: node.id, taskId: node.taskId })));
  targets.push(...standaloneTasks(state).filter(task => task.status === 'running')
    .map(task => ({ view: 'tasks', taskId: task.id })));
  return targets.find(target => target.view === previous?.view && (target.view === 'dag' ?
    target.runId === previous.runId && target.nodeId === previous.nodeId : target.taskId === previous.taskId)) ??
    (previous?.taskId ? targets.find(target => target.taskId === previous.taskId) : undefined) ?? targets[0];
}

export function graphLines(run, columns, color = true, language = 'en', { selectedNodeId, viewState, tasks = [], now = Date.now(), graphRanges, drawnEdges, frame = 0 } = {}) {
  const output = [];
  const rows = layers(run, language);
  let previous = [];
  const glyphs = { 1: '│', 2: '─', 3: '└', 4: '│', 5: '│', 6: '┌', 7: '├', 8: '─', 9: '┘', 10: '─', 11: '┴', 12: '┐', 13: '┤', 14: '┬', 15: '┼' };
  // Compact connectors: the source box's bottom border carries the drop (┬), so
  // only the turn row and the arrow row remain, and straight edges need just the arrow.
  function connectors(current) {
    const grid = Array(columns).fill(0);
    const targets = new Set();
    let turns = false;
    for (const edge of run.edges) {
      const from = previous.find(n => n.id === edge.from), to = current.find(n => n.id === edge.to);
      if (!from || !to) continue;
      const a = from.center, b = to.center;
      grid[a] |= 1;
      if (a < b) { for (let x = a; x < b; x++) { grid[x] |= 2; grid[x + 1] |= 8; } }
      if (a > b) { for (let x = b; x < a; x++) { grid[x] |= 2; grid[x + 1] |= 8; } }
      grid[b] |= 4; targets.add(b); turns ||= a !== b;
      drawnEdges?.add(edge);
    }
    if (!targets.size) return [];
    const arrows = paint(grid.map((_, x) => targets.has(x) ? '▼' : ' ').join('').trimEnd(), accent, color);
    return turns ? [paint(grid.map(bits => glyphs[bits] ?? ' ').join('').trimEnd(), accent, color), arrows] : [arrows];
  }
  // Frontiers keep 20-cell boxes, but two boxes may shrink to 18 cells so a narrow pane still shows a fork side by side.
  const perRow = Math.max(1, Math.floor((columns + 2) / 22), Math.min(2, Math.floor((columns + 2) / 20)));
  const groups = rows.flatMap(row => Array.from({ length: Math.ceil(row.length / perRow) },
    (_, index) => ({ nodes: row.slice(index * perRow, (index + 1) * perRow), wraps: (index + 1) * perRow < row.length })));
  // Exact incoming labels and the edge list disambiguate crossings and edges which
  // skip a frontier. Wide frontiers wrap without changing their dependencies.
  for (const [index, { nodes: group, wraps }] of groups.entries()) {
    const boxWidth = Math.min(34, Math.floor((columns - 2 * (group.length - 1)) / group.length));
    const inner = Math.max(1, boxWidth - 4);
    const left = Math.floor((columns - (boxWidth * group.length + 2 * (group.length - 1))) / 2);
    const prefix = ' '.repeat(left);
    const positions = group.map((node, i) => ({ id: node.id, center: left + i * (boxWidth + 2) + Math.floor(boxWidth / 2) }));
    if (index) output.push(...connectors(positions));
    const start = output.length;
    const next = new Set(groups[index + 1]?.nodes.map(node => node.id) ?? []);
    const boxes = group.map(node => {
      const task = tasks.find(task => task.id === node.taskId);
      const activity = node.state === 'running' ? activitySummary(task, language, now) : null;
      const incoming = run.edges.filter(e => e.to === node.id).map(e => clean(e.from));
      const from = incoming.length ? `← ${incoming.join(', ')}` : '';
      const span = task ? elapsedTime(task, { now, connected: true }, node.state) : null;
      const elapsed = span ? `${timeMark} ${compactDuration(language, span.split(':').reduce((total, part) => total * 60 + Number(part), 0) * 1000)}` : '';
      const status = `${statusIcon(node.state, frame)} ${t(language, node.state)}`;
      let first = activity ? `${status} ${activity.head}` : node.error ? `${status} · ${clean(node.error)}` : status;
      if (activity?.text && inner - width(first) - 1 >= 4) first = `${first} ${fitTail(activity.text, inner - width(first) - 1)}`;
      let second = [elapsed, from].filter(Boolean).join(' · ');
      if (second && width(`${first} · ${second}`) <= inner) { first = `${first} · ${second}`; second = ''; }
      const title = fit(`${node.id === selectedNodeId ? '> ' : ''}[${isExpanded(viewState, run.id, node.id, node.state) ? '-' : '+'}] ${clean(node.label)}`, Math.max(1, boxWidth - 6));
      const half = Math.floor(boxWidth / 2);
      return { node, stalled: activity?.stalled, rows: [fit(first, inner, true), fit(second, inner, true)],
        top: `╭─ ${title} ${'─'.repeat(Math.max(0, boxWidth - 5 - width(title)))}╮`,
        bottom: run.edges.some(e => e.from === node.id && next.has(e.to)) && boxWidth >= 4 ?
          `╰${'─'.repeat(half - 1)}┬${'─'.repeat(boxWidth - half - 2)}╯` : `╰${'─'.repeat(Math.max(0, boxWidth - 2))}╯` };
    });
    output.push(prefix + boxes.map(box => paint(box.top, colors[box.node.state], color)).join('  '));
    // The second row is dropped when no box of the group has a time or dependency to show.
    const contentRows = boxes.some(box => box.rows[1].trim()) ? 2 : 1;
    for (let line = 0; line < contentRows; line++) output.push(prefix + boxes.map(box =>
      `${paint('│', colors[box.node.state], color)} ${paint(box.rows[line], line === 0 && box.stalled ? colors.paused : line === 0 ? colors[box.node.state] : undefined, color)} ${paint('│', colors[box.node.state], color)}`).join('  '));
    output.push(prefix + boxes.map(box => paint(box.bottom, colors[box.node.state], color)).join('  '));
    if (graphRanges) for (const node of group) graphRanges[node.id] = { start, end: output.length };
    if (wraps) output.push(`  · ${t(language, 'sameFrontier')}`);
    previous = positions;
  }
  return output;
}

// Continuation rows keep the hanging indent; the wrap mark sits inside it when it fits.
const wrapLead = prefix => {
  const indent = width(prefix);
  return `${' '.repeat(indent >= 2 ? indent - 2 : indent)}${wrapMark} `;
};
// Wrap at word boundaries when possible, never dropping the tail of task text.
function wrap(text, columns, prefix = '') {
  const first = Math.max(1, columns - width(prefix));
  const rest = Math.max(1, columns - width(wrapLead(prefix)));
  const result = [];
  let line = '';
  for (const { segment } of segmenter.segment(clean(text))) {
    if (line && width(line + segment) > (result.length ? rest : first)) {
      const space = line.lastIndexOf(' ');
      if (space > 0 && segment !== ' ') {
        result.push(line.slice(0, space));
        line = line.slice(space + 1);
      } else { result.push(line); line = ''; }
      if (line && width(line + segment) > rest) { result.push(line); line = ''; }
    }
    // A break consumes the space it happens at, so no row starts with one.
    if (line || segment !== ' ' || !result.length) line += segment;
  }
  if (line || !result.length) result.push(line);
  return result.map((line, index) => `${index ? wrapLead(prefix) : prefix}${line}`);
}

function elapsedTime(task, { now, connected, updatedAt }, status) {
  const start = Date.parse(task.startedAt);
  // Completion is authoritative. A terminal task without its endpoint is not
  // still running; disconnected snapshots can only use their recorded time.
  const end = task.completedAt !== undefined ? Date.parse(task.completedAt) :
    status === 'running' ? (connected ? now : Date.parse(updatedAt)) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const seconds = Math.floor((end - start) / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, '0')).join(':');
}

const measured = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function metricSummary(task, language, showReported = true) {
  const metrics = task?.metrics;
  const quality = metrics?.cost_status;
  const knownCost = measured(metrics?.cost_usd) && quality !== 'unavailable' && quality !== 'invalid';
  const badge = quality === 'reported' && !showReported ? '' :
    ` [${t(language, quality === 'reported' || quality === 'estimated' ? quality : 'metricUnknown')}]`;
  const cost = knownCost ? `${metrics.cost_usd > 0 && metrics.cost_usd < 0.0001 ?
    '<$0.0001' : `$${metrics.cost_usd.toFixed(4)}`}${badge}` :
    `${t(language, 'cost')}: ${t(language, 'metricUnknown')}`;
  const native = measured(metrics?.tokens_per_second);
  const derived = Number.isSafeInteger(metrics?.output_tokens) && metrics.output_tokens >= 0 &&
    measured(metrics?.generation_ms) && metrics.generation_ms > 0;
  const rate = native ? metrics.tokens_per_second : derived ? metrics.output_tokens * 1000 / metrics.generation_ms : undefined;
  const speed = measured(rate) ? `${native ? rate : Math.round(rate)} tok/s${native ? '' : ` [${t(language, 'estimated')}]`}` :
    `tok/s: ${t(language, 'metricUnknown')}`;
  return `${cost} · ${speed}`;
}

function metricLines(task, language) {
  const metrics = task.metrics;
  const lines = [metricSummary(task, language)];
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'total_tokens',
    'generation_ms', 'runtime_ms']) {
    const valid = key.endsWith('_tokens') ? Number.isSafeInteger(metrics?.[key]) && metrics[key] >= 0 : measured(metrics?.[key]);
    lines.push(`${t(language, key)}: ${valid ? metrics[key] : t(language, 'metricUnknown')}`);
  }
  for (const key of ['token_status', 'cost_status', 'duration_status']) {
    lines.push(`${t(language, key)}: ${metrics?.[key] === undefined ? t(language, 'metricUnknown') : clean(metrics[key])}`);
  }
  lines.push(`${t(language, 'metricSource')}: ${metrics?.source ? clean(metrics.source) : t(language, 'collectionPending')}`,
    `${t(language, 'metricReportedAt')}: ${metrics?.reportedAt ? clean(metrics.reportedAt) : t(language, 'metricUnknown')}`,
    `${t(language, 'reportedAt')}: ${task.reportedAt ? clean(task.reportedAt) : t(language, 'metricUnknown')}`);
  return lines;
}

function taskLines(task, language, timing, nodeStatus, columns) {
  const value = key => task?.[key] === undefined || task[key] === null || task[key] === '' ? t(language, 'noData') : clean(task[key]);
  if (!task) return [`${t(language, 'task')}: ${t(language, 'noData')}`];
  const lines = [`${t(language, 'task')}: ${clean(task.id)}`];
  if (task.status) lines.push(`${t(language, 'taskStatus')}: ${taskStatuses.has(task.status) ? t(language, task.status) : clean(task.status)}`);
  for (const key of ['description', ...(task.category ? ['category'] : []), 'agent', 'model', 'progress']) {
    const label = `${t(language, key)}: `;
    lines.push(`${label}${key === 'model' && task.model ? modelLabel(task, Math.max(1, columns - 4 - width(label))) : value(key)}`);
  }
  const activity = timing.connected ? activitySummary(task, language, timing.now) : null;
  if (activity) lines.push(`${t(language, 'activity')}: ${activity.head}${activity.text ? ` · ${activity.text}` : ''}`);
  const stats = [`${t(language, 'elapsed')}: ${elapsedTime(task, timing, task.status ?? nodeStatus) ?? t(language, 'noData')}`];
  for (const key of ['turns', 'toolCalls']) {
    if (task[key] !== undefined && task[key] !== null) stats.push(`${t(language, key)}: ${value(key)}`);
  }
  lines.push(stats.join(' · '));
  for (const key of ['startedAt', 'completedAt']) {
    if (task[key] !== undefined && task[key] !== null) lines.push(`${t(language, key)}: ${value(key)}`);
  }
  lines.push(...metricLines(task, language));
  return lines;
}

function compactTaskLines(task, language, timing, columns, { selected = false, node, depth = 0, collapsed = false, color = false, room: roomOverride } = {}) {
  const value = text => text === undefined || text === null || text === '' ? '-' : clean(text);
  const status = node?.state ?? task?.status;
  const duration = task ? elapsedTime(task, timing, status) : null;
  let elapsed = '';
  if (duration !== null) {
    const [hours, minutes, seconds] = duration.split(':').map(Number);
    elapsed = `${timeMark} ${[hours ? t(language, 'compactHours', { count: hours }) : '',
      hours || minutes ? t(language, 'compactMinutes', { count: minutes }) : '',
      t(language, 'compactSeconds', { count: seconds })].filter(Boolean).join(' ')}`;
  }
  const stats = [];
  for (const [key, label] of [['turns', 'compactTurns'], ['toolCalls', 'compactTools']]) {
    if (task?.[key] !== undefined && task[key] !== null) stats.push(t(language, label, { count: value(task[key]) }));
  }
  const room = Math.max(1, roomOverride ?? columns - 4);
  const depthColumns = 2 * Math.min(depth, Math.max(0, Math.floor((room - 12) / 2)));
  const indent = '';
  const marker = depth ? '↳' : selected ? '>' : ' ';
  const identity = [task?.agent, task?.category].map(part => clean(part).trim()).filter(Boolean).join('/');
  // Keep existing role/model wrapping while removing the visible child inset.
  const badge = identity ? `[${fit(identity, Math.max(1, room - depthColumns - 2))}]` : '';
  const modelRoom = room - depthColumns - (badge ? width(badge) + 1 : 0);
  // If the role badge would crowd out model:effort, the badge keeps its own row and the model follows it.
  const modelOwnRow = Boolean(task?.model) && modelRoom < width(task.reasoningEffort ? `:${task.reasoningEffort}` : '') + 2;
  const metadata = modelOwnRow ? `${indent}${badge}` :
    `${indent}${[badge, task?.model ? modelLabel(task, modelRoom) : ''].filter(Boolean).join(' ')}`;
  const titleText = `${indent}${marker} ${statusIcon(status, timing.frame)} ${collapsed ? '[+] ' : ''}${value(task?.description || node?.label)}`;
  // The elapsed time and the turn/tool counts take the card's last row, so neither the title
  // nor the activity row gives up room to them in a narrow pane.
  const counts = stats.join(' · ');
  const timeRow = [elapsed, counts].filter(Boolean).join(' · ');
  const progress = task?.progress || node?.error ? clean(task?.progress || node.error) : '';
  const lines = [
    titleText,
    metadata,
    `${indent}${progress}`,
    `${indent}${task?.metrics ? metricSummary(task, language, Boolean(node)) : ''}`,
    `${indent}${timeRow}`,
  ].map((line, index) => {
    const activity = index === 2 && timing.connected ? activitySummary(task, language, timing.now) : null;
    if (!activity) return fit(line, room);
    const head = `${indent}${activity.head}`;
    const rest = room - width(head) - 3;
    return activity.text && rest >= 4 ? `${head} · ${fitTail(activity.text, rest)}` : fit(head, room);
  });
  // Colour after sizing, and only runs that survived intact: role badge magenta, model green,
  // elapsed time yellow and the counts after it grey, so no row repeats the title's colour.
  const modelText = !modelOwnRow && task?.model ? modelLabel(task, modelRoom) : '';
  lines[1] = paintAt(lines[1], indent.length + (badge ? badge.length + 1 : 0), modelText, roleColors.model, color && Boolean(modelText));
  lines[1] = paintAt(lines[1], indent.length, badge, roleColors.badge, color && Boolean(badge));
  if (color && lines[4].trim()) {
    const timed = elapsed && lines[4].startsWith(elapsed, indent.length);
    const rest = lines[4].slice(indent.length + (timed ? elapsed.length : 0));
    lines[4] = `${indent}${timed ? paint(elapsed, roleColors.time, true) : ''}${rest ? paint(rest, roleColors.counts, true) : ''}`;
  }
  if (modelOwnRow) {
    const ownModel = modelLabel(task, room - width(indent));
    lines.splice(2, 0, paintAt(fit(`${indent}${ownModel}`, room), indent.length, ownModel, roleColors.model, color));
  }
  // Card height follows content: rows with nothing after the indent are dropped.
  return lines.filter((line, index) => !index || line.trim());
}

function taskDescendants(task, tasks) {
  // Only parentTaskId establishes ownership. DAG edges never imply subtasks.
  const visited = new Set(task ? [task.id] : []);
  const descendants = [];
  const pending = task ? tasks.filter(child => child.parentTaskId === task.id).map(child => ({ task: child, depth: 1 })) : [];
  while (pending.length) {
    const { task: child, depth } = pending.shift();
    if (visited.has(child.id)) continue;
    visited.add(child.id);
    descendants.push({ task: child, depth });
    pending.unshift(...tasks.filter(task => task.parentTaskId === child.id).map(task => ({ task, depth: depth + 1 })));
  }
  return descendants;
}

export function completedTasks(state) {
  return standaloneTasks(state).filter(task => task.status === 'completed' &&
    taskDescendants(task, state?.tasks ?? []).every(({ task: child }) =>
      terminal.has(child.status) && !['failed', 'error', 'lost'].includes(child.status)));
}

function descendantLines(task, tasks, language, timing, columns, color) {
  const descendants = taskDescendants(task, tasks);
  const title = fit(`─ ${t(language, 'subtasksCount', { count: descendants.length })} `, columns - 4);
  return descendants.length ? [title + '─'.repeat(Math.max(0, columns - 4 - width(title))),
    ...descendants.flatMap(({ task: child, depth }) =>
      compactTaskLines(child, language, timing, columns, { depth, color }))] : [];
}

function detailBox(text, columns, color, status, label) {
  const inner = Math.max(1, columns - 4);
  const border = colors[status];
  const title = label !== undefined && columns >= 7 ? `─ ${fit(label, columns - 6)} ` : '';
  return [paint(`╭${title}${'─'.repeat(Math.max(0, columns - 2 - width(title)))}╮`, border, color),
    ...text.flatMap((line, index) => {
      // Rows coloured by compactTaskLines are already sized to the card.
      if (line.includes('\x1b')) return [`${paint('│', border, color)} ${line}${' '.repeat(Math.max(0, inner - width(line)))} ${paint('│', border, color)}`];
      const colon = line.indexOf(': ');
      const prefix = index > 0 && colon >= 0 && width(line.slice(0, colon + 2)) <= inner - 4 ?
        line.slice(0, colon + 2) : line.match(/^\s*/u)[0];
      return wrap(line.slice(prefix.length), inner, prefix).map((part, row) => {
        const body = fit(part, inner, true);
        const marked = row ? paintAt(body, wrapLead(prefix).length - 2, wrapMark, dim, color) : body;
        return `${paint('│', border, color)} ${paint(marked, index === 0 ? border : undefined, color, index === 0)} ${paint('│', border, color)}`;
      });
    }),
    paint(`╰${'─'.repeat(Math.max(0, columns - 2))}╯`, border, color)];
}

// A compact card trades the box for a status-coloured bar: the title row is bold,
// a one-row card has no bar, and only the verbose inspection keeps its box.
function barCard(lines, columns, color, status) {
  const bar = lines.length > 1 ? paint('▌', colors[status], color) : ' ';
  // Rows after the title are already sized to columns - 3 (and may carry a coloured badge).
  return lines.map((line, index) => `${bar}${index ? `  ${line}` : paint(fit(line, columns - 1), colors[status], color, true)}`);
}

function taskCard(task, tasks, columns, color, language, timing, { selected, expanded, verbose, node, compactCompleted = false }) {
  const detailed = selected && verbose;
  const status = node?.state ?? task?.status;
  if (!detailed) {
    const compact = compactTaskLines(task, language, timing, columns, { selected, node, collapsed: !expanded, color, room: columns - 3 });
    const text = expanded ? [...compact, ...descendantLines(task, tasks, language, timing, columns + 1, color)] : compact.slice(0, 1);
    return barCard(compactCompleted && !expanded ? compact.slice(0, 1) : text, columns, color, status);
  }
  const compact = compactTaskLines(task, language, timing, columns, { selected, node, collapsed: false, color });
  const text = [compact[0], ...(node ? [`${clean(node.label)} (${clean(node.id)})`, `${statusIcon(node.state, timing.frame)} ${t(language, node.state)}`] : []),
    ...taskLines(task, language, timing, node?.state, columns)];
  text.push(...descendantLines(task, tasks, language, timing, columns, color));
  return detailBox(text, columns, color, status, node?.label ?? node?.id);
}

const separator = (columns, color, label) => {
  const title = label ? fit(`─ ${label} `, columns) : '';
  return paint(title + '─'.repeat(Math.max(0, columns - width(title))), dim, color);
};

const RUN_SELECTOR_LIMIT = 5;

function visibleRunSelector(runs, selectedId) {
  if (runs.length <= RUN_SELECTOR_LIMIT) return runs;
  const selected = Math.max(0, runs.findIndex(run => run.id === selectedId));
  const start = Math.min(Math.max(0, selected - RUN_SELECTOR_LIMIT + 1), runs.length - RUN_SELECTOR_LIMIT);
  return runs.slice(start, start + RUN_SELECTOR_LIMIT);
}

function runSummary(run, language, columns, selected) {
  const total = run.nodes.length;
  const running = run.nodes.filter(node => node.state === 'running').length;
  const waiting = run.nodes.filter(node => !terminalState(node.state) && node.state !== 'running').length;
  const completed = run.nodes.filter(node => node.state === 'completed').length;
  const marker = selected ? '>' : ' ';
  return fit(`${marker} ${run.name}  ${completed}/${total} ${t(language, 'total')} · ${t(language, 'runningCount', { count: running })} · ${t(language, 'waitingCount', { count: waiting })}`, columns);
}
function terminalState(status) { return terminal.has(status); }

export function renderFrame(state, { columns = 54, rows = 48, runIndex = 0, scroll = 0, color = true, error = '', language = state?.language ?? 'en',
  selectedNodeId, selectedTaskId, view, viewState, verbose = false, revealSelection = false, notice = '', now = Date.now(), completedExpanded = false,
  follow = true, runningNodeId, runningTaskId, offline = false, frame = 0, fixed = false } = {}) {
  columns = Math.max(1, columns - 1);
  rows = Math.max(1, rows);
  const all = state?.runs ?? [];
  const run = all[Math.min(Math.max(0, runIndex), Math.max(0, all.length - 1))];
  const roots = standaloneTasks(state);
  const tasksView = view === 'tasks' || !all.length;
  const activeRuns = all.filter(candidate => candidate.status === 'running' || candidate.nodes.some(node => node.state === 'running'));
  const completedRuns = all.filter(candidate => !activeRuns.includes(candidate));
  // One header row "name [done/total]  summary" under which a divider runs, the same shape as the Todo pane.
  const headLine = (name, done, total, detail) => {
    const tally = `[${done}/${total}]`, rest = columns - width(`${name} ${tally}`) - 2;
    if (rest < 0) return paint(fit(`${name} ${tally}`, columns), accent, color, true);
    return `${paint(name, accent, color, true)} ${paint(tally, roleColors.time, color, true)}${rest >= 2 && detail ? `  ${paint(fit(detail, rest), dim, color)}` : ''}`;
  };
  const rootsDone = roots.filter(task => task.status === 'completed').length;
  // The standalone viewer switches views with t, so it names the other view's count; a fixed role pane does not.
  const switchHint = fixed ? '' : tasksView ? (all.length ? ` · DAG (${all.length})` : '') : ` · ${t(language, 'tasks')} (${roots.length})`;
  const head = [headLine(t(language, 'tasks'), rootsDone, roots.length,
    `${t(language, 'runningCount', { count: roots.filter(task => task.status === 'running').length })}${switchHint}`), separator(columns, color)];
  const body = [], nodeRanges = Object.create(null), taskRanges = Object.create(null), graphRanges = Object.create(null);
  if (error) body.push(t(language, 'readError', { error: clean(error) }), t(language, 'keepLast'),
    ...(state?.connected ? [] : [t(language, 'disconnected')]), '');
  if (tasksView && (roots.length || all.length)) {
    const completed = new Set(completedTasks(state).map(task => task.id));
    if (completed.size) head[0] = headLine(t(language, 'tasks'), rootsDone, roots.length,
      `${t(language, 'runningCount', { count: roots.filter(task => task.status === 'running').length })} · ${t(language, 'completedTasks', { count: completed.size })} ${completedExpanded ? '[-]' : '[+]'}${switchHint}`);
    let cards = 0;
    for (const task of roots) {
      const compactCompleted = completed.has(task.id);
      const explicit = viewState?.expanded?.[JSON.stringify([TASK_SCOPE, task.id])];
      const protectedParent = task.status === 'completed' && !compactCompleted;
      const expanded = typeof explicit === 'boolean' ? explicit :
        protectedParent || isExpanded(viewState, TASK_SCOPE, task.id, task.status);
      if (compactCompleted && !completedExpanded && !expanded && task.id !== selectedTaskId) continue;
      if (cards++) body.push(separator(columns, color));
      const start = body.length;
      body.push(...taskCard(task, state?.tasks ?? [], columns, color, language,
        { now, connected: state?.connected, updatedAt: state?.updatedAt, frame },
        { selected: task.id === selectedTaskId, expanded, verbose, compactCompleted }));
      taskRanges[task.id] = { start, end: body.length };
    }
    if (!roots.length) body.push(t(language, 'none'));
  } else if (run && !tasksView) {
    if (all.length > 1) {
      body.push(paint(t(language, 'activeRuns', { count: activeRuns.length }), accent, color));
      const showCompleted = completedExpanded || !activeRuns.includes(run);
      const selectorRuns = visibleRunSelector([...activeRuns, ...(showCompleted ? completedRuns : [])], run.id);
      for (const candidate of selectorRuns) body.push(paint(runSummary(candidate, language, columns, candidate.id === run.id), candidate.id === run.id ? accent : undefined, color));
      if (completedRuns.length) body.push(`${t(language, 'completedRuns', { count: completedRuns.length })} ${showCompleted ? '[-]' : '[+]'}`);
      body.push('');
    }
    const done = run.nodes.filter(n => n.state === 'completed').length;
    const failed = run.nodes.filter(n => n.state === 'failed').length;
    // Run name, status and progress share one row; the graph and its ← labels carry the dependencies.
    // With several runs the row keeps naming the selected one; the selector below lists the active count.
    // A narrow pane drops the 'Selected run:' prefix before it would cut the run name itself.
    const runTail = ` · ${t(language, run.status)}${failed ? ` · ${t(language, 'failedCount', { count: failed })}` : ''}${switchHint}`;
    const prefixed = `${t(language, 'selectedRun', { name: run.name })}${runTail}`;
    const runRoom = columns - width(`DAG [${done}/${run.nodes.length}]`) - 2;
    head[0] = headLine('DAG', done, run.nodes.length,
      all.length > 1 && width(prefixed) <= runRoom ? prefixed : `${clean(run.name)}${runTail}`);
    const drawnEdges = new Set();
    try {
      const ranges = Object.create(null), start = body.length;
      body.push(...graphLines(run, columns, color, language, { selectedNodeId, viewState, tasks: state?.connected ? state.tasks ?? [] : [], now, graphRanges: ranges, drawnEdges, frame }));
      for (const [id, range] of Object.entries(ranges)) graphRanges[id] = { start: start + range.start, end: start + range.end };
    }
    catch (error) { body.push(t(language, 'graphError', { error: clean(error.message) })); }
    // Connectors draw edges between neighbouring frontiers; any other edge keeps an exact listed row.
    const undrawn = run.edges.filter(edge => !drawnEdges.has(edge));
    if (undrawn.length) body.push(separator(columns, color, t(language, 'dependencies')),
      ...undrawn.map(edge => `  ${clean(edge.from)} → ${clean(edge.to)}`));
    // Each detail card sits under a separator that names its node, as the old box border did.
    for (const node of run.nodes) {
      body.push(separator(columns, color, clean(node.label ?? node.id)));
      const start = body.length;
      body.push(...taskCard(state?.tasks?.find(task => task.id === node.taskId), state?.tasks ?? [], columns, color, language,
        { now, connected: state?.connected, updatedAt: state?.updatedAt, frame },
        { selected: node.id === selectedNodeId, expanded: isExpanded(viewState, run.id, node.id, node.state), verbose, node }));
      nodeRanges[node.id] = { start, end: body.length };
    }
    for (const node of run.nodes) if (node.error) body.push('', `× ${clean(node.id)}: ${node.error}`);
  } else {
    body.push('', `  ○  ${t(language, 'waiting')}`, '', `  ${t(language, 'waitingLine1')}`, `  ${t(language, 'waitingLine2')}`);
  }
  const narrow = columns < 40;
  const available = Math.max(0, rows - head.length - 2 - Number(Boolean(error)) - Number(Boolean(notice)));
  const selected = tasksView ? taskRanges[selectedTaskId] : nodeRanges[selectedNodeId];
  if (revealSelection && selected && available > 0) {
    if (verbose || selected.start < scroll || selected.start + Math.min(3, available) > scroll + available) scroll = selected.start;
  }
  const running = tasksView ? taskRanges[runningTaskId] : graphRanges[runningNodeId];
  if (follow && state?.connected && !revealSelection && running && available > 0 &&
      (running.start < scroll || running.end > scroll + available)) scroll = running.start;
  const start = Math.min(Math.max(0, scroll), Math.max(0, body.length - available));
  const visible = body.slice(start, start + available).map(line => {
    // Preserve ANSI colors when the already sized graph fits.
    return width(line) <= columns ? line : fit(line, columns);
  });
  if (tasksView) for (const range of Object.values(taskRanges)) {
    const from = Math.max(start, range.start), to = Math.min(start + available, range.end);
    if (to - from === 1 && (from === range.start || from === range.end - 1) &&
        /^[╭╰]─+[╮╯]$/.test(clean(body[from]))) visible[from - start] = '';
  }
  while (visible.length < available) visible.push('');
  if (!tasksView && narrow && available === 1) {
    const node = run.nodes.find(node => node.id === runningNodeId) ??
      run.nodes.find(node => graphRanges[node.id]?.start <= start && graphRanges[node.id]?.end > start) ??
      run.nodes.find(node => node.id === selectedNodeId) ?? run.nodes[0];
    if (node) visible[0] = fit(`${statusIcon(node.state, frame)} ${clean(node.label ?? node.id)}`, columns);
  }
  const range = body.length > available ? ` · ${start + 1}–${Math.min(start + available, body.length)}/${body.length}` : '';
  const live = state?.connected && !error;
  const source = offline || !state?.connected ? t(language, !state?.connected && !narrow ? 'disconnected' : 'offlineShort') :
    t(language, error ? 'error' : 'liveShort');
  const status = `${t(language, narrow ? follow && live ? 'followShortOn' : 'followShortOff' :
    follow && live ? 'followOn' : 'followOff')} · ${source}${range}`;
  const foot = [
    ...(error ? [paint(fit(t(language, offline || !state?.connected ? 'readErrorOffline' : 'readError', { error: clean(error) }), columns), colors.error, color)] : []),
    ...(notice ? [paint(fit(notice, columns), colors.paused, color)] : []),
    separator(columns, color),
    paint(fit(status, columns), live ? accent : colors.paused, color),
  ];
  return { text: [...head, ...visible, ...foot].slice(0, rows).join('\n'), scroll: start,
    bodyStart: head.length, bodyRows: available, nodeRanges, taskRanges, graphRanges };
}

export const render = (state, options) => renderFrame(state, options).text;
