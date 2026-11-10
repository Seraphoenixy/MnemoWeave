import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MnemoWeaveError, SyncChangeInput } from '../../packages/core/contracts/src/index.ts';
import type { SyncChangeRequest, SyncEntryDraftValue } from '../../packages/core/contracts/src/index.ts';
import { buildChange, planPull, plainContent, VersionConflictError } from '../../packages/core/application/src/sync.ts';
import { SyncStore } from '../../packages/infrastructure/sync-store/src/index.ts';

const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);
const NOW = '2026-11-10T04:00:00.000Z';

function openStore() {
  const dir = join('work', 'sync-store-test', randomUUID());
  mkdirSync(dir, { recursive: true });
  const store = new SyncStore({ path: join(dir, 'sync.db'), now: () => NOW });
  store.enroll('device-a', TOKEN_A, [
    { scope: 'global', canRead: true, canWrite: true },
    { scope: 'project:alpha', canRead: true, canWrite: true },
  ]);
  store.enroll('device-b', TOKEN_B, [{ scope: 'project:beta', canRead: true, canWrite: true }]);
  return store;
}

function draft(overrides: Partial<SyncEntryDraftValue> = {}): SyncEntryDraftValue {
  return {
    entryId: overrides.entryId ?? randomUUID(),
    kind: overrides.kind ?? 'runtime',
    scope: overrides.scope ?? 'project:alpha',
    content: overrides.content ?? plainContent('提交前必须运行类型检查。'),
    payload: overrides.payload ?? { enabled: true },
    withdrawnAt: overrides.withdrawnAt ?? null,
  };
}

function create(entry: SyncEntryDraftValue, changeId = randomUUID()): SyncChangeRequest {
  return buildChange({ changeId, baseVersion: 0, operation: 'create', entry });
}

function update(entry: SyncEntryDraftValue, baseVersion: number, changeId = randomUUID()): SyncChangeRequest {
  return buildChange({ changeId, baseVersion, operation: 'update', entry });
}

test('devices authenticate by hashed token and lose access when revoked', () => {
  const store = openStore();
  try {
    assert.deepEqual(store.scopes(TOKEN_A).scopes.map((item) => item.scope).sort(), ['global', 'project:alpha']);
    assert.throws(() => store.scopes('c'.repeat(32)), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'UNAUTHORIZED');
    store.revoke('device-a');
    assert.throws(() => store.scopes(TOKEN_A), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'DEVICE_REVOKED');
  } finally {
    store.close();
  }
});

test('a submitted change gets the next version and a per-scope sequence', () => {
  const store = openStore();
  try {
    const first = create(draft());
    const accepted = store.submit(TOKEN_A, first);
    assert.equal(accepted.version, 1);
    assert.equal(accepted.seq, 1);
    assert.equal(accepted.duplicate, false);
    assert.equal(store.submit(TOKEN_A, first).duplicate, true);
    assert.equal(store.submit(TOKEN_A, first).seq, 1);
  } finally {
    store.close();
  }
});

test('a reused change id with different content is rejected', () => {
  const store = openStore();
  try {
    const entry = draft();
    const first = create(entry);
    store.submit(TOKEN_A, first);
    const altered = buildChange({ changeId: first.changeId, baseVersion: 0, operation: 'create', entry: { ...entry, content: plainContent('另一条正文。') } });
    assert.throws(() => store.submit(TOKEN_A, altered), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'CHANGE_ID_REUSED');
  } finally {
    store.close();
  }
});

test('a stale base version is refused and reports the current version', () => {
  const store = openStore();
  try {
    const entry = draft();
    store.submit(TOKEN_A, create(entry));
    assert.throws(
      () => store.submit(TOKEN_A, SyncChangeInput.parse({ changeId: randomUUID(), baseVersion: 0, operation: 'update', entry })),
      (error: unknown) => error instanceof VersionConflictError && error.currentVersion === 1 && error.code === 'VERSION_CONFLICT',
    );
    store.submit(TOKEN_A, update({ ...entry, content: plainContent('第二版正文。') }, 1));
    assert.throws(
      () => store.submit(TOKEN_A, update({ ...entry, content: plainContent('基于旧版本的更正。') }, 1)),
      (error: unknown) => error instanceof VersionConflictError && error.currentVersion === 2,
    );
    assert.throws(
      () => store.submit(TOKEN_A, buildChange({ changeId: randomUUID(), baseVersion: 0, operation: 'create', entry })),
      (error: unknown) => error instanceof VersionConflictError && error.currentVersion === 2,
    );
  } finally {
    store.close();
  }
});

test('writing a scope the device was not granted is refused', () => {
  const store = openStore();
  try {
    assert.throws(() => store.submit(TOKEN_B, create(draft({ scope: 'project:alpha' }))), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'SCOPE_FORBIDDEN');
    assert.throws(() => store.pull(TOKEN_B, { scope: 'project:alpha', since: 0, limit: 10 }), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'SCOPE_FORBIDDEN');
  } finally {
    store.close();
  }
});

test('sequences stay contiguous per scope and paging never skips', () => {
  const store = openStore();
  try {
    const one = draft();
    const two = draft();
    store.submit(TOKEN_A, create(one));
    store.submit(TOKEN_A, create(two));
    store.submit(TOKEN_A, update({ ...one, content: plainContent('更新后的正文。') }, 1));
    const all = store.pull(TOKEN_A, { scope: 'project:alpha', since: 0, limit: 10 });
    assert.deepEqual(all.changes.map((item) => item.seq), [1, 2, 3]);
    assert.equal(all.retentionFloor, 1);
    assert.equal(all.hasMore, false);
    assert.equal(all.nextSince, 3);
    const page = store.pull(TOKEN_A, { scope: 'project:alpha', since: 1, limit: 1 });
    assert.deepEqual(page.changes.map((item) => item.seq), [2]);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextSince, 2);
    assert.deepEqual(store.pull(TOKEN_A, { scope: 'project:alpha', since: 3, limit: 10 }).changes, []);
  } finally {
    store.close();
  }
});

test('entry reads carry the revision chain and refuse other scopes', () => {
  const store = openStore();
  try {
    const entry = draft({ kind: 'formal', payload: { category: 'fact', importance: 3, tags: [], entities: [], relations: [] } });
    store.submit(TOKEN_A, create(entry));
    store.submit(TOKEN_A, update({ ...entry, content: plainContent('第二版正式记忆。') }, 1));
    const current = store.entry(TOKEN_A, entry.entryId);
    assert.equal(current.version, 2);
    assert.deepEqual(current.revisions?.map((item) => item.version), [1, 2]);
    assert.throws(() => store.entry(TOKEN_B, entry.entryId), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'SCOPE_FORBIDDEN');
    assert.throws(() => store.entry(TOKEN_A, randomUUID()), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'NOT_FOUND');
  } finally {
    store.close();
  }
});

test('a snapshot is a consistent cut point and carries formal history', () => {
  const store = openStore();
  try {
    const formal = draft({ kind: 'formal', payload: { category: 'decision', importance: 4, tags: ['sync'], entities: ['mnemoweave'], relations: [] } });
    store.submit(TOKEN_A, create(formal));
    store.submit(TOKEN_A, update({ ...formal, content: plainContent('第二版正式记忆。') }, 1));
    store.submit(TOKEN_A, create(draft({ scope: 'global', payload: { enabled: true } })));
    const snapshot = store.snapshot(TOKEN_A, 'project:alpha');
    assert.equal(snapshot.asOfSeq, snapshot.nextSince);
    assert.equal(snapshot.asOfSeq, 2);
    assert.equal(snapshot.entries.length, 1);
    assert.deepEqual(snapshot.entries[0]?.revisions?.map((item) => item.version), [1, 2]);
    const global = store.snapshot(TOKEN_A, 'global');
    assert.equal(global.asOfSeq, 1);
    assert.throws(() => store.snapshot(TOKEN_B, 'project:alpha'), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'SCOPE_FORBIDDEN');
  } finally {
    store.close();
  }
});

test('pruning keeps a per-scope prefix rule and outlives changes with receipts', () => {
  const store = openStore();
  try {
    const first = create(draft());
    store.submit(TOKEN_A, first);
    store.submit(TOKEN_A, create(draft()));
    store.submit(TOKEN_A, create(draft()));
    assert.deepEqual(store.changeRange('project:alpha'), { floor: 1, head: 3, count: 3 });

    // Hard cap keeps the newest changes and drops a prefix, never a hole.
    assert.equal(store.prune({ now: NOW, maxChangesPerScope: 2 }).changes, 1);
    assert.deepEqual(store.changeRange('project:alpha'), { floor: 2, head: 3, count: 2 });

    // Age removes the rest; the receipt still resolves a changeId that is gone.
    assert.equal(store.prune({ now: new Date(Date.parse(NOW) + 100 * 86_400_000).toISOString(), retentionDays: 90 }).changes, 2);
    assert.deepEqual(store.changeRange('project:alpha'), { floor: 0, head: 0, count: 0 });
    assert.equal(store.receipt(TOKEN_A, first.changeId).seq, 1);

    // Receipts themselves expire later than changes.
    const later = new Date(Date.parse(NOW) + 400 * 86_400_000).toISOString();
    assert.equal(store.prune({ now: later, receiptDays: 365 }).receipts, 3);
    assert.throws(() => store.receipt(TOKEN_A, first.changeId), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'NOT_FOUND');
  } finally {
    store.close();
  }
});

test('pruning one scope leaves other scopes and their cursors alone', () => {
  const store = openStore();
  try {
    store.submit(TOKEN_A, create(draft({ scope: 'global' })));
    store.submit(TOKEN_A, create(draft()));
    const result = store.prune({ now: new Date(Date.parse(NOW) + 100 * 86_400_000).toISOString(), retentionDays: 90 });
    assert.equal(result.scopes, 2);
    assert.equal(result.changes, 2);
    assert.deepEqual(store.pull(TOKEN_A, { scope: 'global', since: 0, limit: 10 }).changes, []);
  } finally {
    store.close();
  }
});

test('pruning a whole scope keeps the sequence head so devices are not stranded', () => {
  const store = openStore();
  try {
    store.submit(TOKEN_A, create(draft()));
    store.submit(TOKEN_A, create(draft()));
    store.submit(TOKEN_A, create(draft()));
    assert.equal(store.prune({ now: new Date(Date.parse(NOW) + 100 * 86_400_000).toISOString(), retentionDays: 90 }).changes, 3);
    assert.deepEqual(store.changeRange('project:alpha'), { floor: 0, head: 0, count: 0 });

    const revived = create(draft());
    const accepted = store.submit(TOKEN_A, revived);
    assert.equal(accepted.seq, 4, 'sequence numbers must continue after the retained rows are gone');
    assert.deepEqual(store.changeRange('project:alpha'), { floor: 4, head: 4, count: 1 });

    // A device at cursor 3 continues; a device at 0 must snapshot instead of hitting a gap.
    const behind = store.pull(TOKEN_A, { scope: 'project:alpha', since: 3, limit: 10 });
    assert.equal(behind.retentionFloor, 4);
    assert.deepEqual(behind.changes.map((change) => change.seq), [4]);
    assert.equal(planPull(behind, 3).apply.length, 1);
    assert.equal(planPull(behind, 3).needsSnapshot, false);

    const stale = store.pull(TOKEN_A, { scope: 'project:alpha', since: 0, limit: 10 });
    assert.equal(planPull(stale, 0).needsSnapshot, true, 'a cursor below the floor must use a snapshot');

    const snapshot = store.snapshot(TOKEN_A, 'project:alpha');
    assert.equal(snapshot.asOfSeq, 4);
    assert.equal(snapshot.nextSince, 4);
  } finally {
    store.close();
  }
});
