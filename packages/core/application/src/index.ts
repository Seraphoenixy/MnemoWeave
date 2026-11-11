import { mayRead, assertGrant } from './access.ts';

export * from './sync.ts';
export * from './sync-apply.ts';
export * from './rules.ts';
export * from './local-write.ts';
import type { ReadGrantRecord } from '../../contracts/src/index.ts';
import { MnemoWeaveError, RecallInput, RecallOutput, ProviderHealth, RememberInput, CandidateIdInput, HumanReviewInput, RetryInput, MemoryIdInput, PublishedMemoryOutput,ConflictResolutionInput,ConflictIdInput,CancelVersionInput, ReviewCompleteInput, ReviewDueItem, ReviewDueOutput } from '../../contracts/src/index.ts';
import type {ConflictResolutionRequest} from '../../contracts/src/index.ts';
import type { ReviewDueItemRecord } from '../../contracts/src/index.ts';
import { createHash } from 'node:crypto';
import type { MemoryCatalogReader } from './catalog-ports.ts';
import type { WorkflowRepository } from './workflow-ports.ts';
import type { RecallRequest, RecallResult, Health } from '../../contracts/src/index.ts';
import type { CandidateRecord, RememberRequest } from '../../contracts/src/index.ts';

export interface MemoryProvider {
  health(): Promise<Health>;
  recall(request: RecallRequest): Promise<RecallResult>;
  readMemory?(id: string): Promise<{ id: string; content: string }>;
  /**
   * Read several bodies in one call. Optional so a test provider can omit it; the list view uses
   * it to avoid one process per visible row.
   */
  readMany?(ids: string[]): Promise<{ id: string; content: string }[]>;
}
/** Owns only candidate/governance data; never reads Provider tables. */
export interface CandidateRepository {
  submit(request: RememberRequest): CandidateRecord;
  get(candidateId: string): CandidateRecord;
  readonly catalog?: MemoryCatalogReader;
  /** Synced version of a logical memory; absent when sync has never applied it (version 0). */
  entryVersion?(memoryId: string): number;
}
export interface ReviewRepository extends CandidateRepository, WorkflowRepository {
  amend(id: string, request: RememberRequest, actor: string, reason: string): CandidateRecord;
  resolveConflict(input:ConflictResolutionRequest,actor:string):CandidateRecord;
  cancelVersion(candidateId:string,actor:string,reason:string):CandidateRecord;
  /** KNOWLEDGE-01 review queue and completion (optional so test stores can omit it). */
  reviewDue?(now?: Date): ReviewDueItemRecord[];
  completeReview?(memoryId: string, actor: string, reason: string, now?: Date): ReviewDueItemRecord;
}
export class MemoryApplication {
  private readonly provider: MemoryProvider;
  private readonly candidates: CandidateRepository | undefined;
  private readonly reviewRepository: ReviewRepository | undefined;
  constructor(provider: MemoryProvider, candidates?: CandidateRepository, reviewRepository?: ReviewRepository) { this.provider = provider; this.candidates = candidates; this.reviewRepository = reviewRepository; }
  get acceptsCandidates(): boolean { return this.candidates !== undefined; }
  /** Publication metadata reader for View assembly; undefined without candidate storage. */
  get catalogReader(): MemoryCatalogReader | undefined { return this.candidates?.catalog; }
  async health(): Promise<Health> { return ProviderHealth.parse(await this.provider.health()); }
  async recall(input: unknown, grant?: ReadGrantRecord): Promise<RecallResult> {
    const { unregistered: _unregistered, ...result } = await this.recallDetailed(input, grant);
    return result;
  }

  /**
   * Recall plus the Provider ids this machine never published. The View reports them as
   * `excluded: 'unregistered'` instead of dropping them silently; `/v1/recall` keeps the
   * wire shape and does not expose the extra list.
   */
  async recallDetailed(input: unknown, grant?: ReadGrantRecord): Promise<RecallResult & { unregistered: string[] }> {
    if (grant) assertGrant(grant);
    const request = RecallInput.parse(input);
    if (this.candidates?.catalog) {
      // Filter-first pagination: expand the Provider window until the requested page is
      // filled from the visible set or the Provider list is exhausted, so a large visible
      // pool can no longer push matching results out of a fixed 100-record fetch.
      const catalog = this.candidates.catalog;
      const visible = new Set(catalog.visibleProviderIds().filter(id => !grant || catalog.currentMemoryIds(id).some(logicalId => mayRead(grant))));
      const unmatched = new Set<string>();
      const page = 100;
      const maxWindow = 1000;
      const selected: RecallResult['memories'] = [];
      const picked = new Set<string>();
      let window = page;
      let exhausted = false;
      while (selected.length < request.limit && !exhausted && window <= maxWindow) {
        const raw = await this.provider.recall({ query: request.query, limit: window });
        exhausted = raw.memories.length < window;
        for (const memory of raw.memories) {
          if (selected.length >= request.limit) break;
          if (!visible.has(memory.id)) { if (catalog.currentMemoryIds(memory.id).length === 0) unmatched.add(memory.id); continue; }
          if (picked.has(memory.id)) continue;
          picked.add(memory.id);
          selected.push(memory);
        }
        window += page;
      }
      if (grant) assertGrant(grant);
      const authorized = selected.filter(memory => !grant || catalog.currentMemoryIds(memory.id).some(id => { const descriptor = catalog.get(id); return descriptor.state === 'active' && mayRead(grant); }));
      return { ...RecallOutput.parse({ memories: authorized, complete: exhausted }), unregistered: [...unmatched] };
    }
    if (grant) throw new MnemoWeaveError('REVIEW_REQUIRED');
    return { ...RecallOutput.parse(await this.provider.recall(request)), unregistered: [] };
  }
  async remember(input: unknown, grant?: ReadGrantRecord): Promise<CandidateRecord> {
    if (!this.candidates) throw new MnemoWeaveError('REVIEW_REQUIRED');
    const request = RememberInput.parse(input);
    if (grant && !mayRead(grant)) throw new MnemoWeaveError('UNAUTHORIZED');
    if (grant && request.change) { if (!this.candidates.catalog?.get(request.change.targetMemoryId) || !mayRead(grant)) throw new MnemoWeaveError('UNAUTHORIZED'); }
    return this.candidates.submit(request);
  }
  async candidateStatus(input: unknown, grant?: ReadGrantRecord): Promise<CandidateRecord> {
    if (!this.candidates) throw new MnemoWeaveError('REVIEW_REQUIRED');
    const candidate = this.candidates.get(CandidateIdInput.parse(input).candidateId);
    if (grant) { assertGrant(grant); if (!mayRead(grant)) throw new MnemoWeaveError('UNAUTHORIZED'); }
    return candidate;
  }
  async readMemory(input: unknown, grant?: ReadGrantRecord) {
    if (!this.candidates?.catalog || !this.provider.readMemory) throw new MnemoWeaveError('REVIEW_REQUIRED');
    const request = MemoryIdInput.parse(input);
    const descriptor = this.candidates.catalog.get(request.memoryId);
    if (grant) { assertGrant(grant); if (!mayRead(grant)) throw new MnemoWeaveError('UNAUTHORIZED'); }
    const revisionId = request.revisionId ?? descriptor.currentRevisionId;
    const revision = descriptor.revisions.find(value => value.id === revisionId);
    if (!revision) throw new MnemoWeaveError('NOT_FOUND');
    const actual = await this.provider.readMemory(revision.providerMemoryId);
    if (actual.id !== revision.providerMemoryId || createHash('sha256').update(actual.content).digest('hex') !== revision.contentHash) throw new MnemoWeaveError('PROVIDER_INTEGRITY');
    if (grant) assertGrant(grant);
    const visible = descriptor;
    return PublishedMemoryOutput.parse({ ...visible, selectedRevisionId: revisionId,selectedRevision:revision, content: actual.content, entryVersion: this.candidates.entryVersion?.(request.memoryId) ?? 0 });
  }
  async readConflict(input:unknown, grant?: ReadGrantRecord){
    if(!this.candidates?.catalog)throw new MnemoWeaveError('REVIEW_REQUIRED');
    const record = this.candidates.catalog.getConflict(ConflictIdInput.parse(input).caseId);
    if (grant) { assertGrant(grant); if (!mayRead(grant)) throw new MnemoWeaveError('UNAUTHORIZED'); }
    return record;
  }
  async resolveConflict(input:unknown,operator:string){
    if(!this.reviewRepository)throw new MnemoWeaveError('REVIEW_REQUIRED');
    return this.reviewRepository.resolveConflict(ConflictResolutionInput.parse(input),operator);
  }
  async cancelVersion(input:unknown,operator:string){
    if(!this.reviewRepository)throw new MnemoWeaveError('REVIEW_REQUIRED');
    const request=CancelVersionInput.parse(input);return this.reviewRepository.cancelVersion(request.candidateId,operator,request.reason);
  }
  /** KNOWLEDGE-01: due reviews stay visible and valid; completion only reschedules. */
  async reviewDue() {
    if (!this.reviewRepository?.reviewDue) throw new MnemoWeaveError('REVIEW_REQUIRED');
    return ReviewDueOutput.parse({ items: this.reviewRepository.reviewDue() });
  }
  async completeReview(input: unknown, operator: string): Promise<ReviewDueItemRecord> {
    if (!this.reviewRepository?.completeReview) throw new MnemoWeaveError('REVIEW_REQUIRED');
    const request = ReviewCompleteInput.parse(input);
    return ReviewDueItem.parse(this.reviewRepository.completeReview(request.memoryId, operator, request.reason));
  }
  /** Called only by the authenticated operator protocol, never exposed as a model tool. */
  async humanReview(input: unknown, operator: string): Promise<CandidateRecord> {
    if (!this.reviewRepository) throw new MnemoWeaveError('REVIEW_REQUIRED');
    const review = HumanReviewInput.parse(input);
    const candidate = this.reviewRepository.get(review.candidateId);
    if (candidate.status !== 'needs_review') throw new MnemoWeaveError('INVALID_STATE');
    if (review.decision === 'amend') return this.reviewRepository.amend(candidate.id, review.replacement!, operator, review.reason);
    if (review.decision === 'approve') {
      const conflicting = candidate.reviews.some(value => {
        const record = value as { assessment?: { conflict?: string } | null };
        return record.assessment?.conflict && record.assessment.conflict !== 'none' && record.assessment.conflict !== 'different_scope';
      });
      // Revision/replacement writes need their own design; do not turn unresolved conflicts into independent facts.
      if (conflicting && !candidate.request.change) throw new MnemoWeaveError('REVIEW_REQUIRED');
      // Interception must not depend on review records: an unresolved conflict case on the
      // target memory blocks any other candidate's new conclusion until it is adjudicated.
      const catalog = this.reviewRepository?.catalog ?? this.candidates?.catalog;
      if (candidate.request.change && catalog) {
        const target = catalog.get(candidate.request.change.targetMemoryId);
        if (target.conflicts.some(item => item.candidateId !== candidate.id && item.followUpCandidateId !== candidate.id && ['open', 'unverified', 'resolving'].includes(item.state))) throw new MnemoWeaveError('REVIEW_REQUIRED');
      }
    }
    return this.reviewRepository.review(candidate.id, review.decision, operator, review.reason, null);
  }
  async retryWrite(input: unknown, operator: string): Promise<CandidateRecord> {
    if (!this.reviewRepository) throw new MnemoWeaveError('REVIEW_REQUIRED');
    const retry = RetryInput.parse(input);
    return this.reviewRepository.retry(retry.candidateId, operator, retry.reason);
  }
}
