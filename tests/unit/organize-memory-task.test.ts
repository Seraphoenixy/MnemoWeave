import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOrganizeMemories, previewOrganizeMemories } from '../../plugins/dsh-mnemo-weave/src/ui/organize-memory-task.ts';

/**
 * 「整理记忆」 is a two-step flow: the task Agent proposes a plan, the user confirms individual
 * items, and only then are the confirmed writes executed. A plan never writes on its own, and a
 * withdrawal requires the user's instruction to name the exact memory id.
 */
function harness(answer: unknown) {
  const writes: Array<Record<string, unknown>> = [];
  const source = {
    explore: async () => ({ hits: [{ memoryId: MEMORY_ID, content: '串口 9600' }] }),
    memory: async () => ({ memoryId: 'memory-1', entryVersion: 4 }),
    archives: async () => [],
    create: async (input: Record<string, unknown>) => { writes.push({ kind: 'create', ...input }); return { memoryId: 'memory-2' }; },
    edit: async (input: Record<string, unknown>) => { writes.push({ kind: 'edit', ...input }); return { memoryId: 'memory-1', revisionId: 'rev-9' }; },
    withdraw: async (input: Record<string, unknown>) => { writes.push({ kind: 'withdraw', ...input }); return { memoryId: 'memory-1' }; },
  };
  const run = (async () => answer) as never;
  return { source, writes, run };
}

const MEMORY_ID = '11111111-1111-4111-8111-111111111111';

test('a preview plans operations against the shown versions and writes nothing', async () => {
  const h = harness({ operations: [
    { action: 'create', content: '新结论', reason: '用户要求' },
    { action: 'edit', targetId: MEMORY_ID, expectedVersion: 4, content: '串口固定 115200', reason: '更新' },
    { action: 'skip', reason: '证据不足' },
  ] });
  h.source.memory = async () => ({ memoryId: MEMORY_ID, entryVersion: 4 });
  const plan = await previewOrganizeMemories(h.source as never, h.run, { instruction: `修订 ${MEMORY_ID} 的串口结论` });
  assert.deepEqual(plan.items.map(item => item.action), ['create', 'edit', 'skip']);
  assert.equal(plan.items[1]!.targetId, MEMORY_ID);
  assert.equal(plan.items[1]!.entryVersion, 4);
  assert.equal(plan.items[1]!.before, '串口 9600');
  assert.equal(h.writes.length, 0, 'a preview performs no write');
});

test('only the confirmed items are executed, in plan order', async () => {
  const h = harness({ operations: [
    { action: 'create', content: '新结论', reason: '用户要求' },
    { action: 'edit', targetId: MEMORY_ID, expectedVersion: 4, content: '串口固定 115200', reason: '更新' },
  ] });
  h.source.memory = async () => ({ memoryId: MEMORY_ID, entryVersion: 4 });
  const plan = await previewOrganizeMemories(h.source as never, h.run, { instruction: `更新 ${MEMORY_ID}` });
  const result = await applyOrganizeMemories(h.source as never, plan, [1]);
  assert.deepEqual(result.items.map(item => item.state), ['skipped', 'applied']);
  assert.deepEqual(h.writes.map(write => write['kind']), ['edit']);
  assert.equal(h.writes[0]!['entryVersion'], 4);
});

test('a stale version is skipped with the re-run reason and never written', async () => {
  const h = harness({ operations: [{ action: 'edit', targetId: MEMORY_ID, expectedVersion: 3, content: '新正文', reason: '修订' }] });
  h.source.memory = async () => ({ memoryId: MEMORY_ID, entryVersion: 4 });
  const plan = await previewOrganizeMemories(h.source as never, h.run, { instruction: '修订' });
  assert.equal(plan.items[0]!.action, 'edit');
  assert.equal(plan.items[0]!.targetId, undefined);
  assert.match(plan.items[0]!.reason, /读取后已变化/);
  assert.equal(h.writes.length, 0);
});

test('a withdrawal is refused unless the instruction names that exact memory id', async () => {
  const reply = { operations: [{ action: 'withdraw', targetId: MEMORY_ID, expectedVersion: 4, reason: '过时' }] };
  const h = harness(reply);
  h.source.memory = async () => ({ memoryId: MEMORY_ID, entryVersion: 4 });
  const unnamed = await previewOrganizeMemories(h.source as never, h.run, { instruction: '删掉过时的串口结论' });
  assert.equal(unnamed.items[0]!.action, 'withdraw');
  assert.equal(unnamed.items[0]!.targetId, undefined, 'the withdrawal is offered without a target');
  await applyOrganizeMemories(h.source as never, unnamed, [0]);
  assert.equal(h.writes.length, 0);

  const named = await previewOrganizeMemories(h.source as never, h.run, { instruction: `撤回 ${MEMORY_ID}，它已过时` });
  assert.equal(named.items[0]!.targetId, MEMORY_ID);
  const result = await applyOrganizeMemories(h.source as never, named, [0]);
  assert.equal(result.items[0]!.state, 'applied');
  assert.equal(h.writes[0]!['kind'], 'withdraw');
});

test('a target that appears twice in one plan is only written once', async () => {
  const h = harness({ operations: [
    { action: 'edit', targetId: MEMORY_ID, expectedVersion: 4, content: '第一版', reason: 'a' },
    { action: 'edit', targetId: MEMORY_ID, expectedVersion: 4, content: '第二版', reason: 'b' },
  ] });
  h.source.memory = async () => ({ memoryId: MEMORY_ID, entryVersion: 4 });
  const plan = await previewOrganizeMemories(h.source as never, h.run, { instruction: '修订' });
  assert.notEqual(plan.items[0]!.targetId, undefined);
  assert.equal(plan.items[1]!.targetId, undefined);
  assert.match(plan.items[1]!.reason, /多次/);
});

test('an unsupported action or an oversized body is planned as a skip', async () => {
  const h = harness({ operations: [
    { action: 'delete', targetId: MEMORY_ID },
    { action: 'create', content: 'x'.repeat(8001) },
    { action: 'bogus' },
  ] });
  const plan = await previewOrganizeMemories(h.source as never, h.run, { instruction: '整理' });
  assert.deepEqual(plan.items.map(item => item.action), ['skip', 'skip', 'skip']);
  assert.equal(plan.items[1]!.content, undefined);
  await applyOrganizeMemories(h.source as never, plan, [0, 1, 2]);
  assert.equal(h.writes.length, 0);
});
