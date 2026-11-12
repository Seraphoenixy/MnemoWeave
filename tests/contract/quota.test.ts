import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { MnemoWeaveError } from '../../packages/core/contracts/src/index.ts';
import type { RememberRequest } from '../../packages/core/contracts/src/index.ts';
import { tempDir } from '../support/temp.ts';

const request = (key: string): RememberRequest => ({
  idempotencyKey: key,
  content: 'Quota fixture content for the governance store.',
  tags: [],
  provenance: {
    source: 'quota-test', sourceReference: 'fixture:quota', evidence: ['fixture'],
    verificationStatus: 'unverified', confidence: 0.5, applicability: 'isolated quota fixture',
    limitations: 'not production knowledge', lastVerified: null,
  },
});

async function fixture(softBytes: number, hardBytes: number) {
  await mkdir('work/tests', { recursive: true });
  const root = await tempDir('quota', 'quota');
  return new SqliteCandidates(join(root, 'governance.db'), { softBytes, hardBytes });
}

test('Hard quota rejects new candidate growth and reports hard state', async () => {
  const repo = await fixture(1, 2);
  try {
    assert.throws(
      () => repo.submit(request('quota-hard-001')),
      (error: unknown) => error instanceof MnemoWeaveError && error.code === 'QUOTA_EXCEEDED',
    );
    assert.equal(repo.storageStatus().state, 'hard');
    assert.ok(repo.storageStatus().usedBytes > 2);
  } finally { repo.close(); }
});

test('Soft quota admits new growth and reports soft state', async () => {
  const repo = await fixture(1, 1_000_000_000);
  try {
    const candidate = repo.submit(request('quota-soft-001'));
    assert.equal(candidate.status, 'pending_review');
    assert.equal(repo.storageStatus().state, 'soft');
  } finally { repo.close(); }
});

test('Quota limits must be ordered soft below hard', async () => {
  await mkdir('work/tests', { recursive: true });
  const root = await tempDir('quota', 'quota-invalid');
  assert.throws(() => new SqliteCandidates(join(root, 'governance.db'), { softBytes: 10, hardBytes: 5 }));
});
