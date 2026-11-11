import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
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
 * Remote outage: an edit must be refused instead of half-applied, the change must stay
 * queued or pending confirmation, and the queue must drain once the remote answers.
 */

const TOKEN = 'f'.repeat(32);
const SCOPE = 'project:alpha';

/** A port that is free right now, so a refused connection is a real refusal. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', () => done()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

function machine(root: string, base: string) {
  const state = resolve(join(root, 'state'));
  const provider = resolve(join(root, 'provider'));
  mkdirSync(state, { recursive: true });
  mkdirSync(provider, { recursive: true });
  return configure({
    MNEMON_BINARY: mnemonBinary(), MNEMON_DATA_DIR: provider, MNEMON_STORE: 'offline',
    MNEMOWEAVE_STATE_DIR: state, MNEMOWEAVE_PORT: '0',
    MNEMOWEAVE_TOKEN: 'host-token-0123456789abcdef', MNEMOWEAVE_OPERATOR_TOKEN: 'operator-token-0123456789abcdef',
    MNEMOWEAVE_WORKER: 'off',
    MNEMOWEAVE_SYNC_URL: base, MNEMOWEAVE_SYNC_DEVICE_ID: 'device-local', MNEMOWEAVE_SYNC_TOKEN: TOKEN,
    MNEMOWEAVE_SYNC_INTERVAL_MS: '0', MNEMOWEAVE_SYNC_TIMEOUT_MS: '3000',
  });
}

/** Publish one memory before the Server is configured, the way the candidate path does. */
async function seedPublishedMemory(root: string): Promise<string> {
  const state = resolve(join(root, 'state'));
  const providerDir = resolve(join(root, 'provider'));
  mkdirSync(state, { recursive: true });
  mkdirSync(providerDir, { recursive: true });
  const repo = new SqliteCandidates(resolve(join(state, 'governance.db')));
  const provider = new MnemonCliProvider({ binary: mnemonBinary(), dataDir: providerDir, store: 'offline' });
  const request = RememberInput.parse({
    idempotencyKey: `seed-${randomUUID()}`, content: '断网前的初始正文。', knowledgeType: 'Practice', tags: [], projectId: 'alpha',
    provenance: {
      source: 'local-user', sourceReference: 'e2e:offline', evidence: ['seed'], verificationStatus: 'verified',
      confidence: 1, applicability: 'alpha', limitations: '无（验收固定值）', lastVerified: '2026-11-10T12:00:00.000Z',
    },
  });
  const candidate = repo.submit(request);
  const written = await provider.persistReviewed(request.content, `candidate:${candidate.id}`);
  const memoryId = repo.catalog.publishInitial(candidate.id, request, written.id, createHash('sha256').update(request.content).digest('hex'), '2026-11-10T12:00:00.000Z').memoryId;
  repo.close();
  return memoryId;
}

test('an edit that never reaches the remote is queued, not applied, and drains after recovery', async () => {
  const port = await freePort();
  const root = resolve('work', 'offline-never-reached', randomUUID());
  mkdirSync(root, { recursive: true });
  const remote = new SyncStore({ path: join(root, 'remote.db') });
  remote.enroll('device-local', TOKEN, [{ scope: SCOPE, canRead: true, canWrite: true }]);
  const memoryId = await seedPublishedMemory(root);
  const app = machine(root, `http://127.0.0.1:${port}`);
  let server: Server | undefined;
  try {
    await assert.rejects(
      app.client!.editMemory(memoryId, { content: '第一次写入就断网。', entryVersion: 0 }),
      (error: unknown) => error instanceof MnemoWeaveError && error.code === 'SYNC_QUEUED',
    );
    const unchanged = (await app.client!.memories({ query: '初始', limit: 5 })).items[0];
    assert.equal(unchanged?.entryVersion, 0, 'a queued edit must not be published');
    const scope = (await app.client!.syncStatus!()).scopes.find(item => item.scope === SCOPE);
    assert.equal(scope?.pending, 1);
    assert.equal(scope?.unknown, 0);

    server = createSyncServer({ gateway: remote });
    await new Promise<void>((done) => server!.listen(port, '127.0.0.1', () => done()));
    await app.client!.syncRefresh!();

    const applied = (await app.client!.memories({ query: '第一次写入', limit: 5 })).items[0];
    assert.equal(applied?.entryVersion, 1);
    assert.equal((await app.client!.syncStatus!()).scopes.find(item => item.scope === SCOPE)?.pending, 0);
    assert.deepEqual(remote.pull(TOKEN, { scope: SCOPE, since: 0, limit: 10 }).changes.map(change => change.version), [1]);
  } finally {
    await app.close();
    if (server) await new Promise<void>((done) => server!.close(() => done()));
    remote.close();
  }
});

test('an edit lost after a successful write becomes pending confirmation and still converges', async () => {
  const root = resolve('work', 'offline-lost-connection', randomUUID());
  mkdirSync(root, { recursive: true });
  const remote = new SyncStore({ path: join(root, 'remote.db') });
  remote.enroll('device-local', TOKEN, [{ scope: SCOPE, canRead: true, canWrite: true }]);
  const start = async (fixed?: number) => {
    const server: Server = createSyncServer({ gateway: remote });
    await new Promise<void>((done) => server.listen(fixed ?? 0, '127.0.0.1', () => done()));
    return { server, port: (server.address() as AddressInfo).port };
  };
  let { server, port } = await start();
  const memoryId = await seedPublishedMemory(root);
  const app = machine(root, `http://127.0.0.1:${port}`);
  try {
    const first = await app.client!.editMemory(memoryId, { content: '在线时写入的第一版。', entryVersion: 0 });
    assert.equal(first.entryVersion, 1);

    await new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); });
    let outageCode = '';
    await assert.rejects(
      app.client!.editMemory(memoryId, { content: '断网时尝试的第二版。', entryVersion: 1 }),
      (error: unknown) => {
        outageCode = error instanceof MnemoWeaveError ? error.code : '';
        return error instanceof MnemoWeaveError && (error.code === 'SYNC_QUEUED' || error.code === 'SYNC_OUTCOME_UNKNOWN');
      },
    );
    const duringOutage = (await app.client!.memories({ query: '在线时写入', limit: 5 })).items[0];
    assert.equal(duringOutage?.entryVersion, 1, 'a refused edit must not change the published memory');
    const pendingScope = (await app.client!.syncStatus!()).scopes.find(item => item.scope === SCOPE);
    assert.equal((pendingScope?.pending ?? 0) + (pendingScope?.unknown ?? 0), 1, 'the refused change must stay in the ledger');
    if (outageCode === 'SYNC_OUTCOME_UNKNOWN') assert.equal(pendingScope?.unknown, 1);
    else assert.equal(pendingScope?.pending, 1);

    ({ server } = await start(port));
    assert.equal((server.address() as AddressInfo).port, port, 'the remote must return on the same address');
    await app.client!.syncRefresh!();

    const after = (await app.client!.memories({ query: '断网时尝试', limit: 5 })).items[0];
    assert.equal(after?.content, '断网时尝试的第二版。');
    assert.equal(after?.entryVersion, 2);
    const drained = (await app.client!.syncStatus!()).scopes.find(item => item.scope === SCOPE);
    assert.equal(drained?.pending, 0);
    assert.equal(drained?.unknown, 0);
    assert.deepEqual(
      remote.pull(TOKEN, { scope: SCOPE, since: 0, limit: 10 }).changes.map(change => [change.operation, change.version]),
      [['create', 1], ['update', 2]],
    );
  } finally {
    await app.close();
    await new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); });
    remote.close();
  }
});
