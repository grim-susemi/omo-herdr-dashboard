import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import extension from '../extension.mjs';
import { RECOVERY_V1, validScope } from '../../coordination/src/recovery.mjs';

test('child lifecycle and explicit command return before UI availability or ownership checks', async () => {
  const handlers = new Map(), commands = new Map();
  const pi = { on(type, callback) { handlers.set(type, callback); return () => {}; },
    registerCommand(name, command) { commands.set(name, command); } };
  extension(pi);
  const child = { sessionManager: { getSessionFile: () => '/synthetic/senpi-task/children/child/native.jsonl' },
    get hasUI() { throw new Error('Child UI was inspected'); } };
  await handlers.get('session_start')({}, child);
  await handlers.get('session_tree')({}, child);
  assert.deepEqual([...commands.keys()], ['dashboard']);
  await commands.get('dashboard').handler('', child);
  await handlers.get('session_shutdown')();
  assert.equal(commands.size, 1);
});

test('noninteractive lifecycle and commands never create a controller or read a parent session ID', async () => {
  const handlers = new Map(), commands = new Map();
  extension({ on(type, callback) { handlers.set(type, callback); return () => {}; },
    registerCommand(name, command) { commands.set(name, command); } });
  for (const ctx of [{ hasUI: false, mode: 'tui' }, { hasUI: true, mode: 'rpc' }]) {
    ctx.sessionManager = { getSessionFile: () => '/synthetic/parent.jsonl',
      getSessionId() { throw new Error('Noninteractive ownership was inspected'); } };
    await handlers.get('session_start')({}, ctx);
    await commands.get('dashboard').handler('', ctx);
  }
});

test('dashboard command asks the connected core for its last settled layout', async t => {
  const directory = join(tmpdir(), `dag-extension-${process.pid}-${randomUUID()}`);
  const socket = join(directory, 'synthetic.sock'), bin = join(directory, 'herdr.exe');
  await mkdir(directory);
  await writeFile(socket, ''); await writeFile(bin, '');
  const saved = Object.fromEntries(['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH', 'HERDR_BIN_PATH',
    'OMO_HERDR_COORDINATION_LANG'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { HERDR_ENV: '1', HERDR_PANE_ID: 'qa:parent',
    HERDR_SOCKET_PATH: socket, HERDR_BIN_PATH: bin, OMO_HERDR_COORDINATION_LANG: 'ko' });
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const bus = new EventEmitter(), handlers = new Map(), commands = new Map();
  const pi = { events: { on(name, callback) { bus.on(name, callback); return () => bus.off(name, callback); },
    emit(name, value) { bus.emit(name, value); } },
  on(type, callback) { handlers.set(type, callback); return () => {}; },
  registerCommand(name, command) { commands.set(name, command); } };
  const scope = { ownerKey: 'synthetic-owner', sessionId: 'synthetic-session', lifetimeId: 'synthetic-lifetime',
    scopeEpoch: 1, generation: 1, tabId: 'synthetic-tab' };
  const todoOwner = { scopeEpoch: 1, recoveryScope: () => scope, coordinator: () => ({ schedule: async () => {} }) };
  const opened = [];
  let captured;
  const controller = {
    binding: { socketPath: socket, parentPaneId: 'qa:parent', sessionId: scope.sessionId, ownerKey: scope.ownerKey },
    lifetimeId: scope.lifetimeId, stopped: false,
    coordinator: { actor: { blocked: false, leaseHeld: true, draining: false }, schedule: async () => {} },
    provider: () => ({ setCoordinator() {} }),
    async start() {}, async stop() {}, async openPair() {},
    async open() { opened.push('open'); },
  };
  extension(pi, { createController: options => { captured = options; return controller; } });
  bus.emit('omo.herdr.dashboard.provider', { v: 2, kind: 'managed-availability',
    socketPath: socket, parentPaneId: 'qa:parent', stateDir: directory,
    service: { start: async () => todoOwner } });
  const queries = [];
  bus.on(RECOVERY_V1.layoutQuery, message => queries.push(message));
  const ctx = { hasUI: true, mode: 'tui', ui: { notify() {} }, sessionManager: {
    getSessionFile: () => join(directory, 'parent.jsonl'), getSessionId: () => scope.sessionId } };
  await handlers.get('session_start')({}, ctx);
  await commands.get('dashboard').handler('', ctx);
  assert.deepEqual(opened, ['open']);
  assert.equal(captured.events, pi.events, 'the yield bus reaches the DAG controller');
  assert.equal(captured.coordinationLanguage, 'ko', 'the managed coordination locale reaches the proof');
  assert.equal(queries.length, 1);
  assert.equal(queries[0].kind, 'layout-query');
  assert.equal(queries[0].v, 1);
  assert.equal(validScope(queries[0].scope), true);
  assert.deepEqual(queries[0].scope, scope);
  assert.equal(typeof queries[0].commandId, 'string');
  assert.equal(typeof queries[0].requestId, 'string');
  await handlers.get('session_shutdown')();
});
