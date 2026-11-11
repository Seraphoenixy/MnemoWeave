import { test } from 'node:test';
import assert from 'node:assert/strict';
import { organizeMemories } from '../../plugins/dsh-mnemo-weave/src/ui/organize-memory-task.ts';

function harness(answer: unknown) {
  const writes: Array<Record<string, unknown>> = [];
  const source = {
    explore: async () => ({ hits: [{ memoryId: 'memory-1', content: '串口 9600', projectId: 'alpha' }] }),
    memory: async () => ({ memoryId: 'memory-1', entryVersion: 4, projectId: 'alpha' }),
    archives: async () => [],
    create: async (input: Record<string, unknown>) => { writes.push({ kind: 'create', ...input }); return { memoryId: 'memory-2' }; },
    edit: async (input: Record<string, unknown>) => { writes.push({ kind: 'edit', ...input }); return { memoryId: 'memory-1', revisionId: 'rev-9' }; },
    withdraw: async (input: Record<string, unknown>) => { writes.push({ kind: 'withdraw', ...input }); return { memoryId: 'memory-1' }; },
  };
  const run = (async () => answer) as never;
  return { source, writes, run };
}

test('a user instruction applies create, edit and withdraw only on shown candidates', async () => {
  const h = harness({ operations: [
    { action: 'create', body: '新结论' },
    { action: 'edit', targetId: 'memory-1', expectedVersion: 4, body: '串口固定 115200' },
    { action: 'withdraw', targetId: 'memory-1', expectedVersion: 4, reason: '过时' },
    { action: 'withdraw', targetId: 'forged', expectedVersion: 1, reason: 'x' },
    { action: 'skip', reason: '证据不足' },
  ] });
  const result = await organizeMemories(h.source as never, h.run, { instruction: '把串口结论合并，保留现在生效的版本', projectId: 'alpha' });
  assert.deepEqual(result.items.map(item => item.state), ['applied', 'applied', 'applied', 'skipped', 'skipped']);
  assert.deepEqual(h.writes.map(write => write['kind']), ['create', 'edit', 'withdraw']);
  assert.equal(h.writes[0]!['projectId'], 'alpha');
  assert.equal(h.writes[1]!['entryVersion'], 4);
  assert.equal(result.items[1]!['detail']!['before'], '串口 9600');
});

test('a stale version is skipped with the re-run reason and never written', async () => {
  const h = harness({ operations: [{ action: 'edit', targetId: 'memory-1', expectedVersion: 3, body: '新正文' }] });
  const result = await organizeMemories(h.source as never, h.run, { instruction: '修订', projectId: 'alpha' });
  assert.equal(result.items[0]!.state, 'skipped');
  assert.match(String(result.items[0]!.detail!['reason']), /changed after it was read/);
  assert.equal(h.writes.length, 0);
});

test('without a project the task only offers general memories', async () => {
  const h = harness({ operations: [] });
  h.source.explore = async () => ({ hits: [{ memoryId: 'p-1', content: '项目事实', projectId: 'alpha' }] });
  const result = await organizeMemories(h.source as never, h.run, { instruction: '整理通用经验' });
  assert.deepEqual(result.items, []);
  assert.equal(h.writes.length, 0);
});
