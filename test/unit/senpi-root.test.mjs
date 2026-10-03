import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REQUIRED_MODULES, assertSenpiVersion, resolveSenpiRoot } from '../../src/senpi-root.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = join(root, '.tmp-e1', `unit-senpi-${process.pid}`);
const casesRoot = join(fixtureRoot, 'cases');
const sentinel = join(fixtureRoot, 'outside-sentinel.txt');

before(() => {
  mkdirSync(casesRoot, { recursive: true });
  writeFileSync(sentinel, 'outside fixture sentinel\n');
});

after(() => {
  if (existsSync(fixtureRoot)) rmSync(fixtureRoot, { recursive: true, force: true });
});

function expectCode(code, run) {
  try {
    run();
  } catch (error) {
    assert.equal(error.name, 'SenpiRootError', `expected a SenpiRootError, saw ${error.name}: ${error.message}`);
    assert.equal(error.code, code, `expected ${code}, saw ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected SenpiRootError with code ${code}`);
}

function makeFakeSdk(name, version, { modules = true } = {}) {
  const dir = join(casesRoot, `${name.replace(/[^a-z0-9]+/gi, '-')}-${version}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }));
  if (modules) {
    for (const relative of Object.values(REQUIRED_MODULES)) {
      const path = join(dir, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'export const fixture = true;\n');
    }
  }
  return dir;
}

test('a missing --senpi-root argument fails clearly instead of falling back', () => {
  expectCode('MISSING_ARGUMENT', () => resolveSenpiRoot(undefined));
  expectCode('MISSING_ARGUMENT', () => resolveSenpiRoot(''));
  expectCode('MISSING_ARGUMENT', () => resolveSenpiRoot('   '));
});

test('a nonexistent or non-SDK root fails with the exact reason and path', () => {
  const missing = join(casesRoot, 'does-not-exist');
  const missingError = expectCode('MISSING_ROOT', () => resolveSenpiRoot(missing));
  assert.equal(missingError.detail.root, resolve(missing));
  assert.ok(missingError.message.includes(resolve(missing)), 'the error must name the requested root, never a fallback');

  const empty = join(casesRoot, 'empty-dir');
  mkdirSync(empty, { recursive: true });
  expectCode('MISSING_MANIFEST', () => resolveSenpiRoot(empty));

  const badJson = join(casesRoot, 'bad-json');
  mkdirSync(badJson, { recursive: true });
  writeFileSync(join(badJson, 'package.json'), '{ not json');
  expectCode('INVALID_MANIFEST', () => resolveSenpiRoot(badJson));

  const other = makeFakeSdk('some-other-package', '1.0.0', { modules: false });
  const notSdk = expectCode('NOT_SDK', () => resolveSenpiRoot(other));
  assert.equal(notSdk.detail.name, 'some-other-package');
});

test('an SDK root without its native modules fails instead of half-loading', () => {
  const incomplete = makeFakeSdk('@code-yeongyu/senpi', '0.0.1', { modules: false });
  const error = expectCode('MISSING_MODULE', () => resolveSenpiRoot(incomplete));
  assert.equal(error.detail.missing.length, Object.values(REQUIRED_MODULES).length);
});

test('a complete SDK root resolves with its version and a version gate exists', () => {
  const fake = makeFakeSdk('@code-yeongyu/senpi', '9.9.9-fixture');
  const info = resolveSenpiRoot(fake);
  assert.equal(info.version, '9.9.9-fixture');
  assert.equal(info.root, resolve(fake));
  assert.equal(assertSenpiVersion(info, '9.9.9-fixture'), info);
  const error = expectCode('VERSION_MISMATCH', () => assertSenpiVersion(info, '1.2.3'));
  assert.equal(error.detail.actual, '9.9.9-fixture');
});

test('test:host refuses a missing or invalid root with a clear exit code', () => {
  const withoutArgument = spawnSync(process.execPath, [join(root, 'scripts/test-host.mjs')], { cwd: root, encoding: 'utf8', timeout: 60000 });
  assert.equal(withoutArgument.status, 1);
  assert.ok(`${withoutArgument.stdout}${withoutArgument.stderr}`.includes('A --senpi-root path is required'));

  const badRoot = spawnSync(process.execPath, [join(root, 'scripts/test-host.mjs'), '--senpi-root', join(casesRoot, 'does-not-exist')], { cwd: root, encoding: 'utf8', timeout: 60000 });
  assert.equal(badRoot.status, 1);
  assert.ok(`${badRoot.stdout}${badRoot.stderr}`.includes('MISSING_ROOT'));
});

test('the host suite fails rather than skipping when the SDK root is absent', () => {
  const environment = { ...process.env };
  delete environment.OMO_HERDR_SENPI_ROOT;
  delete environment.OMO_HERDR_FIXTURE_ROOT;
  const run = spawnSync(process.execPath, ['--test', '--test-isolation=none', join(root, 'test/host/native-host.test.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 120000, env: environment,
  });
  assert.notEqual(run.status, 0, 'a missing SDK root must fail the host suite');
  assert.ok(`${run.stdout}${run.stderr}`.includes('OMO_HERDR_SENPI_ROOT'), 'the failure must name the missing SDK root');
});

test('fixture refusals leave the outside sentinel intact', () => {
  assert.equal(readFileSync(sentinel, 'utf8'), 'outside fixture sentinel\n');
});
