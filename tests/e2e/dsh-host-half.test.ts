import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { configure } from '../../apps/server/src/config.ts';
import { createHttpServer } from '../../packages/protocols/http/src/index.ts';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { MnemonCliProvider } from '../../packages/providers/mnemon/src/index.ts';
import { MemoryClient } from '../../packages/client/src/index.ts';
import { RememberInput } from '../../packages/core/contracts/src/index.ts';
import { MemorySource } from '../../plugins/dsh-mnemo-weave/src/ui/memory-source.ts';
import { createRpcHandler } from '../../plugins/dsh-mnemo-weave/src/ui/rpc.ts';
import { mnemonBinary } from './mnemon-binary.ts';

/**
 * The DSH plugin's Host half against a real Server: the same client, the same RPC handler
 * and the same parsing the desktop page uses, with a real Mnemon behind it.
 */

const TOKEN = 'host-token-0123456789abcdef';
const OPERATOR = 'operator-token-0123456789abcdef';
const HOST = 'dsh-desktop';

test('the DSH Host half lists, reads, edits and reports injections through a real Server', async () => {
  const dir = resolve('work', 'dsh-host-half', randomUUID());
  mkdirSync(join(dir, 'provider'), { recursive: true });
  mkdirSync(join(dir, 'state'), { recursive: true });

  // Seed one published memory through the normal candidate path.
  const seed = new SqliteCandidates(resolve(join(dir, 'state', 'governance.db')));
  const seedProvider = new MnemonCliProvider({ binary: mnemonBinary(), dataDir: resolve(join(dir, 'provider')), store: 'dsh_host' });
  const request = RememberInput.parse({
    idempotencyKey: `seed-${randomUUID()}`, content: '插件读取的初始正文。', knowledgeType: 'Practice', tags: [],
    scope: 'project', projectId: 'alpha',
    provenance: {
      source: 'local-user', sourceReference: 'e2e:dsh-host', evidence: ['seed'], verificationStatus: 'verified',
      confidence: 1, applicability: 'alpha', limitations: '无（验收固定值）', lastVerified: '2026-11-10T10:00:00.000Z',
    },
  });
  const candidate = seed.submit(request);
  const written = await seedProvider.persistReviewed(request.content, `candidate:${candidate.id}`);
  const memoryId = seed.catalog.publishInitial(candidate.id, request, written.id, createHash('sha256').update(request.content).digest('hex'), '2026-11-10T10:00:00.000Z').memoryId;
  seed.close();

  const app = configure({
    MNEMON_BINARY: mnemonBinary(), MNEMON_DATA_DIR: join(dir, 'provider'), MNEMON_STORE: 'dsh_host',
    MNEMOWEAVE_STATE_DIR: join(dir, 'state'), MNEMOWEAVE_PORT: '0',
    MNEMOWEAVE_TOKEN: TOKEN, MNEMOWEAVE_OPERATOR_TOKEN: OPERATOR, MNEMOWEAVE_WORKER: 'off',
  });
  const server: Server = createHttpServer(app.app, TOKEN, OPERATOR, app.client, app.storage);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new MemoryClient({ baseUrl: base, token: TOKEN, hostId: HOST, projectId: 'alpha' });
  const source = new MemorySource({ client, serverUrl: base, hasToken: true });
  const rpc = createRpcHandler(source);
  try {
    const status = await rpc('status', {});
    assert.equal(status.ok, true);
    if (status.ok) assert.equal((status.value as { status: string }).status, 'ok');

    const list = await rpc('memories', { limit: 10 });
    assert.equal(list.ok, true);
    if (!list.ok) return;
    const items = (list.value as { items: Array<{ memoryId: string; content: string; entryVersion: number }> }).items;
    assert.equal(items.length, 1);
    assert.equal(items[0]?.content, '插件读取的初始正文。');
    assert.equal(items[0]?.entryVersion, 0);

    const detail = await rpc('memory', { memoryId });
    assert.equal(detail.ok, true);
    if (detail.ok) assert.equal((detail.value as { memoryId: string }).memoryId, memoryId);

    const edited = await rpc('edit', { memoryId, content: '插件编辑后的正文。', entryVersion: 0 });
    assert.equal(edited.ok, true);
    if (edited.ok) assert.equal((edited.value as { entryVersion: number }).entryVersion, 1);

    const stale = await rpc('edit', { memoryId, content: '过期基准。', entryVersion: 0 });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, 'VERSION_CONFLICT');

    // No View yet: the host has never injected, which is a normal first run.
    assert.equal(await source.injection(), null);

    // A View for a project scope requires the project to be registered first.
    const registration = await fetch(`${base}/v1/runtime/projects`, {
      method: 'POST', headers: { authorization: `Bearer ${OPERATOR}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'alpha' }),
    });
    assert.equal(registration.status, 200);

    // The default injection budget is 2 s; a loaded machine needs a larger budget to assert
    // the happy path, so the test passes one explicitly instead of weakening the deadline.
    const view = await client.inject({ query: '初始' }, 20_000);
    assert.equal(view.ok, true);
    const report = await source.injection();
    assert.ok(report, 'a View call must leave an injection report');
    assert.equal(typeof report.rulesInjected, 'number');
    assert.equal(typeof report.memoriesInjected, 'number');
    assert.equal(report.sessionId.length > 0, true);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await app.close();
  }
});
