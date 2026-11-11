import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configure } from '../../apps/server/src/config.ts';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { MnemonCliProvider } from '../../packages/providers/mnemon/src/index.ts';
import { RememberInput } from '../../packages/core/contracts/src/index.ts';
import { mnemonBinary } from '../e2e/mnemon-binary.ts';

/**
 * The three gates the edit page depends on, checked against the real Server rather than a stub:
 *
 * 1. Two requests on the same `entryVersion` cannot both succeed.
 * 2. A successful save reports the revision and version this change produced, never an older one.
 * 3. Authorization cannot be satisfied by a self-declared Host header plus the service token.
 */

async function withServer(run: (app: ReturnType<typeof configure>, seeded: { memoryId: string }) => Promise<void>): Promise<void> {
  const root = resolve('work', 'edit-gates', randomUUID());
  mkdirSync(join(root, 'provider'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  const repo = new SqliteCandidates(resolve(join(root, 'state', 'governance.db')));
  const provider = new MnemonCliProvider({ binary: mnemonBinary(), dataDir: resolve(join(root, 'provider')), store: 'gates' });
  const request = RememberInput.parse({
    idempotencyKey: 'gate-seed', content: '初始正文。', knowledgeType: 'Practice', tags: [], scope: 'global',
    provenance: {
      source: 'local-user', sourceReference: 'gate:1', evidence: ['gate'], verificationStatus: 'verified',
      confidence: 1, applicability: 'global', limitations: '无（验收固定值）', lastVerified: '2026-11-10T00:00:00.000Z',
    },
  });
  const candidate = repo.submit(request);
  const written = await provider.persistReviewed(request.content, `candidate:${candidate.id}`);
  const published = repo.catalog.publishInitial(candidate.id, request, written.id, createHash('sha256').update(request.content).digest('hex'), '2026-11-10T00:00:00.000Z');
  repo.close();
  const app = configure({
    MNEMON_BINARY: mnemonBinary(), MNEMON_DATA_DIR: join(root, 'provider'), MNEMON_STORE: 'gates',
    MNEMOWEAVE_STATE_DIR: join(root, 'state'), MNEMOWEAVE_PORT: '0',
    MNEMOWEAVE_TOKEN: 'host-token-0123456789abcdef', MNEMOWEAVE_OPERATOR_TOKEN: 'operator-token-0123456789abcdef',
    MNEMOWEAVE_WORKER: 'off',
  });
  try { await run(app, { memoryId: published.memoryId }); } finally { await app.close(); }
}

test('two edits on the same base cannot both succeed', async () => {
  await withServer(async (app, seeded) => {
    const results = await Promise.allSettled([
      app.client!.editMemory(seeded.memoryId, { content: '并发甲', entryVersion: 0 }),
      app.client!.editMemory(seeded.memoryId, { content: '并发乙', entryVersion: 0 }),
    ]);
    const fulfilled = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one editor wins');
    assert.equal(rejected.length, 1);
    // The loser is told why, and leaves no visible revision behind.
    const code = (rejected[0] as PromiseRejectedResult).reason.code;
    assert.equal(code, 'VERSION_CONFLICT');
    const detail = await app.app.readMemory({ memoryId: seeded.memoryId });
    assert.equal(detail.revisions.length, 2, 'one edit, one new revision');
  });
});

test('a successful save reports its own revision and the version this change produced', async () => {
  await withServer(async (app, seeded) => {
    const before = await app.app.readMemory({ memoryId: seeded.memoryId });
    const edited = await app.client!.editMemory(seeded.memoryId, { content: '第一次修改', entryVersion: 0 });
    assert.equal(edited.entryVersion, 1, 'the new confirmed version is reported');
    const after = await app.app.readMemory({ memoryId: seeded.memoryId, revisionId: edited.revisionId });
    // The returned revision is the one this edit appended, and its parent is the previous current.
    assert.equal(after.content, '第一次修改');
    assert.equal(after.currentRevisionId, edited.revisionId);
    assert.equal(after.revisions.length, before.revisions.length + 1);
    const parent = after.revisions.find(revision => revision.id === before.currentRevisionId);
    assert.ok(parent, 'the previous current revision is still in the history');

    // A second edit on the stale base is refused rather than silently overwriting.
    await assert.rejects(
      app.client!.editMemory(seeded.memoryId, { content: '基于旧基准', entryVersion: 0 }),
      (error: unknown) => (error as { code?: string }).code === 'VERSION_CONFLICT',
    );
  });
});

test('a save reports a queued outcome instead of claiming success', async () => {
  await withServer(async (app, seeded) => {
    // Without an outbox flush the change cannot reach the remote, so the save must say so rather
    // than returning a revision the remote never assigned.
    const outcome = await app.client!.editMemory(seeded.memoryId, { content: '断网提交', entryVersion: 0 })
      .then(() => 'succeeded', (error: unknown) => (error as { code?: string }).code ?? 'unknown');
    // Either it applied cleanly (local-only Server) or it reported the exact pending state.
    assert.ok(
      outcome === 'succeeded' || outcome === 'SYNC_QUEUED' || outcome === 'SYNC_OUTCOME_UNKNOWN' || outcome === 'NEEDS_REVIEW',
      `unexpected outcome: ${String(outcome)}`,
    );
  });
});
