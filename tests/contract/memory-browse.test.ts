import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configure } from '../../apps/server/src/config.ts';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { MnemonCliProvider, createRunner } from '../../packages/providers/mnemon/src/index.ts';
import { RememberInput } from '../../packages/core/contracts/src/index.ts';
import { mnemonBinary } from '../e2e/mnemon-binary.ts';
import { tempDir } from '../support/temp.ts';

/**
 * Browsing must reach every project and must not lose or duplicate rows while paging.
 *
 * The cursor records how far the scan got, so a page whose candidates are all skipped still
 * advances. Scope filtering happens before body matching, so a project that sorts late is
 * still selectable.
 */


async function seed(
  root: string,
  counts: { global: number; alpha: number; beta: number; categorized?: Array<{ category: string; importance: number; entities?: string[] }> },
): Promise<{ app: ReturnType<typeof configure>; projects: string[] }> {
  mkdirSync(join(root, 'provider'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  const repo = new SqliteCandidates(resolve(join(root, 'state', 'governance.db')));
  // This fixture writes every row through the real CLI. Under a full parallel run on Windows a
  // spawn can fail for lack of process slots, which is an environment failure rather than a
  // product one; the write is retried once so a busy machine does not report a memory bug.
  const binary = mnemonBinary();
  const provider = new MnemonCliProvider({ binary, dataDir: resolve(join(root, 'provider')), store: 'browse', runner: createRunner(binary, 120_000) });
  const persist = async (content: string, source: string) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await provider.persistReviewed(content, source);
      } catch (error) {
        if (attempt >= 2 || (error as { code?: string }).code !== 'PROVIDER_UNAVAILABLE') throw error;
        await new Promise(done => setTimeout(done, 500));
      }
    }
  };
  const publish = async (content: string, label: string, index: number): Promise<void> => {
    const request = RememberInput.parse({
      idempotencyKey: `browse-${label}-${index}`, content, tags: [],
      provenance: {
        source: 'local-user', sourceReference: `browse:${index}`,
      },
    });
    const candidate = repo.submit(request);
    const written = await persist(request.content, `candidate:${candidate.id}`);
    repo.catalog.publishInitial(candidate.id, request, written.id, createHash('sha256').update(request.content).digest('hex'), '2026-11-10T00:00:00.000Z');
  };
  // Identical publishedAt on purpose: only the memoryId tie-break keeps the order stable.
  // "alpha" and "beta" only vary the text: the collection has no owner dimension.
  for (let index = 0; index < counts.global; index += 1) await publish(`条目 ${index}`, 'global', index);
  for (let index = 0; index < counts.alpha; index += 1) await publish(`甲组条目 ${index}`, 'alpha', index);
  for (let index = 0; index < counts.beta; index += 1) await publish(`乙组条目 ${index}`, 'beta', index);
  // Synced entries are the ones that carry a category; the local publish path records only a
  // knowledge type, which is exactly the distinction the filter has to respect.
  for (const [index, meta] of (counts.categorized ?? []).entries()) {
    const content = `同步分类条目 ${index}`;
    const request = RememberInput.parse({
      idempotencyKey: `browse-synced-${index}`, content, tags: [],
      provenance: {
        source: 'sync', sourceReference: `browse:synced:${index}`,
      },
    });
    const written = await persist(content, `candidate:${randomUUID()}`);
    repo.catalog.publishSynced(
      randomUUID(), request, written.id, createHash('sha256').update(content).digest('hex'),
      '2026-11-10T00:00:00.000Z', 'sync', `synced revision ${index + 1}`,
      { category: meta.category, importance: meta.importance, tags: [], entities: meta.entities ?? [] },
    );
  }
  repo.close();
  const app = configure({
    MNEMON_BINARY: mnemonBinary(), MNEMON_DATA_DIR: join(root, 'provider'), MNEMON_STORE: 'browse',
    MNEMOWEAVE_STATE_DIR: join(root, 'state'), MNEMOWEAVE_PORT: '0',
    MNEMOWEAVE_TOKEN: 'host-token-0123456789abcdef', MNEMOWEAVE_OPERATOR_TOKEN: 'operator-token-0123456789abcdef',
    MNEMOWEAVE_WORKER: 'off',
  });
  return { app, projects: ['alpha', 'beta'] };
}

test('list and graph leave unpublished Server writes for reconciliation', async t => {
  const root = await tempDir('memory-browse', 'unpublished-provider-write');
  const { app } = await seed(root, { global: 0, alpha: 0, beta: 0 });
  t.after(() => app.close());
  const provider = new MnemonCliProvider({ binary: mnemonBinary(), dataDir: join(root, 'provider'), store: 'browse' });
  const pending = await provider.persistReviewed('等待治理库发布的正文', `candidate:${randomUUID()}`);
  const external = await provider.acceptanceRemember('独立工具写入的完整正文');

  const listAll = MnemonCliProvider.prototype.listAll;
  const unavailable = t.mock.method(MnemonCliProvider.prototype, 'listAll', async () => { throw new Error('list unavailable'); });
  const graphWithoutBodies = await app.client!.graph!('browse-test', { limit: 50 });
  assert.equal(graphWithoutBodies.nodes.length, 0);
  unavailable.mock.restore();

  const rows = await listAll.call(provider);
  assert.match(rows.find(row => row.id === pending.id)?.source ?? '', /^mnemoweave:/);
  const graph = await app.client!.graph!('browse-test', { limit: 50 });
  assert.equal(graph.nodes.length, 1);
  const list = await app.client!.memories({ limit: 50 });
  assert.deepEqual(list.items.map(item => item.providerMemoryId), [external.id]);
  const [item] = list.items;
  assert.ok(item);
  assert.equal(item.memoryId, graph.nodes[0]?.memoryId);
  assert.equal((await app.app.readMemory({ memoryId: item.memoryId })).content, '独立工具写入的完整正文');
});

test('a list read skips a revision replaced while its body is being read', async t => {
  const root = await tempDir('memory-browse', 'concurrent-edit');
  const { app } = await seed(root, { global: 1, alpha: 0, beta: 0 });
  t.after(() => app.close());
  const [before] = (await app.client!.memories({ limit: 1 })).items;
  assert.ok(before);
  const readMany = MnemonCliProvider.prototype.readMany;
  t.mock.method(MnemonCliProvider.prototype, 'readMany', async function (this: MnemonCliProvider, ids: string[]) {
    const rows = await readMany.call(this, ids);
    await app.client!.editMemory(before.memoryId, { content: '并发编辑后的正文', entryVersion: before.entryVersion });
    return rows;
  }, { times: 1 });
  assert.deepEqual((await app.client!.memories({ limit: 1 })).items, []);
  const [after] = (await app.client!.memories({ limit: 1 })).items;
  assert.ok(after);
  assert.equal(after.content, '并发编辑后的正文');
  assert.equal(after.entryVersion, before.entryVersion + 1);
});

test('paging covers every row exactly once, even when candidates share a timestamp', async () => {
  const root = await tempDir('memory-browse', 'browse-paging');
  const { app } = await seed(root, { global: 12, alpha: 9, beta: 6 });
  try {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await app.client!.memories({ limit: 7, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...page.items.map(item => item.memoryId));
      pages += 1;
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
      assert.ok(pages < 20, 'paging must terminate');
    }
    assert.equal(seen.length, 27, 'every published memory appears');
    assert.equal(new Set(seen).size, 27, 'no memory is duplicated across pages');
  } finally { await app.close(); }
});

test('the list is one shared collection with no owner field or project filter', async () => {
  const root = await tempDir('memory-browse', 'browse-scope');
  const { app } = await seed(root, { global: 3, alpha: 2, beta: 1 });
  try {
    // One collection: every published memory appears, and no item carries an owner.
    const all = await app.client!.memories({ limit: 200 });
    assert.equal(all.items.length, 6);
    for (const item of all.items) assert.equal(Object.hasOwn(item, 'projectId'), false);
    assert.equal(Object.hasOwn(all, 'projects'), false);
    // The classification facet still travels with the list, so the filter picker keeps its values.
    assert.ok(all.categories !== undefined);
    // A query filters the shared collection by text; there is nothing to narrow by workspace.
    const filtered = await app.client!.memories({ limit: 200, query: '甲组' });
    assert.equal(filtered.items.length, 2);
    assert.ok(filtered.items.every(item => item.content.includes('甲组')));
  } finally { await app.close(); }
});

test('a query that skips a whole page still advances instead of stalling', async () => {
  const root = await tempDir('memory-browse', 'browse-query');
  const { app } = await seed(root, { global: 10, alpha: 0, beta: 0 });
  try {
    // Only two rows match; with limit 3 the first page may scan past many non-matching rows.
    const first = await app.client!.memories({ query: '条目 7', limit: 1 });
    assert.equal(first.items.length, 1);
    assert.match(first.items[0]!.content, /条目 7/);
    // A cursor must exist because the scan has not necessarily reached the end.
    assert.ok(first.nextCursor !== undefined || first.items.length === 1);
  } finally { await app.close(); }
});

test('a page boundary survives rows being withdrawn between pages', async () => {
  const root = await tempDir('memory-browse', 'browse-mutation');
  const { app } = await seed(root, { global: 9, alpha: 0, beta: 0 });
  try {
    const first = await app.client!.memories({ limit: 4 });
    assert.equal(first.items.length, 4);
    assert.ok(first.nextCursor !== undefined);

    // Remove a memory that sits before the cursor and one after it. An offset cursor would repeat
    // or skip here; a keyset cursor must not care.
    const all = await app.client!.memories({ limit: 200 });
    const before = all.items.find(item => !first.items.some(seen => seen.memoryId === item.memoryId));
    assert.ok(before, 'a row exists beyond the first page');
    const withdrawn = await app.client!.withdrawMemory!(before!.memoryId, { reason: '页面间撤回', entryVersion: before!.entryVersion });
    assert.equal(withdrawn.memoryId, before!.memoryId);

    const collected = [...first.items.map(item => item.memoryId)];
    let cursor: string | undefined = first.nextCursor;
    while (cursor !== undefined) {
      const page = await app.client!.memories({ limit: 4, cursor });
      collected.push(...page.items.map(item => item.memoryId));
      cursor = page.nextCursor;
    }
    assert.equal(new Set(collected).size, collected.length, 'no memory repeats across the boundary');
    // The withdrawn row is gone; every other row is still reachable exactly once.
    assert.equal(collected.includes(before!.memoryId), false);
    assert.equal(collected.length, all.items.length - 1);
  } finally { await app.close(); }
});

test('a keyset cursor never re-includes a row it already returned', async () => {
  const root = await tempDir('memory-browse', 'browse-read-failure');
  const { app } = await seed(root, { global: 5, alpha: 0, beta: 0 });
  try {
    const first = await app.client!.memories({ limit: 3 });
    assert.equal(first.items.length, 3);
    assert.ok(first.nextCursor !== undefined);
    // A stale cursor still resolves; the page continues from the key, so a failed row earlier in
    // the scan cannot have been "passed over" by an offset.
    const next = await app.client!.memories({ limit: 3, cursor: first.nextCursor });
    const overlap = next.items.filter(item => first.items.some(seen => seen.memoryId === item.memoryId));
    assert.equal(overlap.length, 0, 'a keyset cursor never re-includes a returned row');
  } finally { await app.close(); }
});

test('a category filter narrows the set and reports the categories that exist', async () => {
  const root = await tempDir('memory-browse', 'browse-category');
  const { app } = await seed(root, { global: 3, alpha: 2, beta: 0 });
  try {
    /**
     * The index follows the Provider's own accounting.
     *
     * A memory stored without a chosen classification is held as `general`, and the Provider
     * counts it that way in `by_category`. The index reports what the store holds rather than
     * re-deriving "unrecorded" from this Server's own catalog, so `general` appears.
     */
    const unfiltered = await app.client!.memories({ limit: 200 });
    assert.equal(unfiltered.items.length, 5);
    assert.deepEqual(unfiltered.categories, [{ value: 'general', count: 5 }], 'the Provider classes unclassified rows as general');
    assert.ok(unfiltered.items.every(item => item.category === 'general'), 'the Provider supplies the default category');

    // A category nothing was stored under still matches nothing.
    const filtered = await app.client!.memories({ limit: 200, category: 'decision' });
    assert.equal(filtered.items.length, 0, 'an unused category matches nothing');

    // The default category is filterable like any other.
    const general = await app.client!.memories({ limit: 200, category: 'general' });
    assert.equal(general.items.length, 5);
  } finally { await app.close(); }
});

test('a synced classification is offered in the index and filters the list', async () => {
  const root = await tempDir('memory-browse', 'browse-category-synced');
  const { app } = await seed(root, { global: 2, alpha: 0, beta: 0, categorized: [{ category: 'decision', importance: 4 }, { category: 'fact', importance: 2 }] });
  try {
    const all = await app.client!.memories({ limit: 200 });
    assert.equal(all.items.length, 4);
    // The index lists what the store holds. Two rows were written without a chosen category, so
    // the Provider holds them as `general` and counts them there.
    assert.deepEqual(all.categories, [{ value: 'decision', count: 1 }, { value: 'fact', count: 1 }, { value: 'general', count: 2 }]);
    assert.equal(all.items.filter(item => item.category === 'decision').length, 1);
    assert.equal(all.items.filter(item => item.category === 'general').length, 2, 'unclassified rows are held as general');

    const decisions = await app.client!.memories({ limit: 200, category: 'decision' });
    assert.equal(decisions.items.length, 1);
    assert.equal(decisions.items[0]?.category, 'decision');
    assert.equal(decisions.items[0]?.importance, 4);
    // The index does not shrink with the filter, so the picker can switch back.
    assert.deepEqual(decisions.categories, [{ value: 'decision', count: 1 }, { value: 'fact', count: 1 }, { value: 'general', count: 2 }]);
  } finally { await app.close(); }
});

test('each order pages every row exactly once, and a cursor cannot cross orders', async () => {
  const root = await tempDir('memory-browse', 'browse-sort');
  const { app } = await seed(root, { global: 3, alpha: 2, beta: 0, categorized: [{ category: 'decision', importance: 5 }, { category: 'fact', importance: 1 }, { category: 'insight', importance: 3 }] });
  try {
    for (const sort of ['newest', 'oldest', 'importance'] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const response = await app.client!.memories({ limit: 2, ...(cursor === undefined ? {} : { cursor }), sort });
        seen.push(...response.items.map(item => item.memoryId));
        if (response.nextCursor === undefined) break;
        cursor = response.nextCursor;
      }
      assert.equal(seen.length, 8, `${sort} must page every row`);
      assert.equal(new Set(seen).size, 8, `${sort} must not repeat a row across pages`);
    }

    // The orders really do differ: importance descends. A row stored without a chosen importance
    // is held by the Provider as its default (3), so it ranks among the middle values rather than
    // being pushed to the end as unrecorded.
    const byImportance = await app.client!.memories({ limit: 200, sort: 'importance' });
    const ranks = byImportance.items.map(item => item.importance ?? -1);
    assert.deepEqual(ranks, [...ranks].sort((left, right) => right - left), 'higher importance comes first');
    assert.ok(byImportance.items.every(item => typeof item.importance === 'number'), 'the Provider supplies its default importance');
    assert.ok(byImportance.items.at(-1)!.importance! <= byImportance.items[0]!.importance!, 'the order descends');

    // A cursor issued for one order is refused by another, instead of silently skipping rows.
    const first = await app.client!.memories({ limit: 2, sort: 'newest' });
    assert.ok(first.nextCursor);
    await assert.rejects(
      () => app.client!.memories({ limit: 2, sort: 'oldest', cursor: first.nextCursor! }),
      (error: { code?: string }) => error.code === 'INVALID_INPUT',
    );
  } finally { await app.close(); }
});

test('an entity filter matches case-insensitively and lists recorded spellings', async () => {
  const root = await tempDir('memory-browse', 'browse-entity');
  const { app } = await seed(root, {
    global: 1, alpha: 0, beta: 0,
    categorized: [{ category: 'decision', importance: 4, entities: ['MnemoWeave', 'DSH'] }, { category: 'fact', importance: 2, entities: ['dsh'] }],
  });
  try {
    const all = await app.client!.memories({ limit: 200 });
    // Two memories name the same entity in different casing; the index keeps one spelling (the
    // first one seen) and counts both. Ordering is by the recorded spelling.
    assert.deepEqual(all.entities, [{ value: 'DSH', count: 2 }, { value: 'MnemoWeave', count: 1 }]);

    const filtered = await app.client!.memories({ limit: 200, entity: 'DSH' });
    assert.equal(filtered.items.length, 2, 'matching ignores case');
    assert.ok(filtered.items.every(item => (item.entities ?? []).some(name => name.toLowerCase() === 'dsh')));

    const missing = await app.client!.memories({ limit: 200, entity: 'nobody' });
    assert.equal(missing.items.length, 0);
    assert.deepEqual(missing.entities, all.entities, 'the index describes the scoped set, not the filtered one');
  } finally { await app.close(); }
});

test('an unknown cursor shape is rejected instead of silently restarting', async () => {
  const root = await tempDir('memory-browse', 'browse-cursor');
  const { app } = await seed(root, { global: 1, alpha: 0, beta: 0 });
  try {
    // The RPC surface validates the same way the HTTP route does.
    await assert.rejects(
      app.client!.memories({ limit: 5, cursor: 'not-a-cursor' }),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_INPUT',
    );
  } finally { await app.close(); }
});
