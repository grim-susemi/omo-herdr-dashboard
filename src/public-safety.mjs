// Public-safety scan for the shipped tree.
//
// The forbiddden literals are assembled from fragments so this rule module does
// not contain (and therefore does not flag) a contiguous private value itself.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const fragment = (...parts) => parts.join('');
const ATOMS = {
  drivePath: fragment('(?:^|[^A-Za-z0-9])', '[A-Za-z]', ':', '[', '\\\\', '/]'),
  usersHome: fragment('/', 'Us', 'ers', '/'),
  linuxHome: fragment('/', 'ho', 'me', '/'),
  stableRoot: fragment('\\.omo', '-stable-'),
  bunGlobal: fragment('\\.bun', '/install/global'),
  orcaProjects: fragment('orca', '/projects'),
  evidenceDir: fragment('\\.omo', '/evidence'),
  waveWorktree: fragment('-wave1', '-e1'),
  ulwExecute: fragment('ulw', '-execute'),
  senpiSession: fragment('senpi', ':[0-9a-f]{8,}'),
  taskId: fragment('st_', '[0-9a-f]{8,}'),
};

export const PUBLIC_SAFETY_RULES = Object.freeze([
  {
    id: 'machine-absolute-path',
    description: 'Machine-local absolute path (drive letter, Unix user or home prefix)',
    pattern: new RegExp([ATOMS.drivePath, ATOMS.usersHome, ATOMS.linuxHome].join('|'), 'g'),
  },
  {
    id: 'private-install-root',
    description: 'Private live-install or project scratch root',
    pattern: new RegExp([ATOMS.stableRoot, ATOMS.bunGlobal, ATOMS.orcaProjects].join('|'), 'gi'),
  },
  {
    id: 'private-evidence-path',
    description: 'Private evidence/orchestration path',
    pattern: new RegExp([ATOMS.evidenceDir, ATOMS.waveWorktree, ATOMS.ulwExecute].join('|'), 'gi'),
  },
  {
    id: 'session-or-task-identifier',
    description: 'Session or task identifier',
    pattern: new RegExp([ATOMS.senpiSession, ATOMS.taskId].join('|'), 'gi'),
  },
]);

/** Scan one text for every rule; returns violations with 1-based line numbers. */
export function scanText(text, rules = PUBLIC_SAFETY_RULES) {
  const lines = String(text).split(/\r?\n/);
  const violations = [];
  for (const rule of rules) {
    for (let index = 0; index < lines.length; index++) {
      rule.pattern.lastIndex = 0;
      let match;
      while ((match = rule.pattern.exec(lines[index])) !== null) {
        violations.push({ rule: rule.id, line: index + 1, match: match[0] });
        if (match.index === rule.pattern.lastIndex) rule.pattern.lastIndex++;
      }
    }
  }
  return violations;
}

/**
 * Import specifiers must be node builtins or relative. Anything else is an
 * undeclared dependency (and potentially a private host module path).
 */
export function scanSpecifiers(text) {
  const violations = [];
  const specifierPattern = /(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;
  const lines = String(text).split(/\r?\n/);
  let match;
  while ((match = specifierPattern.exec(text)) !== null) {
    const specifier = match[1];
    if (specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('#')) continue;
    const line = text.slice(0, match.index).split(/\r?\n/).length;
    violations.push({ rule: 'undeclared-specifier', line, specifier, text: lines[line - 1] ?? '' });
  }
  return violations;
}

/** Recursively list files under one directory (absolute paths, sorted). */
export function listFilesRecursive(directory) {
  const files = [];
  const walk = current => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  if (statSync(directory).isDirectory()) walk(directory);
  return files;
}

/**
 * Scan an explicit list of paths (no globbing, no implicit tree sweep).
 * `root` only anchors the reported relative names.
 */
export function scanTree(root, paths) {
  const violations = [];
  for (const path of paths) {
    const text = readFileSync(path, 'utf8');
    const name = relative(root, path).split(sep).join('/');
    for (const violation of scanText(text)) violations.push({ file: name, ...violation });
    if (path.endsWith('.mjs')) {
      for (const violation of scanSpecifiers(text)) violations.push({ file: name, ...violation });
    }
  }
  return violations;
}
