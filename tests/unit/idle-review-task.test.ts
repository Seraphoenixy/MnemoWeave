import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runIdleReview } from '../../plugins/dsh-mnemo-weave/src/ui/idle-review-task.ts';

function harness(reply: () => unknown) {
  const created: Array<{ content: string; projectId?: string }> = [];
  const items: Array<Record<string, unknown>> = [];
  const source = {
    startIdleReviewRun: async () => ({
      run: { id: 'run-1', sessionId: 's-1', state: 'running', attempt: 1, startedAt: 'x', finishedAt: null, error: null, items: [] },
      signals: [{ id: 'sig-1', sessionId: 's-1', turnId: 3, eventId: 'e-1', text: '必须使用 pnpm，而不是 npm', projectId: 'alpha', reason: 'standing-instruction', createdAt: 'x' }],
    }),
    explore: async () => ({ hits: [] }),
    create: async (input: { content: string; projectId?: string }) => { created.push(input); return { memoryId: 'memory-1' }; },
    recordIdleReviewItem: async (_runId: string, item: Record<string, unknown>) => { items.push(item); return { id: 'run-1', items: [] }; },
    finishIdleReviewRun: async (_runId: string, state: string) => ({ id: 'run-1', state, items: [] }),
  };
  return { source, created, items, run: (async () => reply()) as never };
}

test('a task create is applied within the signal project and recorded as one item', async () => {
  const h = harness(() => ({ action: 'create', kind: 'formal', body: '项目统一使用 pnpm' }));
  const result = await runIdleReview(h.source as never, h.run, 's-1');
  assert.equal(result.state, 'succeeded');
  assert.deepEqual(h.created, [{ content: '项目统一使用 pnpm', knowledgeType: 'Practice', projectId: 'alpha' }]);
  assert.equal(h.items.length, 1);
  assert.equal(h.items[0]!['state'], 'applied');
  assert.equal(h.items[0]!['targetId'], 'memory-1');
});

test('a skip writes nothing, and a failed task records the reason without failing the run', async () => {
  const skipped = harness(() => ({ action: 'skip', reason: 'already recorded' }));
  const skippedResult = await runIdleReview(skipped.source as never, skipped.run, 's-1');
  assert.equal(skippedResult.state, 'succeeded');
  assert.equal(skipped.created.length, 0);
  assert.equal(skipped.items[0]!['state'], 'skipped');

  const broken = harness(() => { throw new Error('model unavailable'); });
  const brokenResult = await runIdleReview(broken.source as never, broken.run, 's-1');
  assert.equal(brokenResult.state, 'succeeded');
  assert.equal(broken.created.length, 0);
  assert.equal(broken.items[0]!['state'], 'failed');
  assert.match(String((broken.items[0]!['detail'] as Record<string, unknown>)['reason'] ?? ''), /model unavailable/);
});

test('an unsupported edit without a shown candidate is skipped instead of guessing a version', async () => {
  const h = harness(() => ({ action: 'edit', targetId: 'memory-1', expectedVersion: 1, body: '已修订' }));
  const result = await runIdleReview(h.source as never, h.run, 's-1');
  assert.equal(result.state, 'succeeded');
  assert.equal(h.created.length, 0);
  assert.equal(h.items[0]!['state'], 'skipped');
  assert.match(String((h.items[0]!['detail'] as Record<string, unknown>)['reason'] ?? ''), /not one of the supplied/);
});

test('an explicit correction revises the shown version and records the revision', async () => {
  const edited: Array<Record<string, unknown>> = [];
  const items: Array<Record<string, unknown>> = [];
  const source = {
    startIdleReviewRun: async () => ({
      run: { id: 'run-2', sessionId: 's-2', state: 'running', attempt: 1, startedAt: 'x', finishedAt: null, error: null, items: [] },
      signals: [{ id: 'sig-2', sessionId: 's-2', turnId: 4, eventId: 'e-2', text: '不对，串口应该是 115200 而不是 9600', projectId: 'alpha', reason: 'correction', createdAt: 'x' }],
    }),
    explore: async () => ({ hits: [{ memoryId: 'memory-9', content: '串口 9600', projectId: 'alpha' }] }),
    memory: async () => ({ memoryId: 'memory-9', entryVersion: 7, projectId: 'alpha' }),
    create: async () => ({ memoryId: 'unused' }),
    edit: async (input: Record<string, unknown>) => { edited.push(input); return { memoryId: 'memory-9', revisionId: 'rev-1' }; },
    recordIdleReviewItem: async (_runId: string, item: Record<string, unknown>) => { items.push(item); return { id: 'run-2', items: [] }; },
    finishIdleReviewRun: async (_runId: string, state: string) => ({ id: 'run-2', state, items: [] }),
  };
  const run = (async () => ({ action: 'edit', targetId: 'memory-9', expectedVersion: 7, body: '串口固定 115200' })) as never;
  const result = await runIdleReview(source as never, run, 's-2');
  assert.equal(result.state, 'succeeded');
  assert.deepEqual(edited, [{ memoryId: 'memory-9', content: '串口固定 115200', entryVersion: 7, reason: 'Idle review: explicit user correction.' }]);
  assert.equal(items[0]!['state'], 'applied');
  assert.deepEqual(items[0]!['detail'], { revisionId: 'rev-1' });
});
