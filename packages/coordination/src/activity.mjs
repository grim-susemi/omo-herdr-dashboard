// Read-only sources of the collaboration pane. Every reader returns an empty
// result for a missing, unreadable or corrupt file: the pane never fails on input.
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';

export const TAIL_BYTES = 64 * 1024;
export const MAX_EVENTS = 200;
export const KINDS = Object.freeze(['ask', 'notify', 'inspect', 'repair', 'advisor', 'status']);

// Complete lines of the last `bytes` of a file. A partial first line (cut by the
// window) and an unterminated last line (a writer mid-append) are dropped.
export function tailLines(path, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size, start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (!count) break;
      read += count;
    }
    const text = buffer.subarray(0, read).toString('utf8');
    const lines = text.split('\n');
    if (start > 0) lines.shift();
    lines.pop(); // '' after the final newline, or an unterminated line
    return lines.map(line => line.replace(/\r$/, '')).filter(Boolean);
  } catch { return []; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ } }
}

const label = value => typeof value === 'string' && value.length >= 1 && value.length <= 40;
const oneLine = value => typeof value === 'string' && !/[\r\n]/.test(value);

// One activity line (task-8/activity-schema.json, omo-agent-coordination/activity-line/1).
export function parseActivityLine(line) {
  let value;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== 'object' || value.v !== 1 || !KINDS.includes(value.kind) ||
    typeof value.ts !== 'string' || !Number.isFinite(Date.parse(value.ts)) || !label(value.from) ||
    !(value.to === null || value.to === undefined || label(value.to)) || !oneLine(value.summary) ||
    !(value.ok === true || value.ok === false || value.ok === null)) return null;
  return { ...value, to: value.to ?? null, summary: value.summary.slice(0, 160) };
}

// With `session`, only that session's lines: the mod stamps `session` on ask, notify
// and inspect lines (a child's lines carry its parent's session); lines without one
// (auto-repair) cannot be attributed to a session and are left out.
export function readActivity(path, { session } = {}) {
  const events = [];
  for (const line of tailLines(path)) {
    const event = parseActivityLine(line);
    if (event && (session === undefined || event.session === session)) events.push(event);
  }
  return events.slice(-MAX_EVENTS);
}

// The newest status line: the mod's own carrier check at session start.
export function latestStatus(events) {
  return events.findLast(event => event.kind === 'status') ?? null;
}

// Advisor summary from logs/oracle-advisor.jsonl (oracle-advisor generation-000001):
// {at, event: consult|consult_effect|nudge|gate_blocked|disabled-by-env, job_id, status, ...}.
export function readAdvisor(path) {
  const rows = [];
  for (const line of tailLines(path)) {
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && typeof row.event === 'string' && Number.isFinite(Date.parse(row.at))) rows.push(row);
    } catch { /* a corrupt line is skipped */ }
  }
  const newest = rows.at(-1);
  if (!newest) return { state: 'none', consults: 0, stops: 0, last: null };
  const job = rows.findLast(row => typeof row.job_id === 'string')?.job_id ?? null;
  const ofJob = rows.filter(row => job !== null && row.job_id === job);
  return {
    state: newest.event === 'disabled-by-env' ? 'off' : 'on', job,
    consults: ofJob.filter(row => row.event === 'consult').length,
    stops: ofJob.filter(row => row.event === 'gate_blocked').length,
    last: newest.at,
  };
}

// The controller's connection record (<state>/<parent>.status.json); null when absent or corrupt.
export function readStatus(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && value.v === 1 && typeof value.state === 'string' ? value : null;
  } catch { return null; }
}
