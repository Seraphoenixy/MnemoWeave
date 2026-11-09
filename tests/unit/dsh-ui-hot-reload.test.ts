import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  HOT_RELOAD_ENV, isHostArtifact, reloadBundle, shouldWatch, watchLib, type PluginManagerLike,
} from '../../plugins/dsh-mnemo-weave/src/ui/hot-reload.ts';

const existsOf = (present: string[]) => (path: string): boolean => present.some(item => path.replaceAll('\\', '/').endsWith(item));

test('the watcher only arms for a checkout install with a build output', () => {
  const checkout = existsOf(['src/ui/index.ts', 'build.mjs', 'lib']);
  assert.equal(shouldWatch('C:/work/plugin', {}, checkout), true);
  assert.equal(shouldWatch('C:/work/plugin', { [HOT_RELOAD_ENV]: '0' }, checkout), false);
  assert.equal(shouldWatch('C:/work/plugin', {}, existsOf(['build.mjs', 'lib'])), false, 'packaged copy has no src');
  assert.equal(shouldWatch('C:/work/plugin', {}, existsOf(['src/ui/index.ts', 'lib'])), false);
  assert.equal(shouldWatch('C:/work/plugin', {}, existsOf(['src/ui/index.ts', 'build.mjs'])), false);
});

test('only Host-side artifacts trigger a recompose', () => {
  assert.equal(isHostArtifact('index.js'), true);
  assert.equal(isHostArtifact('ui/index.js'), true);
  assert.equal(isHostArtifact('shared/contract.js'), true);
  assert.equal(isHostArtifact('client.js'), false);
  assert.equal(isHostArtifact('ui/client.js'), false);
  assert.equal(isHostArtifact('ui/index.js.map'), false);
  assert.equal(isHostArtifact('ui\\index.js'), true);
});

test('reload reports the host outcome instead of assuming success', async () => {
  const calls: Array<[string, boolean]> = [];
  const ok: PluginManagerLike = { setBundleEnabled: async (name, enabled) => { calls.push([name, enabled]); return { status: 'reloaded', message: '已热加载' }; } };
  assert.deepEqual(await reloadBundle(ok), { ok: true, message: '已热加载' });
  assert.deepEqual(calls, [['dsh-mnemo-weave', true]]);

  const failed: PluginManagerLike = { setBundleEnabled: async () => ({ status: 'failed', message: '需要重启' }) };
  assert.deepEqual(await reloadBundle(failed), { ok: false, message: '需要重启' });

  const broken: PluginManagerLike = { setBundleEnabled: async () => { throw new Error('host offline'); } };
  assert.deepEqual(await reloadBundle(broken), { ok: false, message: 'host offline' });

  const missing = await reloadBundle(undefined);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /pluginManager/);

  const unsigned: PluginManagerLike = { setBundleEnabled: async () => undefined };
  assert.equal((await reloadBundle(unsigned)).ok, true);
});

test('watchLib debounces writes and honours the filter', async () => {
  const dir = await mkdtemp(resolve('work/tests/hot-reload-'));
  try {
    await mkdir(join(dir, 'ui'), { recursive: true });
    const seen: string[] = [];
    let resolveSeen: (() => void) | undefined;
    const first = new Promise<void>(resolve => { resolveSeen = resolve; });
    const stop = watchLib({
      dir,
      debounceMs: 40,
      filter: isHostArtifact,
      onChange: () => { seen.push('change'); resolveSeen?.(); },
      logger: { info: () => {}, warn: () => {} },
    });
    try {
      // The browser bundle must not wake the Host watcher.
      await writeFile(join(dir, 'client.js'), 'window.x = 1\n');
      await new Promise(done => setTimeout(done, 120));
      assert.deepEqual(seen, []);
      await writeFile(join(dir, 'ui', 'index.js'), 'export const x = 1\n');
      await Promise.race([first, new Promise((_, reject) => setTimeout(() => reject(new Error('watch did not fire')), 4_000))]);
      await new Promise(done => setTimeout(done, 150));
      assert.deepEqual(seen, ['change'], 'a burst of writes collapses into one reload');
    } finally { stop(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
