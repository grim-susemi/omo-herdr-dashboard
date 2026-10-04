import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OWNER_MARKER_VALUE, createFoundationWorktree, createIntegrationRoot, headOf, listWorktrees,
  readOwnerMarker, verifyWorkspace,
} from '../../src/workspace.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = join(root, '.tmp-e1', `unit-workspace-${process.pid}`);
const outsideSentinel = join(fixtureRoot, 'outside-sentinel.txt');
const identity = { name: 'fixture-owner', email: 'fixture@example.invalid' };

mkdirSync(fixtureRoot, { recursive: true });
writeFileSync(outsideSentinel, 'outside fixture sentinel\n');

after(() => {
  if (existsSync(fixtureRoot)) rmSync(fixtureRoot, { recursive: true, force: true });
});

function expectCode(code, run) {
  try {
    run();
  } catch (error) {
    assert.equal(error.name, 'WorkspaceError', `expected a WorkspaceError, saw ${error.name}: ${error.message}`);
    assert.equal(error.code, code, `expected ${code}, saw ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected WorkspaceError with code ${code}`);
}

test('a pre-existing unrelated directory is refused intact', () => {
  const directory = join(fixtureRoot, 'unrelated-dir');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'unrelated.txt'), 'keep me\n');
  const error = expectCode('UNMANAGED_DESTINATION', () => createIntegrationRoot({ root: directory, identity }));
  assert.equal(error.detail.path, resolve(directory));
  assert.deepEqual(error.detail.entries, ['unrelated.txt']);
  assert.equal(readFileSync(join(directory, 'unrelated.txt'), 'utf8'), 'keep me\n');
  assert.equal(existsSync(join(directory, '.git')), false);
});

test('a pre-existing unmanaged Git repository is refused intact', () => {
  const directory = join(fixtureRoot, 'unmanaged-repo');
  mkdirSync(directory, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main', directory], { stdio: 'pipe' });
  writeFileSync(join(directory, 'README.md'), 'unmanaged\n');
  const error = expectCode('UNMANAGED_REPO', () => createIntegrationRoot({ root: directory, identity }));
  assert.equal(error.detail.ownerMarker, null);
  assert.equal(readOwnerMarker(directory), null);
  assert.equal(readFileSync(join(directory, 'README.md'), 'utf8'), 'unmanaged\n');
});

test('an owned integration root and its orphan linked worktree are created without a commit', () => {
  const integrationRoot = join(fixtureRoot, 'integration');
  const created = createIntegrationRoot({ root: integrationRoot, identity });
  assert.equal(created.created, true);
  assert.equal(created.adopted, false);
  assert.equal(readOwnerMarker(integrationRoot), OWNER_MARKER_VALUE);
  assert.equal(headOf(integrationRoot), null, 'the integration branch must stay unborn');

  const worktreePath = join(fixtureRoot, 'phase-worktree');
  const worktree = createFoundationWorktree({ integrationRoot, worktreePath, branch: 'feat/unit-fixture' });
  assert.equal(worktree.created, true);
  assert.equal(worktree.branch, 'refs/heads/feat/unit-fixture');
  assert.equal(worktree.unborn, true, 'the orphan worktree must have no commit');
  assert.equal(headOf(worktreePath), null);

  const again = createFoundationWorktree({ integrationRoot, worktreePath, branch: 'feat/unit-fixture' });
  assert.equal(again.created, false);
  assert.equal(again.existing, true);

  const status = verifyWorkspace({ integrationRoot, worktreePath, branch: 'feat/unit-fixture' });
  assert.equal(status.integrationRoot.ownerMarker, OWNER_MARKER_VALUE);
  assert.equal(status.integrationRoot.isGitRepository, true);
  assert.equal(status.integrationRoot.entries.includes('.git'), true);
  assert.equal(status.worktree.registered, true);
  assert.equal(status.worktree.branch, 'refs/heads/feat/unit-fixture');
  assert.equal(status.worktree.expectedBranch, 'refs/heads/feat/unit-fixture');
  assert.equal(status.worktree.unborn, true);
});

test('a pre-existing non-empty worktree destination is refused intact', () => {
  const integrationRoot = join(fixtureRoot, 'integration-occupied');
  createIntegrationRoot({ root: integrationRoot, identity });
  const worktreePath = join(fixtureRoot, 'occupied-worktree');
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(join(worktreePath, 'other-project.txt'), 'unrelated content\n');
  const registered = listWorktrees(integrationRoot).length;
  const error = expectCode('UNMANAGED_DESTINATION', () => createFoundationWorktree({ integrationRoot, worktreePath, branch: 'feat/occupied' }));
  assert.deepEqual(error.detail.entries, ['other-project.txt']);
  assert.equal(readFileSync(join(worktreePath, 'other-project.txt'), 'utf8'), 'unrelated content\n');
  assert.equal(listWorktrees(integrationRoot).length, registered, 'a refused destination must not register a worktree');
});

test('a registered worktree on another branch is refused', () => {
  const integrationRoot = join(fixtureRoot, 'integration-branch');
  createIntegrationRoot({ root: integrationRoot, identity });
  const worktreePath = join(fixtureRoot, 'other-branch-worktree');
  createFoundationWorktree({ integrationRoot, worktreePath, branch: 'feat/other' });
  const error = expectCode('WORKTREE_BRANCH_MISMATCH', () => createFoundationWorktree({ integrationRoot, worktreePath, branch: 'feat/different' }));
  assert.equal(error.detail.branch, 'refs/heads/feat/other');
});

test('a worktree cannot be created from a repository without the ownership marker', () => {
  const directory = join(fixtureRoot, 'plain-repo');
  mkdirSync(directory, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main', directory], { stdio: 'pipe' });
  const target = join(fixtureRoot, 'never-created');
  expectCode('NOT_OWNED_INTEGRATION_ROOT', () => createFoundationWorktree({ integrationRoot: directory, worktreePath: target, branch: 'feat/x' }));
  assert.equal(existsSync(target), false);
});

test('the workspace verification command reports the owned roots', () => {
  const integrationRoot = join(fixtureRoot, 'integration-cli');
  const worktreePath = join(fixtureRoot, 'cli-worktree');
  createIntegrationRoot({ root: integrationRoot, identity });
  createFoundationWorktree({ integrationRoot, worktreePath, branch: 'feat/cli-fixture' });
  const ok = spawnSync(process.execPath, [
    join(root, 'scripts/workspace.mjs'),
    '--integration-root', integrationRoot,
    '--worktree', worktreePath,
    '--branch', 'feat/cli-fixture',
  ], { cwd: root, encoding: 'utf8', timeout: 60000 });
  assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
  const report = JSON.parse(ok.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks, {
    ownedIntegrationRoot: true,
    integrationRootIsRepository: true,
    worktreeRegistered: true,
    worktreeBranchMatches: true,
  });
  assert.equal(report.worktree.unborn, true);

  const refused = spawnSync(process.execPath, [
    join(root, 'scripts/workspace.mjs'),
    '--integration-root', join(fixtureRoot, 'unrelated-dir'),
    '--worktree', join(fixtureRoot, 'cli-worktree'),
    '--branch', 'feat/cli-fixture',
  ], { cwd: root, encoding: 'utf8', timeout: 60000 });
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout).checks.ownedIntegrationRoot, false);

  const missingArgument = spawnSync(process.execPath, [join(root, 'scripts/workspace.mjs')], { cwd: root, encoding: 'utf8', timeout: 60000 });
  assert.equal(missingArgument.status, 2);
});

test('every refusal left outside paths intact', () => {
  assert.equal(readFileSync(outsideSentinel, 'utf8'), 'outside fixture sentinel\n');
  assert.equal(readFileSync(join(fixtureRoot, 'unrelated-dir', 'unrelated.txt'), 'utf8'), 'keep me\n');
  assert.equal(readFileSync(join(fixtureRoot, 'occupied-worktree', 'other-project.txt'), 'utf8'), 'unrelated content\n');
  assert.equal(existsSync(join(fixtureRoot, 'unrelated-dir', '.git')), false);
});
