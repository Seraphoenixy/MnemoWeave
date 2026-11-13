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
import { createRpcHandler } from '../../plugins/dsh-mnemo-weave/src/ui/rpc.ts';
import { MemorySource } from '../../plugins/dsh-mnemo-weave/src/ui/memory-source.ts';
import { mnemonBinary } from '../e2e/mnemon-binary.ts';
import { tempDir } from '../support/temp.ts';

/**
 * An edit and a withdrawal of the same memory may race, and only one may win.
 *
 * Both are serialized per memory. Whichever runs second is working from a base version that the
 * first one already moved, so it must fail rather than silently produce a second "current" state:
 * a withdrawal followed by an edit that succeeds would leave a withdrawn memory with a newer body,
 * and an edit followed by a withdrawal at the old base would overwrite a version the user never saw.
 */

const TOKEN = 'race-token-0123456789abcdefg';
const OPERATOR = 'race-operator-0123456789abc';
const HOST = 'race-probe';

async function harness(): Promise<{
  rpc: (endpoint: 'edit' | 'withdraw' | 'memory', payload: Record<string, unknown>) => Promise<{ ok: boolean; value?: unknown; error?: { code: string } }>;
  memoryId: string;
  close: () => Promise<void>;
}> {
  const root = await tempDir('concurrent-writes', 'race');
  mkdirSync(join(root, 'provider'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  const seed = new SqliteCandidates(resolve(join(root, 'state', 'governance.db')));
  const seedProvider = new MnemonCliProvider({ binary: mnemonBinary(), dataDir: resolve(join(root, 'provider')), store: 'race' });
  const request = RememberInput.parse({
    idempotencyKey: `race-${randomUUID()}`, content: '并发写入的初始正文。', tags: [],
    provenance: {
      source: 'local-user', sourceReference: 'race:fixture',
    },
  });
  const candidate = seed.submit(request);
  const written = await seedProvider.persistReviewed(request.content, `candidate:${candidate.id}`);
  const memoryId = seed.catalog.publishInitial(candidate.id, request, written.id, createHash('sha256').update(request.content).digest('hex'), '2026-11-10T00:00:00.000Z').memoryId;
  seed.close();

  const app = configure({
    MNEMON_BINARY: mnemonBinary(), MNEMON_DATA_DIR: join(root, 'provider'), MNEMON_STORE: 'race',
    MNEMOWEAVE_STATE_DIR: join(root, 'state'), MNEMOWEAVE_PORT: '0',
    MNEMOWEAVE_TOKEN: TOKEN, MNEMOWEAVE_OPERATOR_TOKEN: OPERATOR, MNEMOWEAVE_WORKER: 'off',
  } as NodeJS.ProcessEnv);
  const server: Server = createHttpServer(app.app, TOKEN, OPERATOR, app.client, app.storage);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new MemoryClient({ baseUrl: base, token: TOKEN, hostId: HOST, timeoutMs: 30_000 });
  const handler = createRpcHandler(new MemorySource({ client, serverUrl: base, hasToken: true }));
  return {
    rpc: (endpoint, payload) => handler(endpoint, payload) as Promise<never>,
    memoryId,
    close: async () => {
      await new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); });
      await app.close();
    },
  };
}

test('an edit and a withdrawal started together: exactly one succeeds', async () => {
  const { rpc, memoryId, close } = await harness();
  try {
    // Both start from entryVersion 0, so they share a base and cannot both be applied.
    const [edited, withdrawn] = await Promise.all([
      rpc('edit', { memoryId, content: '并发编辑后的正文。', entryVersion: 0 }),
      rpc('withdraw', { memoryId, reason: '并发撤回', entryVersion: 0 }),
    ]);
    const successes = [edited, withdrawn].filter(result => result.ok).length;
    assert.equal(successes, 1, 'exactly one write may be applied to the same base version');

    const detail = await rpc('memory', { memoryId });
    assert.equal(detail.ok, true);
    if (!detail.ok) return;
    const record = detail.value as { state: string; revisions: unknown[]; content: string; entryVersion: number };

    if (edited.ok) {
      // The edit won: the withdrawal was rejected, so the memory is still live and has one more
      // revision.
      assert.equal(record.state, 'active', 'a rejected withdrawal must not retire the memory');
      assert.equal(record.revisions.length, 2);
      assert.equal(record.content, '并发编辑后的正文。');
      assert.equal(record.entryVersion, 1);
      assert.equal(withdrawn.ok, false);
      if (!withdrawn.ok) assert.match(withdrawn.error!.code, /VERSION_CONFLICT|INVALID_STATE/);
    } else {
      // The withdrawal won: the edit was rejected, so the body is the original and the memory is
      // retired with a single revision.
      assert.equal(record.state, 'superseded');
      assert.equal(record.revisions.length, 1, 'a rejected edit must not append a revision');
      assert.equal(record.content, '并发写入的初始正文。');
      assert.equal(record.entryVersion, 1);
      assert.equal(edited.ok, false);
      if (!edited.ok) assert.match(edited.error!.code, /VERSION_CONFLICT|INVALID_STATE/);
    }
  } finally { await close(); }
});

test('two withdrawals started together: the memory is retired once', async () => {
  const { rpc, memoryId, close } = await harness();
  try {
    const results = await Promise.all([
      rpc('withdraw', { memoryId, reason: '并发撤回甲', entryVersion: 0 }),
      rpc('withdraw', { memoryId, reason: '并发撤回乙', entryVersion: 0 }),
    ]);
    assert.equal(results.filter(result => result.ok).length, 1, 'withdrawing twice would double-count the version');
    const detail = await rpc('memory', { memoryId });
    assert.equal(detail.ok, true);
    if (!detail.ok) return;
    assert.equal((detail.value as { entryVersion: number }).entryVersion, 1, 'the version advanced exactly once');
  } finally { await close(); }
});

test('two edits started together: one applies and the other reports the stale base', async () => {
  const { rpc, memoryId, close } = await harness();
  try {
    const results = await Promise.all([
      rpc('edit', { memoryId, content: '并发编辑甲。', entryVersion: 0 }),
      rpc('edit', { memoryId, content: '并发编辑乙。', entryVersion: 0 }),
    ]);
    assert.equal(results.filter(result => result.ok).length, 1, 'a shared base cannot produce two revisions');
    const detail = await rpc('memory', { memoryId });
    assert.equal(detail.ok, true);
    if (!detail.ok) return;
    const record = detail.value as { revisions: unknown[]; content: string; entryVersion: number };
    assert.equal(record.revisions.length, 2, 'only the winning edit appended a revision');
    assert.equal(record.entryVersion, 1);
    assert.ok(['并发编辑甲。', '并发编辑乙。'].includes(record.content), 'the body is the winner, not a mix');
  } finally { await close(); }
});
