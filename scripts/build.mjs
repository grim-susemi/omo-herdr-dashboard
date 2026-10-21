import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
for (const component of ['todo', 'dag']) execFileSync(process.execPath,
  [join(root, 'packages', component, 'scripts/build.mjs')], { cwd: join(root, 'packages', component), stdio: 'inherit' });
await mkdir(dist, { recursive: true });
for (const component of ['todo', 'dag']) {
  await rm(join(dist, component), { recursive: true, force: true });
  await cp(join(root, 'packages', component, 'dist'), join(dist, component), { recursive: true });
}
// The collaboration pane has no build step of its own: its sources ship as they are.
await rm(join(dist, 'coordination'), { recursive: true, force: true });
for (const part of ['extension.mjs', 'src']) await cp(join(root, 'packages/coordination', part), join(dist, 'coordination', part), { recursive: true });
for (const file of ['extension.mjs', 'LICENSE', 'THIRD-PARTY-NOTICES.md']) await cp(join(root, file), join(dist, file));
await cp(join(root, 'scripts/install.mjs'), join(dist, 'install.mjs'));
for (const file of ['extension.mjs', 'install.mjs', 'todo/extension.mjs', 'dag/extension.mjs',
  'todo/src/parent-slot.mjs', 'todo/src/terminal-input.mjs', 'dag/src/terminal-input.mjs', 'coordination/extension.mjs',
  'coordination/src/controller.mjs', 'coordination/src/viewer.mjs',
  'coordination/src/recovery.mjs', 'coordination/src/proof.mjs']) {
  await readFile(join(dist, file));
  execFileSync(process.execPath, ['--check', join(dist, file)], { stdio: 'inherit' });
}
// The four-pane participants share this one dependency-free protocol. Loading
// it from the built tree catches a missing or half-copied module before install.
const protocol = await import(pathToFileURL(join(dist, 'coordination/src/recovery.mjs')).href);
if (protocol.RECOVERY_V1?.layout !== 'omo.herdr.dashboard.layout.v1' ||
  typeof protocol.createRecoveryCoordinator !== 'function' || typeof protocol.layoutIssues !== 'function' ||
  typeof protocol.bindingRevision !== 'function')
  throw new Error('The shared four-pane recovery protocol did not load from dist.');
const proof = await import(pathToFileURL(join(dist, 'coordination/src/proof.mjs')).href);
if (typeof proof.inspectViewerProof !== 'function' || typeof proof.readViewerProof !== 'function')
  throw new Error('The shared viewer proof reader did not load from dist.');
console.log('PASS: single dashboard entry and both component runtimes built.');
