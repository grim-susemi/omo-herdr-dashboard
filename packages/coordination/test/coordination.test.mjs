import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseActivityLine, readActivity, readAdvisor, readStatus, tailLines } from '../src/activity.mjs';
import { renderFrame } from '../src/render.mjs';
import { CoordinationPane, advisorSummary, connectionStatus, lowerRowWidths, ADVISOR_KEY, API_KEY, API_READY_KEY } from '../src/controller.mjs';
import { parseArgs, snapshot } from '../src/viewer.mjs';
import { width } from '../../dag/src/render.mjs';

const directory = () => mkdtempSync(join(tmpdir(), 'omo-coordination-'));
const line = value => JSON.stringify(value) + '\n';
const ask = { v: 1, ts: '2026-10-18T08:22:05.000Z', kind: 'ask', phase: 'request', id: 'q-1', from: '리드', to: '워커A',
  summary: '레인2 상태 어때?', ok: null, mode: 'quick' };
const reply = { ...ask, ts: '2026-10-18T08:22:08.000Z', phase: 'reply', from: '워커A', to: '리드', summary: '빌드 중, 3분 남음',
  ok: true, latency_ms: 3000 };

test('missing, corrupt and half-written activity files read as an empty or partial list', () => {
  const dir = directory();
  try {
    assert.deepEqual(readActivity(join(dir, 'absent.jsonl')), []);
    const file = join(dir, 'activity.jsonl');
    writeFileSync(file, 'not json\n' + line({ ...ask, v: 2 }) + line({ ...ask, summary: 'a\nb' }) + line(ask) + '{"v":1,"ts"');
    assert.deepEqual(readActivity(file).map(event => event.id), ['q-1']);
    assert.equal(parseActivityLine(JSON.stringify({ ...ask, kind: 'other' })), null);
    assert.equal(parseActivityLine(JSON.stringify({ ...ask, to: undefined })).to, null);
    assert.deepEqual(readStatus(join(dir, 'absent.json')), null);
    writeFileSync(join(dir, 'status.json'), '{broken');
    assert.equal(readStatus(join(dir, 'status.json')), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a session filter keeps only that session\'s lines, so the flow and the badge differ per pane', () => {
  const dir = directory();
  try {
    const file = join(dir, 'activity.jsonl');
    const repair = { v: 1, ts: ask.ts, kind: 'repair', from: 'auto-repair', to: null, summary: 'settled t1 run 1', ok: true, phase: 'done' };
    writeFileSync(file, line({ ...ask, id: 'a', session: 's1' }) + line({ ...ask, id: 'b', session: 's2' }) + line(repair) +
      line({ ...reply, id: 'c', session: 's1', ok: false }));
    assert.deepEqual(readActivity(file).map(event => event.id ?? event.kind), ['a', 'b', 'repair', 'c']);
    assert.deepEqual(readActivity(file, { session: 's1' }).map(event => event.id), ['a', 'c']);
    assert.deepEqual(readActivity(file, { session: 's2' }).map(event => event.id), ['b']);
    assert.deepEqual(readActivity(file, { session: 's3' }), []);
    const status = { v: 1, state: 'connected', protocol: 'api v1' };
    const head = session => renderFrame({ status, events: readActivity(file, { session }) },
      { columns: 28, rows: 30, language: 'ko', color: false }).plain[0];
    assert.equal(head('s1'), ' Collab [1/2]  ×1 · wait 1');
    assert.equal(head('s2'), ' Collab [0/1]  wait 1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the viewer snapshot filters by --session and takes the advisor from the status file', () => {
  const dir = directory();
  try {
    const [statusFile, activityFile, advisorFile] = ['status.json', 'activity.jsonl', 'oracle-advisor.jsonl'].map(name => join(dir, name));
    writeFileSync(activityFile, line({ ...ask, id: 'a', session: 's1' }) + line({ ...ask, id: 'b', session: 's2' }));
    writeFileSync(advisorFile, line({ at: '2026-10-18T01:00:00.000Z', event: 'consult', job_id: 'J9' }));
    const own = { state: 'on', job: 'J1', consults: 1, stops: 0, last: null };
    writeFileSync(statusFile, JSON.stringify({ v: 1, state: 'connected', advisor: own }));
    const options = parseArgs(['--status', statusFile, '--activity', activityFile, '--advisor', advisorFile, '--session', 's1']);
    assert.equal(options.session, 's1');
    assert.deepEqual(snapshot(options).events.map(event => event.id), ['a']);
    assert.deepEqual(snapshot(options).advisor, own);
    // A status file without an advisor record falls back to an explicit --advisor log.
    writeFileSync(statusFile, JSON.stringify({ v: 1, state: 'connected' }));
    assert.equal(snapshot(options).advisor.job, 'J9');
    assert.equal(snapshot({ ...options, advisor: undefined }).advisor, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('advisor summary reads this process\'s advisor job, not the newest job of any session', () => {
  assert.deepEqual(advisorSummary({}), { state: 'none', consults: 0, stops: 0, last: null });
  assert.equal(advisorSummary({ [ADVISOR_KEY]: { disabled: true, runtime: null } }).state, 'off');
  const job = { job_id: 'J1', status: 'active', opened_at: '2026-10-20T00:00:00.000Z', counters: { consults: 2 },
    stops: { S1: { status: 'open' }, S2: { status: 'overridden' } } };
  const host = (status, facts) => ({ [ADVISOR_KEY]: { runtime: { getSessionStatus: () => status, ledger: { jobFacts: facts } } } });
  assert.deepEqual(advisorSummary(host('lead', job)), { state: 'on', job: 'J1', consults: 2, stops: 1, last: '2026-10-20T00:00:00.000Z' });
  assert.equal(advisorSummary(host('lead', job), '2026-10-20T01:00:00.000Z').last, '2026-10-20T01:00:00.000Z');
  assert.equal(advisorSummary(host('lead', { ...job, status: 'paused' })).state, 'off');
  assert.equal(advisorSummary(host('lead', null)).state, 'none');
  assert.equal(advisorSummary(host('child', job)).state, 'none');
  const broken = { [ADVISOR_KEY]: { runtime: { getSessionStatus() { throw new Error('gone'); } } } };
  assert.equal(advisorSummary(broken).state, 'none');
});

test('advisor ledger events rewrite the status file once per window and stop unsubscribes', async () => {
  const dir = directory();
  try {
    const listeners = new Set();
    let facts = null;
    const ledger = { get jobFacts() { return facts; }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
    const host = { [ADVISOR_KEY]: { runtime: { getSessionStatus: () => 'lead', ledger } } };
    const pending = [];
    const timers = { setTimeout(callback) { pending.push(callback); return pending.length; }, clearTimeout() {} };
    const controller = new CoordinationPane({ stateDir: dir, dagStateDir: join(dir, 'dag'), parentPane: 'P', sessionId: 's1',
      cwd: dir, herdr: async () => ({}), node: async () => 'node', viewer: 'viewer.mjs', activityPath: 'a.jsonl',
      host, env: { OMO_HERDR_COORDINATION_PANE: '0' }, timers });
    await controller.start();
    assert.equal(readStatus(controller.statusFile).advisor.state, 'none');
    assert.equal(listeners.size, 1);
    facts = { job_id: 'J1', status: 'active', opened_at: '2026-10-20T00:00:00.000Z', counters: { consults: 0 }, stops: {} };
    for (const listener of listeners) { listener({ type: 'job_opened' }); listener({ type: 'trigger_state_recorded' }); }
    assert.equal(pending.length, 1);
    await pending.shift()();
    const advisor = readStatus(controller.statusFile).advisor;
    assert.equal(advisor.state, 'on');
    assert.equal(advisor.job, 'J1');
    assert.ok(Number.isFinite(Date.parse(advisor.last)));
    // Bookkeeping entries alone do not move the last-activity time.
    const before = controller.advisorLast;
    for (const listener of listeners) listener({ type: 'progress_recorded' });
    assert.equal(controller.advisorLast, before);
    assert.equal(pending.length, 1);
    // A listener that cannot schedule never throws into the advisor's append.
    pending.length = 0;
    controller.advisorTimer = undefined;
    const throwing = { ...timers, setTimeout() { throw new Error('no timers'); } };
    controller.timers = throwing;
    for (const listener of listeners) assert.doesNotThrow(() => listener({ type: 'consult_started' }));
    controller.timers = timers;
    await controller.stop();
    assert.equal(listeners.size, 0);
    assert.equal(readStatus(controller.statusFile).state, 'closed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the tail window drops the partial first line and keeps the newest complete lines', () => {
  const dir = directory();
  try {
    const file = join(dir, 'activity.jsonl');
    for (let index = 0; index < 50; index++) appendFileSync(file, line({ ...ask, id: `q-${index}` }));
    const lines = tailLines(file, 1000);
    assert.ok(lines.length > 0 && lines.length < 50);
    assert.equal(JSON.parse(lines.at(-1)).id, 'q-49');
    assert.ok(lines.every(text => JSON.parse(text)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('advisor summary counts consults and gate stops of the newest job', () => {
  const dir = directory();
  try {
    const file = join(dir, 'oracle-advisor.jsonl');
    assert.deepEqual(readAdvisor(file), { state: 'none', consults: 0, stops: 0, last: null });
    writeFileSync(file, line({ at: '2026-10-18T01:00:00.000Z', event: 'consult', job_id: 'J1' }) +
      line({ at: '2026-10-18T02:00:00.000Z', event: 'consult', job_id: 'J2' }) + 'garbage\n' +
      line({ at: '2026-10-18T02:05:00.000Z', event: 'consult', job_id: 'J2' }) +
      line({ at: '2026-10-18T02:10:00.000Z', event: 'gate_blocked', job_id: 'J2' }));
    assert.deepEqual(readAdvisor(file), { state: 'on', job: 'J2', consults: 2, stops: 1, last: '2026-10-18T02:10:00.000Z' });
    appendFileSync(file, line({ at: '2026-10-18T03:00:00.000Z', event: 'disabled-by-env', status: 'disabled-by-env' }));
    assert.equal(readAdvisor(file).state, 'off');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a 28x30 frame shows the shared header, a flow card per ask, the advisor section and the follow footer', () => {
  const status = { v: 1, state: 'connected', protocol: 'api v1', baseline: 'eb2db2c195edcf8e42dac8944535b7df85ad6e90fe1c806676573296799b2287' };
  const advisor = { state: 'on', consults: 2, stops: 0, last: '2026-10-18T08:10:00.000Z' };
  const options = { columns: 28, rows: 30, language: 'ko', color: false, timeZone: 'UTC' };
  const frame = renderFrame({ status, events: [ask, reply], advisor }, options);
  assert.equal(frame.plain.length, 30);
  assert.ok(frame.plain.every(row => width(row) <= 27));
  // Name [done/total] as in the other panes; the ask and its reply are one card.
  assert.equal(frame.plain[0], ' Collab [1/1]');
  assert.match(frame.plain[2], /^─ Flow 1 ─+$/);
  assert.equal(frame.plain[3], ' ✓ 리드→워커A · ⧖ 3s');
  assert.equal(frame.plain[4], ' 08:22 "레인2 상태 어때?"');
  assert.equal(frame.plain[5], ' ↳ 빌드 중, 3분 남음');
  assert.match(frame.plain.at(-4), /^─ Advisor ● on 08:10 ─+$/);
  assert.equal(frame.plain.at(-3), ' 2 consults · 0 STOP');
  assert.equal(frame.plain.at(-1), ' Follow ON · LIVE');
  // The connection and baseline rows are gone: the link is named in the footer only.
  assert.ok(!frame.plain.some(row => /baseline|v1/.test(row)));
  // A waiting ask carries the running bar, spinner and elapsed time of a running worker card.
  const waiting = renderFrame({ status, events: [ask] }, { ...options, now: Date.parse(ask.ts) + 45000 });
  assert.equal(waiting.plain[0], ' Collab [0/1]  wait 1');
  assert.equal(waiting.plain[3], '▌⠋ 리드→워커A · ⧖ 45s');
  const colored = renderFrame({ status, events: [ask, reply], advisor }, { ...options, color: true });
  assert.deepEqual(colored.plain, frame.plain);
  assert.ok(colored.text.includes('\x1b[1;36mCollab'));
  // The real 28-column pane gives the viewer about 25 columns: header and footer fit whole.
  for (const language of ['ko', 'en', 'zh-cn']) {
    const narrow = renderFrame({ status, events: [ask, reply] }, { columns: 25, rows: 30, language, color: false });
    for (const row of [narrow.plain[0], narrow.plain.at(-1)]) assert.ok(!row.endsWith('…'), `${language}: ${row}`);
  }
});

test('an empty or unknown state renders the empty frame without an error or a warning', () => {
  const frame = renderFrame({ status: null, events: [], advisor: undefined }, { columns: 28, rows: 30, language: 'ko', color: false });
  assert.equal(frame.plain[0], ' Collab [0/0]');
  assert.ok(frame.plain.includes(' (no collaboration yet)'));
  assert.match(frame.plain.at(-3), /^─ Advisor ○ no record ─+$/);
  assert.equal(frame.plain.at(-1), ' Follow ON · checking');
  // Only a failed card raises a warning; an unconnected pane does not.
  assert.ok(!frame.plain.some(row => row.includes('⚠')));
});

test('scrolling up pauses follow and the counter names the cards shown', () => {
  const events = Array.from({ length: 20 }, (_, index) => ({ ...reply, id: `q-${index}` }));
  const frame = renderFrame({ status: { state: 'connected' }, events }, { columns: 28, rows: 16, language: 'ko', color: false, follow: false, offset: 4 });
  // 16 rows leave 10 flow rows = 5 two-row cards; 4 rows up from the newest shows cards 14 to 18.
  assert.equal(frame.plain.at(-1), ' Follow OFF · 14–18/20');
});

test('the lower row splits 86 columns into the measured 28 | 28 | 30', () => {
  assert.deepEqual(lowerRowWidths(86), { collab: 28, workers: 28, dag: 30 });
});

test('connection status reads the mod broker, the off switch and the install baseline', async () => {
  const dir = directory();
  try {
    const receiptPath = join(dir, 'receipt.json');
    writeFileSync(receiptPath, JSON.stringify({ adapter: { baseline_sha256: 'eb2db2c195edcf8e42dac8944535b7df85ad6e90fe1c806676573296799b2287' } }));
    const host = { [API_KEY]: { version: 1, features: [], getClient() {} } };
    assert.equal((await connectionStatus({ host, env: {}, receiptPath })).state, 'connected');
    assert.equal((await connectionStatus({ host: {}, env: {}, receiptPath })).state, 'no-carrier');
    assert.equal((await connectionStatus({ host: { [API_READY_KEY]: () => host[API_KEY] }, env: {}, receiptPath })).state, 'connected');
    assert.equal((await connectionStatus({ host, env: { OMO_AGENT_COORDINATION: '0' }, receiptPath })).state, 'disabled');
    assert.equal((await connectionStatus({ host: {}, env: {}, receiptPath: join(dir, 'absent') })).baseline, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('placement splits workers, swaps the new pane leftmost, resizes the group and runs the viewer once', async () => {
  const dir = directory();
  try {
    const dagStateDir = join(dir, 'dag');
    const key = join(dagStateDir, 'k1');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(key, { recursive: true });
    writeFileSync(join(key, 'workers.pane.json'), JSON.stringify({ role: 'workers', paneId: 'W', tabId: 't1', ready: true }));
    writeFileSync(join(key, 'dag.pane.json'), JSON.stringify({ role: 'dag', paneId: 'G', tabId: 't1', ready: true }));
    const pane = (id, x, y, w, h) => ({ pane_id: id, rect: { x, y, width: w, height: h } });
    let panes = [pane('P', 0, 0, 86, 46), pane('T', 86, 0, 86, 16), pane('W', 86, 16, 34, 30), pane('G', 120, 16, 52, 30)];
    const calls = [];
    const herdr = async (...args) => {
      calls.push(args.join(' '));
      if (args[0] === 'layout') return { layout: { tab_id: 't1', panes } };
      if (args[0] === 'split') { panes = [...panes, pane('C', 103, 16, 17, 30)]; return { pane: { pane_id: 'C' } }; }
      if (args[0] === 'close') panes = panes.filter(entry => entry.pane_id !== args[1]);
      return {};
    };
    const controller = new CoordinationPane({ stateDir: join(dir, 'state'), dagStateDir, parentPane: 'P', sessionId: 's1',
      cwd: dir, herdr, node: async () => 'node', viewer: 'viewer.mjs', activityPath: 'a.jsonl',
      host: {}, env: {} });
    // The first look only records the lower row; the split waits for the same row on the next tick.
    assert.equal(await controller.placeOnce(), false);
    assert.equal(controller.state, 'waiting-settle');
    assert.equal(await controller.placeOnce(), true);
    assert.equal(controller.state, 'current');
    assert.deepEqual(calls.map(call => call.split(' ')[0]), ['layout', 'layout', 'split', 'swap', 'resize', 'run', 'get', 'layout']);
    assert.match(calls[2], /^split --pane W --direction right --ratio 0\.5/);
    assert.equal(calls[3], 'swap --source-pane C --target-pane W');
    assert.match(calls[4], /^resize --pane W --direction right --amount 0\.2558/);
    // The viewer filters the shared flow to this session and no longer reads the shared advisor log.
    assert.match(calls[5], /'--session' 's1'/);
    assert.doesNotMatch(calls[5], /--advisor/);
    // A second session start finds its live pane and mutates nothing.
    calls.length = 0;
    assert.equal(await new CoordinationPane({ ...controller }).placeOnce(), true);
    assert.deepEqual(calls, ['layout --pane P']);
    // A new session in the same chat pane replaces the viewer that filters on the old session.
    calls.length = 0;
    const next = new CoordinationPane({ ...controller, sessionId: 's2' });
    assert.equal(await next.placeOnce(), false);
    assert.equal(next.state, 'replacing');
    assert.deepEqual(calls, ['layout --pane P', 'close C']);
    assert.equal(await next.placeOnce(), false);
    assert.equal(await next.placeOnce(), true);
    assert.match(calls.find(call => call.startsWith('run ')), /'--session' 's2'/);
    const record = JSON.parse(readFileSync(next.recordFile, 'utf8'));
    assert.equal(record.sessionId, 's2');
    assert.equal(record.viewer, 'viewer.mjs');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a live pane recorded by an older build (no viewer field) is replaced once', async () => {
  const dir = directory();
  try {
    const stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'P.pane.json'), JSON.stringify({ v: 1, paneId: 'C', parentPaneId: 'P', sessionId: 's1', phase: 'running' }));
    const calls = [];
    const herdr = async (...args) => {
      calls.push(args.join(' '));
      if (args[0] === 'layout') return { layout: { tab_id: 't1', panes: [{ pane_id: 'P', rect: {} }, { pane_id: 'C', rect: {} }] } };
      return {};
    };
    const controller = new CoordinationPane({ stateDir, dagStateDir: join(dir, 'dag'), parentPane: 'P', sessionId: 's1', cwd: dir,
      herdr, node: async () => 'node', viewer: 'viewer.mjs', activityPath: 'a.jsonl', host: {}, env: {} });
    assert.equal(await controller.placeOnce(), false);
    assert.equal(controller.state, 'replacing');
    assert.deepEqual(calls, ['layout --pane P', 'close C']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
