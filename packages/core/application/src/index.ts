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
import {
  DEFAULT_RECALL_QUALITY, STRICT_RECALL_QUALITY_POLICY, applyRecallQuality, relevanceFromTier,
  NORMALIZED_RELEVANCE_SCORE, type RecallQualityPolicy,
} from './recall-quality.ts';
import { lexicalRequiredMatchCount, lexicalSearchTokens, lexicalTokenMatchCount } from './search-tokens.ts';

export * from './sync.ts';
export * from './sync-apply.ts';
export * from './rules.ts';
export * from './idle-review.ts';
export * from './local-write.ts';
export * from './turn-budget.ts';
export * from './recall-quality.ts';
export * from './search-tokens.ts';

/**
 * A deterministic second pass for a smart query whose words no ranked row covers.
 *
 * `exact` anchors are the values a paraphrase must not erase — versions, identifiers, dates,
 * percentages. `lexical` is the fallback when there are too few anchors: the query's own tokens,
 * including overlapping Han character pairs.
 */
interface RecallRecoveryPlan {
  kind: 'exact' | 'lexical';
  terms: string[];
  query: string;
  requiredMatches: number;
}

const MAX_EXACT_SEARCH_ANCHORS = 8;
/** A value a semantic paraphrase must not be allowed to erase. */
const EXACT_SEARCH_ANCHOR = /(?<!\d)\d{4}-\d{1,2}-\d{1,2}(?!\d)|(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+(?![A-Za-z0-9])|(?<!\d)\d+(?:[.,]\d+)?\s*(?:[%％]|percent(?:age)?)(?![A-Za-z])|百分之\s*\d+(?:[.,]\d+)?|(?<!\d)\d{1,2}:\d{2}(?!\d)|(?<![A-Za-z0-9])v?\d+\.\d+(?:\.\d+)*(?![A-Za-z0-9])|(?<![\d.])\d+(?![\d.%％:-])/giu;

function normalizedExactText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/百分之\s*(\d+(?:[.,]\d+)?)/gu, '$1%')
    .replace(/(\d+(?:[.,]\d+)?)\s*percent(?:age)?/giu, '$1%')
    .replace(/\s+/gu, '');
}

function recallRecoveryPlan(query: string): RecallRecoveryPlan | undefined {
  const anchors = [...new Set([...query.matchAll(EXACT_SEARCH_ANCHOR)].map(match => normalizedExactText(match[0])))].slice(0, MAX_EXACT_SEARCH_ANCHORS);
  if (anchors.length >= 2) return { kind: 'exact', terms: anchors, query: anchors.join(' '), requiredMatches: Math.min(4, anchors.length) };
  const tokens = lexicalSearchTokens(query, 32);
  if (tokens.length < 4) return undefined;
  return { kind: 'lexical', terms: tokens, query, requiredMatches: lexicalRequiredMatchCount(tokens) };
}

function recoveryMatchCount(content: string, plan: RecallRecoveryPlan): number {
  if (plan.kind === 'lexical') return lexicalTokenMatchCount(content, plan.terms);
  const normalized = normalizedExactText(content);
  return plan.terms.filter(anchor => normalized.includes(anchor)).length;
}

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
   * Recall plus the Provider ids this machine never published.
   *
   * Three steps, in the upstream order:
   *
   * 1. Ask the Provider for a widened candidate pool and walk it until the candidate limit is
   *    reached, skipping rows the catalog cannot open and reporting the ones it never published.
   * 2. Apply the recall quality policy. The policy is what turns a ranking into an answer: it
   *    drops irrelevant rows and bounds the weaker relevant tiers, and it decides that from the
   *    score the caller will actually see.
   * 3. When a smart query carries high-information words that no selected row covers, run one
   *    deterministic keyword pass and admit only rows that cover them. A fusion ranking can lose
   *    an exact term to a semantically nearby neighbour; this keeps the term reachable without
   *    turning recall into a second, model-driven search.
   */
  async recallDetailed(input: unknown): Promise<RecallResult & { unregistered: string[] }> {
    const request = RecallInput.parse(input);
    const policy = STRICT_RECALL_QUALITY_POLICY;
    // The pool the policy selects from has to be wider than the page it returns, or the policy
    // could only ever choose among the Provider's own top rows.
    const candidateLimit = policy.candidateLimit(request.limit, DEFAULT_RECALL_QUALITY);
    const keyword = request.mode === 'keyword';
    const plan = (request.mode !== undefined && request.mode !== 'smart') || request.category !== undefined || request.source !== undefined
      ? undefined
      : recallRecoveryPlan(request.query);
    if (!this.candidates?.catalog) {
      const raw = await this.provider.recall({ ...request, limit: candidateLimit });
      return { ...RecallOutput.parse({ memories: this.applyPolicy(policy, raw.memories, request.limit, plan, keyword) }), unregistered: [] };
    }
    const catalog = this.candidates.catalog;
    // A Provider id is visible when it anchors at least one active logical memory.
    const visible = new Set(catalog.visibleProviderIds());
    const unmatched = new Set<string>();
    const page = 100;
    const maxWindow = 1000;
    /** Admit a Provider row when this machine may read it; count the rest. */
    const admit = (memory: NonNullable<RecallResult['memories']>[number]): boolean => {
      if (!visible.has(memory.id)) {
        if (catalog.currentMemoryIds(memory.id).length === 0) unmatched.add(memory.id);
        return false;
      }
      if (!catalog.currentMemoryIds(memory.id).some(id => catalog.get(id).state === 'active')) return false;
      return true;
    };
    let exhausted = false;
    /**
     * Walk Provider windows until the caller's page is filled with rows this machine may read.
     *
     * The first window is at least as large as the candidate pool: rows the catalog filters out
     * would otherwise consume the page before the policy ever sees it, and the policy needs a pool
     * wider than the page to choose from.
     */
    const pool: RecallResult['memories'] = [];
    const picked = new Set<string>();
    let window = Math.max(page, candidateLimit);
    while (pool.length < request.limit && !exhausted && window <= maxWindow) {
      const rows = (await this.provider.recall({ ...request, limit: window })).memories;
      // A short answer means the Provider had nothing more to give at this window.
      if (rows.length < window) exhausted = true;
      for (const memory of rows) {
        if (picked.has(memory.id)) continue;
        picked.add(memory.id);
        if (admit(memory)) pool.push(memory);
      }
      window += page;
    }
    const first = this.applyPolicy(policy, pool, request.limit, plan, keyword);
    if (plan !== undefined && !first.some(memory => recoveryMatchCount(memory.content, plan) >= plan.requiredMatches)) {
      const recovered = await this.provider
        .recall({ query: plan.query, limit: Math.min(request.limit, candidateLimit), mode: 'keyword' })
        .catch(() => null);
      if (recovered !== null) {
        // Give coverage-qualified keyword hits the first slots. Their scores and the primary
        // scores are on different scales.
        const seen = new Set<string>();
        const admitted = recovered.memories
          .map(memory => ({ memory, matches: recoveryMatchCount(memory.content, plan) }))
          .filter(entry => entry.matches >= plan.requiredMatches)
          .sort((left, right) => right.matches - left.matches || (right.memory.score ?? 0) - (left.memory.score ?? 0))
          .map(entry => entry.memory)
          .filter(memory => {
            if (seen.has(memory.id) || !admit(memory)) return false;
            seen.add(memory.id);
            return true;
          });
        const recoveredHits = this.applyPolicy(policy, admitted, request.limit, plan, true);
        const recoveredIds = new Set(recoveredHits.map(memory => memory.id));
        const remaining = this.applyPolicy(policy, pool.filter(memory => !recoveredIds.has(memory.id)),
          request.limit - recoveredHits.length, plan);
        const selected = [...recoveredHits, ...remaining];
        return { ...RecallOutput.parse({ memories: selected, complete: exhausted }), unregistered: [...unmatched] };
      }
    }
    return { ...RecallOutput.parse({ memories: first, complete: exhausted }), unregistered: [...unmatched] };
  }

  /**
   * Apply the policy and, when a recovery plan exists, put the rows that cover the query first.
   *
   * Ordering inside the selected set is stable: rows are only moved when they cover more of the
   * words the caller typed, so the two calls of one turn agree on what they already said.
   */
  private applyPolicy(
    policy: RecallQualityPolicy,
    memories: readonly NonNullable<RecallResult['memories']>[number][],
    limit: number,
    plan?: RecallRecoveryPlan,
    keyword = false,
  ): NonNullable<RecallResult['memories']> {
    const selected = applyRecallQuality(policy, memories, limit, DEFAULT_RECALL_QUALITY,
      keyword ? { kind: 'provider-native' } : NORMALIZED_RELEVANCE_SCORE);
    const ordered = plan === undefined ? selected : selected
      .map((entry, index) => ({ entry, index, matches: recoveryMatchCount(entry.memory.content, plan) }))
      .sort((left, right) => {
        const leftAdmitted = left.matches >= plan.requiredMatches;
        const rightAdmitted = right.matches >= plan.requiredMatches;
        if (leftAdmitted !== rightAdmitted) return rightAdmitted ? 1 : -1;
        if (leftAdmitted && left.matches !== right.matches) return right.matches - left.matches;
        return left.index - right.index;
      })
      .map(candidate => candidate.entry);
    // The relevance band follows the tier the policy assigned, and replaces the Provider's own
    // `confidence` label, which described a fused score that may no longer be the score shown.
    return ordered.map(({ memory, decision }) => {
      const { confidence: _confidence, ...rest } = memory;
      return { ...rest, relevance: relevanceFromTier(decision.tier) };
    });
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
    const entryVersion = this.candidates.entryVersion?.(request.memoryId) ?? 0;
    const actual = await this.provider.readMemory(revision.providerMemoryId);
    if (actual.id !== revision.providerMemoryId || createHash('sha256').update(actual.content).digest('hex') !== revision.contentHash) throw new MnemoWeaveError('PROVIDER_INTEGRITY');
    return PublishedMemoryOutput.parse({
      ...descriptor, selectedRevisionId: revisionId, selectedRevision: revision, content: actual.content,
      entryVersion,
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
