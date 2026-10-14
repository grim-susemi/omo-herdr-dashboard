import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
for (const file of ['extension.mjs', 'LICENSE', 'THIRD-PARTY-NOTICES.md']) await cp(join(root, file), join(dist, file));
await cp(join(root, 'scripts/install.mjs'), join(dist, 'install.mjs'));
for (const file of ['extension.mjs', 'install.mjs', 'todo/extension.mjs', 'dag/extension.mjs',
  'todo/src/parent-slot.mjs', 'todo/src/terminal-input.mjs', 'dag/src/terminal-input.mjs']) {
  await readFile(join(dist, file));
  execFileSync(process.execPath, ['--check', join(dist, file)], { stdio: 'inherit' });
}
console.log('PASS: single dashboard entry and both component runtimes built.');
