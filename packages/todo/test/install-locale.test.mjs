import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

test('installed locale is selected by the actual extension with explicit environment override', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'todo-locale-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const packages = join(dir, 'packages'), todo = join(packages, 'todo');
  await cp(join(root, 'src'), join(todo, 'src'), { recursive: true });
  await cp(join(root, 'extension.mjs'), join(todo, 'extension.mjs'));
  // The controller shares the v1 recovery protocol with DAG and coordination.
  await cp(join(root, '../coordination/src'), join(packages, 'coordination/src'), { recursive: true });
  const module = await import(pathToFileURL(join(todo, 'extension.mjs')));
  for (const language of ['ko', 'zh-cn']) {
    await writeFile(join(todo, 'locale.json'), JSON.stringify({ language }));
    assert.equal(module.installedLanguage({}), language);
    assert.equal(module.installedLanguage({ OMO_HERDR_TODO_LANG: 'en' }), 'en');
  }
  await writeFile(join(todo, 'locale.json'), 'invalid');
  assert.equal(module.installedLanguage({}), 'en');
});
