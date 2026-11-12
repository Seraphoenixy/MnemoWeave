import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MnemoWeaveError } from '../../packages/core/contracts/src/index.ts';
import {
  ARCHIVE_SEGMENT_CHARS, ARCHIVE_SEARCH_MAX_CALLS, MODEL_RECALL_FIRST_LIMIT, MODEL_RECALL_ITEM_CHARS,
  MODEL_RECALL_TOTAL_CHARS, MODEL_RECALL_TOTAL_LIMIT, MODEL_RELATED_LIMIT, MODEL_RELATED_TOTAL_CHARS,
} from '../../packages/core/contracts/src/index.ts';
import {
  TRIGGER_ACTIONS, TRIGGER_MAX_ACTIONS, TurnBudget, TurnBudgetRegistry, assertTriggerAllows, clipChars, segmentCursorToken,
} from '../../packages/core/application/src/turn-budget.ts';

/**
 * The per-turn model budget is the only thing between a model and the whole store, so its edges
 * are contract. Identities are never model arguments: the Server builds the key from the turn the
 * Host vouched for.
 */

const KEY = { hostId: 'host-a', sessionId: 's-1', agentId: 'default', turnId: '7' };
const memory = (id: string, length = 10, relevance?: 'high' | 'medium' | 'low' | 'unknown') => ({
  id, content: 'x'.repeat(length), ...(relevance === undefined ? {} : { relevance }),
});

test('clipping never splits a surrogate pair and reports whether it clipped', () => {
  assert.deepEqual(clipChars('abc', 10), { text: 'abc', truncated: false });
  assert.deepEqual(clipChars('abcdef', 3), { text: 'abc', truncated: true });
  // An emoji is two code units; a budget that lands in the middle keeps the pair whole.
  const emoji = '😀😀😀';
  assert.equal(emoji.length, 6);
  assert.equal(clipChars(emoji, 3).text, '😀');
  assert.equal(clipChars(emoji, 3).truncated, true);
  assert.deepEqual(clipChars('', 5), { text: '', truncated: false });
});

test('the first query gets 4 entries and the second uses the remainder', () => {
  const budget = new TurnBudget(KEY);
  // High relevance is what a model gets for a good match; without a bucket an entry is unknown
  // and only one of those may be delivered per turn.
  const first = budget.acceptRecall('q1', [memory('a', 10, 'high'), memory('b', 10, 'high'), memory('c', 10, 'high'), memory('d', 10, 'high'), memory('e', 10, 'high')]);
  assert.equal(first.memories.length, MODEL_RECALL_FIRST_LIMIT);
  assert.equal(first.truncated, true, 'one more entry existed than the first query may take');
  const second = budget.acceptRecall('q2', [memory('f', 10, 'high'), memory('g', 10, 'high')]);
  assert.equal(second.memories.length, MODEL_RECALL_TOTAL_LIMIT - MODEL_RECALL_FIRST_LIMIT);
  // A third distinct query is refused rather than trimmed: the model must know it is out.
  assert.throws(() => budget.acceptRecall('q3', [memory('h')]), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'TURN_BUDGET_EXCEEDED');
});

test('repeating a query replays the earlier answer without a second query slot', () => {
  const budget = new TurnBudget(KEY);
  const first = budget.acceptRecall('q1', [memory('a'), memory('b')]);
  const replay = budget.acceptRecall('q1', [memory('a'), memory('b')]);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.memories.map(item => item.id), first.memories.map(item => item.id));
  // The replay did not consume the second slot: a different query still works.
  assert.equal(budget.acceptRecall('q2', [memory('c')]).memories.length, 1);
});

test('an entry already delivered is never delivered twice, and total characters are bounded', () => {
  const budget = new TurnBudget(KEY);
  budget.acceptRecall('q1', [memory('a', 100), memory('b', 100)]);
  const second = budget.acceptRecall('q2', [memory('a', 100), memory('c', 100)]);
  assert.deepEqual(second.memories.map(item => item.id), ['c']);
  // The turn total is 4,800 code units; a single entry is capped at 1,200.
  const wide = new TurnBudget(KEY);
  const big = wide.acceptRecall('q1', [memory('x', MODEL_RECALL_ITEM_CHARS * 5)]);
  assert.equal(big.memories[0]!.content.length, MODEL_RECALL_ITEM_CHARS);
  assert.equal(big.memories[0]!.excerpt, true);
  assert.equal(MODEL_RECALL_TOTAL_CHARS, 4_800);
});

test('low relevance is dropped and medium and unknown each contribute one entry', () => {
  const budget = new TurnBudget(KEY);
  const answer = budget.acceptRecall('q1', [
    memory('low', 10, 'low'),
    memory('m1', 10, 'medium'), memory('m2', 10, 'medium'),
    memory('u1', 10, 'unknown'), memory('u2', 10, 'unknown'),
    memory('h1', 10, 'high'), memory('h2', 10, 'high'),
  ]);
  assert.deepEqual(answer.memories.map(item => item.id), ['m1', 'u1', 'h1', 'h2']);
});

test('relations expand once per turn from a memory already delivered', () => {
  const budget = new TurnBudget(KEY);
  budget.acceptRecall('q1', [memory('a', 10, 'high'), memory('b', 10, 'high')]);
  // A start the model invented is not expanded.
  assert.throws(() => budget.acceptRelated('invented', [memory('c')]), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'INVALID_INPUT');
  const answer = budget.acceptRelated('a', [memory('b'), memory('c'), memory('d'), memory('e'), memory('f'), memory('g')]);
  assert.ok(answer.memories.length <= MODEL_RELATED_LIMIT);
  assert.equal(answer.memories.some(item => item.id === 'b'), false, 'a memory already delivered is not repeated');
  assert.ok(answer.memories.reduce((sum, item) => sum + item.content.length, 0) <= MODEL_RELATED_TOTAL_CHARS);
  // One expansion per turn.
  assert.throws(() => budget.acceptRelated('a', [memory('h')]), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'TURN_BUDGET_EXCEEDED');
});

test('the archive tool shares four calls between search and segments', () => {
  const budget = new TurnBudget(KEY);
  for (let index = 0; index < ARCHIVE_SEARCH_MAX_CALLS; index += 1) budget.takeArchiveCall();
  assert.throws(() => budget.takeArchiveCall(), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'TURN_BUDGET_EXCEEDED');
  assert.equal(ARCHIVE_SEARCH_MAX_CALLS, 4);
});

test('one full body read is allowed per turn, and only of a memory this turn delivered', () => {
  const budget = new TurnBudget(KEY);
  budget.acceptRecall('q1', [memory('a', 20)]);
  // A memory the model did not see this turn cannot be read in full.
  assert.throws(() => budget.takeBodyRead('invented', 'body'), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'INVALID_INPUT');
  assert.deepEqual(budget.takeBodyRead('a', 'body'), { content: 'body', excerpt: false });
  assert.throws(() => budget.takeBodyRead('a', 'body'), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'TURN_BUDGET_EXCEEDED');
  // The stored ceiling is 8,000 UTF-8 bytes; an over-long body is trimmed on a character boundary.
  const wide = new TurnBudget(KEY);
  wide.acceptRecall('q1', [memory('b', 20)]);
  const clipped = wide.takeBodyRead('b', '界'.repeat(3000));
  assert.equal(clipped.excerpt, true);
  assert.ok(Buffer.byteLength(clipped.content, 'utf8') <= 8_000);
  assert.equal(clipped.content.includes('\uFFFD'), false);
});

test('budgets are per Host, session, agent and turn, and a different key starts fresh', () => {
  const registry = new TurnBudgetRegistry();
  const first = registry.for(KEY);
  first.acceptRecall('q1', [memory('a', 10)]);
  first.takeBodyRead('a', 'body');
  assert.equal(registry.for({ ...KEY }).bodyRead, true, 'the same identity reaches the same budget');
  for (const key of [
    { ...KEY, hostId: 'host-b' },
    { ...KEY, sessionId: 's-2' },
    { ...KEY, agentId: 'sub' },
    { ...KEY, turnId: '8' },
  ]) {
    assert.equal(registry.for(key).bodyRead, false, JSON.stringify(key));
  }
});

test('the registry is bounded and evicts the oldest turn instead of growing without limit', () => {
  const registry = new TurnBudgetRegistry(2);
  registry.for({ ...KEY, turnId: '1' });
  registry.for({ ...KEY, turnId: '2' });
  assert.equal(registry.size(), 2);
  registry.for({ ...KEY, turnId: '3' });
  assert.equal(registry.size(), 2, 'the cap holds');
  // An evicted turn starts over rather than throwing.
  assert.equal(registry.for({ ...KEY, turnId: '1' }).bodyRead, false);
  // Releasing a turn the registry no longer holds is a no-op, not a leak.
  registry.release({ ...KEY, turnId: '3' });
  assert.ok(registry.size() <= 2);
});

test('a segment cursor token is opaque and bound to the parts it was minted from', () => {
  const parts = ['host-a', 's-1', 'e-1', 'w-1', '3'];
  const token = segmentCursorToken(parts);
  assert.equal(typeof token, 'string');
  assert.equal(token.includes('w-1'), false, 'the cursor carries no readable identifier');
  // A cursor minted for one binding does not repeat for another.
  assert.notEqual(segmentCursorToken([...parts, '0']), token);
  assert.notEqual(segmentCursorToken(['host-b', 's-1', 'e-1', 'w-1', '3']), segmentCursorToken(parts));
  assert.equal(ARCHIVE_SEGMENT_CHARS, 6_000);
});

test('each trigger allows only the actions the contract gives it', () => {
  // A conversation may correct or withdraw; a reply save may only add.
  assertTriggerAllows('conversation', 'withdraw');
  assertTriggerAllows('reply-save', 'create');
  assert.throws(() => assertTriggerAllows('reply-save', 'edit'), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'SCOPE_FORBIDDEN');
  assert.throws(() => assertTriggerAllows('reply-save', 'withdraw'), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'SCOPE_FORBIDDEN');
  // The organizer may withdraw, the archive distillation only creates.
  assertTriggerAllows('organize', 'withdraw');
  assert.throws(() => assertTriggerAllows('archive-distill', 'skip'), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'SCOPE_FORBIDDEN');
  // An idle review may change a rule, and never writes a formal memory.
  assertTriggerAllows('idle-review', 'edit');
  assertTriggerAllows('idle-review', 'remove');
  assert.throws(() => assertTriggerAllows('idle-review', 'withdraw'), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'SCOPE_FORBIDDEN');
  // An unknown trigger is invalid input, not a permissive default.
  assert.throws(() => assertTriggerAllows('invented', 'create'), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'INVALID_INPUT');
  // The per-trigger action ceiling is what limits one task.
  assert.equal(TRIGGER_MAX_ACTIONS['conversation'], 1);
  assert.equal(TRIGGER_MAX_ACTIONS['organize'], 8);
  assert.equal(TRIGGER_MAX_ACTIONS['archive-distill'], 1);
  // The idle review's two changes are one rule change and one archive create.
  assert.equal(TRIGGER_MAX_ACTIONS['idle-review'], 2);
  assert.equal(Object.keys(TRIGGER_ACTIONS).length, 5);
});
