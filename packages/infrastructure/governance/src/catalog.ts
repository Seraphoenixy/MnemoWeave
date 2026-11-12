import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { MemoryDescriptor, MnemoWeaveError, PublicationRef, RememberInput,ConflictDescriptor, ReviewDueItem } from '../../../core/contracts/src/index.ts';
import type { RememberRequest, MemoryCatalogRecord, ReviewDueItemRecord } from '../../../core/contracts/src/index.ts';
import type { MemoryCatalogReader } from '../../../core/application/src/catalog-ports.ts';
import type { VersionPlan, VersionCheckpoint, VersionOperation } from '../../../core/application/src/version-ports.ts';

type Transaction = <T>(operation: () => T) => T;
/**
 * Classification a revision may carry. Both dimensions exist because a local Remember and a
 * synced formal entry describe their content differently; neither is derived from the other.
 */
export interface RevisionMeta {
  knowledgeType?: string;
  category?: string;
  importance?: number;
  tags?: string[];
  entities?: string[];
}
const REVIEW_DAY_MS = 86_400_000;
/** KNOWLEDGE-01 defaults: version/platform-sensitive, regular practice, long-term principles. */
export const REVIEW_INTERVAL_DAYS: Readonly<Record<string, number>> = {
  Troubleshooting: 30, Reference: 30, Procedure: 30,
  Practice: 90, Concept: 90,
  Architecture: 180, Constraint: 180,
};
export const DEFAULT_REVIEW_INTERVAL_DAYS = 90;
/** Ordered-change hook (SYNC-P2): called inside the mutation transaction for replica sync. */
export type SyncHook = (op: string, entityId: string, payload: Record<string, unknown>) => void;

/** v3 metadata only: immutable Provider references and logical current pointers. */
/**
 * Classification carried by a publication request.
 *
 * Absent fields stay absent: "not recorded" is a different statement from "recorded as empty", and
 * the catalog keeps that distinction all the way to the API.
 */
function revisionMetaOf(request: RememberRequest): RevisionMeta {
  return {
    knowledgeType: request.knowledgeType,
    tags: request.tags,
    ...(request.category === undefined ? {} : { category: request.category }),
    ...(request.importance === undefined ? {} : { importance: request.importance }),
    ...(request.entities === undefined ? {} : { entities: request.entities }),
  };
}

export class SqliteMemoryCatalog implements MemoryCatalogReader {
  private readonly db: DatabaseSync;
  private readonly transaction:Transaction;
  private syncHook: SyncHook | undefined;
  setSyncHook(hook: SyncHook | undefined): void { this.syncHook = hook; }
  private emit(op: string, entityId: string, payload: Record<string, unknown>): void { if (this.syncHook) this.syncHook(op, entityId, payload); }
  /**
   * Ownership columns exist in older databases but carry no meaning in the shared collection.
   * Every new row writes `scope='global'` and no owner; the reader never exposes either field.
   */
  private hasProjectColumn(): boolean {
    return this.db.prepare("SELECT 1 FROM pragma_table_info('catalog_memories') WHERE name='project_id'").get() !== undefined;
  }
  constructor(db: DatabaseSync, path: string, transaction: Transaction) {
    this.db = db;
    this.transaction=transaction;
    if (Number(db.prepare('PRAGMA user_version').get()!['user_version']) === 2) {
      db.prepare('VACUUM INTO ?').run(`${path}.pre-v3.${randomUUID()}.db`);
      transaction(() => {
        if (Number(db.prepare('PRAGMA user_version').get()!['user_version']) !== 2) return;
        db.exec(`
          CREATE TABLE catalog_memories(
            id TEXT PRIMARY KEY, current_revision_id TEXT,
            state TEXT NOT NULL CHECK(state IN ('active','superseded','unverified')),
            scope TEXT NOT NULL, applicability TEXT NOT NULL
          ) STRICT;
          CREATE TABLE catalog_revisions(
            id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES catalog_memories(id),
            revision_number INTEGER NOT NULL, parent_id TEXT REFERENCES catalog_revisions(id),
            provider_memory_id TEXT NOT NULL, content_hash TEXT NOT NULL,
            candidate_id TEXT NOT NULL UNIQUE REFERENCES governance_candidates(id),
            published_at TEXT NOT NULL, effective_at TEXT NOT NULL,
            UNIQUE(memory_id,revision_number)
          ) STRICT;
          CREATE TRIGGER catalog_revisions_immutable_update BEFORE UPDATE ON catalog_revisions BEGIN SELECT RAISE(ABORT,'Revision is immutable'); END;
          CREATE TRIGGER catalog_revisions_immutable_delete BEFORE DELETE ON catalog_revisions BEGIN SELECT RAISE(ABORT,'Revision is immutable'); END;
          PRAGMA user_version=3;
        `);
        const rows = db.prepare(`SELECT c.id,c.request_json,r.result_json,r.created_at FROM governance_candidates c
          JOIN governance_execution_receipts r ON r.candidate_id=c.id
          WHERE json_extract(r.result_json,'$.status')='persisted' ORDER BY r.rowid`).all();
        for (const row of rows) {
          const request = RememberInput.parse(JSON.parse(String(row['request_json'])));
          const receipt = JSON.parse(String(row['result_json'])) as { providerMemoryId: string; contentHash: string };
          this.publishInitial(String(row['id']), request, receipt.providerMemoryId, receipt.contentHash, String(row['created_at']));
        }
      });
    }
    if (Number(db.prepare('PRAGMA user_version').get()!['user_version']) === 3) {
      db.prepare('VACUUM INTO ?').run(`${path}.pre-v4.${randomUUID()}.db`);
      transaction(() => {
        if (Number(db.prepare('PRAGMA user_version').get()!['user_version']) !== 3) return;
        db.exec(`
          CREATE TABLE catalog_operations(id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL UNIQUE REFERENCES governance_candidates(id),plan_json TEXT NOT NULL,checkpoint_json TEXT NOT NULL,state TEXT NOT NULL);
          CREATE TABLE catalog_reservations(memory_id TEXT PRIMARY KEY REFERENCES catalog_memories(id),operation_id TEXT NOT NULL UNIQUE REFERENCES catalog_operations(id));
          CREATE TABLE catalog_relations(id TEXT PRIMARY KEY,kind TEXT NOT NULL,source_memory_id TEXT NOT NULL REFERENCES catalog_memories(id),source_revision_id TEXT NOT NULL REFERENCES catalog_revisions(id),target_memory_id TEXT NOT NULL REFERENCES catalog_memories(id),target_revision_id TEXT NOT NULL REFERENCES catalog_revisions(id),effective_at TEXT NOT NULL,reason TEXT NOT NULL,evidence_json TEXT NOT NULL,native_projected INTEGER NOT NULL);
          CREATE TRIGGER catalog_operation_plan_immutable BEFORE UPDATE OF plan_json ON catalog_operations BEGIN SELECT RAISE(ABORT,'Operation plan is immutable'); END;
          PRAGMA user_version=4;
        `);
      });
    }
    if(Number(db.prepare('PRAGMA user_version').get()!['user_version'])===4){
      db.prepare('VACUUM INTO ?').run(`${path}.pre-v5.${randomUUID()}.db`);
      transaction(()=>{
        if(Number(db.prepare('PRAGMA user_version').get()!['user_version'])!==4)return;
        db.exec(`CREATE TABLE catalog_conflicts(id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL UNIQUE REFERENCES governance_candidates(id),target_memory_id TEXT NOT NULL REFERENCES catalog_memories(id),base_revision_id TEXT NOT NULL REFERENCES catalog_revisions(id),state TEXT NOT NULL,follow_up_candidate_id TEXT REFERENCES governance_candidates(id));
          CREATE TABLE catalog_conflict_decisions(id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES catalog_conflicts(id),actor TEXT NOT NULL,decision TEXT NOT NULL,reason TEXT NOT NULL,evidence_json TEXT NOT NULL,created_at TEXT NOT NULL);
          PRAGMA user_version=5;`);
      });
    }
    db.prepare('SELECT id,memory_id,provider_memory_id,content_hash FROM catalog_revisions LIMIT 0').all();
  }
  /** Must run in the same transaction as the successful execution receipt. */
  publishInitial(candidateId: string, request: RememberRequest, providerId: string, hash: string, time: string) {
    const existing = this.publicationForCandidate(candidateId);
    if (existing) return existing;
    if (createHash('sha256').update(request.content).digest('hex') !== hash) throw new MnemoWeaveError('PROVIDER_PROTOCOL');
    this.assertUnambiguousPublication(providerId);
    const memoryId = randomUUID(); const revisionId = randomUUID();
    if (this.hasProjectColumn()) {
      this.db.prepare('INSERT INTO catalog_memories(id,current_revision_id,state,scope,applicability,project_id) VALUES(?,?,?,?,?,?)').run(memoryId, null, 'active', 'global', request.provenance.applicability, null);
    } else {
      this.db.prepare('INSERT INTO catalog_memories VALUES(?,?,?,?,?)').run(memoryId, null, 'active', 'global', request.provenance.applicability);
    }
    this.emit('memory', memoryId, { id: memoryId, currentRevisionId: revisionId, state: 'active',  applicability: request.provenance.applicability });
    // During the v2→v3 backfill the provenance columns do not exist yet (v7 adds them and
    // backfills from the candidate request); runtime publications always carry them.
    if (this.db.prepare("SELECT 1 FROM pragma_table_info('catalog_revisions') WHERE name='applicability'").get()) {
      this.insertRevision({
        id: revisionId, memoryId, number: 1, parentId: null, providerMemoryId: providerId,
        contentHash: hash, candidateId, publishedAt: time, effectiveAt: time,
        applicability: request.provenance.applicability,
        meta: revisionMetaOf(request),
      });
    } else {
      this.db.prepare('INSERT INTO catalog_revisions(id,memory_id,revision_number,parent_id,provider_memory_id,content_hash,candidate_id,published_at,effective_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(revisionId, memoryId, 1, null, providerId, hash, candidateId, time, time);
    }
    this.emit('revision', revisionId, { id: revisionId, memoryId, number: 1, parentId: null, providerMemoryId: providerId, contentHash: hash, candidateId, publishedAt: time, effectiveAt: time, applicability: request.provenance.applicability });
    this.db.prepare('UPDATE catalog_memories SET current_revision_id=? WHERE id=?').run(revisionId, memoryId);
    this.scheduleReview(memoryId, request.knowledgeType, time);
    return { memoryId, revisionId };
  }
  publicationForCandidate(candidateId: string) {
    const row = this.db.prepare('SELECT id,memory_id FROM catalog_revisions WHERE candidate_id=?').get(candidateId);
    return row ? PublicationRef.parse({ memoryId: row['memory_id'], revisionId: row['id'] }) : undefined;
  }
  visibleProviderIds(): string[] {
    return this.db.prepare("SELECT DISTINCT r.provider_memory_id FROM catalog_memories m JOIN catalog_revisions r ON r.id=m.current_revision_id WHERE m.state='active'").all().map(row => String(row['provider_memory_id']));
  }
  currentMemoryIds(providerMemoryId: string): string[] {
    return this.db.prepare('SELECT m.id FROM catalog_memories m JOIN catalog_revisions r ON r.id=m.current_revision_id WHERE r.provider_memory_id=? ORDER BY m.id').all(providerMemoryId).map(row => String(row['id']));
  }
  get(memoryId: string): MemoryCatalogRecord {
    return this.transaction(()=>this.readDescriptor(memoryId));
  }
  private readDescriptor(memoryId: string): MemoryCatalogRecord {
    const memory = this.db.prepare('SELECT * FROM catalog_memories WHERE id=?').get(memoryId);
    if (!memory) throw new MnemoWeaveError('NOT_FOUND');
    // Revision provenance lives on the revision itself; cleared candidate bodies never affect it.
    const revisions = this.db.prepare('SELECT r.* FROM catalog_revisions r WHERE r.memory_id=? ORDER BY r.revision_number').all(memoryId).map(row => {
      const tags = row['tags_json'] === null || row['tags_json'] === undefined ? [] : (JSON.parse(String(row['tags_json'])) as string[]);
      const entities = row['entities_json'] === null || row['entities_json'] === undefined ? [] : (JSON.parse(String(row['entities_json'])) as string[]);
      return {
        id: row['id'], memoryId: row['memory_id'], number: row['revision_number'], parentId: row['parent_id'],
        providerMemoryId: row['provider_memory_id'], contentHash: row['content_hash'], candidateId: row['candidate_id'],
        publishedAt: row['published_at'], effectiveAt: row['effective_at'], applicability: row['applicability'],
        // Absent means the classification was never recorded, which differs from an empty one.
        ...(row['knowledge_type'] === null ? {} : { knowledgeType: row['knowledge_type'] }),
        ...(row['category'] === null ? {} : { category: row['category'] }),
        ...(row['importance'] === null ? {} : { importance: row['importance'] }),
        tags, entities,
      };
    });
    const relations = this.db.prepare('SELECT * FROM catalog_relations WHERE source_memory_id=? OR target_memory_id=?').all(memoryId,memoryId).map(row => ({ id: row['id'], kind: row['kind'], sourceMemoryId: row['source_memory_id'], sourceRevisionId: row['source_revision_id'], targetMemoryId: row['target_memory_id'], targetRevisionId: row['target_revision_id'], effectiveAt: row['effective_at'], reason: row['reason'], evidence: JSON.parse(String(row['evidence_json'])), nativeProjected: row['native_projected'] === 1 }));
    const conflicts=this.db.prepare('SELECT id FROM catalog_conflicts WHERE target_memory_id=?').all(memoryId).map(row=>this.getConflict(String(row['id'])));
    const current = revisions.find(row => row.id === memory['current_revision_id']);
    return MemoryDescriptor.parse({ id: memory['id'], currentRevisionId: memory['current_revision_id'], state: memory['state'], applicability: memory['applicability'], revisions, relations, conflicts });
  }
  /**
   * Every catalogued relation, for the graph view.
   *
   * The per-memory read answers "what touches this memory"; a graph needs the whole edge set in
   * one query, or a page would pay one catalog read per node just to draw lines.
   */
  allRelations(limit: number): Array<{ id: string; kind: string; sourceMemoryId: string; targetMemoryId: string; effectiveAt: string; reason: string }> {
    return this.db.prepare('SELECT id,kind,source_memory_id,target_memory_id,effective_at,reason FROM catalog_relations ORDER BY effective_at DESC, id ASC LIMIT ?')
      .all(limit)
      .map(row => ({
        id: String(row['id']), kind: String(row['kind']),
        sourceMemoryId: String(row['source_memory_id']), targetMemoryId: String(row['target_memory_id']),
        effectiveAt: String(row['effective_at']), reason: String(row['reason']),
      }));
  }
  /**
   * Conflicts that became a relation between two published memories.
   *
   * A conflict case is recorded between a *candidate* and a target memory, so it only connects two
   * memories once that candidate has been published (a `coexist` resolution is the normal case).
   * An unresolved case citing an unpublished candidate has no second endpoint to draw.
   */
  allConflictEdges(limit: number): Array<{ id: string; sourceMemoryId: string; targetMemoryId: string; effectiveAt: string; reason: string; state: string }> {
    // The published side is the follow-up candidate when there is one: a `coexist` resolution
    // rejects the conflicting candidate and publishes the qualified replacement instead, so
    // joining on `candidate_id` alone would find no revision at all.
    return this.db.prepare(`
      SELECT c.id AS case_id, c.target_memory_id, c.state, r.memory_id AS source_memory_id
      FROM catalog_conflicts c
      JOIN catalog_revisions r ON r.candidate_id = COALESCE(c.follow_up_candidate_id, c.candidate_id)
      WHERE r.memory_id <> c.target_memory_id
      ORDER BY c.id ASC
      LIMIT ?
    `).all(limit).map(row => ({
      id: String(row['case_id']),
      sourceMemoryId: String(row['source_memory_id']),
      targetMemoryId: String(row['target_memory_id']),
      effectiveAt: '1970-01-01T00:00:00.000Z',
      reason: `conflict ${String(row['state'])}`,
      state: String(row['state']),
    }));
  }
  registerConflict(candidateId:string,request:RememberRequest):void{
    if(request.change?.kind!=='conflict')return;
    const target=this.get(request.change.targetMemoryId);
    if(target.currentRevisionId!==request.change.expectedRevisionId)throw new MnemoWeaveError('INVALID_STATE');
    this.db.prepare('INSERT INTO catalog_conflicts VALUES(?,?,?,?,?,?)').run(randomUUID(),candidateId,target.id,request.change.expectedRevisionId,'open',null);
  }
  conflictForCandidate(candidateId:string):string|undefined{
    const row=this.db.prepare('SELECT id FROM catalog_conflicts WHERE candidate_id=?').get(candidateId);return row?String(row['id']):undefined;
  }
  dismissCaseForCandidate(candidateId:string,actor:string,reason:string):void{
    const id=this.conflictForCandidate(candidateId);if(!id)return;
    const conflict=this.getConflict(id);if(!['open','unverified'].includes(conflict.state))return;
    this.db.prepare('INSERT INTO catalog_conflict_decisions VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,actor,'candidate_rejected',reason,'[]',new Date().toISOString());
    this.db.prepare("UPDATE catalog_conflicts SET state='resolved' WHERE id=?").run(id);
  }
  getConflict(caseId:string){
    return this.transaction(()=>this.readConflictDescriptor(caseId));
  }
  private readConflictDescriptor(caseId:string){
    const row=this.db.prepare('SELECT * FROM catalog_conflicts WHERE id=?').get(caseId);if(!row)throw new MnemoWeaveError('NOT_FOUND');
    const decisions=this.db.prepare('SELECT * FROM catalog_conflict_decisions WHERE case_id=? ORDER BY rowid').all(caseId).map(d=>({actor:d['actor'],decision:d['decision'],reason:d['reason'],evidence:JSON.parse(String(d['evidence_json'])),createdAt:d['created_at']}));
    return ConflictDescriptor.parse({id:row['id'],candidateId:row['candidate_id'],targetMemoryId:row['target_memory_id'],baseRevisionId:row['base_revision_id'],state:row['state'],followUpCandidateId:row['follow_up_candidate_id'],decisions});
  }
  resolve(caseId:string,decision:'keep_existing'|'revise'|'supersede'|'coexist'|'unverified',actor:string,reason:string,evidence:string[],followUp?:string):void{
    const conflict=this.getConflict(caseId);if(!['open','unverified'].includes(conflict.state))throw new MnemoWeaveError('INVALID_STATE');
    const target=this.get(conflict.targetMemoryId);
    if(target.currentRevisionId!==conflict.baseRevisionId||this.db.prepare('SELECT memory_id FROM catalog_reservations WHERE memory_id=?').get(target.id))throw new MnemoWeaveError('INVALID_STATE');
    if(followUp&&this.db.prepare('SELECT id FROM catalog_conflicts WHERE follow_up_candidate_id=?').get(followUp))throw new MnemoWeaveError('IDEMPOTENCY_CONFLICT');
    this.db.prepare('INSERT INTO catalog_conflict_decisions VALUES(?,?,?,?,?,?,?)').run(randomUUID(),caseId,actor,decision,reason,JSON.stringify(evidence),new Date().toISOString());
    this.db.prepare('UPDATE catalog_conflicts SET state=?,follow_up_candidate_id=? WHERE id=?').run(decision==='keep_existing'?'resolved':decision==='unverified'?'unverified':'resolving',followUp??null,caseId);
    if(decision==='unverified'){this.db.prepare("UPDATE catalog_memories SET state='unverified' WHERE id=?").run(target.id);this.emit('memory',target.id,{id:target.id,currentRevisionId:target.currentRevisionId,state:'unverified',applicability:target.applicability});}
    else if(!this.db.prepare("SELECT id FROM catalog_conflicts WHERE target_memory_id=? AND state='unverified' AND id!=?").get(target.id,caseId)){this.db.prepare("UPDATE catalog_memories SET state='active' WHERE id=? AND state='unverified'").run(target.id);this.emit('memory',target.id,{id:target.id,currentRevisionId:target.currentRevisionId,state:'active',applicability:target.applicability});}
  }
  prepare(candidateId: string, request: RememberRequest,resolution?:'revise'|'supersede'|'coexist'): void {
    const intent = request.change;
    if (!intent || (intent.kind === 'conflict'&&!resolution)) throw new MnemoWeaveError('REVIEW_REQUIRED');
    const kind=intent.kind==='conflict'?resolution!:intent.kind;
    if (new Date(intent.effectiveAt).getTime() > Date.now()) throw new MnemoWeaveError('INVALID_INPUT');
    const target = this.get(intent.targetMemoryId);
    if (target.state !== 'active' || target.currentRevisionId !== intent.expectedRevisionId || this.db.prepare('SELECT memory_id FROM catalog_reservations WHERE memory_id=?').get(target.id)) throw new MnemoWeaveError('INVALID_STATE');
    const base = target.revisions.find(revision => revision.id === target.currentRevisionId)!;
    
    if (kind === 'coexist' && request.provenance.applicability === target.applicability) throw new MnemoWeaveError('REVIEW_REQUIRED');
    if (kind === 'supersede') {
      if (request.provenance.applicability !== target.applicability) throw new MnemoWeaveError('REVIEW_REQUIRED');
      const aliases = Number(this.db.prepare('SELECT count(DISTINCT memory_id) n FROM catalog_revisions WHERE provider_memory_id=?').get(base.providerMemoryId)!['n']);
      if (aliases > 1) throw new MnemoWeaveError('REVIEW_REQUIRED');
    }
    const conflict=this.db.prepare("SELECT id FROM catalog_conflicts WHERE (candidate_id=? OR follow_up_candidate_id=?) AND state='resolving'").get(candidateId,candidateId);
    const plan: VersionPlan = { id: randomUUID(), candidateId, kind, memoryId: kind === 'revise' ? target.id : randomUUID(), revisionId: randomUUID(), number: kind === 'revise' ? base.number + 1 : 1, parentId: kind === 'revise' ? base.id : null, targetMemoryId: target.id, baseRevisionId: base.id, baseProviderId: base.providerMemoryId, baseHash: base.contentHash, effectiveAt: intent.effectiveAt, reason: intent.reason, evidence: intent.evidence,...(conflict?{conflictCaseId:String(conflict['id'])}:{}) };
    const checkpoint: VersionCheckpoint = { content: 'pending', link: kind === 'supersede' ? 'pending' : 'none' };
    this.db.prepare('INSERT INTO catalog_operations VALUES(?,?,?,?,?)').run(plan.id,candidateId,JSON.stringify(plan),JSON.stringify(checkpoint),'staged');
    this.db.prepare('INSERT INTO catalog_reservations VALUES(?,?)').run(target.id,plan.id);
  }
  operation(candidateId: string): VersionOperation {
    const row = this.db.prepare('SELECT plan_json,checkpoint_json FROM catalog_operations WHERE candidate_id=?').get(candidateId);
    if (!row) throw new MnemoWeaveError('INVALID_STATE');
    return { plan: JSON.parse(String(row['plan_json'])) as VersionPlan, checkpoint: JSON.parse(String(row['checkpoint_json'])) as VersionCheckpoint };
  }
  checkpoint(candidateId: string, checkpoint: VersionCheckpoint): void {
    this.db.prepare("UPDATE catalog_operations SET checkpoint_json=? WHERE candidate_id=? AND state='staged'").run(JSON.stringify(checkpoint),candidateId);
  }
  private assertUnambiguousPublication(providerId:string,memoryId?:string):void{
    // The v2→v3 backfill runs before v4 creates catalog_relations; a v2 store has no
    // relations at all, so the ambiguity check is vacuously true while the table is absent.
    if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_relations'").get())return;
    const projected=this.db.prepare(`SELECT r.memory_id FROM catalog_revisions r JOIN catalog_relations l ON (l.source_revision_id=r.id OR l.target_revision_id=r.id) WHERE r.provider_memory_id=? AND l.native_projected=1`).all(providerId);
    if(projected.some(row=>row['memory_id']!==memoryId))throw new MnemoWeaveError('REVIEW_REQUIRED');
  }
  checkSupersedesProjection(candidateId:string,sourceProviderId:string):void{
    const {plan}=this.operation(candidateId);
    if(sourceProviderId===plan.baseProviderId)throw new MnemoWeaveError('REVIEW_REQUIRED');
    const targetAliases=Number(this.db.prepare('SELECT count(DISTINCT memory_id) n FROM catalog_revisions WHERE provider_memory_id=?').get(plan.baseProviderId)!['n']);
    if(targetAliases!==1||this.db.prepare('SELECT id FROM catalog_revisions WHERE provider_memory_id=?').get(sourceProviderId))throw new MnemoWeaveError('REVIEW_REQUIRED');
    if(this.db.prepare("SELECT id FROM catalog_operations WHERE state='staged' AND candidate_id!=? AND json_extract(checkpoint_json,'$.providerId') IN (?,?)").get(candidateId,sourceProviderId,plan.baseProviderId))throw new MnemoWeaveError('REVIEW_REQUIRED');
  }
  cancel(candidateId:string,actor:string,reason:string):void{
    const {plan,checkpoint}=this.operation(candidateId);
    const row=this.db.prepare('SELECT state FROM catalog_operations WHERE candidate_id=?').get(candidateId);
    if(row?.['state']!=='staged'||['invoking','verified'].includes(checkpoint.link))throw new MnemoWeaveError('INVALID_STATE');
    this.db.prepare("UPDATE catalog_operations SET state='cancelled' WHERE candidate_id=?").run(candidateId);
    this.db.prepare('DELETE FROM catalog_reservations WHERE memory_id=? AND operation_id=?').run(plan.targetMemoryId,plan.id);
    if(plan.conflictCaseId){
      this.db.prepare('INSERT INTO catalog_conflict_decisions VALUES(?,?,?,?,?,?,?)').run(randomUUID(),plan.conflictCaseId,actor,'update_cancelled',reason,'[]',new Date().toISOString());
      this.db.prepare("UPDATE catalog_conflicts SET state='resolved' WHERE id=?").run(plan.conflictCaseId);
    }
  }
  /**
   * One revision row, with whatever classification this revision carries.
   *
   * A local Remember knows `knowledgeType` and tags; a synced formal entry knows `category`,
   * `importance`, tags and entities. They are stored side by side and never converted into each
   * other, so the reader can tell "no category recorded" from "category is general".
   */
  private insertRevision(input: {
    id: string; memoryId: string; number: number; parentId: string | null;
    providerMemoryId: string; contentHash: string; candidateId: string;
    publishedAt: string; effectiveAt: string; applicability: string;
    meta?: RevisionMeta;
  }): void {
    const meta = input.meta ?? {};
    this.db.prepare(`INSERT INTO catalog_revisions(
      id,memory_id,revision_number,parent_id,provider_memory_id,content_hash,candidate_id,
      published_at,effective_at,applicability,scope,knowledge_type,category,importance,tags_json,entities_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.id, input.memoryId, input.number, input.parentId, input.providerMemoryId, input.contentHash,
      input.candidateId, input.publishedAt, input.effectiveAt, input.applicability,
      'global',
      meta.knowledgeType ?? null, meta.category ?? null, meta.importance ?? null,
      meta.tags === undefined ? null : JSON.stringify(meta.tags),
      meta.entities === undefined ? null : JSON.stringify(meta.entities),
    );
  }
  publishOperation(candidateId: string, request: RememberRequest, providerId: string, hash: string, time: string): void {
    const { plan,checkpoint } = this.operation(candidateId);
    if (checkpoint.content !== 'verified' || checkpoint.providerId !== providerId || !['none','verified'].includes(checkpoint.link)) throw new MnemoWeaveError('INVALID_STATE');
    const target = this.get(plan.targetMemoryId);
    if (target.currentRevisionId !== plan.baseRevisionId || !this.db.prepare('SELECT memory_id FROM catalog_reservations WHERE memory_id=? AND operation_id=?').get(target.id,plan.id)) throw new MnemoWeaveError('INVALID_STATE');
    if (createHash('sha256').update(request.content).digest('hex') !== hash) throw new MnemoWeaveError('PROVIDER_INTEGRITY');
    this.assertUnambiguousPublication(providerId,plan.memoryId);
    if (plan.kind !== 'revise') {
      if (this.hasProjectColumn()) {
        this.db.prepare('INSERT INTO catalog_memories(id,current_revision_id,state,scope,applicability,project_id) VALUES(?,?,?,?,?,?)').run(plan.memoryId,null,'active','global',request.provenance.applicability,null);
      } else {
        this.db.prepare('INSERT INTO catalog_memories VALUES(?,?,?,?,?)').run(plan.memoryId,null,'active','global',request.provenance.applicability);
      }
    }
    this.insertRevision({
      id: plan.revisionId, memoryId: plan.memoryId, number: plan.number, parentId: plan.parentId,
      providerMemoryId: providerId, contentHash: hash, candidateId, publishedAt: time, effectiveAt: plan.effectiveAt,
      applicability: request.provenance.applicability,
      meta: { knowledgeType: request.knowledgeType, tags: request.tags },
    });
    this.emit('revision', plan.revisionId, { id: plan.revisionId, memoryId: plan.memoryId, number: plan.number, parentId: plan.parentId, providerMemoryId: providerId, contentHash: hash, candidateId, publishedAt: time, effectiveAt: plan.effectiveAt, applicability: request.provenance.applicability });
    const changed = this.db.prepare('UPDATE catalog_memories SET current_revision_id=?,applicability=? WHERE id=? AND current_revision_id IS ?').run(plan.revisionId,request.provenance.applicability,plan.memoryId,plan.kind === 'revise' ? plan.baseRevisionId : null);
    if (changed.changes !== 1) throw new MnemoWeaveError('INVALID_STATE');
    this.emit('memory', plan.memoryId, { id: plan.memoryId, currentRevisionId: plan.revisionId, state: this.db.prepare('SELECT state FROM catalog_memories WHERE id=?').get(plan.memoryId)!['state'],  applicability: request.provenance.applicability });
    if (plan.kind !== 'revise') {
      this.db.prepare('INSERT INTO catalog_relations VALUES(?,?,?,?,?,?,?,?,?,?)').run(plan.id,plan.kind === 'supersede' ? 'Supersedes' : 'RelatedTo',plan.memoryId,plan.revisionId,plan.targetMemoryId,plan.baseRevisionId,plan.effectiveAt,plan.reason,JSON.stringify(plan.evidence),plan.kind === 'supersede' ? 1 : 0);
      this.emit('relation', plan.id, { id: plan.id, kind: plan.kind === 'supersede' ? 'Supersedes' : 'RelatedTo', sourceMemoryId: plan.memoryId, sourceRevisionId: plan.revisionId, targetMemoryId: plan.targetMemoryId, targetRevisionId: plan.baseRevisionId, effectiveAt: plan.effectiveAt, reason: plan.reason, evidence: plan.evidence, nativeProjected: plan.kind === 'supersede' });
      if (plan.kind === 'supersede') { this.db.prepare("UPDATE catalog_memories SET state='superseded' WHERE id=?").run(plan.targetMemoryId); this.emit('memory', plan.targetMemoryId, { id: plan.targetMemoryId, currentRevisionId: plan.baseRevisionId, state: 'superseded',  applicability: request.provenance.applicability }); }
    }
    this.db.prepare("UPDATE catalog_operations SET state='published' WHERE id=?").run(plan.id);
    if(plan.conflictCaseId)this.db.prepare("UPDATE catalog_conflicts SET state='resolved' WHERE id=?").run(plan.conflictCaseId);
    this.db.prepare('DELETE FROM catalog_reservations WHERE memory_id=? AND operation_id=?').run(plan.targetMemoryId,plan.id);
    this.scheduleReview(plan.memoryId, request.knowledgeType, time);
  }
  /**
   * User edit: append one immutable revision without a review round. The edit is still recorded
   * as an operator review decision so the audit trail keeps who changed what and why.
   */
  publishDirectEdit(memoryId: string, request: RememberRequest, providerId: string, hash: string, time: string, actor: string, reason: string, meta?: RevisionMeta): { memoryId: string; revisionId: string; candidateId: string } {
    return this.transaction(() => {
      if (createHash('sha256').update(request.content).digest('hex') !== hash) throw new MnemoWeaveError('PROVIDER_INTEGRITY');
      const memory = this.db.prepare('SELECT * FROM catalog_memories WHERE id=?').get(memoryId);
      if (!memory) throw new MnemoWeaveError('NOT_FOUND');
      if (String(memory['state']) !== 'active') throw new MnemoWeaveError('INVALID_STATE');
      const currentId = String(memory['current_revision_id']);
      const base = this.db.prepare('SELECT revision_number FROM catalog_revisions WHERE id=?').get(currentId);
      if (!base) throw new MnemoWeaveError('INVALID_STATE');
      const candidateId = randomUUID();
      const requestJson = JSON.stringify(request);
      this.db.prepare('INSERT INTO governance_candidates(id,idempotency_key,request_hash,request_json,status,submitted_at) VALUES(?,?,?,?,?,?)')
        .run(candidateId, `direct-edit:${candidateId}`, createHash('sha256').update(requestJson).digest('hex'), requestJson, 'pending_review', time);
      this.db.prepare('INSERT INTO governance_submission_receipts(id,candidate_id,status) VALUES(?,?,?)').run(randomUUID(), candidateId, 'candidate');
      this.db.prepare('INSERT INTO governance_lifecycle(candidate_id,status) VALUES(?,?)').run(candidateId, 'persisted');
      this.db.prepare('INSERT INTO governance_reviews(id,candidate_id,decision,actor,reason,assessment_json,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(randomUUID(), candidateId, 'approve', actor, reason, null, time);
      const revisionId = randomUUID();
      const number = Number(base['revision_number']) + 1;
      // A user edit changes the body, not necessarily the classification: fields the caller did
      // not set are carried forward from the previous revision instead of being replaced by the
      // synthetic request's placeholder values.
      const previous = this.db.prepare('SELECT knowledge_type, category, importance, tags_json, entities_json FROM catalog_revisions WHERE id=?').get(currentId);
      const carried: RevisionMeta = {
        ...(previous?.['knowledge_type'] === null || previous?.['knowledge_type'] === undefined ? {} : { knowledgeType: String(previous['knowledge_type']) }),
        ...(previous?.['category'] === null || previous?.['category'] === undefined ? {} : { category: String(previous['category']) }),
        ...(previous?.['importance'] === null || previous?.['importance'] === undefined ? {} : { importance: Number(previous['importance']) }),
        ...(previous?.['tags_json'] === null || previous?.['tags_json'] === undefined ? {} : { tags: JSON.parse(String(previous['tags_json'])) as string[] }),
        ...(previous?.['entities_json'] === null || previous?.['entities_json'] === undefined ? {} : { entities: JSON.parse(String(previous['entities_json'])) as string[] }),
        ...(meta ?? {}),
      };
      this.insertRevision({
        id: revisionId, memoryId, number, parentId: currentId, providerMemoryId: providerId,
        contentHash: hash, candidateId, publishedAt: time, effectiveAt: time,
        applicability: String(memory['applicability']),
        meta: carried,
      });
      const changed = this.db.prepare('UPDATE catalog_memories SET current_revision_id=? WHERE id=? AND current_revision_id=?').run(revisionId, memoryId, currentId);
      if (changed.changes !== 1) throw new MnemoWeaveError('INVALID_STATE');
      this.emit('revision', revisionId, { id: revisionId, memoryId, number, parentId: currentId, providerMemoryId: providerId, contentHash: hash, candidateId, publishedAt: time, effectiveAt: time, applicability: memory['applicability'] });
      this.scheduleReview(memoryId, request.knowledgeType, time);
      return { memoryId, revisionId, candidateId };
    });
  }
  /**
   * The Revision this machine already appended for a Provider memory, if any. A synced
   * edit publishes through the shared apply pipeline, so the caller must adopt that
   * Revision instead of appending a second one for the same edit.
   */
  currentRevisionFor(memoryId: string, providerMemoryId: string): { id: string; candidateId: string; number: number } | null {
    const row = this.db.prepare('SELECT id, candidate_id, revision_number FROM catalog_revisions WHERE memory_id = ? AND provider_memory_id = ? ORDER BY revision_number DESC LIMIT 1')
      .get(memoryId, providerMemoryId);
    return row ? { id: String(row['id']), candidateId: String(row['candidate_id']), number: Number(row['revision_number']) } : null;
  }

  /**
   * Record the user's edit as an operator decision against a Revision that already exists.
   * The audit trail keeps who changed what and why; no second Revision is created.
   */
  recordEditDecision(memoryId: string, candidateId: string, actor: string, reason: string): void {
    this.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM governance_reviews WHERE candidate_id = ? AND actor = ? AND reason = ?').get(candidateId, actor, reason);
      if (existing) return;
      this.db.prepare('INSERT INTO governance_reviews(id,candidate_id,decision,actor,reason,assessment_json,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(randomUUID(), candidateId, 'approve', actor, reason, null, new Date().toISOString());
      this.emit('revision', memoryId, { memoryId, candidateId, decision: 'approve', actor });
    });
  }
  /**
   * Record a revision that another machine created. The local catalog has no candidate
   * for it, so a synthetic one carries the request metadata (its body lives in the
   * Provider). The call is idempotent by provider id: a replay returns the existing row.
   */
  publishSynced(memoryId: string, request: RememberRequest, providerId: string, hash: string, time: string, actor: string, reason: string, meta?: RevisionMeta): { memoryId: string; revisionId: string } {
    return this.transaction(() => {
      if (createHash('sha256').update(request.content).digest('hex') !== hash) throw new MnemoWeaveError('PROVIDER_INTEGRITY');
      const existing = this.db.prepare('SELECT id, memory_id FROM catalog_revisions WHERE provider_memory_id=?').get(providerId);
      if (existing) return { memoryId: String(existing['memory_id']), revisionId: String(existing['id']) };
      const candidateId = randomUUID();
      const requestJson = JSON.stringify(request);
      this.db.prepare('INSERT INTO governance_candidates(id,idempotency_key,request_hash,request_json,status,submitted_at) VALUES(?,?,?,?,?,?)')
        .run(candidateId, `sync:${candidateId}`, createHash('sha256').update(requestJson).digest('hex'), requestJson, 'pending_review', time);
      this.db.prepare('INSERT INTO governance_submission_receipts(id,candidate_id,status) VALUES(?,?,?)').run(randomUUID(), candidateId, 'candidate');
      this.db.prepare('INSERT INTO governance_lifecycle(candidate_id,status) VALUES(?,?)').run(candidateId, 'persisted');
      this.db.prepare('INSERT INTO governance_reviews(id,candidate_id,decision,actor,reason,assessment_json,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(randomUUID(), candidateId, 'approve', actor, reason, null, time);
      const memory = this.db.prepare('SELECT * FROM catalog_memories WHERE id=?').get(memoryId);
      if (!memory) {
        const revisionId = randomUUID();
        if (this.hasProjectColumn()) {
          this.db.prepare('INSERT INTO catalog_memories(id,current_revision_id,state,scope,applicability,project_id) VALUES(?,?,?,?,?,?)').run(memoryId, null, 'active', 'global', request.provenance.applicability, null);
        } else {
          this.db.prepare('INSERT INTO catalog_memories VALUES(?,?,?,?,?)').run(memoryId, null, 'active', 'global', request.provenance.applicability);
        }
        this.insertRevision({
          id: revisionId, memoryId, number: 1, parentId: null, providerMemoryId: providerId,
          contentHash: hash, candidateId, publishedAt: time, effectiveAt: time,
          applicability: request.provenance.applicability,
          ...(meta === undefined ? {} : { meta }),
        });
        this.db.prepare('UPDATE catalog_memories SET current_revision_id=? WHERE id=?').run(revisionId, memoryId);
        this.emit('memory', memoryId, { id: memoryId, currentRevisionId: revisionId, state: 'active',  applicability: request.provenance.applicability });
        this.emit('revision', revisionId, { id: revisionId, memoryId, number: 1, parentId: null, providerMemoryId: providerId, contentHash: hash, candidateId, publishedAt: time, effectiveAt: time, applicability: request.provenance.applicability });
        this.scheduleReview(memoryId, request.knowledgeType, time);
        return { memoryId, revisionId };
      }
      if (String(memory['state']) !== 'active') throw new MnemoWeaveError('INVALID_STATE');
      const currentId = String(memory['current_revision_id']);
      const base = this.db.prepare('SELECT revision_number FROM catalog_revisions WHERE id=?').get(currentId);
      if (!base) throw new MnemoWeaveError('INVALID_STATE');
      const revisionId = randomUUID();
      const number = Number(base['revision_number']) + 1;
      this.insertRevision({
        id: revisionId, memoryId, number, parentId: currentId, providerMemoryId: providerId,
        contentHash: hash, candidateId, publishedAt: time, effectiveAt: time,
        applicability: String(memory['applicability']),
        ...(meta === undefined ? {} : { meta }),
      });
      const changed = this.db.prepare('UPDATE catalog_memories SET current_revision_id=? WHERE id=? AND current_revision_id=?').run(revisionId, memoryId, currentId);
      if (changed.changes !== 1) throw new MnemoWeaveError('INVALID_STATE');
      this.emit('revision', revisionId, { id: revisionId, memoryId, number, parentId: currentId, providerMemoryId: providerId, contentHash: hash, candidateId, publishedAt: time, effectiveAt: time, applicability: memory['applicability'] });
      this.scheduleReview(memoryId, request.knowledgeType, time);
      return { memoryId, revisionId };
    });
  }
  /**
   * Withdraw a memory. A withdrawn memory leaves recall and injection, but its revisions stay
   * readable: the body is not deleted, the pointer stops being current, and the state records
   * why. `retireSynced` does the state change; this appends the audit trail of who withdrew it
   * and why, reusing the operator-decision record so the history explains itself.
   */
  withdrawLocal(memoryId: string, actor: string, reason: string, at: string): { revisionId: string } {
    return this.transaction(() => {
      const memory = this.db.prepare('SELECT * FROM catalog_memories WHERE id=?').get(memoryId);
      if (!memory) throw new MnemoWeaveError('NOT_FOUND');
      if (String(memory['state']) !== 'active') throw new MnemoWeaveError('INVALID_STATE');
      const currentId = String(memory['current_revision_id']);
      const current = this.db.prepare('SELECT candidate_id FROM catalog_revisions WHERE id=?').get(currentId);
      if (!current) throw new MnemoWeaveError('INVALID_STATE');
      this.db.prepare('INSERT INTO governance_reviews(id,candidate_id,decision,actor,reason,assessment_json,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(randomUUID(), String(current['candidate_id']), 'withdraw', actor, reason, null, at);
      this.db.prepare("UPDATE catalog_memories SET state='superseded' WHERE id=?").run(memoryId);
      this.emit('memory', memoryId, { id: memoryId, currentRevisionId: currentId, state: 'superseded', applicability: memory['applicability'] });
      return { revisionId: currentId };
    });
  }

  /** Hide a memory whose remote entry was withdrawn; the revision history stays. */
  retireSynced(memoryId: string): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT current_revision_id FROM catalog_memories WHERE id=? AND state='active'").get(memoryId);
      if (!row) return;
      this.db.prepare("UPDATE catalog_memories SET state='superseded' WHERE id=?").run(memoryId);
      this.emit('memory', memoryId, { id: memoryId, currentRevisionId: String(row['current_revision_id']), state: 'superseded' });
    });
  }
  /** KNOWLEDGE-01: due times are derived; expiry only queues a review, never invalidates. */  private scheduleReview(memoryId: string, knowledgeType: string, baseTime: string): void {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_review_state'").get()) return;
    const intervalDays = REVIEW_INTERVAL_DAYS[knowledgeType] ?? DEFAULT_REVIEW_INTERVAL_DAYS;
    const dueAt = new Date(new Date(baseTime).getTime() + intervalDays * REVIEW_DAY_MS).toISOString();
    this.db.prepare(`INSERT INTO catalog_review_state(memory_id,knowledge_type,interval_days,last_reviewed_at,due_at) VALUES(?,?,?,NULL,?)
      ON CONFLICT(memory_id) DO UPDATE SET knowledge_type=excluded.knowledge_type, interval_days=excluded.interval_days, due_at=excluded.due_at`)
      .run(memoryId, knowledgeType, intervalDays, dueAt);
  }
  reviewDue(now: Date = new Date()): ReviewDueItemRecord[] {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_review_state'").get()) return [];
    return this.db.prepare(`SELECT s.memory_id,s.knowledge_type,s.interval_days,s.last_reviewed_at,s.due_at
      FROM catalog_review_state s JOIN catalog_memories m ON m.id=s.memory_id
      WHERE m.state='active' AND s.due_at<=? ORDER BY s.due_at`).all(now.toISOString()).map(row => ReviewDueItem.parse({
        memoryId: String(row['memory_id']), knowledgeType: String(row['knowledge_type']), intervalDays: Number(row['interval_days']),
        dueAt: String(row['due_at']), lastReviewedAt: row['last_reviewed_at'] === null ? null : String(row['last_reviewed_at']),
      }));
  }
  completeReview(memoryId: string, actor: string, reason: string, now: Date = new Date()): ReviewDueItemRecord {
    const row = this.db.prepare('SELECT knowledge_type,interval_days,last_reviewed_at FROM catalog_review_state WHERE memory_id=?').get(memoryId);
    if (!row) throw new MnemoWeaveError('NOT_FOUND');
    const reviewedAt = now.toISOString();
    const dueAt = new Date(now.getTime() + Number(row['interval_days']) * REVIEW_DAY_MS).toISOString();
    this.db.prepare('UPDATE catalog_review_state SET last_reviewed_at=?,due_at=? WHERE memory_id=?').run(reviewedAt, dueAt, memoryId);
    this.db.prepare('INSERT INTO catalog_review_history VALUES(?,?,?,?,?)').run(randomUUID(), memoryId, reviewedAt, actor, reason);
    return ReviewDueItem.parse({
      memoryId, knowledgeType: String(row['knowledge_type']), intervalDays: Number(row['interval_days']),
      dueAt, lastReviewedAt: reviewedAt,
    });
  }
}
