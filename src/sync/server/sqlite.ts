import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { isActivityScope } from '../activity-protocol.ts'
import { SYNC_MAX_BATCH_BYTES, SYNC_PAGE_LIMIT, type SyncPage, type SyncPush } from '../protocol.ts'
import { SyncConflict, type SyncStore } from './store.ts'

interface StoredBatch {
  cursor: number
  requestId: string
  digest: string
  changes: string
}

/**
 * How long a block survives after it stops being named by the newest manifest.
 * It covers an upload whose manifest has not landed yet, and a replica that is
 * midway through downloading the manifest it just got.
 */
const BLOB_GRACE_MS = 10 * 60 * 1000

/** The ordered log is authoritative. A delete stays in the log as a tombstone. */
export class SqliteSyncStore implements SyncStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sync_batches (
        scope TEXT NOT NULL,
        cursor INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        changes TEXT NOT NULL,
        PRIMARY KEY (scope, cursor),
        UNIQUE (scope, request_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sync_blobs (
        scope TEXT NOT NULL,
        digest TEXT NOT NULL,
        bytes BLOB NOT NULL,
        created_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (scope, digest)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sync_activity_events (
        scope TEXT NOT NULL,
        event_id TEXT NOT NULL,
        PRIMARY KEY (scope, event_id)
      ) STRICT;
    `)
    // A store created before growth was bounded has no timestamp, so its blobs
    // are treated as old: they predate this column and are collected on the
    // next prune instead of being kept forever.
    if (!this.columnExists('sync_blobs', 'created_at')) {
      this.db.exec('ALTER TABLE sync_blobs ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0')
    }
  }

  private columnExists(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return rows.some(row => row.name === column)
  }

  close(): void {
    this.db.close()
  }

  hasBlob(scope: string, digest: string): boolean {
    return this.db.prepare('SELECT 1 FROM sync_blobs WHERE scope = ? AND digest = ?').get(scope, digest) !== undefined
  }

  readBlob(scope: string, digest: string): Uint8Array | undefined {
    return this.db.prepare('SELECT bytes FROM sync_blobs WHERE scope = ? AND digest = ?').get(scope, digest)?.bytes as Uint8Array | undefined
  }

  putBlob(scope: string, digest: string, bytes: Uint8Array): void {
    this.db.prepare('INSERT OR IGNORE INTO sync_blobs (scope, digest, bytes, created_at) VALUES (?, ?, ?, ?)')
      .run(scope, digest, bytes, Date.now())
  }

  /**
   * Drop blocks this scope's newest manifest no longer refers to.
   *
   * A blob is reachable only through the manifest a batch publishes, and a
   * replica always resolves to the newest one — `latest()` walks the log and
   * keeps the last manifest it sees. Every earlier manifest's files are
   * therefore dead once a later batch replaced it. Without this the table keeps
   * a full copy of every snapshot ever pushed, so a scope that changes daily
   * grows without bound.
   *
   * Two guards keep it from deleting a blob another write still needs:
   *
   *  - A blob is only removed once it is older than `graceMs`. An uploader
   *    writes its files before pushing the manifest that names them, so a
   *    concurrent upload's files are still fresh and survive; a replica that is
   *    midway through downloading an older manifest has that long to finish.
   *  - Nothing is removed while the scope has no manifest at all, because then
   *    there is no live set to judge against.
   *
   * A blob that does get removed under a slow reader costs that reader one
   * pull: the client re-reads the manifest and continues from the new one.
   */
  pruneBlobs(scope: string, graceMs = BLOB_GRACE_MS): number {
    const live = this.newestManifestDigests(scope)
    if (live === undefined) return 0
    const removed = this.db.prepare(
      `DELETE FROM sync_blobs
       WHERE scope = ? AND digest NOT IN (SELECT value FROM json_each(?)) AND created_at < ?`,
    ).run(scope, JSON.stringify([...live]), Date.now() - graceMs).changes
    return Number(removed)
  }

  /**
   * Every file digest the newest published manifest names, or undefined when
   * there is none.
   *
   * Reads backwards one batch at a time and stops at the first manifest, rather
   * than loading the scope's whole history: collection runs after every push,
   * and a scope that has synchronized for a long time has a long log.
   */
  private newestManifestDigests(scope: string): Set<string> | undefined {
    const statement = this.db.prepare(
      'SELECT cursor, changes FROM sync_batches WHERE scope = ? AND cursor < ? ORDER BY cursor DESC LIMIT 1',
    )
    let cursor = Number.MAX_SAFE_INTEGER
    for (;;) {
      const row = statement.get(scope, cursor) as { cursor: number; changes: string } | undefined
      if (row === undefined) return undefined
      // The next probe looks strictly below this batch, so the walk terminates.
      cursor = row.cursor
      let changes: unknown
      try { changes = JSON.parse(row.changes) } catch { changes = undefined }
      if (!Array.isArray(changes)) return undefined
      for (const change of changes) {
        const files = ((change as { value?: unknown } | undefined)?.value as { files?: unknown } | undefined)?.files
        if (!Array.isArray(files)) continue
        const digests = new Set<string>()
        for (const file of files) {
          const digest = (file as { digest?: unknown } | undefined)?.digest
          if (typeof digest === 'string') digests.add(digest)
        }
        return digests.size === 0 ? undefined : digests
      }
      // This batch carried no manifest; keep looking further back.
    }
  }

  /**
   * How many files a manifest names that the store does not hold, or undefined
   * when every one of them is present.
   *
   * Only content scopes are checked: an activity scope publishes events, which
   * carry their own value and reference no stored file.
   */
  private missingManifestBlobs(scope: string, changes: SyncPush['changes']): number | undefined {
    if (isActivityScope(scope)) return undefined
    const statement = this.db.prepare('SELECT 1 FROM sync_blobs WHERE scope = ? AND digest = ?')
    let missing = 0
    for (const change of changes) {
      // A delete publishes no manifest; only a put can name files to check.
      if (change.operation !== 'put') continue
      const files = (change.value as { files?: unknown } | undefined)?.files
      if (!Array.isArray(files)) continue
      for (const file of files) {
        const digest = (file as { digest?: unknown } | undefined)?.digest
        if (typeof digest === 'string' && statement.get(scope, digest) === undefined) missing += 1
      }
    }
    return missing === 0 ? undefined : missing
  }

  private head(scope: string): number {
    return Number(this.db.prepare('SELECT COALESCE(MAX(cursor), 0) AS cursor FROM sync_batches WHERE scope = ?').get(scope)!.cursor)
  }

  push(scope: string, input: SyncPush): { cursor: number } {
    const changes = JSON.stringify(input.changes)
    const digest = createHash('sha256').update(String(input.baseCursor)).update('\0').update(changes).digest('hex')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.db.prepare('SELECT cursor, digest FROM sync_batches WHERE scope = ? AND request_id = ?')
        .get(scope, input.requestId)
      const head = this.head(scope)
      if (existing !== undefined && existing.digest !== digest) throw new SyncConflict(head, 'Request ID was reused for a different batch')
      if (existing === undefined) {
        if (input.baseCursor !== head) throw new SyncConflict(head)
        // A manifest may only be published once the files it names are stored.
        // An uploader writes its files before pushing, but collection can run
        // in between and drop one that is older than the grace window — a large
        // file on a slow link takes longer than that window to arrive. Accepting
        // such a manifest would leave every reader with a snapshot it cannot
        // assemble, so the publish is refused and the writer uploads again.
        const missing = this.missingManifestBlobs(scope, input.changes)
        if (missing !== undefined) {
          throw new SyncConflict(head, `The snapshot names ${missing} file(s) that are not stored; upload them and publish again`)
        }
        if (isActivityScope(scope)) {
          const reserve = this.db.prepare('INSERT OR IGNORE INTO sync_activity_events (scope, event_id) VALUES (?, ?)')
          for (const change of input.changes) {
            if (reserve.run(scope, change.key).changes === 0) throw new SyncConflict(head, 'Activity event already exists')
          }
        }
        this.db.prepare('INSERT INTO sync_batches (scope, cursor, request_id, digest, changes) VALUES (?, ?, ?, ?, ?)')
          .run(scope, head + 1, input.requestId, digest, changes)
      }
      this.db.exec('COMMIT')
      // Collection runs after the commit, never inside it: the manifest that
      // justifies keeping a block has to be durable before anything is judged
      // against it. A failure here leaves the table as it was.
      if (existing === undefined) {
        try { this.pruneBlobs(scope) } catch { /* the next push collects again */ }
      }
      return { cursor: existing === undefined ? head + 1 : Number(existing.cursor) }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  pull(scope: string, cursor: number): SyncPage {
    const head = this.head(scope)
    if (cursor > head) throw new SyncConflict(head, 'Cursor is ahead of the server')
    const batches: SyncPage['batches'] = []
    let bytes = 0
    const rows = this.db.prepare(`
      SELECT cursor, request_id AS requestId, changes FROM sync_batches
      WHERE scope = ? AND cursor > ? AND cursor <= ? ORDER BY cursor LIMIT ?
    `).iterate(scope, cursor, head, SYNC_PAGE_LIMIT)
    for (const row of rows) {
      const batch = row as unknown as StoredBatch
      bytes += Buffer.byteLength(batch.changes, 'utf8')
      if (bytes > SYNC_MAX_BATCH_BYTES && batches.length > 0) break
      batches.push({ cursor: batch.cursor, requestId: batch.requestId, changes: JSON.parse(batch.changes) as SyncPush['changes'] })
    }
    return { cursor: batches.at(-1)?.cursor ?? cursor, head, batches }
  }
}
