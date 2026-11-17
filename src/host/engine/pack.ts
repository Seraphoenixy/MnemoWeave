import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped, type Zippable } from 'fflate'
import type { ResolvedConfig } from '../configuration/config.ts'
import {
  DOCUMENTS_ACTIVE_LIMIT_BYTES, DOCUMENTS_DIRECTORY, DOCUMENTS_INDEX_FILE, DOCUMENTS_LOCK_FILE, DOCUMENTS_LOCK_STALE_MS, DOCUMENT_FILENAME_PATTERN,
  parseDocumentIndex, type DocumentIndex, type DocumentRecord,
} from 'dsh-mnemo-weave/source-documents/contracts'
import {
  MEMORY_SPACE_DATABASE_FILE, MEMORY_SPACE_ID_PATTERN, MEMORY_SPACE_NAME_MAX_LENGTH, MEMORY_SPACE_REGISTRY_FILE, MEMORY_SPACES_DIRECTORY, MNEMON_ACTIVE_STORE_FILE,
  parseMemorySpaceRegistry, type MemorySpaceRegistryEntry, type MemorySpaceRegistryFile,
} from 'dsh-mnemo-weave/source-memory-spaces/contracts'
import { MemorySpaceIdentity } from '../../components/source-memory-spaces/src/space-identity.ts'
import {
  RUNTIME_ARCHIVE_DIRECTORY, RUNTIME_DIRECTORY, RUNTIME_ENTRY_MAX_BYTES, RUNTIME_LOCK_FILE, RUNTIME_LOCK_STALE_MS, RUNTIME_MEMORIES_FILE,
  RUNTIME_MEMORY_LIMITS, RUNTIME_MEMORY_VERSION, RUNTIME_PROJECTION_FILES,
  parseRuntimeBranches, runtimeBytes, runtimeProjection, assertRuntimePinnedBudget, type RuntimeMemoryEntry, type RuntimeMemoryLimits, type RuntimeMemoryTarget,
} from 'dsh-mnemo-weave/source-runtime/contracts'
import { createStorageRoot, type StorageRoot } from './storage-root.ts'
import { MNEMON_PACK_COMPONENTS, type MnemonEntryOrigin, type MnemonMachineIdentity, type MnemonPackComponent, type MnemonPackComponentSummary, type MnemonPackExport, type MnemonPackImportMode, type MnemonPackImportResult, type MnemonPackManifest, type MnemonPackPreview, type MnemonPackScope, type MnemonPackTarget, type MnemonRuntimeMergeReport } from "../contracts/protocol.ts"
import { MnemonMachineStore } from '../support/machine-identity.ts'
import { pluginPackageVersion } from '../surface/version-updates.ts'

export type { MnemonPackComponent, MnemonPackComponentSummary, MnemonPackExport, MnemonPackImportMode, MnemonPackImportResult, MnemonPackManifest, MnemonPackPreview, MnemonPackScope } from "../contracts/protocol.ts"

export type { StoredRuntimeEntry, RuntimeFile, DocumentIndex }


export const MNEMON_PACK_FORMAT = 'mnemonpack'
export const MNEMON_PACK_VERSION = 1
export const MNEMON_PACK_MIME = 'application/zip'
export const MNEMON_PACK_MAX_ARCHIVE_BYTES = 48 * 1024 * 1024
export const MNEMON_PACK_MAX_EXPANDED_BYTES = 256 * 1024 * 1024

const MAX_FILE_BYTES = 128 * 1024 * 1024
const MAX_FILES = 4096
const LOCK_TIMEOUT_MS = 5_000
const LOCK_STALE_MS = 30_000
const LOCK_RETRY_MS = 20
/**
 * Each component's directory under the data directory, as its Source names it. A Pack carries a
 * component's data files (memories and projections, the index and documents, the registry and
 * stores, never a lock, the local archive or a write-ahead log) under `payload/` at the paths they
 * have there, so these names and the Sources' file names spell the Pack's entries too;
 * they are the entries 0.5.24 accepts, and must stay those.
 */
const COMPONENT_DIRECTORIES = { runtime: RUNTIME_DIRECTORY, documents: DOCUMENTS_DIRECTORY, 'memory-spaces': MEMORY_SPACES_DIRECTORY } as const
export const RUNTIME_MEMORIES_PATH = `payload/${RUNTIME_DIRECTORY}/${RUNTIME_MEMORIES_FILE}`
const RUNTIME_PROJECTION_PATHS = {
  user: `payload/${RUNTIME_DIRECTORY}/${RUNTIME_PROJECTION_FILES.user}`,
  memory: `payload/${RUNTIME_DIRECTORY}/${RUNTIME_PROJECTION_FILES.memory}`,
} as const satisfies Record<RuntimeMemoryTarget, string>
export const DOCUMENTS_INDEX_PATH = `payload/${DOCUMENTS_DIRECTORY}/${DOCUMENTS_INDEX_FILE}`
const MEMORY_SPACE_REGISTRY_PATH = `payload/${MEMORY_SPACES_DIRECTORY}/${MEMORY_SPACE_REGISTRY_FILE}`
const COMPONENT_ORDER = MNEMON_PACK_COMPONENTS
/**
 * Every content hash this format writes is `sha256(...)` in hex, so one rule decides the shape.
 * The digest of a Runtime entry's text and the digest of a Document's body are the same kind of
 * value, and a second, drifting copy of the rule is how one of them ends up unchecked.
 */
const CONTENT_HASH = /^[a-f0-9]{64}$/u
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'binary')

interface ChecksumFile {
  algorithm: 'sha256'
  files: Record<string, string>
}

interface ParsedPack {
  archiveBytes: number
  expandedBytes: number
  files: Unzipped
  manifest: MnemonPackManifest
}

/**
 * A stored entry may carry fields this Host does not own: the machine that wrote it,
 * and whatever a newer version adds. They round-trip through the Pack untouched.
 */
type StoredRuntimeEntry = RuntimeMemoryEntry & { origin?: MnemonEntryOrigin }

interface RuntimeFile {
  version: 1
  entries: StoredRuntimeEntry[]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function utf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${label} is not valid UTF-8`)
  }
}

function json(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(utf8(bytes, label)) as unknown
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON`)
    throw error
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function safeArchivePath(path: string): void {
  if (path === '' || path.length > 512 || path.includes('\0') || path.includes('\\') || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
    throw new Error(`unsafe Pack entry path: ${JSON.stringify(path)}`)
  }
  const parts = path.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) throw new Error(`unsafe Pack entry path: ${JSON.stringify(path)}`)
}

/** Where one component's files sit in a Pack; the sync channel compares a component's files by it. */
export function payloadPrefix(component: MnemonPackComponent): string {
  return `payload/${COMPONENT_DIRECTORIES[component]}/`
}

/** The path segments below a component's payload directory, or nothing for a path outside it. */
function payloadSegments(path: string, component: MnemonPackComponent): string[] | undefined {
  const prefix = payloadPrefix(component)
  return path.startsWith(prefix) ? path.slice(prefix.length).split('/') : undefined
}

function databasePayloadPath(id: string): string {
  return `${payloadPrefix('memory-spaces')}${id}/${MEMORY_SPACE_DATABASE_FILE}`
}

function payloadComponent(path: string): MnemonPackComponent | undefined {
  return COMPONENT_ORDER.find(component => path.startsWith(payloadPrefix(component)))
}

/**
 * The exact entry list a Pack may hold, kept deliberately identical to the list
 * version 0.5.24 accepts: a backup written here opens there, and one written
 * there opens here. A file this list does not name is not "extra data", it is a
 * Pack the other side refuses outright, so machine-local state (deletions, the
 * machine identity) travels over the sync channel instead of inside an archive.
 */
function allowedPayloadPath(path: string): boolean {
  if (path === RUNTIME_MEMORIES_PATH || path === RUNTIME_PROJECTION_PATHS.user || path === RUNTIME_PROJECTION_PATHS.memory) return true
  if (path === DOCUMENTS_INDEX_PATH) return true
  const document = payloadSegments(path, 'documents')
  if (document?.length === 2 && (document[0] === 'active' || document[0] === 'archived') && DOCUMENT_FILENAME_PATTERN.test(document[1]!)) return true
  if (path === MEMORY_SPACE_REGISTRY_PATH) return true
  const space = payloadSegments(path, 'memory-spaces')
  return space?.length === 2 && MEMORY_SPACE_ID_PATTERN.test(space[0]!) && space[1] === MEMORY_SPACE_DATABASE_FILE
}

function componentsForScope(scope: MnemonPackScope): MnemonPackComponent[] {
  if (scope === 'full') return [...COMPONENT_ORDER]
  if (!COMPONENT_ORDER.includes(scope)) throw new Error('Mnemon Pack scope must be full, runtime, documents, or memory-spaces')
  return [scope]
}

/** Exported so the sync channel can read the manifest a commit holds without unpacking the archive. */
export function parseManifest(value: unknown): MnemonPackManifest {
  const manifest = record(value)
  if (manifest?.format !== MNEMON_PACK_FORMAT || manifest.version !== MNEMON_PACK_VERSION) throw new Error('unsupported Mnemon Pack format or version')
  if (manifest.scope !== 'full' && !COMPONENT_ORDER.includes(manifest.scope as MnemonPackComponent)) throw new Error('Mnemon Pack scope is invalid')
  if (typeof manifest.exportedAt !== 'string') throw new Error('Mnemon Pack exportedAt is invalid')
  if (!Array.isArray(manifest.components)) throw new Error('Mnemon Pack components are invalid')
  const components = manifest.components.map(String) as MnemonPackComponent[]
  if (components.length === 0 || new Set(components).size !== components.length || components.some(component => !COMPONENT_ORDER.includes(component))) {
    throw new Error('Mnemon Pack components are invalid')
  }
  const expected = componentsForScope(manifest.scope as MnemonPackScope)
  if (components.length !== expected.length || expected.some(component => !components.includes(component))) throw new Error('Mnemon Pack scope does not match its components')
  const source = record(manifest.source)
  if (source?.plugin !== 'dsh-mnemon' || typeof source.pluginVersion !== 'string') throw new Error('Mnemon Pack source is invalid')
  if (!Array.isArray(manifest.summary)) throw new Error('Mnemon Pack summary is invalid')
  const summary = manifest.summary.map((entry): MnemonPackComponentSummary => {
    const item = record(entry)
    const component = item?.component as MnemonPackComponent
    if (!COMPONENT_ORDER.includes(component) || !Number.isSafeInteger(item?.files) || !Number.isSafeInteger(item?.bytes) || !Number.isSafeInteger(item?.items)
      || Number(item?.files) < 0 || Number(item?.bytes) < 0 || Number(item?.items) < 0) {
      throw new Error('Mnemon Pack summary entry is invalid')
    }
    return { component, files: Number(item!.files), bytes: Number(item!.bytes), items: Number(item!.items) }
  })
  // Anything else the writer put in the manifest (a newer field, a sync channel's
  // own extension) is ignored rather than rejected: a reader has to open a Pack
  // written by a version it has never seen.
  return {
    format: MNEMON_PACK_FORMAT,
    version: MNEMON_PACK_VERSION,
    scope: manifest.scope as MnemonPackScope,
    exportedAt: manifest.exportedAt,
    source: { plugin: 'dsh-mnemon', pluginVersion: source.pluginVersion },
    components,
    summary,
  }
}

/** The sync channel reads its machine identity with this parser; no Pack carries one. */
export function parseMachineIdentity(value: unknown): MnemonMachineIdentity | undefined {
  if (value === undefined || value === null) return undefined
  const machine = record(value)
  if (typeof machine?.id !== 'string' || machine.id.trim() === '' || typeof machine.label !== 'string' || typeof machine.createdAt !== 'string') {
    throw new Error('Mnemon Pack machine identity is invalid')
  }
  return { id: machine.id, label: machine.label, createdAt: machine.createdAt }
}

function parseEntryOrigin(value: unknown): MnemonEntryOrigin | undefined {
  if (value === undefined || value === null) return undefined
  const origin = record(value)
  if (typeof origin?.machine !== 'string' || typeof origin.label !== 'string' || typeof origin.at !== 'string') return undefined
  return { machine: origin.machine, label: origin.label, at: origin.at }
}

/**
 * Whole groups of four from the base64 alphabet, padded with at most two `=` at the end. The
 * length check and one character class keep this a flat loop at any size. A pattern that repeats
 * a four-character group keeps a backtracking entry per group, and V8 threw "Maximum call stack
 * size exceeded" once a payload passed about 4.5 MB (#368). The `u` flag stays off: under it,
 * V8 13 (Node 24) does the same for a class over a string holding a character above U+00FF.
 */
function isBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)
}

function decodeArchive(base64: string): Buffer {
  if (typeof base64 !== 'string' || base64 === '' || base64.length > Math.ceil(MNEMON_PACK_MAX_ARCHIVE_BYTES / 3) * 4 + 4) throw new Error('Mnemon Pack archive is empty or too large')
  if (!isBase64(base64)) throw new Error('Mnemon Pack payload is not valid base64')
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length === 0 || bytes.length > MNEMON_PACK_MAX_ARCHIVE_BYTES) throw new Error('Mnemon Pack archive is empty or too large')
  return bytes
}

function parseArchive(base64: string, runtimeLimits: RuntimeMemoryLimits = RUNTIME_MEMORY_LIMITS): ParsedPack {
  const archive = decodeArchive(base64)
  let count = 0
  let expandedBytes = 0
  const files = unzipSync(archive, {
    filter(info) {
      safeArchivePath(info.name)
      if (info.name.endsWith('/')) return false
      count += 1
      expandedBytes += info.originalSize
      if (count > MAX_FILES) throw new Error(`Mnemon Pack contains more than ${MAX_FILES} files`)
      if (info.originalSize > MAX_FILE_BYTES || expandedBytes > MNEMON_PACK_MAX_EXPANDED_BYTES) throw new Error('Mnemon Pack expanded data exceeds the safety limit')
      return true
    },
  })
  const names = Object.keys(files)
  if (!names.includes('manifest.json') || !names.includes('checksums.json')) throw new Error('Mnemon Pack is missing manifest.json or checksums.json')
  for (const path of names) {
    safeArchivePath(path)
    if (path !== 'manifest.json' && path !== 'checksums.json' && !allowedPayloadPath(path)) throw new Error(`unsupported Mnemon Pack entry: ${path}`)
  }
  const manifest = parseManifest(json(files['manifest.json']!, 'manifest.json'))
  const checksumValue = record(json(files['checksums.json']!, 'checksums.json'))
  const checksumFiles = record(checksumValue?.files)
  if (checksumValue?.algorithm !== 'sha256' || checksumFiles === undefined) throw new Error('Mnemon Pack checksums are invalid')
  const payloadNames = names.filter(path => path.startsWith('payload/')).sort()
  if (Object.keys(checksumFiles).length !== payloadNames.length) throw new Error('Mnemon Pack checksum inventory does not match the payload')
  for (const path of payloadNames) {
    const component = payloadComponent(path)
    if (component === undefined || !manifest.components.includes(component)) throw new Error(`Mnemon Pack payload is outside its declared components: ${path}`)
    const expected = checksumFiles[path]
    if (typeof expected !== 'string' || expected !== sha256(files[path]!)) throw new Error(`Mnemon Pack checksum mismatch: ${path}`)
  }
  validatePackPayload(files, manifest.components, runtimeLimits)
  const actualSummary = summaryFor(manifest.components, files, runtimeLimits)
  return { archiveBytes: archive.length, expandedBytes, files, manifest: { ...manifest, summary: actualSummary } }
}

export function parseRuntime(value: unknown, limits: RuntimeMemoryLimits = RUNTIME_MEMORY_LIMITS): RuntimeFile {
  const source = record(value)
  if (source?.version !== RUNTIME_MEMORY_VERSION || !Array.isArray(source.entries)) throw new Error('runtime memories.json is invalid')
  const entries = source.entries.map((raw): RuntimeMemoryEntry => {
    const entry = record(raw)
    if (typeof entry?.content !== 'string' || (entry.target !== 'memory' && entry.target !== 'user') || !['critical', 'normal', 'low'].includes(String(entry.importance))) {
      throw new Error('runtime memories.json contains an invalid entry')
    }
    if (typeof entry.created_at !== 'string' || typeof entry.updated_at !== 'string') throw new Error('runtime memories.json contains invalid timestamps')
    if (entry.pinned !== undefined && typeof entry.pinned !== 'boolean') throw new Error('runtime memories.json contains invalid pin state')
    const content = entry.content.trim().replace(/\s+/gu, ' ')
    if (content === '' || content.includes('§') || Buffer.byteLength(content, 'utf8') > RUNTIME_ENTRY_MAX_BYTES) throw new Error('runtime memories.json contains invalid content')
    // A Pack carries provenance, not only text: the branch scope of a working-memory entry
    // and the machine that wrote it travel along. Each is read through its own rule, so a
    // malformed value from a damaged archive or another installation is dropped here instead
    // of reaching the runtime projection.
    const branches = entry.target === 'memory' ? parseRuntimeBranches(entry.branches) : undefined
    const origin = parseEntryOrigin(entry.origin)
    return {
      content, target: entry.target, importance: entry.importance as RuntimeMemoryEntry['importance'],
      created_at: entry.created_at, updated_at: entry.updated_at,
      ...(entry.pinned === undefined ? {} : { pinned: entry.pinned }),
      ...(branches === undefined ? {} : { branches }),
      ...(origin === undefined ? {} : { origin }),
    }
  })
  assertRuntimePinnedBudget(entries)
  for (const target of ['user', 'memory'] as const) {
    const used = runtimeBytes(entries, target)
    if (used > limits[target]) throw new Error(`runtime ${target} memory holds ${used} bytes and exceeds its ${limits[target]} byte limit`)
  }
  return { version: 1, entries }
}

function validDatabase(bytes: Uint8Array, path: string): void {
  if (bytes.length < 100 || !Buffer.from(bytes.subarray(0, SQLITE_HEADER.length)).equals(SQLITE_HEADER)) throw new Error(`${path} is not a SQLite ${MEMORY_SPACE_DATABASE_FILE}`)
}

/**
 * One document's payload entry, judged against the index that describes it.
 *
 * A document's body lives in its own file while its digest lives in `index.json`, so the two can
 * disagree while neither looks malformed: an index a person edited, a write that stopped halfway,
 * or a store an older version repaired by hand. The import path and the publish path judge that
 * pair by this one rule, so a payload this machine would refuse from another machine is never one
 * this machine produces. Reading the index does not judge the digest's shape: a ZIP backup reads
 * the same index, and a store that needs repair still has to download as one.
 */
function assertDocumentPayload(document: DocumentRecord, bytes: Uint8Array): void {
  if (!CONTENT_HASH.test(document.contentHash)) throw new Error(`Documents index records a content hash that is not a sha256 digest for ${document.relativePath}`)
  if (bytes.length !== document.sizeBytes) throw new Error(`Documents payload size does not match ${document.relativePath}`)
  const markdown = utf8(bytes, `payload/${document.relativePath}`)
  const frontmatterEnd = markdown.startsWith('---\n') ? markdown.indexOf('\n---\n', 4) : -1
  if (frontmatterEnd < 0 || !markdown.slice(4, frontmatterEnd).split('\n').includes(`id: ${JSON.stringify(document.id)}`)) throw new Error(`Documents payload identity does not match ${document.relativePath}`)
  const body = markdown.slice(frontmatterEnd + 5).trim()
  if (sha256(body) !== document.contentHash) throw new Error(`Documents payload content hash does not match ${document.relativePath}`)
}

function validatePackPayload(files: Record<string, Uint8Array>, components: MnemonPackComponent[], runtimeLimits: RuntimeMemoryLimits): void {
  if (components.includes('runtime')) parseRuntime(json(files[RUNTIME_MEMORIES_PATH] ?? new Uint8Array(), RUNTIME_MEMORIES_PATH), runtimeLimits)
  if (components.includes('documents')) {
    const index = parseDocumentIndex(json(files[DOCUMENTS_INDEX_PATH] ?? new Uint8Array(), DOCUMENTS_INDEX_PATH))
    for (const document of index.documents) {
      const bytes = files[`payload/${document.relativePath}`]
      if (bytes === undefined) throw new Error(`Documents payload is missing ${document.relativePath}`)
      assertDocumentPayload(document, bytes)
    }
  }
  if (components.includes('memory-spaces')) {
    const registry = parseMemorySpaceRegistry(json(files[MEMORY_SPACE_REGISTRY_PATH] ?? new Uint8Array(), MEMORY_SPACE_REGISTRY_PATH))
    for (const body of registry.bodies) {
      const path = databasePayloadPath(body.id)
      const database = files[path]
      if (database === undefined) throw new Error(`Memory Space payload is missing ${body.id}/${MEMORY_SPACE_DATABASE_FILE}`)
      validDatabase(database, path)
    }
    const databases = Object.keys(files).filter(path => {
      const segments = payloadSegments(path, 'memory-spaces')
      return segments?.length === 2 && segments[0] !== '' && segments[1] === MEMORY_SPACE_DATABASE_FILE
    })
    if (databases.length !== registry.bodies.length) throw new Error('Memory Space registry does not match the database payload')
  }
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

/** `staleMs` is the owner's rule for an abandoned lock: a Source's lock is taken over only when that Source would take it over. */
function acquireLock(path: string, staleMs: number): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let descriptor: number | undefined
  while (descriptor === undefined) {
    try {
      descriptor = openSync(path, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try { if (Date.now() - statSync(path).mtimeMs > staleMs) rmSync(path, { force: true }) } catch {}
      if (Date.now() >= deadline) throw new Error(`timed out waiting for Pack component lock: ${path}`)
      sleepSync(LOCK_RETRY_MS)
    }
  }
  // The lock is the lock file's existence, not its descriptor. Windows refuses
  // to rename a directory that holds an open handle, and an import replaces the
  // runtime and documents directories that carry these very lock files.
  const identity = fstatSync(descriptor)
  closeSync(descriptor)
  return () => {
    try {
      const current = lstatSync(path)
      if (current.dev === identity.dev && current.ino === identity.ino) rmSync(path, { force: true })
    } catch {}
  }
}

/**
 * The lock each Source's controller holds while it writes, so a copy never sees a component half
 * written, always in this order whatever order the components are listed in.
 */
function sourceLocks(root: string, components: readonly MnemonPackComponent[]): Array<{ path: string; staleMs: number }> {
  const locks: Array<{ path: string; staleMs: number }> = []
  if (components.includes('runtime')) locks.push({ path: join(root, RUNTIME_DIRECTORY, RUNTIME_LOCK_FILE), staleMs: RUNTIME_LOCK_STALE_MS })
  if (components.includes('documents')) locks.push({ path: join(root, DOCUMENTS_DIRECTORY, DOCUMENTS_LOCK_FILE), staleMs: DOCUMENTS_LOCK_STALE_MS })
  return locks
}

function withLocks<T>(root: string, components: MnemonPackComponent[], operation: () => T): T {
  const locks = [{ path: join(root, '.dsh-pack.lock'), staleMs: LOCK_STALE_MS }, ...sourceLocks(root, components)]
  const releases: Array<() => void> = []
  try {
    for (const lock of locks) releases.push(acquireLock(lock.path, lock.staleMs))
    return operation()
  } finally {
    for (const release of releases.reverse()) release()
  }
}

function assertRegularFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Pack source is not a regular file: ${path}`)
  if (stat.size > MAX_FILE_BYTES) throw new Error(`Pack source file exceeds the safety limit: ${path}`)
}

function sourceBytes(path: string): Uint8Array {
  assertRegularFile(path)
  return readFileSync(path)
}

function emptyRuntime(): RuntimeFile {
  return { version: 1, entries: [] }
}

function readCurrentRuntime(root: string, limits: RuntimeMemoryLimits = RUNTIME_MEMORY_LIMITS): RuntimeFile {
  const path = join(root, RUNTIME_DIRECTORY, RUNTIME_MEMORIES_FILE)
  return existsSync(path) ? parseRuntime(JSON.parse(readFileSync(path, 'utf8')) as unknown, limits) : emptyRuntime()
}

/**
 * A Pack carries no local archive: the one MEMORY.md wrote while no Memory Space
 * could take its entries holds their only copy, so an import keeps it (#336).
 * Its files and folders are carried; a link is neither carried nor followed.
 */
function keepRuntimeArchive(root: string, stagedRuntime: string): void {
  const copy = (from: string, to: string): void => {
    let stat
    try { stat = lstatSync(from) } catch { return }
    if (stat.isSymbolicLink()) return
    if (stat.isFile()) {
      copyFileSync(from, to)
      chmodSync(to, 0o600)
    } else if (stat.isDirectory()) {
      mkdirSync(to, { recursive: true, mode: 0o700 })
      for (const name of readdirSync(from)) copy(join(from, name), join(to, name))
    }
  }
  copy(join(root, RUNTIME_DIRECTORY, RUNTIME_ARCHIVE_DIRECTORY), join(stagedRuntime, RUNTIME_ARCHIVE_DIRECTORY))
}

/** Keep exact overflow records locally; a stable filename makes retried merges idempotent. */
function archiveRuntimeOverflow(stagedRuntime: string, entries: RuntimeMemoryEntry[]): number {
  if (entries.length === 0) return 0
  const directory = join(stagedRuntime, RUNTIME_ARCHIVE_DIRECTORY, 'import-overflow')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  let added = 0
  for (const entry of entries) {
    const content = `${canonicalJson({ version: 1, entries: [entry] })}\n`
    const path = join(directory, `${sha256(content)}.json`)
    if (existsSync(path)) {
      if (readFileSync(path, 'utf8') !== content) throw new Error('Runtime overflow archive content mismatch')
      continue
    }
    writeFileSync(path, content, { mode: 0o600, flag: 'wx' })
    added += 1
  }
  return added
}

/** Retain the same hot set on both machines, without asking a model to rewrite evidence. */
function fitMergedRuntime(entries: RuntimeMemoryEntry[], limits: RuntimeMemoryLimits): { entries: RuntimeMemoryEntry[]; archived: RuntimeMemoryEntry[] } {
  if (runtimeBytes(entries.filter(entry => entry.pinned === true), 'memory') > limits.memory) throw new Error('Pinned runtime entries exceed the merge capacity. Unpin entries or increase the capacity; no data was changed.')
  if (runtimeBytes(entries, 'memory') <= limits.memory) return { entries, archived: [] }
  const importance = { critical: 2, normal: 1, low: 0 }
  const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
  const ranked = entries.filter(entry => entry.target === 'memory').sort((left, right) =>
    Number(right.pinned === true) - Number(left.pinned === true) || importance[right.importance] - importance[left.importance] || compare(right.updated_at, left.updated_at) || compare(entryKey(left), entryKey(right)))
  const kept: RuntimeMemoryEntry[] = []
  const archived: RuntimeMemoryEntry[] = []
  for (const entry of ranked) {
    if (runtimeBytes([...kept, entry], 'memory') <= limits.memory) kept.push(entry)
    else archived.push(entry)
  }
  const selected = new Set(kept)
  return { entries: entries.filter(entry => entry.target === 'user' || selected.has(entry)), archived }
}

function writeRuntime(directory: string, file: RuntimeFile): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(join(directory, RUNTIME_MEMORIES_FILE), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  writeFileSync(join(directory, RUNTIME_PROJECTION_FILES.user), runtimeProjection(file.entries, 'user'), { mode: 0o600 })
  writeFileSync(join(directory, RUNTIME_PROJECTION_FILES.memory), runtimeProjection(file.entries, 'memory'), { mode: 0o600 })
}

function readCurrentDocuments(root: string): { index: DocumentIndex; files: Map<string, Uint8Array> } {
  const indexPath = join(root, DOCUMENTS_DIRECTORY, DOCUMENTS_INDEX_FILE)
  const index = existsSync(indexPath) ? parseDocumentIndex(JSON.parse(readFileSync(indexPath, 'utf8')) as unknown) : { version: 1 as const, documents: [] }
  const files = new Map<string, Uint8Array>()
  for (const document of index.documents) {
    const path = join(root, document.relativePath)
    if (!existsSync(path)) throw new Error(`current Documents index is missing ${document.relativePath}`)
    files.set(document.id, sourceBytes(path))
  }
  return { index, files }
}

function writeDocuments(directory: string, index: DocumentIndex, files: Map<string, Uint8Array>): void {
  mkdirSync(join(directory, 'active'), { recursive: true, mode: 0o700 })
  mkdirSync(join(directory, 'archived'), { recursive: true, mode: 0o700 })
  for (const document of index.documents) {
    const bytes = files.get(document.id)
    if (bytes === undefined) throw new Error(`Documents staging is missing ${document.id}`)
    writeFileSync(join(directory, document.status, document.filename), bytes, { mode: 0o600 })
  }
  writeFileSync(join(directory, DOCUMENTS_INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 })
}

function archiveDocuments(pack: ParsedPack): { index: DocumentIndex; files: Map<string, Uint8Array> } {
  const index = parseDocumentIndex(json(pack.files[DOCUMENTS_INDEX_PATH]!, DOCUMENTS_INDEX_PATH))
  return { index, files: new Map(index.documents.map(document => [document.id, pack.files[`payload/${document.relativePath}`]!])) }
}

function remapDocument(document: DocumentRecord, bytes: Uint8Array, id: string): { document: DocumentRecord; bytes: Uint8Array } {
  const base = document.filename.replace(/\.md$/u, '').slice(0, 80) || 'document'
  const filename = `${base}-${id.slice(0, 8)}.md`
  const markdown = utf8(bytes, document.filename).replace(/^id:\s*.*$/mu, `id: ${JSON.stringify(id)}`)
  const output = strToU8(markdown)
  return {
    document: { ...document, id, filename, relativePath: `${DOCUMENTS_DIRECTORY}/${document.status}/${filename}`, sizeBytes: output.length },
    bytes: output,
  }
}

function readCurrentRegistry(root: string, timestamp = new Date().toISOString()): { registry: MemorySpaceRegistryFile; databases: Map<string, Uint8Array> } {
  const data = join(root, MEMORY_SPACES_DIRECTORY)
  if (!existsSync(data)) return { registry: { version: 1, bodies: [] }, databases: new Map() }
  const discovered = readdirSync(data, { withFileTypes: true }).filter(entry => entry.isDirectory() && MEMORY_SPACE_ID_PATTERN.test(entry.name) && existsSync(join(data, entry.name, MEMORY_SPACE_DATABASE_FILE))).map(entry => entry.name)
  const registryPath = join(data, MEMORY_SPACE_REGISTRY_FILE)
  const existing = existsSync(registryPath) ? parseMemorySpaceRegistry(JSON.parse(readFileSync(registryPath, 'utf8')) as unknown) : { version: 1 as const, bodies: [] }
  const byId = new Map(existing.bodies.map(body => [body.id, body]))
  const bodies = discovered.sort().map(id => byId.get(id) ?? { id, name: id, description: 'Existing Mnemon Store discovered on disk.', active: false, createdAt: timestamp, updatedAt: timestamp })
  const databases = new Map<string, Uint8Array>()
  for (const body of bodies) {
    const path = join(data, body.id, MEMORY_SPACE_DATABASE_FILE)
    const wal = `${path}-wal`
    if (existsSync(wal) && statSync(wal).size > 0) throw new Error(`Memory Space ${body.id} is busy (${MEMORY_SPACE_DATABASE_FILE}-wal is not checkpointed); retry after writes settle`)
    const bytes = sourceBytes(path)
    validDatabase(bytes, path)
    databases.set(body.id, bytes)
  }
  return { registry: { version: 1, bodies }, databases }
}

function archiveRegistry(pack: ParsedPack): { registry: MemorySpaceRegistryFile; databases: Map<string, Uint8Array> } {
  const registry = parseMemorySpaceRegistry(json(pack.files[MEMORY_SPACE_REGISTRY_PATH]!, MEMORY_SPACE_REGISTRY_PATH))
  return { registry, databases: new Map(registry.bodies.map(body => [body.id, pack.files[databasePayloadPath(body.id)]!])) }
}

function writeRegistry(directory: string, registry: MemorySpaceRegistryFile, databases: Map<string, Uint8Array>): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  for (const body of registry.bodies) {
    const bytes = databases.get(body.id)
    if (bytes === undefined) throw new Error(`Memory Space staging is missing ${body.id}/${MEMORY_SPACE_DATABASE_FILE}`)
    const bodyDirectory = join(directory, body.id)
    mkdirSync(bodyDirectory, { recursive: true, mode: 0o700 })
    writeFileSync(join(bodyDirectory, MEMORY_SPACE_DATABASE_FILE), bytes, { mode: 0o600 })
  }
  writeFileSync(join(directory, MEMORY_SPACE_REGISTRY_FILE), `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 })
}

function componentItems(component: MnemonPackComponent, files: Record<string, Uint8Array>, runtimeLimits: RuntimeMemoryLimits = RUNTIME_MEMORY_LIMITS): number {
  if (component === 'runtime') return parseRuntime(json(files[RUNTIME_MEMORIES_PATH]!, RUNTIME_MEMORIES_PATH), runtimeLimits).entries.length
  if (component === 'documents') return parseDocumentIndex(json(files[DOCUMENTS_INDEX_PATH]!, DOCUMENTS_INDEX_PATH)).documents.length
  return parseMemorySpaceRegistry(json(files[MEMORY_SPACE_REGISTRY_PATH]!, MEMORY_SPACE_REGISTRY_PATH)).bodies.length
}

function summaryFor(components: MnemonPackComponent[], files: Record<string, Uint8Array>, runtimeLimits: RuntimeMemoryLimits = RUNTIME_MEMORY_LIMITS): MnemonPackComponentSummary[] {
  return components.map(component => {
    const prefix = payloadPrefix(component)
    const entries = Object.entries(files).filter(([path]) => path.startsWith(prefix))
    return { component, files: entries.length, bytes: entries.reduce((sum, [, value]) => sum + value.length, 0), items: componentItems(component, files, runtimeLimits) }
  })
}

function collectExport(root: string, components: MnemonPackComponent[], runtimeLimits: RuntimeMemoryLimits = RUNTIME_MEMORY_LIMITS, forSync = false): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {}
  if (components.includes('runtime')) {
    const runtime = readCurrentRuntime(root, runtimeLimits)
    const entries = runtime.entries
    files[RUNTIME_MEMORIES_PATH] = strToU8(`${JSON.stringify({ ...runtime, entries }, null, 2)}\n`)
    files[RUNTIME_PROJECTION_PATHS.user] = strToU8(runtimeProjection(entries, 'user'))
    files[RUNTIME_PROJECTION_PATHS.memory] = strToU8(runtimeProjection(entries, 'memory'))
  }
  if (components.includes('documents')) {
    const current = readCurrentDocuments(root)
    const index = forSync ? { ...current.index, documents: current.index.documents.map(document => ({
      ...document, lastAccessedAt: document.updatedAt,
      // The workspace a Document belongs to is this machine's absolute path, so
      // it must not travel: the same workspace has a different path on each
      // machine, and a scope whose records disagreed on that field could never
      // converge. The receiving side records its own path (see `mergeWorkspaceSync`).
      workspaceRoot: undefined,
    })) } : current.index
    files[DOCUMENTS_INDEX_PATH] = strToU8(`${JSON.stringify(index, null, 2)}\n`)
    for (const document of current.index.documents) files[`payload/${document.relativePath}`] = current.files.get(document.id)!
  }
  if (components.includes('memory-spaces')) {
    const current = readCurrentRegistry(root, forSync ? SYNC_SNAPSHOT_DATE : undefined)
    files[MEMORY_SPACE_REGISTRY_PATH] = strToU8(`${JSON.stringify(current.registry, null, 2)}\n`)
    for (const body of current.registry.bodies) files[databasePayloadPath(body.id)] = current.databases.get(body.id)!
  }
  return files
}

/** One entry's identity across machines: its target plus its exact text. */
function entryKey(entry: { target: RuntimeMemoryTarget; content: string }): string {
  return `${entry.target}\0${entry.content}`
}

type RuntimeMergeReport = MnemonRuntimeMergeReport

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const fields = value as Record<string, unknown>
    return `{${Object.keys(fields).filter(key => fields[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(fields[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Order a merged result canonically.
 *
 * A union has no inherent order: taking the local entries first and appending
 * the peer's gives `[a, b]` on one machine and `[b, a]` on the other. Both are
 * the same set, so a one-off import would not care — but sync runs repeatedly,
 * and two snapshots that differ only by order differ by digest, so each machine
 * would keep republishing the other's result forever. Sorting by identity makes
 * the merged bytes depend on the set alone, which is what lets the second run
 * of both machines agree.
 *
 * Local order is what a person arranged, so this is applied only where a merge
 * combines two copies; a plain replace keeps the order it was given.
 */
function canonicalRuntimeEntries(entries: RuntimeMemoryEntry[]): RuntimeMemoryEntry[] {
  return [...entries].sort((left, right) => left.created_at.localeCompare(right.created_at)
    || left.target.localeCompare(right.target) || left.content.localeCompare(right.content))
}

function canonicalDocuments(documents: DocumentRecord[]): DocumentRecord[] {
  return [...documents].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
}

function canonicalSpaces(bodies: MemorySpaceRegistryEntry[]): MemorySpaceRegistryEntry[] {
  return [...bodies].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
}

function mergeRuntime(root: string, pack: ParsedPack, runtimeLimits: RuntimeMemoryLimits, canonical = false): { runtime: RuntimeFile; report: RuntimeMergeReport; archived: RuntimeMemoryEntry[] } {
  const current = readCurrentRuntime(root, runtimeLimits)
  const incoming = parseRuntime(json(pack.files[RUNTIME_MEMORIES_PATH]!, RUNTIME_MEMORIES_PATH), runtimeLimits)
  const entries = [...current.entries]
  const keys = new Set(entries.map(entryKey))
  const report: RuntimeMergeReport = { added: 0, held: 0 }
  const incomingKeys = new Set<string>()
  for (const entry of incoming.entries) {
    const key = entryKey(entry)
    if (keys.has(key)) {
      const existing = entries.find(candidate => entryKey(candidate) === key)!
      if (entry.pinned !== undefined && (existing.pinned === undefined || entry.updated_at > existing.updated_at)) {
        existing.pinned = entry.pinned
        if (entry.updated_at > existing.updated_at) existing.updated_at = entry.updated_at
      }
      continue
    }
    keys.add(key)
    entries.push(entry)
    incomingKeys.add(key)
  }
  const fitted = fitMergedRuntime(canonical ? canonicalRuntimeEntries(entries) : entries, runtimeLimits)
  report.added = fitted.entries.filter(entry => incomingKeys.has(entryKey(entry))).length
  return {
    runtime: parseRuntime({ version: 1, entries: fitted.entries }, runtimeLimits),
    archived: fitted.archived,
    report,
  }
}

/**
 * A document's identity across machines.
 *
 * A Pack conflict copy used to take a random id, which is fine for a one-off
 * import: re-importing the same archive finds the conflicting copy by its
 * content hash and stops. Sync runs repeatedly, so the same pair of divergent
 * copies would otherwise produce a new copy on every pass. Deriving the id
 * from what the copy holds makes the operation idempotent: the second run
 * finds the id it created and reports nothing new.
 */
function conflictDocumentId(source: DocumentRecord, workspaceRoot: string | undefined): string {
  return sha256(JSON.stringify(['document-conflict', workspaceRoot ?? '', source.id, source.contentHash])).slice(0, 32)
}

function mergeDocuments(root: string, pack: ParsedPack, workspaceRoot?: string, canonical = false): { index: DocumentIndex; files: Map<string, Uint8Array> } {
  const current = readCurrentDocuments(root)
  const incoming = archiveDocuments(pack)
  const ids = new Map(current.index.documents.map(document => [document.id, document]))
  const add = (document: DocumentRecord, bytes: Uint8Array): void => {
    current.index.documents.push(document)
    current.files.set(document.id, bytes)
    ids.set(document.id, document)
  }
  // A divergent document is kept beside the local one under a stable new id.
  const copy = (source: DocumentRecord): void => {
    const id = conflictDocumentId(source, workspaceRoot)
    const existing = ids.get(id)
    // This run, or an earlier one, already kept this exact version.
    if (existing !== undefined && existing.contentHash === source.contentHash) return
    const remapped = remapDocument(source, incoming.files.get(source.id)!, id)
    if (existing !== undefined) {
      // The same derived id now names different bytes: keep both rather than
      // silently replacing what an earlier pass stored.
      const fallback = remapDocument(source, incoming.files.get(source.id)!, randomUUID())
      add(fallback.document, fallback.bytes)
      return
    }
    add(remapped.document, remapped.bytes)
  }
  for (const source of incoming.index.documents) {
    const existing = ids.get(source.id)
    // A synced record carries no workspace path: the scope it travelled in is
    // this machine's copy of the same workspace, so it is recorded here.
    const adopted = workspaceRoot === undefined ? source : { ...source, workspaceRoot }
    if (existing !== undefined && existing.contentHash === adopted.contentHash) continue
    // Merging the same pack again, finds that copy and does not make a second one.
    if (existing !== undefined && current.index.documents.some(document => document.contentHash === adopted.contentHash)) continue
    if (existing !== undefined) copy(adopted)
    else add(adopted, incoming.files.get(source.id)!)
  }
  const activeBytes = current.index.documents.filter(document => document.status === 'active').reduce((sum, document) => sum + document.sizeBytes, 0)
  if (activeBytes > DOCUMENTS_ACTIVE_LIMIT_BYTES) throw new Error(`merged Documents exceed the ${DOCUMENTS_ACTIVE_LIMIT_BYTES} byte active limit`)
  // Every record in this scope belongs to the workspace this machine synced, so
  // each one names this machine's path. Without this, records that arrived
  // without a path would be grouped under "no recorded workspace".
  if (workspaceRoot !== undefined) {
    current.index.documents = current.index.documents.map(document => ({ ...document, workspaceRoot }))
  }
  if (canonical) current.index.documents = canonicalDocuments(current.index.documents)
  return current
}

/** Stable across repeated imports, bounded by the registry contract, and distinguishable in the UI. */
function conflictSpaceName(source: MemorySpaceRegistryEntry): string {
  const suffix = ` (import conflict ${createHash('sha256').update(source.id).digest('hex').slice(0, 8)})`
  return source.name.slice(0, MEMORY_SPACE_NAME_MAX_LENGTH - suffix.length) + suffix
}

/**
 * The id a divergent Memory Space copy takes.
 *
 * A Pack import could take a fresh `randomUUID()` because it is a deliberate
 * one-off. Sync repeats, and the copy is only recognized by its name, so a
 * random id would keep producing registries that differ from the peer's even
 * when both hold the same spaces — and each machine would republish forever.
 * Deriving it from what the copy holds makes the same input produce the same
 * registry on every machine and every run.
 */
function conflictSpaceId(source: MemorySpaceRegistryEntry, database: Uint8Array): string {
  return 'conflict-' + sha256(`${source.id}\0${sha256(database)}`).slice(0, 32)
}

function mergeRegistry(root: string, pack: ParsedPack, canonical = false): { registry: MemorySpaceRegistryFile; databases: Map<string, Uint8Array> } {
  const current = readCurrentRegistry(root)
  const incoming = archiveRegistry(pack)
  const ids = new Set(current.registry.bodies.map(body => body.id))
  // Spaces are compared by what they hold, not by their bytes: reading a space rewrites
  // its read counters, so the same space never has the same bytes on two machines (#370).
  const identity = new MemorySpaceIdentity(root)
  try {
    const covers = (outer: Uint8Array, inner: Uint8Array): boolean => identity.of(outer) === identity.of(inner) || identity.contains(outer, inner)
    // Whether a space held here that `accept` admits already holds every memory of `database`.
    const held = (database: Uint8Array, accept: (body: MemorySpaceRegistryEntry) => boolean): boolean =>
      current.registry.bodies.some(body => accept(body) && covers(current.databases.get(body.id)!, database))
    const add = (body: MemorySpaceRegistryEntry, database: Uint8Array): void => {
      ids.add(body.id)
      current.registry.bodies.push(body)
      current.databases.set(body.id, database)
    }
    for (const source of incoming.registry.bodies) {
      const sourceDb = incoming.databases.get(source.id)!
      if (ids.has(source.id)) {
        const localDb = current.databases.get(source.id)!
        // Read on both machines, or an older version of this machine's: nothing new arrives,
        // and this machine's copy stays, read counts included.
        if (covers(localDb, sourceDb)) continue
        // The memories only the other machine holds join this machine's, which keeps its own rows,
        // read counts and log: one space holding both, whichever side gained them.
        const merged = identity.merge(localDb, sourceDb)
        if (merged !== undefined) {
          current.databases.set(source.id, merged)
          continue
        }
        // A memory edited or forgotten on one side: the other version stays beside this one as a
        // copy, once. A space here already holding it, whatever its name, takes its place, and a
        // conflict copy it only added to moves on with it. Also recognize older same-name copies.
        if (held(sourceDb, body => body.id !== source.id)) continue
        const copy = current.registry.bodies.find(body => body.id !== source.id && (body.name === conflictSpaceName(source) || body.name === source.name)
          && identity.contains(sourceDb, current.databases.get(body.id)!))
        const advanced = copy === undefined ? undefined : identity.merge(current.databases.get(copy.id)!, sourceDb)
        if (copy !== undefined && advanced !== undefined) {
          current.databases.set(copy.id, advanced)
          continue
        }
        add({ ...source, id: conflictSpaceId(source, sourceDb), name: conflictSpaceName(source), active: false, updatedAt: source.updatedAt }, sourceDb)
      } else if (!held(sourceDb, body => body.name === source.name)) {
        // A space new here, unless one of the same name already holds every memory in it:
        // a copy an older version made, or the other machine's copy of a divergent space.
        add(source, sourceDb)
      }
    }
    if (canonical) current.registry.bodies = canonicalSpaces(current.registry.bodies)
    return current
  } finally {
    identity.dispose()
  }
}

function persistedStore(root: string): string {
  try {
    const value = readFileSync(join(root, MNEMON_ACTIVE_STORE_FILE), 'utf8').trim()
    if (MEMORY_SPACE_ID_PATTERN.test(value)) return value
  } catch {}
  return 'default'
}

function reconcilePersistedStore(root: string): void {
  const current = readCurrentRegistry(root).registry.bodies
  const ids = new Set(current.map(body => body.id))
  const selected = persistedStore(root)
  if (ids.has(selected)) return
  const replacement = ids.has('default')
    ? 'default'
    : current.filter(body => body.active).map(body => body.id).sort()[0] ?? [...ids].sort()[0] ?? 'default'
  const temporary = join(root, `.active-${process.pid}-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${replacement}\n`, { mode: 0o600 })
    renameSync(temporary, join(root, MNEMON_ACTIVE_STORE_FILE))
  } finally {
    rmSync(temporary, { force: true })
  }
}

function stageImport(root: string, pack: ParsedPack, components: MnemonPackComponent[], mode: MnemonPackImportMode, runtimeLimits: RuntimeMemoryLimits, options: { allowEmptySpaces?: boolean; workspaceRoot?: string; canonical?: boolean } = {}): { staging: string; report: RuntimeMergeReport | undefined } {
  const staging = join(root, `.dsh-pack-stage-${randomUUID()}`)
  mkdirSync(staging, { recursive: true, mode: 0o700 })
  try {
    const canonical = options.canonical === true
    let report: RuntimeMergeReport | undefined
    if (components.includes('runtime')) {
      const merged = mode === 'merge' ? mergeRuntime(root, pack, runtimeLimits, canonical) : undefined
      const runtime = merged === undefined ? parseRuntime(json(pack.files[RUNTIME_MEMORIES_PATH]!, RUNTIME_MEMORIES_PATH), runtimeLimits) : merged.runtime
      writeRuntime(join(staging, RUNTIME_DIRECTORY), runtime)
      report = merged?.report
      keepRuntimeArchive(root, join(staging, RUNTIME_DIRECTORY))
      if (merged !== undefined && merged.archived.length > 0) {
        const archived = archiveRuntimeOverflow(join(staging, RUNTIME_DIRECTORY), merged.archived)
        if (archived > 0) merged.report.archived = archived
      }
    }
    if (components.includes('documents')) {
      const documents = mode === 'merge' ? mergeDocuments(root, pack, options.workspaceRoot, canonical) : archiveDocuments(pack)
      writeDocuments(join(staging, DOCUMENTS_DIRECTORY), documents.index, documents.files)
    }
    if (components.includes('memory-spaces')) {
      const memory = mode === 'merge' ? mergeRegistry(root, pack, canonical) : archiveRegistry(pack)
      if (mode === 'replace' && !options.allowEmptySpaces && readCurrentRegistry(root).registry.bodies.length > 0 && memory.registry.bodies.length === 0) {
        throw new Error('cannot replace the last Mnemon Store with an empty Memory Space set')
      }
      writeRegistry(join(staging, MEMORY_SPACES_DIRECTORY), memory.registry, memory.databases)
    }
    return { staging, report }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

function commitStaging(root: string, staging: string, components: MnemonPackComponent[]): void {
  const backup = join(root, `.dsh-pack-backup-${randomUUID()}`)
  mkdirSync(backup, { recursive: true, mode: 0o700 })
  const committed: Array<{ directory: string; hadPrevious: boolean }> = []
  // The Sources' locks are written into the staged directories, so the directories that replace
  // the current ones arrive already locked and no Source writes between the swap and the release.
  const replacementLocks = sourceLocks(staging, components).map(lock => lock.path)
  const activePath = join(root, MNEMON_ACTIVE_STORE_FILE)
  const previousActive = existsSync(activePath) ? readFileSync(activePath) : undefined
  try {
    for (const lock of replacementLocks) writeFileSync(lock, 'pack-import\n', { mode: 0o600 })
    for (const component of components) {
      const directory = COMPONENT_DIRECTORIES[component]
      const target = join(root, directory)
      const previous = join(backup, directory)
      const hadPrevious = existsSync(target)
      if (hadPrevious) renameSync(target, previous)
      try {
        renameSync(join(staging, directory), target)
      } catch (error) {
        if (hadPrevious) renameSync(previous, target)
        throw error
      }
      committed.push({ directory, hadPrevious })
    }
    if (components.includes('memory-spaces')) reconcilePersistedStore(root)
    for (const lock of sourceLocks(root, components)) rmSync(lock.path, { force: true })
  } catch (error) {
    for (const entry of committed.reverse()) {
      const target = join(root, entry.directory)
      rmSync(target, { recursive: true, force: true })
      if (entry.hadPrevious) renameSync(join(backup, entry.directory), target)
    }
    if (components.includes('memory-spaces')) {
      if (previousActive === undefined) rmSync(activePath, { force: true })
      else writeFileSync(activePath, previousActive, { mode: 0o600 })
    }
    throw error
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(backup, { recursive: true, force: true })
  }
}

function occupied(root: string, component: MnemonPackComponent): boolean {
  const directory = join(root, COMPONENT_DIRECTORIES[component])
  if (!existsSync(directory)) return false
  try { return readdirSync(directory).some(name => !name.startsWith('.')) } catch { return true }
}

function safeName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const name = basename(value.trim()).replace(/[^a-zA-Z0-9._-]+/gu, '-')
  return name === '' ? undefined : name.slice(0, 160)
}

/** Native, checksummed import/export for the one currently effective Mnemon root. */
const SYNC_SNAPSHOT_DATE = '1980-01-01T00:00:00.000Z'

export class MnemonPackManager {
  private readonly root: string
  private readonly runtimeLimits: RuntimeMemoryLimits
  private readonly machine: MnemonMachineStore

  constructor(
    private readonly runner: StorageRoot,
    private readonly config: Pick<ResolvedConfig, 'storageScope' | 'runtimeMemory'>,
    private readonly afterImport: (components: MnemonPackComponent[]) => void = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.root = resolve(runner.effectiveDataDir())
    this.machine = new MnemonMachineStore(runner)
    this.runtimeLimits = {
      memory: config.runtimeMemory.memoryLimitBytes,
      user: config.runtimeMemory.userLimitBytes,
    }
  }

  /** The local identity shown on manually reviewed memory proposals. */
  identity(): MnemonMachineIdentity {
    return this.machine.read()
  }

  target(): MnemonPackTarget {
    return { root: this.root, scope: this.config.storageScope, defaultRoot: resolve(createStorageRoot({ storageScope: 'global' }).effectiveDataDir()) }
  }

  async exportPack(scope: MnemonPackScope): Promise<MnemonPackExport> {
    const components = componentsForScope(scope)
    return this.runner.withExclusive(async () => {
      await new Promise<void>(resolveReady => setImmediate(resolveReady))
      return withLocks(this.root, components, () => {
        const exportedAt = this.now().toISOString()
        const payload = collectExport(this.root, components, this.runtimeLimits)
        const summary = summaryFor(components, payload, this.runtimeLimits)
        const manifest: MnemonPackManifest = {
          format: MNEMON_PACK_FORMAT, version: MNEMON_PACK_VERSION, scope, exportedAt,
          source: { plugin: 'dsh-mnemon', pluginVersion: pluginPackageVersion() }, components, summary,
        }
        const checksums: ChecksumFile = { algorithm: 'sha256', files: Object.fromEntries(Object.entries(payload).map(([path, bytes]) => [path, sha256(bytes)])) }
        const entries: Zippable = {
          'manifest.json': strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
          'checksums.json': strToU8(`${JSON.stringify(checksums, null, 2)}\n`),
          ...payload,
        }
        // fflate writes ZIP timestamps using local date fields. Pin those fields
        // to keep the archive in range and byte-identical across timezones.
        const archive = zipSync(entries, { level: 6, mtime: new Date(1980, 0, 1) })
        if (archive.length > MNEMON_PACK_MAX_ARCHIVE_BYTES) throw new Error('exported Mnemon Pack exceeds the transport safety limit')
        const stamp = exportedAt.replace(/[:.]/gu, '-').replace('T', '_').replace('Z', '')
        return {
          fileName: `mnemon-backup-${stamp}.zip`, mimeType: MNEMON_PACK_MIME, bytes: archive.length,
          base64: Buffer.from(archive).toString('base64'), targetRoot: this.root, manifest,
        }
      })
    })
  }

  private captureWorkspaceSyncLocked(): { bytes: Buffer; entries: Record<string, Uint8Array>; empty: boolean } {
    const entries = this.workspaceSyncEntriesLocked()
    const bytes = this.assembleWorkspaceSync(entries.files)
    if (bytes.length > MNEMON_PACK_MAX_ARCHIVE_BYTES) throw new Error('Workspace sync snapshot exceeds the Pack size limit')
    return { bytes, entries: entries.files, empty: entries.empty }
  }

  /**
   * The files one sync snapshot is built from, before they are archived.
   *
   * A replica compares these against the manifest the peer published, so the
   * entries have to be produced the same way on both sides: the archive below
   * is assembled from exactly this set.
   */
  private workspaceSyncEntriesLocked(): { files: Record<string, Uint8Array>; empty: boolean } {
    const components = componentsForScope('full')
    const payload = collectExport(this.root, components, this.runtimeLimits, true)
    validatePackPayload(payload, components, this.runtimeLimits)
    const summary = summaryFor(components, payload, this.runtimeLimits)
    const manifest: MnemonPackManifest = {
      format: MNEMON_PACK_FORMAT, version: MNEMON_PACK_VERSION, scope: 'full', exportedAt: SYNC_SNAPSHOT_DATE,
      source: { plugin: 'dsh-mnemon', pluginVersion: '0.0.0' }, components, summary,
    }
    const ordered = Object.entries(payload).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    const checksums: ChecksumFile = { algorithm: 'sha256', files: Object.fromEntries(ordered.map(([path, bytes]) => [path, sha256(bytes)])) }
    return {
      files: {
        'manifest.json': strToU8(JSON.stringify(manifest)),
        'checksums.json': strToU8(JSON.stringify(checksums)),
        ...Object.fromEntries(ordered),
      },
      empty: summary.every(component => component.items === 0),
    }
  }

  /**
   * Build the sync archive from a set of entries.
   *
   * A pull assembles the archive here rather than asking the peer for it: the
   * entries it already holds are reused, and only the differing ones were
   * downloaded. The build is deterministic — fixed order, fixed mtime — so the
   * same entries always produce the same bytes, which is what the manifest's
   * digest checks.
   *
   * The required entries are checked before archiving, so an incomplete set
   * fails here with a message naming the missing path instead of producing an
   * archive that only the import path rejects.
   */
  assembleWorkspaceSync(entries: Record<string, Uint8Array>): Buffer {
    for (const required of ['manifest.json', 'checksums.json']) {
      if (entries[required] === undefined) throw new Error(`Sync snapshot is missing ${required}`)
    }
    const ordered = Object.keys(entries).sort()
    return Buffer.from(zipSync(Object.fromEntries(ordered.map(path => [path, entries[path]!])), { level: 6, mtime: new Date(1980, 0, 1) }))
  }

  async captureWorkspaceSync(): Promise<{ bytes: Buffer; entries: Record<string, Uint8Array>; empty: boolean }> {
    return this.runner.withExclusive(() => withLocks(this.root, componentsForScope('full'), () => this.captureWorkspaceSyncLocked()))
  }

  async replaceWorkspaceSync(bytes: Buffer, matches: (live: Buffer) => boolean): Promise<void> {
    const pack = parseArchive(bytes.toString('base64'), this.runtimeLimits)
    if (pack.manifest.scope !== 'full') throw new Error('Workspace sync requires a complete memory snapshot')
    const components = componentsForScope('full')
    await this.runner.withExclusive(() => withLocks(this.root, components, () => {
      if (!matches(this.captureWorkspaceSyncLocked().bytes)) throw new Error('Workspace memories changed during sync; retry')
      const staged = stageImport(this.root, pack, components, 'replace', this.runtimeLimits, { allowEmptySpaces: true })
      commitStaging(this.root, staged.staging, components)
      this.afterImport(components)
    }))
  }

  /**
   * Take the peer's snapshot as a union instead of replacing this one.
   *
   * Two clients name the same workspace differently — the DSH workspace id is
   * derived from the local absolute path — so a workspace scope reaches the
   * same server scope under names that differ per machine even though a person
   * regards them as one workspace. Replacing would make each machine's edits
   * take turns overwriting the other's. Merging keeps both: runtime entries are
   * unioned by text, Documents by content (a genuine divergence keeps a second
   * copy), Memory Spaces by content, and a Document that names the peer's
   * workspace path is recorded under this machine's instead.
   *
   * The merge is idempotent — every derived identity is content-based — so a
   * repeated run over the same peer snapshot adds nothing.
   */
  async mergeWorkspaceSync(bytes: Buffer, matches: (live: Buffer) => boolean, workspaceRoot?: string): Promise<void> {
    const pack = parseArchive(bytes.toString('base64'), this.runtimeLimits)
    if (pack.manifest.scope !== 'full') throw new Error('Workspace sync requires a complete memory snapshot')
    const components = componentsForScope('full')
    await this.runner.withExclusive(() => withLocks(this.root, components, () => {
      if (!matches(this.captureWorkspaceSyncLocked().bytes)) throw new Error('Workspace memories changed during sync; retry')
      const staged = stageImport(this.root, pack, components, 'merge', this.runtimeLimits, { allowEmptySpaces: true, canonical: true, ...(workspaceRoot === undefined ? {} : { workspaceRoot }) })
      commitStaging(this.root, staged.staging, components)
      this.afterImport(components)
    }))
  }

  inspectPack(base64: string, fileName?: string): MnemonPackPreview {
    const pack = parseArchive(base64, this.runtimeLimits)
    const sanitizedName = safeName(fileName)
    return {
      ...(sanitizedName === undefined ? {} : { fileName: sanitizedName }),
      archiveBytes: pack.archiveBytes, expandedBytes: pack.expandedBytes, targetRoot: this.root, targetScope: this.config.storageScope,
      manifest: pack.manifest,
      occupied: Object.fromEntries(COMPONENT_ORDER.map(component => [component, occupied(this.root, component)])) as Record<MnemonPackComponent, boolean>,
    }
  }

  async importPack(base64: string, options: { mode: MnemonPackImportMode; components?: MnemonPackComponent[] }): Promise<MnemonPackImportResult> {
    const pack = parseArchive(base64, this.runtimeLimits)
    if (options.mode !== 'merge' && options.mode !== 'replace') throw new Error('Pack import mode must be merge or replace')
    if (options.components !== undefined && (new Set(options.components).size !== options.components.length || options.components.some(component => !COMPONENT_ORDER.includes(component)))) {
      throw new Error('requested import components are invalid')
    }
    const components = options.components === undefined ? pack.manifest.components : COMPONENT_ORDER.filter(component => options.components!.includes(component))
    if (components.length === 0 || components.some(component => !pack.manifest.components.includes(component))) throw new Error('requested import components are not present in this Pack')
    return this.runner.withExclusive(async () => {
      await new Promise<void>(resolveReady => setImmediate(resolveReady))
      mkdirSync(this.root, { recursive: true, mode: 0o700 })
      return withLocks(this.root, components, (): MnemonPackImportResult => {
        const staged = stageImport(this.root, pack, components, options.mode, this.runtimeLimits)
        commitStaging(this.root, staged.staging, components)
        this.afterImport(components)
        return {
          imported: true, mode: options.mode, targetRoot: this.root, components,
          summary: pack.manifest.summary.filter(summary => components.includes(summary.component)),
          ...(staged.report === undefined ? {} : { runtime: staged.report }),
        }
      })
    })
  }
}
