import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createSnapshotStorage } from '../src/storage.mjs';

const scope = { ownerKey: 'test-owner', sessionId: 'test-session', scopeEpoch: 1 };
const snapshot = (sequence = 1, binding = scope) => ({ ...binding, sequence, availability: 'current',
  phases: [{ name: 'Build', tasks: [{ content: 'work', status: 'pending' }] }] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('private cache roundtrip, ENOENT, empty, new scope, invalid and EPERM remain truthful', async t => {
  const prefix = fileURLToPath(new URL(`../.task5-storage-${process.pid}-`, import.meta.url));
  console.log(`TASK5_FIXTURE_DESCRIPTOR ${JSON.stringify({ pid: process.pid, prefix })}`);
  const cacheDirectory = await fs.mkdtemp(prefix);
  console.log(`TASK5_FIXTURE_ALLOCATED ${JSON.stringify({ pid: process.pid, directory: cacheDirectory })}`);
  const path = join(cacheDirectory, 'storage.json');
  const store = createSnapshotStorage({ path });
  t.after(async () => {
    await store.idle();
    await fs.rm(path, { force: true });
    await fs.rm(`${path}.pending`, { force: true });
    await fs.rmdir(cacheDirectory);
    console.log(`TASK5_FIXTURE_REMOVED ${JSON.stringify({ pid: process.pid, directory: cacheDirectory })}`);
  });
  store.rebase(scope);
  assert.deepEqual(await store.read(), { availability: 'waiting', snapshot: null });
  await store.write(snapshot());
  const cached = await store.read();
  assert.equal(cached.availability, 'last-known');
  assert.match(cached.label, /not live/);
  assert.deepEqual(cached.snapshot, snapshot());
  await store.write({ ...snapshot(2), availability: 'empty', phases: [] });
  assert.equal((await store.read()).snapshot.availability, 'empty');
  store.rebase({ ...scope, scopeEpoch: 2 });
  assert.equal((await store.read()).snapshot, null);
  const errorStore = createSnapshotStorage({ path, fs: {
    readFile: async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); },
  } });
  errorStore.rebase(scope);
  assert.equal((await errorStore.read()).error.code, 'EPERM');
  const invalidStore = createSnapshotStorage({ path, fs: { readFile: async () => '{"preferences":{}}' } });
  invalidStore.rebase(scope);
  assert.equal((await invalidStore.read()).error.code, 'INVALID_CACHE');
  assert.throws(() => createSnapshotStorage({ path: 'native-session.jsonl' }));
});

test('serialized writes reject stale work before rename and never overwrite the new scope', async () => {
  const entered = deferred();
  const release = deferred();
  const operations = [];
  let value;
  let blocked = true;
  const store = createSnapshotStorage({ path: 'private-cache.json', fs: {
    mkdir: async () => {},
    writeFile: async (path, text) => {
      operations.push(['write', JSON.parse(text).snapshot.scopeEpoch]);
      value = text;
      if (blocked) { blocked = false; entered.resolve(); await release.promise; }
    },
    rename: async () => operations.push(['rename', JSON.parse(value).snapshot.scopeEpoch]),
    rm: async () => operations.push(['cleanup']),
  } });
  store.rebase(scope);
  const old = store.write(snapshot());
  const rejected = assert.rejects(old, { code: 'STALE_SCOPE' });
  await entered.promise;
  const nextScope = { ...scope, scopeEpoch: 2 };
  store.rebase(nextScope);
  const fresh = store.write(snapshot(1, nextScope));
  release.resolve();
  await rejected;
  await fresh;
  assert.deepEqual(operations, [['write', 1], ['cleanup'], ['write', 2], ['rename', 2]]);
});

test('write failure removes only the owned temporary and preserves prior cache', async () => {
  for (const code of ['ENOENT', 'EPERM']) {
    const events = [];
    const store = createSnapshotStorage({ path: 'private-cache.json', fs: {
      mkdir: async () => {},
      writeFile: async () => events.push('write'),
      rename: async () => { throw Object.assign(new Error(code), { code }); },
      rm: async path => events.push(path),
    } });
    store.rebase(scope);
    await assert.rejects(store.write(snapshot()), { code });
    assert.deepEqual(events, ['write', 'private-cache.json.pending']);
  }
});

test('same-scope writes serialize every commit without timing-based coordination', async () => {
  const entered = deferred();
  const release = deferred();
  const events = [];
  let current;
  const store = createSnapshotStorage({ path: 'private-cache.json', fs: {
    mkdir: async () => {},
    writeFile: async (path, text) => {
      current = JSON.parse(text).snapshot.sequence;
      events.push(['write', current]);
      if (current === 1) { entered.resolve(); await release.promise; }
    },
    rename: async () => events.push(['commit', current]),
    rm: async () => {},
  } });
  store.rebase(scope);
  const first = store.write(snapshot(1));
  await entered.promise;
  const second = store.write(snapshot(2));
  assert.deepEqual(events, [['write', 1]]);
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, [['write', 1], ['commit', 1], ['write', 2], ['commit', 2]]);
});
