import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VersionUpdateManager } from '../../src/host/surface/version-updates.ts'
import { resolveMemorySpacesConfig } from '../../src/components/source-memory-spaces/src/config.ts'
import { MemoryProviderCatalog } from '../../src/components/source-memory-spaces/src/providers/catalog.ts'
import { MemoryProviderAdapterRegistry } from '../../src/components/source-memory-spaces/src/providers/registry.ts'
import { MemorySpacesService } from '../../src/components/source-memory-spaces/src/service.ts'

describe('Provider one-click check and install', () => {
  it('checks missing mnemon CLI and installs it via npm when available', async () => {
    let installed = false
    const commands = []
    const manager = new VersionUpdateManager({
      mnemonCliPath: () => (installed ? '/usr/local/bin/mnemon' : undefined),
      resolveExecutable: cmd => {
        if (cmd === 'npm') return '/usr/local/bin/npm'
        if (installed && cmd === '/usr/local/bin/mnemon') return '/usr/local/bin/mnemon'
        return undefined
      },
      fetchNpmLatest: async () => '0.1.2',
      fetchMnemonLatest: async () => '0.2.15',
      processRunner: async (command, args) => {
        commands.push([command, ...args])
        if (command === '/usr/local/bin/npm' && args.includes('install')) {
          installed = true
          return { exitCode: 0, stdout: '+ @mnemon-dev/mnemon@0.2.15\n', stderr: '' }
        }
        if (command === '/usr/local/bin/mnemon' && args[0] === '--version') {
          return { exitCode: 0, stdout: 'mnemon version 0.2.15\n', stderr: '' }
        }
        return { exitCode: 1, stdout: '', stderr: 'unexpected command' }
      },
    })

    const before = await manager.check()
    const mnemonBefore = before.components.find(item => item.id === 'mnemon')
    assert.ok(mnemonBefore)
    assert.equal(mnemonBefore.installMode, 'missing')
    assert.equal(mnemonBefore.updateSupported, true)
    assert.equal(mnemonBefore.updateHint, 'install')

    const result = await manager.update('mnemon')
    assert.equal(result.component, 'mnemon')
    assert.equal(result.previousVersion, undefined)
    assert.equal(result.currentVersion, '0.2.15')
    assert.equal(result.updated, true)
    assert.equal(result.restartRequired, false)
    assert.ok(commands.some(entry => entry[0] === '/usr/local/bin/npm' && entry.includes('--global') && entry.includes('@mnemon-dev/mnemon@latest')))

    const after = await manager.check()
    const mnemonAfter = after.components.find(item => item.id === 'mnemon')
    assert.ok(mnemonAfter)
    assert.equal(mnemonAfter.current, '0.2.15')
    assert.notEqual(mnemonAfter.installMode, 'missing')
  })

  it('reports npm-missing when mnemon CLI and npm are both unavailable', async () => {
    const manager = new VersionUpdateManager({
      mnemonCliPath: () => undefined,
      resolveExecutable: () => undefined,
      fetchNpmLatest: async () => '0.1.2',
      fetchMnemonLatest: async () => '0.2.15',
    })

    const status = await manager.check()
    const mnemon = status.components.find(item => item.id === 'mnemon')
    assert.ok(mnemon)
    assert.equal(mnemon.installMode, 'missing')
    assert.equal(mnemon.updateSupported, false)
    assert.equal(mnemon.updateHint, 'npm-missing')

    await assert.rejects(() => manager.update('mnemon'), /npm is unavailable/i)
  })

  it('checks third-party provider connectivity via discover without mutating state', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mnemo-provider-check-'))
    try {
      const descriptor = {
        id: 'mock-remote',
        label: 'Mock Remote',
        icon: { kind: 'brand', value: 'mock' },
        kind: 'remote',
        workspaceBinding: 'provider-global',
        summary: 'Mock remote provider',
        origin: 'external',
        capabilities: {
          search: true, browse: false, graph: false, entities: false, related: false,
          remember: true, link: false, forget: true, writeMode: 'exact', deletionMode: 'hard',
        },
        fields: [
          { key: 'apiKey', label: 'API Key', input: 'secret', scope: 'service', required: true },
        ],
      }
      const adapter = {
        id: 'mock-remote',
        async discover(connection) {
          if (connection.apiKey !== 'valid-key') throw new Error('unauthorized')
          return [
            { externalId: 's1', name: 'Space 1', description: '', connection: {} },
            { externalId: 's2', name: 'Space 2', description: '', connection: {} },
          ]
        },
        async status() { return { healthy: true } },
        async search() { return { results: [] } },
        async graph() { return { nodes: [], edges: [] } },
        async list() { return [] },
        async remember() { return {} },
      }
      const runner = { effectiveDataDir: () => dataDir, command: '' }
      const config = resolveMemorySpacesConfig({ dataDir, writeEnabled: true })
      const registry = new MemoryProviderAdapterRegistry()
      registry.register({ id: 'mock-remote', create: () => adapter })
      const catalog = new MemoryProviderCatalog([descriptor])
      const service = new MemorySpacesService(runner, config, undefined, undefined, registry, catalog)

      const ok = await service.checkProviderService('mock-remote', { apiKey: 'valid-key' })
      assert.deepEqual(ok, { providerId: 'mock-remote', healthy: true, spacesCount: 2 })
      assert.equal(service.memorySpaces.providerServices().items.find(item => item.providerId === 'mock-remote')?.configured, false)

      const bad = await service.checkProviderService('mock-remote', { apiKey: 'wrong-key' })
      assert.equal(bad.providerId, 'mock-remote')
      assert.equal(bad.healthy, false)
      assert.match(bad.error ?? '', /unauthorized/)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
