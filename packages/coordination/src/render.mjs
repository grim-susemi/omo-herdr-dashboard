// Pure frame of the OmO collaboration pane (design v4): header, connection and
// baseline, the recent flow (scrollable, newest at the bottom), the advisor and
// the unified footer `Follow ON · start–end/total`.
import { fit, width } from '../../dag/src/render.mjs';
import { t } from './i18n.mjs';

const pad2 = value => String(value).padStart(2, '0');
export const clock = (iso, timeZone) => {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '--:--';
  if (timeZone === 'UTC') return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
};
const seconds = ms => Number.isSafeInteger(ms) && ms >= 0 ? ` ${Math.max(0, Math.round(ms / 1000))}s` : '';

function icon(event) {
  if (event.kind === 'ask') {
    if (event.phase === 'reply' || event.ok !== null) return event.ok === false ? '❌' : '✅';
    return '❓';
  }
  if (event.ok === false) return '❌';
  return { notify: '📝', inspect: '🔍', repair: '🧹', advisor: '🔮' }[event.kind] ?? '•';
}

// Two rows per flow event: `HH:MM from→to icon[ latency]` and the quoted summary.
export function flowRows(events, { timeZone } = {}) {
  const rows = [];
  for (const event of events) {
    if (event.kind === 'status') continue;
    const pending = event.kind === 'ask' && event.ok === null && event.phase !== 'reply' ? ' ⏳' : '';
    const who = event.to ? `${event.from}→${event.to}` : event.from;
    rows.push({ event, text: `${clock(event.ts, timeZone)} ${who} ${icon(event)}${seconds(event.latency_ms)}${pending}` });
    const summary = event.summary ? (event.kind === 'ask' ? `"${event.summary}"` : event.summary) : '';
    rows.push({ event, text: ` ${summary}` });
  }
  return rows;
}

export function connection(status, events) {
  const line = events.findLast(event => event.kind === 'status');
  const state = status?.state ?? (line ? line.state ?? (line.ok ? 'connected' : 'error') : 'checking');
  const baseline = status?.baseline ?? line?.baseline ?? null;
  const protocol = status?.protocol ?? line?.protocol ?? null;
  return { state, baseline: typeof baseline === 'string' && /^[0-9a-f]{8,}$/i.test(baseline) ? baseline : null,
    protocol: typeof protocol === 'string' ? protocol : null };
}

const stateKey = { connected: 'connected', 'no-carrier': 'noCarrier', disabled: 'disabled', closed: 'closed',
  checking: 'checking', error: 'error' };

// options: { columns, rows, language, follow, offset (rows above the newest), color, timeZone }
export function renderFrame({ status, events = [], advisor }, options = {}) {
  const language = options.language;
  const columns = Math.max(1, (options.columns ?? 28) - 1), rows = Math.max(1, options.rows ?? 30);
  const divider = '─'.repeat(columns);
  const link = connection(status, events);
  const recentFailure = events.slice(-10).some(event => event.ok === false);
  const healthy = link.state === 'connected' && !recentFailure;
  const badge = t(language, healthy ? 'healthy' : 'attention');
  const head = t(language, 'header');
  const gap = Math.max(1, columns - width(head) - width(badge));
  const top = [
    width(head) + 1 + width(badge) <= columns ? `${head}${' '.repeat(gap)}${badge}` : head,
    divider,
    // 'api v1' -> 'v1' so the connection line fits a 28-column pane (v4: '코디네이션 ● 연결됨 v2').
    `${t(language, 'coordination')} ${t(language, stateKey[link.state] ?? 'checking')}${link.protocol ? ` ${link.protocol.replace(/^api /, '')}` : ''}`,
    link.baseline ? t(language, 'baseline', { hash: link.baseline.slice(0, 8) }) : t(language, 'noBaseline'),
    t(language, 'recent'),
  ];
  const info = advisor ?? { state: 'none', consults: 0, stops: 0, last: null };
  const advisorState = t(language, info.state === 'on' ? 'advisorOn' : info.state === 'off' ? 'advisorOff' : 'advisorNone');
  const flow = flowRows(events, options);
  const total = flow.filter((_, index) => index % 2 === 0).length;
  const bottomBase = [divider,
    `${t(language, 'advisor')} ${advisorState}${info.state === 'none' ? '' : ` · ${t(language, 'consults', { count: info.consults })}`}`,
    info.state === 'none' ? '' : `${t(language, 'stops', { count: info.stops })}${info.last ? t(language, 'last', { time: clock(info.last, options.timeZone) }) : ''}`,
    divider];
  const height = Math.max(0, rows - top.length - bottomBase.length - 1);
  const maxOffset = Math.max(0, flow.length - height);
  const offset = options.follow === false ? Math.min(Math.max(0, options.offset ?? 0), maxOffset) : 0;
  const end = flow.length - offset, start = Math.max(0, end - height);
  const visible = flow.length ? flow.slice(start, end).map(row => row.text) : [t(language, 'emptyFlow')];
  while (visible.length < height) visible.push('');
  // Footer counter counts flow events (two rows each), first to last shown.
  const firstEvent = flow.length ? Math.floor(start / 2) + 1 : 0, lastEvent = flow.length ? Math.ceil(end / 2) : 0;
  const footer = `${t(language, options.follow === false ? 'followOff' : 'followOn')} · ${firstEvent}–${lastEvent}/${total}`;
  const plain = [...top, ...visible.slice(0, height), ...bottomBase, footer].slice(0, rows).map(line => fit(line, columns));
  const paint = (text, code) => options.color === false ? text : `\x1b[${code}m${text}\x1b[0m`;
  const lines = plain.map((line, index) => line === divider ? paint(line, '2') :
    index === 0 ? paint(line, healthy ? '1;36' : '1;33') : line);
  return { lines, text: lines.join('\n'), plain, maxOffset, height, total, healthy };
}
