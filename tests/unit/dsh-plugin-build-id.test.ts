import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from '../support/temp.ts';
import { assertCarriesBuildId, buildId } from '../../plugins/dsh-mnemo-weave/build-id.ts';

/**
 * The identity exists so a page can say the Host is running other code. Two properties make that
 * work: the same sources always produce the same value, and the build refuses to ship a bundle
 * that does not carry it. A timestamp would break the first; a missing check would break the second
 * silently, because esbuild's `define` is a no-op when the identifier is never referenced.
 */
test('the build identity follows the sources and ignores the build output', async () => {
  const dir = await tempDir('build-id', 'identity');
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  const first = await buildId(dir);

  // Same sources, same value: rebuilding without a change must not churn the output.
  assert.equal(await buildId(dir), first);

  // A source change changes it.
  await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 2;\n', 'utf8');
  const changed = await buildId(dir);
  assert.notEqual(changed, first);

  // Output under lib/ is not source: writing it must not alter the identity, or every build
  // would produce a different value than the one it just wrote.
  await mkdir(join(dir, 'lib'), { recursive: true });
  await writeFile(join(dir, 'lib', 'index.js'), 'built\n', 'utf8');
  assert.equal(await buildId(dir), changed);
});

test('a new file in the tree changes the identity', async () => {
  const dir = await tempDir('build-id', 'newfile');
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  const before = await buildId(dir);
  await writeFile(join(dir, 'src', 'b.ts'), 'export const b = 1;\n', 'utf8');
  assert.notEqual(await buildId(dir), before, 'adding a source file must invalidate the identity');
});

test('the build fails when a bundle does not carry the identity', async () => {
  const dir = await tempDir('build-id', 'missing');
  await mkdir(join(dir, 'lib'), { recursive: true });
  const file = join(dir, 'lib', 'client.js');
  await writeFile(file, 'window.__ModuleLoader__.load({ id: "x" });\n', 'utf8');
  // A bundle without the value cannot let the two halves compare themselves, so shipping it is
  // worse than failing: the mismatch would go unreported.
  await assert.rejects(() => assertCarriesBuildId(file, 'abc123'), /does not carry the build identity/);
  await writeFile(file, 'const build = "abc123";\n', 'utf8');
  await assertCarriesBuildId(file, 'abc123');
});
