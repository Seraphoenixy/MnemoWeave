import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { VersionConflictError } from '../../../core/application/src/sync.ts';
import {
  MnemoWeaveError, SyncAccepted, SyncChangeRecord, SyncEntry, SyncPullPage, SyncSnapshot,
  SyncStream, SyncStreamsOutput, ARCHIVE_ACTIVE_CAPACITY_BYTES, RULE_CAPACITY_BYTES,
  FORMAL_STREAM, RULES_STREAM, streamOf,
} from '../../../core/contracts/src/index.ts';
import type {
  LegacyWorkspaceMapValue, SyncAcceptedValue, SyncChangeRecordValue, SyncChangeRequest, SyncEntryValue, SyncPullPageValue,
  SyncPullRequest, SyncSnapshotValue, SyncStreamsValue,
} from '../../../core/contracts/src/index.ts';

/**
 * Authoritative remote store for shared memory (sync protocol 2, schema v4).
 *
 * Ordering rule: `seq` is per stream, starting at 1 and contiguous. Authenticated devices share the full library.
 * The server derives the stream of each entry.
 *
 * The remote never parses a body's meaning. It checks the payload hash and length, the derived
 * stream, the base version, and capacity for the rule and workspace-archive streams.
 */

const SCHEMA_VERSION = 4;
/** The rule collection capacity the remote enforces before assigning a version. */
const RULE_STREAM_CAPACITY_BYTES = RULE_CAPACITY_BYTES;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface SyncStoreOptions {
  path: string;
  now?: () => string;
  legacyWorkspaces?: LegacyWorkspaceMapValue;
  ruleCapacityBytes?: number;
  archiveCapacityBytes?: number;
}

interface DeviceRow {
  device_id: string;
  token_hash: string;
  revoked_at: string | null;
}

export class SyncStore {
  private readonly db: DatabaseSync;
  private readonly ruleCapacityBytes: number;
  private readonly archiveCapacityBytes: number;
  private readonly now: () => string;

  constructor(options: SyncStoreOptions) {
    this.ruleCapacityBytes = options.ruleCapacityBytes ?? RULE_STREAM_CAPACITY_BYTES;
    this.archiveCapacityBytes = options.archiveCapacityBytes ?? ARCHIVE_ACTIVE_CAPACITY_BYTES;
    this.now = options.now ?? (() => new Date().toISOString());
    this.db = new DatabaseSync(options.path, { timeout: 5000 });
    try { this.initialize(options); }
    catch (error) { this.db.close(); throw error; }
  }

  private initialize(options: SyncStoreOptions): void {
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
            revoked_at TEXT,
            label TEXT
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
    if (version === 2) {
      this.db.prepare('VACUUM INTO ?').run(`${options.path}.v2-${randomUUID()}.bak`);
      this.transaction(() => {
        if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) !== 2) return;
        const mapping = options.legacyWorkspaces ?? {};
        const resolveProject = (id: string) => {
          const item = Object.hasOwn(mapping, id) ? mapping[id] : undefined;
          if (!item) throw new Error(`Missing workspace migration mapping for project ${id}`);
          return item.workspaceId;
        };
        const oldGrants = this.db.prepare('SELECT device_id, scope, can_read, can_write FROM sync_device_scopes ORDER BY device_id').all() as
          { device_id: string; scope: string; can_read: number; can_write: number }[];
        const projectGrants = new Map<string, typeof oldGrants>();
        for (const grant of oldGrants) {
          if (!grant.can_read && grant.can_write) throw new Error('Resolve legacy write-only grants before migrating');
          if (grant.scope === 'global') continue;
          if (!grant.scope.startsWith('project:')) throw new Error(`Unknown legacy scope ${grant.scope}`);
          const project = grant.scope.slice('project:'.length);
          resolveProject(project);
          const grants = projectGrants.get(project) ?? [];
          grants.push(grant);
          projectGrants.set(project, grants);
        }
        const workspaceGrants = new Map<string, typeof oldGrants>();
        for (const [project, { workspaceId }] of Object.entries(mapping)) {
          const grants = projectGrants.get(project) ?? [];
          const previous = workspaceGrants.get(workspaceId);
          const permissions = (items: typeof oldGrants) => JSON.stringify(items.map(item => [item.device_id, item.can_read, item.can_write]));
          if (previous && permissions(previous) !== permissions(grants)) {
            throw new Error(`Legacy projects mapped to ${workspaceId} have different device permissions`);
          }
          workspaceGrants.set(workspaceId, grants);
        }
        this.db.exec(`
          CREATE TABLE sync_device_streams(
            device_id TEXT NOT NULL REFERENCES sync_devices(device_id),
            stream TEXT NOT NULL,
            can_read INTEGER NOT NULL,
            can_write INTEGER NOT NULL,
            PRIMARY KEY(device_id, stream)
          );
          INSERT INTO sync_device_streams(device_id, stream, can_read, can_write)
            SELECT device_id, 'rules', can_read, can_write FROM sync_device_scopes WHERE scope='global';
          INSERT INTO sync_device_streams(device_id, stream, can_read, can_write)
            SELECT device_id, 'formal-memories', can_read, can_write FROM sync_device_scopes WHERE scope='global';
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
            SELECT entry_id, '',
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
          CREATE TABLE sync_migrated_streams(stream TEXT PRIMARY KEY);
          PRAGMA user_version=3;
        `);
        const insertGrant = this.db.prepare('INSERT INTO sync_device_streams VALUES(?, ?, ?, ?)');
        for (const [workspaceId, grants] of workspaceGrants) {
          for (const grant of grants) {
            insertGrant.run(grant.device_id, `workspace-archives:${workspaceId}`, grant.can_read, grant.can_write);
          }
        }
        const updateEntry = this.db.prepare('UPDATE sync_entries SET stream=?, payload_json=? WHERE entry_id=?');
        const entries = this.db.prepare('SELECT * FROM sync_entries').all() as
          { entry_id: string; kind: string; version: number; content_json: string; payload_json: string; withdrawn_at: string | null }[];
        for (const row of entries) {
          const { projectId, scope: _scope, ...legacy } = JSON.parse(row.payload_json);
          const payload = row.kind === 'workspace-archive'
            ? { ...legacy, workspaceId: typeof projectId === 'string' ? resolveProject(projectId) : legacy.workspaceId,
                state: legacy.state ?? 'active', archivedAt: legacy.archivedAt ?? null }
            : row.kind === 'rule' ? { ...legacy, importance: legacy.importance ?? 'normal', pinned: legacy.pinned ?? false } : legacy;
          const entry = SyncEntry.parse({
            entryId: row.entry_id, kind: row.kind, version: row.version, content: JSON.parse(row.content_json),
            payload, withdrawnAt: row.withdrawn_at,
          });
          updateEntry.run(streamOf(entry.kind, entry.payload), JSON.stringify(entry.payload), entry.entryId);
        }
        this.db.exec('INSERT INTO sync_migrated_streams SELECT DISTINCT stream FROM sync_entries');
      });
    }
    if (version === 3) this.db.prepare('VACUUM INTO ?').run(`${options.path}.v3-${randomUUID()}.bak`);
    this.transaction(() => {
      if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) !== 3) return;
      if (version !== 0) this.db.exec('ALTER TABLE sync_devices ADD COLUMN label TEXT');
      this.db.exec(`
        CREATE TABLE sync_auth_registration(
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          access_salt TEXT NOT NULL, srp_salt TEXT NOT NULL, verifier TEXT NOT NULL
        );
        DROP TABLE sync_device_streams;
        PRAGMA user_version=4;
      `);
    });
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

  enroll(deviceId: string, token: string, label?: string): void {
    this.db.prepare('INSERT INTO sync_devices(device_id, token_hash, created_at, label) VALUES(?, ?, ?, ?)').run(deviceId, digest(token), this.now(), label ?? null);
  }

  devices() {
    return this.db.prepare(`
      SELECT device_id AS deviceId, label, created_at AS createdAt, revoked_at AS revokedAt
      FROM sync_devices ORDER BY created_at, device_id
    `).all();
  }

  authRegistration(): { accessSalt: string; srpSalt: string; verifier: string } | undefined {
    return this.db.prepare('SELECT access_salt AS accessSalt, srp_salt AS srpSalt, verifier FROM sync_auth_registration WHERE singleton = 1').get() as ReturnType<SyncStore['authRegistration']>;
  }

  initializeAuth(registration: NonNullable<ReturnType<SyncStore['authRegistration']>>, deviceId: string, token: string, label: string): void {
    this.transaction(() => {
      if (this.authRegistration()) throw new MnemoWeaveError('VERSION_CONFLICT');
      this.db.prepare('INSERT INTO sync_auth_registration VALUES(1, ?, ?, ?)').run(registration.accessSalt, registration.srpSalt, registration.verifier);
      this.enroll(deviceId, token, label);
    });
  }

  revoke(deviceId: string): boolean {
    return this.db.prepare('UPDATE sync_devices SET revoked_at = COALESCE(revoked_at, ?) WHERE device_id = ?')
      .run(this.now(), deviceId).changes !== 0;
  }

  requireActiveDevice(deviceId: string): void {
    if (!this.db.prepare('SELECT 1 FROM sync_devices WHERE device_id = ? AND revoked_at IS NULL').get(deviceId)) {
      throw new MnemoWeaveError('DEVICE_REVOKED');
    }
  }

  private identity(token: string): string {
    const row = this.db.prepare('SELECT device_id, revoked_at FROM sync_devices WHERE token_hash = ?').get(digest(token)) as DeviceRow | undefined;
    if (!row) throw new MnemoWeaveError('UNAUTHORIZED');
    if (row.revoked_at) throw new MnemoWeaveError('DEVICE_REVOKED');
    return row.device_id;
  }

  streams(token: string): SyncStreamsValue {
    const deviceId = this.identity(token);
    const streams = new Set([RULES_STREAM, FORMAL_STREAM]);
    for (const row of this.db.prepare('SELECT DISTINCT stream FROM sync_entries').all()) streams.add(SyncStream.parse(row['stream']));
    return SyncStreamsOutput.parse({
      deviceId,
      streams: [...streams].sort().map(stream => ({ stream, canRead: true, canWrite: true })),
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

  private assertCapacity(stream: string, entry: SyncChangeRequest['entry']): void {
    if (stream === FORMAL_STREAM) return;
    const rule = stream === RULES_STREAM;
    const separator = rule ? Buffer.byteLength('\n§\n', 'utf8') : 0;
    const rows = this.db.prepare(`
      SELECT entry_id, json_extract(content_json, '$.byteLength') AS bytes FROM sync_entries
      WHERE stream=? AND withdrawn_at IS NULL
        AND (? OR COALESCE(json_extract(payload_json, '$.state'), 'active') = 'active')
    `).all(stream, Number(rule)) as { entry_id: string; bytes: number }[];
    const previous = rows.find(row => row.entry_id === entry.entryId);
    const archived = 'state' in entry.payload && entry.payload.state === 'archived';
    const included = entry.withdrawnAt === null && (rule || !archived);
    const before = rows.reduce((sum, row) => sum + row.bytes, 0) + Math.max(0, rows.length - 1) * separator;
    const count = rows.length - Number(previous !== undefined) + Number(included);
    const after = before - Math.max(0, rows.length - 1) * separator - (previous?.bytes ?? 0)
      + (included ? entry.content.byteLength : 0) + Math.max(0, count - 1) * separator;
    if (after > (rule ? this.ruleCapacityBytes : this.archiveCapacityBytes)
      && (rule ? after >= before : included)) {
      throw new MnemoWeaveError(rule ? 'RULE_CAPACITY_EXCEEDED' : 'ARCHIVE_CAPACITY_EXCEEDED');
    }
  }

  submit(token: string, change: SyncChangeRequest): SyncAcceptedValue {
    const deviceId = this.identity(token);
    let stream: string;
    try {
      stream = streamOf(change.entry.kind, change.entry.payload);
    } catch {
      throw new MnemoWeaveError('INVALID_INPUT');
    }
    const parsedStream = SyncStream.safeParse(stream);
    if (!parsedStream.success) throw new MnemoWeaveError('INVALID_INPUT');
    this.assertContent(JSON.stringify(change.entry.content));
    const requestHash = digest(JSON.stringify(change));
    return this.transaction(() => {
      const receipt = this.db.prepare('SELECT stream, entry_id, version, seq, request_hash, created_at FROM sync_change_receipts WHERE change_id = ?').get(change.changeId) as
        { stream: string; entry_id: string; version: number; seq: number; request_hash: string; created_at: string } | undefined;
      if (receipt) {
        if (receipt.request_hash !== requestHash) throw new MnemoWeaveError('CHANGE_ID_REUSED');
        return SyncAccepted.parse({ changeId: change.changeId, entryId: receipt.entry_id, stream: receipt.stream, version: receipt.version, seq: receipt.seq, duplicate: true, confirmedAt: receipt.created_at });
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
      if (stream === FORMAL_STREAM && change.operation === 'create' && change.entry.withdrawnAt === null
        && change.entry.content.format === 'plain') {
        const match = this.db.prepare(`
          SELECT entry_id, version FROM sync_entries
          WHERE stream=? AND withdrawn_at IS NULL AND json_extract(content_json, '$.format')='plain'
            AND json_extract(content_json, '$.contentHash')=? AND json_extract(content_json, '$.byteLength')=?
          ORDER BY entry_id LIMIT 1
        `).get(stream, change.entry.content.contentHash, change.entry.content.byteLength) as
          { entry_id: string; version: number } | undefined;
        if (match) {
          const confirmedAt = this.now();
          this.db.prepare('INSERT INTO sync_change_receipts(change_id, stream, entry_id, version, seq, request_hash, created_at) VALUES(?, ?, ?, ?, 0, ?, ?)')
            .run(change.changeId, stream, match.entry_id, match.version, requestHash, confirmedAt);
          return SyncAccepted.parse({ changeId: change.changeId, entryId: match.entry_id, stream, version: match.version, seq: 0, duplicate: true, confirmedAt });
        }
      }
      this.assertCapacity(stream, change.entry);
      const version = current ? current.version + 1 : 1;
      const createdAt = this.now();
      const payload = change.entry.kind === 'workspace-archive' && 'workspaceId' in change.entry.payload
        ? { ...change.entry.payload, archivedAt: change.entry.payload.state === 'archived'
          ? createdAt : null }
        : change.entry.payload;
      const seq = this.nextSeq(stream);
      const revisions = [...(current?.revisions ?? []), { version, content: change.entry.content, createdAt }]
        .filter((revision, index, all) => all.findIndex((item) => item.version === revision.version) === index);
      const entry = SyncEntry.parse({
        entryId: change.entry.entryId,
        kind: change.entry.kind,
        version,
        content: change.entry.content,
        payload,
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
      return SyncAccepted.parse({ changeId: change.changeId, entryId: entry.entryId, stream, version, seq, duplicate: false, confirmedAt: createdAt });
    });
  }

  pull(token: string, query: SyncPullRequest): SyncPullPageValue {
    this.identity(token);
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
      ...(query.since === 0 && this.db.prepare("SELECT name FROM sqlite_master WHERE name='sync_migrated_streams'").get()
        && this.db.prepare('SELECT 1 FROM sync_migrated_streams WHERE stream=?').get(query.stream)
        ? { snapshotAtStart: true } : {}),
    });
  }

  /**
   * What the remote recorded for a change id. This is how an unknown submission outcome is
   * resolved: the answer comes from the receipt, not from guessing about a timeout.
   */
  receipt(token: string, changeId: string): SyncAcceptedValue {
    this.identity(token);
    const row = this.db.prepare('SELECT stream, entry_id, version, seq, created_at FROM sync_change_receipts WHERE change_id = ?').get(changeId) as
      { stream: string; entry_id: string; version: number; seq: number; created_at: string } | undefined;
    if (!row) throw new MnemoWeaveError('NOT_FOUND');
    return SyncAccepted.parse({ changeId, entryId: row.entry_id, stream: row.stream, version: row.version, seq: row.seq, duplicate: true, confirmedAt: row.created_at });
  }

  entry(token: string, entryId: string): SyncEntryValue {
    this.identity(token);
    const entry = this.entryRow(entryId);
    if (!entry) throw new MnemoWeaveError('NOT_FOUND');
    return entry;
  }

  /** Snapshot and cut point are read inside one transaction, so they cannot disagree. */
  snapshot(token: string, stream: string): SyncSnapshotValue {
    this.identity(token);
    const parsedStream = SyncStream.parse(stream);
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
