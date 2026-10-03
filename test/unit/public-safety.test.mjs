import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listFilesRecursive, scanSpecifiers, scanText, scanTree } from '../../src/public-safety.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('scanText flags each private-value class', () => {
  const cases = [
    ['machine-absolute-path', 'const agent = "C:\\Users\\owner\\.omo\\agent";'],
    ['machine-absolute-path', 'open("/home/owner/.omo/agent/settings.json")'],
    ['private-install-root', 'root = "/home/owner/.omo-stable-500/home/.omo/agent"'],
    ['private-install-root', 'pkg = "/home/owner/.bun/install/global/node_modules"'],
    ['private-install-root', 'dir = "projects/orca/projects/omo-herdr-todo"'],
    ['private-evidence-path', 'read(".omo/evidence/omo-herdr-todo/e1/task-1")'],
    ['private-evidence-path', 'wt = "omo-herdr-todo-wave1-e1"'],
    ['private-evidence-path', 'run = ".omo/ulw-execute/omo-herdr-todo-e1"'],
    ['session-or-task-identifier', 'session = "senpi:00000000-0000-4000-8000-000000000000"'],
    ['session-or-task-identifier', 'task = "st_00000000"'],
  ];
  for (const [rule, text] of cases) {
    const violations = scanText(text);
    assert.ok(violations.some(violation => violation.rule === rule), `${rule} must be detected in: ${text}`);
  }
});

test('scanText reports line numbers and leaves clean text alone', () => {
  const violations = scanText('first line\nconst p = "C:\\Users\\someone";\nthird line');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 2);
  assert.deepEqual(scanText('npm run test:host -- --senpi-root <path-to-sdk>'), []);
  assert.deepEqual(scanText('import { test } from \'node:test\';'), []);
});

test('undeclared bare specifiers are rejected', () => {
  assert.equal(scanSpecifiers("import lodash from 'lodash';").length, 1);
  assert.equal(scanSpecifiers("const mod = await import('some-private-host-module');").length, 1);
  assert.deepEqual(scanSpecifiers("import { test } from 'node:test';\nimport local from './local.mjs';\nimport parent from '../x/y.mjs';"), []);
});

test('the shipped tree is public-safe and free of bare specifiers', () => {
  const scanned = [
    ...listFilesRecursive(join(root, 'src')),
    ...listFilesRecursive(join(root, 'scripts')),
    ...listFilesRecursive(join(root, 'config')),
    join(root, 'package.json'),
    join(root, 'README.md'),
    join(root, 'THIRD-PARTY-NOTICES.md'),
    join(root, 'LICENSE'),
  ];
  assert.ok(scanned.length > 10, 'the scan must cover the shipped tree');
  assert.deepEqual(scanTree(root, scanned), []);
});

test('the rule module itself contains no contiguous private literal', () => {
  const text = readFileSync(join(root, 'src/public-safety.mjs'), 'utf8');
  assert.deepEqual(scanText(text), [], 'rule fragments must not spell out a forbidden value');
});
