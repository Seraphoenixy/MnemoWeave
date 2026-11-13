import { createHash } from 'node:crypto';
import { MnemoWeaveError } from '../../contracts/src/index.ts';
import {
  CandidateIdInput, ConflictIdInput, ConflictResolutionInput, HumanReviewInput, MemoryIdInput,
  PublishedMemoryOutput, RecallInput, RecallOutput, RememberInput, RetryInput, CancelVersionInput,
  EmbeddingDiagnostics, ProviderHealth,
} from '../../contracts/src/index.ts';
import type {
  CandidateRecord, ConflictResolutionRequest, EmbeddingDiagnosticsRecord, Health, ProviderEmbeddingStatusRecord,
  ProviderGraphRecord, ProviderStatsRecord, RecallResult, RememberRequest,
} from '../../contracts/src/index.ts';
import type { MemoryCatalogReader } from './catalog-ports.ts';
import type { WorkflowRepository } from './workflow-ports.ts';

export * from './sync.ts';
export * from './sync-apply.ts';
export * from './rules.ts';
export * from './idle-review.ts';
export * from './local-write.ts';
export * from './turn-budget.ts';

export interface MemoryProvider {
  health(): Promise<Health>;
  recall(request: { query: string; limit: number; mode?: 'smart' | 'keyword' | 'basic' | undefined; category?: string | undefined; source?: string | undefined }): Promise<RecallResult>;
  /** Official embedding coverage report; absent when the Provider has no such interface. */
  embeddingStatus?(): Promise<ProviderEmbeddingStatusRecord>;
  /** Backfill missing vectors; absent when the Provider cannot do it. */
  embedAll?(): Promise<{ error: string | null }>;
  readMemory?(id: string): Promise<{ id: string; content: string }>;
  /** Read several bodies in one call, so a page does not pay one process per visible row. */
  readMany?(ids: string[]): Promise<{ id: string; content: string }[]>;
  /**
   * The Provider's whole store, not a page of it.
   *
   * A list that can only show rows this Server already catalogued answers a different question
   * than "what memories exist": anything written by another tool, or before this Server had a
   * catalog, would be invisible. The Provider owns the library, so it is asked for all of it.
   */
  listAll?(): Promise<NonNullable<RecallResult['memories']>>;
  /** The Provider's own accounting: counts, categories and the entity frequency table. */
  stats?(): Promise<ProviderStatsRecord>;
  /** The Provider's own relation graph, as it draws it. */
  graph?(): Promise<ProviderGraphRecord>;
}
/** Owns candidate and governance data; never reads Provider tables. */
export interface CandidateRepository {
  submit(request: RememberRequest): CandidateRecord;
  get(candidateId: string): CandidateRecord;
  readonly catalog?: MemoryCatalogReader;
  entryVersion?(memoryId: string): number;
}
export interface ReviewRepository extends CandidateRepository, WorkflowRepository {
  amend(id: string, request: RememberRequest, actor: string, reason: string): CandidateRecord;
  resolveConflict(input: ConflictResolutionRequest, actor: string): CandidateRecord;
  cancelVersion(candidateId: string, actor: string, reason: string): CandidateRecord;
}

/**
 * Application Core.
 *
 * Formal memories are one shared collection: recall, listing, the graph and detail never take a
 * workspace and never filter by one. The Provider ranks and the catalog maps, so what a caller
 * reads is the same set on every authorized device.
 */
export class MemoryApplication {
  private readonly provider: MemoryProvider;
  private readonly candidates: CandidateRepository | undefined;
  private readonly reviewRepository: ReviewRepository | undefined;
  constructor(provider: MemoryProvider, candidates?: CandidateRepository, reviewRepository?: ReviewRepository) {
    this.provider = provider; this.candidates = candidates; this.reviewRepository = reviewRepository;
  }
  get acceptsCandidates(): boolean { return this.candidates !== undefined; }
  get catalogReader(): MemoryCatalogReader | undefined { return this.candidates?.catalog; }
  async health(): Promise<Health> { return ProviderHealth.parse(await this.provider.health()); }

  /**
   * Recall diagnosis: what the Provider reports about its embedding backend, interpreted into a
   * recall mode. The Server does not probe the embedding service itself.
   */
  async embeddingDiagnostics(): Promise<EmbeddingDiagnosticsRecord> {
    const checkedAt = new Date().toISOString();
    const unknown = (lastError: string) => EmbeddingDiagnostics.parse({
      provider: 'mnemon', model: 'unknown', protocol: 'unknown', serviceAvailable: false, modelAvailable: false,
      embedded: 0, total: 0, coverage: 0, recallMode: 'unknown', degraded: true, lastError, checkedAt,
    });
    if (!this.provider.embeddingStatus) return unknown('the Provider does not expose embedding status');
    let status: ProviderEmbeddingStatusRecord;
    try {
      status = await this.provider.embeddingStatus();
    } catch (error) {
      return unknown(error instanceof MnemoWeaveError ? error.code : 'PROVIDER_UNAVAILABLE');
    }
    const coverage = status.total === 0 ? 0 : Math.min(1, status.embedded / status.total);
    const semantic = status.serviceAvailable && status.modelAvailable && status.embedded > 0;
    return EmbeddingDiagnostics.parse({
      provider: 'mnemon', model: status.model, protocol: status.protocol,
      serviceAvailable: status.serviceAvailable, modelAvailable: status.modelAvailable,
      embedded: status.embedded, total: status.total, coverage,
      recallMode: semantic ? 'semantic' : 'keyword',
      degraded: !status.serviceAvailable || !status.modelAvailable || status.embedded < status.total,
      lastError: !status.serviceAvailable ? 'embedding service unreachable'
        : !status.modelAvailable ? 'embedding model unavailable'
          : status.embedded < status.total ? 'some insights have no vector yet'
            : null,
      checkedAt,
    });
  }

  async recall(input: unknown): Promise<RecallResult> {
    const { unregistered: _unregistered, ...result } = await this.recallDetailed(input);
    return result;
  }

  /**
   * Recall plus the Provider ids this machine never published. Provider hits that have no
   * catalog entry are reported rather than silently dropped; withdrawn and superseded catalog
   * entries are excluded before the Provider window is walked, so a page is not consumed by
   * rows the caller could not read anyway.
   */
  async recallDetailed(input: unknown): Promise<RecallResult & { unregistered: string[] }> {
    const request = RecallInput.parse(input);
    if (!this.candidates?.catalog) return { ...RecallOutput.parse(await this.provider.recall(request)), unregistered: [] };
    const catalog = this.candidates.catalog;
    // A Provider id is visible when it anchors at least one active logical memory.
    const visible = new Set(catalog.visibleProviderIds());
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
        if (!visible.has(memory.id)) {
          if (catalog.currentMemoryIds(memory.id).length === 0) unmatched.add(memory.id);
          continue;
        }
        if (picked.has(memory.id)) continue;
        picked.add(memory.id);
        selected.push(memory);
      }
      window += page;
    }
    const authorized = selected.filter(memory => catalog.currentMemoryIds(memory.id)
      .some(id => catalog.get(id).state === 'active'));
    return { ...RecallOutput.parse({ memories: authorized, complete: exhausted }), unregistered: [...unmatched] };
  }

  /** A candidate submission; the caller must already have a trusted turn binding. */
  async remember(input: unknown): Promise<CandidateRecord> {
    if (!this.candidates) throw new MnemoWeaveError('REVIEW_REQUIRED');
    return this.candidates.submit(RememberInput.parse(input));
  }
  async candidateStatus(input: unknown): Promise<CandidateRecord> {
    if (!this.candidates) throw new MnemoWeaveError('REVIEW_REQUIRED');
    return this.candidates.get(CandidateIdInput.parse(input).candidateId);
  }
  async readMemory(input: unknown) {
    if (!this.candidates?.catalog || !this.provider.readMemory) throw new MnemoWeaveError('REVIEW_REQUIRED');
    const request = MemoryIdInput.parse(input);
    const descriptor = this.candidates.catalog.get(request.memoryId);
    const revisionId = request.revisionId ?? descriptor.currentRevisionId;
    const revision = descriptor.revisions.find(value => value.id === revisionId);
    if (!revision) throw new MnemoWeaveError('NOT_FOUND');
    const actual = await this.provider.readMemory(revision.providerMemoryId);
    if (actual.id !== revision.providerMemoryId || createHash('sha256').update(actual.content).digest('hex') !== revision.contentHash) throw new MnemoWeaveError('PROVIDER_INTEGRITY');
    return PublishedMemoryOutput.parse({
      ...descriptor, selectedRevisionId: revisionId, selectedRevision: revision, content: actual.content,
      entryVersion: this.candidates.entryVersion?.(request.memoryId) ?? 0,
    });
  }
  async readConflict(input: unknown) {
    if (!this.candidates?.catalog) throw new MnemoWeaveError('REVIEW_REQUIRED');
    return this.candidates.catalog.getConflict(ConflictIdInput.parse(input).caseId);
  }
  async resolveConflict(input: unknown, operator: string) {
    if (!this.reviewRepository) throw new MnemoWeaveError('REVIEW_REQUIRED');
    return this.reviewRepository.resolveConflict(ConflictResolutionInput.parse(input), operator);
  }
  async cancelVersion(input: unknown, operator: string) {
    if (!this.reviewRepository) throw new MnemoWeaveError('REVIEW_REQUIRED');
    const request = CancelVersionInput.parse(input);
    return this.reviewRepository.cancelVersion(request.candidateId, operator, request.reason);
  }
  /** Called only by the authenticated operator protocol, never exposed as a model tool. */
  async humanReview(input: unknown, operator: string): Promise<CandidateRecord> {
    if (!this.reviewRepository) throw new MnemoWeaveError('REVIEW_REQUIRED');
    const review = HumanReviewInput.parse(input);
    const candidate = this.reviewRepository.get(review.candidateId);
    if (candidate.status !== 'needs_review') throw new MnemoWeaveError('INVALID_STATE');
    if (review.decision === 'amend') return this.reviewRepository.amend(candidate.id, review.replacement!, operator, review.reason);
    if (review.decision === 'approve') {
      const catalog = this.reviewRepository?.catalog ?? this.candidates?.catalog;
      if (candidate.request.change && catalog) {
        const target = catalog.get(candidate.request.change.targetMemoryId);
        if (target.conflicts.some(item => item.candidateId !== candidate.id && item.followUpCandidateId !== candidate.id && ['open', 'unverified', 'resolving'].includes(item.state))) throw new MnemoWeaveError('REVIEW_REQUIRED');
      }
    }
    return this.reviewRepository.review(candidate.id, review.decision, operator, review.reason);
  }
  async retryWrite(input: unknown, operator: string): Promise<CandidateRecord> {
    if (!this.reviewRepository) throw new MnemoWeaveError('REVIEW_REQUIRED');
    const retry = RetryInput.parse(input);
    return this.reviewRepository.retry(retry.candidateId, operator, retry.reason);
  }
}
