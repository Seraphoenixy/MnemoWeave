import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { MemoryApplication } from '../../packages/core/application/src/index.ts';
import { ViewAssembler, estimateTokens, DEFAULT_INJECTION_BUDGET_TOKENS } from '../../packages/core/application/src/view.ts';
import { createHttpServer } from '../../packages/protocols/http/src/index.ts';
import { MnemoWeaveError, ReadGrant, ViewRequest } from '../../packages/core/contracts/src/index.ts';
import type { CandidateRepository } from '../../packages/core/application/src/index.ts';
import type { MemoryCatalogReader } from '../../packages/core/application/src/catalog-ports.ts';
import type { MemoryCatalogRecord, ReadGrantRecord, RerankResult } from '../../packages/core/contracts/src/index.ts';

const sha = (content: string) => createHash('sha256').update(content).digest('hex');

interface StoreEntry { descriptor: MemoryCatalogRecord; content: string }
/** In-memory catalog + provider fixture: hash-verified reads and score-ordered recall. */
function makeStore(entries: StoreEntry[]) {
  const byId = new Map(entries.map(entry => [entry.descriptor.id, entry] as const));
  const byProvider = new Map(entries.map(entry => [entry.descriptor.revisions[0]!.providerMemoryId, entry] as const));
  const catalog: MemoryCatalogReader = {
    get(memoryId: string) { const entry = byId.get(memoryId); if (!entry) throw new MnemoWeaveError('NOT_FOUND'); return entry.descriptor; },
    visibleProviderIds() { return [...byProvider.entries()].filter(([, entry]) => entry.descriptor.state === 'active').map(([id]) => id); },
    currentMemoryIds(providerMemoryId: string) { return [...byId.values()].filter(entry => entry.descriptor.currentRevisionId === entry.descriptor.revisions.find(revision => revision.providerMemoryId === providerMemoryId)?.id).map(entry => entry.descriptor.id); },
    getConflict() { throw new MnemoWeaveError('NOT_FOUND'); },
  };
  const provider = {
    async health(): Promise<{ ready: true; version: '0.2.13'; capabilities: ['health'] }> { return { ready: true, version: '0.2.13', capabilities: ['health'] }; },
    async recall(request: { query: string; limit: number }) {
      const visible = new Set(catalog.visibleProviderIds());
      const memories = [...byProvider.entries()].filter(([id]) => visible.has(id)).map(([id, entry], index) => ({ id, content: entry.content, score: 1 - index * 0.1 }));
      return { memories: memories.slice(0, request.limit) };
    },
    async readMemory(id: string) { const entry = byProvider.get(id); if (!entry) throw new MnemoWeaveError('NOT_FOUND'); return { id, content: entry.content }; },
  };
  const app = new MemoryApplication(provider, { catalog } as unknown as CandidateRepository);
  return { catalog, app, provider, byId };
}

function makeEntry(content: string, applicability = 'isolated fixture'): StoreEntry {
  const memoryId = randomUUID(); const revisionId = randomUUID(); const providerMemoryId = `provider-${randomUUID()}`;
  return {
    content,
    descriptor: {
      id: memoryId, currentRevisionId: revisionId, state: 'active', scope: 'project', projectId: 'proj-1', applicability,
      revisions: [{ id: revisionId, memoryId, number: 1, parentId: null, providerMemoryId, contentHash: sha(content), candidateId: randomUUID(), publishedAt: '2026-11-08T00:00:00.000Z', effectiveAt: '2026-11-08T00:00:00.000Z', applicability, scope: 'project' as const, projectId: 'proj-1' }],
      relations: [], conflicts: [],
    },
  };
}

const grant = (overrides: Partial<Record<string, unknown>> = {}): ReadGrantRecord => ReadGrant.parse({
  grantId: randomUUID(), hostId: 'host-a', projects: ['*'], globalIncluded: true,
  issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), generation: 5, ...overrides,
});

test('View assembly enforces grant validity, revocation and project scope before any read', async () => {
  const store = makeStore([makeEntry('content one')]);
  const assembler = new ViewAssembler(store.app, { revocations: { revocationWatermark: () => 0 } });
  await assert.rejects(assembler.assemble({ grant: grant({ expiresAt: new Date(Date.now() - 1000).toISOString() }), query: 'content' }), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'UNAUTHORIZED');
  await assert.rejects(assembler.assemble({ grant: grant({ projects: ['proj-1'] }), query: 'content', projectId: 'other-project' }), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'UNAUTHORIZED');
  const revoked = new ViewAssembler(store.app, { revocations: { revocationWatermark: () => 6 } });
  await assert.rejects(revoked.assemble({ grant: grant(), query: 'content' }), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'UNAUTHORIZED');
});

test('Assembled views are deeply frozen, tiered, traceable and generation-stamped', async () => {
  const critical = makeEntry('Critical constraint: never write outside the project store.');
  const normal = makeEntry('Normal pinned context entry with long background text '.repeat(20), 'pinned environment');
  const dynamic = makeEntry('Dynamic recalled memory for the current task.');
  const store = makeStore([critical, normal, dynamic]);
  const assembler = new ViewAssembler(store.app);
  const view = await assembler.assemble({
    grant: grant(), query: 'content', projectId: 'proj-1',
    pinned: [{ memoryId: critical.descriptor.id, tier: 'critical' }, { memoryId: normal.descriptor.id, tier: 'normal' }],
  });
  assert.equal(Object.isFrozen(view), true);
  assert.equal(Object.isFrozen(view.memories), true);
  assert.equal(Object.isFrozen(view.memories[0]), true);
  assert.throws(() => { (view as { generation: number }).generation = 99; }, TypeError);
  const criticalEntry = view.memories.find(entry => entry.tier === 'pinned-critical')!;
  assert.equal(criticalEntry.content, critical.content);
  assert.equal(criticalEntry.excerpt, false);
  assert.equal(criticalEntry.providerMemoryId, critical.descriptor.revisions[0]!.providerMemoryId);
  assert.equal(criticalEntry.sourceReference.startsWith('readMemory:provider-'), true);
  const normalEntry = view.memories.find(entry => entry.tier === 'pinned-normal')!;
  assert.equal(normalEntry.excerpt, true);
  assert.ok(normalEntry.content.length < normal.content.length);
  assert.ok(view.memories.some(entry => entry.tier === 'dynamic'));
  assert.equal(view.budget.limitTokens, DEFAULT_INJECTION_BUDGET_TOKENS);
  assert.equal(view.budget.estimator, 'utf8-bytes-3');
  assert.equal(view.budget.estimated, true);
  assert.equal(view.complete, true);
  assert.equal(view.rerank.status, 'not_requested');
  const second = await assembler.assemble({ grant: grant(), query: 'content' });
  assert.equal(second.generation, view.generation + 1);
});

test('Critical pinned overflow raises VIEW_BUDGET_EXCEEDED instead of a truncated view', async () => {
  const critical = makeEntry('C'.repeat(6000));
  const store = makeStore([critical]);
  const assembler = new ViewAssembler(store.app, { budgetTokens: 256 });
  await assert.rejects(
    assembler.assemble({ grant: grant(), query: 'content', pinned: [{ memoryId: critical.descriptor.id, tier: 'critical' }] }),
    (error: unknown) => error instanceof MnemoWeaveError && error.code === 'VIEW_BUDGET_EXCEEDED',
  );
});

test('Budget overflow excludes dynamic content, marks incompleteness and never fakes success', async () => {
  const big = makeEntry('X'.repeat(2400));
  const small = makeEntry('small tail content');
  const store = makeStore([big, small]);
  const assembler = new ViewAssembler(store.app, { budgetTokens: 256 });
  const view = await assembler.assemble({ grant: grant(), query: 'content' });
  assert.equal(view.complete, false);
  assert.ok(view.memories.length < 2);
  assert.ok(view.excluded.some(item => item.reason === 'budget'));
  assert.ok(view.budget.usedTokens <= view.budget.limitTokens);
});

test('Explicit rerank reorders; invalid model output keeps the deterministic order and reports failure', async () => {
  const first = makeEntry('alpha candidate');
  const second = makeEntry('beta candidate');
  const store = makeStore([first, second]);
  const validReranker = { async rerank(_c: string, _q: string, memories: { id: string }[], generation: number): Promise<RerankResult> { return { generation, order: [...memories.map(m => m.id)].reverse() }; } };
  const assembler = new ViewAssembler(store.app, { reranker: validReranker });
  const view = await assembler.assemble({ grant: grant(), query: 'candidate', rerank: true });
  assert.equal(view.rerank.status, 'applied');
  assert.equal(view.memories[0]!.memoryId, second.descriptor.id);
  const invalidReranker = { async rerank(_c: string, _q: string, memories: { id: string }[], generation: number): Promise<RerankResult> { return { generation, order: [memories[0]!.id, memories[0]!.id] }; } };
  const failing = new ViewAssembler(store.app, { reranker: invalidReranker });
  const failed = await failing.assemble({ grant: grant(), query: 'candidate', rerank: true });
  assert.equal(failed.rerank.status, 'failed');
  assert.equal(failed.memories[0]!.memoryId, first.descriptor.id);
});

test('Rerank runs only on explicit request or the deterministic ambiguity rule', async () => {
  const first = makeEntry('alpha candidate');
  const second = makeEntry('beta candidate');
  const store = makeStore([first, second]);
  const unconfigured = new ViewAssembler(store.app);
  const unavailable = await unconfigured.assemble({ grant: grant(), query: 'candidate', rerank: true });
  assert.equal(unavailable.rerank.status, 'unavailable');
  const notRequested = await unconfigured.assemble({ grant: grant(), query: 'candidate' });
  assert.equal(notRequested.rerank.status, 'not_requested');
  // The fixture assigns scores 1.0 and 0.9: a 0.1 gap is above the 0.05 ambiguity threshold.
  const reranker = { async rerank(_c: string, _q: string, memories: { id: string }[], generation: number): Promise<RerankResult> { return { generation, order: [...memories.map(m => m.id)].reverse() }; } };
  const gapAssembler = new ViewAssembler(store.app, { reranker });
  const notAmbiguous = await gapAssembler.assemble({ grant: grant(), query: 'candidate' });
  assert.equal(notAmbiguous.rerank.status, 'not_requested');
  // Close the score gap to 0.02 so the deterministic rule triggers rerank without an explicit request.
  store.provider.recall = async request => ({ memories: [
    { id: first.descriptor.revisions[0]!.providerMemoryId, content: first.content, score: 0.52 },
    { id: second.descriptor.revisions[0]!.providerMemoryId, content: second.content, score: 0.50 },
  ].slice(0, request.limit) });
  const autoTriggered = await gapAssembler.assemble({ grant: grant(), query: 'candidate' });
  assert.equal(autoTriggered.rerank.status, 'applied');
  assert.equal(autoTriggered.rerank.reason.includes('Model rerank'), true);
});

test('Late rerank results cannot rewrite a delivered view generation or a foreign candidate set', async () => {
  const entry = makeEntry('only candidate');
  const store = makeStore([entry]);
  const assembler = new ViewAssembler(store.app);
  const view = await assembler.assemble({ grant: grant(), query: 'content' });
  assert.equal(view.memories[0]!.memoryId, entry.descriptor.id);
  assert.throws(() => ViewAssembler.applyRerank(view, { generation: view.generation + 1, order: [entry.descriptor.id] }), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'INVALID_STATE');
  assert.throws(() => ViewAssembler.applyRerank(view, { generation: view.generation, order: [randomUUID()] }), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'INVALID_INPUT');
  const reordered = ViewAssembler.applyRerank(view, { generation: view.generation, order: [entry.descriptor.id] });
  assert.equal(reordered.rerank.status, 'applied');
  assert.equal(Object.isFrozen(reordered), true);
});

test('Token estimation is conservative over UTF-8 and declared as an estimate', () => {
  assert.equal(estimateTokens('abc'), 1);
  assert.equal(estimateTokens('测'.repeat(10)), Math.ceil(30 / 3));
  assert.ok(estimateTokens('a'.repeat(3000)) >= 1000);
});

test('Superseded or unknown pinned memories are excluded with reasons, never silently delivered', async () => {
  const active = makeEntry('active content');
  const superseded = makeEntry('old content');
  superseded.descriptor = { ...superseded.descriptor, state: 'superseded' };
  const store = makeStore([active, superseded]);
  const assembler = new ViewAssembler(store.app);
  const view = await assembler.assemble({ grant: grant(), query: 'content', pinned: [{ memoryId: superseded.descriptor.id, tier: 'critical' }, { memoryId: randomUUID(), tier: 'critical' }, { memoryId: active.descriptor.id, tier: 'critical' }] });
  assert.equal(view.memories.length, 1);
  assert.equal(view.memories[0]!.memoryId, active.descriptor.id);
  assert.deepEqual(view.excluded.map(item => item.reason).sort(), ['not_visible', 'superseded']);
});

test('HTTP View delivery requires the paired Host header and returns the assembled view', async () => {
  const store = makeStore([makeEntry('HTTP view fixture content')]);
  const assembler = new ViewAssembler(store.app, { revocations: { revocationWatermark: () => 0 } });
  const token = 'local-view-http-token-0123456789';
  const view = async (hostId: string, input: unknown) => {
    const request = ViewRequest.parse(input);
    return assembler.assemble({ grant: grant({ hostId }), ...(request.query !== undefined ? { query: request.query } : {}) });
  };
  const server = createHttpServer(store.app, token, undefined, { view, context: () => ({ sessionId: 'probe', task: null, revision: 0, closed: false, entries: [], pins: [], capture: 'idle' }), pin: () => undefined, register: () => undefined, closeSession: () => undefined, events: () => ({ status: 'stored', eventId: 'probe' }), memories: async () => ({ items: [] }), editMemory: async () => { throw new Error('not configured'); } });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const withoutHost = await fetch(`${base}/v1/view`, { method: 'POST', headers, body: JSON.stringify({ query: 'content' }) });
    assert.equal(withoutHost.status, 401);
    const delivered = await fetch(`${base}/v1/view`, { method: 'POST', headers: { ...headers, 'x-mnemoweave-host': 'host-a' }, body: JSON.stringify({ query: 'content' }) });
    assert.equal(delivered.status, 200);
    const body = await delivered.json() as unknown as { viewId: string; memories: { content: string }[] };
    assert.ok(body.viewId);
    assert.equal(body.memories.length, 1);
  } finally {
    await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
  }
});

test('runtime rules are injected whole and counted separately from the memory budget', async () => {
  const store = makeStore([makeEntry('content one')]);
  const rules = [{ entryId: randomUUID(), version: 1, body: '提交前必须运行类型检查。' }];
  const assembler = new ViewAssembler(store.app, { rules: () => rules });
  const view = await assembler.assemble({ grant: grant(), query: 'content' });
  assert.deepEqual(view.rules, rules);
  assert.equal(view.rulesBudget?.usedTokens, estimateTokens(rules[0]!.body) + 8);
  assert.equal(view.rulesBudget?.exceeded, false);
  assert.equal(view.rulesBudget?.limitTokens, 1024);
});

test('an over-budget rule set is omitted instead of trimmed', async () => {
  const store = makeStore([makeEntry('content one')]);
  const rules = [{ entryId: randomUUID(), version: 1, body: '准则'.repeat(2000) }];
  const assembler = new ViewAssembler(store.app, { rules: () => rules });
  const view = await assembler.assemble({ grant: grant(), query: 'content' });
  assert.equal(view.rules, undefined);
  assert.equal(view.rulesBudget?.exceeded, true);
  assert.ok(view.rulesBudget!.usedTokens > 1024);
  assert.equal(view.memories.length, 1);
  assert.equal(view.complete, true);
});

test('a view without rules carries no rules fields', async () => {
  const store = makeStore([makeEntry('content one')]);
  const assembler = new ViewAssembler(store.app);
  const view = await assembler.assemble({ grant: grant(), query: 'content' });
  assert.equal(view.rules, undefined);
  assert.equal(view.rulesBudget, undefined);
});

test('A recalled Provider memory this machine never published is excluded as unregistered', async () => {
  const entry = makeEntry('registered content');
  const store = makeStore([entry]);
  store.provider.recall = async () => ({ memories: [
    { id: 'provider-never-published', content: '陌生正文 content', score: 0.9 },
    { id: entry.descriptor.revisions[0]!.providerMemoryId, content: entry.content, score: 0.8 },
  ] });
  const view = await new ViewAssembler(store.app).assemble({ grant: grant(), query: 'content' });
  assert.deepEqual(view.excluded.map(item => item.reason), ['unregistered']);
  assert.equal(view.excluded[0]!.memoryId, 'provider-never-published');
  assert.equal(view.memories.length, 1);
  assert.equal(view.memories[0]!.memoryId, entry.descriptor.id);
});
