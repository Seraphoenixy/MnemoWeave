import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { MemoryClient } from '../../packages/client/src/index.ts';
import { createHttpServer } from '../../packages/protocols/http/src/index.ts';
import { configure } from '../../apps/server/src/config.ts';
import { mnemonBinary } from './mnemon-binary.ts';
import { tempDir } from '../support/temp.ts';

/**
 * Retrieval works on a store with no embeddings.
 *
 * Mnemon reports `similarity: 0` for every row when the embedding service is unreachable or the
 * store has no vectors, and its `score` is then a fused keyword/entity/graph number rather than a
 * calibrated similarity. Two things follow, and both were broken before this contract existed:
 *
 * - the ranking must be kept, because the Provider's order and scores are the only relevance
 *   signal available, and re-scoring an all-zero similarity would destroy it;
 * - relevance must not be a caller-supplied floor, because the fused scores cluster well below any
 *   threshold a person would pick for a similarity.
 *
 * The regression this locks: with a similarity floor of 0.5, a paraphrase of a stored memory
 * returned nothing at all on this machine, which read as "search finds nothing".
 */

const TOKEN = 'recall-offline-token-0123456789';
const OPERATOR = 'recall-offline-operator-0123456789';
const HOST = 'recall-offline';

async function harness(): Promise<{ client: MemoryClient; close: () => Promise<void> }> {
  const root = await tempDir('recall-offline', 'recall-offline');
  mkdirSync(join(root, 'provider'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  const app = configure({
    MNEMON_BINARY: mnemonBinary(), MNEMON_DATA_DIR: join(root, 'provider'), MNEMON_STORE: 'recalloffline',
    MNEMOWEAVE_STATE_DIR: join(root, 'state'), MNEMOWEAVE_PORT: '0',
    MNEMOWEAVE_TOKEN: TOKEN, MNEMOWEAVE_OPERATOR_TOKEN: OPERATOR, MNEMOWEAVE_WORKER: 'on',
  } as NodeJS.ProcessEnv);
  const server: Server = createHttpServer(app.app, TOKEN, OPERATOR, app.client, app.storage);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    client: new MemoryClient({ baseUrl: base, token: TOKEN, hostId: HOST, timeoutMs: 30_000 }),
    close: async () => {
      await new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); });
      await app.close();
    },
  };
}

test('retrieval returns ranked memories on a store without embeddings', { timeout: 60_000 }, async () => {
  const { client, close } = await harness();
  try {
    const contents = [
      '安装包判断进程是否真的退出不能用文件存在性检查，正在运行的可执行文件同样返回存在。',
      '构建脚本应在产出后独立校验产物，而不只看打包工具的退出码。',
      'Windows 打包选择 NSIS 而非 Inno Setup，因为 Inno Setup 不提供 portable 编译器包。',
    ];
    for (const content of contents) {
      const created = await client.createMemory({ content, category: 'insight' });
      assert.equal(created.ok, true);
    }

    // A paraphrase, not a quote: the fused ranking is what has to find it.
    const explored = await client.explore('怎么确认程序已经停止运行', 10);
    assert.equal(explored.ok, true);
    if (!explored.ok) return;
    assert.ok(explored.value.hits.length > 0, 'a paraphrase still returns candidates');
    for (const hit of explored.value.hits) {
      assert.equal(typeof hit['relevance'], 'string', 'each hit carries the band the policy assigned');
      assert.ok(contents.includes(hit['content'] as string), 'every hit is a body this machine published');
    }
    // The best row is about a running program, not about build verification.
    assert.match(explored.value.hits[0]!['content'] as string, /进程是否真的退出|文件存在性检查/);

    // The same query through the shared-command path returns the same first row.
    const recalled = await client.recall({ query: '怎么确认程序已经停止运行', limit: 10 });
    assert.equal(recalled.ok, true);
    if (recalled.ok) {
      assert.ok(recalled.value.memories.length > 0, 'recall returns the same candidates');
      assert.equal(recalled.value.memories[0]?.content, explored.value.hits[0]!['content']);
    }

    // An exact identifier in the query is not lost to a semantically nearby neighbour.
    const anchor = await client.explore('portable 编译器包', 10);
    assert.equal(anchor.ok, true);
    if (anchor.ok) {
      assert.ok(anchor.value.hits.some(hit => /portable 编译器包/.test(hit['content'] as string)), 'the anchored term is reachable');
    }
  } finally { await close(); }
});
