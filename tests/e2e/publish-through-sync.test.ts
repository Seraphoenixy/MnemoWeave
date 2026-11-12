import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { configure } from '../../apps/server/src/config.ts';
import { SyncStore } from '../../packages/infrastructure/sync-store/src/index.ts';
import { createSyncServer } from '../../packages/protocols/sync-http/src/index.ts';
import { RememberInput } from '../../packages/core/contracts/src/index.ts';import { mnemonBinary } from './mnemon-binary.ts';

/**
 * A memory published through the reviewed candidate path must reach the shared server.
 *
 * The publication commits locally (the Provider write already happened), and the catalog's
 * `syncHook` was never wired to anything, so an approved candidate used to stay on the
 * machine that approved it. Sharing must not depend on a later human edit to push it.
 */

const DEVICE_TOKEN = 'd'.repeat(32);
const STREAM = 'formal-memories';

test('a memory published by the reviewed worker path is shared with the remote', async () => {
  const dir = resolve('work', 'publish-to-sync', randomUUID());
  mkdirSync(join(dir, 'provider'), { recursive: true });
  mkdirSync(join(dir, 'state'), { recursive: true });

  const remote = new SyncStore({ path: join(dir, 'remote.db') });
  remote.enroll('device-local', DEVICE_TOKEN, [{ stream: STREAM, canRead: true, canWrite: true }]);
  const server: Server = createSyncServer({ gateway: remote });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const app = configure({
    MNEMON_BINARY: mnemonBinary(), MNEMON_DATA_DIR: join(dir, 'provider'), MNEMON_STORE: 'publish_sync',
    MNEMOWEAVE_STATE_DIR: join(dir, 'state'), MNEMOWEAVE_PORT: '0',
    MNEMOWEAVE_TOKEN: 'host-token-0123456789abcdef', MNEMOWEAVE_OPERATOR_TOKEN: 'operator-token-0123456789abcdef',
    // The worker publishes; the pass interval is off so only the publication itself can push.
    MNEMOWEAVE_WORKER: 'on',
    MNEMOWEAVE_SYNC_URL: base, MNEMOWEAVE_SYNC_DEVICE_ID: 'device-local', MNEMOWEAVE_SYNC_TOKEN: DEVICE_TOKEN,
    MNEMOWEAVE_SYNC_INTERVAL_MS: '0',
  });
  try {
    assert.equal(remote.pull(DEVICE_TOKEN, { stream: STREAM, since: 0, limit: 50 }).changes.length, 0, 'nothing shared yet');

    // Submit through the public surface. With no model route configured the worker parks
    // the candidate for a human decision, so wait for that state before approving.
    const submitted = await app.app.remember({
      idempotencyKey: `publish-${randomUUID()}`, content: '通过授权写入链路发布的正式记忆。', knowledgeType: 'Practice', tags: [],
      provenance: {
        source: 'local-user', sourceReference: 'e2e:publish', evidence: ['publish'], verificationStatus: 'verified',
        confidence: 1, applicability: 'alpha', limitations: '无（验收固定值）', lastVerified: '2026-11-10T12:00:00.000Z',
      },
    });
    assert.ok(['pending_review', 'needs_review'].includes(submitted.status));
    // Wait until the worker has finished its review round, whatever it concluded.
    const readStatus = async (): Promise<string> => (await app.app.candidateStatus({ candidateId: submitted.id })).status;
    const settled = async (): Promise<string> => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const status = await readStatus();
        // The worker moves the candidate out of `pending_review`; any later state is settled.
        if (status !== 'pending_review') return status;
        await new Promise((done) => setTimeout(done, 50));
      }
      return readStatus();
    };
    const settledStatus = await settled();
    if (settledStatus === 'needs_review') {
      await app.app.humanReview({ candidateId: submitted.id, decision: 'approve', reason: 'e2e approval' }, 'local-operator');
    } else {
      assert.equal(settledStatus, 'approved', `unexpected review outcome ${settledStatus}`);
    }

    // Let the in-process worker pick the approved task up and publish it.
    const deadline = Date.now() + 60_000;
    let changes: ReturnType<typeof remote.pull>['changes'] = [];
    while (Date.now() < deadline) {
      changes = remote.pull(DEVICE_TOKEN, { stream: STREAM, since: 0, limit: 50 }).changes;
      if (changes.length > 0) break;
      await new Promise((done) => setTimeout(done, 250));
    }

    assert.equal(changes.length, 1, 'the reviewed publication must reach the remote without a later edit');
    assert.equal(changes[0]?.operation, 'create');
    assert.equal(changes[0]?.entry.kind, 'formal-memory');
    assert.equal(changes[0]?.stream, STREAM);
    assert.equal(changes[0]?.entry.content.data, '通过授权写入链路发布的正式记忆。');
  } catch (error) {
    console.error('PUBLISH_SYNC_E2E_FAILED', error);
    throw error;
  } finally {
    await app.close();
    await new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); });
    remote.close();
  }
});
