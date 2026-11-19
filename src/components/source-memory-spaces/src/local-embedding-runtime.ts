import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { unzipSync } from 'fflate'
import {
  DEFAULT_LOCAL_EMBEDDING_DEVICE,
  DEFAULT_LOCAL_EMBEDDING_LIFECYCLE,
  DEFAULT_LOCAL_EMBEDDING_PRESET,
  type LocalEmbeddingDeployResult,
  type LocalEmbeddingDevice,
  type LocalEmbeddingLifecycle,
  type LocalEmbeddingPreset,
  type LocalEmbeddingPresetStatus,
  type LocalEmbeddingRuntimeStatus,
  type ResolvedMnemonEmbeddingConfig,
} from './contracts.ts'

export interface LocalEmbeddingPresetSpec {
  readonly id: LocalEmbeddingPreset
  readonly label: string
  readonly fileName: string
  readonly defaultPort: number
  readonly url: string
}

const GGUF_MIRROR_BASE = 'https://hf-mirror.com'

export const LOCAL_EMBEDDING_PRESET_SPECS: Readonly<Record<LocalEmbeddingPreset, LocalEmbeddingPresetSpec>> = {
  'qwen3-embedding:0.6b': {
    id: 'qwen3-embedding:0.6b',
    label: 'Qwen3-Embedding-0.6B (Q8_0)',
    fileName: 'Qwen3-Embedding-0.6B-Q8_0.gguf',
    defaultPort: 8911,
    url: `${GGUF_MIRROR_BASE}/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf`,
  },
  'qwen3-embedding:4b': {
    id: 'qwen3-embedding:4b',
    label: 'Qwen3-Embedding-4B (Q4_K_M)',
    fileName: 'Qwen3-Embedding-4B-Q4_K_M.gguf',
    defaultPort: 8912,
    url: `${GGUF_MIRROR_BASE}/Qwen/Qwen3-Embedding-4B-GGUF/resolve/main/Qwen3-Embedding-4B-Q4_K_M.gguf`,
  },
}

const LLAMA_RELEASES_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases'
const NIGHTLY_POINTER = 'nightly-tag.txt'
const HEALTH_POLL_INTERVAL_MS = 250
const DEFAULT_STARTUP_TIMEOUT_MS = 90_000
const DEFAULT_HEALTH_TIMEOUT_MS = 1_500

export type LocalEmbeddingOperationKind = 'write-or-search' | 'embed'

export interface LocalEmbeddingRuntimeOptions {
  rootDir?: string
  fetchImpl?: typeof fetch
  spawnImpl?: typeof spawn
  probeHealth?: (port: number, signal?: AbortSignal) => Promise<boolean>
  startupTimeoutMs?: number
  platform?: NodeJS.Platform
  arch?: string
}

interface PortSentinel {
  preset: LocalEmbeddingPreset
  port: number
  pid: number
  modelPath: string
  startedAt: string
}

interface ManagedServer {
  preset: LocalEmbeddingPreset
  port: number
  process: ChildProcess
}

export function localEmbeddingRootDir(override?: string): string {
  return override ?? (process.env.MNEMO_LOCAL_EMBEDDING_DIR?.trim() || join(homedir(), '.mnemon', 'local-embedding'))
}

export function localEmbeddingBinDir(rootDir: string): string {
  return join(rootDir, 'bin')
}

export function localEmbeddingModelsDir(rootDir: string): string {
  return join(rootDir, 'models')
}

function localEmbeddingStateDir(rootDir: string): string {
  return join(rootDir, 'state')
}

function serverBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'llama-server.exe' : 'llama-server'
}

function normalizePreset(preset: LocalEmbeddingPreset | undefined): LocalEmbeddingPreset {
  return preset !== undefined && Object.hasOwn(LOCAL_EMBEDDING_PRESET_SPECS, preset)
    ? preset
    : DEFAULT_LOCAL_EMBEDDING_PRESET
}

export function resolveLocalEmbeddingPort(config: Pick<ResolvedMnemonEmbeddingConfig, 'localPreset' | 'localPort'>): number {
  const preset = normalizePreset(config.localPreset)
  return config.localPort ?? LOCAL_EMBEDDING_PRESET_SPECS[preset].defaultPort
}

export function localEmbeddingEndpoint(port: number): string {
  return `http://127.0.0.1:${port}/v1`
}

export function resolveLocalModelPath(preset: LocalEmbeddingPreset | undefined, rootDir = localEmbeddingRootDir()): string {
  return join(localEmbeddingModelsDir(rootDir), LOCAL_EMBEDDING_PRESET_SPECS[normalizePreset(preset)].fileName)
}

function safeExists(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

function findOnPath(binary: string): string | undefined {
  const pathEnv = process.env.PATH ?? ''
  for (const dir of pathEnv.split(delimiter)) {
    const trimmed = dir.trim().replace(/^"+|"+$/gu, '')
    if (!trimmed) continue
    const candidate = join(trimmed, binary)
    if (safeExists(candidate)) return candidate
  }
  return undefined
}

export function resolveLlamaServerPath(
  config: Pick<ResolvedMnemonEmbeddingConfig, 'llamaServerPath'>,
  rootDir = localEmbeddingRootDir(),
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const explicit = config.llamaServerPath?.trim()
  if (explicit && safeExists(explicit)) return explicit
  const managed = join(localEmbeddingBinDir(rootDir), serverBinaryName(platform))
  if (safeExists(managed)) return managed
  return findOnPath(serverBinaryName(platform))
}

function sentinelPath(port: number, rootDir: string): string {
  return join(localEmbeddingStateDir(rootDir), `port_${port}.json`)
}

function readSentinel(port: number, rootDir: string): PortSentinel | undefined {
  const path = sentinelPath(port, rootDir)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PortSentinel
  } catch {
    return undefined
  }
}

function writeSentinel(sentinel: PortSentinel, rootDir: string): void {
  const dir = localEmbeddingStateDir(rootDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(sentinelPath(sentinel.port, rootDir), JSON.stringify(sentinel, null, 2), 'utf8')
}

function clearSentinel(port: number, rootDir: string): void {
  try {
    rmSync(sentinelPath(port, rootDir), { force: true })
  } catch {
    // Best-effort cleanup.
  }
}

export async function probeLlamaServerHealth(
  port: number,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_HEALTH_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: controller.signal })
    return response.status === 200
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

let cachedGpuAvailable: Map<string, boolean> = new Map()

export function resolveLocalNgl(device: LocalEmbeddingDevice, serverPath: string): number {
  if (device === 'cpu') return 0
  if (device === 'gpu') return 99
  const cached = cachedGpuAvailable.get(serverPath)
  if (cached !== undefined) return cached ? 99 : 0
  try {
    const probe = spawnSync(serverPath, ['--list-devices'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    })
    const output = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`
    const hasGpu = /CUDA|Vulkan|Metal/iu.test(output)
    cachedGpuAvailable.set(serverPath, hasGpu)
    return hasGpu ? 99 : 0
  } catch {
    cachedGpuAvailable.set(serverPath, false)
    return 0
  }
}

export function buildLlamaEmbeddingArgs(modelPath: string, port: number, ngl: number): string[] {
  return [
    '-m', modelPath,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--embedding',
    '--pooling', 'last',
    '-ngl', String(ngl),
    '-c', '8192',
    '-ub', '2048',
  ]
}

function presetStatuses(rootDir: string): LocalEmbeddingPresetStatus[] {
  return (Object.values(LOCAL_EMBEDDING_PRESET_SPECS) as LocalEmbeddingPresetSpec[]).map(spec => {
    const path = join(localEmbeddingModelsDir(rootDir), spec.fileName)
    if (!existsSync(path)) {
      return { id: spec.id, label: spec.label, fileName: spec.fileName, installed: false }
    }
    const sizeBytes = statSync(path).size
    return { id: spec.id, label: spec.label, fileName: spec.fileName, installed: true, sizeBytes }
  })
}

export async function inspectLocalEmbeddingRuntime(
  config: Pick<ResolvedMnemonEmbeddingConfig, 'localPreset' | 'lifecycle' | 'localDevice' | 'localPort' | 'llamaServerPath'>,
  options: LocalEmbeddingRuntimeOptions = {},
): Promise<LocalEmbeddingRuntimeStatus> {
  const rootDir = localEmbeddingRootDir(options.rootDir)
  const platform = options.platform ?? process.platform
  const preset = normalizePreset(config.localPreset)
  const lifecycle = config.lifecycle ?? DEFAULT_LOCAL_EMBEDDING_LIFECYCLE
  const device = config.localDevice ?? DEFAULT_LOCAL_EMBEDDING_DEVICE
  const port = resolveLocalEmbeddingPort({ localPreset: preset, ...(config.localPort === undefined ? {} : { localPort: config.localPort }) })
  const serverPath = resolveLlamaServerPath(config, rootDir, platform)
  const modelPath = resolveLocalModelPath(preset, rootDir)
  const modelInstalled = safeExists(modelPath)
  const modelSizeBytes = modelInstalled ? statSync(modelPath).size : undefined
  const probe = options.probeHealth ?? ((p, sig) => probeLlamaServerHealth(p, options.fetchImpl ?? fetch, sig))
  const healthy = await probe(port)
  const sentinel = readSentinel(port, rootDir)
  const running = healthy && (sentinel === undefined || sentinel.preset === preset)
  return {
    preset,
    lifecycle,
    device,
    port,
    endpoint: localEmbeddingEndpoint(port),
    serverInstalled: serverPath !== undefined,
    ...(serverPath === undefined ? {} : { serverPath }),
    modelInstalled,
    modelPath,
    ...(modelSizeBytes === undefined ? {} : { modelSizeBytes }),
    running,
    healthy,
    presets: presetStatuses(rootDir),
  }
}

interface GithubReleaseAsset {
  name: string
  browser_download_url: string
}

interface GithubRelease {
  tag_name: string
  assets?: GithubReleaseAsset[]
}

function selectLlamaAssetPattern(platform: NodeJS.Platform, arch: string): RegExp {
  if (platform === 'win32') return /^llama-.*-bin-win-cpu-x64\.zip$/iu
  if (platform === 'darwin') return arch === 'arm64' ? /^llama-.*-bin-macos-arm64\.(zip|tar\.gz)$/iu : /^llama-.*-bin-macos-x64\.(zip|tar\.gz)$/iu
  return /^llama-.*-bin-ubuntu-x64\.(zip|tar\.gz)$/iu
}

async function fetchJson<T>(url: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<T> {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'MnemoWeave', Accept: 'application/vnd.github+json' },
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`)
  return await response.json() as T
}

async function downloadLlamaServerBinary(
  rootDir: string,
  fetchImpl: typeof fetch,
  platform: NodeJS.Platform,
  arch: string,
  signal?: AbortSignal,
): Promise<string> {
  const releases = await fetchJson<GithubRelease[]>(`${LLAMA_RELEASES_API}?per_page=10`, fetchImpl, signal)
  const pattern = selectLlamaAssetPattern(platform, arch)
  let asset: GithubReleaseAsset | undefined
  let tag = ''

  for (const release of releases) {
    const direct = release.assets?.find(candidate => pattern.test(candidate.name))
    if (direct !== undefined) {
      asset = direct
      tag = release.tag_name
      break
    }
    // Two-step nightly pointer lookup (matching auto_summary/integration/llama_install.py).
    const pointer = release.assets?.find(candidate => candidate.name === NIGHTLY_POINTER)
    if (pointer !== undefined) {
      const pointerRes = await fetchImpl(pointer.browser_download_url, {
        headers: { 'User-Agent': 'MnemoWeave' },
        ...(signal === undefined ? {} : { signal }),
      })
      if (pointerRes.ok) {
        const nightlyTag = (await pointerRes.text()).trim()
        if (nightlyTag !== '') {
          const nightly = await fetchJson<GithubRelease>(`${LLAMA_RELEASES_API}/tags/${encodeURIComponent(nightlyTag)}`, fetchImpl, signal)
          const nightlyAsset = nightly.assets?.find(candidate => pattern.test(candidate.name))
          if (nightlyAsset !== undefined) {
            asset = nightlyAsset
            tag = nightly.tag_name
            break
          }
        }
      }
    }
  }

  if (asset === undefined) {
    throw new Error(`Unable to locate a compatible llama.cpp release asset for ${platform}/${arch}`)
  }

  const archiveRes = await fetchImpl(asset.browser_download_url, {
    headers: { 'User-Agent': 'MnemoWeave' },
    ...(signal === undefined ? {} : { signal }),
  })
  if (!archiveRes.ok) throw new Error(`Failed to download ${asset.name}: HTTP ${archiveRes.status}`)
  const bytes = new Uint8Array(await archiveRes.arrayBuffer())
  if (!asset.name.toLowerCase().endsWith('.zip')) {
    throw new Error(`Unsupported llama.cpp archive format: ${asset.name}. Please install llama-server manually and set llamaServerPath.`)
  }

  const binDir = localEmbeddingBinDir(rootDir)
  mkdirSync(binDir, { recursive: true })
  const entries = unzipSync(bytes)
  for (const [entryPath, content] of Object.entries(entries)) {
    if (entryPath.endsWith('/') || content.length === 0) continue
    const fileName = basename(entryPath)
    if (!fileName) continue
    const target = join(binDir, fileName)
    writeFileSync(target, content, { mode: platform === 'win32' ? 0o666 : 0o755 })
  }

  const exePath = join(binDir, serverBinaryName(platform))
  if (!existsSync(exePath)) {
    throw new Error(`Extracted ${asset.name}, but ${serverBinaryName(platform)} was not found`)
  }
  writeFileSync(join(rootDir, 'installed.json'), JSON.stringify({
    tag,
    asset: asset.name,
    platform,
    arch,
    installedAt: new Date().toISOString(),
  }, null, 2), 'utf8')
  return exePath
}

async function downloadFileResumable(
  url: string,
  targetPath: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<void> {
  mkdirSync(dirname(targetPath), { recursive: true })
  const partPath = `${targetPath}.part`
  let resumeFrom = existsSync(partPath) ? statSync(partPath).size : 0
  const headers: Record<string, string> = { 'User-Agent': 'MnemoWeave' }
  if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`

  const response = await fetchImpl(url, {
    headers,
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok && response.status !== 206) {
    throw new Error(`Failed to download ${basename(targetPath)}: HTTP ${response.status}`)
  }
  if (resumeFrom > 0 && response.status !== 206) {
    resumeFrom = 0
  }
  const contentLengthHeader = response.headers.get('content-length')
  const expectedTotal = contentLengthHeader !== null ? resumeFrom + Number(contentLengthHeader) : undefined
  if (response.body === null) throw new Error(`Empty response body downloading ${basename(targetPath)}`)

  let written = 0
  const stream = createWriteStream(partPath, { flags: resumeFrom > 0 ? 'a' : 'w' })
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      written += value.byteLength
      if (!stream.write(value)) {
        await new Promise<void>(resolve => stream.once('drain', resolve))
      }
    }
    await new Promise<void>((resolve, reject) => {
      stream.end(() => resolve())
      stream.once('error', reject)
    })
  } catch (error) {
    stream.destroy()
    throw error
  } finally {
    reader.releaseLock()
  }

  if (expectedTotal !== undefined && Number.isFinite(expectedTotal) && resumeFrom + written !== expectedTotal) {
    throw new Error(`Incomplete download for ${basename(targetPath)}: got ${resumeFrom + written} of ${expectedTotal} bytes`)
  }
  renameSync(partPath, targetPath)
}

export async function deployLocalEmbeddingRuntime(
  config: Pick<ResolvedMnemonEmbeddingConfig, 'localPreset' | 'lifecycle' | 'localDevice' | 'localPort' | 'llamaServerPath'>,
  options: LocalEmbeddingRuntimeOptions = {},
  signal?: AbortSignal,
): Promise<LocalEmbeddingDeployResult> {
  const rootDir = localEmbeddingRootDir(options.rootDir)
  const fetchImpl = options.fetchImpl ?? fetch
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch

  let downloadedServer = false
  let downloadedModel = false

  if (resolveLlamaServerPath(config, rootDir, platform) === undefined) {
    await downloadLlamaServerBinary(rootDir, fetchImpl, platform, arch, signal)
    downloadedServer = true
  }

  const preset = normalizePreset(config.localPreset)
  const spec = LOCAL_EMBEDDING_PRESET_SPECS[preset]
  const modelPath = resolveLocalModelPath(preset, rootDir)
  if (!existsSync(modelPath)) {
    await downloadFileResumable(spec.url, modelPath, fetchImpl, signal)
    downloadedModel = true
  }

  const status = await inspectLocalEmbeddingRuntime(config, options)
  return { status, downloadedServer, downloadedModel }
}

export class LocalEmbeddingServerManager {
  private readonly managed = new Map<number, ManagedServer>()
  private readonly starting = new Map<number, Promise<{ endpoint: string; startedByUs: boolean }>>()
  private readonly options: LocalEmbeddingRuntimeOptions
  private exitHookRegistered = false

  constructor(options: LocalEmbeddingRuntimeOptions = {}) {
    this.options = options
  }

  private registerExitHook(): void {
    if (this.exitHookRegistered) return
    this.exitHookRegistered = true
    process.once('exit', () => {
      for (const entry of this.managed.values()) {
        try { entry.process.kill() } catch { /* ignore */ }
      }
      this.managed.clear()
    })
  }

  private rootDir(): string {
    return localEmbeddingRootDir(this.options.rootDir)
  }

  private async probe(port: number, signal?: AbortSignal): Promise<boolean> {
    if (this.options.probeHealth !== undefined) return this.options.probeHealth(port, signal)
    return probeLlamaServerHealth(port, this.options.fetchImpl ?? fetch, signal)
  }

  async start(
    config: Pick<ResolvedMnemonEmbeddingConfig, 'localPreset' | 'localDevice' | 'localPort' | 'llamaServerPath'>,
    signal?: AbortSignal,
  ): Promise<{ endpoint: string; startedByUs: boolean }> {
    const port = resolveLocalEmbeddingPort(config)
    const pending = this.starting.get(port)
    if (pending !== undefined) return pending

    const run = this.startInternal(config, port, signal).finally(() => {
      if (this.starting.get(port) === run) this.starting.delete(port)
    })
    this.starting.set(port, run)
    return run
  }

  private async startInternal(
    config: Pick<ResolvedMnemonEmbeddingConfig, 'localPreset' | 'localDevice' | 'localPort' | 'llamaServerPath'>,
    port: number,
    signal?: AbortSignal,
  ): Promise<{ endpoint: string; startedByUs: boolean }> {
    const rootDir = this.rootDir()
    const platform = this.options.platform ?? process.platform
    const endpoint = localEmbeddingEndpoint(port)

    if (await this.probe(port, signal)) {
      const sentinel = readSentinel(port, rootDir)
      if (sentinel === undefined || sentinel.preset === config.localPreset) {
        return { endpoint, startedByUs: false }
      }
      if (this.managed.has(port)) {
        await this.stop(port)
      } else {
        throw new Error(`Port ${port} is already occupied by another llama-server running preset ${sentinel.preset}`)
      }
    }

    const serverPath = resolveLlamaServerPath(config, rootDir, platform)
    if (serverPath === undefined) {
      throw new Error('Local llama-server binary is not installed. Run one-click deployment in Memory Spaces settings first.')
    }
    const modelPath = resolveLocalModelPath(config.localPreset, rootDir)
    if (!existsSync(modelPath)) {
      throw new Error(`Local GGUF model ${basename(modelPath)} is not downloaded. Run one-click deployment in Memory Spaces settings first.`)
    }

    const ngl = resolveLocalNgl(config.localDevice, serverPath)
    const args = buildLlamaEmbeddingArgs(modelPath, port, ngl)
    const spawnImpl = this.options.spawnImpl ?? spawn
    const child = spawnImpl(serverPath, args, {
      cwd: dirname(serverPath),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    this.registerExitHook()
    const logs: string[] = []
    const collect = (chunk: Buffer | string) => {
      const line = String(chunk).trim()
      if (line) {
        logs.push(line)
        if (logs.length > 40) logs.shift()
      }
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    let exited: string | undefined
    child.once('exit', (code, sig) => {
      exited = `llama-server exited early (code=${String(code)}, signal=${String(sig)})`
      if (this.managed.get(port)?.process === child) {
        this.managed.delete(port)
        clearSentinel(port, rootDir)
      }
    })
    child.once('error', error => {
      exited = `llama-server failed to start: ${error.message}`
      if (this.managed.get(port)?.process === child) {
        this.managed.delete(port)
        clearSentinel(port, rootDir)
      }
    })

    this.managed.set(port, { preset: config.localPreset, port, process: child })

    const deadline = Date.now() + (this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        await this.stop(port)
        throw new Error('Local llama-server startup aborted')
      }
      if (exited !== undefined) {
        await this.stop(port)
        const tail = logs.slice(-5).join(' | ')
        throw new Error(tail ? `${exited}: ${tail}` : exited)
      }
      if (await this.probe(port, signal)) {
        writeSentinel({
          preset: config.localPreset,
          port,
          pid: child.pid ?? 0,
          modelPath,
          startedAt: new Date().toISOString(),
        }, rootDir)
        return { endpoint, startedByUs: true }
      }
      await new Promise(resolve => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS))
    }

    await this.stop(port)
    throw new Error(`Timed out waiting for local llama-server on port ${port} to become healthy`)
  }

  async stop(port?: number): Promise<void> {
    const rootDir = this.rootDir()
    const targets = port === undefined ? [...this.managed.keys()] : [port]
    await Promise.all(targets.map(async targetPort => {
      const entry = this.managed.get(targetPort)
      this.managed.delete(targetPort)
      clearSentinel(targetPort, rootDir)
      if (entry === undefined) return
      const child = entry.process
      if (child.exitCode !== null || child.killed) return
      await new Promise<void>(resolve => {
        const killTimer = setTimeout(() => {
          try { child.kill('SIGKILL') } catch { /* ignore */ }
          resolve()
        }, 5_000)
        child.once('exit', () => {
          clearTimeout(killTimer)
          resolve()
        })
        try {
          child.kill('SIGTERM')
        } catch {
          clearTimeout(killTimer)
          resolve()
        }
      })
    }))
  }

  async withServer<T>(
    config: ResolvedMnemonEmbeddingConfig,
    operationKind: LocalEmbeddingOperationKind,
    fn: (endpoint: string | undefined) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!config.enabled || config.runtime !== 'llama-cpp') {
      return fn(undefined)
    }

    const lifecycle: LocalEmbeddingLifecycle = config.lifecycle
    const port = resolveLocalEmbeddingPort(config)

    if (lifecycle === 'write-first-fill-later' && operationKind === 'write-or-search') {
      if (this.managed.has(port)) await this.stop(port)
      return fn(undefined)
    }

    const { endpoint, startedByUs } = await this.start(config, signal)
    try {
      return await fn(endpoint)
    } finally {
      if (startedByUs && lifecycle !== 'resident') {
        await this.stop(port)
      }
    }
  }
}

export const defaultLocalEmbeddingManager = new LocalEmbeddingServerManager()
