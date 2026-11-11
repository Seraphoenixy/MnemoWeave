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
 * A user edit against a real published memory, with sync enabled: the change must be
 * confirmed by the remote, applied to the local Provider, and only then published.
 */

const DEVICE_TOKEN = 'e'.repeat(32);
const B_TOKEN = 'c'.repeat(32);
const SCOPE = 'project:alpha';

test('a user edit is confirmed remotely, applied locally and published once', async () => {
  const dir = resolve('work', 'edit-through-sync', randomUUID());
  mkdirSync(join(dir, 'provider'), { recursive: true });
  mkdirSync(join(dir, 'state'), { recursive: true });

  const remote = new SyncStore({ path: join(dir, 'remote.db') });
  remote.enroll('device-local', DEVICE_TOKEN, [{ scope: SCOPE, canRead: true, canWrite: true }]);
  remote.enroll('device-b', B_TOKEN, [{ scope: SCOPE, canRead: true, canWrite: true }]);
  const server: Server = createSyncServer({ gateway: remote });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Seed one published memory locally, exactly the way the candidate path publishes.
  const seedRepo = new SqliteCandidates(resolve(join(dir, 'state', 'governance.db')));
  const seedProvider = new MnemonCliProvider({ binary: mnemonBinary(), dataDir: resolve(join(dir, 'provider')), store: 'edit_sync' });
  const request = RememberInput.parse({
    idempotencyKey: `seed-${randomUUID()}`, content: '初始正文：发布路径写入。', knowledgeType: 'Practice', tags: [],
    scope: 'project', projectId: 'alpha',
    provenance: {
      source: 'local-user', sourceReference: 'e2e:seed', evidence: ['seed'], verificationStatus: 'verified',
      confidence: 1, applicability: 'alpha', limitations: '无（验收固定值）', lastVerified: '2026-11-10T07:00:00.000Z',
    },
  });
  const candidate = seedRepo.submit(request);
  const written = await seedProvider.persistReviewed(request.content, `candidate:${candidate.id}`);
  const published = seedRepo.catalog.publishInitial(candidate.id, request, written.id, createHash('sha256').update(request.content).digest('hex'), '2026-11-10T07:00:00.000Z');
  const memoryId = published.memoryId;
  seedRepo.close();

  const env: NodeJS.ProcessEnv = {
    MNEMON_BINARY: mnemonBinary(), MNEMON_DATA_DIR: join(dir, 'provider'), MNEMON_STORE: 'edit_sync',
    MNEMOWEAVE_STATE_DIR: join(dir, 'state'), MNEMOWEAVE_PORT: '0',
    MNEMOWEAVE_TOKEN: 'host-token-0123456789abcdef', MNEMOWEAVE_OPERATOR_TOKEN: 'operator-token-0123456789abcdef',
    MNEMOWEAVE_WORKER: 'off',
    MNEMOWEAVE_SYNC_URL: base, MNEMOWEAVE_SYNC_DEVICE_ID: 'device-local', MNEMOWEAVE_SYNC_TOKEN: DEVICE_TOKEN,
    MNEMOWEAVE_SYNC_INTERVAL_MS: '0',
  };
  const app = configure(env);
  try {
    assert.ok(app.client?.editMemory, 'the client edit surface must exist');
    const first = await app.client!.editMemory(memoryId, { content: '第一次编辑后的正文。', entryVersion: 0, reason: 'e2e edit' });
    assert.equal(first.entryVersion, 1);
    assert.ok(first.providerMemoryId.length > 0);

    const remotePage = remote.pull(DEVICE_TOKEN, { scope: SCOPE, since: 0, limit: 10 });
    assert.equal(remotePage.changes.length, 1);
    assert.equal(remotePage.changes[0]?.operation, 'create');
    assert.equal(remotePage.changes[0]?.entry.kind, 'formal');

    const listing = await app.client!.memories({ query: '第一次编辑', limit: 10 });
    assert.equal(listing.items.length, 1);
    assert.equal(listing.items[0]?.content, '第一次编辑后的正文。');
    assert.equal(listing.items[0]?.entryVersion, 1);

    await assert.rejects(
      app.client!.editMemory(memoryId, { content: '过期基准的编辑。', entryVersion: 0 }),
      (error: unknown) => error instanceof MnemoWeaveError && error.code === 'VERSION_CONFLICT',
    );
    assert.equal(remote.pull(DEVICE_TOKEN, { scope: SCOPE, since: 0, limit: 10 }).changes.length, 1, 'a rejected edit must not reach the remote');

    const second = await app.client!.editMemory(memoryId, { content: '第二次编辑后的正文。', entryVersion: 1 });
    assert.equal(second.entryVersion, 2);
    const changes = remote.pull(DEVICE_TOKEN, { scope: SCOPE, since: 0, limit: 10 }).changes;
    assert.equal(changes.length, 2);
    assert.equal(changes[1]?.operation, 'update');
    const listingAfter = await app.client!.memories({ query: '第二次编辑', limit: 10 });
    assert.equal(listingAfter.items[0]?.content, '第二次编辑后的正文。');
    assert.equal(listingAfter.items[0]?.entryVersion, 2);
    assert.ok(app.client?.createArchive && app.client.editArchive && app.client.archives);
    const archive = await app.client.createArchive({
      projectId: 'alpha', title: 'Design record', body: 'Original archive', source: 'user',
      verification: 'open', evidence: 'Design review',
    });
    const archiveEdit = { title: archive.title, body: 'Revised archive', verification: 'verified', evidence: archive.evidence } as const;
    const updated = await app.client.editArchive(archive.entryId, { ...archiveEdit, baseVersion: archive.version });
    assert.equal(updated.version, archive.version + 1);
    await assert.rejects(app.client.editArchive(archive.entryId, { ...archiveEdit, baseVersion: archive.version }),
      (error: unknown) => error instanceof MnemoWeaveError && error.code === 'VERSION_CONFLICT');
    assert.equal((await app.client.archives({ projectId: 'alpha' })).items[0]?.body, archiveEdit.body);
    assert.deepEqual(remote.pull(DEVICE_TOKEN, { scope: SCOPE, since: 0, limit: 10 }).changes
      .filter(change => change.entry.entryId === archive.entryId).map(change => [change.operation, change.version]), [['create', 1], ['update', 2]]);
    // One edit is one local Revision: the initial publish plus two edits is three, not four.
    // Appending from both the sync apply step and the direct-edit path doubled the history.
    const inspect = new SqliteCandidates(resolve(join(dir, 'state', 'governance.db')));
    try {
      const detail = inspect.catalog.get(memoryId);
      assert.equal(detail.revisions.length, 3, `expected 3 revisions (initial + 2 edits), got ${detail.revisions.length}`);
      assert.deepEqual(detail.revisions.map(revision => revision.number), [1, 2, 3]);
      assert.equal(detail.revisions[2]?.parentId, detail.revisions[1]?.id);
      assert.equal(detail.revisions[1]?.parentId, detail.revisions[0]?.id);
    } finally { inspect.close(); }
  } catch (error) {
    console.error('EDIT_E2E_FAILED', error);
    throw error;
  } finally {
    await app.close();
    await new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); });
    remote.close();
  }
});
