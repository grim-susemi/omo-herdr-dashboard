// Static vs mutable identity of a live OmO agent directory.
//
// Read-only by construction: the snapshot opens files for reading only and the
// comparison never writes. Mutable files (settings.json) are recorded so a live
// engine change is visible in evidence, but they are never reverted or repaired
// by this module.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export const WRAPPER_DIRECTORY = 'extensions';
export const GENERATION_DIRECTORY = 'runtime';
export const GENERATION_ANCHORS = Object.freeze([
  'package.json',
  'dist/bundle/runtime-manifest.json',
  'dist/bundle/index.js',
  'dist/bundle/cli.js',
]);
export const STATIC_CONFIG_FILES = Object.freeze(['native-profile-selection.json', 'trust.json']);
export const MUTABLE_FILES = Object.freeze(['settings.json']);

const toPosix = path => path.split(sep).join('/');

function walk(directory) {
  const files = [];
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return files;
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

/** Newest installed generation directory name, or null. */
export function newestGeneration(agentDir) {
  const root = join(agentDir, GENERATION_DIRECTORY);
  if (!existsSync(root) || !statSync(root).isDirectory()) return null;
  const names = readdirSync(root).filter(name => statSync(join(root, name)).isDirectory()).sort();
  return names.length > 0 ? names[names.length - 1] : null;
}

/** Declared identity paths with their static/mutable classification. */
export function listIdentityPaths(agentDir) {
  const entries = [];
  for (const path of walk(join(agentDir, WRAPPER_DIRECTORY))) {
    entries.push({ relative: toPosix(relative(agentDir, path)), kind: 'static' });
  }
  const generation = newestGeneration(agentDir);
  if (generation) {
    for (const anchor of GENERATION_ANCHORS) {
      const path = join(agentDir, GENERATION_DIRECTORY, generation, anchor);
      if (existsSync(path)) entries.push({ relative: toPosix(relative(agentDir, path)), kind: 'static' });
    }
  }
  for (const name of STATIC_CONFIG_FILES) {
    if (existsSync(join(agentDir, name))) entries.push({ relative: name, kind: 'static' });
  }
  for (const name of MUTABLE_FILES) {
    if (existsSync(join(agentDir, name))) entries.push({ relative: name, kind: 'mutable' });
  }
  return entries.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
}

/** Read-only identity snapshot of the declared static and mutable paths. */
export function snapshotAgentIdentity(agentDir) {
  const absolute = resolve(agentDir);
  const entries = listIdentityPaths(absolute).map(({ relative: rel, kind }) => {
    const path = join(absolute, rel);
    const buffer = readFileSync(path);
    const stats = statSync(path);
    return {
      relative: rel,
      kind,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      size: stats.size,
      mtimeMs: Math.round(stats.mtimeMs),
    };
  });
  return { agentDir: absolute, capturedAtUtc: new Date().toISOString(), generation: newestGeneration(absolute), entries };
}

/** Compare two snapshots; static changes fail a gate, mutable ones are recorded. */
export function compareIdentitySnapshots(before, after) {
  const afterByRelative = new Map(after.entries.map(entry => [entry.relative, entry]));
  const staticChanged = [];
  const mutableChanged = [];
  for (const entry of before.entries) {
    const now = afterByRelative.get(entry.relative);
    if (now && now.sha256 === entry.sha256) continue;
    const record = { relative: entry.relative, kind: entry.kind, before: entry.sha256, after: now?.sha256 ?? null };
    if (entry.kind === 'mutable') mutableChanged.push(record);
    else staticChanged.push(record);
  }
  return { staticChanged, mutableChanged, staticUnchanged: staticChanged.length === 0 };
}
