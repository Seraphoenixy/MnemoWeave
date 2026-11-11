import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { RememberInput } from '../../packages/core/contracts/src/index.ts';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { MnemonCliProvider } from '../../packages/providers/mnemon/src/index.ts';
import { MemoryClient } from '../../packages/client/src/index.ts';
import { createHttpServer } from '../../packages/protocols/http/src/index.ts';
import { configure } from '../../apps/server/src/config.ts';
import { mnemonBinary } from '../e2e/mnemon-binary.ts';

/**
 * A written edit must survive a restart.
 *
 * The write path touches three places — the Provider's copy, the catalog pointer and the version
 * counter — and only the last two live in the governance database. A restart is where a
 * disagreement between them shows up: if the version counter were lost, the next edit would be
 * refused forever with a stale base, which looks like corruption to the user.
 */

const TOKEN = 'restart-token-0123456789ab';
const OPERATOR = 'restart-operator-0123456789';
const HOST = 'restart-probe';

function env(root: string): NodeJS.ProcessEnv {
  return {
    MNEMON_BINARY: mnemonBinary(), MNEMON_DATA_DIR: join(root, 'provider'), MNEMON_STORE: 'restart',
    MNEMOWEAVE_STATE_DIR: join(root, 'state'), MNEMOWEAVE_PORT: '0',
    MNEMOWEAVE_TOKEN: TOKEN, MNEMOWEAVE_OPERATOR_TOKEN: OPERATOR, MNEMOWEAVE_WORKER: 'off',
  } as NodeJS.ProcessEnv;
}

/** Start a Server over `root`, run `body`, and always shut it down before returning. */
async function withServer<T>(root: string, body: (client: MemoryClient) => Promise<T>): Promise<T> {
  const app = configure(env(root));
  const server: Server = createHttpServer(app.app, TOKEN, OPERATOR, app.client, app.storage);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await body(new MemoryClient({ baseUrl: base, token: TOKEN, hostId: HOST, timeoutMs: 30_000 }));
  } finally {
    await new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); });
    await app.close();
  }
}

async function seed(root: string): Promise<string> {
  mkdirSync(join(root, 'provider'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  const repo = new SqliteCandidates(resolve(join(root, 'state', 'governance.db')));
  const provider = new MnemonCliProvider({ binary: mnemonBinary(), dataDir: resolve(join(root, 'provider')), store: 'restart' });
  const request = RememberInput.parse({
    idempotencyKey: `restart-${randomUUID()}`, content: '重启前的初始正文。', knowledgeType: 'Practice', tags: [], scope: 'global',
    provenance: {
      source: 'local-user', sourceReference: 'restart:fixture', evidence: ['restart'], verificationStatus: 'verified',
      confidence: 1, applicability: 'global', limitations: '无（验收固定值）', lastVerified: '2026-11-10T00:00:00.000Z',
    },
  });
  const candidate = repo.submit(request);
  const written = await provider.persistReviewed(request.content, `candidate:${candidate.id}`);
  const memoryId = repo.catalog.publishInitial(candidate.id, request, written.id, createHash('sha256').update(request.content).digest('hex'), '2026-11-10T00:00:00.000Z').memoryId;
  repo.close();
  return memoryId;
}

test('an edit made before a restart is still the current version afterwards', async () => {
  const root = resolve('work', 'restart-edit', randomUUID());
  const memoryId = await seed(root);

  await withServer(root, async client => {
    const edited = await client.editMemory(memoryId, { content: '重启前编辑的正文。', entryVersion: 0 });
    assert.equal(edited.ok, true);
  });

  // A second process opens the same state directory: the version counter and the pointer must
  // both have been durable, or the next edit would be refused with a stale base.
  await withServer(root, async client => {
    const detail = await client.readMemory(memoryId);
    assert.equal(detail.ok, true);
    if (!detail.ok) return;
    assert.equal(detail.value.entryVersion, 1, 'the version survived the restart');
    assert.equal(detail.value.content, '重启前编辑的正文。', 'the edited body is what the Provider serves');
    assert.equal((detail.value.revisions as unknown[]).length, 2);

    const again = await client.editMemory(memoryId, { content: '重启后继续编辑。', entryVersion: 1 });
    assert.equal(again.ok, true, 'editing continues from the version the restart preserved');
    if (again.ok) assert.equal(again.value.entryVersion, 2);
  });
});

test('a withdrawal made before a restart stays in effect', async () => {
  const root = resolve('work', 'restart-withdraw', randomUUID());
  const memoryId = await seed(root);

  await withServer(root, async client => {
    const withdrawn = await client.withdrawMemory(memoryId, { reason: '重启前撤回', entryVersion: 0 });
    assert.equal(withdrawn.ok, true);
  });

  await withServer(root, async client => {
    const detail = await client.readMemory(memoryId);
    assert.equal(detail.ok, true);
    if (!detail.ok) return;
    assert.equal(detail.value.state, 'superseded', 'a withdrawn memory does not come back after a restart');
    assert.equal(detail.value.entryVersion, 1);
    // The history is still readable, which is the promise withdrawal makes.
    assert.equal(detail.value.content, '重启前的初始正文。');

    // And it is no longer offered by the list.
    const list = await client.listMemories({ limit: 50 });
    assert.equal(list.ok, true);
    if (list.ok) assert.equal(list.value.items.some(item => item.memoryId === memoryId), false, 'a retired memory is not listed');
  });
});
