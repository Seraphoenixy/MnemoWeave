import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readdirSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import type { RememberRequest } from '../../packages/core/contracts/src/index.ts';

const DAY_MS = 86_400_000;
const request = (key: string, content: string): RememberRequest => ({
  idempotencyKey: key, content, knowledgeType: 'Practice', tags: [],
  provenance: {
    source: 'blob-test', sourceReference: `fixture:${key}`, evidence: ['fixture'], verificationStatus: 'verified',
    confidence: 0.5, applicability: 'isolated blob fixture', limitations: 'not production knowledge', lastVerified: null,
  },
});

async function fixture() {
  await mkdir('work/tests', { recursive: true });
  const root = await mkdtemp(resolve('work/tests/blobs-'));
  return { root, repo: new SqliteCandidates(join(root, 'governance.db')) };
}

test('Large candidate bodies live in content-addressed files and read back intact', async () => {
  const { root, repo } = await fixture();
  try {
    const content = `Large body ${'x'.repeat(5000)}`;
    const candidate = repo.submit(request('blob-large-001', content));
    assert.equal(repo.get(candidate.id).request.content, content);
    const files = readdirSync(join(root, 'blobs'));
    assert.equal(files.length, 1);
    assert.equal(readFileSync(join(root, 'blobs', files[0]!), 'utf8'), content);
  } finally { repo.close(); }
});

test('Small candidate bodies stay inline without blob files', async () => {
  const { root, repo } = await fixture();
  try {
    const candidate = repo.submit(request('blob-small-001', 'Small inline body'));
    assert.equal(repo.get(candidate.id).request.content, 'Small inline body');
    assert.equal(readdirSync(join(root, 'blobs')).length, 0);
  } finally { repo.close(); }
});

test('Retention clearing removes the candidate blob with its metadata', async () => {
  const { root, repo } = await fixture();
  try {
    const candidate = repo.submit(request('blob-retention-001', `Retention body ${'y'.repeat(5000)}`));
    repo.review(candidate.id, 'reject', 'local-operator', 'fixture rejection', null);
    assert.equal(readdirSync(join(root, 'blobs')).length, 1);
    repo.sweepRetention(new Date(Date.now() + 31 * DAY_MS));
    assert.equal(repo.get(candidate.id).bodyCleared, true);
    assert.equal(readdirSync(join(root, 'blobs')).length, 0);
  } finally { repo.close(); }
});

test('Blob GC removes only unreferenced objects past the grace window', async () => {
  const { root, repo } = await fixture();
  try {
    const candidate = repo.submit(request('blob-gc-001', `GC body ${'z'.repeat(5000)}`));
    const referenced = readdirSync(join(root, 'blobs'))[0]!;
    const orphan = join(root, 'blobs', 'orphan-object');
    writeFileSync(orphan, 'unreferenced');
    const old = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(orphan, old, old);
    assert.equal(repo.collectBlobs(new Date()), 1);
    assert.equal(readdirSync(join(root, 'blobs')).includes(referenced), true);
    assert.equal(repo.get(candidate.id).request.content.startsWith('GC body'), true);
  } finally { repo.close(); }
});
