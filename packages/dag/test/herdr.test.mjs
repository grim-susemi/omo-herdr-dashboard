import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createHerdr, herdrSession, quote, resolveHerdrBin, shellCommand } from '../src/herdr.mjs';

async function nativeHerdr(t) {
  const directory = await mkdtemp(join(tmpdir(), 'herdr-native-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, process.platform === 'win32' ? 'herdr.exe' : 'herdr');
  await copyFile(process.execPath, bin);
  const probe = join(directory, 'argv.mjs');
  await writeFile(probe, 'console.log(JSON.stringify({result:{argv:process.argv.slice(1)}})); process.exit(0);');
  return { directory, bin, options: `--import=${pathToFileURL(probe).href}` };
}

test('POSIX shell command preserves apostrophes and shell metacharacters', () => {
  // Given literal shell-sensitive argv, including an empty value.
  const args = ['/opt/node path/node', "/tmp/owner's/viewer.mjs", '$HOME; & `echo`', ''];
  // When the builder targets a POSIX pane, execute its actual quoting in Bash.
  const command = shellCommand(args, 'linux');
  const output = execFileSync('bash', ['-c', `printf '%s${String.fromCharCode(92)}0' ${command}`], { encoding: 'utf8', timeout: 10000 });
  // Then the original quoting contract and literal argv survive.
  assert.equal(command, args.map(quote).join(' '));
  assert.deepEqual(output.split(String.fromCharCode(0)).slice(0, -1), args);
});

test('Herdr adapter uses the supplied executable even when Herdr is absent from PATH', async t => {
  // Given a real executable probe, with no PATH lookup available.
  const directory = await mkdtemp(join(tmpdir(), 'herdr-binary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'pane'), 'console.log(JSON.stringify({result:{argv:process.argv.slice(2)}}));');
  const module = new URL('../src/herdr.mjs', import.meta.url).href;
  // When createHerdr invokes the configured executable with the pane arguments.
  const code = `const {createHerdr} = await import(${JSON.stringify(module)}); console.log(JSON.stringify(await createHerdr()('get','test:pane')));`;
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', code], {
    cwd: directory, env: { ...process.env, PATH: '', HERDR_BIN_PATH: process.execPath }, encoding: 'utf8', timeout: 10000 });
  // Then the real child process receives the explicit pane operation.
  assert.deepEqual(JSON.parse(output), { argv: ['get', 'test:pane'] });
});

test('resolveHerdrBin ignores a deleted HERDR_BIN_PATH and uses PATH', async t => {
  const { directory, bin: stub } = await nativeHerdr(t);
  assert.equal(resolveHerdrBin({ HERDR_BIN_PATH: `${stub} (deleted)`, PATH: directory }), stub);
  assert.equal(resolveHerdrBin({ HERDR_BIN_PATH: join(directory, 'missing'), PATH: directory }), stub);
  assert.equal(resolveHerdrBin({ PATH: '' }), null);
});

test('herdrSession requires env, a live socket, and a real herdr binary', async t => {
  const { directory, bin: stub } = await nativeHerdr(t);
  const socket = join(directory, 'herdr.sock');
  const env = { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: socket, PATH: directory };
  assert.equal(herdrSession(env), false);
  await writeFile(socket, '');
  assert.equal(herdrSession(env), true);
  assert.equal(herdrSession({ ...env, HERDR_BIN_PATH: stub }), true);
  assert.equal(herdrSession({ ...env, HERDR_BIN_PATH: `${stub} (deleted)` }), false);
  assert.equal(herdrSession({ ...env, HERDR_ENV: '0' }), false);
  assert.equal(herdrSession({ ...env, HERDR_PANE_ID: '' }), false);
  assert.equal(herdrSession({ ...env, PATH: '' }), false);
});

test('createHerdr falls back to PATH when HERDR_BIN_PATH is a deleted path', async t => {
  const { directory, bin, options } = await nativeHerdr(t);
  const herdr = createHerdr({ ...process.env, PATH: directory, HERDR_BIN_PATH: `${bin} (deleted)`, NODE_OPTIONS: options });
  // Node resolves its script argument before the preload observes the real argv.
  assert.deepEqual(await herdr('get', 'test:pane'), { argv: [join(process.cwd(), 'pane'), 'get', 'test:pane'] });
});

test('createHerdr refuses to spawn when no herdr binary exists', async t => {
  const herdr = createHerdr({ PATH: '', HERDR_BIN_PATH: '/no/such/herdr (deleted)' });
  await assert.rejects(herdr('list'), /Herdr is not available in this session/);
});
