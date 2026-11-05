import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = data => createHash('sha256').update(data).digest('hex');

test('isolated generation and shim restore together after a failed upgrade', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-rollback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agent = join(dir, 'agent');
  const cli = join(root, 'bin/omo-herdr-dashboard.mjs');
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, OMO_CODING_AGENT_DIR: agent,
    SENPI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent };
  const run = (...args) => JSON.parse(execFileSync(process.execPath,
    [cli, 'install', '--agent-dir', agent, '--lang', 'ko', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const first = run();
  const pointer = join(agent, 'herdr-dashboard/integration/current.json');
  const shim = first.extension;
  const originalPointer = await readFile(pointer);
  const originalShim = await readFile(shim);
  const generation = JSON.parse(originalPointer).generation;
  assert.equal(run('--dry-run').backup, first.integration);
  assert.ok(originalShim.toString().includes(`/${generation}/extension.mjs`));
  const viewer = join(first.integration, 'dag/src/viewer.mjs');
  const originalHash = hash(await readFile(viewer));
  const second = run();
  assert.notEqual(second.integration, first.integration);
  // A foreign legacy shim causes an upgrade to fail without touching the live directory.
  const foreign = join(agent, 'extensions/omo-herdr-todo.js');
  await writeFile(foreign, 'foreign');
  assert.throws(() => run());
  await rm(foreign);
  for (const [file, contents] of [[shim, originalShim], [pointer, originalPointer]]) {
    const temp = `${file}.restore`;
    await writeFile(temp, contents);
    await rename(temp, file);
  }
  assert.deepEqual(await readFile(shim), originalShim);
  assert.deepEqual(await readFile(pointer), originalPointer);
  assert.equal(hash(await readFile(viewer)), originalHash);
  assert.equal(typeof (await import(pathToFileURL(join(first.integration, 'extension.mjs')).href)).default, 'function');
});
