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
import { SettingsService } from '../../plugins/dsh-mnemo-weave/src/ui/settings.ts';
import { mnemonBinary } from '../e2e/mnemon-binary.ts';

/**
 * Exercise every endpoint the memory page calls, through the same channel it uses.
 *
 * The page talks to the Host half over one RPC handler; a mismatch anywhere in that chain — a
 * field the parser requires, a route the Server does not serve, an argument the Host refuses —
 * breaks a tab. Unit tests cover the parsers in isolation and the HTTP tests cover the routes;
 * this covers the wiring between them, against real data, without a browser.
 */

const TOKEN = 'page-smoke-token-0123456789ab';
const OPERATOR = 'page-smoke-operator-01234';
const HOST = 'page-smoke-probe';

type Rpc = (endpoint: string, payload?: unknown) => Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string } }>;

test('every endpoint the page uses answers through the Host channel', async () => {
  const root = resolve('work', 'page-smoke', randomUUID());
  mkdirSync(join(root, 'provider'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });

  // Seed a few memories with different shapes, so the page is not looking at one uniform row.
  const seed = new SqliteCandidates(resolve(join(root, 'state', 'governance.db')));
  const seedProvider = new MnemonCliProvider({ binary: mnemonBinary(), dataDir: resolve(join(root, 'provider')), store: 'pagesmoke' });
  const seeded: string[] = [];
  const shapes = [
    { content: '页面冒烟：全局范围的决策。', scope: 'global' as const, meta: { category: 'decision', importance: 5, tags: ['冒烟'], entities: ['MnemoWeave'] } },
    { content: '页面冒烟：另一条共享约束。', scope: 'shared' as const, meta: { category: 'context', importance: 3, tags: [], entities: ['DSH'] } },
    { content: '页面冒烟：没有分类的条目。', scope: 'global' as const, meta: {} },
  ];
  for (const [index, shape] of shapes.entries()) {
    const request = RememberInput.parse({
      idempotencyKey: `page-smoke-${index}`, content: shape.content, knowledgeType: 'Practice', tags: shape.meta.tags ?? [],
      provenance: {
        source: 'local-user', sourceReference: `page-smoke:${index}`, evidence: ['fixture'], verificationStatus: 'verified',
        confidence: 1, applicability: 'shared collection', limitations: '无', lastVerified: '2026-11-10T00:00:00.000Z',
      },
    });
    const written = await seedProvider.persistReviewed(shape.content, `candidate:${randomUUID()}`);
    const published = seed.catalog.publishSynced(
      randomUUID(), request, written.id, createHash('sha256').update(shape.content).digest('hex'),
      `2026-11-10T00:00:0${index}.000Z`, 'sync', 'smoke', shape.meta,
    );
    seeded.push(published.memoryId);
  }
  // The archive page is bounded to a registered workspace; registering is explicit.
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  seed.workspaces.register(workspaceId, 'smoke workspace');
  seed.close();

  const app = configure({
    MNEMON_BINARY: mnemonBinary(), MNEMON_DATA_DIR: join(root, 'provider'), MNEMON_STORE: 'pagesmoke',
    MNEMOWEAVE_STATE_DIR: join(root, 'state'), MNEMOWEAVE_PORT: '0',
    MNEMOWEAVE_TOKEN: TOKEN, MNEMOWEAVE_OPERATOR_TOKEN: OPERATOR,
    // Creation is published by the worker, so this harness needs it running.
    MNEMOWEAVE_WORKER: 'on',
  } as NodeJS.ProcessEnv);
  const server: Server = createHttpServer(app.app, TOKEN, OPERATOR, app.client, app.storage);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new MemoryClient({ baseUrl: base, token: TOKEN, hostId: HOST, timeoutMs: 30_000 });
  const source = new MemorySource({ client, serverUrl: base, hasToken: true });
  // The settings tab needs its own service; without it the RPC answers "unavailable in this build",
  // which is correct behaviour but would leave that tab unverified here.
  const settings = new SettingsService({
    entryConfig: undefined,
    env: {
      ...process.env,
      // Keep preferences inside this test's directory: writing the real profile would be a side
      // effect a test must never have.
      DSH_PROFILE_DIR: join(root, 'profile'),
      MNEMOWEAVE_TOKEN: TOKEN,
      MNEMOWEAVE_SERVER: base,
      MNEMOWEAVE_HOST_ID: HOST,
    },
    runTask: async () => { /* never touch the real scheduler */ },
    probe: async () => ({ ok: true, status: 'ok', detail: '', latencyMs: 1 }),
  } as unknown as ConstructorParameters<typeof SettingsService>[0]);
  const rpc = createRpcHandler(source, settings) as unknown as Rpc;

  const ok = async (endpoint: string, payload?: unknown): Promise<unknown> => {
    const result = await rpc(endpoint, payload);
    assert.equal(result.ok, true, `${endpoint} failed: ${result.ok ? '' : result.error.code}`);
    return result.ok ? result.value : undefined;
  };

  try {
    // Overview tab.
    const status = await ok('status') as { status: string };
    assert.equal(status.status, 'ok');
    await ok('config');
    await ok('injection');
    await ok('rules');
    // The archive page is always bounded to a registered workspace.
    const noWorkspace = await rpc('archives', {});
    assert.equal(noWorkspace.ok, false, 'an archive list without a workspace is refused');
    await ok('archives', { workspaceId });

    // Memories tab: list, an alternate order, a filter, then a detail and a historical read.
    const list = await ok('memories', { limit: 50 }) as { items: Array<{ memoryId: string; entryVersion: number; category?: string }> };
    assert.equal(list.items.length, 3, 'the three seeded memories');
    const sorted = await ok('memories', { limit: 50, sort: 'importance' }) as { items: Array<{ importance?: number }> };
    assert.deepEqual(sorted.items.map(item => item.importance ?? -1), [5, 3, -1], 'the importance order reaches the page');
    const filtered = await ok('memories', { limit: 50, entity: 'dsh' }) as { items: unknown[] };
    assert.equal(filtered.items.length, 1, 'the entity filter reaches the page');

    const target = list.items[0]!;
    const detail = await ok('memory', { memoryId: target.memoryId }) as { content: string; revisions: Array<{ revisionId: string }> };
    assert.ok(detail.content.length > 0);
    // Reading a specific revision is what the history timeline does.
    await ok('memory', { memoryId: target.memoryId, revisionId: detail.revisions[0]!.revisionId });

    // Entities and explore tabs.
    await ok('memories', { limit: 1 });
    const explored = await ok('explore', { query: '页面冒烟', limit: 10, minScore: 0 }) as { hits: unknown[] };
    assert.ok(explored.hits.length >= 1, 'explore finds the seeded memories');

    // Graph tab.
    const graph = await ok('graph', { limit: 100 }) as { nodes: unknown[] };
    assert.equal(graph.nodes.length, 3);
    // A removed owner filter is refused rather than silently ignored.
    const removedFilter = await rpc('graph', { projectId: 'alpha', limit: 100 });
    assert.equal(removedFilter.ok, false);
    assert.equal((removedFilter as { error: { code: string } }).error.code, 'INVALID_INPUT');

    // Sync tab: nothing configured here, so the page must get a definite answer either way.
    const sync = await rpc('sync', {});
    assert.ok(sync.ok || sync.error.code === 'REVIEW_REQUIRED', 'the sync tab gets a definite answer');

    // Settings tab: the read path, plus the saves that only touch local preferences. The ones that
    // probe or wake the Server need a real scheduler/bridge and are covered by
    // `tests/contract/host-config.test.ts` instead.
    const settingsView = await ok('settings') as { interface: { pageSize: number } };
    assert.ok(settingsView.interface.pageSize > 0);
    await ok('saveInterface', { pageSize: 30 });
    await ok('saveAutoStart', { enabled: false });

    // Create, edit and withdraw: the three writes the page offers.
    const created = await ok('create', {
      content: '页面冒烟：界面新增的正文。', knowledgeType: 'Practice',
      category: 'decision', importance: 4, tags: ['冒烟'], entities: ['MnemoWeave'],
    }) as { memoryId: string; entryVersion: number };
    const createdDetail = await ok('memory', { memoryId: created.memoryId }) as { content: string; state: string };
    assert.equal(createdDetail.content, '页面冒烟：界面新增的正文。');
    assert.equal(createdDetail.state, 'active');
    const edited = await ok('edit', {
      memoryId: target.memoryId, content: '页面冒烟：编辑后的正文。', entryVersion: target.entryVersion,
      category: 'decision', importance: 4, tags: ['冒烟', '编辑'],
    }) as { entryVersion: number };
    assert.equal(edited.entryVersion, target.entryVersion + 1);
    const afterEdit = await ok('memory', { memoryId: target.memoryId }) as { content: string; revisions: unknown[]; currentRevisionId: string };
    assert.equal(afterEdit.content, '页面冒烟：编辑后的正文。');
    assert.equal(afterEdit.revisions.length, 2);

    const withdrawn = await ok('withdraw', { memoryId: target.memoryId, reason: '页面冒烟：撤回', entryVersion: edited.entryVersion }) as { entryVersion: number };
    assert.equal(withdrawn.entryVersion, edited.entryVersion + 1);
    const afterWithdraw = await ok('memory', { memoryId: target.memoryId }) as { state: string };
    assert.equal(afterWithdraw.state, 'superseded');
    const listAfter = await ok('memories', { limit: 50 }) as { items: unknown[] };
    assert.equal(listAfter.items.length, 3, 'the withdrawn memory leaves the list; the created one stays');
  } finally {
    await new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); });
    await app.close();
  }
});
