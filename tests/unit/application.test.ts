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
      get: () => { throw new Error('not used'); },
      getConflict: () => { throw new Error('not used'); },
    },
  };
}

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

test('recall returns general memory plus the requested project, and only general without one', async () => {
  const provider = {
    async health(): Promise<{ ready: true; version: '0.2.13'; capabilities: ['health'] }> { return { ready: true, version: '0.2.13', capabilities: ['health'] }; },
    async recall(req: { query: string; limit: number }) {
      return { memories: [
        { id: 'general-1', content: '通用经验' },
        { id: 'alpha-1', content: '甲项目结论' },
        { id: 'beta-1', content: '乙项目结论' },
      ].slice(0, req.limit) };
    },
  };
  const owners: Record<string, string | null> = { 'general-1': null, 'alpha-1': 'alpha', 'beta-1': 'beta' };
  const catalog = {
    catalog: {
      visibleProviderIds: () => ['general-1', 'alpha-1', 'beta-1'],
      currentMemoryIds: (providerId: string) => (providerId in owners ? [`logical-${providerId}`] : []),
      memoryProject: (memoryId: string) => owners[memoryId.replace('logical-', '')] ?? null,
      get: () => { throw new Error('not used'); },
      getConflict: () => { throw new Error('not used'); },
    },
  };
  const app = new MemoryApplication(provider, catalog as unknown as CandidateRepository);
  const alpha = await app.recall({ query: 'test', limit: 10, projectId: 'alpha' });
  assert.deepEqual(alpha.memories.map(memory => memory.id).sort(), ['alpha-1', 'general-1']);
  assert.equal(alpha.memories.find(memory => memory.id === 'alpha-1')?.projectId, 'alpha');
  const general = await app.recall({ query: 'test', limit: 10 });
  assert.deepEqual(general.memories.map(memory => memory.id), ['general-1']);
  assert.equal(general.memories[0]?.projectId, null);
  // Naming a project is not authorization: a grant that does not cover it is refused.
  const grant = {
    grantId: '00000000-0000-4000-8000-000000000001', hostId: 'h', projects: ['alpha'], globalIncluded: true,
    issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', generation: 0,
  };
  await assert.rejects(app.recall({ query: 'test', limit: 10, projectId: 'beta' }, grant), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'SCOPE_FORBIDDEN');
});

test('a recall result from another project is not returned to a foreign session', async () => {
  const provider = {
    async health(): Promise<{ ready: true; version: '0.2.13'; capabilities: ['health'] }> { return { ready: true, version: '0.2.13', capabilities: ['health'] }; },
    async recall(req: { query: string; limit: number }) { return { memories: [{ id: 'beta-1', content: '乙项目结论' }].slice(0, req.limit) }; },
  };
  const catalog = {
    catalog: {
      visibleProviderIds: () => ['beta-1'],
      currentMemoryIds: (providerId: string) => (providerId === 'beta-1' ? ['logical-beta'] : []),
      memoryProject: () => 'beta',
      get: () => { throw new Error('not used'); },
      getConflict: () => { throw new Error('not used'); },
    },
  };
  const app = new MemoryApplication(provider, catalog as unknown as CandidateRepository);
  assert.deepEqual((await app.recall({ query: 'test', limit: 10, projectId: 'alpha' })).memories, []);
});
