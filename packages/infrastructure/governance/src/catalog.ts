import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { MemoryDescriptor, MnemoWeaveError, PublicationRef, RememberInput,ConflictDescriptor, ReviewDueItem } from '../../../core/contracts/src/index.ts';
import type { RememberRequest, MemoryCatalogRecord, ReviewDueItemRecord } from '../../../core/contracts/src/index.ts';
import type { MemoryCatalogReader } from '../../../core/application/src/catalog-ports.ts';
import type { VersionPlan, VersionCheckpoint, VersionOperation } from '../../../core/application/src/version-ports.ts';

type Transaction = <T>(operation: () => T) => T;
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
export class SqliteMemoryCatalog implements MemoryCatalogReader {
  private readonly db: DatabaseSync;
  private readonly transaction:Transaction;
  private syncHook: SyncHook | undefined;
  setSyncHook(hook: SyncHook | undefined): void { this.syncHook = hook; }
  private emit(op: string, entityId: string, payload: Record<string, unknown>): void { if (this.syncHook) this.syncHook(op, entityId, payload); }
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
    this.db.prepare('INSERT INTO catalog_memories VALUES(?,?,?,?,?)').run(memoryId, null, 'active', request.scope, request.provenance.applicability);
    this.emit('memory', memoryId, { id: memoryId, currentRevisionId: revisionId, state: 'active', scope: request.scope, ...(request.projectId ? { projectId: request.projectId } : {}), applicability: request.provenance.applicability });
    // During the v2→v3 backfill the provenance columns do not exist yet (v7 adds them and
    // backfills from the candidate request); runtime publications always carry them.
    if (this.db.prepare("SELECT 1 FROM pragma_table_info('catalog_revisions') WHERE name='applicability'").get()) {
      this.db.prepare('INSERT INTO catalog_revisions(id,memory_id,revision_number,parent_id,provider_memory_id,content_hash,candidate_id,published_at,effective_at,applicability,scope) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(revisionId, memoryId, 1, null, providerId, hash, candidateId, time, time, request.provenance.applicability, request.scope);
    } else {
      this.db.prepare('INSERT INTO catalog_revisions(id,memory_id,revision_number,parent_id,provider_memory_id,content_hash,candidate_id,published_at,effective_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(revisionId, memoryId, 1, null, providerId, hash, candidateId, time, time);
    }
    this.emit('revision', revisionId, { id: revisionId, memoryId, number: 1, parentId: null, providerMemoryId: providerId, contentHash: hash, candidateId, publishedAt: time, effectiveAt: time, applicability: request.provenance.applicability, scope: request.scope, ...(request.projectId ? { projectId: request.projectId } : {}) });
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
    const revisions = this.db.prepare("SELECT r.*, json_extract(c.request_json,'$.projectId') project_id FROM catalog_revisions r JOIN governance_candidates c ON c.id=r.candidate_id WHERE r.memory_id=? ORDER BY r.revision_number").all(memoryId).map(row => {
      return { ...(row['project_id'] ? { projectId: String(row['project_id']) } : {}), id: row['id'], memoryId: row['memory_id'], number: row['revision_number'], parentId: row['parent_id'], providerMemoryId: row['provider_memory_id'], contentHash: row['content_hash'], candidateId: row['candidate_id'], publishedAt: row['published_at'], effectiveAt: row['effective_at'], applicability: row['applicability'], scope: row['scope'] };
    });
    const relations = this.db.prepare('SELECT * FROM catalog_relations WHERE source_memory_id=? OR target_memory_id=?').all(memoryId,memoryId).map(row => ({ id: row['id'], kind: row['kind'], sourceMemoryId: row['source_memory_id'], sourceRevisionId: row['source_revision_id'], targetMemoryId: row['target_memory_id'], targetRevisionId: row['target_revision_id'], effectiveAt: row['effective_at'], reason: row['reason'], evidence: JSON.parse(String(row['evidence_json'])), nativeProjected: row['native_projected'] === 1 }));
    const conflicts=this.db.prepare('SELECT id FROM catalog_conflicts WHERE target_memory_id=?').all(memoryId).map(row=>this.getConflict(String(row['id'])));
    const current = revisions.find(row => row.id === memory['current_revision_id']);
    return MemoryDescriptor.parse({ ...(current?.projectId ? { projectId: current.projectId } : {}), id: memory['id'], currentRevisionId: memory['current_revision_id'], state: memory['state'], scope: memory['scope'], applicability: memory['applicability'], revisions, relations,conflicts });
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
    if(decision==='unverified'){this.db.prepare("UPDATE catalog_memories SET state='unverified' WHERE id=?").run(target.id);this.emit('memory',target.id,{id:target.id,currentRevisionId:target.currentRevisionId,state:'unverified',scope:target.scope,...(target.projectId ? {projectId:target.projectId} : {}),applicability:target.applicability});}
    else if(!this.db.prepare("SELECT id FROM catalog_conflicts WHERE target_memory_id=? AND state='unverified' AND id!=?").get(target.id,caseId)){this.db.prepare("UPDATE catalog_memories SET state='active' WHERE id=? AND state='unverified'").run(target.id);this.emit('memory',target.id,{id:target.id,currentRevisionId:target.currentRevisionId,state:'active',scope:target.scope,...(target.projectId ? {projectId:target.projectId} : {}),applicability:target.applicability});}
  }
  prepare(candidateId: string, request: RememberRequest,resolution?:'revise'|'supersede'|'coexist'): void {
    const intent = request.change;
    if (!intent || (intent.kind === 'conflict'&&!resolution)) throw new MnemoWeaveError('REVIEW_REQUIRED');
    const kind=intent.kind==='conflict'?resolution!:intent.kind;
    if (new Date(intent.effectiveAt).getTime() > Date.now()) throw new MnemoWeaveError('INVALID_INPUT');
    const target = this.get(intent.targetMemoryId);
    if (target.state !== 'active' || target.currentRevisionId !== intent.expectedRevisionId || this.db.prepare('SELECT memory_id FROM catalog_reservations WHERE memory_id=?').get(target.id)) throw new MnemoWeaveError('INVALID_STATE');
    const base = target.revisions.find(revision => revision.id === target.currentRevisionId)!;
    if (kind === 'revise' && (request.scope !== target.scope || request.projectId !== target.projectId)) throw new MnemoWeaveError('INVALID_INPUT');
    if (kind === 'coexist' && request.scope === target.scope && request.projectId === target.projectId && request.provenance.applicability === target.applicability) throw new MnemoWeaveError('REVIEW_REQUIRED');
    if (kind === 'supersede') {
      if (request.scope !== target.scope || request.projectId !== target.projectId || request.provenance.applicability !== target.applicability) throw new MnemoWeaveError('REVIEW_REQUIRED');
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
  publishOperation(candidateId: string, request: RememberRequest, providerId: string, hash: string, time: string): void {
    const { plan,checkpoint } = this.operation(candidateId);
    if (checkpoint.content !== 'verified' || checkpoint.providerId !== providerId || !['none','verified'].includes(checkpoint.link)) throw new MnemoWeaveError('INVALID_STATE');
    const target = this.get(plan.targetMemoryId);
    if (target.currentRevisionId !== plan.baseRevisionId || !this.db.prepare('SELECT memory_id FROM catalog_reservations WHERE memory_id=? AND operation_id=?').get(target.id,plan.id)) throw new MnemoWeaveError('INVALID_STATE');
    if (createHash('sha256').update(request.content).digest('hex') !== hash) throw new MnemoWeaveError('PROVIDER_INTEGRITY');
    this.assertUnambiguousPublication(providerId,plan.memoryId);
    if (plan.kind !== 'revise') this.db.prepare('INSERT INTO catalog_memories VALUES(?,?,?,?,?)').run(plan.memoryId,null,'active',request.scope,request.provenance.applicability);
    this.db.prepare('INSERT INTO catalog_revisions(id,memory_id,revision_number,parent_id,provider_memory_id,content_hash,candidate_id,published_at,effective_at,applicability,scope) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(plan.revisionId,plan.memoryId,plan.number,plan.parentId,providerId,hash,candidateId,time,plan.effectiveAt,request.provenance.applicability,request.scope);
    this.emit('revision', plan.revisionId, { id: plan.revisionId, memoryId: plan.memoryId, number: plan.number, parentId: plan.parentId, providerMemoryId: providerId, contentHash: hash, candidateId, publishedAt: time, effectiveAt: plan.effectiveAt, applicability: request.provenance.applicability, scope: request.scope, ...(request.projectId ? { projectId: request.projectId } : {}) });
    const changed = this.db.prepare('UPDATE catalog_memories SET current_revision_id=?,applicability=? WHERE id=? AND current_revision_id IS ?').run(plan.revisionId,request.provenance.applicability,plan.memoryId,plan.kind === 'revise' ? plan.baseRevisionId : null);
    if (changed.changes !== 1) throw new MnemoWeaveError('INVALID_STATE');
    this.emit('memory', plan.memoryId, { id: plan.memoryId, currentRevisionId: plan.revisionId, state: this.db.prepare('SELECT state FROM catalog_memories WHERE id=?').get(plan.memoryId)!['state'], scope: request.scope, ...(request.projectId ? { projectId: request.projectId } : {}), applicability: request.provenance.applicability });
    if (plan.kind !== 'revise') {
      this.db.prepare('INSERT INTO catalog_relations VALUES(?,?,?,?,?,?,?,?,?,?)').run(plan.id,plan.kind === 'supersede' ? 'Supersedes' : 'RelatedTo',plan.memoryId,plan.revisionId,plan.targetMemoryId,plan.baseRevisionId,plan.effectiveAt,plan.reason,JSON.stringify(plan.evidence),plan.kind === 'supersede' ? 1 : 0);
      this.emit('relation', plan.id, { id: plan.id, kind: plan.kind === 'supersede' ? 'Supersedes' : 'RelatedTo', sourceMemoryId: plan.memoryId, sourceRevisionId: plan.revisionId, targetMemoryId: plan.targetMemoryId, targetRevisionId: plan.baseRevisionId, effectiveAt: plan.effectiveAt, reason: plan.reason, evidence: plan.evidence, nativeProjected: plan.kind === 'supersede' });
      if (plan.kind === 'supersede') { this.db.prepare("UPDATE catalog_memories SET state='superseded' WHERE id=?").run(plan.targetMemoryId); this.emit('memory', plan.targetMemoryId, { id: plan.targetMemoryId, currentRevisionId: plan.baseRevisionId, state: 'superseded', scope: request.scope, ...(request.projectId ? { projectId: request.projectId } : {}), applicability: request.provenance.applicability }); }
    }
    this.db.prepare("UPDATE catalog_operations SET state='published' WHERE id=?").run(plan.id);
    if(plan.conflictCaseId)this.db.prepare("UPDATE catalog_conflicts SET state='resolved' WHERE id=?").run(plan.conflictCaseId);
    this.db.prepare('DELETE FROM catalog_reservations WHERE memory_id=? AND operation_id=?').run(plan.targetMemoryId,plan.id);
    this.scheduleReview(plan.memoryId, request.knowledgeType, time);
  }
  /** KNOWLEDGE-01: due times are derived; expiry only queues a review, never invalidates. */
  private scheduleReview(memoryId: string, knowledgeType: string, baseTime: string): void {
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
