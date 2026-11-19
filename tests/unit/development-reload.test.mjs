import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { findCheckoutRoot, installDevelopmentReload } from '../../src/host/boot/development-reload.ts'

async function createCheckoutFixture() {
  const root = await mkdtemp(join(tmpdir(), 'mnemo-dev-reload-'))
  await writeFile(join(root, 'package.json'), '{"name":"fixture"}\n', 'utf8')
  await writeFile(join(root, 'tsdown.config.ts'), 'export default []\n', 'utf8')
  await mkdir(join(root, 'dist', 'chunks'), { recursive: true })
  await mkdir(join(root, 'src', 'host', 'boot'), { recursive: true })
  await mkdir(join(root, '.cache'), { recursive: true })
  return root
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for condition')
}

test('findCheckoutRoot resolves repository root across nested paths', async () => {
  const root = await createCheckoutFixture()
  const unrelated = await mkdtemp(join(tmpdir(), 'mnemo-dev-reload-other-'))
  try {
    const expected = pathToFileURL(root + '/').href
    assert.equal(findCheckoutRoot(pathToFileURL(join(root, 'dist', 'index.js'))).href, expected)
    assert.equal(findCheckoutRoot(pathToFileURL(join(root, 'dist', 'chunks', 'shared.js'))).href, expected)
    assert.equal(findCheckoutRoot(pathToFileURL(join(root, 'src', 'host', 'boot', 'development-reload.ts'))).href, expected)
    assert.equal(findCheckoutRoot(pathToFileURL(join(unrelated, 'index.js'))), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(unrelated, { recursive: true, force: true })
  }
})

test('installDevelopmentReload skips registration when disabled or outside checkout', async () => {
  const root = await createCheckoutFixture()
  let registered = 0
  const ctx = {
    effect() {
      registered += 1
    },
    get() {
      return undefined
    },
  }

  try {
    installDevelopmentReload(ctx, {
      checkoutRoot: pathToFileURL(root + '/'),
      env: { DSH_MNEMO_WEAVE_HOT_RELOAD: '0' },
    })
    assert.equal(registered, 0)

    const outside = await mkdtemp(join(tmpdir(), 'mnemo-dev-reload-none-'))
    try {
      const checkout = findCheckoutRoot(pathToFileURL(join(outside, 'index.js')))
      assert.equal(checkout, undefined)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('installDevelopmentReload reacts to build markers across states and stops on dispose', async () => {
  const root = await createCheckoutFixture()
  const markerPath = join(root, '.cache', 'dsh-build-complete')
  const indexPath = join(root, 'dist', 'index.js')
  const clientPath = join(root, 'dist', 'client.js')
  const infoLogs = []
  const warnLogs = []
  const calls = []
  const queue = [
    { application: 'restart-required', restartReason: 'no-hmr' },
    { application: 'restart-required', restartReason: 'no-hmr' },
    { application: 'failed', error: { message: 'reconcile failed' } },
    { application: 'applied' },
    { application: 'restart-required', restartReason: 'no-hmr' },
  ]
  let managerEnabled = false
  let dispose = null

  const ctx = {
    effect(callback) {
      dispose = callback()
    },
    get(key) {
      if (key !== 'pluginManager' || !managerEnabled) return undefined
      return {
        async setBundleEnabled(name, enabled) {
          calls.push([name, enabled])
          return queue.shift() ?? { application: 'applied' }
        },
      }
    },
  }

  try {
    installDevelopmentReload(ctx, {
      checkoutRoot: pathToFileURL(root + '/'),
      intervalMs: 40,
      logger: {
        info: (...args) => infoLogs.push(args.join(' ')),
        warn: (...args) => warnLogs.push(args.join(' ')),
      },
    })
    assert.equal(typeof dispose, 'function')

    // Missing build artifacts guard
    await writeFile(markerPath, 'build-1\n', 'utf8')
    await waitFor(() => warnLogs.some(line => line.includes('构建产物不完整')))

    // Missing pluginManager guard once artifacts exist
    await writeFile(indexPath, 'export {}\n', 'utf8')
    await writeFile(clientPath, 'module.exports = {}\n', 'utf8')
    await writeFile(markerPath, 'build-2\n', 'utf8')
    await waitFor(() => warnLogs.some(line => line.includes('缺少插件管理器')))

    // Enable pluginManager: two consecutive no-hmr results warn only once
    managerEnabled = true
    await writeFile(markerPath, 'build-3\n', 'utf8')
    await waitFor(() => calls.length === 1)
    await writeFile(markerPath, 'build-4\n', 'utf8')
    await waitFor(() => calls.length === 2)
    assert.equal(warnLogs.filter(line => line.includes('no-hmr')).length, 1)

    // Failed reload logs warning and keeps watcher active
    await writeFile(markerPath, 'build-5\n', 'utf8')
    await waitFor(() => warnLogs.some(line => line.includes('reconcile failed')))
    assert.equal(calls.length, 3)

    // Applied resets restartAnnounced so a later no-hmr can warn again
    await writeFile(markerPath, 'build-6\n', 'utf8')
    await waitFor(() => infoLogs.some(line => line.includes('WebUI 变更刷新页面生效')))
    assert.equal(calls.length, 4)

    await writeFile(markerPath, 'build-7\n', 'utf8')
    await waitFor(() => calls.length === 5)
    assert.equal(warnLogs.filter(line => line.includes('no-hmr')).length, 2)
    assert.deepEqual(calls, Array(5).fill(['dsh-mnemo-weave', true]))

    // Dispose stops subsequent marker triggers
    dispose()
    await writeFile(markerPath, 'build-8\n', 'utf8')
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.equal(calls.length, 5)
  } finally {
    dispose?.()
    await rm(root, { recursive: true, force: true })
  }
})
