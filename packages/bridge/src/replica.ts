import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SnapshotManifest, SyncChange } from '../../infrastructure/governance/src/sync-source.ts';
import type { MemoryCatalogReader } from '../../core/application/src/catalog-ports.ts';
import { MemoryDescriptor, MnemoWeaveError } from '../../core/contracts/src/index.ts';
import type { MemoryCatalogRecord } from '../../core/contracts/src/index.ts';

const DAY_MS = 86_400_000;
export const TOMBSTONE_RETENTION_DAYS = 90; // SYNC-06: deletion/removal markers kept 90 days

export interface RecallResult { memories: { id: string; content: string; score: number; superseded?: boolean }[]; complete: boolean; dataTime: string; generation: number }

/** One current revision as the read-only UI lists it; text is present only when verified content exists. */
export interface ReplicaCurrentRow {
  memoryId: string;
  revisionId: string;
  state: 'active' | 'superseded' | 'unverified';
  scope: 'project' | 'global';
  projectId?: string;
  applicability: string;
  revisionNumber: number;
  providerMemoryId: string;
  publishedAt: string;
  effectiveAt: string;
  content: string;
}

/**
 * Local replica (WP6): authoritative Server data derived by sync — never a second write
 * authority. Application is idempotent by seq and the cursor always advances in the same
 * transaction as the applied rows (SYNC-P2/P3).
 */
export class ReplicaStore {
  private readonly db: DatabaseSync;
  private path: string;
  readonly path_: string;
  constructor(path: string) {
    this.path = path; this.path_ = path;
    mkdirSync(dirname(path), { recursive: true });
    let handle: DatabaseSync | undefined;
    try {
      handle = new DatabaseSync(path);
      handle.exec(`
        PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS replica_memories(id TEXT PRIMARY KEY, current_revision_id TEXT, state TEXT, scope TEXT, applicability TEXT);
        CREATE TABLE IF NOT EXISTS replica_revisions(id TEXT PRIMARY KEY, memory_id TEXT, number INTEGER, parent_id TEXT, provider_memory_id TEXT, content_hash TEXT, candidate_id TEXT, published_at TEXT, effective_at TEXT, applicability TEXT, scope TEXT, content TEXT, content_pending INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS replica_relations(id TEXT PRIMARY KEY, kind TEXT, source_memory_id TEXT, source_revision_id TEXT, target_memory_id TEXT, target_revision_id TEXT, effective_at TEXT, reason TEXT, evidence_json TEXT, native_projected INTEGER);
        CREATE TABLE IF NOT EXISTS replica_tombstones(seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, entity_id TEXT NOT NULL, op_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS replica_meta(id INTEGER PRIMARY KEY CHECK(id=1), applied_seq INTEGER NOT NULL, generation INTEGER NOT NULL, data_time TEXT NOT NULL, verified_at TEXT);
      `);
      for (const table of ['replica_memories', 'replica_revisions']) {
        if (!handle.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name='project_id'`).get()) handle.exec(`ALTER TABLE ${table} ADD COLUMN project_id TEXT`);
      }
      handle.prepare('INSERT OR IGNORE INTO replica_meta VALUES(1,0,0,?,NULL)').run(new Date(0).toISOString());
      // Corruption guard (SYNC-05): an unreadable replica must never serve silent empty results.
      const check = handle.prepare('PRAGMA quick_check').get();
      if (!check || String(check['quick_check']) !== 'ok') throw new Error('replica integrity check failed');
      this.db = handle;
    } catch (error) {
      // Release the handle so a rebuild can rename or replace the damaged file.
      try { handle?.close(); } catch { /* already closed */ }
      throw error;
    }
  }
  get appliedSeq(): number { return Number(this.db.prepare('SELECT applied_seq FROM replica_meta WHERE id=1').get()!['applied_seq']); }
  /** Snapshot adoption (SYNC-P7): the staged file takes the snapshot's cursor and data time. */
  adopt(meta: { appliedSeq: number; generation: number; dataTime: string; verifiedAt?: string }): void {
    this.db.prepare('UPDATE replica_meta SET applied_seq=?, generation=?, data_time=?, verified_at=? WHERE id=1')
      .run(meta.appliedSeq, meta.generation, meta.dataTime, meta.verifiedAt ?? null);
  }
  get generation(): number { return Number(this.db.prepare('SELECT generation FROM replica_meta WHERE id=1').get()!['generation']); }
  get dataTime(): string { return String(this.db.prepare('SELECT data_time FROM replica_meta WHERE id=1').get()!['data_time']); }
  get isEmpty(): boolean { return this.appliedSeq === 0 && this.dataTime === new Date(0).toISOString(); }
  close(): void { this.db.close(); }

  /** SYNC-P2/P4: apply a change batch idempotently; the cursor advances in the same transaction. */
  apply(changes: SyncChange[]): { applied: number; skipped: number } {
    let applied = 0; let skipped = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const meta = this.db.prepare('SELECT applied_seq FROM replica_meta WHERE id=1').get()!;
      const cursor = Number(meta['applied_seq']);
      for (const change of changes) {
        // Replay protection: anything at or below the cursor is discarded (SYNC-P4).
        if (change.seq <= cursor) { skipped++; continue; }
        this.applyOne(change);
        applied++;
      }
      const highest = changes.length ? Math.max(cursor, ...changes.map(change => change.seq)) : cursor;
      this.db.prepare('UPDATE replica_meta SET applied_seq=? WHERE id=1').run(highest);
      this.db.exec('COMMIT');
      return { applied, skipped };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private applyOne(change: SyncChange): void {
    const payload = change.payload;
    if (change.op === 'scope_skip') return;
    if (change.op === 'memory') {
      const currentRevisionId = payload['currentRevisionId'] === undefined || payload['currentRevisionId'] === null ? null : String(payload['currentRevisionId']);
      this.db.prepare(`INSERT INTO replica_memories(id,current_revision_id,state,scope,applicability,project_id) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET current_revision_id=excluded.current_revision_id, state=excluded.state, scope=excluded.scope, applicability=excluded.applicability, project_id=excluded.project_id`)
        .run(change.entityId, currentRevisionId, String(payload['state']), String(payload['scope']), String(payload['applicability']), typeof payload['projectId'] === 'string' ? payload['projectId'] : null);
      return;
    }
    if (change.op === 'revision') {
      const parentId = payload['parentId'] === undefined || payload['parentId'] === null ? null : String(payload['parentId']);
      // Content rides on the change envelope (change.content); payload keeps only the hash.
      const content = change.content !== undefined ? String(change.content) : payload['content'] === undefined ? null : String(payload['content']);
      const pending = content === null ? 1 : 0;
      this.db.prepare(`INSERT INTO replica_revisions(id,memory_id,number,parent_id,provider_memory_id,content_hash,candidate_id,published_at,effective_at,applicability,scope,project_id,content,content_pending)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET content=excluded.content, content_pending=excluded.content_pending`)
        .run(change.entityId, String(payload['memoryId']), Number(payload['number']), parentId, String(payload['providerMemoryId']), String(payload['contentHash']), String(payload['candidateId']), String(payload['publishedAt']), String(payload['effectiveAt']), String(payload['applicability']), String(payload['scope']), typeof payload['projectId'] === 'string' ? payload['projectId'] : null, content, pending);
      return;
    }
    if (change.op === 'relation') {
      this.db.prepare(`INSERT INTO replica_relations(id,kind,source_memory_id,source_revision_id,target_memory_id,target_revision_id,effective_at,reason,evidence_json,native_projected)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind`)
        .run(change.entityId, String(payload['kind']), String(payload['sourceMemoryId']), String(payload['sourceRevisionId']), String(payload['targetMemoryId']), String(payload['targetRevisionId']), String(payload['effectiveAt']), String(payload['reason']), JSON.stringify(payload['evidence'] ?? []), payload['nativeProjected'] === true ? 1 : 0);
      return;
    }
    // Tombstones (SYNC-P4): remove deletes the entity; revoke records the withdrawal marker.
    this.db.prepare('INSERT OR REPLACE INTO replica_tombstones(seq,kind,entity_id,op_at) VALUES(?,?,?,?)').run(change.seq, change.op, change.entityId, change.opAt);
    if (change.op === 'remove_tombstone') {
      this.db.prepare('DELETE FROM replica_memories WHERE id=?').run(change.entityId);
      this.db.prepare('DELETE FROM replica_revisions WHERE memory_id=? OR id=?').run(change.entityId, change.entityId);
      this.db.prepare('DELETE FROM replica_relations WHERE source_memory_id=? OR target_memory_id=?').run(change.entityId, change.entityId);
    }
  }
  repairFromSnapshot(path: string, memoryIds: string[]): void {
    const snapshot = new DatabaseSync(path, { readOnly: true });
    const tables = ['replica_memories', 'replica_revisions', 'replica_relations'] as const;
    try {
      const ids = new Set(memoryIds);
      const memories = snapshot.prepare('SELECT * FROM replica_memories').all().filter(row => ids.has(String(row['id'])));
      const revisions = snapshot.prepare('SELECT * FROM replica_revisions').all().filter(row => ids.has(String(row['memory_id'])));
      const relations = snapshot.prepare('SELECT * FROM replica_relations').all().filter(row => ids.has(String(row['source_memory_id'])) || ids.has(String(row['target_memory_id'])));
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const id of memoryIds) {
          this.db.prepare('DELETE FROM replica_relations WHERE source_memory_id=? OR target_memory_id=?').run(id, id);
          this.db.prepare('DELETE FROM replica_revisions WHERE memory_id=?').run(id);
          this.db.prepare('DELETE FROM replica_memories WHERE id=?').run(id);
        }
        for (const [index, rows] of [memories, revisions, relations].entries()) for (const row of rows) {
          const keys = Object.keys(row);
          this.db.prepare(`INSERT OR REPLACE INTO ${tables[index]}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...Object.values(row));
        }
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } finally { snapshot.close(); }
  }
  /** SYNC-P6: local partition summaries for full verification. */
  partitionSummaries(): { memoryId: string; currentRevisionId: string; contentHashes: string[] }[] {
    return this.db.prepare('SELECT id, current_revision_id FROM replica_memories ORDER BY id').all().map(row => ({
      memoryId: String(row['id']),
      currentRevisionId: row['current_revision_id'] === null ? '' : String(row['current_revision_id']),
      contentHashes: this.db.prepare('SELECT content_hash,content,content_pending FROM replica_revisions WHERE memory_id=? ORDER BY number').all(String(row['id'])).map(rev => rev['content_pending'] === 1 || rev['content'] === null ? `pending:${String(rev['content_hash'])}` : contentHashOf(String(rev['content'])) === String(rev['content_hash']) ? String(rev['content_hash']) : `corrupt:${String(rev['content_hash'])}`),
    }));
  }
  markVerified(at: string): void { this.db.prepare('UPDATE replica_meta SET verified_at=? WHERE id=1').run(at); }
  get verifiedAt(): string | null { const row = this.db.prepare('SELECT verified_at FROM replica_meta WHERE id=1').get()!; return row['verified_at'] === null ? null : String(row['verified_at']); }
  /** SYNC-06: tombstone retention — markers older than 90 days are purged. */
  purgeExpiredTombstones(now: Date = new Date()): number {
    const boundary = new Date(now.getTime() - TOMBSTONE_RETENTION_DAYS * DAY_MS).toISOString();
    const result = this.db.prepare('DELETE FROM replica_tombstones WHERE op_at<?').run(boundary);
    return Number(result.changes);
  }
  /** Deterministic local keyword recall over current, active, non-revoked revisions. */
  recall(query: string, limit: number): RecallResult {
    const dataTime = this.dataTime;
    const generation = this.generation;
    const revokedEntities = new Set(this.db.prepare("SELECT entity_id FROM replica_tombstones WHERE kind='revoke_tombstone'").all().map(row => String(row['entity_id'])));
    const rows = this.db.prepare(`SELECT r.content, r.content_hash, r.provider_memory_id, r.id AS revision_id, m.id AS memory_id, m.state, m.current_revision_id
      FROM replica_revisions r JOIN replica_memories m ON m.id=r.memory_id
      WHERE m.state='active' AND m.current_revision_id=r.id AND r.content IS NOT NULL AND r.content_pending=0 ORDER BY r.number`).all();
    const terms = query.trim().toLowerCase().split(/\s+/).filter(term => term.length > 0);
    const scored = rows
      .filter(row => { if (contentHashOf(String(row['content'])) !== String(row['content_hash'])) throw new MnemoWeaveError('PROVIDER_INTEGRITY'); return true; })
      .filter(row => !revokedEntities.has(String(row['memory_id'])))
      .map(row => {
        const content = String(row['content']).toLowerCase();
        const score = terms.reduce((sum, term) => sum + (content.includes(term) ? 1 : 0), 0) / Math.max(1, terms.length);
        return { id: String(row['provider_memory_id']), content: String(row['content']), score, memoryId: String(row['memory_id']) };
      })
      .filter(row => row.score > 0)
      .sort((a, b) => b.score - a.score || a.memoryId.localeCompare(b.memoryId))
      .slice(0, limit)
      .map(({ id, content, score }) => ({ id, content, score }));
    return { memories: scored, complete: this.pendingContentCount() === 0, dataTime, generation };
  }
  /** Content presence for the completeness marker (SYNC-01: full text within grant scope). */
  pendingContentCount(): number { return Number(this.db.prepare('SELECT count(*) n FROM replica_revisions WHERE content_pending=1').get()!['n']); }

  /** Read-only counts for the local UI; never a write authority and never derived from grants. */
  stats(): { memories: number; revisions: number; pendingContent: number } {
    return {
      memories: Number(this.db.prepare('SELECT count(*) n FROM replica_memories').get()!['n']),
      revisions: Number(this.db.prepare('SELECT count(*) n FROM replica_revisions').get()!['n']),
      pendingContent: this.pendingContentCount(),
    };
  }

  /**
   * Current revisions whose text is available, newest publication first. `providerMemoryIds`
   * narrows the page to what local recall selected, so the UI echoes recall's ranking.
   */
  listCurrent(limit: number, offset = 0, providerMemoryIds?: readonly string[]): ReplicaCurrentRow[] {
    const params: (string | number)[] = [];
    let filter = '';
    if (providerMemoryIds !== undefined) {
      // A caller that names no providers asked for no rows; never widen it to "all".
      const ids = providerMemoryIds.filter(id => id.length > 0);
      if (ids.length === 0) return [];
      filter = ` AND r.provider_memory_id IN (${ids.map(() => '?').join(',')})`;
      params.push(...ids);
    }
    params.push(limit, offset);
    const rows = this.db.prepare(`SELECT m.id AS memory_id, m.state, m.scope, m.applicability, m.project_id,
        r.id AS revision_id, r.number, r.provider_memory_id, r.content, r.published_at, r.effective_at
      FROM replica_memories m JOIN replica_revisions r ON r.id = m.current_revision_id
      WHERE r.content IS NOT NULL AND r.content_pending = 0${filter}
      ORDER BY r.published_at DESC, m.id ASC LIMIT ? OFFSET ?`).all(...params);
    return rows.map(row => ({
      memoryId: String(row['memory_id']),
      revisionId: String(row['revision_id']),
      state: String(row['state']) as ReplicaCurrentRow['state'],
      scope: String(row['scope']) as ReplicaCurrentRow['scope'],
      ...(row['project_id'] === null || row['project_id'] === undefined ? {} : { projectId: String(row['project_id']) }),
      applicability: String(row['applicability']),
      revisionNumber: Number(row['number']),
      providerMemoryId: String(row['provider_memory_id']),
      publishedAt: String(row['published_at']),
      effectiveAt: String(row['effective_at']),
      content: String(row['content']),
    }));
  }

  /** Public catalog descriptor for the read-only UI; the same record offline assembly reads. */
  describe(memoryId: string): MemoryCatalogRecord { return this.descriptor(memoryId); }

  /** One revision's metadata and verified text for the read-only UI; pending text is refused. */
  revision(memoryId: string, revisionId: string): { revisionId: string; number: number; publishedAt: string; effectiveAt: string; contentHash: string; content: string } {
    const row = this.db.prepare('SELECT number, published_at, effective_at, content_hash, content, content_pending FROM replica_revisions WHERE id=? AND memory_id=?').get(revisionId, memoryId);
    if (!row) throw new MnemoWeaveError('NOT_FOUND');
    const content = this.readMemory(memoryId, revisionId);
    return {
      revisionId,
      number: Number(row['number']),
      publishedAt: String(row['published_at']),
      effectiveAt: String(row['effective_at']),
      contentHash: String(row['content_hash']),
      content,
    };
  }

  /** Catalog view over the replica for offline View assembly; never a write authority. */
  catalogReader(): MemoryCatalogReader {
    return {
      get: memoryId => this.descriptor(memoryId),
      visibleProviderIds: () => this.db.prepare(`SELECT DISTINCT r.provider_memory_id FROM replica_memories m JOIN replica_revisions r ON r.id=m.current_revision_id WHERE m.state='active'`).all().map(row => String(row['provider_memory_id'])),
      currentMemoryIds: providerMemoryId => this.db.prepare('SELECT m.id FROM replica_memories m JOIN replica_revisions r ON r.id=m.current_revision_id WHERE r.provider_memory_id=? ORDER BY m.id').all(providerMemoryId).map(row => String(row['id'])),
      getConflict: () => { throw new MnemoWeaveError('NOT_FOUND'); },
    };
  }
  /** Current or selected revision text; pending content is unavailable, never empty. */
  readMemory(memoryId: string, revisionId?: string): string {
    const row = revisionId
      ? this.db.prepare('SELECT content, content_hash, content_pending FROM replica_revisions WHERE id=? AND memory_id=?').get(revisionId, memoryId)
      : this.db.prepare('SELECT r.content, r.content_hash, r.content_pending FROM replica_revisions r JOIN replica_memories m ON m.current_revision_id=r.id WHERE m.id=?').get(memoryId);
    if (!row) throw new MnemoWeaveError('NOT_FOUND');
    if (row['content'] === null || Number(row['content_pending']) === 1) throw new MnemoWeaveError('PROVIDER_UNAVAILABLE');
    if (contentHashOf(String(row['content'])) !== String(row['content_hash'])) throw new MnemoWeaveError('PROVIDER_INTEGRITY');
    return String(row['content']);
  }
  private descriptor(memoryId: string): MemoryCatalogRecord {
    const memory = this.db.prepare('SELECT * FROM replica_memories WHERE id=?').get(memoryId);
    if (!memory) throw new MnemoWeaveError('NOT_FOUND');
    const revisions = this.db.prepare('SELECT * FROM replica_revisions WHERE memory_id=? ORDER BY number').all(memoryId).map(row => ({
      ...(row['project_id'] ? { projectId: String(row['project_id']) } : {}), id: String(row['id']), memoryId: String(row['memory_id']), number: Number(row['number']),
      parentId: row['parent_id'] === null ? null : String(row['parent_id']),
      providerMemoryId: String(row['provider_memory_id']), contentHash: String(row['content_hash']),
      candidateId: String(row['candidate_id']), publishedAt: String(row['published_at']),
      effectiveAt: String(row['effective_at']), applicability: String(row['applicability']), scope: String(row['scope']),
    }));
    const relations = this.db.prepare('SELECT * FROM replica_relations WHERE source_memory_id=? OR target_memory_id=?').all(memoryId, memoryId).map(row => ({
      id: String(row['id']), kind: String(row['kind']),
      sourceMemoryId: String(row['source_memory_id']), sourceRevisionId: String(row['source_revision_id']),
      targetMemoryId: String(row['target_memory_id']), targetRevisionId: String(row['target_revision_id']),
      effectiveAt: String(row['effective_at']), reason: String(row['reason']),
      evidence: JSON.parse(String(row['evidence_json'])), nativeProjected: Number(row['native_projected']) === 1,
    }));
    return MemoryDescriptor.parse({
      ...(memory['project_id'] ? { projectId: String(memory['project_id']) } : {}), id: String(memory['id']), currentRevisionId: String(memory['current_revision_id']),
      state: String(memory['state']), scope: String(memory['scope']), applicability: String(memory['applicability']),
      revisions, relations, conflicts: [],
    });
  }
}

/** SYNC-P1: verify a snapshot file against its embedded manifest before trusting it. */
export function verifySnapshotFile(path: string): { manifest: SnapshotManifest; ok: boolean } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const meta = db.prepare('SELECT generation, data_time, manifest_json FROM snapshot_meta WHERE id=1').get()!;
    const manifest: SnapshotManifest = {
      generation: Number(meta['generation']), dataTime: String(meta['data_time']), latestSeq: Number(meta['generation']),
      tables: JSON.parse(String(meta['manifest_json']))['tables'] as SnapshotManifest['tables'],
    };
    const expectedTables = ['replica_memories', 'replica_revisions', 'replica_relations'];
    let ok = Object.keys(manifest.tables).length === expectedTables.length && expectedTables.every(table => table in manifest.tables);
    for (const [table, expected] of Object.entries(manifest.tables)) {
      if (!expectedTables.includes(table)) return { manifest, ok: false };
      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      const serialized = rows.map(row => JSON.stringify(row)).join('\n');
      const actual = createHash('sha256').update(serialized).digest('hex');
      if (actual !== expected.sha256 || rows.length !== expected.rows) ok = false;
    }
    return { manifest, ok };
  } finally { db.close(); }
}

export function contentHashOf(text: string): string { return createHash('sha256').update(text).digest('hex'); }
