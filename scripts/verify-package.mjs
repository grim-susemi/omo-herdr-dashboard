import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await mkdtemp(join(tmpdir(), 'dashboard-package-'));
const env = { ...process.env, HOME: join(fixture, 'home'), USERPROFILE: join(fixture, 'home'), OMO_CODING_AGENT_DIR: join(fixture, 'default-agent'), SENPI_CODING_AGENT_DIR: join(fixture, 'default-agent'), PI_CODING_AGENT_DIR: join(fixture, 'default-agent'), npm_config_cache: join(fixture, 'cache') };
for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
const npm = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const run = (args, cwd = root) => execFileSync(process.execPath, [npm, ...args], { env, cwd, encoding: 'utf8' });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  const output = JSON.parse(run(['pack', '--ignore-scripts', '--json', '--pack-destination', fixture]));
  const pack = Array.isArray(output) ? output[0] : output['omo-herdr-dashboard'];
  for (const file of pack.files) assert.ok(!/^(packages|test|scripts|\.omo|\.git|node_modules)\//.test(file.path), 'Private/development tree in package: ' + file.path);
  const consumer = join(fixture, 'consumer');
  await mkdir(consumer);
  run(['install', '--prefix', consumer, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', join(fixture, pack.filename)]);
  const installed = join(consumer, 'node_modules/omo-herdr-dashboard');
  let runtime = 0;
  for (const component of ['todo', 'dag']) {
    const { readdir } = await import('node:fs/promises');
    for (const file of ['extension.mjs', ...(await readdir(join(root, 'dist', component, 'src'))).filter(file => file.endsWith('.mjs')).map(file => 'src/' + file)]) {
      assert.equal(sha(await readFile(join(installed, 'dist', component, file))), sha(await readFile(join(root, 'dist', component, file))));
      runtime++;
    }
  }
  const agent = join(fixture, 'agent');
  const result = JSON.parse(execFileSync(process.execPath, [join(installed, 'bin/omo-herdr-dashboard.mjs'), 'install', '--agent-dir', agent, '--lang', 'ko'], { env, encoding: 'utf8' }));
  assert.equal(result.installed, true);
  const wrapper = await readFile(result.extension, 'utf8');
  assert.match(wrapper, /omo-herdr-dashboard/);
  console.log(JSON.stringify({ pass: true, archiveFiles: pack.files.length, runtimeModules: runtime, singleExtension: true, offlineInstall: true }));
} finally { await rm(fixture, { recursive: true, force: true }); }
