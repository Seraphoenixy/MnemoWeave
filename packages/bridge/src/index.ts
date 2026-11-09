import { HostEvent } from '../../core/contracts/src/index.ts';
import type { RuntimeContext } from '../../core/contracts/src/index.ts';
import { MemoryRuntime } from '../../core/application/src/runtime.ts';
import { mayRead } from '../../core/application/src/access.ts';
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, copyFileSync, existsSync, statfsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MnemoWeaveError, ReadGrant } from '../../core/contracts/src/index.ts';
import type { ReadGrantRecord, ViewRecord } from '../../core/contracts/src/index.ts';
import { ViewAssembler, deepFreezeView } from '../../core/application/src/view.ts';
import type { ViewSource } from '../../core/application/src/view.ts';
import { ReplicaStore, verifySnapshotFile } from './replica.ts';
import type { SyncChange } from '../../infrastructure/governance/src/sync-source.ts';
import { uiIntents, uiMemories, uiMemory, uiRevision, uiStatus } from './ui-read.ts';
import type { UiIntentsRecord, UiMemoryDetailRecord, UiMemoryListRecord, UiMemoriesInput, UiReadState, UiRevisionRecord, UiStatusRecord } from './ui-read.ts';

export type { ReplicaStore, RecallResult, verifySnapshotFile, contentHashOf } from './replica.ts';
export type { SyncChange, SyncOp, SnapshotManifest, PartitionSummary, SyncIntent } from '../../infrastructure/governance/src/sync-source.ts';

/** Server-facing sync channel; the library contract WP7 adapters will carry over HTTP. */
export interface SyncChannel {
  runtimeContext?(input: { sessionId: string; projectId?: string | undefined; task?: string }): Promise<RuntimeContext>;
  changes(sinceSeq: number): Promise<{ changes: SyncChange[]; windowOldestSeq: number; latestSeq: number }>;
  snapshot(): Promise<{ path: string; latestSeq: number }>;
  partitionSummaries(): Promise<{ memoryId: string; currentRevisionId: string; contentHashes: string[] }[]>;
  issueGrant(hostId: string): Promise<ReadGrantRecord>;
  licenseWatermark(): Promise<number>;
  isRevoked(hostId: string): Promise<boolean>;
  submitIntent(hostId: string, intent: { intentId: string; kind: string; payload: Record<string, unknown>; baselineRef: string | undefined }): Promise<{ status: 'accepted' | 'isolated'; reference?: string }>;
}

const MIN_FREE_BYTES_DEFAULT = 100 * 1024 * 1024; // SYNC-P5: stop receiving below this floor

export type IntentKind = 'remember' | 'event' | 'version_intent' | 'relation_intent';
export interface QueuedIntent {
  intentId: string; hostId: string; kind: IntentKind; payload: Record<string, unknown>;
  baselineRef: string | undefined; createdAt: string; state: 'queued' | 'acknowledged' | 'isolated'; receiptRef: string | undefined;
}

/** Bridge-local identity store: grants and the offline intent queue survive replica rebuilds. */
class BridgeStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(join(path, '..'), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS bridge_runtime(session_id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, context_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bridge_grants(host_id TEXT PRIMARY KEY, grant_json TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS intent_queue(intent_id TEXT PRIMARY KEY, host_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, baseline_ref TEXT, created_at TEXT NOT NULL, state TEXT NOT NULL, receipt_ref TEXT);
    `);
  }
  runtimeContext(sessionId: string, grantId: string): RuntimeContext | undefined {
    const row = this.db.prepare('SELECT context_json FROM bridge_runtime WHERE session_id=? AND grant_id=?').get(sessionId, grantId);
    return row ? JSON.parse(String(row['context_json'])) as RuntimeContext : undefined;
  }
  hasQueuedEvents(sessionId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM intent_queue WHERE state='queued' AND kind='event' AND json_extract(payload_json,'$.sessionId')=? LIMIT 1").get(sessionId);
  }
  saveContext(context: RuntimeContext, grantId: string): void {
    this.db.prepare('INSERT OR REPLACE INTO bridge_runtime VALUES(?,?,?)').run(context.sessionId, grantId, JSON.stringify(context));
  }
  saveGrant(grant: ReadGrantRecord): void {
    this.db.prepare(`INSERT INTO bridge_grants(host_id,grant_json,revoked) VALUES(?,?,0)
      ON CONFLICT(host_id) DO UPDATE SET grant_json=excluded.grant_json, revoked=CASE WHEN json_extract(bridge_grants.grant_json,'$.grantId')=json_extract(excluded.grant_json,'$.grantId') THEN bridge_grants.revoked ELSE 0 END`).run(grant.hostId, JSON.stringify(grant));
  }
  grantFor(hostId: string): { grant: ReadGrantRecord; revoked: boolean } | undefined {
    const row = this.db.prepare('SELECT grant_json, revoked FROM bridge_grants WHERE host_id=?').get(hostId);
    if (!row) return undefined;
    return { grant: ReadGrant.parse(JSON.parse(String(row['grant_json']))), revoked: row['revoked'] === 1 };
  }
  markRevoked(hostId: string): void { this.db.prepare('UPDATE bridge_grants SET revoked=1 WHERE host_id=?').run(hostId); }
  queueIntent(intent: { hostId: string; kind: IntentKind; payload: Record<string, unknown>; baselineRef: string | undefined; intentId: string | undefined }): QueuedIntent {
    const record: QueuedIntent = {
      intentId: intent.intentId ?? randomUUID(), hostId: intent.hostId, kind: intent.kind,
      payload: intent.payload, baselineRef: intent.baselineRef, createdAt: new Date().toISOString(),
      state: 'queued', receiptRef: undefined,
    };
    const existing = this.db.prepare('SELECT * FROM intent_queue WHERE intent_id=?').get(record.intentId);
    if (existing) {
      if (existing['host_id'] !== record.hostId || existing['kind'] !== record.kind || existing['payload_json'] !== JSON.stringify(record.payload) || existing['baseline_ref'] !== (record.baselineRef ?? null)) throw new MnemoWeaveError('IDEMPOTENCY_CONFLICT');
      return { ...record, createdAt: String(existing['created_at']), state: existing['state'] as QueuedIntent['state'], receiptRef: existing['receipt_ref'] === null ? undefined : String(existing['receipt_ref']) };
    }
    this.db.prepare('INSERT INTO intent_queue(intent_id,host_id,kind,payload_json,baseline_ref,created_at,state,receipt_ref) VALUES(?,?,?,?,?,?,?,?)')
      .run(record.intentId, record.hostId, record.kind, JSON.stringify(record.payload), record.baselineRef ?? null, record.createdAt, record.state, record.receiptRef ?? null);
    return record;
  }
  intentsFor(hostId: string): QueuedIntent[] {
    return this.db.prepare("SELECT * FROM intent_queue WHERE host_id=? AND state IN ('queued','isolated') ORDER BY created_at").all(hostId).map(row => ({
      intentId: String(row['intent_id']), hostId: String(row['host_id']), kind: row['kind'] as IntentKind,
      payload: JSON.parse(String(row['payload_json'])) as Record<string, unknown>,
      baselineRef: row['baseline_ref'] === null ? undefined : String(row['baseline_ref']),
      createdAt: String(row['created_at']), state: row['state'] as QueuedIntent['state'],
      receiptRef: row['receipt_ref'] === null ? undefined : String(row['receipt_ref']),
    }));
  }
  markIntent(intentId: string, state: QueuedIntent['state'], receiptRef?: string): void {
    this.db.prepare('UPDATE intent_queue SET state=?, receipt_ref=? WHERE intent_id=?').run(state, receiptRef ?? null, intentId);
  }
  close(): void { this.db.close(); }
}

export interface BridgeReadResult {
  status: 'ok' | 'unavailable' | 'unauthorized' | 'corrupted';
  reason?: string;
  recall?: { memories: { id: string; content: string; score: number }[]; complete: boolean; dataTime: string; stale: boolean };
}

/**
 * Shared Bridge (WP6): local-first reads with explicit availability, snapshot/incremental
 * sync per the accepted protocol, and an offline intent queue the Server re-validates.
 */
export class Bridge {
  private readonly store: BridgeStore;
  private replica: ReplicaStore | undefined;
  private replicaCorrupted = false;
  readonly hostId: string;
  readonly directory: string;
  private readonly channel: SyncChannel;
  private readonly options: { minFreeBytes?: number };
  private viewGeneration = 0;
  private draining: Promise<{ submitted: number; acknowledged: number; isolated: number }> | undefined;
  private syncing: Promise<{ mode: 'snapshot' | 'incremental' | 'skipped'; reason?: string; applied: number; skipped: number }> | undefined;
  constructor(directory: string, hostId: string, channel: SyncChannel, options: { minFreeBytes?: number } = {}) {
    this.directory = directory; this.hostId = hostId; this.channel = channel; this.options = options;
    mkdirSync(directory, { recursive: true });
    this.store = new BridgeStore(join(directory, 'bridge.db'));
    const replicaPath = join(directory, 'replica.db');
    if (!existsSync(replicaPath) && existsSync(join(directory, 'replica.previous.db'))) copyFileSync(join(directory, 'replica.previous.db'), replicaPath);
    if (existsSync(replicaPath)) {
      try { this.replica = new ReplicaStore(replicaPath); }
      catch { this.replicaCorrupted = true; }
    }
  }
  close(): void { this.replica?.close(); this.store.close(); }

  /** AUTH-04: whether an operator-issued grant has been fetched and stored locally. */
  get paired(): boolean { return this.store.grantFor(this.hostId) !== undefined; }
  /** AUTH-04: pairing stores the server-issued grant locally. */
  async pair(): Promise<ReadGrantRecord> {
    const grant = await this.channel.issueGrant(this.hostId);
    const old = this.store.grantFor(this.hostId);
    if (old && old.grant.grantId !== grant.grantId) this.replicaCorrupted = true;
    if (grant.hostId !== this.hostId) throw new MnemoWeaveError('UNAUTHORIZED');
    this.store.saveGrant(grant);
    return grant;
  }
  /** AUTH-02: revocation stops reads immediately; the replica and intents are kept. */
  async isRevokedNow(): Promise<boolean> {
    const record = this.store.grantFor(this.hostId);
    if (!record) return false;
    if (record.revoked) return true;
    if (await this.channel.isRevoked(this.hostId)) { this.store.markRevoked(this.hostId); return true; }
    const watermark = await this.channel.licenseWatermark();
    if (record.grant.generation < watermark) { this.store.markRevoked(this.hostId); return true; }
    return false;
  }
  /**
   * Offline View assembly from the replica (HOST-05/SYNC-05). License expiry and cached
   * revocation still gate delivery; a missing or corrupt replica reports unavailability.
   */
  async localView(input: { query: string | null; sessionId?: string; projectId?: string | undefined; task?: string | undefined; budgetTokens?: number | undefined; pinned?: ReadonlyArray<{ memoryId: string; tier: 'critical' | 'normal' }> | undefined }): Promise<ViewRecord> {
    const record = this.store.grantFor(this.hostId);
    if (!record || record.revoked) throw new MnemoWeaveError('UNAUTHORIZED');
    if (!this.replica || this.replicaCorrupted) throw new MnemoWeaveError('PROVIDER_UNAVAILABLE');
    const replica = this.replica;
    const source: ViewSource = {
      catalogReader: replica.catalogReader(),
      recall: async ({ query, limit }) => {
        const result = replica.recall(query, limit);
        return { memories: result.memories.map(memory => ({ id: memory.id, content: memory.content, score: memory.score })), complete: result.complete };
      },
      readMemory: async ({ memoryId, revisionId }) => ({ content: replica.readMemory(memoryId, revisionId) }),
    };
    const assembler = new ViewAssembler(source, { generation: this.viewGeneration++ });
    if (input.sessionId && this.channel.runtimeContext) {
      let context = this.store.runtimeContext(input.sessionId, record.grant.grantId);
      try { if (!context || !this.store.hasQueuedEvents(input.sessionId)) context = await this.channel.runtimeContext({ sessionId: input.sessionId, ...(input.projectId ? { projectId: input.projectId } : {}), ...(input.task ? { task: input.task } : {}) }); this.store.saveContext(context, record.grant.grantId); }
      catch (error) { if (error instanceof MnemoWeaveError && error.code === 'UNAUTHORIZED') throw error; }
      if (!context || context.closed) throw new MnemoWeaveError('PROVIDER_UNAVAILABLE');
      const cached = context;
      const runtime = new MemoryRuntime({
        context: () => cached, registered: id => id === cached.projectId,
        observe: () => { throw new MnemoWeaveError('INVALID_STATE'); }, pin: () => { throw new MnemoWeaveError('UNAUTHORIZED'); }, register: () => { throw new MnemoWeaveError('UNAUTHORIZED'); }, closeSession: () => { throw new MnemoWeaveError('INVALID_STATE'); },
      }, assembler);
      const view = await runtime.view(record.grant, { ...input, query: input.query ?? undefined, pinned: input.pinned ? [...input.pinned] : undefined });
      return deepFreezeView({ ...view, delivery: 'local_replica' as const, dataTime: replica.dataTime, stale: Date.now() - Date.parse(replica.dataTime) > 600_000 });
    }
    return assembler.assemble({
      grant: record.grant,
      ...(input.query !== null ? { query: input.query } : {}),
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
    });
  }
  /** Cached grant for offline assembly; the Bridge never issues one. */
  storedGrant(): ReadGrantRecord | undefined { return this.store.grantFor(this.hostId)?.grant; }
  /** Cached revocation flag so an unreachable Server does not silently re-enable reads. */
  cachedRevoked(): boolean { return this.store.grantFor(this.hostId)?.revoked ?? false; }
  private underDiskFloor(): boolean {
    const floor = this.options.minFreeBytes ?? MIN_FREE_BYTES_DEFAULT;
    try { const stats = statfsSync(this.directory); return stats.bavail * stats.bsize < floor; } catch { return false; }
  }
  /**
   * One sync pass (SYNC-P3/P5/P7): rebuild from snapshot when the replica is missing,
   * corrupted or its cursor fell behind the server window; otherwise apply batches.
   */
  sync(now: Date = new Date()): Promise<{ mode: 'snapshot' | 'incremental' | 'skipped'; reason?: string; applied: number; skipped: number }> {
    if (this.syncing) return this.syncing;
    this.syncing = this.syncOnce(now).finally(() => { this.syncing = undefined; });
    return this.syncing;
  }
  private async syncOnce(now: Date): Promise<{ mode: 'snapshot' | 'incremental' | 'skipped'; reason?: string; applied: number; skipped: number }> {
    const record = this.store.grantFor(this.hostId);
    if (!record) return { mode: 'skipped', reason: 'unpaired', applied: 0, skipped: 0 };
    if (await this.isRevokedNow()) return { mode: 'skipped', reason: 'revoked', applied: 0, skipped: 0 };
    if (this.underDiskFloor()) return { mode: 'skipped', reason: 'disk_floor', applied: 0, skipped: 0 };
    if (this.replicaCorrupted || !this.replica || this.replica.isEmpty) {
      // Capture the reason first: rebuild() clears the corruption flag on success.
      const reason = this.replicaCorrupted ? 'corrupted' : this.replica ? 'empty' : 'initial';
      await this.rebuild();
      return { mode: 'snapshot', reason, applied: 0, skipped: 0 };
    }
    const window = await this.channel.changes(this.replica.appliedSeq);
    if (window.windowOldestSeq > 0 && this.replica.appliedSeq < window.windowOldestSeq - 1) {
      await this.rebuild();
      return { mode: 'snapshot', reason: 'cursor_expired', applied: 0, skipped: 0 };
    }
    let applied = 0; let skipped = 0;
    let since = this.replica.appliedSeq;
    for (;;) {
      const batch = await this.channel.changes(since);
      if (batch.windowOldestSeq > since + 1) { await this.rebuild(); return { mode: 'snapshot', reason: 'cursor_expired_midstream', applied, skipped }; }
      if (!batch.changes.length) break;
      if (this.underDiskFloor()) return { mode: 'incremental', reason: 'disk_floor_midstream', applied, skipped };
      const result = this.replica!.apply(batch.changes);
      applied += result.applied; skipped += result.skipped;
      since = Math.max(...batch.changes.map(change => change.seq));
      if (batch.changes.length < 200) break;
    }
    await this.fullVerifyIfDue(now);
    return { mode: 'incremental', applied, skipped };
  }
  /** SYNC-P7: staged rebuild verified against the manifest, then an atomic switch. */
  private async rebuild(): Promise<void> {
    const staging = join(this.directory, 'replica.staging.db');
    const previous = join(this.directory, 'replica.previous.db');
    const current = join(this.directory, 'replica.db');
    if (existsSync(staging)) unlinkSync(staging);
    const served = await this.channel.snapshot();
    const verification = verifySnapshotFile(served.path);
    if (!verification.ok || verification.manifest.latestSeq !== served.latestSeq) throw new MnemoWeaveError('PROVIDER_INTEGRITY');
    copyFileSync(served.path, staging);
    const staged = new ReplicaStore(staging);
    try {
      // The snapshot file carries the cursor facts; adopt them before trusting the switch.
      staged.adopt({ appliedSeq: served.latestSeq, generation: verification.manifest.generation, dataTime: verification.manifest.dataTime });
      if (staged.appliedSeq !== served.latestSeq) throw new MnemoWeaveError('PROVIDER_INTEGRITY');
      staged.close();
    } catch (error) { staged.close(); unlinkSync(staging); throw error; }
    // Atomic switch: close the current handle first (Windows cannot rename open files);
    // the rename itself is atomic, so readers see either the old or the new replica.
    this.replica?.close();
    this.replica = undefined;
    if (existsSync(current)) {
      if (existsSync(previous)) unlinkSync(previous);
      renameSync(current, previous);
    }
    renameSync(staging, current);
    this.replicaCorrupted = false;
    this.replica = new ReplicaStore(current);
  }
  /** SYNC-P6: verify every 72 hours. repair small diffs at a snapshot boundary; rebuild above five percent. */
  private async fullVerifyIfDue(now: Date): Promise<void> {
    const verifiedAt = this.replica!.verifiedAt;
    if (verifiedAt && now.getTime() - new Date(verifiedAt).getTime() < 72 * 3_600_000) return;
    const server = await this.channel.partitionSummaries();
    const local = this.replica!.partitionSummaries();
    const serverIds = new Set(server.map(summary => summary.memoryId));
    const differing: string[] = [];
    for (const summary of server) {
      const mine = local.find(item => item.memoryId === summary.memoryId);
      if (!mine || mine.currentRevisionId !== summary.currentRevisionId || JSON.stringify(mine.contentHashes) !== JSON.stringify(summary.contentHashes)) differing.push(summary.memoryId);
    }
    for (const mine of local) if (!serverIds.has(mine.memoryId)) differing.push(mine.memoryId);
    if (differing.length > 0) {
      if (server.length === 0 || differing.length > server.length * 0.05) { await this.rebuild(); return; }
      const served = await this.channel.snapshot();
      const verification = verifySnapshotFile(served.path);
      if (!verification.ok || verification.manifest.latestSeq !== served.latestSeq) throw new MnemoWeaveError('PROVIDER_INTEGRITY');
      // Catch up exactly to the repair snapshot boundary; never skip concurrent publications.
      while (this.replica!.appliedSeq < served.latestSeq) {
        const batch = await this.channel.changes(this.replica!.appliedSeq);
        const changes = batch.changes.filter(change => change.seq <= served.latestSeq);
        if (!changes.length || batch.windowOldestSeq > this.replica!.appliedSeq + 1) { await this.rebuild(); return; }
        this.replica!.apply(changes);
      }
      if (this.replica!.appliedSeq !== served.latestSeq) { await this.rebuild(); return; }
      this.replica!.repairFromSnapshot(served.path, differing);
      const repaired = this.replica!.partitionSummaries();
      const snapshot = new ReplicaStore(served.path);
      try { if (JSON.stringify(repaired) !== JSON.stringify(snapshot.partitionSummaries())) throw new MnemoWeaveError('PROVIDER_INTEGRITY'); }
      finally { snapshot.close(); }
    }
    if (this.replica!.pendingContentCount() === 0) this.replica!.markVerified(now.toISOString());
  }
  /** Local-first recall (R18-1) with explicit availability per HOST-04/SYNC-05. */
  recall(query: string, limit = 10, now: Date = new Date()): BridgeReadResult {
    const record = this.store.grantFor(this.hostId);
    if (!record) return { status: 'unavailable', reason: 'unpaired' };
    if (record.revoked) return { status: 'unauthorized', reason: 'revoked' };
    if (new Date(record.grant.expiresAt).getTime() <= now.getTime()) return { status: 'unauthorized', reason: 'license_expired' };
    if (this.replicaCorrupted) return { status: 'corrupted', reason: 'integrity check failed' };
    if (!this.replica || this.replica.isEmpty) return { status: 'unavailable', reason: 'no_replica' };
    let result;
    try { result = this.replica.recall(query, limit); } catch { this.replicaCorrupted = true; return { status: 'corrupted', reason: 'content integrity check failed' }; }
    result.memories = result.memories.filter(memory => this.replica!.catalogReader().currentMemoryIds(memory.id).some(id => mayRead(record.grant, this.replica!.catalogReader().get(id))));
    return {
      status: 'ok',
      recall: {
        memories: result.memories, complete: result.complete && this.replica.pendingContentCount() === 0,
        dataTime: result.dataTime,
        stale: result.dataTime < new Date(now.getTime() - 10 * 60_000).toISOString(),
      },
    };
  }
  /** AUTH-03: intents queue even with an expired license; revocation isolates them. */
  queueIntent(kind: IntentKind, payload: Record<string, unknown>, baselineRef?: string, intentId?: string): QueuedIntent {
    const record = this.store.grantFor(this.hostId);
    if (!record) throw new MnemoWeaveError('UNAUTHORIZED');
    if (record.revoked) {
      const isolated = this.store.queueIntent({ hostId: this.hostId, kind, payload, baselineRef, intentId });
      this.store.markIntent(isolated.intentId, 'isolated');
      return { ...isolated, state: 'isolated' };
    }
    return this.store.queueIntent({ hostId: this.hostId, kind, payload, baselineRef, intentId });
  }
  /** Reconnect: the Server re-validates each intent; nothing is deleted before a receipt. */
  drainIntents(): Promise<{ submitted: number; acknowledged: number; isolated: number }> {
    if (this.draining) return this.draining;
    this.draining = this.drainOnce().finally(() => { this.draining = undefined; });
    return this.draining;
  }
  private async drainOnce(): Promise<{ submitted: number; acknowledged: number; isolated: number }> {
    let submitted = 0; let acknowledged = 0; let isolated = 0;
    for (const intent of this.store.intentsFor(this.hostId)) {
      if (intent.state === 'isolated') { isolated++; continue; }
      const response = await this.channel.submitIntent(this.hostId, { intentId: intent.intentId, kind: intent.kind, payload: intent.payload, baselineRef: intent.baselineRef });
      submitted++;
      if (response.status === 'accepted' && response.reference) { this.store.markIntent(intent.intentId, 'acknowledged', response.reference); acknowledged++; }
      else if (response.status === 'isolated') { this.store.markIntent(intent.intentId, 'isolated'); isolated++; }
    }
    return { submitted, acknowledged, isolated };
  }
  observeEvent(input: unknown): void {
    const event = HostEvent.parse(input);
    const grant = this.storedGrant();
    if (!grant || this.cachedRevoked()) throw new MnemoWeaveError('UNAUTHORIZED');
    const context = this.store.runtimeContext(event.sessionId, grant.grantId);
    if (context && !context.closed) {
      const text = typeof event.payload.text === 'string' ? event.payload.text : '';
      if (event.kind === 'message.user' && /(?:do not remember|don't remember|不要记住|不要记录|别记住)/i.test(text)) { context.entries = []; context.task = null; context.capture = 'cancelled'; }
      else if (event.kind === 'message.user' && text && !context.entries.some(entry => entry.eventId === event.eventId)) {
        context.entries = [...context.entries, { eventId: event.eventId, text: text.slice(0, 2000), kind: 'user' as const }].slice(-4);
        if (!/^(继续|继续吧|好的|continue|ok)[。.!！\s]*$/i.test(text.trim())) context.task = text.slice(0, 2000);
      }
      context.closed = event.kind === 'session.ended'; context.revision++;
      this.store.saveContext(context, grant.grantId);
    }
    this.queueIntent('event', event, undefined, event.eventId);
  }
  isolatedIntentCount(): number { return this.store.intentsFor(this.hostId).filter(intent => intent.state === 'isolated').length; }

  /**
   * Read-only UI projection over the same local state injection reads: status, current
   * memories, one memory and the offline intent queue. It never writes, never extends a
   * grant and applies the Host grant to every row it returns.
   */
  private uiState(now: Date): UiReadState {
    const record = this.store.grantFor(this.hostId);
    return {
      hostId: this.hostId,
      grant: record?.grant,
      revoked: record?.revoked ?? false,
      replica: this.replica,
      corrupted: this.replicaCorrupted,
      intents: this.store.intentsFor(this.hostId),
      now,
    };
  }

  uiStatus(now: Date = new Date()): UiStatusRecord { return uiStatus(this.uiState(now)); }

  uiMemories(input: UiMemoriesInput = {}, now: Date = new Date()): UiMemoryListRecord {
    return uiMemories(this.uiState(now), input);
  }

  uiMemory(memoryId: string, now: Date = new Date()): UiMemoryDetailRecord { return uiMemory(this.uiState(now), memoryId); }

  uiRevision(memoryId: string, revisionId: string, now: Date = new Date()): UiRevisionRecord { return uiRevision(this.uiState(now), memoryId, revisionId); }

  uiIntents(now: Date = new Date()): UiIntentsRecord { return uiIntents(this.uiState(now)); }
}
