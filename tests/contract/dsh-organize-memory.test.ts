import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTaskRunner } from '../../plugins/dsh-mnemo-weave/src/ui/task-runner.ts';
import { organizeMemory } from '../../plugins/dsh-mnemo-weave/src/ui/organize-memory.ts';
import type { MemorySource } from '../../plugins/dsh-mnemo-weave/src/ui/memory-source.ts';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';

/**
 * 「整理记忆」 asks a restricted task Agent to tidy text the user chose to save. The task only ever
 * proposes one create in the class the user picked; it never edits, deletes or reclassifies.
 */
test('a user task only publishes a new record in the class the user selected', async () => {
  const writes: unknown[] = [];
  const source = {
    explore: async () => ({ hits: [{ memoryId: 'm-1', content: 'An existing memory' }] }),
    rules: async () => [{ entryId: 'r-1', body: 'Existing rule', enabled: true, version: 1, withdrawnAt: null }],
    archives: async () => [{ entryId: 'a-1', workspaceId: WORKSPACE, title: 't', body: 'Other workspace archive', state: 'active', version: 1 }],
    create: async (input: unknown) => { writes.push(input); return { memoryId: 'formal' }; },
    createRule: async (input: unknown) => { writes.push(input); return { entryId: 'rule' }; },
    saveArchive: async (input: unknown) => { writes.push(input); return { entryId: 'archive' }; },
  } as unknown as MemorySource;
  const input = { content: 'A new fact', knowledgeType: 'Practice', target: 'rule' as const };

  // A rule target offers the resident rules as reference and writes only a rule.
  assert.deepEqual(await organizeMemory(source, async prompt => {
    assert.match(prompt, /Existing rule/);
    // A different workspace's archive is never offered as reference material.
    assert.doesNotMatch(prompt, /Other workspace archive/);
    return { action: 'create', body: 'A new rule' };
  }, input), { kind: 'rule', entryId: 'rule' });
  assert.deepEqual(writes, [{ body: 'A new rule' }]);

  // A body that already exists verbatim is a duplicate, not a second row.
  assert.deepEqual(await organizeMemory(source, async () => ({ action: 'create', body: 'Existing rule' }), input), { kind: 'duplicate' });
  assert.deepEqual(await organizeMemory(source, async () => ({ action: 'review', reason: 'Contradictory' }), input), { kind: 'review', reason: 'Contradictory' });

  // An archive needs a bound workspace; without one the task is refused rather than guessed.
  await assert.rejects(organizeMemory(source, async () => ({ action: 'create', body: 'X', title: 'X' }), { content: 'No workspace', knowledgeType: 'Practice', target: 'workspace-archive' }));
  assert.equal(writes.length, 1);
});

test('the formal-memory target writes only a formal memory and carries no workspace', async () => {
  const writes: Array<Record<string, unknown>> = [];
  const source = {
    explore: async () => ({ hits: [] }),
    rules: async () => [],
    archives: async () => [],
    create: async (input: Record<string, unknown>) => { writes.push(input); return { memoryId: 'formal' }; },
  } as unknown as MemorySource;
  assert.deepEqual(
    await organizeMemory(source, async () => ({ action: 'create', body: '整理后的正文' }), { content: '原文', knowledgeType: 'Practice' }),
    { kind: 'formal', entryId: 'formal' },
  );
  assert.deepEqual(writes, [{ content: '整理后的正文', knowledgeType: 'Practice' }]);
  assert.equal('workspaceId' in writes[0]!, false, 'a formal memory carries no workspace');
});

test('the task Agent runs after restricting tools and releases its session', async () => {
  const steps: string[] = [];
  const session = {};
  const run = createTaskRunner(() => ({
    roots: () => [{ id: 'conversation', options: { provider: 'fixture', model: 'fixture' }, session: { header: { cwd: process.cwd() } } }],
    create: async (input: { setup(ctx: unknown): void }) => {
      let listener: (session: unknown, event: unknown) => void = () => {};
      const ctx = {
        tools: { restrict: (filter: unknown) => { assert.deepEqual(filter, { allow: [] }); steps.push('restrict'); } },
        on: (_name: string, next: typeof listener) => { listener = next; return () => steps.push('detach'); },
      };
      input.setup(ctx);
      return {
        agent: { session, ctx, followup() {
          steps.push('followup');
          listener(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"ok":true}' }] } } });
          listener(session, { type: 'turn/end', data: {} });
        } },
        dispose: async () => { steps.push('dispose'); },
      };
    },
  }));
  assert.deepEqual(await run('test'), { ok: true });
  assert.deepEqual(steps, ['restrict', 'followup', 'detach', 'dispose']);
});
