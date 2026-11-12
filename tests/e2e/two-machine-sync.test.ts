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
import { RememberInput } from '../../packages/core/contracts/src/index.ts';
import { mnemonBinary } from './mnemon-binary.ts';

/**
 * Two machines, each with its own Server and Mnemon, share one remote stream. A write
 * on one side becomes visible, editable and re-synchronised on the other.
 */

const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);

/**
 * An explicit refresh that overlaps the startup pass is answered with `skipped`, which is
 * the documented behaviour for an already-running pass. Retry until one pass completes so
 * the test waits for real work instead of a skipped no-op.
 */
async function untilRefreshed(refresh: () => Promise<{ skipped: boolean }>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: { skipped: boolean } = { skipped: true };
  while (Date.now() < deadline) {
    last = await refresh();
    if (!last.skipped) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('the sync pass kept reporting an overlap');
}

test('a memory written on one machine is editable on the other and returns updated', async () => {
  const root = resolve('work', 'two-machine', randomUUID());
  const [stateA, stateB, providerA, providerB] = ['a/state', 'b/state', 'a/provider', 'b/provider'].map((part) => {
    const path = join(root, part);
    mkdirSync(path, { recursive: true });
    return resolve(path);
  }) as [string, string, string, string];
  const streams = [{ stream: 'formal-memories', canRead: true, canWrite: true }, { stream: 'rules', canRead: true, canWrite: true }];
  const remote = new SyncStore({ path: join(root, 'remote.db') });
  remote.enroll('machine-a', TOKEN_A, streams);
  remote.enroll('machine-b', TOKEN_B, streams);
  const server: Server = createSyncServer({ gateway: remote });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Machine A starts with one memory published through the normal candidate path.
  const seed = new SqliteCandidates(resolve(join(stateA, 'governance.db')));
  const seedProvider = new MnemonCliProvider({ binary: mnemonBinary(), dataDir: providerA, store: 'machine_a' });
  const request = RememberInput.parse({
    idempotencyKey: `seed-${randomUUID()}`, content: '机器 A 写入的初始正文。', knowledgeType: 'Practice', tags: [],
    provenance: {
      source: 'local-user', sourceReference: 'e2e:two-machine', evidence: ['seed'], verificationStatus: 'verified',
      confidence: 1, applicability: 'alpha', limitations: '无（验收固定值）', lastVerified: '2026-11-10T08:00:00.000Z',
    },
  });
  const candidate = seed.submit(request);
  const written = await seedProvider.persistReviewed(request.content, `candidate:${candidate.id}`);
  const memoryId = seed.catalog.publishInitial(candidate.id, request, written.id, createHash('sha256').update(request.content).digest('hex'), '2026-11-10T08:00:00.000Z').memoryId;
  seed.close();

  const machine = (device: string, token: string, state: string, provider: string) => configure({
    MNEMON_BINARY: mnemonBinary(), MNEMON_DATA_DIR: provider, MNEMON_STORE: `machine_${device.at(-1)}`,
    MNEMOWEAVE_STATE_DIR: state, MNEMOWEAVE_PORT: '0',
    MNEMOWEAVE_TOKEN: `host-token-${device}-0123456789`, MNEMOWEAVE_OPERATOR_TOKEN: `operator-token-${device}-0123456789`,
    MNEMOWEAVE_WORKER: 'off',
    MNEMOWEAVE_SYNC_URL: base, MNEMOWEAVE_SYNC_DEVICE_ID: device, MNEMOWEAVE_SYNC_TOKEN: token,
    MNEMOWEAVE_SYNC_INTERVAL_MS: '0',
  });
  const a = machine('machine-a', TOKEN_A, stateA, providerA);
  const b = machine('machine-b', TOKEN_B, stateB, providerB);
  try {
    // A edits; the change is confirmed remotely and applied locally.
    const first = await a.client!.editMemory(memoryId, { content: '机器 A 编辑后的正文。', entryVersion: 0, reason: 'A edit' });
    assert.equal(first.entryVersion, 1);

    // B pulls, mirrors the memory into its own Provider and catalog, and can read it.
    // The startup pass may still be running when the explicit refresh arrives; an overlap is
    // reported as `skipped` rather than queued, so retry until a pass actually completes.
    await untilRefreshed(b.client!.syncRefresh!);
    const onB = await b.client!.memories({ query: '机器 A 编辑', limit: 10 });
    assert.equal(onB.items.length, 1);
    assert.equal(onB.items[0]?.memoryId, memoryId);
    assert.equal(onB.items[0]?.content, '机器 A 编辑后的正文。');
    assert.equal(onB.items[0]?.entryVersion, 1);

    // B edits the synced memory; the remote accepts it as version 2.
    const second = await b.client!.editMemory(memoryId, { content: '机器 B 编辑后的正文。', entryVersion: 1, reason: 'B edit' });
    assert.equal(second.entryVersion, 2);
    const changes = remote.pull(TOKEN_B, { stream: 'formal-memories', since: 0, limit: 10 }).changes;
    assert.deepEqual(changes.map((change) => [change.operation, change.version]), [['create', 1], ['update', 2]]);

    // A pulls the new version and shows it.
    await untilRefreshed(a.client!.syncRefresh!);
    const onA = await a.client!.memories({ query: '机器 B 编辑', limit: 10 });
    assert.equal(onA.items.length, 1);
    assert.equal(onA.items[0]?.content, '机器 B 编辑后的正文。');
    assert.equal(onA.items[0]?.entryVersion, 2);

    const statusA = await a.client!.syncStatus!();
    const statusB = await b.client!.syncStatus!();
    for (const status of [statusA, statusB]) {
      for (const stream of status.streams) assert.equal(stream.pending, 0, JSON.stringify(stream));
      assert.ok(status.streams.some((stream) => stream.stream === 'formal-memories'), 'the formal-memory stream must be tracked');
    }
  } finally {
    await a.close();
    await b.close();
    await new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); });
    remote.close();
  }
});
