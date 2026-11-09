import { mayRead } from '../../../core/application/src/access.ts';
import { HostEvent, MnemoWeaveError, RememberInput } from '../../../core/contracts/src/index.ts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ReadGrant } from '../../../core/contracts/src/index.ts';
import type { ReadGrantRecord } from '../../../core/contracts/src/index.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { SqliteCandidates } from './index.ts';

const DAY_MS = 86_400_000;
export const DEFAULT_LICENSE_TTL_MS = 3_600_000; // AUTH-01: offline read license, 1 hour default
export const SYNC_BATCH_MAX_ENTRIES = 200;       // SYNC-P5
export const SYNC_BATCH_MAX_BYTES = 8 * 1024 * 1024;
export const SNAPSHOT_CHUNK_BYTES = 64 * 1024 * 1024; // SYNC-P1 chunk size
export const FULL_VERIFY_INTERVAL_MS = 72 * 3_600_000; // SYNC-04: full verification every 3 days
export const REBUILD_DIFF_THRESHOLD = 0.05; // SYNC-P6: >5% partition diff triggers rebuild

export type SyncOp = 'memory' | 'revision' | 'relation' | 'remove_tombstone' | 'revoke_tombstone' | 'scope_skip';
export interface SyncChange { seq: number; op: SyncOp; entityId: string; payload: Record<string, unknown>; payloadHash: string; opAt: string; content?: string; contentPending?: boolean }
export interface SnapshotManifest { generation: number; dataTime: string; latestSeq: number; tables: Record<string, { rows: number; sha256: string }> }
export interface PartitionSummary { memoryId: string; currentRevisionId: string; contentHashes: string[] }
export interface SyncIntent { intentId: string; kind: 'remember' | 'event' | 'version_intent' | 'relation_intent'; payload: Record<string, unknown>; baselineRef?: string }

type Transaction = <T>(operation: () => T) => T;

/**
 * Server-side sync source (WP6). Serves the ordered change stream, curated snapshots,
 * partition summaries for full verification, per-host grants and offline intent intake.
 * Content enrichment happens at serve time, never inside a write transaction.
 */
export class SyncSource {
  private readonly db: DatabaseSync;
  private readonly transaction: Transaction;
  private readonly repo: SqliteCandidates;
  private readonly readContent: (providerMemoryId: string) => Promise<string>;
  constructor(repo: SqliteCandidates, readContent: (providerMemoryId: string) => Promise<string>) {
    this.repo = repo; this.readContent = readContent;
    // Access the shared handle through the repository's transaction-aware facade.
    this.db = (repo as unknown as { db: DatabaseSync }).db;
    this.transaction = (repo as unknown as { transaction: Transaction }).transaction.bind(repo);
  }
  /** AUTH-04/05: pairing issues a per-host grant covering the granted project set. */
  issueGrant(hostId: string, projects: string[], globalIncluded: boolean, ttlMs: number = DEFAULT_LICENSE_TTL_MS): ReadGrantRecord {
    if (!hostId.trim() || ttlMs <= 0) throw new Error('Grant requires a host identity and positive ttl');
    return this.transaction(() => {
      for (const project of projects) if (project !== '*') this.repo.runtime.register(project);
      const watermark = this.revocationWatermark();
      const now = Date.now();
      const grant: ReadGrantRecord = {
        grantId: randomUUID(), hostId, projects: [...projects], globalIncluded,
        issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString(), generation: watermark,
      };
      const parsed = ReadGrant.parse(grant);
      this.db.prepare(`INSERT INTO sync_grants(grant_id,host_id,projects_json,global_included,issued_at,expires_at,generation,revoked_at)
        VALUES(?,?,?,?,?,?,?,NULL)
        ON CONFLICT(host_id) DO UPDATE SET grant_id=excluded.grant_id, projects_json=excluded.projects_json, global_included=excluded.global_included,
        issued_at=excluded.issued_at, expires_at=excluded.expires_at, generation=excluded.generation, revoked_at=NULL`).run(
        parsed.grantId, hostId, JSON.stringify(parsed.projects), parsed.globalIncluded ? 1 : 0, parsed.issuedAt, parsed.expiresAt, parsed.generation);
      return parsed;
    });
  }
  /** AUTH-02: revocation is immediate (watermark + tombstone) and keeps the replica untouched. */
  revokeHost(hostId: string, global = false): void {
    this.transaction(() => {
      const now = new Date().toISOString();
      if (global) {
        const watermark = this.revocationWatermark() + 1;
        this.db.prepare('UPDATE sync_license_state SET revocation_watermark=? WHERE id=1').run(watermark);
        this.appendTombstone('revoke_tombstone', '*', { scope: 'global', revokedAt: now });
      } else {
        const result = this.db.prepare('UPDATE sync_grants SET revoked_at=? WHERE host_id=? AND revoked_at IS NULL').run(now, hostId);
        if (result.changes !== 1) throw new Error(`Unknown or already revoked host: ${hostId}`);
        this.appendTombstone('revoke_tombstone', hostId, { scope: 'host', revokedAt: now });
      }
    });
  }
  revocationWatermark(): number {
    return Number(this.db.prepare('SELECT revocation_watermark FROM sync_license_state WHERE id=1').get()!['revocation_watermark']);
  }
  grantFor(hostId: string): ReadGrantRecord | undefined {
    const row = this.db.prepare('SELECT * FROM sync_grants WHERE host_id=?').get(hostId);
    if (!row) return undefined;
    return ReadGrant.parse({
      grantId: String(row['grant_id']), hostId: String(row['host_id']), projects: JSON.parse(String(row['projects_json'])),
      globalIncluded: row['global_included'] === 1, issuedAt: String(row['issued_at']), expiresAt: String(row['expires_at']),
      generation: Number(row['generation']),
    });
  }
  /** Host-scoped revocation state (AUTH-02), visible to bridges without the grant row. */
  isHostRevoked(hostId: string): boolean {
    const row = this.db.prepare('SELECT revoked_at FROM sync_grants WHERE host_id=?').get(hostId);
    const grant = this.grantFor(hostId);
    return !grant || (row !== undefined && row['revoked_at'] !== null) || grant.generation < this.revocationWatermark();
  }
  /** AUTH-03: intents are accepted on a valid identity even when the read license expired. */
  submitIntent(hostId: string, intent: { intentId: string; kind: string; payload: Record<string, unknown>; baselineRef?: string }): { status: 'accepted' | 'isolated'; reference?: string } {
    if (!this.grantFor(hostId)) throw new Error(`Unknown host: ${hostId}`);
    if (this.isHostRevoked(hostId)) return { status: 'isolated' };
    if (!intent.intentId?.trim()) throw new Error('Intent requires an id');
    if (!['remember', 'event', 'version_intent', 'relation_intent'].includes(intent.kind)) throw new Error(`Unknown intent kind: ${intent.kind}`);
    if (intent.kind === 'event') {
      const event = HostEvent.parse(intent.payload);
      const grant = this.grantFor(hostId)!;
      if (event.projectId && (!this.repo.runtime.registered(event.projectId) || !grant.projects.includes('*') && !grant.projects.includes(event.projectId))) throw new MnemoWeaveError('UNAUTHORIZED');
      const record = this.transaction(() => {
        const recorded = this.repo.events.record(hostId, event);
        this.repo.runtime.observe(hostId, event);
        return recorded;
      });
      return { status: 'accepted', reference: record.eventId };
    }
    // remember / version_intent / relation_intent all become candidates: never auto-published.
    const request = RememberInput.parse(intent.payload);
    if (!mayRead(this.grantFor(hostId)!, request)) throw new MnemoWeaveError('UNAUTHORIZED');
    if (request.projectId && !this.repo.runtime.registered(request.projectId)) throw new MnemoWeaveError('INVALID_INPUT');
    if (request.change && !mayRead(this.grantFor(hostId)!, this.repo.catalog.get(request.change.targetMemoryId))) throw new MnemoWeaveError('UNAUTHORIZED');
    const candidate = this.repo.submit(request);
    return { status: 'accepted', reference: candidate.id };
  }
  /**
   * Ordered incremental window (SYNC-P2/P3). `windowOldestSeq` lets the Bridge detect a
   * cursor that fell behind the 30-day retention window and request a snapshot instead.
   */
  async changes(sinceSeq: number, readContent: (providerMemoryId: string) => Promise<string> = this.readContent, grant?: ReadGrantRecord): Promise<{ changes: SyncChange[]; windowOldestSeq: number; latestSeq: number }> {
    const rows = this.db.prepare('SELECT * FROM sync_log WHERE seq>? ORDER BY seq LIMIT ?').all(sinceSeq, SYNC_BATCH_MAX_ENTRIES);
    const windowRow = this.db.prepare('SELECT MIN(seq) oldest, MAX(seq) latest FROM sync_log').get()!;
    const latestSeq = Number(this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='sync_log'").get()?.['seq'] ?? 0);
    const windowOldestSeq = windowRow['oldest'] === null ? latestSeq + 1 : Number(windowRow['oldest']);
    const changes: SyncChange[] = [];
    let bytes = 0;
    for (const row of rows) {
      const payload = JSON.parse(String(row['payload_json'])) as Record<string, unknown>;
      const change: SyncChange = {
        seq: Number(row['seq']), op: row['op'] as SyncOp, entityId: String(row['entity_id']), payload,
        payloadHash: String(row['payload_hash']), opAt: String(row['op_at']),
      };
      if (grant && !this.changeAllowed(change, grant)) {
        changes.push({ seq: change.seq, op: 'scope_skip', entityId: '', payload: {}, payloadHash: createHash('sha256').update('{}').digest('hex'), opAt: change.opAt });
        continue;
      }
      if (change.op === 'revision') {
        try {
          const content = await readContent(String(payload['providerMemoryId']));
          const hash = createHash('sha256').update(content).digest('hex');
          // Content integrity is checked against the published revision hash before delivery.
          if (hash === String(payload['contentHash'])) change.content = content;
          else change.contentPending = true;
        } catch { change.contentPending = true; }
      }
      bytes += JSON.stringify(change).length;
      changes.push(change);
      if (bytes >= SYNC_BATCH_MAX_BYTES) break;
    }
    return { changes, windowOldestSeq, latestSeq };
  }
  /**
   * Curated snapshot (SYNC-P1): a fresh SQLite file holding ONLY replica-scope tables plus
   * provider content; a per-table SHA-256 manifest makes the file independently verifiable.
   * Content fetches run outside any write transaction.
   */
  async snapshot(snapshotPath: string, readContent: (providerMemoryId: string) => Promise<string> = this.readContent, grant?: ReadGrantRecord): Promise<SnapshotManifest> {
    mkdirSync(dirname(snapshotPath), { recursive: true });
    const { DatabaseSync: Ctor } = await import('node:sqlite');
    const snapshot = new Ctor(':memory:');
    try {
      snapshot.exec(`
        CREATE TABLE replica_memories(id TEXT PRIMARY KEY, current_revision_id TEXT, state TEXT, scope TEXT, applicability TEXT, project_id TEXT);
        CREATE TABLE replica_revisions(id TEXT PRIMARY KEY, memory_id TEXT, number INTEGER, parent_id TEXT, provider_memory_id TEXT, content_hash TEXT, candidate_id TEXT, published_at TEXT, effective_at TEXT, applicability TEXT, scope TEXT, project_id TEXT, content TEXT, content_pending INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE replica_relations(id TEXT PRIMARY KEY, kind TEXT, source_memory_id TEXT, source_revision_id TEXT, target_memory_id TEXT, target_revision_id TEXT, effective_at TEXT, reason TEXT, evidence_json TEXT, native_projected INTEGER);
      `);
      const captured = this.transaction(() => ({
        memories: this.db.prepare("SELECT m.*, json_extract(c.request_json,'$.projectId') project_id FROM catalog_memories m LEFT JOIN catalog_revisions r ON r.id=m.current_revision_id LEFT JOIN governance_candidates c ON c.id=r.candidate_id ORDER BY m.id").all(),
        revisions: this.db.prepare("SELECT r.*, json_extract(c.request_json,'$.projectId') project_id FROM catalog_revisions r JOIN governance_candidates c ON c.id=r.candidate_id ORDER BY r.id").all(),
        relations: this.db.prepare('SELECT * FROM catalog_relations ORDER BY id').all(),
        seq: Number(this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='sync_log'").get()?.['seq'] ?? 0),
      }));
      const allowed = new Set(captured.memories.filter(row => !grant || mayRead(grant, { scope: row['scope'] as 'project' | 'global', projectId: row['project_id'] ? String(row['project_id']) : undefined })).map(row => String(row['id'])));
      for (const row of captured.memories) {
        if (!allowed.has(String(row['id']))) continue;
        const current = row['current_revision_id'];
        snapshot.prepare('INSERT INTO replica_memories VALUES(?,?,?,?,?,?)').run(String(row['id']), current === null ? null : String(current), String(row['state']), String(row['scope']), String(row['applicability']), row['project_id'] ?? null);
      }
      const pendingFetches: Promise<void>[] = [];
      for (const row of captured.revisions) {
        if (!allowed.has(String(row['memory_id'])) || grant && !mayRead(grant, { scope: row['scope'] as 'project' | 'global', projectId: row['project_id'] ? String(row['project_id']) : undefined })) continue;
        const providerMemoryId = String(row['provider_memory_id']);
        const parentId = row['parent_id'];
        snapshot.prepare('INSERT INTO replica_revisions(id,memory_id,number,parent_id,provider_memory_id,content_hash,candidate_id,published_at,effective_at,applicability,scope,project_id,content,content_pending) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,1)')
          .run(String(row['id']), String(row['memory_id']), Number(row['revision_number']), parentId === null ? null : String(parentId), providerMemoryId, String(row['content_hash']), String(row['candidate_id']), String(row['published_at']), String(row['effective_at']), String(row['applicability']), String(row['scope']), row['project_id'] ?? null);
        pendingFetches.push((async () => {
          try {
            const content = await readContent(providerMemoryId);
            const hash = createHash('sha256').update(content).digest('hex');
            if (hash === String(row['content_hash'])) snapshot.prepare('UPDATE replica_revisions SET content=?, content_pending=0 WHERE id=?').run(content, String(row['id']));
          } catch { /* stays content_pending; recall marks completeness */ }
        })());
      }
      for (const row of captured.relations) {
        if (!allowed.has(String(row['source_memory_id'])) || !allowed.has(String(row['target_memory_id']))) continue;
        snapshot.prepare('INSERT INTO replica_relations VALUES(?,?,?,?,?,?,?,?,?,?)').run(String(row['id']), String(row['kind']), String(row['source_memory_id']), String(row['source_revision_id']), String(row['target_memory_id']), String(row['target_revision_id']), String(row['effective_at']), String(row['reason']), String(row['evidence_json']), Number(row['native_projected']));
      }
      await Promise.all(pendingFetches);
      const generation = captured.seq;
      const tables: SnapshotManifest['tables'] = {};
      const counts: Record<string, number> = {};
      for (const table of ['replica_memories', 'replica_revisions', 'replica_relations']) {
        const rows = snapshot.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
        const serialized = rows.map(row => JSON.stringify(row)).join('\n');
        tables[table] = { rows: rows.length, sha256: createHash('sha256').update(serialized).digest('hex') };
        counts[table] = rows.length;
      }
      const manifest: SnapshotManifest = { generation, dataTime: new Date().toISOString(), latestSeq: generation, tables };
      // Serialize manifest into the file itself so the Bridge can verify without a side channel.
      snapshot.exec(`CREATE TABLE snapshot_meta(id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, data_time TEXT NOT NULL, manifest_json TEXT NOT NULL)`);
      snapshot.prepare('INSERT INTO snapshot_meta VALUES(1,?,?,?)').run(manifest.generation, manifest.dataTime, JSON.stringify({ tables: manifest.tables }));
      snapshot.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
      return manifest;
    } finally { snapshot.close(); }
  }
  /** SYNC-P6: per-memory summaries for the 72-hour full verification. */
  partitionSummaries(grant?: ReadGrantRecord): PartitionSummary[] {
    const memories = this.db.prepare('SELECT id, current_revision_id FROM catalog_memories ORDER BY id').all();
    const statements = memories.filter(row => !grant || mayRead(grant, this.repo.catalog.get(String(row['id'])))).map(row => {
      const hashes = this.db.prepare('SELECT content_hash FROM catalog_revisions WHERE memory_id=? ORDER BY revision_number').all(String(row['id']))
        .map(rev => String(rev['content_hash']));
      return { memoryId: String(row['id']), currentRevisionId: row['current_revision_id'] === null ? '' : String(row['current_revision_id']), contentHashes: hashes };
    });
    return statements;
  }
  /** SYNC-06: incremental log retention — entries older than 30 days are compacted away. */
  compactSyncLog(now: Date = new Date()): number {
    return this.transaction(() => {
      const boundary = new Date(now.getTime() - 30 * DAY_MS).toISOString();
      const result = this.db.prepare('DELETE FROM sync_log WHERE op_at<?').run(boundary);
      return Number(result.changes);
    });
  }
  private changeAllowed(change: SyncChange, grant: ReadGrantRecord): boolean {
    const allowed = (id: string): boolean => { try { return mayRead(grant, this.repo.catalog.get(id)); } catch { return false; } };
    if (change.op === 'revision') return mayRead(grant, { scope: change.payload['scope'] as 'project' | 'global', projectId: change.payload['projectId'] ? String(change.payload['projectId']) : undefined });
    if (change.op === 'relation') return allowed(String(change.payload['sourceMemoryId'])) && allowed(String(change.payload['targetMemoryId']));
    if (change.op === 'revoke_tombstone') return change.entityId === '*' || change.entityId === grant.hostId;
    return allowed(change.entityId);
  }
  private appendTombstone(op: 'remove_tombstone' | 'revoke_tombstone', entityId: string, payload: Record<string, unknown>): void {
    const json = JSON.stringify(payload);
    this.db.prepare('INSERT INTO sync_log(op,entity_id,payload_json,payload_hash,op_at) VALUES(?,?,?,?,?)')
      .run(op, entityId, json, createHash('sha256').update(json).digest('hex'), new Date().toISOString());
  }
}
