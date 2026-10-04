import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyHostEnvironment, assertFixtureRoots } from '../../src/native-host.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = join(root, '.tmp-e1', `unit-env-${process.pid}`);

test('the fixture environment is isolated and then restored exactly', () => {
  const keys = ['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'OMO_CODING_AGENT_DIR', 'SENPI_CODING_AGENT_DIR', 'PI_CODING_AGENT_DIR'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const savedPane = process.env.HERDR_PANE_ID;
  const injectedPane = 'fixture-pane-id';
  process.env.HERDR_PANE_ID = injectedPane;

  const home = join(fixtureRoot, 'home');
  const tmp = join(fixtureRoot, 'tmp');
  const agentDir = join(fixtureRoot, 'agent');
  let environment;
  try {
    environment = applyHostEnvironment({ home, tmp, agentDir });

    assert.equal(process.env.HOME, home);
    assert.equal(process.env.USERPROFILE, home);
    assert.equal(process.env.TEMP, tmp);
    assert.equal(process.env.TMP, tmp);
    assert.equal(process.env.OMO_CODING_AGENT_DIR, agentDir);
    assert.equal(process.env.SENPI_CODING_AGENT_DIR, agentDir);
    assert.equal(process.env.HERDR_PANE_ID, undefined, 'the owner pane environment must not leak into the fixture host');
    assert.equal(environment.stripped.HERDR_PANE_ID, injectedPane);

    environment.restore();
    for (const key of keys) assert.equal(process.env[key], saved[key], key);
    assert.equal(process.env.HERDR_PANE_ID, injectedPane, 'restore must put back the value present before isolation');
  } finally {
    environment?.restore();
    if (savedPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = savedPane;
  }
});

test('fixture roots are required and must not discover user extensions', () => {
  assert.throws(() => assertFixtureRoots({ cwd: join(fixtureRoot, 'missing'), agentDir: join(fixtureRoot, 'missing') }), /fixture cwd must be an existing directory/);
  const cwd = join(fixtureRoot, 'cwd');
  const agentDir = join(fixtureRoot, 'agent');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  assert.doesNotThrow(() => assertFixtureRoots({ cwd, agentDir }));
  mkdirSync(join(agentDir, 'extensions'), { recursive: true });
  assert.throws(() => assertFixtureRoots({ cwd, agentDir }), /must not discover user extensions/);
  rmSync(fixtureRoot, { recursive: true, force: true });
  assert.equal(existsSync(fixtureRoot), false);
});
