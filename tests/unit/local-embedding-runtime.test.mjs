import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { resolveEmbedding } from '../../src/components/source-memory-spaces/src/config.ts'
import {
  buildLlamaEmbeddingArgs,
  deployLocalEmbeddingRuntime,
  inspectLocalEmbeddingRuntime,
  LocalEmbeddingServerManager,
} from '../../src/components/source-memory-spaces/src/local-embedding-runtime.ts'

function createFakeChild() {
  const child = new EventEmitter()
  child.pid = 43210
  child.exitCode = null
  child.killed = false
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {
    if (child.killed) return true
    child.killed = true
    child.exitCode = 0
    queueMicrotask(() => child.emit('exit', 0, 'SIGTERM'))
    return true
  }
  return child
}

describe('Local llama.cpp embedding runtime', () => {
  it('resolves local llama-cpp presets and lifecycle strategies', () => {
    const resolved06 = resolveEmbedding({
      enabled: true,
      runtime: 'llama-cpp',
      localPreset: 'qwen3-embedding:0.6b',
      lifecycle: 'on-demand',
      localDevice: 'cpu',
    })
    assert.equal(resolved06.runtime, 'llama-cpp')
    assert.equal(resolved06.localPreset, 'qwen3-embedding:0.6b')
    assert.equal(resolved06.lifecycle, 'on-demand')
    assert.equal(resolved06.localDevice, 'cpu')

    const resolved4b = resolveEmbedding({
      enabled: true,
      runtime: 'llama-cpp',
      localPreset: 'qwen3-embedding:4b',
      lifecycle: 'write-first-fill-later',
      localDevice: 'gpu',
      localPort: 8920,
    })
    assert.equal(resolved4b.localPreset, 'qwen3-embedding:4b')
    assert.equal(resolved4b.lifecycle, 'write-first-fill-later')
    assert.equal(resolved4b.localPort, 8920)

    const args = buildLlamaEmbeddingArgs('/tmp/model.gguf', 8911, 99)
    assert.ok(args.includes('--embedding'))
    assert.ok(args.includes('--pooling'))
    assert.ok(args.includes('last'))
    assert.ok(args.includes('8911'))
  })

  it('handles blank llamaServerPath and missing localPreset without crashing during inspect', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'mnemo-local-embed-blank-'))
    try {
      const cfgBlank = resolveEmbedding({
        enabled: true,
        runtime: 'llama-cpp',
        localPreset: 'qwen3-embedding:0.6b',
        lifecycle: 'on-demand',
        localDevice: 'auto',
        llamaServerPath: '',
      })
      assert.equal(cfgBlank.llamaServerPath, undefined)
      const status1 = await inspectLocalEmbeddingRuntime(cfgBlank, { rootDir, probeHealth: async () => false })
      assert.equal(status1.preset, 'qwen3-embedding:0.6b')
      assert.equal(status1.port, 8911)
      assert.equal(status1.serverInstalled, false)
      assert.equal(status1.modelInstalled, false)

      // Defensive fallback if an older/stripped config omits localPreset
      const status2 = await inspectLocalEmbeddingRuntime({ llamaServerPath: '   ' }, { rootDir, probeHealth: async () => false })
      assert.equal(status2.preset, 'qwen3-embedding:0.6b')
      assert.equal(status2.port, 8911)
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  it('one-click deploys llama-server and GGUF model via nightly pointer and hf-mirror', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'mnemo-local-embed-deploy-'))
    try {
      const zipBytes = zipSync({
        'llama-b11000/llama-server.exe': new Uint8Array(Buffer.from('fake-llama-server-exe')),
      })
      const ggufBytes = Buffer.from('GGUF-FAKE-MODEL-BYTES')
      const fetchImpl = async url => {
        const href = String(url)
        if (href.includes('/releases?per_page=')) {
          return new Response(JSON.stringify([{
            tag_name: 'v0.4.1',
            assets: [{ name: 'nightly-tag.txt', browser_download_url: 'https://example.test/nightly-tag.txt' }],
          }]), { status: 200 })
        }
        if (href === 'https://example.test/nightly-tag.txt') {
          return new Response('b11000\n', { status: 200 })
        }
        if (href.includes('/releases/tags/b11000')) {
          return new Response(JSON.stringify({
            tag_name: 'b11000',
            assets: [{ name: 'llama-b11000-bin-win-cpu-x64.zip', browser_download_url: 'https://example.test/llama.zip' }],
          }), { status: 200 })
        }
        if (href === 'https://example.test/llama.zip') {
          return new Response(zipBytes, { status: 200 })
        }
        if (href.includes('Qwen3-Embedding-0.6B-Q8_0.gguf')) {
          return new Response(ggufBytes, { status: 200, headers: { 'content-length': String(ggufBytes.byteLength) } })
        }
        return new Response('not found', { status: 404 })
      }

      const config = resolveEmbedding({
        enabled: true,
        runtime: 'llama-cpp',
        localPreset: 'qwen3-embedding:0.6b',
        lifecycle: 'on-demand',
        localDevice: 'cpu',
      })

      const result = await deployLocalEmbeddingRuntime(config, {
        rootDir,
        fetchImpl,
        probeHealth: async () => false,
        platform: 'win32',
        arch: 'x64',
      })

      assert.equal(result.downloadedServer, true)
      assert.equal(result.downloadedModel, true)
      assert.equal(result.status.serverInstalled, true)
      assert.equal(result.status.modelInstalled, true)
      assert.ok(existsSync(join(rootDir, 'bin', 'llama-server.exe')))
      assert.equal(readFileSync(join(rootDir, 'models', 'Qwen3-Embedding-0.6B-Q8_0.gguf'), 'utf8'), 'GGUF-FAKE-MODEL-BYTES')

      const inspected = await inspectLocalEmbeddingRuntime(config, {
        rootDir,
        probeHealth: async () => false,
        platform: 'win32',
      })
      assert.equal(inspected.serverInstalled, true)
      assert.equal(inspected.modelInstalled, true)
      assert.equal(inspected.presets.find(p => p.id === 'qwen3-embedding:0.6b')?.installed, true)
      assert.equal(inspected.presets.find(p => p.id === 'qwen3-embedding:4b')?.installed, false)
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  it('supports on-demand, resident, and write-first-fill-later lifecycle strategies', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'mnemo-local-embed-lifecycle-'))
    try {
      mkdirSync(join(rootDir, 'bin'), { recursive: true })
      mkdirSync(join(rootDir, 'models'), { recursive: true })
      const exeName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
      writeFileSync(join(rootDir, 'bin', exeName), 'fake-bin')
      writeFileSync(join(rootDir, 'models', 'Qwen3-Embedding-0.6B-Q8_0.gguf'), 'fake-gguf')

      let spawnCount = 0
      let serverUp = false
      const manager = new LocalEmbeddingServerManager({
        rootDir,
        probeHealth: async () => serverUp,
        spawnImpl: () => {
          spawnCount += 1
          const child = createFakeChild()
          serverUp = true
          child.once('exit', () => { serverUp = false })
          return child
        },
      })

      // 1. on-demand: starts before call and stops after call
      const onDemandConfig = resolveEmbedding({
        enabled: true, runtime: 'llama-cpp', localPreset: 'qwen3-embedding:0.6b', lifecycle: 'on-demand', localDevice: 'cpu',
      })
      const endpoint1 = await manager.withServer(onDemandConfig, 'write-or-search', async ep => {
        assert.equal(serverUp, true)
        return ep
      })
      assert.equal(endpoint1, 'http://127.0.0.1:8911/v1')
      assert.equal(spawnCount, 1)
      assert.equal(serverUp, false)

      // 2. resident: starts once and stays running across calls until explicit stop()
      const residentConfig = resolveEmbedding({
        enabled: true, runtime: 'llama-cpp', localPreset: 'qwen3-embedding:0.6b', lifecycle: 'resident', localDevice: 'cpu',
      })
      await manager.withServer(residentConfig, 'write-or-search', async ep => {
        assert.equal(ep, 'http://127.0.0.1:8911/v1')
      })
      assert.equal(spawnCount, 2)
      assert.equal(serverUp, true)
      await manager.withServer(residentConfig, 'write-or-search', async ep => {
        assert.equal(ep, 'http://127.0.0.1:8911/v1')
      })
      assert.equal(spawnCount, 2)
      assert.equal(serverUp, true)
      await manager.stop()
      assert.equal(serverUp, false)

      // 3. write-first-fill-later: skips startup on write/search, starts+stops on embed
      const writeFirstConfig = resolveEmbedding({
        enabled: true, runtime: 'llama-cpp', localPreset: 'qwen3-embedding:0.6b', lifecycle: 'write-first-fill-later', localDevice: 'cpu',
      })
      const writeEp = await manager.withServer(writeFirstConfig, 'write-or-search', async ep => ep)
      assert.equal(writeEp, undefined)
      assert.equal(spawnCount, 2)
      assert.equal(serverUp, false)

      const embedEp = await manager.withServer(writeFirstConfig, 'embed', async ep => {
        assert.equal(serverUp, true)
        return ep
      })
      assert.equal(embedEp, 'http://127.0.0.1:8911/v1')
      assert.equal(spawnCount, 3)
      assert.equal(serverUp, false)
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })
})
