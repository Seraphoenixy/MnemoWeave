import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RECALL_QUALITY, STRICT_RECALL_QUALITY_POLICY, applyRecallQuality, relevanceFromTier,
} from '../../packages/core/application/src/recall-quality.ts';
import {
  lexicalRequiredMatchCount, lexicalSearchTokens, lexicalTokenMatchCount,
} from '../../packages/core/application/src/search-tokens.ts';

/**
 * The quality policy is what turns a Provider ranking into an answer.
 *
 * Its thresholds are the upstream ones, and the two behaviours they exist for are both tested
 * here: a bounded mid-tier (so a long list of weak matches cannot crowd out the answer) and an
 * unscored row that survives, because a Provider that ranked a row without a number still ranked
 * it — dropping it would treat "no score" as "irrelevant".
 */

const memory = (id: string, score?: number, content = id): { id: string; content: string; score?: number } =>
  ({ id, content, ...(score === undefined ? {} : { score }) });

test('a score at or above the high threshold is selected ahead of every weaker band', () => {
  // The caller passes the Provider's own order; the policy only reorders across bands, and keeps
  // the Provider's ranking inside a band so two calls of one turn agree on what they said.
  const rows = [memory('a', 0.9), memory('b', 0.7), memory('c', 0.3), memory('d', 0.26)];
  const selected = applyRecallQuality(STRICT_RECALL_QUALITY_POLICY, rows, 10);
  assert.deepEqual(selected.map(entry => entry.memory.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(selected.map(entry => entry.decision.tier), ['high', 'high', 'medium', 'medium']);
});

test('a fused score below the low threshold is dropped, not admitted as a weak answer', () => {
  const selected = applyRecallQuality(STRICT_RECALL_QUALITY_POLICY, [memory('a', 0.1), memory('b', 0.5)], 10);
  assert.deepEqual(selected.map(entry => entry.memory.id), ['b'], 'the row under 0.25 is gone');
});

test('a row with no score survives as unknown, because the Provider still ranked it', () => {
  const selected = applyRecallQuality(STRICT_RECALL_QUALITY_POLICY, [memory('a'), memory('b', 0.9)], 10);
  assert.deepEqual(selected.map(entry => entry.memory.id), ['b', 'a']);
  assert.equal(selected[1]?.decision.tier, 'unknown');
});

test('the weaker bands are bounded so a long tail cannot crowd out a strong answer', () => {
  const rows = [
    ...Array.from({ length: 10 }, (_, index) => memory(`medium-${index}`, 0.3)),
    ...Array.from({ length: 10 }, (_, index) => memory(`unknown-${index}`)),
    memory('strong', 0.95),
  ];
  const selected = applyRecallQuality(STRICT_RECALL_QUALITY_POLICY, rows, 20);
  const tiers = selected.map(entry => entry.decision.tier);
  assert.equal(tiers.filter(tier => tier === 'high').length, 1);
  assert.equal(tiers.filter(tier => tier === 'medium').length, DEFAULT_RECALL_QUALITY.maxMediumResults);
  assert.equal(tiers.filter(tier => tier === 'unknown').length, DEFAULT_RECALL_QUALITY.maxUnknownResults);
  assert.equal(selected[0]?.memory.id, 'strong', 'the strong row leads regardless of input order');
});

test('the selected page never exceeds what the caller asked for', () => {
  const rows = Array.from({ length: 12 }, (_, index) => memory(`m-${index}`, 0.9 - index * 0.01));
  assert.equal(applyRecallQuality(STRICT_RECALL_QUALITY_POLICY, rows, 5).length, 5);
});

test('a native-ordered score is kept whatever its magnitude', () => {
  const rows = [memory('a', 0.01), memory('b', 0.02)];
  const selected = applyRecallQuality(STRICT_RECALL_QUALITY_POLICY, rows, 10, DEFAULT_RECALL_QUALITY, { kind: 'provider-native' });
  assert.deepEqual(selected.map(entry => entry.memory.id), ['a', 'b'], 'ordering evidence is not a threshold');
  assert.ok(selected.every(entry => entry.decision.tier === 'ranked'));
});

test('the candidate pool is wider than the page, so the policy has something to choose from', () => {
  assert.equal(STRICT_RECALL_QUALITY_POLICY.candidateLimit(2, DEFAULT_RECALL_QUALITY), 6, 'a small page still gets three times its size');
  assert.equal(STRICT_RECALL_QUALITY_POLICY.candidateLimit(10, DEFAULT_RECALL_QUALITY), 30);
  assert.equal(STRICT_RECALL_QUALITY_POLICY.candidateLimit(40, DEFAULT_RECALL_QUALITY), 50, 'the Provider cap is respected');
});

test('every tier maps to the band the turn budget reads', () => {
  assert.equal(relevanceFromTier('high'), 'high');
  assert.equal(relevanceFromTier('medium'), 'medium');
  assert.equal(relevanceFromTier('low'), 'low');
  assert.equal(relevanceFromTier('unknown'), 'unknown');
  // A Provider-ranked row has no calibrated score but is still the Provider's answer.
  assert.equal(relevanceFromTier('ranked'), 'high');
});

test('Han text is tokenized into overlapping pairs, and coverage decides admission', () => {
  const tokens = lexicalSearchTokens('掩码通配符展开', 32);
  assert.deepEqual(tokens, ['掩码', '码通', '通配', '配符', '符展', '展开']);
  assert.equal(lexicalRequiredMatchCount(tokens), 2, 'a focused query demands more than one hit');
  const body = 'NSIS 的 CopyFiles 第二个参数是掩码（mask），不是目标目录。';
  assert.equal(lexicalTokenMatchCount(body, tokens), 1, 'one pair is not enough to call it a match');
  assert.ok(lexicalTokenMatchCount(body, tokens) < lexicalRequiredMatchCount(tokens));
});

test('a short query asks for one match, and a long one for a quarter of its tokens', () => {
  assert.equal(lexicalRequiredMatchCount(['a']), 1);
  assert.equal(lexicalRequiredMatchCount(['a', 'b', 'c']), 1);
  assert.equal(lexicalRequiredMatchCount(['a', 'b', 'c', 'd']), 2);
  assert.equal(lexicalRequiredMatchCount(Array.from({ length: 12 }, (_, index) => `t${index}`)), 3);
});
