import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewDistillation, confirmDistillation } from '../../plugins/dsh-mnemo-weave/src/ui/archive-distillation.ts';
import type { MemorySource } from '../../plugins/dsh-mnemo-weave/src/ui/memory-source.ts';

/**
 * 档案提炼 previews a draft and writes nothing until the user confirms. The draft fixes the source
 * version, so a source edited after the preview is refused by the Server, and the confirmation is
 * one write-task action keyed by the task the page minted.
 */

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ENTRY = '22222222-2222-4222-8222-222222222222';

function harness(answer: unknown, options: { body?: string } = {}) {
  const created: Array<Record<string, unknown>> = [];
  const writes: Array<{ taskId: string; index: number; action: Record<string, unknown> }> = [];
  const source = {
    archiveHistory: async () => [{
      revisionId: 'r-1', entryId: ENTRY, workspaceId: WORKSPACE, version: 3, title: '串口约定',
      body: options.body ?? '原始正文：9600 在长线缆上丢包，改为 115200 后稳定。本地路径 C:/work/port。',
      state: 'active', recordedAt: '2026-11-10T00:00:00.000Z',
    }],
    createDistillation: async (input: Record<string, unknown>) => {
      created.push(input);
      return { kind: 'draft' as const, draftId: '33333333-3333-4333-8333-333333333333', ...input, usedRange: { start: 0, end: 0, truncated: false } };
    },
    writeTask: async (taskId: string, index: number, action: Record<string, unknown>) => {
      writes.push({ taskId, index, action });
      return { kind: 'receipt' as const, taskId, index, status: 'published' as const, memoryId: 'm-1', entryVersion: 1 };
    },
  } as unknown as MemorySource;
  const run = (async () => answer) as never;
  return { source, created, writes, run };
}

test('a draft is created from the current version and nothing is published', async () => {
  const h = harness({ action: 'draft', content: '长线缆串口在 9600 波特率下会丢包，提到 115200 后稳定。', knowledgeType: 'Troubleshooting', category: 'decision', importance: 4, reason: '可复用的排查结论', assessment: 'supported' });
  const draft = await previewDistillation(h.source, h.run, ENTRY);
  assert.equal(draft.kind, 'draft');
  if (draft.kind !== 'draft') throw new Error('expected a draft');
  assert.equal(h.writes.length, 0, 'a preview never writes');
  assert.equal(h.created.length, 1);
  const written = h.created[0]!;
  assert.deepEqual(written['source'], {
    workspaceId: WORKSPACE, entryId: ENTRY, entryVersion: 3,
    // The hash is over the body that was actually read, so a later edit cannot match it.
    contentHash: (written['source'] as { contentHash: string }).contentHash,
  });
  assert.equal((written['source'] as { contentHash: string }).contentHash.length, 64);
  assert.equal(written['knowledgeType'], 'Troubleshooting');
  assert.equal(written['importance'], 4);
  assert.equal(draft.usedRange.truncated, false);
});

test('a task that declines returns a skip with its reason and creates no draft', async () => {
  const h = harness({ action: 'skip', reason: '只有本仓库路径，没有可复用结论。' });
  const result = await previewDistillation(h.source, h.run, ENTRY);
  assert.equal(result.kind, 'skip');
  if (result.kind !== 'skip') throw new Error('expected a skip');
  assert.match(result.reason, /可复用/);
  assert.equal(h.created.length, 0);
});

test('an unusable draft body is a skip rather than a stored draft', async () => {
  const tooLong = harness({ action: 'draft', content: 'x'.repeat(8001), knowledgeType: 'Practice' });
  assert.equal((await previewDistillation(tooLong.source, tooLong.run, ENTRY)).kind, 'skip');
  assert.equal(tooLong.created.length, 0);
  const blank = harness({ action: 'draft', content: '   ', knowledgeType: 'Practice' });
  assert.equal((await previewDistillation(blank.source, blank.run, ENTRY)).kind, 'skip');
  assert.equal(blank.created.length, 0);
});

test('an unknown knowledge type falls back to Practice instead of being stored verbatim', async () => {
  const h = harness({ action: 'draft', content: '可复用的结论。', knowledgeType: 'Nonsense', category: 'bogus', importance: 9 });
  await previewDistillation(h.source, h.run, ENTRY);
  assert.equal(h.created[0]!['knowledgeType'], 'Practice');
  assert.equal('category' in h.created[0]!, false);
  assert.equal('importance' in h.created[0]!, false);
});

test('a long archive reports the range actually used', async () => {
  const h = harness({ action: 'draft', content: '可复用的结论。', knowledgeType: 'Practice' }, { body: 'x'.repeat(20_000) });
  const draft = await previewDistillation(h.source, h.run, ENTRY);
  if (draft.kind !== 'draft') throw new Error('expected a draft');
  assert.equal(draft.usedRange.truncated, true);
  assert.ok(draft.usedRange.end <= 12_000, 'a single archive never exceeds its evidence budget');
  assert.equal(draft.usedRange.start, 0);
});

test('a confirmation is one write-task action whose task is the draft itself', async () => {
  const h = harness({ action: 'skip', reason: 'unused' });
  const result = await confirmDistillation(h.source, { draftId: '33333333-3333-4333-8333-333333333333', reason: '用户确认从档案提炼' });
  assert.equal(result.status, 'published');
  assert.equal(h.writes.length, 1);
  const write = h.writes[0]!;
  assert.equal(write.taskId, '33333333-3333-4333-8333-333333333333');
  assert.equal(write.index, 0);
  assert.equal(write.action['kind'], 'formal-memory');
  assert.equal(write.action['trigger'], 'archive-distill');
  assert.equal(write.action['action'], 'create');
  assert.equal(write.action['draftId'], '33333333-3333-4333-8333-333333333333');
  assert.deepEqual(write.action['evidenceRefs'], ['confirm:33333333-3333-4333-8333-333333333333']);
});
