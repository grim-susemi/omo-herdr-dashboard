import * as filesystem from 'node:fs/promises';
import { dirname } from 'node:path';

export const sameSnapshotScope = (a, b) => a && b &&
  a.ownerKey === b.ownerKey && a.sessionId === b.sessionId && a.scopeEpoch === b.scopeEpoch;

export function validSnapshot(value) {
  return value !== null && typeof value === 'object' &&
    typeof value.ownerKey === 'string' && value.ownerKey.length > 0 &&
    typeof value.sessionId === 'string' && value.sessionId.length > 0 &&
    Number.isSafeInteger(value.scopeEpoch) && value.scopeEpoch > 0 &&
    Number.isSafeInteger(value.sequence) && value.sequence > 0 &&
    ['current', 'empty', 'waiting'].includes(value.availability) &&
    Array.isArray(value.phases) && value.phases.every(phase =>
      typeof phase?.name === 'string' && Array.isArray(phase.tasks) &&
      phase.tasks.every(task => typeof task?.content === 'string' &&
        ['pending', 'in_progress', 'completed', 'abandoned'].includes(task.status))) &&
    (value.availability !== 'empty' || value.phases.every(phase => phase.tasks.length === 0));
}

// Private, disposable projection cache only. No native session or preferences API.
export function createSnapshotStorage({ path, fs = filesystem }) {
  if (typeof path !== 'string' || !path.endsWith('.json')) throw new TypeError('Private cache requires a .json path');
  const temporary = `${path}.pending`;
  let scope = null;
  let generation = 0;
  let tail = Promise.resolve();
  const stale = () => Object.assign(new Error('Stale snapshot scope'), { code: 'STALE_SCOPE' });
  return {
    path,
    rebase(next) { scope = { ...next }; generation++; },
    write(value) {
      if (!validSnapshot(value) || !sameSnapshotScope(value, scope)) return Promise.reject(stale());
      const candidate = structuredClone(value);
      const epoch = generation;
      const check = () => { if (epoch !== generation || !sameSnapshotScope(candidate, scope)) throw stale(); };
      const job = tail.then(async () => {
        check();
        await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
        check();
        try {
          await fs.writeFile(temporary, JSON.stringify({ schema: 'omo-herdr-todo/cache/1', snapshot: candidate }), { mode: 0o600 });
          check();
          await fs.rename(temporary, path);
          check();
          return candidate;
        } catch (error) {
          await fs.rm(temporary, { force: true });
          throw error;
        }
      });
      tail = job.catch(() => {});
      return job;
    },
    async read() {
      const epoch = generation;
      const selected = { ...scope };
      try {
        const value = JSON.parse(await fs.readFile(path, 'utf8'));
        if (epoch !== generation) throw stale();
        if (value?.schema !== 'omo-herdr-todo/cache/1' || !validSnapshot(value.snapshot)) {
          throw Object.assign(new Error('Invalid derived snapshot cache'), { code: 'INVALID_CACHE' });
        }
        if (!sameSnapshotScope(value.snapshot, selected)) return { availability: 'waiting', snapshot: null };
        // A cache is not a live source or a painted frame.
        return { availability: 'last-known', label: 'last-known derived cache; not live', snapshot: value.snapshot };
      } catch (error) {
        if (epoch !== generation) return { availability: 'waiting', snapshot: null };
        if (error.code === 'ENOENT') return { availability: 'waiting', snapshot: null };
        return { availability: 'error', snapshot: null, error: { code: error.code ?? 'INVALID_CACHE', message: error.message } };
      }
    },
    async idle() { await tail; },
  };
}
