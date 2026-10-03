// Read-only sha256 identity helpers for the native SDK sources and, when asked,
// for any other declared file set. No writer, no cache, no mutation.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export async function hashFile(path) {
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

/** Hash `relativePaths` under `root` preserving order. */
export async function hashManifest(root, relativePaths) {
  const entries = [];
  for (const relative of relativePaths) {
    entries.push({ relative, path: join(root, relative), sha256: await hashFile(join(root, relative)) });
  }
  return entries;
}

/**
 * Compare entries against a declared `{ relative: sha256 }` map.
 * Unknown entries are ignored; missing and mismatching entries are reported.
 */
export function compareToDeclared(entries, declared) {
  const mismatches = [];
  for (const entry of entries) {
    const expected = declared[entry.relative];
    if (!expected) continue;
    if (entry.sha256 === null) {
      mismatches.push({ ...entry, expected, reason: 'missing' });
    } else if (entry.sha256 !== expected) {
      mismatches.push({ ...entry, expected, reason: 'sha256-mismatch' });
    }
  }
  return mismatches;
}

/** Before/after identity summary for one file set. */
export function summarizeIdentity(before, after) {
  const byRelative = new Map(after.map(entry => [entry.relative, entry.sha256]));
  const changed = before
    .filter(entry => byRelative.get(entry.relative) !== entry.sha256)
    .map(entry => ({ relative: entry.relative, before: entry.sha256, after: byRelative.get(entry.relative) ?? null }));
  return { files: before.length, changed, allUnchanged: changed.length === 0 };
}
