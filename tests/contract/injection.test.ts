import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { MemoryApplication } from '../../packages/core/application/src/index.ts';
import { ViewAssembler } from '../../packages/core/application/src/view.ts';
import { InjectionController } from '../../packages/adapters/shared-sdk/src/index.ts';
import type { InjectionRecallSource } from '../../packages/adapters/shared-sdk/src/index.ts';
import { unverifiedDescriptor, validateDescriptor } from '../../packages/adapters/shared-sdk/src/descriptor.ts';
import { MnemoWeaveError, View } from '../../packages/core/contracts/src/index.ts';
import type { CandidateRepository } from '../../packages/core/application/src/index.ts';
import type { MemoryCatalogReader } from '../../packages/core/application/src/catalog-ports.ts';
import type { MemoryCatalogRecord, ViewRecord } from '../../packages/core/contracts/src/index.ts';

const sha = (content: string) => createHash('sha256').update(content).digest('hex');

function makeEntry(content: string): { descriptor: MemoryCatalogRecord; content: string } {
  const memoryId = randomUUID(); const revisionId = randomUUID(); const providerMemoryId = `provider-${randomUUID()}`;
  return {
    content,
    descriptor: {
      id: memoryId, currentRevisionId: revisionId, state: 'active', scope: 'project', applicability: 'injection fixture',
      revisions: [{ id: revisionId, memoryId, number: 1, parentId: null, providerMemoryId, contentHash: sha(content), candidateId: randomUUID(), publishedAt: '2026-11-08T00:00:00.000Z', effectiveAt: '2026-11-08T00:00:00.000Z', applicability: 'injection fixture', scope: 'project' as const }],
      relations: [], conflicts: [],
    },
  };
}

function makeCatalog(entries: { descriptor: MemoryCatalogRecord; content: string }[]): { catalog: MemoryCatalogReader; app: MemoryApplication } {
  const byId = new Map(entries.map(entry => [entry.descriptor.id, entry] as const));
  const byProvider = new Map(entries.map(entry => [entry.descriptor.revisions[0]!.providerMemoryId, entry] as const));
  const catalog: MemoryCatalogReader = {
    get(memoryId: string) { const entry = byId.get(memoryId); if (!entry) throw new MnemoWeaveError('NOT_FOUND'); return entry.descriptor; },
    visibleProviderIds() { return [...byProvider.entries()].filter(([, entry]) => entry.descriptor.state === 'active').map(([id]) => id); },
    currentMemoryIds(providerMemoryId: string) { return [...byId.values()].filter(entry => entry.descriptor.currentRevisionId === entry.descriptor.revisions.find(rev => rev.providerMemoryId === providerMemoryId)?.id).map(entry => entry.descriptor.id); },
    getConflict() { throw new MnemoWeaveError('NOT_FOUND'); },
  };
  const provider = {
    async health(): Promise<{ ready: true; version: '0.2.13'; capabilities: ['health'] }> { return { ready: true, version: '0.2.13', capabilities: ['health'] }; },
    async recall(req: { query: string; limit: number }) {
      const visible = new Set(catalog.visibleProviderIds());
      const scored = [...byProvider.entries()].filter(([id]) => visible.has(id)).map(([id, entry], index) => ({ id, content: entry.content, score: 1 - index * 0.1 }));
      return { memories: scored.slice(0, req.limit) };
      void 0;
    },
    async readMemory(id: string) { const entry = byProvider.get(id); if (!entry) throw new MnemoWeaveError('NOT_FOUND'); return { id, content: entry.content }; },
  };
  return { catalog, app: new MemoryApplication(provider, { catalog } as unknown as CandidateRepository) };
}

const grant = () => ({
  grantId: randomUUID(), hostId: 'host-injection', projects: ['*'], globalIncluded: true,
  issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), generation: 5,
});

function makeController(entries: { descriptor: MemoryCatalogRecord; content: string }[], recallOverride?: Partial<InjectionRecallSource>) {
  const { app } = makeCatalog(entries);
  const assembler = new ViewAssembler(app, { budgetTokens: 4096 });
  let revoked = false;
  let delayMs = 0;
  const source: InjectionRecallSource = {
    recall: async (query: string) => {
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      const result = await app.recall({ query, limit: 10 });
      return { status: 'ok' as const, memories: result.memories.map(({ id, content, score }) => ({ id, content, ...(score !== undefined ? { score } : {}) })), dataTime: new Date().toISOString() };
    },
    isRevoked: async () => revoked,
  };
  if (recallOverride?.recall) source.recall = recallOverride.recall.bind(recallOverride);
  if (recallOverride?.isRevoked) source.isRevoked = recallOverride.isRevoked.bind(recallOverride);
  const controller = new InjectionController(source, (query, memories) => assembler.assemble({ grant: grant(), ...(query === null ? {} : { query }) }).then(view => {
    // Keep only memories the recall actually returned so the test can bind content to views.
    const allowed = new Set(memories.map(memory => memory.id));
    return View.parse({ ...view, memories: view.memories.filter(memory => allowed.has(memory.providerMemoryId) || query === null) });
  }), { deadlineMs: 150 });
  return { controller, setRevoked: (value: boolean) => { revoked = value; }, setDelay: (ms: number) => { delayMs = ms; } };
}

test('Session start injects the full view; ordinary turns reuse the bound view', async () => {
  const { controller } = makeController([makeEntry('Critical injection fixture content.')]);
  const turn = { sessionId: 's-1', turnId: 't-1' };
  const outcome = await controller.inject('session_started', turn, 'Critical injection', false);
  assert.equal(outcome.status, 'injected');
  assert.ok(outcome.viewId);
  assert.equal(outcome.deliveredAtTurn, 't-1');
  // HOST-05: ordinary turns keep the current view without re-injection.
  const bound = controller.currentViewFor('s-1');
  assert.equal(bound?.viewId, outcome.viewId);
  assert.equal(controller.currentViewFor('s-2'), undefined);
});

test('Incremental triggers rebuild views; ordinary events do not', async () => {
  const { controller } = makeController([makeEntry('Incremental trigger fixture.')]);
  await controller.inject('session_started', { sessionId: 's-1', turnId: 't-0' }, 'Incremental trigger', false);
  const before = controller.currentViewFor('s-1')!;
  assert.equal(controller.isIncrementalTrigger('message_user'), true);
  assert.equal(controller.isIncrementalTrigger('tool_failure'), true);
  const outcome = await controller.inject('message_user', { sessionId: 's-1', turnId: 't-1' }, 'Incremental trigger', false);
  assert.equal(outcome.status, 'injected');
  const after = controller.currentViewFor('s-1')!;
  assert.equal(after.viewId, outcome.viewId);
  assert.notEqual(after.generation, before.generation);
});

test('Deadline miss reports explicit unavailability and the late result is delivered only as a new view', async () => {
  const { controller, setDelay } = makeController([makeEntry('Slow retrieval fixture.')]);
  setDelay(400);
  const first = await controller.inject('explicit_recall', { sessionId: 's-1', turnId: 't-1' }, 'Slow retrieval', true);
  assert.equal(first.status, 'unavailable');
  assert.equal(first.viewId, undefined, 'a missed deadline never claims delivery');
  assert.equal(first.usedLocalReplica, true);
  // The turn that already timed out cannot receive the late result.
  const replay = await controller.inject('explicit_recall', { sessionId: 's-1', turnId: 't-1' }, 'Slow retrieval', true);
  assert.notEqual(replay.status, 'injected');
  // The next supported entry (a new turn, no fresh query) receives it as a NEW view.
  setDelay(0);
  await new Promise(resolve => setTimeout(resolve, 450));
  const second = await controller.inject('message_user', { sessionId: 's-1', turnId: 't-2' }, null, true);
  assert.equal(second.status, 'injected');
  assert.ok(second.viewId);
  assert.equal(second.reason.includes('late result'), true);
  assert.notEqual(second.viewId, first.viewId);
});

test('Revocation during the foreground window denies injection (AUTH-02/HOST-06)', async () => {
  const { controller, setRevoked } = makeController([makeEntry('Revoked fixture.')]);
  setRevoked(true);
  const outcome = await controller.inject('session_started', { sessionId: 's-1', turnId: 't-1' }, 'Revoked fixture', false);
  assert.equal(outcome.status, 'denied');
  assert.equal(outcome.reason, 'revoked');
  assert.equal(outcome.viewId, undefined);
});

test('Recall unavailability keeps ordinary tasks alive with an explicit reason (HOST-04)', async () => {
  const { controller } = makeController([], {
    async recall() { return { status: 'unavailable', reason: 'bridge offline and no valid replica' }; },
  });
  const outcome = await controller.inject('session_started', { sessionId: 's-1', turnId: 't-1' }, 'anything', false);
  assert.equal(outcome.status, 'unavailable');
  assert.equal(outcome.reason, 'bridge offline and no valid replica');
  assert.equal(outcome.viewId, undefined);
});

test('Critical pinned overflow maps to budget_exceeded, never to a truncated view (VIEW-01)', async () => {
  const critical = makeEntry('C'.repeat(8000));
  const { app } = makeCatalog([critical]);
  // A pinned-critical-only view over a 128-token budget must fail loudly.
  const assembler = new ViewAssembler(app, { budgetTokens: 128 });
  const failing = new InjectionController({
    async recall() { return { status: 'ok', memories: [], dataTime: new Date().toISOString() }; },
    async isRevoked() { return false; },
  }, () => assembler.assemble({ grant: grant(), pinned: [{ memoryId: critical.descriptor.id, tier: 'critical' }] }), { deadlineMs: 150 });
  const outcome = await failing.inject('session_started', { sessionId: 's-1', turnId: 't-1' }, null, false);
  assert.equal(outcome.status, 'budget_exceeded');
  assert.equal(outcome.viewId, undefined);
});

test('Adapter descriptors keep unverified hosts out of the acceptance claim', () => {
  const descriptor = unverifiedDescriptor('DSH', '0.2.2-rc.1', '0.1.0', 'docs/implementation/host-integration-evidence.md');
  validateDescriptor(descriptor);
  assert.equal(descriptor.gatesMet, false, 'unverified capabilities cannot pass the HOST-02 gate');
  const proven = unverifiedDescriptor('ZCode', 'unknown', '0.1.0', 'evidence', new Date().toISOString());
  proven.capabilities.context_injection = { status: 'supported', evidence: 'local verification record', verifiedAt: new Date().toISOString() };
  proven.capabilities.message_events = { status: 'supported', evidence: 'local verification record', verifiedAt: new Date().toISOString() };
  proven.capabilities.tool_results = { status: 'supported', evidence: 'local verification record', verifiedAt: new Date().toISOString() };
  proven.capabilities.session_start = { status: 'supported', evidence: 'local verification record', verifiedAt: new Date().toISOString() };
  validateDescriptor(proven);
  assert.equal(proven.gatesMet, true);
  assert.throws(() => {
    const bad = unverifiedDescriptor('Codex', '1.0', '0.1.0', 'evidence', new Date().toISOString());
    bad.capabilities.context_injection = { status: 'supported', evidence: 'evidence', verifiedAt: null };
    validateDescriptor(bad);
  }, /verification date/);
});


test('Authorization checks share the foreground deadline', async () => {
  const { controller } = makeController([], { isRevoked: () => new Promise<boolean>(() => {}) });
  const started = performance.now();
  const result = await controller.inject('session_started', { sessionId: 'deadline-auth', turnId: '1' }, null, false);
  assert.equal(result.status, 'unavailable');
  assert.ok(performance.now() - started < 1000);
});

test('Revocation after assembly denies final delivery', async () => {
  let checks = 0;
  const { controller } = makeController([], { isRevoked: async () => ++checks >= 2 });
  const result = await controller.inject('session_started', { sessionId: 'final-auth', turnId: '1' }, null, false);
  assert.equal(result.status, 'denied');
});
