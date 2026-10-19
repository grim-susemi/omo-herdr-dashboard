import { t } from './i18n.mjs';
import { clean, layers, terminal } from './model.mjs';
import { TASK_SCOPE, isExpanded } from './view-state.mjs';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function width(text) {
  let result = 0;
  for (const { segment } of segmenter.segment(clean(text))) {
    const cp = segment.codePointAt(0);
    result += /\p{Emoji_Presentation}|\uFE0F|\u200D/u.test(segment) || cp >= 0x1100 &&
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

// A run is drawn as a lane graph (as git log --graph): one vertical lane per open branch, a status-coloured
// dot where a node sits on its lane, and a stage header row ("Step 2 0/2 ───") before each dependency stage,
// joined onto the fork or merge row when there is one. Open (running or manually expanded) nodes keep a
// worker-pane card beside their lane: a status bar (▌), the spinner by the name and detail rows under it.
// A faint dotted row parts two neighbouring cards. No node is drawn as a box.
function partsLine(parts, columns, color) {
  let used = 0, out = '';
  for (const part of parts) {
    const room = columns - used;
    if (room <= 0 || !part.text) continue;
    const text = width(part.text) > room ? fit(part.text, room) : part.text;
    out += paint(text, part.color, color, part.bold);
    used += width(text);
  }
  return out;
}
function durationText(task, timing, status, language) {
  const duration = task ? elapsedTime(task, timing, status) : null;
  return duration ? `${timeMark} ${compactDuration(language, duration.split(':').reduce((total, part) => total * 60 + Number(part), 0) * 1000)}` : '';
}
// Title row: status icon, node label, a dependency hint or else the task description (shrinks first) and elapsed
// time; only the selected title is bold.
function nodeTitle(node, task, language, timing, room, color, selected, hint = '') {
  const status = node.state;
  const label = clean(node.label ?? node.id), description = hint || clean(task?.description ?? '');
  const time = durationText(task, timing, status, language);
  const head = `${statusIcon(status, timing.frame)} ${label}`;
  const tail = time ? [{ text: ` · ${time}`, color: status === 'running' ? roleColors.time : roleColors.counts }] : [];
  const descRoom = room - width(head) - tail.reduce((sum, part) => sum + width(part.text), 0) - 2;
  const desc = description && description !== label && descRoom >= 4 ? { text: `  ${fit(description, descRoom)}` } : null;
  return partsLine([{ text: head, color: colors[status], bold: selected }, desc, ...tail].filter(Boolean), room, color);
}
// Card rows under the title: role and model, live activity or progress, counts and cost, then subtasks.
function nodeDetail(task, tasks, language, timing, room, color) {
  if (!task) return [];
  const rows = [];
  const identity = [task.agent, task.category].map(part => clean(part).trim()).filter(Boolean).join('/');
  const badge = identity ? `[${identity}]` : '', model = task.model ? modelLabel(task) : '';
  if (badge || model) rows.push(partsLine([badge && { text: badge, color: roleColors.badge },
    model && { text: `${badge ? ' ' : ''}${model}`, color: roleColors.model }].filter(Boolean), room, color));
  const activity = timing.connected ? activitySummary(task, language, timing.now) : null;
  if (activity) rows.push(partsLine([{ text: activity.head, color: activity.stalled ? colors.paused : undefined },
    activity.text && { text: ` · ${fitTail(activity.text, Math.max(1, room - width(activity.head) - 3))}`, color: dim }].filter(Boolean), room, color));
  else if (task.progress) rows.push(partsLine([{ text: clean(task.progress), color: dim }], room, color));
  const counts = [['turns', 'compactTurns'], ['toolCalls', 'compactTools']].flatMap(([key, label]) =>
    task[key] !== undefined && task[key] !== null ? [t(language, label, { count: clean(task[key]) })] : []).join(' · ');
  const cost = task.metrics ? metricSummary(task, language, false) : '';
  if (counts || cost) rows.push(partsLine([{ text: [counts, cost].filter(Boolean).join(' · '), color: roleColors.counts }], room, color));
  for (const { task: child } of taskDescendants(task, tasks)) {
    const time = foldedStatuses.has(child.status) ? '' : durationText(child, timing, child.status, language);
    rows.push(partsLine([{ text: `↳ ${statusIcon(child.status, timing.frame)} ${clean(child.description)}`, color: colors[child.status] },
      time && { text: ` · ${time}`, color: roleColors.time }].filter(Boolean), room, color));
  }
  return rows;
}
export function laneLines(run, columns, color = true, language = 'en', { selectedNodeId, viewState, tasks = [], timing = { now: Date.now(), connected: true, frame: 0 } } = {}) {
  const out = [], ranges = Object.create(null);
  const steps = layers(run, language);
  const stageOf = new Map(steps.flatMap((step, index) => step.map(node => [node.id, index])));
  const firstOf = new Set(steps.map(step => step[0]?.id));
  const line = text => paint(text, dim, color);
  const lanes = [];
  const laneCells = (own, glyph) => lanes.map((id, lane) => lane === own ? glyph : id ? line('│') : ' ').join(' ');
  const openLanes = () => lanes.map(id => id ? line('│') : ' ').join(' ');
  const lanesWidth = () => lanes.length ? 2 * lanes.length - 1 : 0;
  // A fork or merge row: two cells per lane, built plain and trimmed before it is dimmed as a whole.
  const connector = (own, joined, last, end) => line(lanes.map((id, lane) => lane === own ? `├${lane < last ? '─' : ' '}` :
    joined.includes(lane) ? `${lane === last ? end : end === '┘' ? '┴' : '┬'}${lane < last ? '─' : ' '}` :
    lane > own && lane < last ? `${id ? '┼' : '─'}─` : `${id ? '│' : ' '} `).join('').trimEnd());
  let lastConnector = -1, cardOpen = false;
  const push = (text, joinable = false) => { out.push(text); lastConnector = joinable ? out.length - 1 : -1; if (joinable) cardOpen = false; };
  const header = index => {
    cardOpen = false;
    const step = steps[index], active = step.some(node => node.state === 'running');
    const label = t(language, 'stage', { index: index + 1 }) + ` ${step.filter(node => node.state === 'completed').length}/${step.length}`;
    const tail = at => `${paint(label, active ? roleColors.time : dim, color, active)}${line(` ${'─'.repeat(Math.max(0, columns - at - width(label) - 1))}`)}`;
    if (lastConnector >= 0 && lastConnector === out.length - 1) {
      const used = width(out[lastConnector]), at = Math.max(used + 2, lanesWidth() + 2);
      out[lastConnector] += `${' '.repeat(at - used)}${tail(at)}`; lastConnector = -1;
    } else if (lanes.some(Boolean)) push(`${openLanes()}  ${tail(lanesWidth() + 2)}`);
    else push(`${line('─ ')}${tail(2)}`);
  };
  for (const node of steps.flat()) {
    const stage = stageOf.get(node.id), first = firstOf.has(node.id);
    if (first && stage === 0) header(0);
    let mine = lanes.flatMap((id, lane) => id === node.id ? [lane] : []);
    if (!mine.length) { const free = lanes.indexOf(null); mine = [free >= 0 ? free : lanes.length]; lanes[mine[0]] = node.id; }
    const own = mine[0];
    if (mine.length > 1) {
      push(connector(own, mine.slice(1), mine.at(-1), '┘'), true);
      for (const lane of mine.slice(1)) lanes[lane] = null;
      while (lanes.length > own + 1 && lanes.at(-1) === null) lanes.pop();
    }
    if (first && stage > 0) header(stage);
    const open = isExpanded(viewState, run.id, node.id, node.state);
    const bar = open ? paint('▌', colors[node.state], color) : ' ';
    const room = columns - lanesWidth() - 2;
    if (cardOpen) push(`${openLanes()} ${line('┈'.repeat(Math.max(0, columns - lanesWidth() - 1)))}`);
    cardOpen = false;
    const start = out.length, task = tasks.find(task => task.id === node.taskId);
    push(`${laneCells(own, paint('•', colors[node.state], color))} ${bar}${nodeTitle(node, task, language, timing, room, color, node.id === selectedNodeId)}`);
    const kids = run.edges.filter(edge => edge.from === node.id).map(edge => edge.to);
    if (open) {
      const under = laneCells(own, kids.length ? line('│') : ' ');
      for (const row of nodeDetail(task, tasks, language, timing, room, color)) push(`${under} ${bar}${row}`);
      cardOpen = true;
    }
    lanes[own] = kids[0] ?? null;
    const opened = [];
    for (const kid of kids.slice(1)) {
      if (lanes.includes(kid)) continue;
      const free = lanes.findIndex((id, lane) => id === null && lane > own);
      const lane = free >= 0 ? free : lanes.length;
      lanes[lane] = kid; opened.push(lane);
    }
    if (opened.length) push(connector(own, opened, Math.max(...opened), '┐'), true);
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    ranges[node.id] = { start, end: out.length };
  }
  return { rows: out, ranges };
}
// The DAG pane draws a run as a stage list: the stage header rows of the lane graph, and under each one its
// nodes listed one per row behind a single tree mark (├, └ for the last), so the left margin stays one cell
// however many nodes run in parallel (23 parallel nodes took 45 cells of lanes). A node fed by only part of
// the previous stage names its first parent (← a +2). Open nodes keep the bar card and dotted parting row.
export function stageLines(run, columns, color = true, language = 'en', { selectedNodeId, viewState, tasks = [], timing = { now: Date.now(), connected: true, frame: 0 } } = {}) {
  const out = [], ranges = Object.create(null);
  const steps = layers(run, language);
  const line = text => paint(text, dim, color);
  const labels = new Map(run.nodes.map(node => [node.id, node.label ?? node.id]));
  steps.forEach((step, index) => {
    const active = step.some(node => node.state === 'running');
    const label = t(language, 'stage', { index: index + 1 }) + ` ${step.filter(node => node.state === 'completed').length}/${step.length}`;
    out.push(`${line('─ ')}${paint(label, active ? roleColors.time : dim, color, active)}${line(` ${'─'.repeat(Math.max(0, columns - width(label) - 3))}`)}`);
    const previous = new Set(index ? steps[index - 1].map(node => node.id) : []);
    let cardOpen = false;
    step.forEach((node, at) => {
      const last = at === step.length - 1, open = isExpanded(viewState, run.id, node.id, node.state);
      const bar = open ? paint('▌', colors[node.state], color) : ' ';
      const parents = run.edges.filter(edge => edge.to === node.id).map(edge => edge.from);
      const whole = parents.length === previous.size && parents.every(id => previous.has(id));
      const hint = parents.length && !whole ? `← ${clean(labels.get(parents[0]))}${parents.length > 1 ? ` +${parents.length - 1}` : ''}` : '';
      if (cardOpen) out.push(`${line('│')} ${line('┈'.repeat(Math.max(0, columns - 2)))}`);
      cardOpen = open;
      const start = out.length, task = tasks.find(task => task.id === node.taskId);
      out.push(`${line(last ? '└' : '├')}${bar}${nodeTitle(node, task, language, timing, columns - 2, color, node.id === selectedNodeId, hint)}`);
      // An open node's card rows are the worker pane's card rows under the title, subtasks included.
      const detail = open && task ? [...compactTaskLines(task, language, timing, columns, { node, color, room: columns - 2, titleRow: false }).slice(1),
        ...descendantLines(task, tasks, language, timing, columns + 2, color)] : [];
      for (const row of detail) out.push(`${line(last ? ' ' : '│')}${bar}${row}`);
      ranges[node.id] = { start, end: out.length };
    });
  });
  return { rows: out, ranges };
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
// Tokens per second as reported, else derived from the output tokens over the generation time.
function tokenRate(metrics) {
  const native = measured(metrics?.tokens_per_second);
  const derived = Number.isSafeInteger(metrics?.output_tokens) && metrics.output_tokens >= 0 &&
    measured(metrics?.generation_ms) && metrics.generation_ms > 0;
  return { native, rate: native ? metrics.tokens_per_second : derived ? metrics.output_tokens * 1000 / metrics.generation_ms : undefined };
}
function metricSummary(task, language, showReported = true) {
  const metrics = task?.metrics;
  const quality = metrics?.cost_status;
  const knownCost = measured(metrics?.cost_usd) && quality !== 'unavailable' && quality !== 'invalid';
  const badge = quality === 'reported' && !showReported ? '' :
    ` [${t(language, quality === 'reported' || quality === 'estimated' ? quality : 'metricUnknown')}]`;
  const cost = knownCost ? `${metrics.cost_usd > 0 && metrics.cost_usd < 0.0001 ?
    '<$0.0001' : `$${metrics.cost_usd.toFixed(4)}`}${badge}` :
    `${t(language, 'cost')}: ${t(language, 'metricUnknown')}`;
  const { native, rate } = tokenRate(metrics);
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

function compactTaskLines(task, language, timing, columns, { selected = false, node, depth = 0, collapsed = false, color = false, room: roomOverride, titleRow = true } = {}) {
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
  const identity = [task?.agent, task?.category].map(part => clean(part).trim()).filter(Boolean).join('/');
  // Keep existing role/model wrapping while removing the visible child inset.
  const badge = identity ? `[${fit(identity, Math.max(1, room - depthColumns - 2))}]` : '';
  const modelRoom = room - depthColumns - (badge ? width(badge) + 1 : 0);
  // When the role badge and the whole model:effort do not fit on one row, the badge keeps its own row and the
  // model follows it, so neither is cut short only to share a row.
  const modelOwnRow = Boolean(task?.model) && Boolean(badge) && width(modelLabel(task)) > modelRoom;
  const metadata = modelOwnRow ? `${indent}${badge}` :
    `${indent}${[badge, task?.model ? modelLabel(task, modelRoom) : ''].filter(Boolean).join(' ')}`;
  const titleText = `${indent}${depth ? '↳ ' : ''}${statusIcon(status, timing.frame)} ${collapsed ? '▸ ' : ''}${value(task?.description || node?.label)}`;
  // Three rows: the title with its elapsed time, the role and model, then the speed with the turn and tool
  // counts. The cost is left to the d detail view.
  const counts = stats.join(' · ');
  const { native, rate } = tokenRate(task?.metrics);
  // The elapsed time ends the title row unless the title would keep fewer than 10 cells beside it (a narrow
  // pane or a long time); then it leads the speed row. A DAG node draws its own title row (titleRow false).
  const timeInTitle = Boolean(elapsed) && room - width(elapsed) - 3 >= Math.min(width(titleText), 10);
  const timeInStats = Boolean(elapsed) && !timeInTitle && titleRow;
  const statRow = [timeInStats ? elapsed : '', measured(rate) ? `${native ? rate : Math.round(rate)} tok/s` : '', counts]
    .filter(Boolean).join(' · ');
  // A healthy card drops its message row; a stall, a retry or a paused task keeps it.
  const live = timing.connected ? activitySummary(task, language, timing.now) : null;
  const alert = live && (live.stalled || task.activity.phase === 'retry') ? live : null;
  const held = !alert && status === 'paused' && task?.progress ? clean(task.progress) : '';
  const lines = [
    titleText,
    metadata,
    `${indent}${held}`,
    `${indent}${statRow}`,
  ].map((line, index) => {
    const activity = index === 2 ? alert : null;
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
  const timeColor = status === 'running' ? roleColors.time : roleColors.counts;
  if (color && lines[3].trim()) {
    const timed = timeInStats && lines[3].startsWith(elapsed, indent.length);
    const rest = lines[3].slice(indent.length + (timed ? elapsed.length : 0));
    lines[3] = `${indent}${timed ? paint(elapsed, timeColor, true) : ''}${rest ? paint(rest, roleColors.counts, true) : ''}`;
  }
  if (timeInTitle) {
    const head = fit(titleText, Math.max(1, room - width(elapsed) - 3));
    lines[0] = color ? `${paint(head, colors[status], true, selected)}${paint(` · ${elapsed}`, timeColor, true)}` :
      `${head} · ${elapsed}`;
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

const foldedStatuses = new Set(['completed', 'cancelled', 'skipped', 'interrupted']);
function descendantLines(task, tasks, language, timing, columns, color) {
  const descendants = taskDescendants(task, tasks);
  const title = fit(`─ ${t(language, 'subtasksCount', { count: descendants.length })} `, columns - 4);
  return descendants.length ? [title + '─'.repeat(Math.max(0, columns - 4 - width(title))),
    // A finished subtask folds to its title row; failed, blocked and running ones keep their details.
    ...descendants.flatMap(({ task: child, depth }) => {
      const lines = compactTaskLines(child, language, timing, columns, { depth, color });
      return foldedStatuses.has(child.status) ? lines.slice(0, 1) : lines;
    })] : [];
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

// A compact card trades the box for a status-coloured bar: only the selected card's title row is bold, a one-row card has no bar, and only the verbose inspection keeps its box.
function barCard(lines, columns, color, status, selected = false) {
  const bar = lines.length > 1 ? paint('▌', colors[status], color) : ' ';
  // Rows after the title are already sized to columns - 1 (and may carry a coloured badge).
  // A title row that compactTaskLines already coloured (title and elapsed time) keeps its colours.
  return lines.map((line, index) => `${bar}${index || line.includes('\x1b[') ? line : paint(fit(line, columns - 1), colors[status], color, selected)}`);
}

function taskCard(task, tasks, columns, color, language, timing, { selected, expanded, verbose, node, compactCompleted = false }) {
  const detailed = selected && verbose;
  const status = node?.state ?? task?.status;
  if (!detailed) {
    const compact = compactTaskLines(task, language, timing, columns, { selected, node, collapsed: !expanded, color, room: columns - 1 });
    const text = expanded ? [...compact, ...descendantLines(task, tasks, language, timing, columns + 3, color)] : compact.slice(0, 1);
    return barCard(compactCompleted && !expanded ? compact.slice(0, 1) : text, columns, color, status, selected);
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


export function renderFrame(state, { columns = 54, rows = 48, runIndex = 0, scroll = 0, color = true, error = '', language = state?.language ?? 'en',
  selectedNodeId, selectedTaskId, view, viewState, verbose = false, revealSelection = false, notice = '', now = Date.now(), completedExpanded = false,
  follow = true, runningNodeId, runningTaskId, offline = false, frame = 0, fixed = false } = {}) {
  columns = Math.max(1, columns - 1);
  rows = Math.max(1, rows);
  const all = state?.runs ?? [];
  const run = all[Math.min(Math.max(0, runIndex), Math.max(0, all.length - 1))];
  const roots = standaloneTasks(state);
  // The fixed DAG role stays a DAG pane with no run yet; only the standalone viewer falls back to tasks.
  const dagRole = fixed && view === 'dag';
  const tasksView = view === 'tasks' || !all.length && !dagRole;
  // One header row "name [done/total]  summary" under which a divider runs, the same shape as the Todo pane.
  // The header and footer rows sit one column in from the pane edge, as in every pane.
  const inset = columns > 1 ? ' ' : '', room = columns - inset.length;
  const headLine = (name, done, total, detail) => {
    const tally = `[${done}/${total}]`, rest = room - width(`${name} ${tally}`) - 2;
    if (rest < 0) return inset + paint(fit(`${name} ${tally}`, room), accent, color, true);
    return `${inset}${paint(name, accent, color, true)} ${paint(tally, roleColors.time, color, true)}${rest >= 2 && detail ? `  ${paint(fit(detail, rest), dim, color)}` : ''}`;
  };
  const rootsDone = roots.filter(task => task.status === 'completed').length;
  // The standalone viewer switches views with t, so it names the other view's count; a fixed role pane does not.
  const switchHint = fixed ? '' : tasksView ? (all.length ? ` · DAG (${all.length})` : '') : ` · ${t(language, 'tasks')} (${roots.length})`;
  const head = [headLine(t(language, 'tasks'), rootsDone, roots.length,
    `${t(language, 'runningCount', { count: roots.filter(task => task.status === 'running').length })}${switchHint}`), separator(columns, color)];
  if (dagRole && !run) head[0] = headLine('DAG', 0, 0, t(language, 'none'));
  const body = [], nodeRanges = Object.create(null), taskRanges = Object.create(null), graphRanges = Object.create(null);
  if (error) body.push(t(language, 'readError', { error: clean(error) }), t(language, 'keepLast'),
    ...(state?.connected ? [] : [t(language, 'disconnected')]), '');
  if (tasksView && (roots.length || all.length)) {
    const completed = new Set(completedTasks(state).map(task => task.id));
    if (completed.size) head[0] = headLine(t(language, 'tasks'), rootsDone, roots.length,
      `${t(language, 'runningCount', { count: roots.filter(task => task.status === 'running').length })} · ${t(language, 'completedTasks', { count: completed.size })} ${completedExpanded ? '▾' : '▸'}${switchHint}`);
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
    // No run list above the flow: ←→ switches runs and the footer names the position (Run 1/7).
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
    const timing = { now, connected: state?.connected, updatedAt: state?.updatedAt, frame };
    try {
      const { rows: flow, ranges } = stageLines(run, columns, color, language, { selectedNodeId, viewState, tasks: state?.tasks ?? [], timing });
      const start = body.length;
      body.push(...flow);
      for (const [id, range] of Object.entries(ranges)) graphRanges[id] = nodeRanges[id] = { start: start + range.start, end: start + range.end };
    }
    catch (error) { body.push(t(language, 'graphError', { error: clean(error.message) })); }
    // d still opens the full detail of the selected node, under the cards.
    const inspected = verbose && run.nodes.find(node => node.id === selectedNodeId);
    if (inspected) {
      const start = body.length;
      body.push(...taskCard(state?.tasks?.find(task => task.id === inspected.taskId), state?.tasks ?? [], columns, color, language,
        timing, { selected: true, expanded: true, verbose, node: inspected }));
      nodeRanges[inspected.id] = { start, end: body.length };
    }
    for (const node of run.nodes) if (node.error) body.push('', `× ${clean(node.id)}: ${node.error}`);
  } else {
    // An empty pane names its own role: the worker pane waits for workers, the DAG pane for a run.
    const [first, line1, line2] = view === 'tasks' ? ['noWorkers', 'noWorkersLine1', 'noWorkersLine2'] :
      ['waiting', 'waitingLine1', 'waitingLine2'];
    body.push('', `  ○  ${t(language, first)}`, '', paint(`  ${t(language, line1)}`, dim, color), paint(`  ${t(language, line2)}`, dim, color));
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
  if (!tasksView && run && narrow && available === 1) {
    const node = run.nodes.find(node => node.id === runningNodeId) ??
      run.nodes.find(node => graphRanges[node.id]?.start <= start && graphRanges[node.id]?.end > start) ??
      run.nodes.find(node => node.id === selectedNodeId) ?? run.nodes[0];
    if (node) visible[0] = fit(`${statusIcon(node.state, frame)} ${clean(node.label ?? node.id)}`, columns);
  }
  const runPosition = !tasksView && run && all.length > 1 ? ` · ${t(language, 'runPosition', { index: all.indexOf(run) + 1, total: all.length })}` : '';
  const range = `${runPosition}${body.length > available ? ` · ${start + 1}–${Math.min(start + available, body.length)}/${body.length}` : ''}`;
  const live = state?.connected && !error;
  const source = offline || !state?.connected ? t(language, !state?.connected && !narrow ? 'disconnected' : 'offlineShort') :
    t(language, error ? 'error' : 'liveShort');
  const status = `${t(language, narrow ? follow && live ? 'followShortOn' : 'followShortOff' :
    follow && live ? 'followOn' : 'followOff')} · ${source}${range}`;
  const foot = [
    ...(error ? [paint(fit(t(language, offline || !state?.connected ? 'readErrorOffline' : 'readError', { error: clean(error) }), columns), colors.error, color)] : []),
    ...(notice ? [paint(fit(notice, columns), colors.paused, color)] : []),
    separator(columns, color),
    inset + paint(fit(status, room), live ? accent : colors.paused, color),
  ];
  return { text: [...head, ...visible, ...foot].slice(0, rows).join('\n'), scroll: start,
    bodyStart: head.length, bodyRows: available, nodeRanges, taskRanges, graphRanges };
}

export const render = (state, options) => renderFrame(state, options).text;
