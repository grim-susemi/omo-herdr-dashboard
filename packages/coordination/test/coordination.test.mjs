import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseActivityLine, readActivity, readAdvisor, readStatus, tailLines } from '../src/activity.mjs';
import { renderFrame } from '../src/render.mjs';
import { CoordinationPane, advisorSummary, connectionStatus, lowerRowWidths, ADVISOR_KEY, API_KEY, API_READY_KEY } from '../src/controller.mjs';
import { parseArgs, snapshot } from '../src/viewer.mjs';
import * as viewerModule from '../src/viewer.mjs';
import * as controllerModule from '../src/controller.mjs';
import { width } from '../../dag/src/render.mjs';
import { EventEmitter } from 'node:events';
import extension from '../extension.mjs';
import { RECOVERY_V1, bindingRevision as protocolBindingRevision,
  geometryRevision as protocolGeometryRevision } from '../src/recovery.mjs';

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

const protocolScope = (overrides = {}) => ({ ownerKey: 'o1', sessionId: 's1', lifetimeId: 'life1',
  scopeEpoch: 0, generation: 1, tabId: 't1', ...overrides });
const pane = (id, x, y, w, h) => ({ pane_id: id, rect: { x, y, width: w, height: h } });
const corePanes = () => [pane('P', 0, 0, 86, 46), pane('T', 86, 0, 86, 16),
  pane('W', 86, 16, 34, 30), pane('G', 120, 16, 52, 30)];
const placedPanes = () => [pane('P', 0, 0, 86, 46), pane('T', 86, 0, 86, 16),
  pane('C', 86, 16, 28, 30), pane('W', 114, 16, 28, 30), pane('G', 142, 16, 30, 30)];
// Build a protocol-valid settled layout. This is a fixture, not a native frame.
function settled({ panes, scope = protocolScope(), passSeq = 1, commandId = null,
  explicit = false, todo = 'T', workers = 'W', dag = 'G', collab = null }) {
  const byId = id => panes.find(entry => entry.pane_id === id);
  const w = byId(workers).rect, d = byId(dag).rect;
  const cells = [];
  let band = { x: w.x, y: w.y, width: d.x + d.width - w.x, height: w.height };
  if (collab) {
    const c = byId(collab).rect;
    cells.push({ role: 'collab', paneId: collab, rect: { ...c } });
    band = { x: c.x, y: w.y, width: band.x + band.width - c.x, height: w.height };
  }
  cells.push({ role: 'workers', paneId: workers, rect: { ...w } },
    { role: 'dag', paneId: dag, rect: { ...d } });
  const message = { v: 1, kind: 'layout', scope, commandId: commandId ?? ('cmd-' + passSeq), passSeq,
    explicit, todo, workers, dag, band, cells };
  message.bindingRevision = protocolBindingRevision(message);
  message.geometryRevision = protocolGeometryRevision(message);
  return message;
}
// A controlled native surface. Split/swap/resize mutate the fixture layout so
// the controller's own postcondition observations are meaningful.
function fakeHerdr(initial, { splitPane = 'C', loseReply = new Set(), onCall = null } = {}) {
  const calls = [];
  let panes = initial.map(entry => ({ ...entry, rect: { ...entry.rect } }));
  const find = id => panes.find(entry => entry.pane_id === id);
  const api = { calls, get panes() { return panes; }, setPanes(value) { panes = value; } };
  api.herdr = async (...args) => {
    calls.push(args.join(' '));
    if (onCall) await onCall(args, api);
    let result = {};
    if (args[0] === 'layout') {
      result = { layout: { tab_id: 't1', panes: panes.map(entry => ({ ...entry, rect: { ...entry.rect } })) } };
    } else if (args[0] === 'split') {
      const target = find(args[2]);
      const ratio = Number(args[args.indexOf('--ratio') + 1]) || 0.5;
      const split = Math.max(1, Math.round(target.rect.width * ratio));
      target.rect.width -= split;
      panes.push({ pane_id: splitPane, rect: { x: target.rect.x + target.rect.width, y: target.rect.y,
        width: split, height: target.rect.height } });
      result = { pane: { pane_id: splitPane } };
    } else if (args[0] === 'swap') {
      const source = find(args[2]), target = find(args[4]);
      const first = { ...source.rect }, second = { ...target.rect };
      source.rect = second; target.rect = first;
    } else if (args[0] === 'resize') {
      const target = find(args[2]);
      const direction = args[args.indexOf('--direction') + 1];
      const amount = Number(args[args.indexOf('--amount') + 1]) || 0;
      const row = panes.filter(entry => entry.rect.y === target.rect.y).sort((a, b) => a.rect.x - b.rect.x);
      const index = row.findIndex(entry => entry.pane_id === target.pane_id);
      const left = row[index - 1], right = row[index + 1];
      if (left && right) {
        const total = row.reduce((sum, entry) => sum + entry.rect.width, 0);
        const delta = Math.round(amount * total) * (direction === 'right' ? 1 : -1);
        const group = left.rect.width + target.rect.width;
        const leftAdd = Math.round(delta * left.rect.width / group);
        const targetAdd = delta - leftAdd;
        left.rect.width += leftAdd;
        target.rect.x += leftAdd;
        target.rect.width += targetAdd;
        right.rect.x += delta;
        right.rect.width -= delta;
      }
    } else if (args[0] === 'close') {
      const closing = find(args[1]);
      if (closing) {
        const row = panes.filter(entry => entry.rect.y === closing.rect.y && entry.pane_id !== closing.pane_id)
          .sort((a, b) => a.rect.x - b.rect.x);
        const right = row.find(entry => entry.rect.x > closing.rect.x);
        const left = [...row].reverse().find(entry => entry.rect.x < closing.rect.x);
        if (right) {
          right.rect.x -= closing.rect.width;
          right.rect.width += closing.rect.width;
        } else if (left) {
          left.rect.width += closing.rect.width;
          for (const entry of panes) if (entry.pane_id !== closing.pane_id && entry.rect.y === closing.rect.y &&
            entry.rect.x > closing.rect.x) entry.rect.x -= closing.rect.width;
        }
      }
      panes = panes.filter(entry => entry.pane_id !== args[1]);
    } else if (args[0] === 'get') {
      result = { pane: { focused: false } };
    }
    if (loseReply.has(args[0])) throw new Error('reply lost: ' + args[0]);
    return result;
  };
  return api;
}
function controllerFor(dir, fake, options = {}) {
  return new CoordinationPane({ stateDir: join(dir, 'state'), dagStateDir: join(dir, 'dag'),
    parentPane: 'P', sessionId: 's1', cwd: dir, herdr: fake.herdr ?? fake, node: async () => 'node',
    viewer: 'viewer.mjs', activityPath: 'a.jsonl', host: {}, env: {}, now: () => NOW, ...options });
}
function writeMatchingProof(recordFile, record, overrides = {}) {
  writeFileSync(viewerModule.viewerProofPath(recordFile), JSON.stringify({
    v: 1, scope: record.scope, bindingRevision: record.revisions?.binding ?? record.binding?.revision,
    pane: record.paneId, launch: { token: record.launch.token, at: record.launch.at },
    viewer: { pid: 2468, startedAt: '2026-10-20T11:59:59.000Z', parentPid: 1357 },
    firstPaint: { seq: 1, at: new Date(NOW).toISOString() },
    heartbeat: { seq: 1, at: new Date(NOW).toISOString() },
    exit: null, ownerClose: null, error: null, ...overrides }));
}
function seedPlaced(controller, panes = placedPanes(), overrides = {}) {
  mkdirSync(dirname(controller.recordFile), { recursive: true });
  const message = settled({ panes, collab: 'C', ...overrides });
  const collabRect = panes.find(entry => entry.pane_id === 'C').rect;
  const revision = controllerModule.bindingRevision(message.scope, { workers: message.workers, dag: message.dag });
  const record = v2Record({ scope: message.scope, workers: message.workers, dag: message.dag,
    binding: { workers: message.workers, dag: message.dag, revision },
    revisions: { binding: revision, geometry: controllerModule.geometryRevision('C', collabRect) },
    rect: collabRect,
    layout: { commandId: message.commandId, passSeq: message.passSeq,
      bindingRevision: message.bindingRevision, geometryRevision: message.geometryRevision } });
  writeRecord(controller.recordFile, record);
  writeMatchingProof(controller.recordFile, record);
  return { message, record };
}

test('placement splits workers, swaps the new pane leftmost, resizes the group and runs the viewer once', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(corePanes());
    const controller = controllerFor(dir, fake);
    const message = settled({ panes: fake.panes });
    await controller.acceptLayout(message);
    await controller.idle();
    assert.equal(controller.state, 'running');
    const verbs = fake.calls.map(call => call.split(' ')[0]).filter(verb => !['layout', 'get'].includes(verb));
    assert.deepEqual(verbs, ['split', 'swap', 'resize', 'run']);
    assert.equal(fake.calls.filter(call => call.startsWith('split ')).length, 1);
    assert.ok(fake.calls.find(call => call.startsWith('split ')).startsWith('split --pane W --direction right --ratio 0.5'));
    assert.equal(fake.calls.find(call => call.startsWith('swap ')), 'swap --source-pane C --target-pane W');
    assert.ok(fake.calls.find(call => call.startsWith('resize ')).startsWith('resize --pane W --direction right --amount 0.2558'));
    const run = fake.calls.find(call => call.startsWith('run '));
    assert.match(run, /'--session' 's1'/);
    assert.doesNotMatch(run, /--advisor/);
    const record = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(record.paneId, 'C');
    assert.equal(record.phase, 'running');
    assert.deepEqual(record.expected, { collab: 28, workers: 28, dag: 30 });
    assert.equal(record.rect.width, 28);
    assert.equal((await controller.viewerStatus()).ready, false);
    assert.equal((await controller.status()).ready, false);
    writeMatchingProof(controller.recordFile, record);
    assert.equal((await controller.status()).ready, true);
    const placed = settled({ panes: fake.panes, collab: 'C', passSeq: 2 });
    await controller.acceptLayout(placed);
    assert.equal(controller.state, 'current');
    assert.equal((await controller.status()).ready, true);
    const before = fake.calls.length;
    await controller.acceptLayout(message);
    assert.equal(fake.calls.length, before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('an unproven v1 record is left legacy-waiting without a native close', async () => {
  const dir = directory();
  try {
    const stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'P.pane.json'), JSON.stringify({ v: 1, paneId: 'C', parentPaneId: 'P', sessionId: 's1', phase: 'running' }));
    const fake = fakeHerdr(placedPanes());
    const controller = controllerFor(dir, fake);
    await controller.acceptLayout(settled({ panes: fake.panes, collab: 'C' }));
    assert.equal(controller.state, 'legacy-waiting');
    assert.deepEqual(fake.calls, []);
    const record = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(record.v, 1);
    assert.equal(record.paneId, 'C');
    assert.equal(record.manualClose, undefined);
    assert.equal(record.closure, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
// --- v2 Collab lifecycle and viewer proof -----------------------------------

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const LAUNCH_AT = '2026-10-20T11:59:58.000Z';
const baseScope = (overrides = {}) => ({ ownerKey: null, sessionId: 's1', lifetimeId: 'life1', scopeEpoch: null,
  generation: 'g1', tabId: 't1', ...overrides });
const v2Record = (overrides = {}) => {
  const scope = overrides.scope ?? baseScope();
  return { v: 2, paneId: 'C', tabId: 't1', parentPaneId: 'P', sessionId: 's1', viewer: 'viewer.mjs',
    workers: 'W', dag: 'G', createdAt: LAUNCH_AT, rect: null, expected: { collab: 28, workers: 28, dag: 30 },
    phase: 'running', scope, binding: { workers: 'W', dag: 'G', revision: 'rev1' },
    revisions: { binding: 'rev1', geometry: null }, launch: { token: 'L1', at: LAUNCH_AT },
    identity: { paneId: 'C', shellPid: null, viewerPid: null, viewerStartedAt: null },
    closure: null, pendingEffect: null, ...overrides };
};
const baseProof = (overrides = {}) => ({ v: 1, scope: baseScope(), bindingRevision: 'rev1', pane: 'C',
  launch: { token: 'L1', at: LAUNCH_AT },
  viewer: { pid: 2468, startedAt: '2026-10-20T11:59:59.000Z', parentPid: 1357 },
  firstPaint: { seq: 1, at: '2026-10-20T11:59:59.500Z' },
  heartbeat: { seq: 1, at: '2026-10-20T11:59:59.500Z' }, exit: null, ownerClose: null, error: null, ...overrides });
const writeProof = (recordFile, value) => writeFileSync(viewerModule.viewerProofPath(recordFile), JSON.stringify(value));
const writeRecord = (file, value) => writeFileSync(file, JSON.stringify(value));
// A launch-scoped sidecar that matches the durable record exactly.
const proofForRecord = (record, overrides = {}) => ({
  v: 1, scope: record.scope, bindingRevision: record.revisions?.binding ?? record.binding?.revision,
  pane: record.paneId, launch: { token: record.launch.token, at: record.launch.at },
  viewer: { pid: 2468, startedAt: '2026-10-20T11:59:59.000Z', parentPid: 1357 },
  firstPaint: { seq: 1, at: '2026-10-20T11:59:59.500Z' },
  heartbeat: { seq: 1, at: '2026-10-20T11:59:59.500Z' }, exit: null,
  ownerClose: { reason: 'owner-close', at: '2026-10-20T12:00:00.000Z', launchToken: record.launch.token,
    pane: record.paneId, bindingRevision: record.revisions?.binding ?? record.binding?.revision,
    sessionId: record.scope.sessionId, lifetimeId: record.scope.lifetimeId }, error: null, ...overrides,
});

function harness(clock = () => NOW) {
  const dir = directory();
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const controller = new CoordinationPane({ stateDir, dagStateDir: join(dir, 'dag'), parentPane: 'P', sessionId: 's1',
    cwd: dir, herdr: async () => { throw new Error('no native call expected'); }, node: async () => 'node',
    viewer: 'viewer.mjs', activityPath: 'a.jsonl', host: {}, env: {}, now: clock });
  return { dir, stateDir, controller, recordFile: controller.recordFile };
}

test('viewer parses an exact launch identity and names one proof sidecar beside the record', () => {
  const options = parseArgs(['--record', '/r/P.pane.json', '--launch', 'L1', '--binding', 'rev1', '--tab', 't1',
    '--parent', 'P', '--session', 's1', '--lifetime', 'life1', '--generation', 'g1', '--owner', 'o1']);
  assert.equal(options.launch, 'L1');
  assert.equal(options.binding, 'rev1');
  assert.equal(options.tab, 't1');
  assert.equal(options.parent, 'P');
  assert.equal(options.lifetime, 'life1');
  assert.equal(options.generation, 'g1');
  assert.equal(options.owner, 'o1');
  assert.equal(viewerModule.VIEWER_PROOF_SUFFIX, '.viewer.json');
  assert.equal(viewerModule.viewerProofPath('/r/P.pane.json'), '/r/P.pane.json.viewer.json');
  assert.equal(typeof viewerModule.runViewer, 'function');
  assert.equal(typeof controllerModule.inspectViewerProof, 'function');
});

test('first paint waits for the frame write, a same-launch late paint stays current, and q publishes launch-scoped owner intent before close', async () => {
  const dir = directory();
  try {
    const stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    const recordFile = join(stateDir, 'P.pane.json');
    const statusFile = join(dir, 'status.json');
    writeRecord(recordFile, v2Record());
    writeFileSync(statusFile, JSON.stringify({ v: 1, state: 'no-carrier' }));
    let clock = NOW;
    let tick, handlers, releaseGate, gate, closeDone;
    let held = false;
    let frameWrites = 0;
    const writes = [], calls = [];
    let ownerCloseAtCall = null;
    const closed = new Promise(resolve => { closeDone = resolve; });
    gate = new Promise(resolve => { releaseGate = resolve; });
    const output = { columns: 28, rows: 30, isTTY: true, on() {}, off() {},
      write(chunk, callback) {
        writes.push(chunk);
        if (typeof callback !== 'function') return true;
        frameWrites++;
        if (!held) { held = true; gate.then(() => callback()); } else callback();
        return true;
      } };
    const input = { isTTY: true, setRawMode() {}, resume() {}, on() {}, off() {} };
    const deps = { output, input, now: () => clock, exit: async () => { closeDone(); },
      setInterval: callback => { tick = callback; return 'tick'; }, clearInterval() {},
      terminalInput: (_input, value) => { handlers = value; return () => {}; },
      pid: 2468, parentPid: 1357, startedAt: '2026-10-20T11:59:59.000Z',
      herdr: () => async (...args) => {
        calls.push(args.join(' '));
        if (args[0] === 'close') ownerCloseAtCall = viewerModule.readViewerProof(recordFile)?.ownerClose ?? null;
        return {};
      } };
    const handle = await viewerModule.runViewer(parseArgs(['--status', statusFile, '--activity', join(dir, 'a.jsonl'),
      '--record', recordFile, '--launch', 'L1', '--binding', 'rev1', '--tab', 't1', '--parent', 'P',
      '--session', 's1', '--lifetime', 'life1', '--generation', 'g1', '--lang', 'en', '--close-pane', 'C']), deps);
    // The frame write is held: a shell/pane and a started viewer are not first paint.
    assert.equal(frameWrites, 1);
    assert.equal(viewerModule.readViewerProof(recordFile), null);
    const controller = new CoordinationPane({ stateDir, dagStateDir: join(dir, 'dag'), parentPane: 'P', sessionId: 's1',
      cwd: dir, herdr: async () => { throw new Error('no native call expected'); }, node: async () => 'node',
      viewer: 'viewer.mjs', activityPath: join(dir, 'a.jsonl'), host: {}, env: {}, now: () => clock });
    let status = await controller.viewerStatus();
    assert.equal(status.ready, false);
    assert.equal(status.state, 'no-proof');
    releaseGate();
    await handle.firstPaint;
    const first = viewerModule.readViewerProof(recordFile);
    assert.equal(first.pane, 'C');
    assert.equal(first.launch.token, 'L1');
    assert.equal(first.bindingRevision, 'rev1');
    assert.equal(first.viewer.pid, 2468);
    assert.equal(first.viewer.parentPid, 1357);
    assert.equal(first.firstPaint.seq, 1);
    status = await controller.viewerStatus();
    assert.equal(status.ready, true);
    assert.equal(status.state, 'current');
    // A later frame of the same launch is still accepted; heartbeat writes are
    // coalesced to at most one per second, while first paint never moves.
    clock += 400;
    writeFileSync(statusFile, JSON.stringify({ v: 1, state: 'connected', protocol: 'api v1' }));
    tick();
    const early = viewerModule.readViewerProof(recordFile);
    assert.equal(early.heartbeat.seq, 1);
    assert.equal(early.firstPaint.seq, 1);
    clock += 700;
    writeFileSync(statusFile, JSON.stringify({ v: 1, state: 'no-carrier' }));
    tick();
    const late = viewerModule.readViewerProof(recordFile);
    assert.equal(late.firstPaint.seq, 1);
    assert.equal(late.heartbeat.seq, 2);
    assert.notEqual(late.heartbeat.at, first.heartbeat.at);
    status = await controller.viewerStatus();
    assert.equal(status.ready, true);
    // A quiet second keeps the heartbeat fresh without a new frame.
    clock += 1000;
    tick();
    const idle = viewerModule.readViewerProof(recordFile);
    assert.equal(idle.firstPaint.seq, 1);
    assert.equal(idle.heartbeat.seq, 3);
    status = await controller.viewerStatus();
    assert.equal(status.ready, true);
    // Consume the viewer's own exact identity into the controller record.
    await controller.observeViewer();
    const mirrored = JSON.parse(readFileSync(recordFile, 'utf8'));
    assert.equal(mirrored.identity.viewerPid, 2468);
    assert.equal(mirrored.identity.shellPid, 1357);
    assert.equal(mirrored.identity.viewerStartedAt, '2026-10-20T11:59:59.000Z');
    const beforeClose = readFileSync(recordFile, 'utf8');
    const beforeProof = readFileSync(viewerModule.viewerProofPath(recordFile), 'utf8');
    handlers.key('q');
    handlers.key('q');
    await closed;
    // Intent is durable before the native close; the viewer never writes the controller record.
    assert.deepEqual(calls, ['close C']);
    assert.equal(ownerCloseAtCall.reason, 'owner-close');
    assert.equal(ownerCloseAtCall.launchToken, 'L1');
    assert.equal(ownerCloseAtCall.pane, 'C');
    assert.equal(readFileSync(recordFile, 'utf8'), beforeClose);
    assert.notEqual(readFileSync(viewerModule.viewerProofPath(recordFile), 'utf8'), beforeProof);
    const consumed = await controller.consumeOwnerClose();
    assert.equal(consumed.v, 2);
    assert.equal(consumed.paneId, 'C');
    assert.equal(consumed.manualClose, true);
    assert.equal(consumed.phase, 'closed');
    assert.equal(consumed.closure.reason, 'owner-close');
    assert.equal(consumed.closure.launchToken, 'L1');
    assert.equal(consumed.pendingEffect, null);
    status = await controller.viewerStatus();
    assert.equal(status.ready, false);
    assert.equal(status.state, 'owner-closed');
    assert.equal(viewerModule.readViewerProof(recordFile).ownerClose.reason, 'owner-close');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a legacy v1 record is still read for placement but is never viewer readiness or close authority', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(placedPanes());
    const controller = controllerFor(dir, fake);
    mkdirSync(join(dir, 'state'), { recursive: true });
    const legacy = { v: 1, paneId: 'C', tabId: 't1', parentPaneId: 'P', sessionId: 's1', viewer: 'viewer.mjs',
      workers: 'W', dag: 'G', createdAt: LAUNCH_AT, phase: 'running', rect: null };
    writeRecord(controller.recordFile, legacy);
    await controller.acceptLayout(settled({ panes: fake.panes, collab: 'C' }));
    assert.equal(controller.state, 'legacy-waiting');
    assert.deepEqual(fake.calls, []);
    const status = await controller.viewerStatus();
    assert.equal(status.ready, false);
    assert.equal(status.state, 'legacy-unproven');
    writeProof(controller.recordFile, baseProof({ ownerClose: { reason: 'owner-close', at: '2026-10-20T11:59:59.900Z',
      launchToken: 'L1', pane: 'C', bindingRevision: 'rev1', sessionId: 's1', lifetimeId: 'life1' } }));
    const before = readFileSync(controller.recordFile, 'utf8');
    assert.equal(await controller.consumeOwnerClose(), null);
    assert.equal(readFileSync(controller.recordFile, 'utf8'), before);
    assert.equal(JSON.parse(readFileSync(controller.recordFile, 'utf8')).manualClose, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('old launch, old scope, stale heartbeat with a live PID, corrupt proof and v1 close intent cannot mark current or authorize a close', async () => {
  const { dir, controller, recordFile } = harness();
  try {
    const record = v2Record();
    writeRecord(recordFile, record);
    const fresh = { now: NOW };
    const states = [
      ['launch-mismatch', { launch: { token: 'OLD', at: LAUNCH_AT } }],
      ['scope-mismatch', { scope: baseScope({ sessionId: 's0' }) }],
      ['binding-mismatch', { bindingRevision: 'rev0' }],
      ['pane-mismatch', { pane: 'OTHER' }],
      ['stale', { viewer: { pid: process.pid, startedAt: '2026-10-20T11:59:00.000Z', parentPid: 1 },
        heartbeat: { seq: 5, at: '2026-10-20T11:59:50.000Z' } }],
      ['first-paint-pending', { firstPaint: null }],
    ];
    for (const [state, patch] of states) {
      const proof = baseProof(patch);
      assert.equal(controllerModule.inspectViewerProof(record, proof, fresh).state, state);
      assert.equal(controllerModule.inspectViewerProof(record, proof, fresh).ready, false);
    }
    // The same identity mismatches cannot consume an explicit owner-close intent.
    for (const [, patch] of states.slice(0, 4)) {
      const proof = baseProof({ ...patch, ownerClose: { reason: 'owner-close', at: '2026-10-20T11:59:59.900Z',
        launchToken: 'L1', pane: 'C', bindingRevision: 'rev1', sessionId: 's1', lifetimeId: 'life1' } });
      writeProof(recordFile, proof);
      const before = readFileSync(recordFile, 'utf8');
      assert.equal(await controller.consumeOwnerClose(), null);
      assert.equal(readFileSync(recordFile, 'utf8'), before);
    }
    writeFileSync(viewerModule.viewerProofPath(recordFile), '{"v":1,"pane":"C",');
    assert.equal(viewerModule.readViewerProof(recordFile), null);
    assert.equal((await controller.viewerStatus()).state, 'no-proof');
    const before = readFileSync(recordFile, 'utf8');
    assert.equal(await controller.consumeOwnerClose(), null);
    assert.equal(readFileSync(recordFile, 'utf8'), before);
    // A stale heartbeat with a live PID is not current and, without an explicit
    // owner intent, authorizes no close at all.
    writeProof(recordFile, baseProof(states[4][1]));
    assert.equal((await controller.viewerStatus()).ready, false);
    const beforeStale = readFileSync(recordFile, 'utf8');
    assert.equal(await controller.consumeOwnerClose(), null);
    assert.equal(readFileSync(recordFile, 'utf8'), beforeStale);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('placement journals a v2 record with exact identities while a live shell stays unproven until first paint', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(corePanes());
    const controller = controllerFor(dir, fake);
    const message = settled({ panes: fake.panes });
    await controller.acceptLayout(message);
    await controller.idle();
    const record = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(record.v, 2);
    for (const field of ['paneId', 'sessionId', 'parentPaneId', 'tabId', 'viewer', 'workers', 'dag', 'createdAt', 'rect', 'expected'])
      assert.ok(Object.hasOwn(record, field), field);
    assert.equal(record.paneId, 'C');
    assert.equal(record.sessionId, 's1');
    assert.equal(record.parentPaneId, 'P');
    assert.equal(record.tabId, 't1');
    assert.equal(record.viewer, 'viewer.mjs');
    assert.equal(record.workers, 'W');
    assert.equal(record.dag, 'G');
    assert.equal(record.phase, 'running');
    assert.equal(record.pendingEffect, null);
    assert.equal(record.closure, null);
    assert.deepEqual(record.scope, protocolScope());
    assert.equal(record.binding.workers, 'W');
    assert.equal(record.binding.dag, 'G');
    assert.match(record.binding.revision, /^[0-9a-f]{16}$/);
    assert.equal(record.revisions.binding, record.binding.revision);
    assert.match(record.revisions.geometry, /^[0-9a-f]{16}$/);
    assert.equal(record.layout.bindingRevision, message.bindingRevision);
    assert.equal(record.layout.geometryRevision, message.geometryRevision);
    assert.match(record.launch.token, /^[0-9a-f-]{36}$/);
    assert.equal(record.identity.paneId, 'C');
    assert.equal(record.identity.viewerPid, null);
    const run = fake.calls.find(call => call.startsWith('run '));
    assert.ok(run.includes("'--launch' '" + record.launch.token + "'"), run);
    assert.ok(run.includes("'--binding' '" + record.binding.revision + "'"), run);
    assert.ok(run.includes("'--tab' 't1'"), run);
    assert.ok(run.includes("'--parent' 'P'"), run);
    assert.ok(run.includes("'--lifetime' 'life1'"), run);
    assert.ok(run.includes("'--epoch' '0'"), run);
    assert.ok(run.includes("'--generation' '1'"), run);
    assert.ok(run.includes("'--owner' 'o1'"), run);
    assert.ok(run.includes("'--close-pane' 'C'"), run);
    const status = await controller.viewerStatus();
    assert.equal(status.ready, false);
    assert.equal(status.state, 'no-proof');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('an owner close arriving during the launch wins over the stale launched snapshot', async () => {
  const dir = directory();
  try {
    let controller, closeWrittenAtRun = false;
    const fake = fakeHerdr(corePanes(), { onCall: async args => {
      if (args[0] !== 'run') return;
      const current = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
      writeProof(controller.recordFile, proofForRecord(current));
      closeWrittenAtRun = true;
    } });
    controller = controllerFor(dir, fake);
    await controller.acceptLayout(settled({ panes: fake.panes }));
    await controller.idle();
    assert.equal(closeWrittenAtRun, true);
    assert.equal(controller.state, 'closed-by-owner');
    const record = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(record.manualClose, true);
    assert.equal(record.phase, 'closed');
    assert.equal(record.closure.reason, 'owner-close');
    assert.equal(record.pendingEffect, null);
    assert.equal(viewerModule.readViewerProof(controller.recordFile).ownerClose.reason, 'owner-close');
    assert.equal(fake.calls.filter(call => call.startsWith('split ')).length, 1);
    assert.equal(fake.calls.filter(call => call.startsWith('run ')).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('startup recovers a stored-launch owner close before classification and repeated passes keep it closed', async () => {
  const dir = directory();
  try {
    const stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    const recordFile = join(stateDir, 'P.pane.json');
    const record = v2Record();
    writeRecord(recordFile, record);
    writeProof(recordFile, baseProof({ heartbeat: { seq: 3, at: '2026-10-20T11:00:00.000Z' },
      ownerClose: { reason: 'owner-close', at: '2026-10-20T11:00:00.500Z',
        launchToken: 'L1', pane: 'C', bindingRevision: 'rev1', sessionId: 's1', lifetimeId: 'life1' } }));
    const failing = new CoordinationPane({ stateDir, dagStateDir: join(dir, 'dag'), parentPane: 'P', sessionId: 's1',
      cwd: dir, herdr: async () => { throw new Error('layout unavailable'); }, node: async () => 'node',
      viewer: 'viewer.mjs', activityPath: 'a.jsonl', host: {}, env: {}, now: () => NOW });
    await failing.start();
    const recovered = JSON.parse(readFileSync(recordFile, 'utf8'));
    assert.equal(recovered.manualClose, true);
    assert.equal(recovered.closure.reason, 'owner-close');
    assert.equal(recovered.phase, 'closed');
    const fake = fakeHerdr(placedPanes());
    const reopened = controllerFor(dir, fake);
    await reopened.acceptLayout(settled({ panes: fake.panes, collab: 'C' }));
    await reopened.acceptLayout(settled({ panes: fake.panes, collab: 'C', passSeq: 2 }));
    assert.equal(reopened.state, 'closed-by-owner');
    assert.deepEqual(fake.calls, []);
    assert.equal((await reopened.viewerStatus()).ready, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('generic viewer shutdown and errors are exit evidence, never owner intent', async () => {
  const dir = directory();
  try {
    const recordFile = join(dir, 'P.pane.json');
    const statusFile = join(dir, 'status.json');
    writeRecord(recordFile, v2Record());
    writeFileSync(statusFile, JSON.stringify({ v: 1, state: 'no-carrier' }));
    let signalHandler, exitDone;
    const exited = new Promise(resolve => { exitDone = resolve; });
    const output = { columns: 28, rows: 30, isTTY: true, on() {}, off() {},
      write(_chunk, callback) { if (typeof callback === 'function') callback(); return true; } };
    const input = { isTTY: true, setRawMode() {}, resume() {}, on() {}, off() {} };
    const options = parseArgs(['--status', statusFile, '--record', recordFile, '--launch', 'L1', '--binding', 'rev1',
      '--tab', 't1', '--parent', 'P', '--session', 's1', '--lang', 'en', '--close-pane', 'C']);
    const handle = await viewerModule.runViewer(options, { output, input, now: () => NOW, exit: async () => exitDone(),
      setInterval: () => 'tick', clearInterval() {}, terminalInput: () => () => {},
      onSignal: handler => { signalHandler = handler; return () => {}; },
      pid: 2468, parentPid: 1357, startedAt: '2026-10-20T11:59:59.000Z',
      herdr: () => async () => { throw new Error('shutdown must not close a pane'); } });
    await handle.firstPaint;
    const recordBefore = readFileSync(recordFile, 'utf8');
    signalHandler();
    await exited;
    const proof = viewerModule.readViewerProof(recordFile);
    assert.equal(proof.exit.reason, 'shutdown');
    assert.equal(proof.ownerClose, null);
    assert.equal(proof.firstPaint.seq, 1);
    assert.equal(readFileSync(recordFile, 'utf8'), recordBefore);
    const controller = new CoordinationPane({ stateDir: dir, dagStateDir: join(dir, 'dag'), parentPane: 'P', sessionId: 's1',
      cwd: dir, herdr: async () => { throw new Error('no native call expected'); }, node: async () => 'node',
      viewer: 'viewer.mjs', activityPath: 'a.jsonl', host: {}, env: {}, now: () => NOW });
    assert.equal(await controller.consumeOwnerClose(), null);
    viewerModule.recordViewerError(options, new Error('frame failed\nretry later'));
    const failed = viewerModule.readViewerProof(recordFile);
    assert.equal(failed.ownerClose, null);
    assert.equal(failed.error.message, 'frame failed retry later');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unwritable proof path keeps the pane open and never performs a native close', async () => {
  const dir = directory();
  try {
    const recordFile = join(dir, 'P.pane.json');
    const statusFile = join(dir, 'status.json');
    writeRecord(recordFile, v2Record());
    writeFileSync(statusFile, JSON.stringify({ v: 1, state: 'no-carrier' }));
    // A directory at the sidecar path makes every proof publication fail.
    mkdirSync(viewerModule.viewerProofPath(recordFile), { recursive: true });
    const calls = [], writes = [];
    let exited = false, handlers;
    const output = { columns: 28, rows: 30, isTTY: true, on() {}, off() {},
      write(chunk, callback) { writes.push(String(chunk)); if (typeof callback === 'function') callback(); return true; } };
    const input = { isTTY: true, setRawMode() {}, resume() {}, on() {}, off() {} };
    const options = parseArgs(['--status', statusFile, '--record', recordFile, '--launch', 'L1', '--launch-at', LAUNCH_AT,
      '--binding', 'rev1', '--tab', 't1', '--parent', 'P', '--session', 's1', '--lang', 'en', '--close-pane', 'C']);
    const handle = await viewerModule.runViewer(options, { output, input, now: () => NOW, exit: async () => { exited = true; },
      setInterval: () => 'tick', clearInterval() {}, terminalInput: (_input, value) => { handlers = value; return () => {}; },
      onSignal: () => () => {}, pid: 2468, parentPid: 1357, startedAt: '2026-10-20T11:59:59.000Z',
      herdr: () => async (...args) => { calls.push(args.join(' ')); return {}; } });
    await handle.firstPaint;
    const recordBefore = readFileSync(recordFile, 'utf8');
    handlers.key('q');
    // Publication failed, so the viewer surfaces the failure and keeps the pane.
    assert.deepEqual(calls, []);
    assert.equal(exited, false);
    assert.ok(writes.some(chunk => /owner close was not recorded/i.test(chunk)), writes.at(-1));
    assert.equal(readFileSync(recordFile, 'utf8'), recordBefore);
    assert.equal(viewerModule.readViewerProof(recordFile), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a numeric protocol generation survives the viewer CLI into a current first-paint proof', async () => {
  const { dir, controller, recordFile } = harness();
  try {
    const statusFile = join(dir, 'status.json');
    writeRecord(recordFile, v2Record({ scope: baseScope({ generation: 1 }) }));
    writeFileSync(statusFile, JSON.stringify({ v: 1, state: 'no-carrier' }));
    const output = { columns: 28, rows: 30, isTTY: true, on() {}, off() {},
      write(_chunk, callback) { if (typeof callback === 'function') callback(); return true; } };
    const input = { isTTY: true, setRawMode() {}, resume() {}, on() {}, off() {} };
    const options = parseArgs(['--status', statusFile, '--record', recordFile, '--launch', 'L1', '--launch-at', LAUNCH_AT,
      '--binding', 'rev1', '--tab', 't1', '--parent', 'P', '--session', 's1', '--lifetime', 'life1', '--generation', '1',
      '--lang', 'en', '--close-pane', 'C']);
    const handle = await viewerModule.runViewer(options, { output, input, now: () => NOW, exit: async () => {},
      setInterval: () => 'tick', clearInterval() {}, terminalInput: () => () => {}, onSignal: () => () => {},
      pid: 2468, parentPid: 1357, startedAt: '2026-10-20T11:59:59.000Z',
      herdr: () => async () => ({}) });
    await handle.firstPaint;
    const proof = viewerModule.readViewerProof(recordFile);
    assert.equal(proof.scope.generation, 1);
    const status = await controller.viewerStatus();
    assert.equal(status.state, 'current');
    assert.equal(status.ready, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the proof sidecar drops arbitrary activity fields and coordination never starts a process query', () => {
  const { dir, recordFile } = harness();
  try {
    writeProof(recordFile, baseProof({ summary: 'external text', events: [{ summary: 'leaked' }],
      error: { message: 'x\n'.repeat(1000), at: '2026-10-20T11:59:59.900Z' } }));
    const proof = viewerModule.readViewerProof(recordFile);
    assert.equal(proof.summary, undefined);
    assert.equal(proof.events, undefined);
    assert.ok(proof.error.message.length <= 300);
    assert.doesNotMatch(proof.error.message, /[\r\n]/);
    const source = readFileSync(new URL('../src/controller.mjs', import.meta.url), 'utf8') +
      readFileSync(new URL('../src/viewer.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /Get-CimInstance|Get-Process|wmic|powershell\.exe/i);
    assert.doesNotMatch(source, /node:child_process/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- event-driven ensure, policy A and effect recovery ----------------------

test('one ensure plus one coalesced rerun collapses a latest-layout burst', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(corePanes());
    const controller = controllerFor(dir, fake);
    const seen = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    controller.ensure = async message => { seen.push(message.passSeq); await gate; return { state: 'test' }; };
    const panes = corePanes();
    const first = settled({ panes, passSeq: 1, commandId: 'burst-1' });
    const second = settled({ panes, passSeq: 2, commandId: 'burst-2' });
    const third = settled({ panes, passSeq: 3, commandId: 'burst-3' });
    const waits = [controller.acceptLayout(first), controller.acceptLayout(second), controller.acceptLayout(third)];
    release();
    await Promise.all(waits);
    await controller.idle();
    assert.deepEqual(seen, [1, 3]);
    assert.equal(fake.calls.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('foreign scopes and stale events never cause a native mutation', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(corePanes());
    const controller = controllerFor(dir, fake);
    await controller.acceptLayout(settled({ panes: fake.panes, scope: protocolScope({ sessionId: 's0' }) }));
    assert.equal(controller.state, 'foreign-scope');
    assert.deepEqual(fake.calls, []);
    const current = settled({ panes: fake.panes, passSeq: 1 });
    await controller.acceptLayout(current);
    const afterPlacement = fake.calls.length;
    await controller.acceptLayout(current);
    await controller.acceptLayout(settled({ panes: fake.panes, passSeq: 1, commandId: 'stale' }));
    assert.equal(fake.calls.length, afterPlacement);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a previous session's dead record is archived and replaced, not foreign-blocked", async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(corePanes());
    const controller = controllerFor(dir, fake);
    mkdirSync(join(dir, 'state'), { recursive: true });
    const foreign = v2Record({ sessionId: 's0', scope: protocolScope({ ownerKey: 'o0', sessionId: 's0' }),
      paneId: 'C', launch: { token: 'OLD', at: LAUNCH_AT } });
    writeRecord(controller.recordFile, foreign);
    await controller.acceptLayout(settled({ panes: fake.panes }));
    await controller.idle();
    assert.equal(controller.state, 'running');
    const record = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(record.sessionId, 's1');
    assert.equal(record.paneId, 'C');
    const archives = fs.readdirSync(join(dir, 'state')).filter(name => name.startsWith('P.pane.json.foreign-'));
    assert.equal(archives.length, 1);
    const archived = JSON.parse(readFileSync(join(dir, 'state', archives[0]), 'utf8'));
    assert.equal(archived.reason, 'foreign-session');
    assert.equal(archived.record.sessionId, 's0');
    assert.equal(fake.calls.filter(call => call.startsWith('close ')).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a previous session's live collaboration pane is held without a mutation", async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(placedPanes());
    const controller = controllerFor(dir, fake);
    mkdirSync(join(dir, 'state'), { recursive: true });
    const foreign = v2Record({ sessionId: 's0', scope: protocolScope({ ownerKey: 'o0', sessionId: 's0' }), paneId: 'C' });
    writeRecord(controller.recordFile, foreign);
    const before = readFileSync(controller.recordFile, 'utf8');
    await controller.acceptLayout(settled({ panes: fake.panes, collab: 'C' }));
    assert.equal(controller.state, 'foreign-pane-live');
    assert.equal(readFileSync(controller.recordFile, 'utf8'), before);
    assert.equal(fake.calls.filter(call => /^(split|swap|resize|run|close) /.test(call)).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("shutdown never marks a previous session's record as this session's absence", async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(corePanes());
    const controller = controllerFor(dir, fake);
    mkdirSync(join(dir, 'state'), { recursive: true });
    const foreign = v2Record({ sessionId: 's0', scope: protocolScope({ ownerKey: 'o0', sessionId: 's0' }), paneId: 'C' });
    writeRecord(controller.recordFile, foreign);
    const before = readFileSync(controller.recordFile, 'utf8');
    assert.equal(await controller.shutdownObserve(), null);
    assert.equal(readFileSync(controller.recordFile, 'utf8'), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an owner-close proof is never consumed into a previous session's record", async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(corePanes());
    const controller = controllerFor(dir, fake);
    mkdirSync(join(dir, 'state'), { recursive: true });
    const foreign = v2Record({ sessionId: 's0', scope: protocolScope({ ownerKey: 'o0', sessionId: 's0' }), paneId: 'C' });
    writeRecord(controller.recordFile, foreign);
    writeMatchingProof(controller.recordFile, foreign, { ownerClose: { reason: 'owner-close',
      at: '2026-10-20T11:59:59.900Z', launchToken: foreign.launch.token, pane: 'C',
      sessionId: 's0', lifetimeId: foreign.scope.lifetimeId } });
    const before = readFileSync(controller.recordFile, 'utf8');
    assert.equal(await controller.consumeOwnerClose(), null);
    assert.equal(readFileSync(controller.recordFile, 'utf8'), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an explicit command never overrides another session's close record", async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(corePanes());
    const controller = controllerFor(dir, fake);
    mkdirSync(join(dir, 'state'), { recursive: true });
    const foreign = v2Record({ sessionId: 's0', scope: protocolScope({ ownerKey: 'o0', sessionId: 's0' }),
      manualClose: true, phase: 'closed',
      closure: { reason: 'absence', at: '2026-10-20T11:59:00.000Z', launchToken: 'L1', sessionId: 's0', lifetimeId: 'life1' } });
    writeRecord(controller.recordFile, foreign);
    const before = readFileSync(controller.recordFile, 'utf8');
    assert.equal(await controller.overrideRecord({ ...foreign, manualClose: false }, null, NOW), false);
    assert.equal(readFileSync(controller.recordFile, 'utf8'), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an already placed 86-column band with an unchanged payload is a no-op', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(placedPanes());
    const controller = controllerFor(dir, fake);
    const { message } = seedPlaced(controller, fake.panes);
    assert.equal((await controller.viewerStatus()).ready, true);
    await controller.acceptLayout(message);
    assert.deepEqual(fake.calls, []);
    assert.equal(controller.state, 'current');
    assert.equal((await controller.status()).ready, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a width-only event resizes the same launch and never splits or runs', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(placedPanes());
    const controller = controllerFor(dir, fake);
    const { record } = seedPlaced(controller, fake.panes);
    const wide = [pane('P', 0, 0, 100, 46), pane('T', 100, 0, 100, 16),
      pane('C', 100, 16, 28, 30), pane('W', 128, 16, 28, 30), pane('G', 156, 16, 44, 30)];
    fake.setPanes(wide);
    await controller.acceptLayout(settled({ panes: wide, collab: 'C', passSeq: 2 }));
    assert.equal(fake.calls.filter(call => call.startsWith('split ')).length, 0);
    assert.equal(fake.calls.filter(call => call.startsWith('run ')).length, 0);
    assert.equal(fake.calls.filter(call => call.startsWith('resize ')).length, 1);
    const next = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(next.launch.token, record.launch.token);
    assert.deepEqual(next.expected, { collab: 33, workers: 33, dag: 34 });
    assert.equal((await controller.status()).ready, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('replacing sibling IDs closes the old owned pane and rebinds exactly once', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(placedPanes(), { splitPane: 'C2' });
    const controller = controllerFor(dir, fake);
    const { record } = seedPlaced(controller, fake.panes);
    const rebased = [pane('P', 0, 0, 86, 46), pane('T', 86, 0, 86, 16),
      pane('C', 86, 16, 28, 30), pane('W2', 114, 16, 28, 30), pane('G2', 142, 16, 30, 30)];
    fake.setPanes(rebased);
    await controller.acceptLayout(settled({ panes: rebased, workers: 'W2', dag: 'G2', collab: 'C',
      passSeq: 2, commandId: 'rebind' }));
    await controller.idle();
    assert.equal(fake.calls.filter(call => call.startsWith('close ')).length, 1);
    assert.equal(fake.calls.filter(call => call.startsWith('split ')).length, 1);
    assert.equal(fake.calls.filter(call => call.startsWith('run ')).length, 1);
    const next = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(next.workers, 'W2');
    assert.equal(next.dag, 'G2');
    assert.equal(next.paneId, 'C2');
    const revision = controllerModule.bindingRevision(next.scope, { workers: 'W2', dag: 'G2' });
    assert.equal(next.revisions.binding, revision);
    assert.ok(fake.calls.find(call => call.startsWith('run ')).includes("'--binding' '" + revision + "'"));
    assert.notEqual(next.launch.token, record.launch.token);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a lost split reply is effect-unknown and never splits twice', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(corePanes(), { loseReply: new Set(['split']) });
    const controller = controllerFor(dir, fake);
    await controller.acceptLayout(settled({ panes: fake.panes }));
    assert.equal(controller.state, 'effect-unknown');
    const record = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(record.paneId, null);
    assert.equal(record.pendingEffect.kind, 'split');
    assert.equal(fake.calls.filter(call => call.startsWith('split ')).length, 1);
    // A later settled pass, even with an unidentified new pane visible, is not
    // adopted and never triggers a second split.
    await controller.acceptLayout(settled({ panes: corePanes(), passSeq: 2 }));
    assert.equal(controller.state, 'effect-unknown');
    assert.equal(fake.calls.filter(call => call.startsWith('split ')).length, 1);
    assert.equal(fake.calls.filter(call => call.startsWith('close ')).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a lost swap reply is settled by the observed postcondition and never repeated', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(corePanes(), { loseReply: new Set(['swap']) });
    const controller = controllerFor(dir, fake);
    await controller.acceptLayout(settled({ panes: fake.panes }));
    assert.equal(controller.state, 'effect-unknown');
    let record = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(record.pendingEffect.kind, 'swap');
    assert.equal(fake.calls.filter(call => call.startsWith('swap ')).length, 1);
    // The native swap happened before the reply was lost. A later settled pass
    // observes Collab leftmost, settles the effect without repeating it, then
    // continues to resize and launch.
    await controller.acceptLayout(settled({ panes: fake.panes, collab: 'C', passSeq: 2 }));
    await controller.idle();
    assert.equal(fake.calls.filter(call => call.startsWith('swap ')).length, 1);
    assert.equal(fake.calls.filter(call => call.startsWith('split ')).length, 1);
    assert.equal(fake.calls.filter(call => call.startsWith('run ')).length, 1);
    record = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(record.phase, 'running');
    assert.equal(record.pendingEffect, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a lost run reply waits for exact proof and never types a second run; a late paint is accepted', async () => {
  const dir = directory();
  try {
    let clock = NOW;
    const fake = fakeHerdr(corePanes(), { loseReply: new Set(['run']) });
    const controller = controllerFor(dir, fake, { now: () => clock });
    await controller.acceptLayout(settled({ panes: fake.panes }));
    await controller.idle();
    let record = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(record.pendingEffect.kind, 'run');
    assert.equal(fake.calls.filter(call => call.startsWith('run ')).length, 1);
    await controller.acceptLayout(settled({ panes: fake.panes, collab: 'C', passSeq: 2 }));
    assert.equal(controller.state, 'run-pending');
    assert.equal(fake.calls.filter(call => call.startsWith('run ')).length, 1);
    // Ten seconds later is past the 5s response deadline but inside the launch
    // confirmation window. The exact same launch's paint is still accepted.
    clock += 10000;
    writeMatchingProof(controller.recordFile, record, {
      firstPaint: { seq: 1, at: new Date(NOW + 5000).toISOString() },
      heartbeat: { seq: 2, at: new Date(clock).toISOString() } });
    await controller.acceptLayout(settled({ panes: fake.panes, collab: 'C', passSeq: 3 }));
    assert.equal(fake.calls.filter(call => call.startsWith('run ')).length, 1);
    assert.equal(controller.state, 'current');
    assert.equal((await controller.status()).ready, true);
    record = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(record.pendingEffect, null);
    assert.equal(record.phase, 'running');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a stale heartbeat with a live PID is a truthful wait, not a reason to run or close', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(placedPanes());
    const controller = controllerFor(dir, fake);
    const { record } = seedPlaced(controller, fake.panes);
    writeMatchingProof(controller.recordFile, record, {
      viewer: { pid: process.pid, startedAt: '2026-10-20T11:59:00.000Z', parentPid: 1 },
      heartbeat: { seq: 5, at: new Date(NOW - 10000).toISOString() } });
    await controller.acceptLayout(settled({ panes: fake.panes, collab: 'C', passSeq: 2 }));
    assert.equal(controller.state, 'stale');
    assert.equal(fake.calls.filter(call => call.startsWith('split ')).length, 0);
    assert.equal(fake.calls.filter(call => call.startsWith('run ')).length, 0);
    assert.equal(fake.calls.filter(call => call.startsWith('close ')).length, 0);
    assert.equal((await controller.status()).ready, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a native close is persisted as absence and suppresses reload until a fresh explicit restore', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(placedPanes());
    const controller = controllerFor(dir, fake);
    seedPlaced(controller, fake.panes);
    fake.setPanes(fake.panes.filter(entry => entry.pane_id !== 'C'));
    const absent = await controller.shutdownObserve();
    assert.equal(absent.manualClose, true);
    assert.equal(absent.phase, 'closed');
    assert.equal(absent.closure.reason, 'absence');
    // Reload: the same durable fixture is read by a fresh controller.
    const core = fakeHerdr(corePanes());
    const reopened = controllerFor(dir, core, { now: () => NOW + 1000 });
    await reopened.start();
    await reopened.acceptLayout(settled({ panes: core.panes, passSeq: 1 }));
    assert.equal(reopened.state, 'closed-by-owner');
    assert.deepEqual(core.calls, []);
    // A later fresh explicit command overrides only the older recorded close.
    await reopened.acceptLayout(settled({ panes: core.panes, passSeq: 2, explicit: true }));
    await reopened.idle();
    const record = JSON.parse(readFileSync(reopened.recordFile, 'utf8'));
    assert.equal(record.manualClose, false);
    assert.ok(record.closure?.overriddenAt);
    assert.equal(core.calls.filter(call => call.startsWith('split ')).length, 1);
    assert.equal(core.calls.filter(call => call.startsWith('run ')).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a close recorded after an explicit command still wins', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(corePanes());
    const controller = controllerFor(dir, fake, { now: () => NOW + 1000 });
    const closedAt = new Date(NOW + 5000).toISOString();
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeRecord(controller.recordFile, v2Record({ scope: protocolScope(), manualClose: true, phase: 'closed',
      closure: { reason: 'absence', at: closedAt, launchToken: 'L1', sessionId: 's1', lifetimeId: 'life1' },
      pendingEffect: null }));
    await controller.acceptLayout(settled({ panes: fake.panes, explicit: true, passSeq: 1 }));
    assert.equal(controller.state, 'closed-by-owner');
    assert.deepEqual(fake.calls, []);
    assert.equal(JSON.parse(readFileSync(controller.recordFile, 'utf8')).manualClose, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the coordination extension subscribes before replay and observes before shutdown', async t => {
  const dir = directory();
  const socket = join(dir, 'herdr.sock'), bin = join(dir, 'herdr.exe');
  writeFileSync(socket, ''); writeFileSync(bin, '');
  const saved = Object.fromEntries(['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH', 'HERDR_BIN_PATH']
    .map(key => [key, process.env[key]]));
  Object.assign(process.env, { HERDR_ENV: '1', HERDR_PANE_ID: 'P', HERDR_SOCKET_PATH: socket, HERDR_BIN_PATH: bin });
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const bus = new EventEmitter(), handlers = new Map(), order = [], actions = [];
  let created;
  const pi = {
    events: {
      on(name, callback) {
        if (name === RECOVERY_V1.layout) order.push('subscribe');
        bus.on(name, callback);
        return () => bus.off(name, callback);
      },
      emit(name, value) {
        if (name === RECOVERY_V1.layoutQuery) order.push('query');
        bus.emit(name, value);
      },
    },
    on(type, callback) { handlers.set(type, callback); return () => {}; },
    cwd: dir,
  };
  const fake = {
    async start() { actions.push('start'); },
    async stop() { actions.push('stop'); },
    acceptLayout(message) { actions.push('layout:' + message.passSeq); return Promise.resolve(); },
    acceptYield(message) { actions.push('yield:' + message.commandId); return Promise.resolve({ status: 'waiting' }); },
    async shutdownObserve() { actions.push('observe'); },
  };
  extension(pi, { createController: options => { created = options; return fake; } });
  const todoRecord = join(dir, 'todo.pane.json');
  writeFileSync(todoRecord, JSON.stringify({ scopeEpoch: 2, tabId: 't1' }));
  const todoOwner = { lifetimeId: 'life1', binding: { ownerKey: 'o1', sessionId: 's1', parentPaneId: 'P' },
    actor: { snapshot: { generation: 1 } }, todoRecord: { path: todoRecord }, claim: { tabId: 't1' } };
  const queries = [];
  bus.on('omo.herdr.dashboard.query', message => {
    if (message?.kind !== 'todo-owner') return;
    queries.push(message);
    bus.emit('omo.herdr.dashboard.reply', { v: 1, kind: 'todo-owner', requestId: message.requestId, provider: todoOwner });
  });
  const ctx = { hasUI: true, mode: 'tui', sessionManager: {
    getSessionFile: () => join(dir, 'parent.jsonl'), getSessionId: () => 's1' } };
  await handlers.get('session_start')({}, ctx);
  assert.equal(order[0], 'subscribe');
  assert.equal(order.includes('query'), true);
  assert.equal(order.indexOf('subscribe') < order.indexOf('query'), true);
  assert.equal(queries.length, 1);
  assert.equal(created.events, pi.events, 'the recovery bus reaches the coordination controller');
  assert.equal(bus.listenerCount(RECOVERY_V1.yield), 1, 'the yield channel is subscribed before replay');
  bus.emit(RECOVERY_V1.yield, { v: 1, kind: 'yield', scope: protocolScope(), commandId: 'yield-1' });
  assert.deepEqual(actions, ['start', 'yield:yield-1']);
  bus.emit(RECOVERY_V1.layout, settled({ panes: corePanes() }));
  assert.deepEqual(actions, ['start', 'yield:yield-1', 'layout:1']);
  await handlers.get('session_shutdown')();
  assert.deepEqual(actions, ['start', 'yield:yield-1', 'layout:1', 'observe', 'stop']);
});

test('11-o (a) a broker published after session_start flips the status on the post-bind event', async t => {
  const dir = directory();
  const socket = join(dir, 'herdr.sock'), bin = join(dir, 'herdr.exe');
  writeFileSync(socket, ''); writeFileSync(bin, '');
  const saved = Object.fromEntries(['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH', 'HERDR_BIN_PATH',
    'OMO_HERDR_COORDINATION_STATE_DIR'].map(key => [key, process.env[key]]));
  const savedBroker = globalThis[API_KEY], savedReady = globalThis[API_READY_KEY];
  delete globalThis[API_KEY]; delete globalThis[API_READY_KEY];
  Object.assign(process.env, { HERDR_ENV: '1', HERDR_PANE_ID: 'P11O', HERDR_SOCKET_PATH: socket,
    HERDR_BIN_PATH: bin, OMO_HERDR_COORDINATION_STATE_DIR: join(dir, 'coordination') });
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (savedBroker === undefined) delete globalThis[API_KEY]; else globalThis[API_KEY] = savedBroker;
    if (savedReady === undefined) delete globalThis[API_READY_KEY]; else globalThis[API_READY_KEY] = savedReady;
    rmSync(dir, { recursive: true, force: true });
  });
  const bus = new EventEmitter(), handlers = new Map();
  const pi = {
    events: {
      on(name, callback) { bus.on(name, callback); return () => bus.off(name, callback); },
      emit(name, value) { bus.emit(name, value); },
    },
    on(type, callback) { handlers.set(type, callback); return () => {}; },
    cwd: dir,
  };
  let controller;
  extension(pi, { createController: options => (controller = new CoordinationPane(options)) });
  const ctx = { hasUI: true, mode: 'tui', sessionManager: {
    getSessionFile: () => join(dir, 'parent.jsonl'), getSessionId: () => 's1' } };
  await handlers.get('session_start')({}, ctx);
  const statusFile = join(dir, 'coordination', 'P11O.status.json');
  const startup = JSON.parse(readFileSync(statusFile, 'utf8'));
  assert.equal(startup.state, 'no-carrier', 'session_start runs before the mod publishes its broker');
  // bindExtensions() has now returned; the mod installs its broker.
  globalThis[API_KEY] = { version: 1, features: [], getClient() {} };
  const refresh = handlers.get('before_agent_start');
  assert.equal(typeof refresh, 'function', 'a post-bind lifecycle event refreshes the status');
  await refresh({ type: 'before_agent_start' }, ctx);
  const connected = JSON.parse(readFileSync(statusFile, 'utf8'));
  assert.equal(connected.state, 'connected');
  assert.equal(connected.protocol, 'api v1');
  assert.equal(controller.statusWrites, 2);
  // A duplicate event is not a second write: the record stays byte-identical.
  const bytes = readFileSync(statusFile);
  await refresh({ type: 'before_agent_start' }, ctx);
  assert.deepEqual(readFileSync(statusFile), bytes);
  assert.equal(controller.statusWrites, 2);
  await handlers.get('session_shutdown')();
});

test('11-o (b) an identical post-bind refresh does not rewrite the status record', async () => {
  const dir = directory();
  try {
    const host = { [API_KEY]: { version: 1, features: [], getClient() {} } };
    const controller = new CoordinationPane({ stateDir: dir, parentPane: 'P11O-b', sessionId: 's1',
      host, env: {}, herdr: async () => ({}) });
    await controller.start();
    const file = join(dir, 'P11O-b.status.json');
    const bytes = readFileSync(file);
    await controller.writeStatus();
    await controller.writeStatus();
    assert.deepEqual(readFileSync(file), bytes, 'an identical snapshot is not rewritten');
    assert.equal(controller.statusWrites, 1);
    // A changed carrier state is still written exactly once.
    delete host[API_KEY];
    await controller.writeStatus();
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).state, 'no-carrier');
    assert.equal(controller.statusWrites, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('coordination placement no longer polls or scans role directories', () => {
  const source = readFileSync(new URL('../src/controller.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /readdir|dashboardIds|PLACE_ATTEMPTS|waiting-timeout/);
  assert.equal(typeof controllerModule.CoordinationPane.prototype.acceptLayout, 'function');
  assert.equal(typeof controllerModule.CoordinationPane.prototype.shutdownObserve, 'function');
  assert.equal(controllerModule.CoordinationPane.prototype.placeOnce, undefined);
});

test('a binding change between the event and the native row aborts before any mutation', async () => {
  const dir = directory();
  try {
    let changed = false;
    const fake = fakeHerdr(corePanes(), { onCall: async (args, api) => {
      if (args[0] !== 'layout' || changed) return;
      changed = true;
      api.setPanes([pane('P', 0, 0, 86, 46), pane('T', 86, 0, 86, 16),
        pane('W2', 86, 16, 34, 30), pane('G2', 120, 16, 52, 30)]);
    } });
    const controller = controllerFor(dir, fake);
    await controller.acceptLayout(settled({ panes: corePanes() }));
    assert.equal(controller.state, 'stale-layout');
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls.filter(call => call.startsWith('split ')).length, 0);
    assert.equal(fake.calls.filter(call => call.startsWith('close ')).length, 0);
    assert.equal(fake.calls.filter(call => call.startsWith('run ')).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a proven viewer exit in a live owned shell repairs in place without split or close', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(placedPanes());
    const controller = controllerFor(dir, fake);
    const { record } = seedPlaced(controller, fake.panes);
    writeMatchingProof(controller.recordFile, record, {
      exit: { reason: 'error', at: new Date(NOW).toISOString() },
      error: { message: 'frame write failed', at: new Date(NOW).toISOString() } });
    const rebased = [pane('P', 0, 0, 86, 46), pane('T', 86, 0, 86, 16),
      pane('C', 86, 16, 28, 30), pane('W2', 114, 16, 28, 30), pane('G2', 142, 16, 30, 30)];
    fake.setPanes(rebased);
    await controller.acceptLayout(settled({ panes: rebased, workers: 'W2', dag: 'G2', collab: 'C', passSeq: 2 }));
    assert.equal(fake.calls.filter(call => call.startsWith('split ')).length, 0);
    assert.equal(fake.calls.filter(call => call.startsWith('close ')).length, 0);
    assert.equal(fake.calls.filter(call => call.startsWith('run ')).length, 1);
    const next = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(next.paneId, 'C');
    assert.notEqual(next.launch.token, record.launch.token);
    assert.equal(next.pendingEffect, null);
    assert.equal(next.workers, 'W2');
    assert.equal(next.dag, 'G2');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a lost resize reply is not repeated on unchanged geometry and settles when observed', async () => {
  const dir = directory();
  try {
    let failed = false;
    const fake = fakeHerdr(placedPanes(), { onCall: async args => {
      if (args[0] !== 'resize' || failed) return;
      failed = true;
      throw new Error('reply lost: resize');
    } });
    const controller = controllerFor(dir, fake);
    const { record } = seedPlaced(controller, fake.panes);
    const wide = [pane('P', 0, 0, 100, 46), pane('T', 100, 0, 100, 16),
      pane('C', 100, 16, 28, 30), pane('W', 128, 16, 28, 30), pane('G', 156, 16, 44, 30)];
    fake.setPanes(wide);
    await controller.acceptLayout(settled({ panes: wide, collab: 'C', passSeq: 2 }));
    let next = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(next.pendingEffect.kind, 'resize');
    assert.equal(fake.calls.filter(call => call.startsWith('resize ')).length, 1);
    // The reply was lost before any effect. The same geometry is not resized twice.
    await controller.acceptLayout(settled({ panes: wide, collab: 'C', passSeq: 3 }));
    assert.equal(fake.calls.filter(call => call.startsWith('resize ')).length, 1);
    assert.equal(controller.state, 'resize-pending');
    // The delayed effect is observed; the same launch becomes current without
    // another resize, split or run.
    const resized = [pane('P', 0, 0, 100, 46), pane('T', 100, 0, 100, 16),
      pane('C', 100, 16, 33, 30), pane('W', 133, 16, 33, 30), pane('G', 166, 16, 34, 30)];
    fake.setPanes(resized);
    await controller.acceptLayout(settled({ panes: resized, collab: 'C', passSeq: 4 }));
    assert.equal(fake.calls.filter(call => call.startsWith('resize ')).length, 1);
    assert.equal(fake.calls.filter(call => call.startsWith('split ')).length, 0);
    assert.equal(fake.calls.filter(call => call.startsWith('run ')).length, 0);
    next = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(next.pendingEffect, null);
    assert.equal(next.launch.token, record.launch.token);
    assert.deepEqual(next.expected, { collab: 33, workers: 33, dag: 34 });
    assert.equal((await controller.status()).ready, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a proven viewer exit with an unchanged binding repairs in place', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(placedPanes());
    const controller = controllerFor(dir, fake);
    const { record } = seedPlaced(controller, fake.panes);
    writeMatchingProof(controller.recordFile, record, {
      exit: { reason: 'error', at: new Date(NOW).toISOString() },
      error: { message: 'frame write failed', at: new Date(NOW).toISOString() } });
    await controller.acceptLayout(settled({ panes: fake.panes, collab: 'C', passSeq: 2 }));
    assert.equal(fake.calls.filter(call => call.startsWith('split ')).length, 0);
    assert.equal(fake.calls.filter(call => call.startsWith('close ')).length, 0);
    assert.equal(fake.calls.filter(call => call.startsWith('run ')).length, 1);
    const next = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(next.paneId, 'C');
    assert.equal(next.workers, record.workers);
    assert.equal(next.dag, record.dag);
    assert.notEqual(next.launch.token, record.launch.token);
    assert.equal(next.pendingEffect, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a collab cell that is not the owned record is never taken over', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(placedPanes());
    const controller = controllerFor(dir, fake);
    await controller.acceptLayout(settled({ panes: fake.panes, collab: 'C' }));
    assert.equal(controller.state, 'foreign-cell');
    assert.deepEqual(fake.calls, []);
    assert.equal((await controller.status()).ready, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a fresh explicit command overrides an older owner close', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(corePanes());
    const controller = controllerFor(dir, fake);
    const base = v2Record({ scope: protocolScope() });
    const closedAt = new Date(NOW - 1000).toISOString();
    mkdirSync(join(dir, 'state'), { recursive: true });
    const closed = { ...base, manualClose: true, phase: 'closed',
      closure: { reason: 'owner-close', at: closedAt, launchToken: base.launch.token,
        sessionId: 's1', lifetimeId: 'life1' } };
    writeRecord(controller.recordFile, closed);
    writeMatchingProof(controller.recordFile, closed, { ownerClose: {
      reason: 'owner-close', at: closedAt, launchToken: base.launch.token, pane: 'C',
      bindingRevision: base.revisions.binding, sessionId: 's1', lifetimeId: 'life1' } });
    await controller.acceptLayout(settled({ panes: fake.panes, explicit: true, passSeq: 2 }));
    await controller.idle();
    const record = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(record.manualClose, false);
    assert.ok(record.closure?.overriddenAt);
    assert.equal(fake.calls.filter(call => call.startsWith('split ')).length, 1);
    assert.equal(fake.calls.filter(call => call.startsWith('run ')).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a close recorded after a queued explicit command wins', async () => {
  const dir = directory();
  try {
    let clock = NOW, first = true, release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const seen = new Promise(resolve => { entered = resolve; });
    const calls = [];
    const herdr = async (...args) => {
      calls.push(args.join(' '));
      if (first && args[0] === 'layout') { first = false; entered(); await gate; }
      return args[0] === 'layout' ? { layout: { tab_id: 't1', panes: corePanes() } } : {};
    };
    const controller = new CoordinationPane({ stateDir: join(dir, 'state'), dagStateDir: join(dir, 'dag'),
      parentPane: 'P', sessionId: 's1', cwd: dir, herdr, node: async () => 'node', viewer: 'viewer.mjs',
      activityPath: 'a.jsonl', host: {}, env: {}, now: () => clock });
    const running = controller.acceptLayout(settled({ panes: corePanes(), passSeq: 1 }));
    await seen;
    clock = NOW + 1000;
    const queued = controller.acceptLayout(settled({ panes: corePanes(), passSeq: 2, explicit: true }));
    clock = NOW + 2000;
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeRecord(controller.recordFile, { v: 2, paneId: 'C', sessionId: 's1', scope: protocolScope(),
      launch: { token: 'L1', at: new Date(NOW - 1000).toISOString() }, manualClose: true, phase: 'closed',
      closure: { reason: 'absence', at: new Date(clock).toISOString(), launchToken: 'L1' }, pendingEffect: null });
    clock = NOW + 3000;
    release();
    await Promise.all([running, queued]);
    await controller.idle();
    const record = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(record.manualClose, true);
    assert.equal(controller.state, 'closed-by-owner');
    assert.equal(calls.filter(call => call.startsWith('split ')).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a foreign owner in the same session cannot authorize a close', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(placedPanes());
    const controller = controllerFor(dir, fake);
    seedPlaced(controller, fake.panes);
    await controller.acceptLayout(settled({ panes: fake.panes, collab: 'C', passSeq: 2 }));
    assert.equal(controller.state, 'current');
    const before = fake.calls.length;
    await controller.acceptLayout(settled({ panes: fake.panes, collab: 'C', passSeq: 3,
      scope: protocolScope({ ownerKey: 'foreign-owner', lifetimeId: 'foreign-life' }) }));
    assert.equal(controller.state, 'foreign-scope');
    assert.equal(fake.calls.length, before);
    assert.equal(fake.calls.filter(call => call.startsWith('close ')).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a retained-shell run requires the live owned pane', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(corePanes());
    const controller = controllerFor(dir, fake);
    const { record } = seedPlaced(controller, placedPanes());
    writeMatchingProof(controller.recordFile, record, {
      exit: { reason: 'error', at: new Date(NOW).toISOString() },
      error: { message: 'frame write failed', at: new Date(NOW).toISOString() } });
    await controller.acceptLayout(settled({ panes: placedPanes(), collab: 'C', passSeq: 2 }));
    assert.equal(fake.calls.filter(call => call.startsWith('run ')).length, 0);
    assert.equal(controller.state, 'stale-layout');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resize recovery never retypes a run into a stale live viewer', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(placedPanes());
    const controller = controllerFor(dir, fake);
    const { record } = seedPlaced(controller, fake.panes);
    const pending = { ...record, pendingEffect: { kind: 'resize', at: new Date(NOW - 500).toISOString(),
      launchToken: record.launch.token, target: 'W', lastObserved: { collab: 20, workers: 20, dag: 46 } } };
    writeRecord(controller.recordFile, pending);
    writeMatchingProof(controller.recordFile, pending, {
      heartbeat: { seq: 1, at: new Date(NOW - 10000).toISOString() } });
    await controller.acceptLayout(settled({ panes: fake.panes, collab: 'C', passSeq: 2 }));
    assert.equal(fake.calls.filter(call => call.startsWith('run ')).length, 0);
    assert.notEqual(controller.state, 'running');
    const next = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(next.pendingEffect, null);
    assert.equal(next.phase, 'running');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('environment-off remains terminal for explicit recovery', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(corePanes());
    const controller = controllerFor(dir, fake, { env: { OMO_HERDR_COORDINATION_PANE: '0' } });
    await controller.start();
    assert.equal(controller.state, 'disabled');
    await controller.acceptLayout(settled({ panes: fake.panes, explicit: true, passSeq: 2 }));
    assert.equal(controller.state, 'disabled');
    assert.deepEqual(fake.calls, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an expired run never retires a foreign or wrong-tab record', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(placedPanes());
    const controller = controllerFor(dir, fake);
    const base = v2Record({ scope: protocolScope() });
    const effect = { kind: 'run', at: new Date(NOW - 2000).toISOString(),
      launchToken: base.launch.token, deadlineAt: NOW - 1000 };
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeRecord(controller.recordFile, { ...base, phase: 'launching',
      scope: { ...protocolScope(), ownerKey: 'foreign-owner' }, pendingEffect: effect });
    await controller.acceptLayout(settled({ panes: fake.panes, collab: 'C', passSeq: 2 }));
    assert.equal(controller.state, 'foreign-scope');
    assert.equal(fake.calls.filter(call => call.startsWith('close ')).length, 0);
    // The same controller remains pinned to the healthy scope. A record whose
    // scope names another tab cannot authorize retirement either.
    writeRecord(controller.recordFile, { ...base, phase: 'launching',
      scope: { ...protocolScope(), tabId: 'other-tab' }, pendingEffect: effect });
    await controller.acceptLayout(settled({ panes: fake.panes, collab: 'C', passSeq: 3 }));
    assert.equal(controller.state, 'foreign-scope');
    assert.equal(fake.calls.filter(call => call.startsWith('close ')).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an expired run never retires when the native tab differs', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(placedPanes());
    const calls = [];
    const herdr = async (...args) => {
      calls.push(args.join(' '));
      if (args[0] === 'layout') return { layout: { tab_id: 'other-tab', panes: fake.panes } };
      return fake.herdr(...args);
    };
    const controller = controllerFor(dir, herdr);
    const base = v2Record({ scope: protocolScope() });
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeRecord(controller.recordFile, { ...base, phase: 'launching',
      pendingEffect: { kind: 'run', at: new Date(NOW - 2000).toISOString(),
        launchToken: base.launch.token, deadlineAt: NOW - 1000 } });
    await controller.acceptLayout(settled({ panes: fake.panes, collab: 'C', passSeq: 2 }));
    assert.equal(controller.state, 'stale-layout');
    assert.equal(calls.filter(call => call.startsWith('close ')).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a native close after a successful restore is suppressed', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(corePanes());
    const controller = controllerFor(dir, fake);
    const base = v2Record({ scope: protocolScope() });
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeRecord(controller.recordFile, { ...base, paneId: 'C', manualClose: true, phase: 'closed',
      closure: { reason: 'absence', at: new Date(NOW - 5000).toISOString(),
        launchToken: base.launch.token, sessionId: 's1', lifetimeId: 'life1' }, pendingEffect: null });
    // The explicit restore is newer than the recorded absence, so it places a
    // fresh owned pane. Its createdAt is the placement time, after the override.
    await controller.acceptLayout(settled({ panes: corePanes(), explicit: true, passSeq: 2 }));
    await controller.idle();
    const splitBefore = fake.calls.filter(call => call.startsWith('split ')).length;
    const runBefore = fake.calls.filter(call => call.startsWith('run ')).length;
    assert.equal(splitBefore, 1);
    assert.equal(runBefore, 1);
    // The new pane is natively closed. This absence belongs to the launch
    // created after the restore, so it is recorded, not reopened.
    fake.setPanes(corePanes());
    await controller.acceptLayout(settled({ panes: corePanes(), passSeq: 3 }));
    const record = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(record.manualClose, true);
    assert.equal(record.phase, 'closed');
    assert.equal(fake.calls.filter(call => call.startsWith('split ')).length, splitBefore);
    assert.equal(fake.calls.filter(call => call.startsWith('run ')).length, runBefore);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a foreign record written during retirement revalidation is never overwritten or closed', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(placedPanes());
    let controller, replaced = false;
    const foreign = v2Record({ scope: protocolScope({ ownerKey: 'foreign-owner' }) });
    const herdr = async (...args) => {
      if (args[0] === 'layout' && !replaced) {
        replaced = true;
        writeFileSync(controller.recordFile, JSON.stringify({ ...foreign, marker: 'foreign-writer',
          phase: 'foreign-writer', pendingEffect: null }));
      }
      return fake.herdr(...args);
    };
    controller = controllerFor(dir, herdr);
    const base = v2Record({ scope: protocolScope() });
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeRecord(controller.recordFile, { ...base, phase: 'launching',
      pendingEffect: { kind: 'run', at: new Date(NOW - 2000).toISOString(),
        launchToken: base.launch.token, deadlineAt: NOW - 1000 } });
    await controller.acceptLayout(settled({ panes: fake.panes, collab: 'C', passSeq: 2 }));
    assert.equal(controller.state, 'foreign-scope');
    assert.equal(fake.calls.filter(call => call.startsWith('close ')).length, 0);
    const record = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(record.marker, 'foreign-writer');
    assert.equal(record.phase, 'foreign-writer');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an owned expired run still retires after all custody checks', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(placedPanes());
    const controller = controllerFor(dir, fake);
    const base = v2Record({ scope: protocolScope() });
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeRecord(controller.recordFile, { ...base, phase: 'launching',
      pendingEffect: { kind: 'run', at: new Date(NOW - 2000).toISOString(),
        launchToken: base.launch.token, deadlineAt: NOW - 1000 } });
    await controller.acceptLayout(settled({ panes: fake.panes, collab: 'C', passSeq: 2 }));
    assert.equal(controller.state, 'run-unconfirmed');
    assert.equal(fake.calls.filter(call => call.startsWith('close ')).length, 1);
    const record = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(record.phase, 'retiring');
    assert.equal(record.pendingEffect.kind, 'close');
    assert.equal(record.pendingEffect.reason, 'retirement');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a foreign record written between the CAS check and rename is kept and never closed', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(placedPanes());
    let controller, injected = false;
    const foreign = v2Record({ scope: protocolScope({ ownerKey: 'foreign-owner' }) });
    const fileSystem = {
      openSync: fs.openSync, closeSync: fs.closeSync, existsSync: fs.existsSync,
      readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync,
      linkSync: fs.linkSync, unlinkSync: fs.unlinkSync,
      renameSync(from, to) {
        if (!injected && from === controller.recordFile) {
          injected = true;
          fs.writeFileSync(controller.recordFile, JSON.stringify({ ...foreign, marker: 'foreign-writer',
            phase: 'foreign-writer', pendingEffect: null }));
        }
        return fs.renameSync(from, to);
      },
    };
    controller = controllerFor(dir, fake, { fileSystem });
    const base = v2Record({ scope: protocolScope() });
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeRecord(controller.recordFile, { ...base, phase: 'launching',
      pendingEffect: { kind: 'run', at: new Date(NOW - 2000).toISOString(),
        launchToken: base.launch.token, deadlineAt: NOW - 1000 } });
    await controller.acceptLayout(settled({ panes: fake.panes, collab: 'C', passSeq: 2 }));
    assert.equal(controller.state, 'foreign-scope');
    assert.equal(fake.calls.filter(call => call.startsWith('close ')).length, 0);
    const record = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(record.marker, 'foreign-writer');
    assert.equal(record.phase, 'foreign-writer');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a lifetime epoch generation change during final revalidation never closes', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(placedPanes());
    let layouts = 0, controller;
    const herdr = async (...args) => {
      if (args[0] === 'layout') {
        layouts++;
        if (layouts === 2) {
          const current = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
          fs.writeFileSync(controller.recordFile, JSON.stringify({ ...current,
            scope: { ...current.scope, lifetimeId: 'new-life', scopeEpoch: 2, generation: 2 } }));
        }
      }
      return fake.herdr(...args);
    };
    controller = controllerFor(dir, herdr);
    const base = v2Record({ scope: protocolScope() });
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeRecord(controller.recordFile, { ...base, phase: 'launching',
      pendingEffect: { kind: 'run', at: new Date(NOW - 2000).toISOString(),
        launchToken: base.launch.token, deadlineAt: NOW - 1000 } });
    await controller.acceptLayout(settled({ panes: fake.panes, collab: 'C', passSeq: 2 }));
    assert.equal(controller.state, 'foreign-scope');
    assert.equal(fake.calls.filter(call => call.startsWith('close ')).length, 0);
    const record = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(record.scope.lifetimeId, 'new-life');
    assert.equal(record.scope.scopeEpoch, 2);
    assert.equal(record.scope.generation, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a newer foreign record at the restore boundary is never overwritten', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(placedPanes());
    let controller, injectedFirst = false, injectedSecond = false;
    const foreignFirst = { ...v2Record({ scope: protocolScope({ ownerKey: 'foreign-first' }) }),
      marker: 'foreign-first', phase: 'foreign-first-phase' };
    const foreignSecond = { ...v2Record({ scope: protocolScope({ ownerKey: 'foreign-second' }) }),
      marker: 'foreign-second', phase: 'foreign-second-phase' };
    const fileSystem = {
      openSync: fs.openSync, closeSync: fs.closeSync, existsSync: fs.existsSync,
      readFileSync: fs.readFileSync, linkSync: fs.linkSync, unlinkSync: fs.unlinkSync,
      renameSync(from, to) {
        if (from === controller.recordFile && !injectedFirst) {
          injectedFirst = true;
          fs.writeFileSync(from, JSON.stringify(foreignFirst));
        }
        return fs.renameSync(from, to);
      },
      writeFileSync(file, data, options) {
        if (file === controller.recordFile && !injectedSecond) {
          injectedSecond = true;
          fs.writeFileSync(file, JSON.stringify(foreignSecond));
        }
        return fs.writeFileSync(file, data, options);
      },
    };
    controller = controllerFor(dir, fake, { fileSystem });
    const base = v2Record({ scope: protocolScope() });
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeRecord(controller.recordFile, { ...base, phase: 'launching',
      pendingEffect: { kind: 'run', at: new Date(NOW - 2000).toISOString(),
        launchToken: base.launch.token, deadlineAt: NOW - 1000 } });
    await controller.acceptLayout(settled({ panes: fake.panes, collab: 'C', passSeq: 2 }));
    assert.equal(controller.state, 'foreign-scope');
    assert.equal(fake.calls.filter(call => call.startsWith('close ')).length, 0);
    const record = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(record.marker, 'foreign-second');
    assert.equal(record.phase, 'foreign-second-phase');
    assert.deepEqual(fs.readdirSync(join(dir, 'state')).filter(name => /\.(lock|tmp|bak)$/.test(name)), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a binding change during final revalidation never closes', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(placedPanes());
    let layouts = 0, controller;
    const herdr = async (...args) => {
      if (args[0] === 'layout') {
        layouts++;
        if (layouts === 2) {
          const current = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
          const binding = controllerModule.bindingRevision(current.scope, { workers: 'W2', dag: 'G2' });
          fs.writeFileSync(controller.recordFile, JSON.stringify({ ...current, workers: 'W2', dag: 'G2',
            revisions: { ...current.revisions, binding }, marker: 'final-writer' }));
        }
      }
      return fake.herdr(...args);
    };
    controller = controllerFor(dir, herdr);
    const base = v2Record({ scope: protocolScope() });
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeRecord(controller.recordFile, { ...base, phase: 'launching',
      pendingEffect: { kind: 'run', at: new Date(NOW - 2000).toISOString(),
        launchToken: base.launch.token, deadlineAt: NOW - 1000 } });
    await controller.acceptLayout(settled({ panes: fake.panes, collab: 'C', passSeq: 2 }));
    assert.equal(controller.state, 'foreign-scope');
    assert.equal(fake.calls.filter(call => call.startsWith('close ')).length, 0);
    const record = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(record.workers, 'W2');
    assert.equal(record.dag, 'G2');
    assert.notEqual(record.revisions.binding, base.revisions.binding);
    assert.deepEqual(fs.readdirSync(join(dir, 'state')).filter(name => /\.(lock|tmp|bak)$/.test(name)), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a newer owner close during final revalidation wins over retirement', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(placedPanes());
    let layouts = 0, controller;
    const herdr = async (...args) => {
      if (args[0] === 'layout') {
        layouts++;
        if (layouts === 2) {
          const current = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
          writeMatchingProof(controller.recordFile, current, {
            ownerClose: { reason: 'owner-close', at: new Date(NOW).toISOString(),
              launchToken: current.launch.token, pane: current.paneId,
              bindingRevision: current.revisions?.binding ?? current.binding?.revision,
              sessionId: current.sessionId, lifetimeId: current.scope.lifetimeId },
          });
        }
      }
      return fake.herdr(...args);
    };
    controller = controllerFor(dir, herdr);
    const base = v2Record({ scope: protocolScope() });
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeRecord(controller.recordFile, { ...base, phase: 'launching',
      pendingEffect: { kind: 'run', at: new Date(NOW - 2000).toISOString(),
        launchToken: base.launch.token, deadlineAt: NOW - 1000 } });
    await controller.acceptLayout(settled({ panes: fake.panes, collab: 'C', passSeq: 2 }));
    assert.equal(controller.state, 'owner-closed');
    assert.equal(fake.calls.filter(call => call.startsWith('close ')).length, 0);
    const record = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(record.manualClose, true);
    assert.equal(record.phase, 'closed');
    assert.equal(record.closure.reason, 'owner-close');
    assert.equal(record.pendingEffect, null);
    assert.deepEqual(fs.readdirSync(join(dir, 'state')).filter(name => /\.(lock|tmp|bak)$/.test(name)), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a mismatched owner intent does not suppress retirement or alter the sidecar', async () => {
  const cases = [
    ['bindingRevision', 'OLD-BINDING'],
    ['sessionId', 'OTHER-SESSION'],
    ['lifetimeId', 'OLD-LIFETIME'],
  ];
  for (const [field, value] of cases) {
    const dir = directory();
    try {
      const fake = fakeHerdr(placedPanes());
      let layouts = 0, controller, sidecarText = null;
      const herdr = async (...args) => {
        if (args[0] === 'layout') {
          layouts++;
          if (layouts === 2) {
            const current = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
            writeMatchingProof(controller.recordFile, current, {
              ownerClose: { reason: 'owner-close', at: new Date(NOW).toISOString(),
                launchToken: current.launch.token, pane: current.paneId,
                bindingRevision: current.revisions?.binding ?? current.binding?.revision,
                sessionId: current.sessionId, lifetimeId: current.scope.lifetimeId, [field]: value },
            });
            sidecarText = readFileSync(viewerModule.viewerProofPath(controller.recordFile), 'utf8');
          }
        }
        return fake.herdr(...args);
      };
      controller = controllerFor(dir, herdr);
      const base = v2Record({ scope: protocolScope() });
      mkdirSync(join(dir, 'state'), { recursive: true });
      writeRecord(controller.recordFile, { ...base, manualClose: false, phase: 'launching',
        pendingEffect: { kind: 'run', at: new Date(NOW - 2000).toISOString(),
          launchToken: base.launch.token, deadlineAt: NOW - 1000 } });
      await controller.acceptLayout(settled({ panes: fake.panes, collab: 'C', passSeq: 2 }));
      assert.equal(controller.state, 'run-unconfirmed', field);
      assert.equal(fake.calls.filter(call => call.startsWith('close ')).length, 1, field);
      const record = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
      assert.equal(record.manualClose, false, field);
      assert.equal(record.pendingEffect.reason, 'retirement', field);
      assert.equal(readFileSync(viewerModule.viewerProofPath(controller.recordFile), 'utf8'), sidecarText, field);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

// --- PENDING-6b: coordination consumes the scoped yield ---------------------

function yieldSetup(version, overrides = {}) {
  const dir = directory();
  mkdirSync(join(dir, 'state'), { recursive: true });
  const fake = fakeHerdr(placedPanes(), overrides.fakeOptions);
  const controller = controllerFor(dir, fake, overrides.controller);
  const message = settled({ panes: placedPanes(), collab: 'C', explicit: true });
  let record;
  if (version === 2) {
    const collabRect = placedPanes().find(entry => entry.pane_id === 'C').rect;
    const revision = controllerModule.bindingRevision(message.scope, { workers: 'W', dag: 'G' });
    record = v2Record({ scope: message.scope, workers: 'W', dag: 'G',
      identity: { paneId: 'C', shellPid: 1357, viewerPid: 2468,
        viewerStartedAt: '2026-10-20T11:59:59.000Z' },
      binding: { workers: 'W', dag: 'G', revision },
      revisions: { binding: revision, geometry: controllerModule.geometryRevision('C', collabRect) },
      rect: collabRect, layout: { commandId: message.commandId, passSeq: message.passSeq,
        bindingRevision: message.bindingRevision, geometryRevision: message.geometryRevision } });
    writeRecord(controller.recordFile, record);
    writeMatchingProof(controller.recordFile, record);
  } else {
    record = { v: 1, paneId: 'C', parentPaneId: 'P', sessionId: 's1', tabId: 't1',
      viewer: 'viewer.mjs', createdAt: new Date(NOW - 2000).toISOString(), phase: 'running',
      workers: 'W', dag: 'G' };
    writeRecord(controller.recordFile, record);
  }
  return { dir, fake, controller, message, record };
}

function legacyYieldProof(controller, record, overrides = {}) {
  const expected = ['viewer.mjs', '--status', controller.statusFile, '--activity', controller.activityPath,
    '--session', 's1', '--record', controller.recordFile, '--lang', 'en', '--close-pane', 'C'];
  return { v: 1, paneId: 'C', parentPaneId: 'P', sessionId: 's1', tabId: 't1',
    createdAt: record.createdAt, shellPid: 456, shellBirth: '133000000000000000',
    shellCreationDate: '2026-10-20T11:59:58.000Z', viewerPid: 123,
    viewerBirth: '133000000030000000', viewerCreationDate: '2026-10-20T11:59:59.000Z',
    viewerPath: 'viewer.mjs', language: 'en', expected, argv: expected,
    argvDigest: '0'.repeat(64), ...overrides };
}

function legacyHerdr(fake, proof) {
  return async (...args) => args[0] === 'process-info'
    ? { process_info: { pane_id: args[2], shell_pid: proof.shellPid,
      foreground_processes: [{ pid: proof.viewerPid, argv: ['node.exe', ...proof.argv] }] } }
    : fake.herdr(...args);
}

function v2Herdr(fake, record) {
  return async (...args) => args[0] === 'process-info'
    ? { process_info: { pane_id: args[2], shell_pid: record.identity.shellPid,
      foreground_processes: [{ pid: record.identity.viewerPid, argv: ['node.exe', 'viewer.mjs'] }] } }
    : fake.herdr(...args);
}

function yieldEvents() {
  const results = [];
  return { results, events: { emit(name, value) { if (name === RECOVERY_V1.result) results.push(value); } } };
}

test('a scoped v2 yield closes exactly its proven pane, records a yield closure and publishes the next row', async () => {
  const setup = yieldSetup(2);
  try {
    const { fake, controller, message, record } = setup;
    controller.herdr = v2Herdr(fake, record);
    await controller.acceptLayout(message);
    assert.equal(controller.state, 'current');
    const { results, events } = yieldEvents();
    controller.events = events;
    const before = readFileSync(controller.recordFile, 'utf8');
    const outcome = await controller.acceptYield({ v: 1, kind: 'yield', scope: message.scope,
      commandId: 'yield-v2', reason: 'layout-migration', paneId: 'C' });
    assert.equal(outcome.status, 'settled');
    assert.equal(outcome.waiting, false);
    assert.equal(fake.calls.filter(call => call.startsWith('close ')).length, 1);
    assert.equal(fake.calls.filter(call => call === 'close C').length, 1);
    assert.equal(fake.panes.some(entry => entry.pane_id === 'C'), false);
    const written = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.notEqual(readFileSync(controller.recordFile, 'utf8'), before);
    assert.equal(written.paneId, null);
    assert.equal(written.phase, 'yielded');
    assert.equal(written.manualClose, false);
    assert.equal(written.pendingEffect, null);
    assert.equal(written.closure.reason, 'yield');
    assert.equal(written.closure.commandId, 'yield-v2');
    assert.equal(results.length, 1);
    assert.equal(results[0].kind, 'result');
    assert.equal(results[0].commandId, 'yield-v2');
    assert.equal(results[0].status, 'settled');
    assert.equal(results[0].collab.current, false);
    assert.equal(results[0].collab.yielded, true);
    assert.deepEqual(results[0].core.cells.map(cell => cell.role), ['workers', 'dag']);
    assert.deepEqual(results[0].core.band, { x: 86, y: 16, width: 86, height: 30 });
    assert.equal(controller.collabCurrent, false);
  } finally { rmSync(setup.dir, { recursive: true, force: true }); }
});

test('a scoped v1 yield closes its freshly re-proved pane and records a yield, not an owner close', async () => {
  const setup = yieldSetup(1);
  try {
    const { fake, controller, message, record } = setup;
    const proof = legacyYieldProof(controller, record);
    controller.herdr = legacyHerdr(fake, proof);
    await controller.acceptLayout(message);
    assert.equal(controller.state, 'legacy-waiting');
    const { results, events } = yieldEvents();
    controller.events = events;
    const outcome = await controller.acceptYield({ v: 1, kind: 'yield', scope: message.scope,
      commandId: 'yield-v1', reason: 'layout-migration', paneId: 'C', legacyProof: proof });
    assert.equal(outcome.status, 'settled');
    assert.equal(fake.calls.filter(call => call.startsWith('close ')).length, 1);
    assert.equal(fake.panes.some(entry => entry.pane_id === 'C'), false);
    const written = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(written.v, 1);
    assert.equal(written.paneId, null);
    assert.equal(written.phase, 'yielded');
    assert.notEqual(written.manualClose, true);
    assert.equal(written.closure.reason, 'yield');
    assert.equal(written.pendingEffect, null);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'settled');
    assert.equal(results[0].collab.yielded, true);
  } finally { rmSync(setup.dir, { recursive: true, force: true }); }
});

test('a yield with a foreign scope or another pane closes nothing and leaves the record byte-identical', async () => {
  const attempts = [
    ['foreign scope', message => ({ ...message, scope: { ...message.scope, lifetimeId: 'other-life' } })],
    ['foreign tab', message => ({ ...message, scope: { ...message.scope, tabId: 'other-tab' } })],
    ['another pane', message => ({ ...message, paneId: 'X' })],
  ];
  for (const [label, mutate] of attempts) {
    const setup = yieldSetup(2);
    try {
      const { fake, controller, message, record } = setup;
      controller.herdr = v2Herdr(fake, record);
      await controller.acceptLayout(message);
      const before = readFileSync(controller.recordFile, 'utf8');
      const { results, events } = yieldEvents();
      controller.events = events;
      const mutated = mutate(message);
      const outcome = await controller.acceptYield({ v: 1, kind: 'yield', scope: mutated.scope,
        commandId: `yield-${label}`, reason: 'layout-migration', paneId: mutated.paneId });
      assert.equal(outcome.status, 'waiting', label);
      assert.equal(outcome.waiting, true, label);
      assert.equal(fake.calls.filter(call => call.startsWith('close ')).length, 0, label);
      assert.equal(fake.panes.some(entry => entry.pane_id === 'C'), true, label);
      assert.equal(readFileSync(controller.recordFile, 'utf8'), before, label);
      assert.equal(results.length, label === 'another pane' ? 1 : 0, label);
      if (results.length) assert.equal(results[0].status, 'waiting', label);
    } finally { rmSync(setup.dir, { recursive: true, force: true }); }
  }
});

test('a yield without current proof closes nothing and leaves the record byte-identical', async () => {
  // v2: the viewer sidecar is absent or stale; v1: no proof, or a proof that
  // does not match the fresh native shell identity.
  const cases = [
    ['v2 missing proof', 2, controller => {
      rmSync(viewerModule.viewerProofPath(controller.recordFile), { force: true });
      return { proof: null };
    }],
    ['v2 stale proof', 2, (controller, record) => {
      writeMatchingProof(controller.recordFile, record,
        { heartbeat: { seq: 1, at: new Date(NOW - 60000).toISOString() } });
      return { proof: null };
    }],
    ['v1 missing proof', 1, () => ({ proof: undefined })],
    ['v1 foreign shell', 1, (controller, record) => ({
      proof: legacyYieldProof(controller, record, { shellPid: 999 }) })],
    ['v1 foreign argv', 1, (controller, record) => ({
      proof: legacyYieldProof(controller, record, { argv: ['viewer.mjs', '--foreign'] }) })],
  ];
  for (const [label, version, prepare] of cases) {
    const setup = yieldSetup(version);
    try {
      const { fake, controller, message, record } = setup;
      const prepared = prepare(controller, record);
      controller.herdr = version === 1 ? legacyHerdr(fake, prepared.proof ?? legacyYieldProof(controller, record))
        : v2Herdr(fake, record);
      if (version === 1 && prepared.proof) controller.herdr = legacyHerdr(fake, legacyYieldProof(controller, record));
      await controller.acceptLayout(message);
      const before = readFileSync(controller.recordFile, 'utf8');
      const { results, events } = yieldEvents();
      controller.events = events;
      const outcome = await controller.acceptYield({ v: 1, kind: 'yield', scope: message.scope,
        commandId: `yield-${label}`, reason: 'layout-migration', paneId: 'C', legacyProof: prepared.proof });
      assert.equal(outcome.status, 'waiting', label);
      assert.equal(outcome.waiting, true, label);
      assert.equal(fake.calls.filter(call => call.startsWith('close ')).length, 0, label);
      assert.equal(fake.panes.some(entry => entry.pane_id === 'C'), true, label);
      assert.equal(readFileSync(controller.recordFile, 'utf8'), before, label);
      assert.equal(results.length, 1, `${label}: a same-scope wait is published`);
      assert.equal(results[0].status, 'waiting', label);
      assert.equal(results[0].collab.current, false, label);
    } finally { rmSync(setup.dir, { recursive: true, force: true }); }
  }
});

test('after a valid v1 proof, a fresh foreign child argv or shell-only evidence gives zero closes', async () => {
  for (const [label, mode] of [['child argv becomes foreign (fresh read is shell-only)', 'after-initial'],
    ['foreign child argv still reported', 'reported'], ['ambiguous shell and child', 'ambiguous'],
    ['shell-only evidence', 'always']]) {
    const setup = yieldSetup(1);
    try {
      const { fake, controller, message, record } = setup;
      const proof = legacyYieldProof(controller, record);
      const canonical = [{ pid: proof.viewerPid, argv: ['node.exe', ...proof.argv] }];
      const foreign = [{ pid: proof.viewerPid,
        argv: ['node.exe', proof.argv[0], '--foreign'] }];
      const shellOnlyRows = [{ pid: proof.shellPid, argv: ['powershell.exe'] }];
      let index = 0;
      controller.herdr = async (...args) => {
        if (args[0] !== 'process-info') return fake.herdr(...args);
        const selected = mode === 'always' ? shellOnlyRows
          : mode === 'ambiguous' ? [shellOnlyRows[0], canonical[0]]
          : mode === 'reported' ? (index++ === 0 ? canonical : foreign)
            : (index++ === 0 ? canonical : shellOnlyRows);
        return { process_info: { pane_id: args[2], shell_pid: proof.shellPid,
          foreground_processes: selected } };
      };
      await controller.acceptLayout(message);
      const before = readFileSync(controller.recordFile, 'utf8');
      const { results, events } = yieldEvents();
      controller.events = events;
      const outcome = await controller.acceptYield({ v: 1, kind: 'yield', scope: message.scope,
        commandId: `yield-${label}`, reason: 'layout-migration', paneId: 'C', legacyProof: proof });
      assert.equal(outcome.status, 'waiting', label);
      assert.equal(outcome.waiting, true, label);
      assert.equal(fake.calls.filter(call => call.startsWith('close ')).length, 0, label);
      assert.equal(fake.panes.some(entry => entry.pane_id === 'C'), true, label);
      assert.equal(readFileSync(controller.recordFile, 'utf8'), before, label);
      assert.equal(results.length, 1, label);
      assert.equal(results[0].status, 'waiting', label);
    } finally { rmSync(setup.dir, { recursive: true, force: true }); }
  }
});

test('a disappearance observed in a different tab is not accepted and keeps the yield journal unresolved', async () => {
  const setup = yieldSetup(2);
  try {
    const { fake, controller, message, record } = setup;
    const v2 = v2Herdr(fake, record);
    let closed = false;
    controller.herdr = async (...args) => {
      if (args[0] === 'close') { const result = await fake.herdr(...args); closed = true; return result; }
      if (args[0] === 'layout' && closed) {
        return { layout: { tab_id: 't2', panes: fake.panes.map(entry => ({ ...entry, rect: { ...entry.rect } })) } };
      }
      return v2(...args);
    };
    await controller.acceptLayout(message);
    const { results, events } = yieldEvents();
    controller.events = events;
    const outcome = await controller.acceptYield({ v: 1, kind: 'yield', scope: message.scope,
      commandId: 'yield-wrong-tab', reason: 'layout-migration', paneId: 'C' });
    assert.equal(outcome.status, 'waiting');
    assert.equal(outcome.waiting, true);
    assert.equal(outcome.state, 'yield-stale-tab');
    assert.equal(fake.calls.filter(call => call.startsWith('close ')).length, 1);
    assert.equal(fake.panes.some(entry => entry.pane_id === 'C'), false);
    const journal = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(journal.paneId, 'C', 'the recorded pane is retained until the same-tab query proves it gone');
    assert.equal(journal.phase, 'yielding');
    assert.equal(journal.pendingEffect.kind, 'close');
    assert.equal(journal.pendingEffect.paneId, 'C');
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'waiting');
    assert.equal(results.some(result => result.status === 'settled'), false);
  } finally { rmSync(setup.dir, { recursive: true, force: true }); }
});

test('a malformed yield is refused without a native call or a record write', async () => {
  const setup = yieldSetup(2);
  try {
    const { fake, controller, message, record } = setup;
    controller.herdr = v2Herdr(fake, record);
    await controller.acceptLayout(message);
    const before = readFileSync(controller.recordFile, 'utf8');
    for (const malformed of [
      { v: 1, kind: 'yield', scope: {}, commandId: 'bad-scope', paneId: 'C' },
      { v: 1, kind: 'layout', scope: message.scope, commandId: 'bad-kind', paneId: 'C' },
      { v: 1, kind: 'yield', scope: message.scope, paneId: 'C' },
    ]) {
      const outcome = await controller.acceptYield(malformed);
      assert.equal(outcome.status, 'waiting');
      assert.equal(outcome.waiting, true);
    }
    assert.equal(fake.calls.some(call => call.startsWith('close ')), false);
    assert.equal(fake.calls.some(call => call.startsWith('process-info ')), false);
    assert.equal(readFileSync(controller.recordFile, 'utf8'), before);
  } finally { rmSync(setup.dir, { recursive: true, force: true }); }
});

test('a lost close reply journals the yield effect and a repeated yield never closes twice', async () => {
  const setup = yieldSetup(2, { fakeOptions: { loseReply: new Set(['close']) } });
  try {
    const { fake, controller, message, record } = setup;
    controller.herdr = v2Herdr(fake, record);
    await controller.acceptLayout(message);
    const { results, events } = yieldEvents();
    controller.events = events;
    const first = await controller.acceptYield({ v: 1, kind: 'yield', scope: message.scope,
      commandId: 'yield-lost', reason: 'layout-migration', paneId: 'C' });
    assert.equal(first.status, 'waiting');
    assert.equal(first.state, 'effect-unknown');
    assert.equal(fake.calls.filter(call => call === 'close C').length, 1);
    const journaled = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(journaled.phase, 'yielding');
    assert.equal(journaled.closure.reason, 'yield');
    assert.equal(journaled.pendingEffect.kind, 'close');
    assert.equal(journaled.pendingEffect.paneId, 'C');
    const second = await controller.acceptYield({ v: 1, kind: 'yield', scope: message.scope,
      commandId: 'yield-lost-again', reason: 'layout-migration', paneId: 'C' });
    assert.equal(second.status, 'waiting');
    assert.equal(second.state, 'yield-effect-pending');
    assert.equal(fake.calls.filter(call => call === 'close C').length, 1, 'a lost reply never repeats the close');
    assert.equal(results.length, 2, 'both waits are published');
    assert.equal(results[0].status, 'waiting');
    assert.equal(results[1].status, 'waiting');
  } finally { rmSync(setup.dir, { recursive: true, force: true }); }
});

test('an already-overridden owner intent does not suppress retirement or leave a stuck close', async () => {
  const dir = directory();
  try {
    const fake = fakeHerdr(placedPanes());
    let layouts = 0, controller;
    const herdr = async (...args) => {
      if (args[0] === 'layout') {
        layouts++;
        if (layouts === 2) {
          const current = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
          writeMatchingProof(controller.recordFile, current, {
            ownerClose: { reason: 'owner-close', at: new Date(NOW - 1000).toISOString(),
              launchToken: current.launch.token, pane: current.paneId,
              bindingRevision: current.revisions?.binding ?? current.binding?.revision,
              sessionId: current.sessionId, lifetimeId: current.scope.lifetimeId },
          });
        }
      }
      return fake.herdr(...args);
    };
    controller = controllerFor(dir, herdr);
    const base = v2Record({ scope: protocolScope() });
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeRecord(controller.recordFile, { ...base, manualClose: false, phase: 'launching',
      closure: { reason: 'owner-close', at: new Date(NOW - 2000).toISOString(),
        overriddenAt: new Date(NOW - 500).toISOString() },
      pendingEffect: { kind: 'run', at: new Date(NOW - 2000).toISOString(),
        launchToken: base.launch.token, deadlineAt: NOW - 1000 } });
    await controller.acceptLayout(settled({ panes: fake.panes, collab: 'C', passSeq: 2 }));
    assert.equal(controller.state, 'run-unconfirmed');
    assert.equal(fake.calls.filter(call => call.startsWith('close ')).length, 1);
    const record = JSON.parse(readFileSync(controller.recordFile, 'utf8'));
    assert.equal(record.manualClose, false);
    assert.equal(record.pendingEffect.reason, 'retirement');
    assert.equal(record.closure.overriddenAt, new Date(NOW - 500).toISOString());
    assert.deepEqual(fs.readdirSync(join(dir, 'state')).filter(name => /\.(lock|tmp|bak)$/.test(name)), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
