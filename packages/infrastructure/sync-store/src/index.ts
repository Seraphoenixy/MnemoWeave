import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { VersionConflictError } from '../../../core/application/src/sync.ts';
import { MnemoWeaveError, SyncAccepted, SyncChangeRecord, SyncScope, SyncScopeGrant, SyncScopesOutput, SyncEntry, SyncPullPage, SyncSnapshot } from '../../../core/contracts/src/index.ts';
import type {
  SyncAcceptedValue, SyncChangeRecordValue, SyncChangeRequest, SyncEntryValue, SyncPullPageValue, SyncPullRequest, SyncScopeGrantValue, SyncScopesValue, SyncSnapshotValue,
} from '../../../core/contracts/src/index.ts';

/**
 * Authoritative remote store for shared memory.
 *
 * Ordering rule: `seq` is per scope, starting at 1 and contiguous. A device only
 * ever reads scopes it is granted, so its sequences never contain holes due to
 * other projects, and a scope cursor can never skip another project's changes.
 */

const SCHEMA_VERSION = 2;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface SyncStoreOptions {
  path: string;
  now?: () => string;
}

interface DeviceRow {
  device_id: string;
  token_hash: string;
  revoked_at: string | null;
}

export class SyncStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(options: SyncStoreOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.db = new DatabaseSync(options.path, { timeout: 5000 });
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    const version = Number(this.db.prepare('PRAGMA user_version').get()!['user_version']);
    if (version > SCHEMA_VERSION) throw new Error('Unsupported sync schema version');
    if (version === 0) {
      if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()) throw new Error('Refusing to initialize an unidentified existing database');
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE sync_devices(
            device_id TEXT PRIMARY KEY,
            token_hash TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            revoked_at TEXT
          );
          CREATE TABLE sync_device_scopes(
            device_id TEXT NOT NULL REFERENCES sync_devices(device_id),
            scope TEXT NOT NULL,
            can_read INTEGER NOT NULL,
            can_write INTEGER NOT NULL,
            PRIMARY KEY(device_id, scope)
          );
          CREATE TABLE sync_entries(
            entry_id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            kind TEXT NOT NULL,
            version INTEGER NOT NULL,
            content_json TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            withdrawn_at TEXT,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX sync_entries_scope ON sync_entries(scope);
          CREATE TABLE sync_entry_revisions(
            entry_id TEXT NOT NULL REFERENCES sync_entries(entry_id),
            version INTEGER NOT NULL,
            content_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(entry_id, version)
          );
          CREATE TABLE sync_changes(
            scope TEXT NOT NULL,
            seq INTEGER NOT NULL,
            change_id TEXT NOT NULL UNIQUE,
            entry_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            operation TEXT NOT NULL,
            entry_json TEXT NOT NULL,
            device_id TEXT NOT NULL,
            recorded_at TEXT NOT NULL,
            PRIMARY KEY(scope, seq)
          );
          CREATE TABLE sync_change_receipts(
            change_id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            entry_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            seq INTEGER NOT NULL,
            request_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          PRAGMA user_version=1;
        `);
      });
    }
    if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) === 1) {
      this.transaction(() => {
        if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) !== 1) return;
        // v2: sequence numbers must not depend on retained rows. With numbering derived
        // from MAX(seq), pruning a whole scope would restart at 1 and leave every device
        // behind it permanently stuck; the head is now its own durable value.
        this.db.exec(`
          CREATE TABLE sync_scope_heads(scope TEXT PRIMARY KEY, head INTEGER NOT NULL);
          INSERT INTO sync_scope_heads(scope, head) SELECT scope, MAX(seq) FROM sync_changes GROUP BY scope;
          PRAGMA user_version=2;
        `);
      });
    }
  }

  close(): void { this.db.close(); }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private readTransaction<T>(operation: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Register a device and its scope grants. Tokens are stored hashed. */
  enroll(deviceId: string, token: string, grants: readonly SyncScopeGrantValue[]): void {
    const scopes = grants.map((grant) => SyncScopeGrant.parse(grant));
    this.transaction(() => {
      this.db.prepare('INSERT INTO sync_devices(device_id, token_hash, created_at) VALUES(?, ?, ?)').run(deviceId, digest(token), this.now());
      for (const grant of scopes) {
        this.db.prepare('INSERT INTO sync_device_scopes(device_id, scope, can_read, can_write) VALUES(?, ?, ?, ?)')
          .run(deviceId, grant.scope, grant.canRead ? 1 : 0, grant.canWrite ? 1 : 0);
      }
    });
  }

  revoke(deviceId: string): void {
    this.db.prepare('UPDATE sync_devices SET revoked_at = ? WHERE device_id = ?').run(this.now(), deviceId);
  }

  private identity(token: string): { deviceId: string; grants: Map<string, { canRead: boolean; canWrite: boolean }> } {
    const row = this.db.prepare('SELECT device_id, token_hash, revoked_at FROM sync_devices WHERE token_hash = ?').get(digest(token)) as DeviceRow | undefined;
    if (!row) throw new MnemoWeaveError('UNAUTHORIZED');
    if (row.revoked_at) throw new MnemoWeaveError('DEVICE_REVOKED');
    const grants = new Map<string, { canRead: boolean; canWrite: boolean }>();
    for (const scope of this.db.prepare('SELECT scope, can_read, can_write FROM sync_device_scopes WHERE device_id = ?').all(row.device_id) as { scope: string; can_read: number; can_write: number }[]) {
      grants.set(scope.scope, { canRead: scope.can_read === 1, canWrite: scope.can_write === 1 });
    }
    return { deviceId: row.device_id, grants };
  }

  private requireRead(grants: Map<string, { canRead: boolean; canWrite: boolean }>, scope: string): void {
    if (!grants.get(scope)?.canRead) throw new MnemoWeaveError('SCOPE_FORBIDDEN');
  }

  private requireWrite(grants: Map<string, { canRead: boolean; canWrite: boolean }>, scope: string): void {
    if (!grants.get(scope)?.canWrite) throw new MnemoWeaveError('SCOPE_FORBIDDEN');
  }

  scopes(token: string): SyncScopesValue {
    const { deviceId, grants } = this.identity(token);
    return SyncScopesOutput.parse({
      deviceId,
      scopes: [...grants.entries()].map(([scope, grant]) => ({ scope, canRead: grant.canRead, canWrite: grant.canWrite })),
    });
  }

  private entryRow(entryId: string): SyncEntryValue | null {
    const row = this.db.prepare('SELECT entry_id, scope, kind, version, content_json, payload_json, withdrawn_at FROM sync_entries WHERE entry_id = ?').get(entryId) as
      { entry_id: string; scope: string; kind: string; version: number; content_json: string; payload_json: string; withdrawn_at: string | null } | undefined;
    if (!row) return null;
    const revisions = this.db.prepare('SELECT version, content_json, created_at FROM sync_entry_revisions WHERE entry_id = ? ORDER BY version ASC').all(entryId) as
      { version: number; content_json: string; created_at: string }[];
    return SyncEntry.parse({
      entryId: row.entry_id,
      kind: row.kind,
      scope: row.scope,
      version: row.version,
      content: JSON.parse(row.content_json),
      payload: JSON.parse(row.payload_json),
      withdrawnAt: row.withdrawn_at,
      revisions: revisions.map((revision) => ({ version: revision.version, content: JSON.parse(revision.content_json), createdAt: revision.created_at })),
    });
  }

  private head(scope: string): number {
    const row = this.db.prepare('SELECT head FROM sync_scope_heads WHERE scope = ?').get(scope) as { head: number } | undefined;
    return row?.head ?? 0;
  }

  private nextSeq(scope: string): number {
    const seq = this.head(scope) + 1;
    this.db.prepare('INSERT INTO sync_scope_heads(scope, head) VALUES(?, ?) ON CONFLICT(scope) DO UPDATE SET head = excluded.head').run(scope, seq);
    return seq;
  }

  private recorded(change: SyncChangeRequest, version: number, seq: number, entry: SyncEntryValue, deviceId: string): SyncChangeRecordValue {
    return SyncChangeRecord.parse({
      changeId: change.changeId,
      entryId: entry.entryId,
      scope: entry.scope,
      version,
      seq,
      operation: change.operation,
      entry,
      deviceId,
      recordedAt: entry.revisions?.at(-1)?.createdAt ?? this.now(),
    });
  }

  submit(token: string, change: SyncChangeRequest): SyncAcceptedValue {
    const { deviceId, grants } = this.identity(token);
    const scope = change.entry.scope;
    this.requireWrite(grants, scope);
    const requestHash = digest(JSON.stringify(change));
    return this.transaction(() => {
      const receipt = this.db.prepare('SELECT scope, entry_id, version, seq, request_hash FROM sync_change_receipts WHERE change_id = ?').get(change.changeId) as
        { scope: string; entry_id: string; version: number; seq: number; request_hash: string } | undefined;
      if (receipt) {
        if (receipt.request_hash !== requestHash) throw new MnemoWeaveError('CHANGE_ID_REUSED');
        return SyncAccepted.parse({ changeId: change.changeId, entryId: receipt.entry_id, scope: receipt.scope, version: receipt.version, seq: receipt.seq, duplicate: true });
      }
      const current = this.entryRow(change.entry.entryId);
      if (current && current.scope !== scope) throw new MnemoWeaveError('INVALID_INPUT');
      if (change.operation === 'create') {
        if (current) throw new VersionConflictError(current);
        if (change.baseVersion !== 0) throw new MnemoWeaveError('INVALID_INPUT');
      } else {
        if (!current) throw new MnemoWeaveError('NOT_FOUND');
        if (change.baseVersion !== current.version) throw new VersionConflictError(current);
      }
      const version = current ? current.version + 1 : 1;
      const createdAt = this.now();
      const seq = this.nextSeq(scope);
      const revisions = [...(current?.revisions ?? []), { version, content: change.entry.content, createdAt }]
        .filter((revision, index, all) => all.findIndex((item) => item.version === revision.version) === index);
      const entry = SyncEntry.parse({
        entryId: change.entry.entryId,
        kind: change.entry.kind,
        scope,
        version,
        content: change.entry.content,
        payload: change.entry.payload,
        withdrawnAt: change.entry.withdrawnAt,
        revisions,
      });
      this.db.prepare(`
        INSERT INTO sync_entries(entry_id, scope, kind, version, content_json, payload_json, withdrawn_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entry_id) DO UPDATE SET scope=excluded.scope, kind=excluded.kind, version=excluded.version,
          content_json=excluded.content_json, payload_json=excluded.payload_json, withdrawn_at=excluded.withdrawn_at, updated_at=excluded.updated_at
      `).run(entry.entryId, scope, entry.kind, version, JSON.stringify(entry.content), JSON.stringify(entry.payload), entry.withdrawnAt, createdAt);
      this.db.prepare('INSERT INTO sync_entry_revisions(entry_id, version, content_json, created_at) VALUES(?, ?, ?, ?)')
        .run(entry.entryId, version, JSON.stringify(entry.content), createdAt);
      const record = this.recorded(change, version, seq, entry, deviceId);
      this.db.prepare('INSERT INTO sync_changes(scope, seq, change_id, entry_id, version, operation, entry_json, device_id, recorded_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(scope, seq, change.changeId, entry.entryId, version, change.operation, JSON.stringify(record.entry), deviceId, createdAt);
      this.db.prepare('INSERT INTO sync_change_receipts(change_id, scope, entry_id, version, seq, request_hash, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
        .run(change.changeId, scope, entry.entryId, version, seq, requestHash, createdAt);
      return SyncAccepted.parse({ changeId: change.changeId, entryId: entry.entryId, scope, version, seq, duplicate: false });
    });
  }

  pull(token: string, query: SyncPullRequest): SyncPullPageValue {
    const { grants } = this.identity(token);
    this.requireRead(grants, query.scope);
    const floorRow = this.db.prepare('SELECT MIN(seq) AS value FROM sync_changes WHERE scope = ?').get(query.scope) as { value: number | null };
    // With nothing retained, a device behind the head must still take a snapshot, so the
    // floor is the first seq a reader could ever see again: head + 1.
    const retentionFloor = floorRow.value ?? (this.head(query.scope) + 1);
    const rows = this.db.prepare('SELECT change_id, entry_id, scope, version, seq, operation, entry_json, device_id, recorded_at FROM sync_changes WHERE scope = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(query.scope, query.since, query.limit + 1) as {
        change_id: string; entry_id: string; scope: string; version: number; seq: number; operation: string; entry_json: string; device_id: string; recorded_at: string;
      }[];
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit).map((row) => SyncChangeRecord.parse({
      changeId: row.change_id,
      entryId: row.entry_id,
      scope: row.scope,
      version: row.version,
      seq: row.seq,
      operation: row.operation,
      entry: JSON.parse(row.entry_json),
      deviceId: row.device_id,
      recordedAt: row.recorded_at,
    }));
    return SyncPullPage.parse({
      scope: query.scope,
      changes: page,
      nextSince: page.at(-1)?.seq ?? query.since,
      hasMore,
      retentionFloor,
    });
  }

  /**
   * Look up what the remote recorded for a change id. This is how an unknown
   * submission outcome is resolved: the answer comes from the receipt, not from
   * guessing about a timeout.
   */
  receipt(token: string, changeId: string): SyncAcceptedValue {
    const { grants } = this.identity(token);
    const row = this.db.prepare('SELECT scope, entry_id, version, seq FROM sync_change_receipts WHERE change_id = ?').get(changeId) as
      { scope: string; entry_id: string; version: number; seq: number } | undefined;
    if (!row) throw new MnemoWeaveError('NOT_FOUND');
    this.requireRead(grants, row.scope);
    return SyncAccepted.parse({ changeId, entryId: row.entry_id, scope: row.scope, version: row.version, seq: row.seq, duplicate: true });
  }

  entry(token: string, entryId: string): SyncEntryValue {    const { grants } = this.identity(token);
    const entry = this.entryRow(entryId);
    if (!entry) throw new MnemoWeaveError('NOT_FOUND');
    this.requireRead(grants, entry.scope);
    return entry;
  }

  /** Snapshot and cut point are read inside one transaction, so they cannot disagree. */
  snapshot(token: string, scope: string): SyncSnapshotValue {
    const { grants } = this.identity(token);
    const parsedScope = SyncScope.parse(scope);
    this.requireRead(grants, parsedScope);
    return this.readTransaction(() => {
      const asOfSeq = this.head(parsedScope);
      const ids = this.db.prepare('SELECT entry_id FROM sync_entries WHERE scope = ? ORDER BY entry_id ASC').all(parsedScope) as { entry_id: string }[];
      const entries = ids.map((item) => this.entryRow(item.entry_id)).filter((entry): entry is SyncEntryValue => entry !== null);
      return SyncSnapshot.parse({ scope: parsedScope, asOfSeq, nextSince: asOfSeq, entries });
    });
  }

  /** Test/diagnostic helper: current retained change range for a scope. */
  changeRange(scope: string): { floor: number; head: number; count: number } {
    const row = this.db.prepare('SELECT MIN(seq) AS floor, MAX(seq) AS head, COUNT(*) AS count FROM sync_changes WHERE scope = ?').get(scope) as { floor: number | null; head: number | null; count: number };
    return { floor: row.floor ?? 0, head: row.head ?? 0, count: row.count };
  }

  /**
   * Drop old changes and receipts. Deletion is always a per-scope prefix, so a device
   * below the floor sees a retention gap and takes a snapshot instead of hitting a
   * hole in the middle of the sequence. Receipts outlive changes: they are what
   * resolves an unknown submit outcome.
   */
  prune(options: PruneOptions = {}): { changes: number; receipts: number; scopes: number } {
    const at = options.now ?? this.now();
    const retentionDays = options.retentionDays ?? 90;
    const maxChangesPerScope = options.maxChangesPerScope ?? 50_000;
    const receiptDays = options.receiptDays ?? 365;
    const changeCutoff = new Date(Date.parse(at) - retentionDays * 86_400_000).toISOString();
    const receiptCutoff = new Date(Date.parse(at) - receiptDays * 86_400_000).toISOString();
    return this.transaction(() => {
      let changes = 0;
      const scopes = this.db.prepare('SELECT scope, MAX(seq) AS head FROM sync_changes GROUP BY scope').all() as { scope: string; head: number }[];
      for (const { scope, head } of scopes) {
        const expired = this.db.prepare("SELECT MAX(seq) AS value FROM sync_changes WHERE scope = ? AND recorded_at < ?").get(scope, changeCutoff) as { value: number | null };
        const cut = Math.max(expired.value ?? 0, Number(head) - maxChangesPerScope);
        if (cut > 0) changes += Number(this.db.prepare('DELETE FROM sync_changes WHERE scope = ? AND seq <= ?').run(scope, cut).changes);
      }
      const receipts = Number(this.db.prepare('DELETE FROM sync_change_receipts WHERE created_at < ?').run(receiptCutoff).changes);
      return { changes, receipts, scopes: scopes.length };
    });
  }
}

export interface PruneOptions {
  /** Changes older than this many days are dropped. */
  retentionDays?: number;
  /** Hard cap per scope; the oldest changes beyond it are dropped. */
  maxChangesPerScope?: number;
  /** Receipts older than this many days are dropped. */
  receiptDays?: number;
  /** Overrides the store clock, for tests and manual runs. */
  now?: string;
}

export type { SyncEntryValue, SyncChangeRecordValue };
