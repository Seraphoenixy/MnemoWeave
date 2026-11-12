import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { VersionConflictError } from '../../../core/application/src/sync.ts';
import {
  MnemoWeaveError, SyncAccepted, SyncChangeRecord, SyncEntry, SyncPullPage, SyncSnapshot,
  SyncStream, SyncStreamGrant, SyncStreamsOutput, RULE_CAPACITY_BYTES, streamOf,
} from '../../../core/contracts/src/index.ts';
import type {
  SyncAcceptedValue, SyncChangeRecordValue, SyncChangeRequest, SyncEntryValue, SyncPullPageValue,
  SyncPullRequest, SyncSnapshotValue, SyncStreamGrantValue, SyncStreamsValue,
} from '../../../core/contracts/src/index.ts';

/**
 * Authoritative remote store for shared memory (sync protocol 2, schema v3).
 *
 * Ordering rule: `seq` is per stream, starting at 1 and contiguous. A device only ever reads
 * streams it is granted. The stream an entry belongs to is derived from the entry itself: a
 * client cannot name one, and a change whose entry names a different stream than its granted
 * write authority is refused.
 *
 * The remote never parses a body's meaning. It checks the payload hash and length, the derived
 * stream, the base version, and capacity for the rule and workspace-archive streams.
 */

const SCHEMA_VERSION = 3;
/** The rule collection capacity the remote enforces before assigning a version. */
const RULE_STREAM_CAPACITY_BYTES = RULE_CAPACITY_BYTES;

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
    if (version > SCHEMA_VERSION && version !== 2) throw new Error('Unsupported sync schema version');
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
          CREATE TABLE sync_device_streams(
            device_id TEXT NOT NULL REFERENCES sync_devices(device_id),
            stream TEXT NOT NULL,
            can_read INTEGER NOT NULL,
            can_write INTEGER NOT NULL,
            PRIMARY KEY(device_id, stream)
          );
          CREATE TABLE sync_entries(
            entry_id TEXT PRIMARY KEY,
            stream TEXT NOT NULL,
            kind TEXT NOT NULL,
            version INTEGER NOT NULL,
            content_json TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            withdrawn_at TEXT,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX sync_entries_stream ON sync_entries(stream);
          CREATE TABLE sync_entry_revisions(
            entry_id TEXT NOT NULL REFERENCES sync_entries(entry_id),
            version INTEGER NOT NULL,
            content_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(entry_id, version)
          );
          CREATE TABLE sync_changes(
            stream TEXT NOT NULL,
            seq INTEGER NOT NULL,
            change_id TEXT NOT NULL UNIQUE,
            entry_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            operation TEXT NOT NULL,
            entry_json TEXT NOT NULL,
            device_id TEXT NOT NULL,
            recorded_at TEXT NOT NULL,
            PRIMARY KEY(stream, seq)
          );
          CREATE TABLE sync_change_receipts(
            change_id TEXT PRIMARY KEY,
            stream TEXT NOT NULL,
            entry_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            seq INTEGER NOT NULL,
            request_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE TABLE sync_stream_heads(stream TEXT PRIMARY KEY, head INTEGER NOT NULL);
          PRAGMA user_version=3;
        `);
      });
    }
    if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) === 2) {
      // v2 was protocol 1: scopes, no stream derivation, no per-stream capacity. The switch
      // procedure backs the database up first; this step renames the columns it can and leaves
      // the old rows under their old key so nothing is silently reinterpreted as a stream.
      // The operator backs the database up before switching; this step never rewrites a body.
      this.transaction(() => {
        if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) !== 2) return;
        this.db.exec(`
          CREATE TABLE sync_device_streams(
            device_id TEXT NOT NULL REFERENCES sync_devices(device_id),
            stream TEXT NOT NULL,
            can_read INTEGER NOT NULL,
            can_write INTEGER NOT NULL,
            PRIMARY KEY(device_id, stream)
          );
          -- The old "global" grant covered rules and formal memories together; it becomes one
          -- grant on each stream. A project grant has no workspace id yet, so it is never copied
          -- into a stream name: it waits in the backup table for the operator's mapping, and a
          -- device without the new grant simply sees nothing on that stream.
          INSERT INTO sync_device_streams(device_id, stream, can_read, can_write)
            SELECT device_id, 'rules', can_read, can_write FROM sync_device_scopes WHERE scope='global';
          INSERT INTO sync_device_streams(device_id, stream, can_read, can_write)
            SELECT device_id, 'formal-memories', can_read, can_write FROM sync_device_scopes WHERE scope='global';
          CREATE TABLE legacy_device_scope_grants(device_id TEXT NOT NULL, scope TEXT NOT NULL, can_read INTEGER NOT NULL, can_write INTEGER NOT NULL);
          INSERT INTO legacy_device_scope_grants(device_id, scope, can_read, can_write)
            SELECT device_id, scope, can_read, can_write FROM sync_device_scopes WHERE scope LIKE 'project:%';
          CREATE TABLE sync_stream_heads(stream TEXT PRIMARY KEY, head INTEGER NOT NULL);
          CREATE TABLE legacy_scope_changes AS SELECT * FROM sync_changes;
          CREATE TABLE legacy_scope_receipts AS SELECT * FROM sync_change_receipts;
          -- The old log has no stream column and its sequence numbers meant scopes. It is already
          -- preserved in the backup tables, so the live log is rebuilt empty for the new streams.
          DROP TABLE sync_changes;
          CREATE TABLE sync_changes(
            stream TEXT NOT NULL,
            seq INTEGER NOT NULL,
            change_id TEXT NOT NULL UNIQUE,
            entry_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            operation TEXT NOT NULL,
            entry_json TEXT NOT NULL,
            device_id TEXT NOT NULL,
            recorded_at TEXT NOT NULL,
            PRIMARY KEY(stream, seq)
          );
          DROP TABLE sync_change_receipts;
          CREATE TABLE sync_change_receipts(
            change_id TEXT PRIMARY KEY,
            stream TEXT NOT NULL,
            entry_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            seq INTEGER NOT NULL,
            request_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          -- Old cursors are discarded rather than reinterpreted: every stream is re-read from a
          -- snapshot. The old entries table had no stream column, so it is rebuilt with one
          -- derived from the entry kind, and for an archive from the workspace in its payload. A
          -- legacy archive whose payload carries no workspace cannot name a stream; it keeps its
          -- row under an empty stream and is never listed, so it waits for the operator's mapping.
          CREATE TABLE sync_entries_streams(
            entry_id TEXT PRIMARY KEY,
            stream TEXT NOT NULL,
            kind TEXT NOT NULL,
            version INTEGER NOT NULL,
            content_json TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            withdrawn_at TEXT,
            updated_at TEXT NOT NULL
          );
          INSERT INTO sync_entries_streams(entry_id, stream, kind, version, content_json, payload_json, withdrawn_at, updated_at)
            SELECT entry_id,
              CASE
                WHEN kind IN ('runtime','rule') THEN 'rules'
                WHEN kind IN ('formal','formal-memory') THEN 'formal-memories'
                WHEN json_extract(payload_json, '$.workspaceId') IS NOT NULL
                  THEN 'workspace-archives:' || json_extract(payload_json, '$.workspaceId')
                ELSE ''
              END,
              CASE kind
                WHEN 'runtime' THEN 'rule'
                WHEN 'formal' THEN 'formal-memory'
                WHEN 'archive' THEN 'workspace-archive'
                ELSE kind
              END,
              version, content_json, payload_json, withdrawn_at, updated_at
            FROM sync_entries;
          DROP TABLE sync_entries;
          ALTER TABLE sync_entries_streams RENAME TO sync_entries;
          CREATE INDEX IF NOT EXISTS sync_entries_stream ON sync_entries(stream);
          DROP TABLE IF EXISTS sync_device_scopes;
          DROP TABLE IF EXISTS sync_scope_heads;
          PRAGMA user_version=3;
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

  /** Register a device and its stream grants. Tokens are stored hashed. */
  enroll(deviceId: string, token: string, grants: readonly SyncStreamGrantValue[]): void {
    const streams = grants.map((grant) => SyncStreamGrant.parse(grant));
    this.transaction(() => {
      this.db.prepare('INSERT INTO sync_devices(device_id, token_hash, created_at) VALUES(?, ?, ?)').run(deviceId, digest(token), this.now());
      for (const grant of streams) {
        this.db.prepare('INSERT INTO sync_device_streams(device_id, stream, can_read, can_write) VALUES(?, ?, ?, ?)')
          .run(deviceId, grant.stream, grant.canRead ? 1 : 0, grant.canWrite ? 1 : 0);
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
    for (const stream of this.db.prepare('SELECT stream, can_read, can_write FROM sync_device_streams WHERE device_id = ?').all(row.device_id) as { stream: string; can_read: number; can_write: number }[]) {
      grants.set(stream.stream, { canRead: stream.can_read === 1, canWrite: stream.can_write === 1 });
    }
    return { deviceId: row.device_id, grants };
  }

  private requireRead(grants: Map<string, { canRead: boolean; canWrite: boolean }>, stream: string): void {
    if (!grants.get(stream)?.canRead) throw new MnemoWeaveError('SCOPE_FORBIDDEN');
  }

  private requireWrite(grants: Map<string, { canRead: boolean; canWrite: boolean }>, stream: string): void {
    if (!grants.get(stream)?.canWrite) throw new MnemoWeaveError('SCOPE_FORBIDDEN');
  }

  streams(token: string): SyncStreamsValue {
    const { deviceId, grants } = this.identity(token);
    return SyncStreamsOutput.parse({
      deviceId,
      streams: [...grants.entries()].map(([stream, grant]) => ({ stream, canRead: grant.canRead, canWrite: grant.canWrite })),
    });
  }

  private entryRow(entryId: string): SyncEntryValue | null {
    const row = this.db.prepare('SELECT entry_id, stream, kind, version, content_json, payload_json, withdrawn_at FROM sync_entries WHERE entry_id = ?').get(entryId) as
      { entry_id: string; stream: string; kind: string; version: number; content_json: string; payload_json: string; withdrawn_at: string | null } | undefined;
    if (!row) return null;
    const revisions = this.db.prepare('SELECT version, content_json, created_at FROM sync_entry_revisions WHERE entry_id = ? ORDER BY version ASC').all(entryId) as
      { version: number; content_json: string; created_at: string }[];
    return SyncEntry.parse({
      entryId: row.entry_id,
      kind: row.kind,
      version: row.version,
      content: JSON.parse(row.content_json),
      payload: JSON.parse(row.payload_json),
      withdrawnAt: row.withdrawn_at,
      revisions: revisions.map((revision) => ({ version: revision.version, content: JSON.parse(revision.content_json), createdAt: revision.created_at })),
    });
  }

  private head(stream: string): number {
    const row = this.db.prepare('SELECT head FROM sync_stream_heads WHERE stream = ?').get(stream) as { head: number } | undefined;
    return row?.head ?? 0;
  }

  private nextSeq(stream: string): number {
    const seq = this.head(stream) + 1;
    this.db.prepare('INSERT INTO sync_stream_heads(stream, head) VALUES(?, ?) ON CONFLICT(stream) DO UPDATE SET head = excluded.head').run(stream, seq);
    return seq;
  }

  private recorded(change: SyncChangeRequest, stream: string, version: number, seq: number, entry: SyncEntryValue, deviceId: string): SyncChangeRecordValue {
    return SyncChangeRecord.parse({
      changeId: change.changeId,
      entryId: entry.entryId,
      stream,
      version,
      seq,
      operation: change.operation,
      entry,
      deviceId,
      recordedAt: entry.revisions?.at(-1)?.createdAt ?? this.now(),
    });
  }

  /**
   * The body envelope check the remote performs without reading the body: hash, length, and for
   * `plain` only, that the data really is the bytes it claims. `enc-v1` is accepted as opaque.
   */
  private assertContent(contentJson: string): void {
    const content = JSON.parse(contentJson) as { format: string; data: string; contentHash: string; byteLength: number };
    if (content.format === 'plain') {
      const bytes = Buffer.from(content.data, 'utf8');
      if (bytes.length !== content.byteLength) throw new MnemoWeaveError('INVALID_INPUT');
      if (createHash('sha256').update(bytes).digest('hex') !== content.contentHash) throw new MnemoWeaveError('INVALID_INPUT');
    }
  }

  /**
   * Capacity for the streams that have one. The rule collection is measured across the whole
   * stream, including the `\n§\n` separators, and an over-capacity write is refused before a
   * version or log entry exists. A disabled or withdrawn rule does not consume capacity.
   */
  private assertCapacity(stream: string, entryId: string, payloadJson: string, body: string, withdrawnAt: string | null): void {
    if (stream !== 'rules') return;
    const payload = JSON.parse(payloadJson) as { enabled?: boolean };
    if (payload.enabled === false || withdrawnAt !== null) return;
    let used = 0;
    let counted = 0;
    const rows = this.db.prepare("SELECT entry_id, content_json, payload_json, withdrawn_at FROM sync_entries WHERE stream='rules'").all() as
      { entry_id: string; content_json: string; payload_json: string; withdrawn_at: string | null }[];
    for (const row of rows) {
      if (row.entry_id === entryId) continue;
      if ((JSON.parse(row.payload_json) as { enabled?: boolean }).enabled === false || row.withdrawn_at !== null) continue;
      const text = (JSON.parse(row.content_json) as { data: string }).data;
      used += Buffer.byteLength(text, 'utf8') + (counted === 0 ? 0 : Buffer.byteLength('\n§\n', 'utf8'));
      counted += 1;
    }
    used += Buffer.byteLength(body, 'utf8') + (counted === 0 ? 0 : Buffer.byteLength('\n§\n', 'utf8'));
    if (used > RULE_STREAM_CAPACITY_BYTES) throw new MnemoWeaveError('RULE_CAPACITY_EXCEEDED');
  }


  submit(token: string, change: SyncChangeRequest): SyncAcceptedValue {
    const { deviceId, grants } = this.identity(token);
    let stream: string;
    try {
      stream = streamOf(change.entry.kind, change.entry.payload);
    } catch {
      throw new MnemoWeaveError('INVALID_INPUT');
    }
    const parsedStream = SyncStream.safeParse(stream);
    if (!parsedStream.success) throw new MnemoWeaveError('INVALID_INPUT');
    this.requireWrite(grants, stream);
    this.assertContent(JSON.stringify(change.entry.content));
    const requestHash = digest(JSON.stringify(change));
    return this.transaction(() => {
      const receipt = this.db.prepare('SELECT stream, entry_id, version, seq, request_hash FROM sync_change_receipts WHERE change_id = ?').get(change.changeId) as
        { stream: string; entry_id: string; version: number; seq: number; request_hash: string } | undefined;
      if (receipt) {
        if (receipt.request_hash !== requestHash) throw new MnemoWeaveError('CHANGE_ID_REUSED');
        return SyncAccepted.parse({ changeId: change.changeId, entryId: receipt.entry_id, stream: receipt.stream, version: receipt.version, seq: receipt.seq, duplicate: true });
      }
      const current = this.entryRow(change.entry.entryId);
      if (current) {
        const currentStream = streamOf(current.kind, current.payload);
        if (currentStream !== stream) throw new MnemoWeaveError('INVALID_INPUT');
      }
      if (change.operation === 'create') {
        if (current) throw new VersionConflictError(current);
        if (change.baseVersion !== 0) throw new MnemoWeaveError('INVALID_INPUT');
      } else {
        if (!current) throw new MnemoWeaveError('NOT_FOUND');
        if (change.baseVersion !== current.version) throw new VersionConflictError(current);
      }
      this.assertCapacity(stream, change.entry.entryId, JSON.stringify(change.entry.payload), change.entry.content.data, change.entry.withdrawnAt);
      const version = current ? current.version + 1 : 1;
      const createdAt = this.now();
      const seq = this.nextSeq(stream);
      const revisions = [...(current?.revisions ?? []), { version, content: change.entry.content, createdAt }]
        .filter((revision, index, all) => all.findIndex((item) => item.version === revision.version) === index);
      const entry = SyncEntry.parse({
        entryId: change.entry.entryId,
        kind: change.entry.kind,
        version,
        content: change.entry.content,
        payload: change.entry.payload,
        withdrawnAt: change.entry.withdrawnAt,
        revisions,
      });
      this.db.prepare(`
        INSERT INTO sync_entries(entry_id, stream, kind, version, content_json, payload_json, withdrawn_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entry_id) DO UPDATE SET stream=excluded.stream, kind=excluded.kind, version=excluded.version,
          content_json=excluded.content_json, payload_json=excluded.payload_json, withdrawn_at=excluded.withdrawn_at, updated_at=excluded.updated_at
      `).run(entry.entryId, stream, entry.kind, version, JSON.stringify(entry.content), JSON.stringify(entry.payload), entry.withdrawnAt, createdAt);
      this.db.prepare('INSERT INTO sync_entry_revisions(entry_id, version, content_json, created_at) VALUES(?, ?, ?, ?)')
        .run(entry.entryId, version, JSON.stringify(entry.content), createdAt);
      const record = this.recorded(change, stream, version, seq, entry, deviceId);
      this.db.prepare('INSERT INTO sync_changes(stream, seq, change_id, entry_id, version, operation, entry_json, device_id, recorded_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(stream, seq, change.changeId, entry.entryId, version, change.operation, JSON.stringify(record.entry), deviceId, createdAt);
      this.db.prepare('INSERT INTO sync_change_receipts(change_id, stream, entry_id, version, seq, request_hash, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
        .run(change.changeId, stream, change.entry.entryId, version, seq, requestHash, createdAt);
      return SyncAccepted.parse({ changeId: change.changeId, entryId: entry.entryId, stream, version, seq, duplicate: false });
    });
  }

  pull(token: string, query: SyncPullRequest): SyncPullPageValue {
    const { grants } = this.identity(token);
    this.requireRead(grants, query.stream);
    const floorRow = this.db.prepare('SELECT MIN(seq) AS value FROM sync_changes WHERE stream = ?').get(query.stream) as { value: number | null };
    // With nothing retained, a device behind the head must still take a snapshot, so the floor is
    // the first seq a reader could ever see again: head + 1.
    const retentionFloor = floorRow.value ?? (this.head(query.stream) + 1);
    const rows = this.db.prepare('SELECT change_id, entry_id, stream, version, seq, operation, entry_json, device_id, recorded_at FROM sync_changes WHERE stream = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(query.stream, query.since, query.limit + 1) as {
        change_id: string; entry_id: string; stream: string; version: number; seq: number; operation: string; entry_json: string; device_id: string; recorded_at: string;
      }[];
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit).map((row) => SyncChangeRecord.parse({
      changeId: row.change_id,
      entryId: row.entry_id,
      stream: row.stream,
      version: row.version,
      seq: row.seq,
      operation: row.operation,
      entry: JSON.parse(row.entry_json),
      deviceId: row.device_id,
      recordedAt: row.recorded_at,
    }));
    return SyncPullPage.parse({
      stream: query.stream,
      changes: page,
      nextSince: page.at(-1)?.seq ?? query.since,
      hasMore,
      retentionFloor,
    });
  }

  /**
   * What the remote recorded for a change id. This is how an unknown submission outcome is
   * resolved: the answer comes from the receipt, not from guessing about a timeout.
   */
  receipt(token: string, changeId: string): SyncAcceptedValue {
    const { grants } = this.identity(token);
    const row = this.db.prepare('SELECT stream, entry_id, version, seq FROM sync_change_receipts WHERE change_id = ?').get(changeId) as
      { stream: string; entry_id: string; version: number; seq: number } | undefined;
    if (!row) throw new MnemoWeaveError('NOT_FOUND');
    this.requireRead(grants, row.stream);
    return SyncAccepted.parse({ changeId, entryId: row.entry_id, stream: row.stream, version: row.version, seq: row.seq, duplicate: true });
  }

  entry(token: string, entryId: string): SyncEntryValue {
    const { grants } = this.identity(token);
    const entry = this.entryRow(entryId);
    if (!entry) throw new MnemoWeaveError('NOT_FOUND');
    this.requireRead(grants, streamOf(entry.kind, entry.payload));
    return entry;
  }

  /** Snapshot and cut point are read inside one transaction, so they cannot disagree. */
  snapshot(token: string, stream: string): SyncSnapshotValue {
    const { grants } = this.identity(token);
    const parsedStream = SyncStream.parse(stream);
    this.requireRead(grants, parsedStream);
    return this.readTransaction(() => {
      const asOfSeq = this.head(parsedStream);
      const ids = this.db.prepare('SELECT entry_id FROM sync_entries WHERE stream = ? ORDER BY entry_id ASC').all(parsedStream) as { entry_id: string }[];
      const entries = ids.map((item) => this.entryRow(item.entry_id)).filter((entry): entry is SyncEntryValue => entry !== null);
      return SyncSnapshot.parse({ stream: parsedStream, asOfSeq, nextSince: asOfSeq, entries });
    });
  }

  /** Test/diagnostic helper: current retained change range for a stream. */
  changeRange(stream: string): { floor: number; head: number; count: number } {
    const row = this.db.prepare('SELECT MIN(seq) AS floor, MAX(seq) AS head, COUNT(*) AS count FROM sync_changes WHERE stream = ?').get(stream) as { floor: number | null; head: number | null; count: number };
    return { floor: row.floor ?? 0, head: row.head ?? 0, count: row.count };
  }

  /**
   * Drop old changes and receipts. Deletion is always a per-stream prefix, so a device below the
   * floor sees a retention gap and takes a snapshot instead of hitting a hole in the middle of the
   * sequence. Receipts outlive changes: they are what resolves an unknown submit outcome.
   */
  prune(options: PruneOptions = {}): { changes: number; receipts: number; streams: number } {
    const at = options.now ?? this.now();
    const retentionDays = options.retentionDays ?? 90;
    const maxChangesPerStream = options.maxChangesPerStream ?? 50_000;
    const receiptDays = options.receiptDays ?? 365;
    const changeCutoff = new Date(Date.parse(at) - retentionDays * 86_400_000).toISOString();
    const receiptCutoff = new Date(Date.parse(at) - receiptDays * 86_400_000).toISOString();
    return this.transaction(() => {
      let changes = 0;
      const streams = this.db.prepare('SELECT stream, MAX(seq) AS head FROM sync_changes GROUP BY stream').all() as { stream: string; head: number }[];
      for (const { stream, head } of streams) {
        const expired = this.db.prepare("SELECT MAX(seq) AS value FROM sync_changes WHERE stream = ? AND recorded_at < ?").get(stream, changeCutoff) as { value: number | null };
        const cut = Math.max(expired.value ?? 0, Number(head) - maxChangesPerStream);
        if (cut > 0) changes += Number(this.db.prepare('DELETE FROM sync_changes WHERE stream = ? AND seq <= ?').run(stream, cut).changes);
      }
      const receipts = Number(this.db.prepare('DELETE FROM sync_change_receipts WHERE created_at < ?').run(receiptCutoff).changes);
      return { changes, receipts, streams: streams.length };
    });
  }
}

export interface PruneOptions {
  /** Changes older than this many days are dropped. */
  retentionDays?: number;
  /** Hard cap per stream; the oldest changes beyond it are dropped. */
  maxChangesPerStream?: number;
  /** Receipts older than this many days are dropped. */
  receiptDays?: number;
  /** Overrides the store clock, for tests and manual runs. */
  now?: string;
}

export type { SyncEntryValue, SyncChangeRecordValue };
