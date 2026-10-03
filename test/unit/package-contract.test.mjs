import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('package is a Node >= 24 ESM MIT library at version 0.1.0', () => {
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.engines?.node, '>=24');
  assert.equal(existsSync(join(root, 'LICENSE')), true);
});

test('package declares no production dependency and no bundled path', () => {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies']) {
    assert.equal(manifest[field], undefined, `${field} must stay absent`);
  }
});

test('every command contract points at a real, executable file', () => {
  assert.equal(manifest.scripts.test, 'node --test --test-isolation=none test/unit/*.test.mjs test/native-todo.test.mjs');
  assert.equal(manifest.scripts['test:host'], 'node scripts/test-host.mjs');
  assert.equal(manifest.scripts.build, 'node scripts/build.mjs');
  for (const command of Object.values(manifest.scripts)) {
    const match = /node\s+(\S+\.mjs)/.exec(command);
    if (match) assert.equal(existsSync(join(root, match[1])), true, match[1]);
  }
  assert.equal(existsSync(join(root, manifest.exports['.'])), true);
  for (const entry of manifest.files) assert.equal(existsSync(join(root, entry)), true, entry);
});

test('the public index re-exports the foundation surface', async () => {
  const index = await import('../../src/index.mjs');
  for (const name of [
    'resolveSenpiRoot', 'assertSenpiVersion', 'loadNativeModules', 'createNativeHost', 'applyHostEnvironment',
    'hostContextEligible', 'isChildSession', 'scanText', 'scanSpecifiers', 'scanTree', 'hashManifest',
    'snapshotAgentIdentity', 'compareIdentitySnapshots', 'createIntegrationRoot', 'createFoundationWorktree', 'verifyWorkspace',
  ]) {
    assert.equal(typeof index[name], 'function', `src/index.mjs must export ${name}`);
  }
});
