import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTaskRunner } from '../../plugins/dsh-mnemo-weave/src/ui/task-runner.ts';
import { organizeMemory } from '../../plugins/dsh-mnemo-weave/src/ui/organize-memory.ts';
import type { MemorySource } from '../../plugins/dsh-mnemo-weave/src/ui/memory-source.ts';

test('a user task only publishes a new record with a supported kind', async () => {
  const writes: unknown[] = [];
  const source = {
    explore: async () => ({ hits: [{ content: 'An existing memory' }] }),
    rules: async () => [{ body: 'Existing rule' }],
    archives: async () => [{ projectId: 'private', body: 'Other project archive' }],
    create: async (input: unknown) => { writes.push(input); return { memoryId: 'formal' }; },
    createRule: async (input: unknown) => { writes.push(input); return { entryId: 'rule' }; },
    saveArchive: async (input: unknown) => { writes.push(input); return { entryId: 'archive' }; },
  } as unknown as MemorySource;
  const input = { content: 'A new fact', knowledgeType: 'Practice', projectId: 'alpha' } as const;
  assert.deepEqual(await organizeMemory(source, async prompt => {
    // Archives are still project-scoped: another project's reference material is not offered.
    assert.doesNotMatch(prompt, /Other project archive/);
    assert.match(prompt, /Existing rule/);
    return { action: 'create', kind: 'runtime', body: 'A new rule' };
  }, input), { kind: 'runtime', entryId: 'rule' });
  assert.deepEqual(writes, [{ body: 'A new rule' }]);
  assert.deepEqual(await organizeMemory(source, async () => ({ action: 'create', kind: 'formal', body: 'Existing rule' }), input), { kind: 'duplicate' });
  assert.deepEqual(await organizeMemory(source, async () => ({ action: 'review', reason: 'Contradictory' }), input), { kind: 'review', reason: 'Contradictory' });
  // An archive needs a project, so the task cannot create one without one.
  await assert.rejects(organizeMemory(source, async () => ({ action: 'create', kind: 'archive', body: 'X', title: 'X' }), { content: 'No project', knowledgeType: 'Practice' }));
  assert.equal(writes.length, 1);
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
