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
 * The relation graph is structure, not content.
 *
 * Nodes are active memories in scope and edges are catalogued relations whose endpoints both
 * survive the node cap, so nothing in the answer is undrawable. Bodies stay out: reading them
 * would cost one Provider process per node.
 */

const TOKEN = 'graph-token-0123456789abcdef';
const OPERATOR = 'graph-operator-0123456789ab';
const HOST = 'graph-probe';

async function seeded(root: string): Promise<{ client: MemoryClient; ids: string[]; close: () => Promise<void> }> {
  mkdirSync(join(root, 'provider'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  const repo = new SqliteCandidates(resolve(join(root, 'state', 'governance.db')));
  const provider = new MnemonCliProvider({ binary: mnemonBinary(), dataDir: resolve(join(root, 'provider')), store: 'graph' });
  const ids: string[] = [];
  const publish = async (content: string, projectId: string | null, at: string): Promise<{ memoryId: string; revisionId: string }> => {
    const request = RememberInput.parse({
      idempotencyKey: `graph-${randomUUID()}`, content, knowledgeType: 'Practice', tags: [],
            provenance: {
        source: 'local-user', sourceReference: 'graph:fixture', evidence: ['graph'], verificationStatus: 'verified',
        confidence: 1, applicability: projectId ?? 'global', limitations: '无（验收固定值）', lastVerified: '2026-11-10T00:00:00.000Z',
      },
    });
    const written = await provider.persistReviewed(content, `candidate:${randomUUID()}`);
    const published = repo.catalog.publishSynced(
      randomUUID(), request, written.id, createHash('sha256').update(content).digest('hex'),
      at, 'sync', 'synced revision 1',
      { category: 'fact', importance: 3, tags: [], entities: [] },
    );
    ids.push(published.memoryId);
    return published;
  };

  const first = await publish('图节点一：MnemoWeave 的记忆界面。', null, '2026-11-10T00:00:01.000Z');
  const second = await publish('图节点二：另一个项目里的条目。', 'alpha', '2026-11-10T00:00:02.000Z');
  // A supersedes edge between the two, so the graph has something to draw.
  repo.catalog.publishSynced(
    second.memoryId,
    RememberInput.parse({
      idempotencyKey: 'graph-second-version', content: '图节点二的第二版。', knowledgeType: 'Practice', tags: [],
      provenance: {
        source: 'sync', sourceReference: 'graph:fixture:2', evidence: ['graph'], verificationStatus: 'verified',
        confidence: 1, applicability: 'alpha', limitations: '无（验收固定值）', lastVerified: '2026-11-10T00:00:00.000Z',
      },
    }),
    (await provider.persistReviewed('图节点二的第二版。', `candidate:${randomUUID()}`)).id,
    createHash('sha256').update('图节点二的第二版。').digest('hex'),
    '2026-11-10T00:00:03.000Z', 'sync', 'synced revision 2',
    { category: 'fact', importance: 3, tags: [], entities: [] },
  );
  void first;
  repo.close();

  const app = configure({
    MNEMON_BINARY: mnemonBinary(), MNEMON_DATA_DIR: join(root, 'provider'), MNEMON_STORE: 'graph',
    MNEMOWEAVE_STATE_DIR: join(root, 'state'), MNEMOWEAVE_PORT: '0',
    MNEMOWEAVE_TOKEN: TOKEN, MNEMOWEAVE_OPERATOR_TOKEN: OPERATOR, MNEMOWEAVE_WORKER: 'off',
  } as NodeJS.ProcessEnv);
  const server: Server = createHttpServer(app.app, TOKEN, OPERATOR, app.client, app.storage);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    client: new MemoryClient({ baseUrl: base, token: TOKEN, hostId: HOST, timeoutMs: 30_000 }),
    ids,
    close: async () => {
      await new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); });
      await app.close();
    },
  };
}

test('the graph carries nodes and only drawable edges', async () => {
  const root = resolve('work', 'graph-shape', randomUUID());
  const { client, close } = await seeded(root);
  try {
    const all = await client.graph({ limit: 50 });
    assert.equal(all.ok, true);
    if (!all.ok) return;
    assert.equal(all.value.nodes.length, 2, 'both memories are nodes');
    assert.equal(all.value.truncated, false);
    // Every edge points at nodes that are present; a dangling edge cannot be drawn.
    const present = new Set(all.value.nodes.map(node => node['memoryId']));
    for (const edge of all.value.edges) {
      assert.ok(present.has(edge['sourceMemoryId']), 'the source node is present');
      assert.ok(present.has(edge['targetMemoryId']), 'the target node is present');
    }
    // Nodes carry catalog facts and no body: the graph is structure, not content.
    for (const node of all.value.nodes) {
      assert.equal(typeof node['memoryId'], 'string');
      assert.equal(node['content'], undefined, 'a node must not smuggle the body in');
    }

    // The node cap drops nodes and, with them, the edges that would dangle.
    const capped = await client.graph({ limit: 1 });
    assert.equal(capped.ok, true);
    if (capped.ok) {
      assert.equal(capped.value.nodes.length, 1);
      assert.equal(capped.value.truncated, true, 'a full node list means the graph is a subset');
      const kept = new Set(capped.value.nodes.map(node => node['memoryId']));
      assert.ok(capped.value.edges.every(edge => kept.has(edge['sourceMemoryId']) && kept.has(edge['targetMemoryId'])),
        'edges whose endpoint was dropped are not returned');
    }

  } finally { await close(); }
});

test('the graph rejects an out-of-range limit', async () => {
  const root = resolve('work', 'graph-invalid', randomUUID());
  const { client, close } = await seeded(root);
  try {
    const tooMany = await client.graph({ limit: 501 });
    assert.equal(tooMany.ok, false);
    if (!tooMany.ok) assert.equal(tooMany.error.code, 'INVALID_INPUT');
  } finally { await close(); }
});
