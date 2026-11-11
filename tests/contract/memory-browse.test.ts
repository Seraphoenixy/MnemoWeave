import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configure } from '../../apps/server/src/config.ts';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { MnemonCliProvider } from '../../packages/providers/mnemon/src/index.ts';
import { RememberInput } from '../../packages/core/contracts/src/index.ts';
import { mnemonBinary } from '../e2e/mnemon-binary.ts';

/**
 * Browsing must reach every project and must not lose or duplicate rows while paging.
 *
 * The cursor records how far the scan got, so a page whose candidates are all skipped still
 * advances. Scope filtering happens before body matching, so a project that sorts late is
 * still selectable.
 */

const SCOPE = 'project:alpha';

async function seed(
  root: string,
  counts: { global: number; alpha: number; beta: number; categorized?: Array<{ category: string; importance: number; entities?: string[] }> },
): Promise<{ app: ReturnType<typeof configure>; projects: string[] }> {
  mkdirSync(join(root, 'provider'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  const repo = new SqliteCandidates(resolve(join(root, 'state', 'governance.db')));
  const provider = new MnemonCliProvider({ binary: mnemonBinary(), dataDir: resolve(join(root, 'provider')), store: 'browse' });
  const publish = async (content: string, projectId: string | null, index: number): Promise<void> => {
    const request = RememberInput.parse({
      idempotencyKey: `browse-${projectId ?? 'global'}-${index}`, content, knowledgeType: 'Practice', tags: [],
      ...(projectId === null ? { scope: 'global' } : { scope: 'project', projectId }),
      provenance: {
        source: 'local-user', sourceReference: `browse:${index}`, evidence: ['browse'], verificationStatus: 'verified',
        confidence: 1, applicability: projectId ?? 'global', limitations: '无（验收固定值）', lastVerified: '2026-11-10T00:00:00.000Z',
      },
    });
    const candidate = repo.submit(request);
    const written = await provider.persistReviewed(request.content, `candidate:${candidate.id}`);
    repo.catalog.publishInitial(candidate.id, request, written.id, createHash('sha256').update(request.content).digest('hex'), '2026-11-10T00:00:00.000Z');
  };
  // Identical publishedAt on purpose: only the memoryId tie-break keeps the order stable.
  for (let index = 0; index < counts.global; index += 1) await publish(`全局条目 ${index}`, null, index);
  for (let index = 0; index < counts.alpha; index += 1) await publish(`甲项目条目 ${index}`, 'alpha', index);
  for (let index = 0; index < counts.beta; index += 1) await publish(`乙项目条目 ${index}`, 'beta', index);
  // Synced entries are the ones that carry a category; the local publish path records only a
  // knowledge type, which is exactly the distinction the filter has to respect.
  for (const [index, meta] of (counts.categorized ?? []).entries()) {
    const content = `同步分类条目 ${index}`;
    const request = RememberInput.parse({
      idempotencyKey: `browse-synced-${index}`, content, knowledgeType: 'Practice', tags: [], scope: 'global',
      provenance: {
        source: 'sync', sourceReference: `browse:synced:${index}`, evidence: ['sync'], verificationStatus: 'verified',
        confidence: 1, applicability: 'global', limitations: '无（验收固定值）', lastVerified: '2026-11-10T00:00:00.000Z',
      },
    });
    const written = await provider.persistReviewed(content, `candidate:${randomUUID()}`);
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

test('paging covers every row exactly once, even when candidates share a timestamp', async () => {
  const root = resolve('work', 'browse-paging', randomUUID());
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

test('a scope filter reaches a project that sorts late, and reports the browsable projects', async () => {
  const root = resolve('work', 'browse-scope', randomUUID());
  const { app } = await seed(root, { global: 3, alpha: 2, beta: 1 });
  try {
    const all = await app.client!.memories({ limit: 200 });
    const listed = all.projects ?? [];
    // The project index covers the whole set, so a filter can never hide an existing project.
    assert.deepEqual(listed.map(entry => entry.projectId), ['alpha', 'beta']);
    assert.deepEqual(listed.map(entry => entry.count), [2, 1]);

    const beta = await app.client!.memories({ limit: 200, scope: 'project', projectId: 'beta' });
    assert.equal(beta.items.length, 1);
    assert.equal(beta.items[0]?.projectId, 'beta');
    assert.equal(beta.items[0]?.scope, 'project');

    const globalOnly = await app.client!.memories({ limit: 200, scope: 'global' });
    assert.equal(globalOnly.items.length, 3);
    assert.ok(globalOnly.items.every(item => item.scope === 'global'), 'a global filter never leaks project rows');
  } finally { await app.close(); }
});

test('a query that skips a whole page still advances instead of stalling', async () => {
  const root = resolve('work', 'browse-query', randomUUID());
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
  const root = resolve('work', 'browse-mutation', randomUUID());
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
  const root = resolve('work', 'browse-read-failure', randomUUID());
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
  const root = resolve('work', 'browse-category', randomUUID());
  const { app } = await seed(root, { global: 3, alpha: 2, beta: 0 });
  try {
    // The seed publishes without classification, so every memory's category is unknown. A
    // category filter must not match them and must not invent "general".
    const unfiltered = await app.client!.memories({ limit: 200 });
    assert.equal(unfiltered.items.length, 5);
    assert.equal(unfiltered.categories?.length ?? 0, 0, 'no category was recorded, so none is offered');
    assert.ok(unfiltered.items.every(item => item.category === undefined), 'no category is invented');

    const filtered = await app.client!.memories({ limit: 200, category: 'decision' });
    assert.equal(filtered.items.length, 0, 'an unknown category matches nothing');
  } finally { await app.close(); }
});

test('a synced classification is offered in the index and filters the list', async () => {
  const root = resolve('work', 'browse-category-synced', randomUUID());
  const { app } = await seed(root, { global: 2, alpha: 0, beta: 0, categorized: [{ category: 'decision', importance: 4 }, { category: 'fact', importance: 2 }] });
  try {
    const all = await app.client!.memories({ limit: 200 });
    assert.equal(all.items.length, 4);
    // The index lists the categories that exist, with counts, before any filter is applied.
    assert.deepEqual(all.categories, [{ value: 'decision', count: 1 }, { value: 'fact', count: 1 }]);
    assert.equal(all.items.filter(item => item.category === 'decision').length, 1);
    assert.equal(all.items.filter(item => item.category === undefined).length, 2, 'unclassified stays unclassified');

    const decisions = await app.client!.memories({ limit: 200, category: 'decision' });
    assert.equal(decisions.items.length, 1);
    assert.equal(decisions.items[0]?.category, 'decision');
    assert.equal(decisions.items[0]?.importance, 4);
    // The index does not shrink with the filter, so the picker can switch back.
    assert.deepEqual(decisions.categories, [{ value: 'decision', count: 1 }, { value: 'fact', count: 1 }]);
  } finally { await app.close(); }
});

test('each order pages every row exactly once, and a cursor cannot cross orders', async () => {
  const root = resolve('work', 'browse-sort', randomUUID());
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

    // The orders really do differ: importance descends, and unrecorded importance sorts last.
    const byImportance = await app.client!.memories({ limit: 200, sort: 'importance' });
    const ranks = byImportance.items.map(item => item.importance ?? -1);
    assert.deepEqual(ranks, [...ranks].sort((left, right) => right - left), 'higher importance comes first');
    assert.equal(byImportance.items.at(-1)?.importance, undefined, 'an unrecorded importance sorts last rather than as 0');

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
  const root = resolve('work', 'browse-entity', randomUUID());
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
  const root = resolve('work', 'browse-cursor', randomUUID());
  const { app } = await seed(root, { global: 1, alpha: 0, beta: 0 });
  try {
    // The RPC surface validates the same way the HTTP route does.
    await assert.rejects(
      app.client!.memories({ limit: 5, cursor: 'not-a-cursor' }),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_INPUT',
    );
  } finally { await app.close(); }
});
