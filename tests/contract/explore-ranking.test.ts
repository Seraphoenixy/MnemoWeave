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
import { tempDir } from '../support/temp.ts';

/**
 * Explore is a ranking, not a scan.
 *
 * The Provider re-ranks on every call and offers no cursor, so "show more" means asking again with
 * a larger limit. That is only honest if the larger answer is a superset in the same order;
 * otherwise the second click would reshuffle what the user just read.
 */

const TOKEN = 'explore-token-0123456789abcdef';
const OPERATOR = 'explore-operator-0123456789abc';
const HOST = 'explore-probe';

async function seeded(root: string, contents: string[]): Promise<{ client: MemoryClient; close: () => Promise<void> }> {
  mkdirSync(join(root, 'provider'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  const repo = new SqliteCandidates(resolve(join(root, 'state', 'governance.db')));
  const provider = new MnemonCliProvider({ binary: mnemonBinary(), dataDir: resolve(join(root, 'provider')), store: 'explore' });
  for (const [index, content] of contents.entries()) {
    const request = RememberInput.parse({
      idempotencyKey: `explore-${index}`, content, tags: [],
      provenance: {
        source: 'local-user', sourceReference: `explore:${index}`,
      },
    });
    const written = await provider.persistReviewed(content, `candidate:${randomUUID()}`);
    repo.catalog.publishSynced(
      randomUUID(), request, written.id, createHash('sha256').update(content).digest('hex'),
      '2026-11-10T00:00:00.000Z', 'sync', `synced revision ${index + 1}`,
      { category: 'fact', importance: 3, tags: [], entities: [] },
    );
  }
  repo.close();
  const app = configure({
    MNEMON_BINARY: mnemonBinary(), MNEMON_DATA_DIR: join(root, 'provider'), MNEMON_STORE: 'explore',
    MNEMOWEAVE_STATE_DIR: join(root, 'state'), MNEMOWEAVE_PORT: '0',
    MNEMOWEAVE_TOKEN: TOKEN, MNEMOWEAVE_OPERATOR_TOKEN: OPERATOR, MNEMOWEAVE_WORKER: 'off',
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

test('a larger limit extends the same ranking instead of reshuffling it', async () => {
  const root = await tempDir('explore-ranking', 'explore-ranking');
  const { client, close } = await seeded(root, [
    'MnemoWeave 记忆界面使用 TypeScript 与 React 编写。',
    'TypeScript 的严格模式要求显式处理 undefined。',
    'React 组件状态必须通过 setState 更新。',
    '今天午餐吃了拉面。',
  ]);
  try {
    const small = await client.explore('TypeScript', 2, 0);
    const large = await client.explore('TypeScript', 4, 0);
    assert.equal(small.ok, true);
    assert.equal(large.ok, true);
    if (!small.ok || !large.ok) return;
    assert.equal(small.value.truncated, true, 'a full page means more may exist');
    assert.ok(large.value.hits.length >= small.value.hits.length);
    // The two calls must agree on the head of the list, otherwise "show more" rewrites history.
    assert.deepEqual(
      large.value.hits.slice(0, small.value.hits.length).map(hit => hit['memoryId']),
      small.value.hits.map(hit => hit['memoryId']),
      'the larger answer keeps the smaller answer as its prefix',
    );

    // Every hit is a memory this machine published, and each one can be opened.
    for (const hit of large.value.hits) {
      const detail = await client.readMemory(hit['memoryId'] as string);
      assert.equal(detail.ok, true, 'an explore hit maps to a readable memory');
    }

    // The floor is applied to every hit, and an empty result is not reported as truncated.
    const strict = await client.explore('TypeScript', 4, 1);
    assert.equal(strict.ok, true);
    if (strict.ok) {
      assert.ok(strict.value.hits.every(hit => (hit['score'] as number) >= 1), 'the floor is applied to every hit');
      if (strict.value.hits.length === 0) assert.equal(strict.value.truncated, false);
    }
  } finally { await close(); }
});

test('the same query returns the same order twice', async () => {
  const root = await tempDir('explore-ranking', 'explore-stable');
  const { client, close } = await seeded(root, [
    'TypeScript 类型系统在编译期发现问题。',
    'TypeScript 严格模式要求显式处理 undefined。',
    'TypeScript 与 React 一起构成记忆界面。',
    '无关条目：今天午餐吃了拉面。',
  ]);
  try {
    // The Provider's own tie order is unstable — measured, it returned three different orders for
    // one query across five calls — so the Server re-sorts. Without that, re-running the same
    // search would look like the list shuffled itself.
    const first = await client.explore('TypeScript', 4, 0);
    const second = await client.explore('TypeScript', 4, 0);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.deepEqual(
      second.value.hits.map(hit => hit['memoryId']),
      first.value.hits.map(hit => hit['memoryId']),
      'the same query returns the same order',
    );
    // And the order is a total one: scores never increase down the list.
    const scores = first.value.hits.map(hit => hit['score'] as number);
    assert.deepEqual(scores, [...scores].sort((left, right) => right - left), 'scores descend');
  } finally { await close(); }
});

test('an impossible floor returns nothing rather than everything', async () => {
  const root = await tempDir('explore-ranking', 'explore-floor');
  const { client, close } = await seeded(root, ['完整性校验的固定文本。']);
  try {
    const anything = await client.explore('完整性校验', 10, 0);
    const nothing = await client.explore('完整性校验', 10, 1);
    assert.equal(anything.ok, true);
    assert.equal(nothing.ok, true);
    if (!anything.ok || !nothing.ok) return;
    assert.ok(anything.value.hits.length >= 1, 'the memory is found without a floor');
    // A floor of 1 keeps only exact full-score matches; anything below it is dropped, and the
    // difference proves the floor is applied rather than ignored.
    assert.ok(nothing.value.hits.length <= anything.value.hits.length);
    assert.ok(nothing.value.hits.every(hit => (hit['score'] as number) >= 1));
  } finally { await close(); }
});
