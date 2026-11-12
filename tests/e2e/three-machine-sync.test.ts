import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { configure } from '../../apps/server/src/config.ts';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { MnemonCliProvider } from '../../packages/providers/mnemon/src/index.ts';
import { SyncStore } from '../../packages/infrastructure/sync-store/src/index.ts';
import { createSyncServer } from '../../packages/protocols/sync-http/src/index.ts';
import { MnemoWeaveError, RememberInput } from '../../packages/core/contracts/src/index.ts';
import { mnemonBinary } from './mnemon-binary.ts';

/**
 * Three machines share one stream: a stale base is rejected, the loser re-reads and
 * retries, and every machine converges on the same revision chain.
 */

const streams = [{ stream: 'formal-memories', canRead: true, canWrite: true }, { stream: 'rules', canRead: true, canWrite: true }];

/**
 * An explicit refresh that overlaps the startup pass is answered with `skipped`, which is
 * the documented behaviour for an already-running pass. Retry until one pass completes so
 * the test waits for real work instead of a skipped no-op.
 */
async function untilRefreshed(refresh: () => Promise<{ skipped: boolean }>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await refresh()).skipped) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('the sync pass kept reporting an overlap');
}

function machine(root: string, name: string, token: string, base: string) {
  const state = resolve(join(root, name, 'state'));
  const provider = resolve(join(root, name, 'provider'));
  mkdirSync(state, { recursive: true });
  mkdirSync(provider, { recursive: true });
  return configure({
    MNEMON_BINARY: mnemonBinary(), MNEMON_DATA_DIR: provider, MNEMON_STORE: `m_${name}`,
    MNEMOWEAVE_STATE_DIR: state, MNEMOWEAVE_PORT: '0',
    MNEMOWEAVE_TOKEN: `host-${name}-0123456789abcdef`, MNEMOWEAVE_OPERATOR_TOKEN: `operator-${name}-0123456789abcdef`,
    MNEMOWEAVE_WORKER: 'off',
    MNEMOWEAVE_SYNC_URL: base, MNEMOWEAVE_SYNC_DEVICE_ID: name, MNEMOWEAVE_SYNC_TOKEN: token,
    MNEMOWEAVE_SYNC_INTERVAL_MS: '0', MNEMOWEAVE_SYNC_TIMEOUT_MS: '20000',
  });
}

test('three machines converge on one revision chain and a stale base is rejected', async () => {
  const root = resolve('work', 'three-machine', randomUUID());
  mkdirSync(root, { recursive: true });
  const tokens = { a: 'a'.repeat(32), b: 'b'.repeat(32), c: 'c'.repeat(32) };
  const remote = new SyncStore({ path: join(root, 'remote.db') });
  remote.enroll('a', tokens.a, streams);
  remote.enroll('b', tokens.b, streams);
  remote.enroll('c', tokens.c, streams);
  const server: Server = createSyncServer({ gateway: remote });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Machine A starts with one published memory.
  const seedDir = resolve(join(root, 'a', 'seed'));
  mkdirSync(seedDir, { recursive: true });
  const seedRepo = new SqliteCandidates(resolve(join(root, 'a', 'state', 'governance.db')));
  const seedProvider = new MnemonCliProvider({ binary: mnemonBinary(), dataDir: resolve(join(root, 'a', 'provider')), store: 'm_a' });
  const request = RememberInput.parse({
    idempotencyKey: `seed-${randomUUID()}`, content: '三机共享的初始正文。', knowledgeType: 'Practice', tags: [],
    provenance: {
      source: 'local-user', sourceReference: 'e2e:three', evidence: ['seed'], verificationStatus: 'verified',
      confidence: 1, applicability: 'alpha', limitations: '无（验收固定值）', lastVerified: '2026-11-10T11:00:00.000Z',
    },
  });
  const candidate = seedRepo.submit(request);
  const written = await seedProvider.persistReviewed(request.content, `candidate:${candidate.id}`);
  const memoryId = seedRepo.catalog.publishInitial(candidate.id, request, written.id, createHash('sha256').update(request.content).digest('hex'), '2026-11-10T11:00:00.000Z').memoryId;
  seedRepo.close();

  const a = machine(root, 'a', tokens.a, base);
  const b = machine(root, 'b', tokens.b, base);
  const c = machine(root, 'c', tokens.c, base);
  try {
    const v1 = await a.client!.editMemory(memoryId, { content: 'A 写入的第一版。', entryVersion: 0 });
    assert.equal(v1.entryVersion, 1);

    await untilRefreshed(b.client!.syncRefresh!);
    await untilRefreshed(c.client!.syncRefresh!);
    assert.equal((await b.client!.memories({ query: 'A 写入', limit: 5 })).items[0]?.entryVersion, 1);
    assert.equal((await c.client!.memories({ query: 'A 写入', limit: 5 })).items[0]?.entryVersion, 1);

    // B and C both start from version 1; only the first one wins.
    const bWins = await b.client!.editMemory(memoryId, { content: 'B 写入的第二版。', entryVersion: 1 });
    assert.equal(bWins.entryVersion, 2);
    await assert.rejects(
      c.client!.editMemory(memoryId, { content: 'C 基于过期基准的写入。', entryVersion: 1 }),
      (error: unknown) => error instanceof MnemoWeaveError && error.code === 'VERSION_CONFLICT',
    );

    // C re-reads, then writes version 3.
    await untilRefreshed(c.client!.syncRefresh!);
    assert.equal((await c.client!.memories({ query: 'B 写入', limit: 5 })).items[0]?.entryVersion, 2);
    const cWins = await c.client!.editMemory(memoryId, { content: 'C 写入的第三版。', entryVersion: 2 });
    assert.equal(cWins.entryVersion, 3);

    // A and B converge on version 3.
    await untilRefreshed(a.client!.syncRefresh!);
    await untilRefreshed(b.client!.syncRefresh!);
    for (const app of [a, b, c]) {
      const item = (await app.client!.memories({ query: '第三版', limit: 5 })).items[0];
      assert.equal(item?.memoryId, memoryId);
      assert.equal(item?.content, 'C 写入的第三版。');
      assert.equal(item?.entryVersion, 3);
    }

    // The remote holds exactly one create and two updates, in that order.
    const changes = remote.pull(tokens.a, { stream: 'formal-memories', since: 0, limit: 20 }).changes;
    assert.deepEqual(changes.map((change) => [change.operation, change.version]), [['create', 1], ['update', 2], ['update', 3]]);

    // Each machine keeps its own Provider mapping for all three revisions.
    for (const name of ['a', 'b', 'c'] as const) {
      const repo = new SqliteCandidates(resolve(join(root, name, 'state', 'governance.db')));
      try {
        const ids = [1, 2, 3].map((version) => repo.memory.formalProviderId(memoryId, version));
        assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0), `${name} must map every revision`);
        assert.equal(new Set(ids).size, 3, `${name} must map three distinct Provider memories`);
        assert.equal(repo.memory.entryVersion(memoryId), 3);
      } finally {
        repo.close();
      }
    }
  } finally {
    await a.close();
    await b.close();
    await c.close();
    await new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); });
    remote.close();
  }
});
