/**
 * Recall quality policy.
 *
 * Ported from the upstream memory-spaces Source. The Provider ranks, but a ranking is not the
 * same as an answer: it scores unrelated text above zero, and it reports a fused score rather than
 * a calibrated similarity. The policy decides, deterministically and before any caller sees a row,
 * which tiers of relevance are allowed through and how many of each.
 *
 * It is a pure function over the rows already fetched, so a retry inside one turn replays the same
 * answer instead of re-ranking it.
 */
import type { RecallResult } from '../../contracts/src/index.ts';

export type RecallRelevanceTier = 'high' | 'medium' | 'ranked' | 'low' | 'unknown';

export interface RecallQualityConfig {
  lowScoreThreshold: number;
  highScoreThreshold: number;
  candidateMultiplier: number;
  maxMediumResults: number;
  maxRankedResults: number;
  maxUnknownResults: number;
}

/**
 * Upstream defaults (`strict-v1` in the memory-spaces Source).
 *
 * 0.25 / 0.6 are not round numbers chosen here: they are the thresholds the upstream strict
 * policy ships with, and a policy that disagrees with them would rank a shared collection
 * differently on this Server than in the tool it was ported from.
 */
export const DEFAULT_RECALL_QUALITY: RecallQualityConfig = Object.freeze({
  lowScoreThreshold: 0.25,
  highScoreThreshold: 0.6,
  candidateMultiplier: 3,
  maxMediumResults: 4,
  maxRankedResults: 4,
  maxUnknownResults: 2,
});

/**
 * What a Provider's score means.
 *
 * `normalized-relevance` is calibrated in 0..1 and may be thresholded. `provider-native` carries
 * ordering only: a number small enough to look irrelevant may still be the Provider's best answer,
 * so it is never dropped by a threshold. Mnemon reports a normalized relevance, because its fused
 * score is constructed in 0..1 and its `confidence` band is derived from the same number.
 */
export type ProviderScoreSemantics =
  | { kind: 'normalized-relevance' }
  | { kind: 'provider-native' };

export const NORMALIZED_RELEVANCE_SCORE: ProviderScoreSemantics = Object.freeze({ kind: 'normalized-relevance' });

export type RecallQualityDecisionReason =
  | 'high-score' | 'medium-score' | 'low-score' | 'non-positive-score'
  | 'invalid-score' | 'native-score' | 'out-of-range-score' | 'unscored';

export interface RecallQualityCandidate {
  memory: NonNullable<RecallResult['memories']>[number];
  scoreSemantics?: ProviderScoreSemantics;
}

export interface RecallQualityDecision {
  action: 'keep' | 'drop';
  tier: RecallRelevanceTier;
  reason: RecallQualityDecisionReason;
  normalizedScore?: number;
}

export interface EvaluatedRecallQualityCandidate {
  candidate: RecallQualityCandidate;
  decision: RecallQualityDecision;
}

export interface RecallQualityPolicy {
  readonly id: string;
  candidateLimit(requestedLimit: number, config: RecallQualityConfig): number;
  evaluate(candidate: RecallQualityCandidate, config: RecallQualityConfig): RecallQualityDecision;
  select(candidates: readonly EvaluatedRecallQualityCandidate[], requestedLimit: number, config: RecallQualityConfig): EvaluatedRecallQualityCandidate[];
}

function expandedLimit(requestedLimit: number, config: RecallQualityConfig): number {
  return Math.min(50, Math.max(requestedLimit, Math.ceil(requestedLimit * config.candidateMultiplier)));
}

function scoreDecision(
  candidate: RecallQualityCandidate,
  config: RecallQualityConfig,
  lowScoreAction: RecallQualityDecision['action'],
  nonPositiveAction: RecallQualityDecision['action'],
): RecallQualityDecision {
  const score = candidate.memory.score;
  if (score === undefined) return { action: 'keep', tier: 'unknown', reason: 'unscored' };
  if (!Number.isFinite(score)) return { action: 'drop', tier: 'unknown', reason: 'invalid-score' };
  if (candidate.scoreSemantics?.kind === 'provider-native') {
    return { action: 'keep', tier: 'ranked', reason: 'native-score' };
  }
  if (score <= 0) return { action: nonPositiveAction, tier: 'low', reason: 'non-positive-score', normalizedScore: 0 };
  // A value above the declared maximum supplies ordering evidence, not calibrated confidence.
  if (score > 1) return { action: 'keep', tier: 'ranked', reason: 'out-of-range-score' };
  if (score < config.lowScoreThreshold) return { action: lowScoreAction, tier: 'low', reason: 'low-score', normalizedScore: score };
  if (score < config.highScoreThreshold) return { action: 'keep', tier: 'medium', reason: 'medium-score', normalizedScore: score };
  return { action: 'keep', tier: 'high', reason: 'high-score', normalizedScore: score };
}

/**
 * Strict: irrelevant rows are dropped, and the weaker relevant tiers are bounded.
 *
 * This is the upstream default for model-facing recall, where a large answer is worse than a short
 * one because every entry spends a turn's character budget.
 */
export const STRICT_RECALL_QUALITY_POLICY: RecallQualityPolicy = {
  id: 'strict-v1',
  candidateLimit: expandedLimit,
  evaluate: (candidate, config) => scoreDecision(candidate, config, 'drop', 'drop'),
  select(candidates, requestedLimit, config) {
    const kept = candidates.filter(candidate => candidate.decision.action === 'keep');
    let medium = 0;
    let ranked = 0;
    // The fused order of these two bounded lanes is preserved: raw score scales do not justify
    // placing every medium result ahead of every ranked one.
    const scored = kept.filter(({ decision }) =>
      decision.tier === 'medium' ? medium++ < config.maxMediumResults
        : decision.tier === 'ranked' && ranked++ < config.maxRankedResults);
    return [
      ...kept.filter(candidate => candidate.decision.tier === 'high'),
      ...scored,
      ...kept.filter(candidate => candidate.decision.tier === 'unknown').slice(0, config.maxUnknownResults),
    ].slice(0, requestedLimit);
  },
};

/** Remembering a tier as a relevance band is what the model-facing turn budget reads. */
export function relevanceFromTier(tier: RecallRelevanceTier): 'high' | 'medium' | 'low' | 'unknown' {
  switch (tier) {
    case 'high': return 'high';
    case 'medium': return 'medium';
    case 'low': return 'low';
    // A Provider-ranked row has no calibrated score but is the Provider's own answer, so it is
    // admitted like a strong match rather than demoted to unknown.
    case 'ranked': return 'high';
    case 'unknown': return 'unknown';
  }
}

/** Apply the policy to the rows already fetched and return them in the policy's order. */
export function applyRecallQuality(
  policy: RecallQualityPolicy,
  memories: readonly NonNullable<RecallResult['memories']>[number][],
  requestedLimit: number,
  config: RecallQualityConfig = DEFAULT_RECALL_QUALITY,
  scoreSemantics: ProviderScoreSemantics = NORMALIZED_RELEVANCE_SCORE,
): Array<{ memory: NonNullable<RecallResult['memories']>[number]; decision: RecallQualityDecision }> {
  const evaluated = memories.map(memory => {
    const candidate: RecallQualityCandidate = { memory, scoreSemantics };
    return { candidate, decision: policy.evaluate(candidate, config) };
  });
  return policy.select(evaluated, requestedLimit, config)
    .map(({ candidate, decision }) => ({ memory: candidate.memory, decision }));
}
