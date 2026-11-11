import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { REVIEW_INTERVAL_DAYS } from '../../packages/infrastructure/governance/src/catalog.ts';
import { MnemoWeaveError } from '../../packages/core/contracts/src/index.ts';
import type { RememberRequest } from '../../packages/core/contracts/src/index.ts';

const DAY_MS = 86_400_000;
const request = (key: string, knowledgeType: RememberRequest['knowledgeType']): RememberRequest => ({
  idempotencyKey: key, content: `Review fixture content ${key}.`, knowledgeType, tags: [],
  provenance: {
    source: 'review-test', sourceReference: `fixture:${key}`, evidence: ['fixture'], verificationStatus: 'verified',
    confidence: 0.5, applicability: 'isolated review fixture', limitations: 'not production knowledge', lastVerified: null,
  },
});

async function published(knowledgeType: RememberRequest['knowledgeType'], publishedAt = '2026-01-01T00:00:00.000Z') {
  await mkdir('work/tests', { recursive: true });
  const root = await mkdtemp(resolve('work/tests/review-'));
  const repo = new SqliteCandidates(join(root, 'governance.db'));
  const candidate = repo.submit(request(`review-${knowledgeType}-001`, knowledgeType));
  const stored = repo.get(candidate.id).request;
  const hash = createHash('sha256').update(stored.content).digest('hex');
  const { memoryId } = repo.catalog.publishInitial(candidate.id, stored, `provider-${knowledgeType}`, hash, publishedAt);
  return { repo, memoryId };
}

test('Review intervals follow the knowledge type and only queue due reviews', async () => {
  const { repo, memoryId } = await published('Practice');
  try {
    assert.equal(REVIEW_INTERVAL_DAYS['Practice'], 90);
    assert.equal(repo.reviewDue(new Date('2026-03-31T00:00:00.000Z')).length, 0);
    const due = repo.reviewDue(new Date('2026-04-02T00:00:00.000Z'));
    assert.equal(due.length, 1);
    assert.equal(due[0]!.memoryId, memoryId);
    assert.equal(due[0]!.intervalDays, 90);
    assert.equal(due[0]!.dueAt, new Date(Date.parse('2026-01-01T00:00:00.000Z') + 90 * DAY_MS).toISOString());
    assert.equal(due[0]!.lastReviewedAt, null);
  } finally { repo.close(); }
});

test('Completing a review reschedules from now and keeps the memory active', async () => {
  const { repo, memoryId } = await published('Architecture');
  try {
    const completed = repo.completeReview(memoryId, 'local-operator', 'Re-verified against current architecture', new Date('2026-07-02T00:00:00.000Z'));
    assert.equal(completed.intervalDays, 180);
    assert.equal(completed.lastReviewedAt, '2026-07-02T00:00:00.000Z');
    assert.equal(completed.dueAt, new Date(Date.parse('2026-07-02T00:00:00.000Z') + 180 * DAY_MS).toISOString());
    assert.equal(repo.reviewDue(new Date('2026-07-03T00:00:00.000Z')).length, 0);
    assert.equal(repo.catalog.get(memoryId).state, 'active');
  } finally { repo.close(); }
});

test('Unknown memories cannot be marked reviewed', async () => {
  const { repo } = await published('Practice');
  try {
    assert.throws(() => repo.completeReview('00000000-0000-4000-8000-000000000000', 'operator', 'missing'), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'NOT_FOUND');
  } finally { repo.close(); }
});
