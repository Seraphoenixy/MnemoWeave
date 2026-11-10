import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MnemoWeaveError, SyncChangeInput, SyncPullPage } from '../../packages/core/contracts/src/index.ts';
import type { SyncChangeRecordValue, SyncEntryDraftValue, SyncPullPageValue } from '../../packages/core/contracts/src/index.ts';
import { advanceCursor, assertEntryVersion, buildChange, buildEditChange, classifySubmitFailure, draftFromEntry, plainContent, planPull } from '../../packages/core/application/src/sync.ts';

const ENTRY = '11111111-1111-4111-8111-111111111111';
const CHANGE = '22222222-2222-4222-8222-222222222222';

function draft(): SyncEntryDraftValue {
  return {
    entryId: ENTRY,
    kind: 'runtime',
    scope: 'project:alpha',
    content: plainContent('提交前必须运行类型检查。'),
    payload: { enabled: true },
    withdrawnAt: null,
  };
}

function record(seq: number): SyncChangeRecordValue {
  return {
    changeId: CHANGE,
    entryId: ENTRY,
    scope: 'project:alpha',
    version: seq,
    seq,
    operation: 'update',
    entry: { ...draft(), version: seq, withdrawnAt: null },
    deviceId: 'device-a',
    recordedAt: '2026-11-10T03:00:00Z',
  };
}

function page(seqs: readonly number[], overrides: Partial<SyncPullPageValue> = {}): SyncPullPageValue {
  return { scope: 'project:alpha', changes: seqs.map(record), nextSince: seqs.at(-1) ?? 0, hasMore: false, retentionFloor: seqs[0] ?? 0, ...overrides };
}

test('plain content carries the hash and byte length the remote checks', () => {
  const content = plainContent('准则');
  assert.equal(content.format, 'plain');
  assert.equal(content.byteLength, 6);
  assert.match(content.contentHash, /^[a-f0-9]{64}$/);
  assert.throws(() => plainContent(''), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'INVALID_INPUT');
  assert.throws(() => plainContent('x'.repeat(8001)), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'INVALID_INPUT');
});

test('create starts from base 0 and update/delete need a real base', () => {
  assert.equal(buildChange({ changeId: CHANGE, baseVersion: 0, operation: 'create', entry: draft() }).baseVersion, 0);
  for (const [operation, baseVersion] of [['create', 3], ['update', 0], ['delete', 0]] as const) {
    assert.throws(
      () => buildChange({ changeId: CHANGE, baseVersion, operation, entry: draft() }),
      (error: unknown) => error instanceof MnemoWeaveError && error.code === 'INVALID_INPUT',
    );
  }
});

test('an edit keeps the version the user opened, not the newest local one', () => {
  const change = buildEditChange({ changeId: CHANGE, entryVersion: 7, entry: draft() });
  assert.equal(change.baseVersion, 7);
  assert.equal(change.operation, 'update');
  assert.throws(() => buildEditChange({ changeId: CHANGE, entryVersion: 0, entry: draft() }), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'INVALID_INPUT');
});

test('drafting an entry drops the local version so it cannot leak into a base', () => {
  const state = { ...draft(), version: 8 };
  const stripped = draftFromEntry(state);
  assert.equal(Object.hasOwn(stripped, 'version'), false);
  assert.equal(Object.hasOwn(stripped, 'revisions'), false);
});

test('strict change input rejects a client-supplied version field', () => {
  const input = { changeId: CHANGE, baseVersion: 1, operation: 'update', entry: { ...draft(), version: 9 } };
  assert.throws(() => SyncChangeInput.parse(input));
});

test('a gap stops application before it and never advances the cursor across it', () => {
  const plan = planPull(page([6, 7, 9, 10]), 5);
  assert.deepEqual(plan.apply.map((item) => item.seq), [6, 7]);
  assert.equal(plan.gapAt, 8);
  assert.equal(plan.nextCursor, 7);
  assert.equal(plan.needsSnapshot, false);
});

test('replayed records at or below the cursor are ignored', () => {
  const plan = planPull(page([5, 6, 7]), 5);
  assert.deepEqual(plan.apply.map((item) => item.seq), [6, 7]);
  assert.equal(plan.nextCursor, 7);
});

test('a page that starts past the cursor reports the missing seq', () => {
  const plan = planPull(page([9, 10], { retentionFloor: 1 }), 5);
  assert.deepEqual(plan.apply, []);
  assert.equal(plan.gapAt, 6);
  assert.equal(plan.nextCursor, 5);
});

test('a page older than the retention floor forces a snapshot even when it starts past the cursor', () => {
  const plan = planPull(page([9, 10], { retentionFloor: 9 }), 5);
  assert.equal(plan.needsSnapshot, true);
  assert.equal(plan.gapAt, null);
});

test('a retention floor past the cursor forces a snapshot', () => {
  const plan = planPull(page([10, 11], { retentionFloor: 10 }), 5);
  assert.equal(plan.needsSnapshot, true);
  assert.deepEqual(plan.apply, []);
  assert.equal(plan.nextCursor, 5);
  assert.equal(planPull(page([1, 2], { retentionFloor: 1 }), 0).needsSnapshot, false);
});

test('the cursor only advances over a contiguous applied run', () => {
  const rows = [{ seq: 1, applied: true }, { seq: 2, applied: false }, { seq: 3, applied: true }];
  assert.equal(advanceCursor(rows, 0), 1);
  assert.equal(advanceCursor([{ seq: 1, applied: true }, { seq: 2, applied: true }], 0), 2);
  assert.equal(advanceCursor([], 4), 4);
});

test('failure classification separates queued from unknown', () => {
  assert.equal(classifySubmitFailure(false), 'queued');
  assert.equal(classifySubmitFailure(true), 'unknown');
});

test('pull pages are strict about shape', () => {
  assert.throws(() => SyncPullPage.parse({ ...page([1]), extra: true }));
  assert.throws(() => SyncPullPage.parse(page([1], { retentionFloor: -1 })));
});

test('an edit is rejected when its base version is not the current one', () => {
  assertEntryVersion(3, 3);
  assert.throws(() => assertEntryVersion(3, 2), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'VERSION_CONFLICT');
  assert.throws(() => assertEntryVersion(0, 1), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'VERSION_CONFLICT');
});
