import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
test('single extension migration backs up managed entries, preserves state, updates generations and refuses foreign entries', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'dashboard-install-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const agent = join(fixture, 'agent');
  const cli = join(root, 'bin/omo-herdr-dashboard.mjs');
  const env = { ...process.env, HOME: fixture, USERPROFILE: fixture, OMO_CODING_AGENT_DIR: agent, SENPI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent };
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, 'install', '--agent-dir', agent, ...args], { env, encoding: 'utf8' }));
  const dry = run('--dry-run', '--lang', 'ko');
  await assert.rejects(readdir(agent), { code: 'ENOENT' });
  await mkdir(join(agent, 'extensions'), { recursive: true });
  for (const component of ['todo', 'dag']) {
    const generation = join(agent, `herdr-${component}/integration/generation-000001`);
    await mkdir(generation, { recursive: true });
    await writeFile(join(generation, '.installed-by'), `// managed by omo-herdr-${component}`);
    await writeFile(join(agent, `extensions/omo-herdr-${component}.js`), `// managed by omo-herdr-${component}\nexport { default } from '../herdr-${component}/integration/generation-000001/extension.mjs';\n`);
    await writeFile(join(agent, `herdr-${component}/retained.json`), 'retained');
  }
  const first = run('--lang', 'ko');
  assert.equal(first.extension, dry.extension);
  assert.deepEqual(await readdir(join(agent, 'extensions')), ['omo-herdr-dashboard.js']);
  assert.equal(JSON.parse(await readFile(join(first.integration, 'legacy-wrapper-backup.json'))).length, 2);
  for (const component of ['todo', 'dag']) {
    assert.equal(await readFile(join(agent, `herdr-${component}/retained.json`), 'utf8'), 'retained');
    assert.equal(JSON.parse(await readFile(join(first.integration, component, 'locale.json'))).language, 'ko');
  }
  // Model the published layout: generation-000003 has no parent-slot module.
  await rm(join(first.integration, 'todo/src/parent-slot.mjs'));
  await assert.rejects(readFile(join(first.integration, 'todo/src/parent-slot.mjs')), { code: 'ENOENT' });
  const wrapperBeforeUpgrade = await readFile(first.extension, 'utf8');
  const pointerFile = join(agent, 'herdr-dashboard/integration/current.json');
  const pointerBeforeUpgrade = await readFile(pointerFile, 'utf8');
  const upgradePlan = run('--dry-run', '--lang', 'ko');
  assert.equal(upgradePlan.backup, first.integration);
  assert.equal(await readFile(first.extension, 'utf8'), wrapperBeforeUpgrade);
  assert.equal(await readFile(pointerFile, 'utf8'), pointerBeforeUpgrade);
  assert.equal((await readdir(join(agent, 'herdr-dashboard/integration'))).filter(file => file.startsWith('generation-')).length, 1);
  const next = run('--lang', 'ko');
  assert.notEqual(next.integration, first.integration);
  assert.equal(next.backup, first.integration);
  assert.equal(await readFile(join(next.integration, 'todo/src/parent-slot.mjs'), 'utf8'),
    await readFile(join(root, 'dist/todo/src/parent-slot.mjs'), 'utf8'));
  await assert.rejects(readFile(join(first.integration, 'todo/src/parent-slot.mjs')), { code: 'ENOENT' });
  assert.equal(typeof (await import('../dist/extension.mjs')).default, 'function');
  const commands = new Map(), events = [];
  const previousState = Object.fromEntries(['OMO_HERDR_DAG_STATE_DIR', 'OMO_HERDR_TODO_STATE_DIR'].map(key => [key, process.env[key]]));
  try {
    (await import('../dist/extension.mjs')).default({ cwd: fixture, on(name, callback) { events.push([name, callback]); }, registerCommand(name, command) { commands.set(name, command); } });
    assert.deepEqual([...commands.keys()], ['dashboard']);
    assert.equal(events.filter(([name]) => name === 'session_start').length, 2);
  } finally { for (const [key, value] of Object.entries(previousState)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await writeFile(join(agent, 'extensions/omo-herdr-todo.js'), 'foreign');
  const before = await readFile(next.extension, 'utf8');
  assert.throws(() => run('--lang', 'ko'));
  assert.equal(await readFile(next.extension, 'utf8'), before);
  assert.equal((await readdir(join(agent, 'herdr-dashboard/integration'))).filter(file => file.startsWith('generation-')).length, 2);
});
