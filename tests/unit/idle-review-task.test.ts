import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runIdleReview } from '../../plugins/dsh-mnemo-weave/src/ui/idle-review-task.ts';

/**
 * Idle review is limited to one rule change and at most one new workspace archive per run. It
 * never writes a formal memory and never edits anything already stored.
 */
function harness(reply: () => unknown, options: { archives?: boolean } = {}) {
  const rules: Array<{ body: string }> = [];
  const archives: Array<Record<string, unknown>> = [];
  const memories: Array<Record<string, unknown>> = [];
  const items: Array<Record<string, unknown>> = [];
  /** Every authorized action the review submitted, keyed by its kind. */
  const submissions: Array<Record<string, unknown>> = [];
  const source = {
    startIdleReviewRun: async () => ({
      run: { id: 'run-1', sessionId: 's-1', state: 'running', attempt: 1, startedAt: 'x', finishedAt: null, error: null, items: [] },
      signals: [{ id: 'sig-1', sessionId: 's-1', turnId: 3, eventId: 'e-1', text: '必须使用 pnpm，而不是 npm', reason: 'standing-instruction', createdAt: 'x' }],
    }),
    archives: async () => (options.archives === false ? [] : [
      { entryId: 'archive-1', workspaceId: 'ws-1', title: '构建约定', body: '构建使用 pnpm', version: 2, source: 'user', verification: 'open', evidence: 'x', withdrawnAt: null, state: 'active', archivedAt: null, bodyBytes: 12 },
    ]),
    submitIdleReviewAction: async (_runId: string, _sessionId: string, action: Record<string, unknown>) => {
      submissions.push(action);
      if (action['kind'] === 'rule') { rules.push({ body: String(action['body']) }); return { status: 'applied', entryId: 'rule-1', entryVersion: 1 }; }
      archives.push(action);
      return { status: 'applied', entryId: 'archive-2', entryVersion: 1 };
    },
    create: async (input: Record<string, unknown>) => { memories.push(input); return { memoryId: 'memory-1' }; },
    recordIdleReviewItem: async (_runId: string, item: Record<string, unknown>) => { items.push(item); return { id: 'run-1', items: [] }; },
    finishIdleReviewRun: async (_runId: string, state: string) => ({ id: 'run-1', state, items: [] }),
  };
  return { source, rules, archives, memories, items, submissions, run: (async () => reply()) as never };
}

test('a task rule create is applied and recorded as one item', async () => {
  const h = harness(() => ({ action: 'rule', kind: 'create', body: '本项目统一使用 pnpm' }));
  const result = await runIdleReview(h.source as never, h.run, 's-1', 'ws-1');
  assert.equal(result.state, 'succeeded');
  assert.deepEqual(h.rules, [{ body: '本项目统一使用 pnpm' }]);
  // The review submits through the authorized task entry, never the resource route. The trigger
  // and run are added by the source layer, so the action itself carries only its own fields.
  assert.equal(h.submissions[0]!['kind'], 'rule');
  assert.equal(h.submissions[0]!['action'], 'create');
  assert.deepEqual(h.submissions[0]!['evidenceRefs'], ['e-1']);
  assert.equal(h.items.length, 1);
  assert.equal(h.items[0]!['state'], 'applied');
  assert.equal(h.items[0]!['kind'], 'rule');
  assert.equal(h.items[0]!['targetId'], 'rule-1');
  assert.equal(h.memories.length, 0);
});

test('a task archive create lands in the bound workspace and is recorded', async () => {
  const h = harness(() => ({ action: 'workspace-archive', kind: 'create', title: '串口约定', body: '串口固定 115200', evidence: '实测三次' }));
  const result = await runIdleReview(h.source as never, h.run, 's-1', 'ws-1');
  assert.equal(result.state, 'succeeded');
  // No workspace id is sent: the Server takes it from the session binding.
  assert.equal('workspaceId' in h.archives[0]!, false);
  assert.equal(h.archives[0]!['title'], '串口约定');
  assert.equal(h.archives[0]!['body'], '串口固定 115200');
  assert.equal(h.submissions[0]!['kind'], 'workspace-archive');
  assert.equal(h.items[0]!['state'], 'applied');
  assert.equal(h.items[0]!['kind'], 'workspace-archive');
  assert.equal(h.memories.length, 0);
});

test('an archive action without a bound workspace is skipped rather than guessed', async () => {
  const h = harness(() => ({ action: 'workspace-archive', kind: 'create', title: '串口约定', body: '串口固定 115200' }));
  const result = await runIdleReview(h.source as never, h.run, 's-1', undefined);
  assert.equal(result.state, 'succeeded');
  assert.equal(h.archives.length, 0);
  assert.equal(h.items[0]!['state'], 'skipped');
  assert.match(String((h.items[0]!['detail'] as Record<string, unknown>)['reason'] ?? ''), /工作区绑定/);
});

test('a skip writes nothing; an unfinished action fails the run so it is retried', async () => {
  const skipped = harness(() => ({ action: 'skip', reason: 'already recorded' }));
  const skippedResult = await runIdleReview(skipped.source as never, skipped.run, 's-1', 'ws-1');
  assert.equal(skippedResult.state, 'succeeded');
  assert.equal(skipped.rules.length + skipped.archives.length + skipped.memories.length, 0);
  assert.equal(skipped.items[0]!['state'], 'skipped');

  // A task that could not run leaves the action unfinished: the run reports failed, the Server
  // keeps that signal reserved for a retry, and nothing was written.
  const broken = harness(() => { throw new Error('model unavailable'); });
  const brokenResult = await runIdleReview(broken.source as never, broken.run, 's-1', 'ws-1');
  assert.equal(brokenResult.state, 'failed');
  assert.equal(broken.rules.length + broken.archives.length + broken.memories.length, 0);
  assert.equal(broken.items[0]!['state'], 'failed');
  assert.match(String((broken.items[0]!['detail'] as Record<string, unknown>)['reason'] ?? ''), /model unavailable/);
});

test('a rule edit or a formal-memory action is refused instead of being converted', async () => {
  for (const reply of [
    { action: 'rule', kind: 'edit', targetId: 'rule-1', body: '改过' },
    { action: 'create', kind: 'formal', body: '一条正式记忆' },
    { action: 'edit', targetId: 'memory-1', expectedVersion: 1, body: '已修订' },
  ]) {
    const h = harness(() => reply);
    const result = await runIdleReview(h.source as never, h.run, 's-1', 'ws-1');
    // A refused action is terminal: the run consumes the signal without converting it into a rule
    // or a formal memory, so a retry cannot ask for an action the review is never allowed.
    assert.equal(result.state, 'succeeded');
    assert.equal(h.rules.filter(item => (item as { body?: string }).body === '改过').length, 0);
    assert.equal(h.memories.length, 0);
    assert.notEqual(h.items[0]!['state'], 'applied', JSON.stringify(reply));
  }
});

test('a duplicate archive title in the workspace is skipped instead of added again', async () => {
  const h = harness(() => ({ action: 'workspace-archive', kind: 'create', title: '构建约定', body: '构建使用 pnpm', evidence: 'x' }));
  const result = await runIdleReview(h.source as never, h.run, 's-1', 'ws-1');
  assert.equal(result.state, 'succeeded');
  assert.equal(h.archives.length, 0);
  assert.equal(h.items[0]!['state'], 'skipped');
});

test('a cancelled run finishes as cancelled and does not continue', async () => {
  const h = harness(() => ({ action: 'skip', reason: 'nothing durable' }));
  const controller = new AbortController();
  controller.abort();
  const result = await runIdleReview(h.source as never, h.run, 's-1', 'ws-1', controller.signal);
  assert.equal(result.state, 'cancelled');
});
