// Migrated native host tests.
//
// Run through: npm run test:host -- --senpi-root <path-to-@code-yeongyu/senpi>
// These cases exercise the actual installed Senpi SDK: real builtin-first
// ResourceLoader ordering, the registered native Todo tool and command
// callbacks, the real SessionManager branch, the D0-derived child-session guard,
// and native factory capture/restore through the original setter. No PTY, IPC,
// provider call or live-install write happens here; those belong to later tasks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createNativeHost, WIDGET_KEY } from '../../src/native-host.mjs';
import { compareToDeclared, hashManifest, summarizeIdentity } from '../../src/source-hashes.mjs';
import { PROBE_HOST_KEY, installProbe } from './fixture-extension.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const senpiRoot = process.env.OMO_HERDR_SENPI_ROOT;
const fixtureRoot = process.env.OMO_HERDR_FIXTURE_ROOT;
const manifestPath = process.env.OMO_HERDR_NATIVE_MANIFEST ?? join(root, 'config/native-source-manifest.json');

if (!senpiRoot || !fixtureRoot) {
  throw new Error('OMO_HERDR_SENPI_ROOT/OMO_HERDR_FIXTURE_ROOT are missing. ' +
    'Run the host suite through: npm run test:host -- --senpi-root <path-to-@code-yeongyu/senpi>');
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const relativePaths = manifest.files.map(file => file.path);
const declared = Object.fromEntries(manifest.files.map(file => [file.path, file.sha256]));

const home = join(fixtureRoot, 'home');
const cwd = join(home, 'cwd');
const agentDir = join(home, 'agent');
const tmp = join(fixtureRoot, 'tmp');
const parentSessionFile = 'C:/fixture/sessions/parent/session.jsonl';
// The runner wraps the UI context in a shallow copy, so the native extension
// receives that copy as ctx.ui. Fabricated contexts must use the same object.
const runnerUI = () => host.runner.getUIContext();

let host;
let surface;
let probe;
let owner;
let beforeHashes;
let sequence = 0;
let paintedMarker = null;

// The probe host must be reachable from globalThis BEFORE the extension factory
// runs, because the factory resolves it while binding its session_start handler.
const probeHost = {
  get owner() { return owner; },
  leaf: () => host.session.getLeafId(),
  read: () => host.readState(),
  get sequence() { return sequence; },
  painted: marker => paintedMarker !== null && marker === paintedMarker,
  setPainted(marker) { paintedMarker = marker; },
  install(ctx) { probe = installProbe(ctx, probeHost); return probe; },
  remove() { probe?.remove(); probe = undefined; },
};

before(async () => {
  for (const directory of [cwd, agentDir, tmp]) mkdirSync(directory, { recursive: true });
  beforeHashes = await hashManifest(senpiRoot, relativePaths);
  assert.deepEqual(compareToDeclared(beforeHashes, declared), [], 'native source identity mismatch');

  globalThis[PROBE_HOST_KEY] = probeHost;
  host = await createNativeHost({
    senpiRoot,
    cwd,
    agentDir,
    home,
    tmp,
    extensionPaths: [join(here, 'fixture-extension.mjs')],
    expectedVersion: manifest.sdkVersion,
  });
  surface = host.surface;
  owner = {
    token: 'harness-owner-token',
    ownerKey: 'harness-owner-key',
    session: host.session.getSessionId(),
    scope: 1,
  };
  await host.emitSessionStart();
});

after(() => {
  try { probe?.remove(); } catch { /* removal is best-effort during teardown */ }
  try { host?.close(); } catch { /* close restores the fixture environment */ }
  try { delete globalThis[PROBE_HOST_KEY]; } catch { /* the key is only set for this run */ }
  if (fixtureRoot && existsSync(fixtureRoot)) rmSync(fixtureRoot, { recursive: true, force: true });
});

test('resource-loader-loads-builtin-todo-first', () => {
  const paths = host.extensions.map(extension => extension.path);
  assert.ok(paths.length >= 2, `expected builtin plus probe extension, saw ${paths.length}`);
  assert.ok(paths[0].startsWith('<builtin:'), `first extension must be the stock builtin: ${paths[0]}`);
  assert.equal(host.nativeExtension.path, paths[0]);
  assert.equal(typeof host.tool?.execute, 'function', 'the registered native todo tool must be available');
  assert.equal(paths[1], join(here, 'fixture-extension.mjs'));
});

test('startup-install-prepares-branch-derived-recovery-without-capture', () => {
  assert.ok(probe, 'the probe must install for a parent TUI session');
  assert.equal(probe.gate.reason, 'eligible');
  assert.equal(probe.captured, undefined, 'no native factory exists before the first native publication');
  assert.equal(probe.captures.length, 0);
  assert.deepEqual(probe.recovery.phases, [], 'startup recovery derives from the current empty branch');
  assert.deepEqual(probe.failures, []);
  assert.equal(surface.nativeWidget(), undefined, 'an empty native branch publishes no widget at startup');
});

test('native-todo-tool-callback-commits-branch-state', async () => {
  const startLeaf = host.session.getLeafId();
  await host.toolAction({
    op: 'init',
    list: [{ phase: 'Foundation', items: ['Native alpha', 'Native beta'] }, { phase: 'Verification', items: ['Native gamma'] }],
  });
  const initLeaf = host.session.getLeafId();
  await host.toolAction({ op: 'start', task: 'Native gamma' });
  await host.toolAction({ op: 'done', task: 'Native alpha' });
  const state = host.readState();
  assert.notEqual(initLeaf, startLeaf, 'native init must commit a new branch entry');
  assert.equal(state.phases[0].tasks[0].status, 'completed');
  assert.equal(state.phases[1].tasks[0].status, 'in_progress');
  assert.equal(host.calls.at(-1).function, 'stock registered todo.definition.execute');
  assert.notEqual(host.calls.at(-1).before, host.calls.at(-1).entry, 'the committed entry must follow the pre-call leaf');
});

test('native-publication-after-commit-is-captured-at-the-exact-key', () => {
  assert.ok(probe.captures.length >= 3, `expected a capture per native publication, saw ${probe.captures.length}`);
  assert.equal(typeof probe.captured.content, 'function', 'the captured value must be the real native factory');
  assert.equal(probe.captured.options, undefined);
  assert.equal(probe.captures.at(-1).entry, host.session.getLeafId());
  assert.deepEqual(probe.recovery, host.readState());
  assert.equal(surface.nativeWidget().constructor.name, 'TodoWidgetComponent');
});

test('session-branch-history-is-visible-by-entry', () => {
  const branch = host.session.getBranch();
  assert.ok(branch.length > 0, 'session branch must hold committed entries');
  const historical = host.native.getLatestTodoStateFromBranchEntries(host.session.getBranch(branch[0].id));
  assert.equal(historical.phases[0].tasks[0].status, 'in_progress');
  assert.equal(host.readState().phases[0].tasks[0].status, 'completed');
});

test('child-session-guard-refuses-populated-child-before-any-read', () => {
  const originalSetter = runnerUI().setWidget;
  const widget = surface.nativeWidget();
  const calls = surface.nativeCalls.length;
  let reads = 0;
  const eligibleHost = {
    owner,
    sequence: probeHost.sequence,
    leaf: () => host.session.getLeafId(),
    read: () => { reads++; return host.readState(); },
    painted: () => true,
  };
  const childFiles = [
    'C:/fixture/senpi-task/children/eligible-child/session.jsonl',
    'C:\\fixture\\senpi-task\\children\\eligible-child\\session.jsonl',
  ];
  for (const sessionFile of childFiles) {
    const rejected = installProbe({
      hasUI: true,
      mode: 'tui',
      ui: runnerUI(),
      sessionManager: { getSessionFile: () => sessionFile },
    }, eligibleHost);
    assert.equal(rejected, undefined);
    assert.equal(runnerUI().setWidget, originalSetter, 'a child session must not wrap the shared setter');
    assert.equal(surface.nativeWidget(), widget);
    assert.equal(surface.nativeCalls.length, calls);
    assert.equal(reads, 0, 'a child session must not read the branch');
  }
  assert.ok(eligibleHost.read().phases.length > 0, 'the rejected child case must be otherwise eligible');
});

test('parent-tui-install-and-guard-variants', () => {
  const originalSetter = runnerUI().setWidget;
  const parent = installProbe({
    hasUI: true,
    mode: 'tui',
    ui: runnerUI(),
    sessionManager: { getSessionFile: () => parentSessionFile },
  }, probeHost);
  assert.ok(parent, 'a parent TUI session must be accepted');
  assert.notEqual(runnerUI().setWidget, originalSetter);
  parent.remove();
  assert.equal(runnerUI().setWidget, originalSetter, 'removal must restore the previous setter');
  assert.equal(installProbe({ hasUI: false, mode: 'tui' }, probeHost), undefined);
  assert.equal(installProbe({ hasUI: true, mode: 'print' }, probeHost), undefined);
  assert.equal(installProbe({ hasUI: true, mode: 'tui', sessionManager: host.session }, {}), undefined);
});

test('native-todo-command-callback-commits-and-captures-at-native-key', async () => {
  const before = host.session.getLeafId();
  await host.commandAction('append Foundation Native manual');
  const branch = host.session.getBranch();
  assert.equal(branch.at(-1).data.source, 'user');
  assert.notEqual(host.session.getLeafId(), before);
  assert.equal(probe.captures.at(-1).entry, host.session.getLeafId());
  assert.equal(typeof probe.captured.content, 'function');
  assert.equal(surface.nativeWidget().constructor.name, 'TodoWidgetComponent');
});

test('malformed-native-input-does-not-commit', async () => {
  const leaf = host.session.getLeafId();
  const state = host.snapshotState();
  await assert.rejects(host.toolAction({ op: 'start', task: 'does not exist' }));
  assert.equal(host.session.getLeafId(), leaf);
  assert.deepEqual(host.readState(), state);
  assert.equal(host.calls.at(-1).rejected, true);
});

test('readonly-view-tool-result-unchanged', async () => {
  const leaf = host.session.getLeafId();
  const output = await host.toolAction({ op: 'view' });
  assert.equal(host.session.getLeafId(), leaf);
  assert.ok(output.content[0].text.includes('Native alpha'));
  const rendered = host.tool
    .renderResult(output, { expanded: true }, host.runner.getUIContext().theme, { isError: false, args: { op: 'view' }, spinnerFrame: 0 })
    .render(100).join('\n');
  assert.ok(rendered.includes('Native alpha'));
});

test('ready-gate-rejects-foreign-owner-and-unpainted-marker', () => {
  const ack = { v: 1, ...owner, role: 'todo', sequence: probeHost.sequence, marker: 'harness-marker-1' };
  const variants = [
    { ...ack, token: 'foreign-token' },
    { ...ack, ownerKey: 'foreign-owner' },
    { ...ack, scope: owner.scope - 1 },
    { ...ack, sequence: probeHost.sequence - 1 },
    { ...ack, role: 'dag' },
    { ...ack, v: 2 },
  ];
  for (const variant of variants) {
    assert.equal(probe.acceptReady(variant), false, `must reject ${JSON.stringify(variant)}`);
  }
  const widget = surface.nativeWidget();
  assert.equal(probe.acceptReady(ack), false, 'an unpainted marker cannot grant readiness');
  assert.equal(surface.nativeWidget(), widget, 'the native surface must stay visible after a rejected ack');
  probeHost.setPainted('harness-marker-1');
  assert.equal(probe.acceptReady(ack), true, 'a matching post-paint ack masks through the original setter');
  assert.equal(probe.masked, true);
  assert.equal(surface.nativeWidget(), undefined);
});

test('restore-uses-captured-native-factory-through-original-setter', () => {
  probe.close(); // the previous case left the shared surface masked
  assert.equal(probe.masked, false);
  const factory = probe.captured.content;
  const options = probe.captured.options;
  const previous = surface.nativeWidget();
  const model = structuredClone(previous.model);
  const captures = probe.captures.length;
  const calls = surface.nativeCalls.length;
  assert.equal(previous.constructor.name, 'TodoWidgetComponent');
  assert.equal(probe.acceptReady({ v: 1, ...owner, role: 'todo', sequence: probeHost.sequence, marker: 'harness-marker-1' }), true);
  assert.equal(probe.masked, true);
  probe.close();
  assert.equal(probe.masked, false);
  assert.notEqual(surface.nativeWidget(), previous, 'restoration must build a fresh native component');
  assert.deepEqual(surface.nativeWidget().model, model);
  const last = surface.nativeCalls.at(-1);
  assert.equal(last.key, WIDGET_KEY);
  assert.equal(last.content, factory);
  assert.equal(last.options, options);
  assert.equal(probe.captures.length, captures, 'restoration must not be captured as a native factory');
  assert.ok(surface.nativeCalls.length > calls);
});

test('probe-removal-restores-setter-and-native-write-leaves-one-widget', async () => {
  const recordedCalls = surface.nativeCalls.length;
  probe.remove();
  assert.equal(runnerUI().setWidget, probe.original, 'removal must restore the setter that was in place before installation');
  await host.commandAction('append Removed probe write');
  assert.ok(surface.nativeCalls.length > recordedCalls, 'later native publications stay observed by the harness recorder');
  assert.equal(surface.surface.extensionWidgetsAbove.size, 1);
  assert.equal(surface.nativeWidget().constructor.name, 'TodoWidgetComponent');
});

test('unrelated-widget-is-delegated-unchanged', () => {
  const lines = ['unrelated widget content'];
  runnerUI().setWidget('host-probe-unrelated', lines, { placement: 'belowEditor' });
  const last = surface.nativeCalls.at(-1);
  assert.equal(last.key, 'host-probe-unrelated');
  assert.equal(last.content, lines);
  assert.deepEqual(last.options, { placement: 'belowEditor' });
  assert.ok(surface.surface.extensionWidgetsBelow.has('host-probe-unrelated'));
});

test('authoritative-empty-clears-native-widget', async () => {
  const observer = installProbe({
    hasUI: true,
    mode: 'tui',
    ui: runnerUI(),
    sessionManager: { getSessionFile: () => null },
  }, probeHost);
  assert.ok(observer, 'the observer probe must install for a parent TUI session');
  const observedSetter = observer.original;
  await host.commandAction('rm');
  assert.deepEqual(host.readState().phases, []);
  assert.equal(surface.nativeWidget(), undefined, 'the authoritative empty clears the native widget');
  assert.deepEqual(observer.recovery.phases, [], 'the observed native clear refreshes recovery to an explicit empty');
  assert.equal(observer.masked, false);
  assert.equal(surface.surface.extensionWidgetsAbove.size, 0);
  assert.equal(surface.surface.extensionWidgetsBelow.size, 1, 'the unrelated widget must be untouched');
  observer.remove();
  assert.equal(runnerUI().setWidget, observedSetter);
});

test('native-source-hashes-unchanged-and-runner-clean', async () => {
  const after = await hashManifest(senpiRoot, relativePaths);
  const identity = summarizeIdentity(beforeHashes, after);
  assert.deepEqual(identity.changed, []);
  assert.equal(identity.allUnchanged, true);
  assert.deepEqual(host.errors, []);
  assert.equal(existsSync(join(agentDir, 'extensions')), false, 'fixture agent dir must not discover user extensions');
});
