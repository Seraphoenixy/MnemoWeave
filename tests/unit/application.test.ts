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
  return { catalog: { visibleProviderIds: () => visible, get: () => { throw new Error('not used'); }, getConflict: () => { throw new Error('not used'); } } };
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
