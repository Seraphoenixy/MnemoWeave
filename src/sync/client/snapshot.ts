import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { RemoteSyncConflict, type SyncRemote } from './remote.ts'
import { syncCursor, syncDigest, syncEntryPath, syncManifest, type SyncManifest } from '../protocol.ts'

const SNAPSHOT_KEY = 'memory-snapshot'
const stateSchema = z.strictObject({ cursor: syncCursor, remote: z.strictObject({ bytes: syncDigest, files: z.array(z.strictObject({ path: syncEntryPath, digest: syncDigest })) }).nullable() })

/**
 * Read the state a replica left behind.
 *
 * A build that synchronized whole snapshots in fixed-size blocks recorded
 * `remote` as `{ digest, blocks }`. Those block digests describe an archive this
 * build no longer produces, so the record is read as "never synchronized": the
 * scope re-publishes once, and every later run is incremental again. Refusing
 * the file outright would leave the scope unable to synchronize at all.
 */
function readState(raw: unknown): SnapshotSyncState {
  const parsed = stateSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  const cursor = (raw as { cursor?: unknown } | undefined)?.cursor
  return { cursor: typeof cursor === 'number' && Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0, remote: null }
}

/**
 * Whether this run should publish the local copy rather than treat the missing
 * manifest as a difference.
 *
 * A replica with no recorded manifest and no content has nothing to publish. A
 * replica whose manifest was just dropped by {@link readState} is the case this
 * exists for: it does have content, and the peer has content it cannot compare
 * against. Publishing is the right resolution — the local copy is the one this
 * build can actually address — but the run must not first report a conflict
 * nobody can act on, because neither side changed relative to a manifest this
 * build understands.
 */
function republishesAfterMigration(local: SyncSnapshot, state: SnapshotSyncState, remote: SyncManifest | null): boolean {
  return remote !== null && state.remote === null && !local.empty
}

export type SnapshotSyncState = z.infer<typeof stateSchema>

/**
 * One scope's content, addressed by path. A run compares these against the
 * manifest the peer publishes and moves only the entries that differ, so a
 * change to one memory file no longer costs a copy of everything beside it.
 */
export interface SnapshotEntries { [path: string]: Uint8Array }

export interface SyncSnapshot {
  /** The deterministically assembled archive, which the manifest's `bytes` names. */
  bytes: Buffer
  entries: SnapshotEntries
  empty: boolean
}

/**
 * How much of one snapshot has moved between the two copies: a pull counts the
 * entries it fetched, an upload counts the entries it stored.
 */
export interface SnapshotTransfer {
  done: number
  total: number
}

export interface SnapshotOptions {
  resolve?: 'local' | 'server'
  conflictToken?: string
  signal?: AbortSignal
  transfer?: (progress: SnapshotTransfer) => void
}

export interface SnapshotSyncResult {
  cursor: number
  action: 'unchanged' | 'pulled' | 'pushed'
}

interface SnapshotReplica {
  /** Current local content, both as an archive and as the files it was built from. */
  capture(): Promise<SyncSnapshot>
  /** Replace local content with the assembled archive, if nothing moved meanwhile. */
  apply(bytes: Buffer, expectedDigest: string): Promise<void>
  /** Assemble an archive from a set of entries, so a partial pull can be completed locally. */
  assemble(entries: SnapshotEntries): Buffer
  load(): unknown
  save(state: SnapshotSyncState): void
}

export function snapshotDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export class SnapshotConflict extends Error {
  readonly reason = 'snapshot-conflict'
  constructor(readonly conflictToken: string) { super('Local and server memories both changed. Choose which copy to keep before syncing.') }
}

/** One scope's content, published as a manifest plus the files it names. */
export class SnapshotSync {
  constructor(private readonly client: SyncRemote, private readonly replica: SnapshotReplica) {}

  async sync(options: SnapshotOptions = {}): Promise<SnapshotSyncResult> {
    const state = readState(this.replica.load() ?? { cursor: 0, remote: null })
    for (let attempt = 0; attempt < 4; attempt++) {
      options.signal?.throwIfAborted()
      const { cursor, remote } = await this.latest(state, options.signal)
      const local = await this.replica.capture()
      const digest = snapshotDigest(local.bytes)
      if (remote !== null && remote.bytes === digest) {
        this.replica.save({ cursor, remote })
        return { cursor, action: 'unchanged' }
      }
      const localChanged = state.remote === null ? !local.empty : digest !== state.remote.bytes
      const remoteChanged = remote?.bytes !== state.remote?.bytes
      const conflictToken = snapshotDigest(Buffer.from(JSON.stringify([cursor, digest, remote?.bytes ?? null])))
      // A manifest this build dropped during migration is not a change either
      // side made: the local copy is published without asking for a resolution.
      const migrated = republishesAfterMigration(local, state, remote)
      if (!migrated && options.resolve !== undefined && options.conflictToken !== conflictToken) throw new SnapshotConflict(conflictToken)
      if (!migrated && remote !== null && localChanged && remoteChanged && options.resolve === undefined) throw new SnapshotConflict(conflictToken)
      if (!migrated && remote !== null && (options.resolve === 'server' || options.resolve === undefined && !localChanged)) {
        const bytes = await this.pullFrom(remote, local, options.signal, options.transfer)
        if (snapshotDigest(bytes) !== remote.bytes) throw new Error('Sync snapshot digest mismatch')
        await this.replica.apply(bytes, digest)
        this.replica.save({ cursor, remote })
        return { cursor, action: 'pulled' }
      }
      if (remote === null && local.empty) return { cursor, action: 'unchanged' }
      if (remote === null && options.resolve === 'server') throw new Error('The server has no memory snapshot to apply')
      const next = await this.upload(local, digest, options.signal, options.transfer, state.remote)
      try {
        const accepted = await this.client.push({
          baseCursor: cursor, requestId: randomUUID(),
          changes: [{ key: SNAPSHOT_KEY, operation: 'put', value: next }],
        }, options.signal)
        this.replica.save({ cursor: accepted, remote: next })
        return { cursor: accepted, action: 'pushed' }
      } catch (error) {
        if (!(error instanceof RemoteSyncConflict) || attempt === 3) throw error
        // The next attempt calls `latest()` again, which pulls to the peer's
        // head and therefore reads whatever manifest it committed meanwhile.
        // Nothing needs to be carried over: the loop already re-derives the
        // peer's state each pass.
      }
    }
    throw new Error('Sync did not settle')
  }

  /**
   * Rebuild the peer's snapshot from this replica's own entries, fetching only
   * the paths whose content differs.
   *
   * The whole archive is still assembled from every entry, because that is what
   * the digest names, but an entry whose local copy already hashes to the
   * published digest is reused as it is. A scope that changed one file out of
   * a hundred therefore costs one download.
   */
  private async pullFrom(remote: SyncManifest, local: SyncSnapshot, signal: AbortSignal | undefined, transfer?: (progress: SnapshotTransfer) => void): Promise<Buffer> {
    const entries: SnapshotEntries = {}
    // A file whose local copy already hashes to the published digest is reused
    // as it is, so it is not a transfer and is not counted as one.
    const reusable = new Set<string>()
    for (const file of remote.files) {
      const localEntry = local.entries[file.path]
      if (localEntry !== undefined && snapshotDigest(localEntry) === file.digest) reusable.add(file.path)
    }
    const total = remote.files.length - reusable.size
    let done = 0
    for (const file of remote.files) {
      if (reusable.has(file.path)) {
        entries[file.path] = local.entries[file.path]!
        continue
      }
      entries[file.path] = await this.client.downloadBlob(file.digest, signal)
      transfer?.({ done: ++done, total })
    }
    // Every declared file has to be present: the assembled archive is checked
    // against the manifest's digest, and a silently missing file would only be
    // reported as a digest mismatch far from its cause.
    for (const file of remote.files) {
      if (entries[file.path] === undefined) throw new Error(`Sync snapshot is missing ${file.path}`)
      if (snapshotDigest(entries[file.path]!) !== file.digest) throw new Error(`Sync entry digest mismatch: ${file.path}`)
    }
    return this.replica.assemble(entries)
  }

  private async latest(state: SnapshotSyncState, signal?: AbortSignal): Promise<SnapshotSyncState> {
    let { cursor, remote } = state
    for (;;) {
      const page = await this.client.pull(cursor, signal)
      for (const batch of page.batches) {
        for (const change of batch.changes) {
          if (change.key !== SNAPSHOT_KEY) continue
          if (change.operation !== 'put') throw new Error('Unexpected removal of the memory snapshot')
          remote = syncManifest.parse(change.value)
        }
      }
      cursor = page.cursor
      if (cursor === page.head) return { cursor, remote }
    }
  }

  /**
   * Store every entry, then publish the manifest that names them.
   *
   * An entry whose digest already appears in the manifest this replica last
   * published is not uploaded: the peer stored that content when it accepted
   * the earlier manifest, and blobs are content-addressed and immutable. Only
   * new content is sent, so republishing a scope that changed one file uploads
   * one file.
   */
  private async upload(local: SyncSnapshot, digest: string, signal?: AbortSignal, transfer?: (progress: SnapshotTransfer) => void, known?: SyncManifest | null): Promise<SyncManifest> {
    const paths = Object.keys(local.entries).sort()
    if (paths.length === 0) throw new Error('Invalid sync snapshot size')
    const published = new Set((known?.files ?? []).map(file => file.digest))
    // Digests are taken once, because they decide both what to send and what
    // the manifest names.
    const entries = paths.map(path => {
      const bytes = local.entries[path]!
      const entryDigest = snapshotDigest(bytes)
      return { path, bytes, digest: entryDigest, changed: !published.has(entryDigest) }
    })
    // Progress counts what is actually sent. Reporting the whole file count
    // would claim a transfer that did not happen, which is the one thing this
    // counter exists to show.
    const total = entries.filter(entry => entry.changed).length
    let done = 0
    for (const entry of entries) {
      if (entry.changed) {
        await this.client.uploadBlob(entry.digest, Buffer.from(entry.bytes), signal)
        transfer?.({ done: ++done, total })
      }
    }
    return { bytes: digest, files: entries.map(entry => ({ path: entry.path, digest: entry.digest })) }
  }
}