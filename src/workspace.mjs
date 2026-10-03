// Isolated source-workspace guards.
//
// Every function here is read-only or additive: a pre-existing destination that
// is not a task-owned Git root (or that already holds unrelated content) is
// refused intact, and nothing is ever removed, reset, checked out or amended.
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export const OWNER_MARKER = 'herdrtodo.workspace';
export const OWNER_MARKER_VALUE = 'owned-by-omo-herdr-todo';

export class WorkspaceError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    this.detail = detail;
  }
}

function git(args, cwd) {
  try {
    const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stdout: stdout.trim(), stderr: '', status: 0 };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout ?? '').trim(),
      stderr: String(error.stderr ?? error.message ?? '').trim(),
      status: typeof error.status === 'number' ? error.status : null,
    };
  }
}

export function isGitRepository(path) {
  if (!existsSync(path) || !statSync(path).isDirectory()) return false;
  // A plain subdirectory of another working tree also resolves a git dir, so the
  // directory must own a .git entry and be the repository top level itself.
  if (!existsSync(join(path, '.git'))) return false;
  const probe = git(['rev-parse', '--show-toplevel'], path);
  return probe.ok && samePath(probe.stdout, path);
}

export function readOwnerMarker(path) {
  // Only the directory's own repository config counts: a plain subdirectory of
  // another working tree must not inherit that repository's ownership marker.
  if (!existsSync(join(path, '.git'))) return null;
  const probe = git(['config', '--local', '--get', OWNER_MARKER], path);
  return probe.ok && probe.stdout !== '' ? probe.stdout : null;
}

export function topLevelEntries(path) {
  return existsSync(path) && statSync(path).isDirectory() ? readdirSync(path).sort() : [];
}

export function headOf(path) {
  const probe = git(['rev-parse', '--verify', 'HEAD'], path);
  return probe.ok ? probe.stdout : null;
}

export function symbolicHead(path) {
  const probe = git(['symbolic-ref', 'HEAD'], path);
  return probe.ok ? probe.stdout : null;
}

export function listWorktrees(integrationRoot) {
  const probe = git(['worktree', 'list', '--porcelain'], integrationRoot);
  if (!probe.ok) return [];
  const worktrees = [];
  let current = null;
  for (const line of probe.stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = { path: line.slice('worktree '.length), branch: null, head: null, unborn: false, detached: false };
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (current && line === 'detached') {
      current.detached = true;
    }
  }
  if (current) worktrees.push(current);
  // Porcelain prints the all-zero object name for a worktree whose branch has no
  // commit yet, so an unborn worktree is either head-less or all-zero.
  for (const worktree of worktrees) worktree.unborn = worktree.head === null || /^0+$/.test(worktree.head);
  return worktrees;
}

const samePath = (a, b) => resolve(a).replace(/[\\/]+$/, '').toLowerCase() === resolve(b).replace(/[\\/]+$/, '').toLowerCase();

export function inspectIntegrationRoot(root) {
  const absolute = resolve(root);
  return {
    path: absolute,
    exists: existsSync(absolute),
    isDirectory: existsSync(absolute) && statSync(absolute).isDirectory(),
    isGitRepository: isGitRepository(absolute),
    ownerMarker: existsSync(absolute) ? readOwnerMarker(absolute) : null,
    head: existsSync(absolute) ? headOf(absolute) : null,
    symbolicHead: existsSync(absolute) ? symbolicHead(absolute) : null,
    entries: topLevelEntries(absolute),
    worktrees: existsSync(absolute) ? listWorktrees(absolute) : [],
  };
}

/**
 * Create the integration Git root, or adopt it when it carries the ownership
 * marker. A pre-existing non-repository directory, or a repository without the
 * marker, is refused intact.
 */
export function createIntegrationRoot({ root, initialBranch = 'main', identity = {} }) {
  const absolute = resolve(root);
  if (existsSync(absolute)) {
    if (!statSync(absolute).isDirectory()) {
      throw new WorkspaceError('UNMANAGED_DESTINATION', `refusing to initialize over a pre-existing non-directory: ${absolute}`, { path: absolute });
    }
    if (!isGitRepository(absolute)) {
      throw new WorkspaceError('UNMANAGED_DESTINATION',
        `refusing to initialize over a pre-existing non-owned directory: ${absolute}`,
        { path: absolute, entries: topLevelEntries(absolute) });
    }
    if (readOwnerMarker(absolute) !== OWNER_MARKER_VALUE) {
      throw new WorkspaceError('UNMANAGED_REPO',
        `refusing to adopt a pre-existing Git repository without the ownership marker (${OWNER_MARKER}): ${absolute}`,
        { path: absolute, entries: topLevelEntries(absolute), ownerMarker: readOwnerMarker(absolute) });
    }
    return { created: false, adopted: true, root: absolute, head: headOf(absolute) };
  }
  const init = git(['init', '--initial-branch=' + initialBranch, absolute], process.cwd());
  if (!init.ok) {
    throw new WorkspaceError('GIT_COMMAND_FAILED', `git init failed: ${init.stderr || init.stdout}`, { root: absolute, stderr: init.stderr });
  }
  for (const [key, value] of [['user.name', identity.name], ['user.email', identity.email]]) {
    if (value) git(['config', key, value], absolute);
  }
  git(['config', OWNER_MARKER, OWNER_MARKER_VALUE], absolute);
  return { created: true, adopted: false, root: absolute, head: headOf(absolute), initialBranch };
}

/**
 * Create the linked Foundation worktree on a new unborn (orphan) branch, or
 * return the already-registered one. A pre-existing non-empty directory, or a
 * directory registered to another branch, is refused intact.
 */
export function createFoundationWorktree({ integrationRoot, worktreePath, branch }) {
  const root = resolve(integrationRoot);
  if (!existsSync(root) || readOwnerMarker(root) !== OWNER_MARKER_VALUE) {
    throw new WorkspaceError('NOT_OWNED_INTEGRATION_ROOT',
      `integration root is missing or does not carry the ownership marker (${OWNER_MARKER}): ${root}`, { integrationRoot: root });
  }
  const path = resolve(worktreePath);
  const registered = listWorktrees(root).find(worktree => samePath(worktree.path, path)) ?? null;
  if (existsSync(path)) {
    const entries = topLevelEntries(path);
    if (registered) {
      if (registered.branch !== `refs/heads/${branch}`) {
        throw new WorkspaceError('WORKTREE_BRANCH_MISMATCH',
          `registered worktree ${path} is on ${String(registered.branch)}, not refs/heads/${branch}`,
          { worktreePath: path, branch: registered.branch });
      }
      return { created: false, existing: true, path, branch: registered.branch, unborn: registered.unborn };
    }
    if (entries.length > 0) {
      throw new WorkspaceError('UNMANAGED_DESTINATION',
        `refusing to create a worktree over a pre-existing non-empty directory: ${path}`,
        { worktreePath: path, entries });
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const add = git(['-C', root, 'worktree', 'add', '--orphan', '-b', branch, path], process.cwd());
  if (!add.ok) {
    throw new WorkspaceError('GIT_COMMAND_FAILED',
      `git worktree add --orphan failed: ${add.stderr || add.stdout}`,
      { integrationRoot: root, worktreePath: path, branch, stderr: add.stderr, stdout: add.stdout, status: add.status });
  }
  return { created: true, existing: false, path, branch: `refs/heads/${branch}`, unborn: headOf(path) === null };
}

/** Read-only workspace status used for evidence. */
export function verifyWorkspace({ integrationRoot, worktreePath, branch }) {
  const root = resolve(integrationRoot);
  const path = resolve(worktreePath);
  const registered = existsSync(root)
    ? listWorktrees(root).find(worktree => samePath(worktree.path, path)) ?? null
    : null;
  return {
    integrationRoot: inspectIntegrationRoot(root),
    worktree: {
      path,
      exists: existsSync(path),
      branch: existsSync(path) ? symbolicHead(path) : null,
      expectedBranch: `refs/heads/${branch}`,
      unborn: existsSync(path) ? headOf(path) === null : null,
      registered: registered !== null,
      registeredBranch: registered?.branch ?? null,
      entries: topLevelEntries(path),
    },
  };
}
