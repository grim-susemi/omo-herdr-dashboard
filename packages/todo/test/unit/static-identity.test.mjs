import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareIdentitySnapshots, newestGeneration, snapshotAgentIdentity } from '../../src/static-identity.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = join(root, '.tmp-e1', `unit-identity-${process.pid}`);
const agentDir = join(fixtureRoot, 'agent');

mkdirSync(join(agentDir, 'extensions', 'goal'), { recursive: true });
mkdirSync(join(agentDir, 'runtime', 'gen-000001', 'dist', 'bundle'), { recursive: true });
mkdirSync(join(agentDir, 'runtime', 'gen-000000'), { recursive: true });
mkdirSync(join(fixtureRoot, 'outside'), { recursive: true });
writeFileSync(join(agentDir, 'extensions', 'diff.js'), 'export default 1;\n');
writeFileSync(join(agentDir, 'extensions', 'goal', 'panel.mjs'), 'export default 2;\n');
writeFileSync(join(agentDir, 'runtime', 'gen-000001', 'package.json'), '{"name":"fixture-runtime"}\n');
writeFileSync(join(agentDir, 'runtime', 'gen-000001', 'dist', 'bundle', 'runtime-manifest.json'), '{}\n');
writeFileSync(join(agentDir, 'runtime', 'gen-000001', 'dist', 'bundle', 'index.js'), 'export {};\n');
writeFileSync(join(agentDir, 'runtime', 'gen-000001', 'dist', 'bundle', 'cli.js'), 'export {};\n');
writeFileSync(join(agentDir, 'runtime', 'gen-000000', 'package.json'), '{}\n');
writeFileSync(join(agentDir, 'settings.json'), '{"autoShow":false}\n');
writeFileSync(join(agentDir, 'native-profile-selection.json'), '{"profile":"x"}\n');
writeFileSync(join(agentDir, 'trust.json'), '{}\n');
writeFileSync(join(fixtureRoot, 'outside', 'sentinel.txt'), 'outside fixture sentinel\n');

after(() => {
  if (existsSync(fixtureRoot)) rmSync(fixtureRoot, { recursive: true, force: true });
});

test('snapshot classifies wrappers, generation anchors, config and mutable files', () => {
  const snapshot = snapshotAgentIdentity(agentDir);
  assert.equal(snapshot.generation, 'gen-000001');
  assert.equal(newestGeneration(agentDir), 'gen-000001');
  const kinds = Object.fromEntries(snapshot.entries.map(entry => [entry.relative, entry.kind]));
  assert.equal(kinds['extensions/diff.js'], 'static');
  assert.equal(kinds['extensions/goal/panel.mjs'], 'static');
  assert.equal(kinds['runtime/gen-000001/package.json'], 'static');
  assert.equal(kinds['runtime/gen-000001/dist/bundle/runtime-manifest.json'], 'static');
  assert.equal(kinds['runtime/gen-000001/dist/bundle/index.js'], 'static');
  assert.equal(kinds['runtime/gen-000001/dist/bundle/cli.js'], 'static');
  assert.equal(kinds['native-profile-selection.json'], 'static');
  assert.equal(kinds['trust.json'], 'static');
  assert.equal(kinds['settings.json'], 'mutable');
  assert.equal(kinds['runtime/gen-000000/package.json'], undefined, 'older generations must not be included');
});

test('snapshot hashes match an independent digest and change nothing', () => {
  const before = snapshotAgentIdentity(agentDir);
  const entry = before.entries.find(candidate => candidate.relative === 'extensions/diff.js');
  assert.equal(entry.sha256, createHash('sha256').update(readFileSync(join(agentDir, 'extensions', 'diff.js'))).digest('hex'));
  const after = snapshotAgentIdentity(agentDir);
  assert.deepEqual(
    after.entries.map(candidate => [candidate.relative, candidate.sha256, candidate.mtimeMs, candidate.size]),
    before.entries.map(candidate => [candidate.relative, candidate.sha256, candidate.mtimeMs, candidate.size]),
    'taking a snapshot must not touch any file',
  );
});

test('static changes fail while mutable changes are recorded and never reverted', () => {
  const before = snapshotAgentIdentity(agentDir);
  writeFileSync(join(agentDir, 'extensions', 'diff.js'), 'export default 111;\n');
  writeFileSync(join(agentDir, 'settings.json'), '{"autoShow":true}\n');
  const after = snapshotAgentIdentity(agentDir);
  const comparison = compareIdentitySnapshots(before, after);
  assert.equal(comparison.staticUnchanged, false);
  assert.deepEqual(comparison.staticChanged.map(change => change.relative), ['extensions/diff.js']);
  assert.deepEqual(comparison.mutableChanged.map(change => change.relative), ['settings.json']);
  assert.equal(comparison.mutableChanged[0].after, after.entries.find(entry => entry.relative === 'settings.json').sha256);
  assert.equal(readFileSync(join(agentDir, 'settings.json'), 'utf8'), '{"autoShow":true}\n', 'a live mutable change must stay as the engine left it');
  assert.equal(readFileSync(join(fixtureRoot, 'outside', 'sentinel.txt'), 'utf8'), 'outside fixture sentinel\n');
});

test('identical snapshots compare clean', () => {
  const snapshot = snapshotAgentIdentity(agentDir);
  const comparison = compareIdentitySnapshots(snapshot, snapshotAgentIdentity(agentDir));
  assert.equal(comparison.staticUnchanged, true);
  assert.deepEqual(comparison.staticChanged, []);
  assert.deepEqual(comparison.mutableChanged, []);
});
