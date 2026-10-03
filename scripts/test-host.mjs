// Migrated native host harness entry point (npm run test:host).
//
// 1. resolve --senpi-root (explicit failure, never a fallback root),
// 2. assert the recorded SDK version and every native source hash,
// 3. run the migrated native host tests with node:test,
// 4. re-hash the same sources and fail when anything changed,
// 5. print a bounded JSON summary and remove its own fixture root.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSenpiRoot, assertSenpiVersion } from '../src/senpi-root.mjs';
import { hashManifest, compareToDeclared, summarizeIdentity } from '../src/source-hashes.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

function fail(message, detail = {}) {
  console.error(`test:host failed: ${message}`);
  console.log('HOST_RESULT_BEGIN');
  console.log(JSON.stringify({ schema: 'omo-herdr-todo/host-run/1', ok: false, error: message, ...detail }, null, 2));
  console.log('HOST_RESULT_END');
  process.exitCode = 1;
}

const senpiRootArg = value('--senpi-root');
if (!senpiRootArg) {
  fail('A --senpi-root path is required. usage: npm run test:host -- --senpi-root <path-to-@code-yeongyu/senpi>');
} else {
  let info;
  try {
    info = resolveSenpiRoot(senpiRootArg);
  } catch (error) {
    fail(`[${error.code ?? 'UNKNOWN'}] ${error.message}`, { senpiRoot: senpiRootArg });
  }
  if (info) {
    const manifest = JSON.parse(readFileSync(join(root, 'config/native-source-manifest.json'), 'utf8'));
    try {
      assertSenpiVersion(info, manifest.sdkVersion);
    } catch (error) {
      fail(`[${error.code}] ${error.message}`, { senpiRoot: info.root });
    }
    const relativePaths = manifest.files.map(file => file.path);
    const declared = Object.fromEntries(manifest.files.map(file => [file.path, file.sha256]));
    const before = await hashManifest(info.root, relativePaths);
    const mismatches = compareToDeclared(before, declared);
    if (mismatches.length > 0) {
      fail(`native source identity mismatch for ${mismatches.length} file(s)`, { mismatches });
    } else {
      const fixtureRoot = join(root, '.tmp-e1', `host-${process.pid}`);
      mkdirSync(fixtureRoot, { recursive: true });
      const run = spawnSync(process.execPath, [
        '--test', '--test-isolation=none', '--test-reporter=tap', '--test-timeout=120000',
        join(root, 'test/host/native-host.test.mjs'),
        join(root, 'test/host/display-bridge-host.test.mjs'),
      ], {
        cwd: root,
        encoding: 'utf8',
        timeout: 300000,
        maxBuffer: 128 * 1024 * 1024,
        env: {
          ...process.env,
          OMO_HERDR_SENPI_ROOT: info.root,
          OMO_HERDR_NATIVE_MANIFEST: join(root, 'config/native-source-manifest.json'),
          OMO_HERDR_FIXTURE_ROOT: fixtureRoot,
        },
      });
      const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
      process.stdout.write(run.stdout ?? '');
      process.stderr.write(run.stderr ?? '');
      const counts = {};
      for (const name of ['tests', 'pass', 'fail', 'skipped', 'todo']) {
        const match = new RegExp(`^# ${name} (\\d+)$`, 'm').exec(output);
        counts[name] = match ? Number(match[1]) : null;
      }
      const cases = [...output.matchAll(/^(?:not )?ok \d+ - (.+)$/gm)].map(match => match[1].trim());
      const after = await hashManifest(info.root, relativePaths);
      const identity = summarizeIdentity(before, after);
      const ok = run.status === 0 && (counts.fail ?? 1) === 0 && identity.allUnchanged;
      if (existsSync(fixtureRoot)) rmSync(fixtureRoot, { recursive: true, force: true });
      try { rmdirSync(join(root, '.tmp-e1')); } catch { /* the parent stays when other owned fixtures are live */ }
      console.log('HOST_RESULT_BEGIN');
      console.log(JSON.stringify({
        schema: 'omo-herdr-todo/host-run/1',
        ok,
        senpiRoot: info.root,
        sdkVersion: info.version,
        exitCode: run.status,
        counts,
        cases,
        identity,
        fixtureRootRemoved: !existsSync(fixtureRoot),
      }, null, 2));
      console.log('HOST_RESULT_END');
      if (!ok) process.exitCode = 1;
    }
  }
}
