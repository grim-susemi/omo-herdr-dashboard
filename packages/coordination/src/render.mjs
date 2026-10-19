// Pure frame of the OmO collaboration pane, in the grammar the other dashboard panes share:
// `Collab [done/total]  summary`, a `─ Flow n ───` section of cards (newest at the bottom,
// scrollable), a `─ Advisor ───` section with one counts row, and the footer `Follow ON · LIVE`.
import { stripVTControlCharacters } from 'node:util';
import { fit, width } from '../../dag/src/render.mjs';
import { t } from './i18n.mjs';

const pad2 = value => String(value).padStart(2, '0');
export const clock = (iso, timeZone) => {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '--:--';
  if (timeZone === 'UTC') return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
};
// The same compact time as the worker cards: 3s, 4m 0s, 1h 2m 3s.
const duration = ms => {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const total = Math.round(ms / 1000), hours = Math.floor(total / 3600), minutes = Math.floor(total / 60) % 60;
  return [hours ? `${hours}h` : '', hours || minutes ? `${minutes}m` : '', `${total % 60}s`].filter(Boolean).join(' ');
};
const paint = (text, code, enabled) => enabled && code ? `\x1b[${code}m${text}\x1b[0m` : text;
// Parts sized to the room before they are coloured; the part that overflows ends in an ellipsis.
function partsLine(parts, room, color) {
  let used = 0, out = '';
  for (const part of parts.filter(Boolean)) {
    const left = room - used;
    if (left <= 0) break;
    const text = width(part.text) > left ? fit(part.text, left) : part.text;
    out += paint(text, part.code, color);
    used += width(text);
  }
  return out;
}
// Card colours: running cyan, done green, failed red, notes grey, kind tags magenta, time yellow.
const codes = { running: '36', done: '32', failed: '31', note: '90', kind: '35', time: '33', muted: '90', dim: '2' };
const kindKey = { notify: 'kindNotify', inspect: 'kindInspect', repair: 'kindRepair', advisor: 'kindAdvisor' };

// One card per flow event; an ask carries its reply (latency and answer row) when both are present.
export function flowCards(events, { language, timeZone, now = Date.now() } = {}) {
  const replies = new Map(), asked = new Set();
  for (const event of events) if (event.kind === 'ask') {
    if (event.phase === 'reply') replies.set(event.id, event);
    else asked.add(event.id);
  }
  const cards = [];
  for (const event of events) {
    if (event.kind === 'status' || event.kind === 'ask' && event.phase === 'reply' && asked.has(event.id)) continue;
    const answerOnly = event.kind === 'ask' && event.phase === 'reply';
    const reply = event.kind === 'ask' && !answerOnly ? replies.get(event.id) : undefined;
    const ok = reply ? reply.ok : event.ok;
    const pending = event.kind === 'ask' && !answerOnly && ok === null;
    const latency = reply?.latency_ms ?? event.latency_ms;
    const time = pending ? duration(now - Date.parse(event.ts)) : Number.isSafeInteger(latency) && latency >= 0 ? duration(latency) : '';
    const state = pending ? 'running' : ok === false ? 'failed' : event.kind === 'ask' ? 'done' : 'note';
    cards.push({ event, pending, failed: ok === false, state, time,
      who: event.to ? `${event.from}→${event.to}` : event.from,
      kind: kindKey[event.kind] ? t(language, kindKey[event.kind]) : '',
      said: answerOnly ? '' : event.summary ? (event.kind === 'ask' ? `"${event.summary}"` : event.summary) : '',
      answer: answerOnly ? event.summary ?? '' : reply?.summary ?? '',
      at: clock(event.ts, timeZone) });
  }
  return cards;
}

function cardRows(card, columns, color) {
  const icon = card.pending ? '⠋' : card.failed ? '×' : card.state === 'done' ? '✓' : '•';
  const bar = card.pending ? paint('▌', codes.running, color) : ' ';
  const room = columns - 1;
  const timeText = card.time ? ` · ⧖ ${card.time}` : '';
  const rows = [partsLine([{ text: `${icon} `, code: codes[card.state] },
    { text: fit(card.who, Math.max(4, room - 2 - width(timeText))) },
    timeText && { text: timeText, code: card.pending ? codes.time : codes.muted }], room, color)];
  rows.push(partsLine([{ text: `${card.at} `, code: codes.muted }, card.kind && { text: `${card.kind} · `, code: codes.kind },
    card.said ? { text: card.said } : card.answer && { text: `↳ ${card.answer}`, code: card.failed ? codes.failed : undefined }], room, color));
  if (card.said && card.answer) rows.push(partsLine([{ text: '↳ ', code: codes.dim },
    { text: card.answer, code: card.failed ? codes.failed : undefined }], room, color));
  return rows.map(row => `${bar}${row}`);
}

export function connection(status, events) {
  const line = events.findLast(event => event.kind === 'status');
  const state = status?.state ?? (line ? line.state ?? (line.ok ? 'connected' : 'error') : 'checking');
  const baseline = status?.baseline ?? line?.baseline ?? null;
  const protocol = status?.protocol ?? line?.protocol ?? null;
  return { state, baseline: typeof baseline === 'string' && /^[0-9a-f]{8,}$/i.test(baseline) ? baseline : null,
    protocol: typeof protocol === 'string' ? protocol : null };
}

const stateKey = { connected: 'live', 'no-carrier': 'noCarrier', disabled: 'disabled', closed: 'closed',
  checking: 'checking', error: 'error' };

// options: { columns, rows, language, follow, offset (rows above the newest), color, timeZone, now }
export function renderFrame({ status, events = [], advisor }, options = {}) {
  const language = options.language, color = options.color !== false;
  const columns = Math.max(1, (options.columns ?? 28) - 1), rows = Math.max(1, options.rows ?? 30);
  const link = connection(status, events);
  const cards = flowCards(events, options);
  const pending = cards.filter(card => card.pending).length, failed = cards.filter(card => card.failed).length;
  const healthy = link.state === 'connected' && !cards.slice(-10).some(card => card.failed);
  const divider = paint('─'.repeat(columns), codes.dim, color);
  const section = (label, active) => `${paint('─ ', codes.dim, color)}${paint(fit(label, Math.max(1, columns - 3)), active ? '1;33' : codes.dim, color)}` +
    paint(` ${'─'.repeat(Math.max(0, columns - width(label) - 3))}`, codes.dim, color);
  // Header: name and [done/total] as in every pane; a warning colour only when a card failed.
  const summary = [failed ? t(language, 'failed', { count: failed }) : '', pending ? t(language, 'wait', { count: pending }) : '']
    .filter(Boolean).join(' · ');
  // The header and footer rows sit one column in from the pane edge, as in every pane.
  const inset = columns > 1 ? ' ' : '', room = columns - inset.length;
  const head = inset + partsLine([{ text: t(language, 'name'), code: failed ? '1;33' : '1;36' },
    { text: ` [${cards.length - pending}/${cards.length}]`, code: '1;33' },
    summary && { text: `  ${summary}`, code: failed ? codes.failed : codes.muted }], room, color);
  const top = [head, divider, section(t(language, 'flow', { count: cards.length }), pending > 0)];
  const info = advisor ?? { state: 'none', consults: 0, stops: 0, last: null };
  const advisorState = t(language, info.state === 'on' ? 'advisorOn' : info.state === 'off' ? 'advisorOff' : 'advisorNone');
  const bottom = [section(`${t(language, 'advisor')} ${advisorState}${info.last ? ` ${clock(info.last, options.timeZone)}` : ''}`, info.state === 'on')];
  if (info.state === 'on' || info.consults || info.stops) bottom.push(` ${partsLine([{ text: t(language, 'stats',
    { consults: info.consults, stops: info.stops }), code: codes.muted }], columns - 1, color)}`);
  bottom.push(divider);
  const height = Math.max(0, rows - top.length - bottom.length - 1);
  const flow = [], owner = [];
  cards.forEach((card, index) => { for (const row of cardRows(card, columns, color)) { flow.push(row); owner.push(index); } });
  const maxOffset = Math.max(0, flow.length - height);
  const follow = options.follow !== false;
  const offset = follow ? 0 : Math.min(Math.max(0, options.offset ?? 0), maxOffset);
  const end = flow.length - offset, start = Math.max(0, end - height);
  const visible = flow.length ? flow.slice(start, end) : [paint(t(language, 'emptyFlow'), codes.muted, color)];
  while (visible.length < height) visible.push('');
  // Footer: the follow state and the link, as in every pane; while scrolled, the cards shown.
  const position = !follow && flow.length ? `${owner[start] + 1}–${owner[end - 1] + 1}/${cards.length}` : '';
  const footer = [t(language, follow ? 'followOn' : 'followOff'), follow || link.state !== 'connected' ? t(language, stateKey[link.state] ?? 'checking') : '',
    position].filter(Boolean).join(' · ');
  const lines = [...top, ...visible.slice(0, height), ...bottom,
    inset + paint(fit(footer, room), link.state === 'connected' ? codes.running : codes.time, color)].slice(0, rows);
  const plain = lines.map(line => stripVTControlCharacters(line));
  return { lines, text: lines.join('\n'), plain, maxOffset, height, total: cards.length, healthy };
}
