import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryApplication } from '../../packages/core/application/src/index.ts';
import type { CandidateRepository } from '../../packages/core/application/src/index.ts';
import { MnemoWeaveError } from '../../packages/core/contracts/src/index.ts';

const app = new MemoryApplication({
  async health() { return { ready: true, version: '0.2.13', capabilities: ['health', 'recall'] }; },
  async recall(request) { return { memories: [{ id: '1', content: request.query }] }; },
});
test('Application validates strict input and applies defaults', async () => {
  assert.equal((await app.recall({ query: 'test' })).memories[0]?.content, 'test');
  for (const input of [{ query: '' }, { query: 'test', limit: 0 }, { query: 'test', grant: 'all' }]) await assert.rejects(app.recall(input));
});
test('Business Remember cannot bypass candidate review', async () => {
  await assert.rejects(app.remember({ content: 'unreviewed', approved: true }), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'REVIEW_REQUIRED');
});

function catalogStub(visible: string[]) {
  return {
    catalog: {
      visibleProviderIds: () => visible,
      currentMemoryIds: (providerId: string) => (visible.includes(providerId) ? [`logical-${providerId}`] : []),
      // Only active memories are readable; the recall filter checks the state of each candidate.
      get: () => ({ state: 'active' }),
      getConflict: () => { throw new Error('not used'); },
    },
  };
}

test('keyword recall keeps a low native score', async () => {
  const result = await new MemoryApplication({
    health: () => app.health(),
    async recall() { return { memories: [{ id: 'match', content: 'alpha', score: 0.2 }] }; },
  }).recall({ query: 'alpha', mode: 'keyword', limit: 1 });
  assert.deepEqual(result.memories.map(({ id, score }) => ({ id, score })), [{ id: 'match', score: 0.2 }]);
});

test('keyword recovery reserves a result slot for a query match before the page is capped', async () => {
  const application = new MemoryApplication({
    health: () => app.health(),
    async recall({ mode }) {
      return { memories: mode === 'keyword'
        ? [{ id: 'match', content: 'alpha bravo', score: 0.2 }]
        : [{ id: 'unrelated', content: 'unrelated', score: 0.9 }] };
    },
  }, catalogStub(['match', 'unrelated']) as unknown as CandidateRepository);
  const result = await application.recall({ query: 'alpha bravo charlie delta', limit: 1 });
  assert.deepEqual(result.memories.map(memory => memory.id), ['match']);
});

test('Default recall filters before pagination and keeps expanding until the requested page is filled', async () => {
  const windows: number[] = [];
  const provider = {
    async health(): Promise<{ ready: true; version: '0.2.13'; capabilities: ['health'] }> { return { ready: true, version: '0.2.13', capabilities: ['health'] }; },
    async recall(req: { query: string; limit: number }) {
      windows.push(req.limit);
      // Sparse visible pool: visible memories only appear once the window covers their ranks.
      const memories = Array.from({ length: req.limit }, (_, index) => ({ id: `noise-${index + 1}`, content: `noise ${index + 1}` }));
      if (req.limit >= 150) memories.push({ id: 'visible-1', content: 'needed' });
      if (req.limit >= 250) memories.push({ id: 'visible-2', content: 'second' });
      return { memories };
    },
  };
  const app = new MemoryApplication(provider, catalogStub(['visible-1', 'visible-2']) as unknown as CandidateRepository);
  const result = await app.recall({ query: 'test', limit: 2 });
  assert.deepEqual(result.memories.map(memory => memory.id), ['visible-1', 'visible-2']);
  assert.deepEqual(windows, [100, 200, 300]);
  assert.equal(result.complete, false);
});

test('Default recall reports completeness when the Provider list is exhausted before the page fills', async () => {
  const provider = {
    async health(): Promise<{ ready: true; version: '0.2.13'; capabilities: ['health'] }> { return { ready: true, version: '0.2.13', capabilities: ['health'] }; },
    async recall(req: { query: string; limit: number }) {
      const total = Math.min(req.limit, 150);
      const memories = Array.from({ length: total }, (_, index) => ({ id: `noise-${index + 1}`, content: `noise ${index + 1}` }));
      if (req.limit >= 150) memories.push({ id: 'visible-1', content: 'needed' });
      return { memories };
    },
  };
  const app = new MemoryApplication(provider, catalogStub(['visible-1']) as unknown as CandidateRepository);
  const result = await app.recall({ query: 'test', limit: 10 });
  assert.deepEqual(result.memories.map(memory => memory.id), ['visible-1']);
  assert.equal(result.complete, true);
});

test('embedding diagnostics turn the Provider coverage report into a recall mode', async () => {
  const app = new MemoryApplication({
    async health() { return { ready: true, version: '0.2.13', capabilities: ['health', 'recall'] }; },
    async recall() { return { memories: [] }; },
    async embeddingStatus() { return { serviceAvailable: true, modelAvailable: true, protocol: 'ollama', model: 'nomic-embed-text', embedded: 2, total: 4 }; },
  });
  const report = await app.embeddingDiagnostics();
  assert.equal(report.coverage, 0.5);
  assert.equal(report.recallMode, 'semantic');
  assert.equal(report.degraded, true);
  assert.match(report.lastError ?? '', /no vector/);
});

test('an unreachable embedding service degrades recall instead of failing the read', async () => {
  const app = new MemoryApplication({
    async health() { return { ready: true, version: '0.2.13', capabilities: ['health', 'recall'] }; },
    async recall() { return { memories: [] }; },
    async embeddingStatus() { return { serviceAvailable: false, modelAvailable: false, protocol: 'ollama', model: 'nomic-embed-text', embedded: 0, total: 3 }; },
  });
  const report = await app.embeddingDiagnostics();
  assert.equal(report.recallMode, 'keyword');
  assert.equal(report.degraded, true);
  assert.equal(report.lastError, 'embedding service unreachable');
});

test('a Provider without an embedding interface reports unknown, and a failed probe is a code', async () => {
  const bare = new MemoryApplication({
    async health() { return { ready: true, version: '0.2.13', capabilities: ['health', 'recall'] }; },
    async recall() { return { memories: [] }; },
  });
  const unknown = await bare.embeddingDiagnostics();
  assert.equal(unknown.recallMode, 'unknown');
  assert.equal(unknown.degraded, true);
  assert.match(unknown.lastError ?? '', /does not expose/);

  const failing = new MemoryApplication({
    async health() { return { ready: true, version: '0.2.13', capabilities: ['health', 'recall'] }; },
    async recall() { return { memories: [] }; },
    async embeddingStatus() { throw new MnemoWeaveError('PROVIDER_TIMEOUT'); },
  });
  const failed = await failing.embeddingDiagnostics();
  assert.equal(failed.recallMode, 'unknown');
  assert.equal(failed.lastError, 'PROVIDER_TIMEOUT');
});

test('recall covers the whole shared collection and takes no workspace', async () => {
  // One shared collection: every published memory is a candidate, whichever workspace the caller
  // was working in. There is no project or workspace parameter to filter by.
  const provider = {
    async health(): Promise<{ ready: true; version: '0.2.13'; capabilities: ['health'] }> { return { ready: true, version: '0.2.13', capabilities: ['health'] }; },
    async recall(req: { query: string; limit: number }) {
      // Mnemon's ranking always reports a score, so these rows carry one. Without it they would
      // land in the policy's unscored tier, which the strict policy bounds on purpose.
      return { memories: [
        { id: 'general-1', content: '通用经验', score: 0.8 },
        { id: 'alpha-1', content: '第一条共享结论', score: 0.75 },
        { id: 'beta-1', content: '第二条共享结论', score: 0.7 },
      ].slice(0, req.limit) };
    },
  };
  const published = new Set(['general-1', 'alpha-1', 'beta-1']);
  const catalog = {
    catalog: {
      visibleProviderIds: () => [...published],
      currentMemoryIds: (providerId: string) => (published.has(providerId) ? [`logical-${providerId}`] : []),
      get: () => ({ state: 'active' }),
      getConflict: () => { throw new Error('not used'); },
    },
  };
  const app = new MemoryApplication(provider, catalog as unknown as CandidateRepository);
  const all = await app.recall({ query: 'test', limit: 10 });
  assert.deepEqual(all.memories.map(memory => memory.id).sort(), ['alpha-1', 'beta-1', 'general-1']);
  for (const memory of all.memories) assert.equal(Object.hasOwn(memory, 'projectId'), false);
  // A workspace name is a recall cue appended to the query, not a parameter of the call.
  await assert.rejects(app.recall({ query: 'test', limit: 10, projectId: 'beta' }), (error: unknown) => error instanceof Error);
});


