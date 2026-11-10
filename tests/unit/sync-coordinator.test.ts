import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { SyncInboxRecord, SyncLedgerPort, SyncOutboxRecord, SyncRemotePort, SyncStateRecord } from '../../packages/core/application/src/sync.ts';
import { SyncCoordinator, VersionConflictError, buildChange, plainContent } from '../../packages/core/application/src/sync.ts';
import type { SyncAcceptedValue, SyncChangeRecordValue, SyncChangeRequest, SyncEntryDraftValue, SyncPullPageValue } from '../../packages/core/contracts/src/index.ts';

const NOW = '2026-11-10T08:00:00.000Z';

class MemoryLedger implements SyncLedgerPort {
  states = new Map<string, SyncStateRecord>();
  outboxRows: SyncOutboxRecord[] = [];
  inboxRows: SyncInboxRecord[] = [];

  state(scope: string): SyncStateRecord {
    return this.states.get(scope) ?? { scope, cursor: 0, lastPullAt: null, lastError: null };
  }
  cursor(scope: string): number { return this.state(scope).cursor; }
  setCursor(scope: string, cursor: number, at: string): void {
    const current = this.state(scope);
    if (cursor <= current.cursor) return;
    this.states.set(scope, { ...current, cursor, lastPullAt: at });
  }
  setError(scope: string, error: string | null, at: string): void {
    this.states.set(scope, { ...this.state(scope), lastError: error, lastPullAt: at });
  }
  enqueue(change: SyncChangeRequest, at: string): void {
    this.outboxRows.push({ changeId: change.changeId, scope: change.entry.scope, entryId: change.entry.entryId, baseVersion: change.baseVersion, operation: change.operation, entry: change.entry, state: 'pending', attempts: 0, lastError: null, createdAt: at, updatedAt: at });
  }
  outbox(state?: SyncOutboxRecord['state'], limit = 100): SyncOutboxRecord[] {
    return (state ? this.outboxRows.filter((row) => row.state === state) : this.outboxRows).slice(0, limit);
  }
  markOutbox(changeId: string, state: SyncOutboxRecord['state'], error: string | null, at: string): void {
    const row = this.outboxRows.find((item) => item.changeId === changeId);
    if (row) Object.assign(row, { state, lastError: error, attempts: row.attempts + 1, updatedAt: at });
  }
  receive(record: SyncChangeRecordValue): boolean {
    if (this.inboxRows.some((row) => row.scope === record.scope && row.seq === record.seq)) return false;
    this.inboxRows.push({ scope: record.scope, seq: record.seq, changeId: record.changeId, entryId: record.entryId, version: record.version, operation: record.operation, entry: record.entry, state: 'received', error: null });
    return true;
  }
  inbox(scope: string, limit = 100): SyncInboxRecord[] {
    return this.inboxRows.filter((row) => row.scope === scope && row.state !== 'applied').slice(0, limit);
  }
  markInbox(scope: string, seq: number, state: SyncInboxRecord['state'], error: string | null = null): void {
    const row = this.inboxRows.find((item) => item.scope === scope && item.seq === seq);
    if (row) Object.assign(row, { state, error });
  }
  progress(scope: string, fromSeq: number, limit = 200): { seq: number; applied: boolean }[] {
    return this.inboxRows.filter((row) => row.scope === scope && row.seq > fromSeq).sort((left, right) => left.seq - right.seq).slice(0, limit).map((row) => ({ seq: row.seq, applied: row.state === 'applied' }));
  }
  resetScope(scope: string, cursor: number, at: string): void {
    this.inboxRows = this.inboxRows.filter((row) => !(row.scope === scope && row.seq <= cursor));
    if (cursor > this.state(scope).cursor) this.states.set(scope, { ...this.state(scope), cursor, lastPullAt: at });
  }
}

function draft(): SyncEntryDraftValue {
  return { entryId: randomUUID(), kind: 'runtime', scope: 'project:alpha', content: plainContent('提交前必须运行类型检查。'), payload: { enabled: true }, withdrawnAt: null };
}

function change(baseVersion = 0): SyncChangeRequest {
  return buildChange({ changeId: randomUUID(), baseVersion, operation: baseVersion === 0 ? 'create' : 'update', entry: draft() });
}

function accepted(changeRequest: SyncChangeRequest, version = 1, seq = 1): SyncAcceptedValue {
  return { changeId: changeRequest.changeId, entryId: changeRequest.entry.entryId, scope: changeRequest.entry.scope, version, seq, duplicate: false };
}

function remote(overrides: Partial<SyncRemotePort> = {}): SyncRemotePort {
  return {
    async push(changeRequest) { return accepted(changeRequest); },
    async pull(scope): Promise<SyncPullPageValue> { return { scope, changes: [], nextSince: 0, hasMore: false, retentionFloor: 0 }; },
    async snapshot(scope) { return { scope, asOfSeq: 0, nextSince: 0, entries: [] }; },
    async receipt() { return null; },
    ...overrides,
  };
}

test('a confirmed push is queued for application, not applied twice', async () => {
  const ledger = new MemoryLedger();
  const coordinator = new SyncCoordinator(remote(), ledger, () => NOW);
  const request = change();
  ledger.enqueue(request, NOW);
  assert.deepEqual(await coordinator.flushOutbox(), { confirmed: 1, conflict: 0, unknown: 0, queued: 0, needsReview: 0 });
  assert.equal(ledger.outboxRows[0]?.state, 'confirmed');
  assert.equal(ledger.inboxRows.length, 1);
  assert.equal(ledger.inboxRows[0]?.version, 1);
  assert.equal(ledger.inboxRows[0]?.entry.version, 1);
  assert.equal(ledger.cursor('project:alpha'), 0);
  const result = await coordinator.applyScope('project:alpha', async () => ({ status: 'applied' }));
  assert.deepEqual(result, { applied: 1, cursor: 1 });
  assert.equal(ledger.cursor('project:alpha'), 1);
});

test('a version conflict stops the change and keeps it for rebasing', async () => {
  const ledger = new MemoryLedger();
  const entry = draft();
  const conflict = new VersionConflictError({ ...entry, version: 3, revisions: [] });
  const coordinator = new SyncCoordinator(remote({ async push() { throw conflict; } }), ledger, () => NOW);
  ledger.enqueue(change(2), NOW);
  const result = await coordinator.flushOutbox();
  assert.equal(result.conflict, 1);
  assert.equal(ledger.outboxRows[0]?.state, 'conflict');
  assert.equal(ledger.outboxRows[0]?.lastError, 'VERSION_CONFLICT');
  assert.equal(ledger.inboxRows.length, 0);
});

test('an unknown outcome is resolved by the receipt, a queued one stays pending', async () => {
  const ledger = new MemoryLedger();
  const request = change();
  const unknown = new (class extends Error { reachedRemote = true; })();
  let mode: 'unknown' | 'queued' = 'unknown';
  const coordinator = new SyncCoordinator(remote({
    async push() { throw mode === 'unknown' ? unknown : Object.assign(new Error('refused'), { reachedRemote: false }); },
    async receipt(changeId) { return { changeId, entryId: request.entry.entryId, scope: request.entry.scope, version: 1, seq: 1, duplicate: true }; },
  }), ledger, () => NOW);

  ledger.enqueue(request, NOW);
  await coordinator.flushOutbox();
  assert.equal(ledger.outboxRows[0]?.state, 'unknown');
  assert.equal(ledger.outboxRows[0]?.lastError, 'SYNC_OUTCOME_UNKNOWN');
  assert.deepEqual(await coordinator.resolveUnknown(), { confirmed: 1, requeued: 0 });
  assert.equal(ledger.outboxRows[0]?.state, 'confirmed');
  assert.equal(ledger.inboxRows.length, 1);

  const second = change();
  ledger.enqueue(second, NOW);
  mode = 'queued';
  const counts = await coordinator.flushOutbox();
  assert.equal(counts.queued, 1);
  const queuedRow = ledger.outboxRows.find((row) => row.changeId === second.changeId);
  assert.equal(queuedRow?.state, 'pending');
  assert.equal(queuedRow?.lastError, 'SYNC_QUEUED');
});

test('pulling receives a page but leaves the cursor to the apply step', async () => {
  const ledger = new MemoryLedger();
  const base = change();
  const record = { changeId: base.changeId, entryId: base.entry.entryId, scope: base.entry.scope, version: 1, seq: 1, operation: base.operation, entry: { ...base.entry, version: 1 }, deviceId: 'device-a', recordedAt: NOW };
  const coordinator = new SyncCoordinator(remote({
    async pull(scope) { return { scope, changes: [record], nextSince: 1, hasMore: false, retentionFloor: 1 }; },
  }), ledger, () => NOW);
  assert.deepEqual(await coordinator.pullScope('project:alpha'), { received: 1, needsSnapshot: false, gapAt: null });
  assert.equal(ledger.cursor('project:alpha'), 0);
  assert.equal(ledger.inboxRows.length, 1);
});

test('a gap or an expired retention floor is reported instead of applied', async () => {
  const ledger = new MemoryLedger();
  const base = change();
  const record = (seq: number) => ({ changeId: base.changeId, entryId: base.entry.entryId, scope: base.entry.scope, version: seq, seq, operation: base.operation, entry: { ...base.entry, version: seq }, deviceId: 'device-a', recordedAt: NOW });
  const gap = new SyncCoordinator(remote({ async pull(scope) { return { scope, changes: [record(3)], nextSince: 3, hasMore: false, retentionFloor: 1 }; } }), ledger, () => NOW);
  assert.deepEqual(await gap.pullScope('project:alpha'), { received: 0, needsSnapshot: false, gapAt: 1 });
  assert.equal(ledger.state('project:alpha').lastError, 'GAP:1');
  const floor = new SyncCoordinator(remote({ async pull(scope) { return { scope, changes: [], nextSince: 9, hasMore: false, retentionFloor: 9 }; } }), new MemoryLedger(), () => NOW);
  assert.deepEqual(await floor.pullScope('project:alpha'), { received: 0, needsSnapshot: true, gapAt: null });
});

test('a row that needs review blocks the cursor and later rows wait', async () => {
  const ledger = new MemoryLedger();
  const base = change();
  for (const seq of [1, 2]) {
    ledger.receive({ changeId: base.changeId, entryId: base.entry.entryId, scope: base.entry.scope, version: seq, seq, operation: base.operation, entry: { ...base.entry, version: seq }, deviceId: 'device-a', recordedAt: NOW });
  }
  const coordinator = new SyncCoordinator(remote(), ledger, () => NOW);
  const seen: number[] = [];
  const result = await coordinator.applyScope('project:alpha', async (row) => {
    seen.push(row.seq);
    return row.seq === 1 ? { status: 'applied' as const } : { status: 'needs_review' as const, error: 'WRITE_UNKNOWN' };
  });
  assert.deepEqual(seen, [1, 2]);
  assert.equal(result.applied, 1);
  assert.equal(result.cursor, 1);
  assert.equal(ledger.inboxRows.find((row) => row.seq === 2)?.state, 'needs_review');
  assert.equal(ledger.inboxRows.find((row) => row.seq === 2)?.error, 'WRITE_UNKNOWN');
});

test('a snapshot replaces the inbox and applies every entry it carries', async () => {
  const ledger = new MemoryLedger();
  const stale = draft();
  ledger.inboxRows.push({ scope: 'project:alpha', seq: 1, changeId: randomUUID(), entryId: stale.entryId, version: 1, operation: 'create', entry: { ...stale, version: 1 }, state: 'received', error: null });
  const entry = { ...draft(), version: 5 };
  const coordinator = new SyncCoordinator(remote({
    async snapshot(scope) { return { scope, asOfSeq: 40, nextSince: 40, entries: [entry] }; },
  }), ledger, () => NOW);
  const applied: string[] = [];
  const result = await coordinator.captureSnapshot('project:alpha', async (row) => { applied.push(row.entryId); return { status: 'applied' as const }; });
  assert.deepEqual(result, { applied: 1, failed: 0, cursor: 40 });
  assert.equal(ledger.cursor('project:alpha'), 40);
  assert.equal(ledger.inboxRows.length, 0, 'rows covered by the snapshot are dropped');
  assert.deepEqual(applied, [entry.entryId]);
});

test('a snapshot entry that cannot be applied is counted and surfaced as an error', async () => {
  const ledger = new MemoryLedger();
  const entry = { ...draft(), version: 2 };
  const coordinator = new SyncCoordinator(remote({
    async snapshot(scope) { return { scope, asOfSeq: 3, nextSince: 3, entries: [entry] }; },
  }), ledger, () => NOW);
  const result = await coordinator.captureSnapshot('project:alpha', async () => ({ status: 'needs_review' as const, error: 'PROVIDER_UNAVAILABLE' }));
  assert.deepEqual(result, { applied: 0, failed: 1, cursor: 3 });
  assert.equal(ledger.state('project:alpha').lastError, 'SNAPSHOT_APPLY_INCOMPLETE');
});

test('a snapshot replays every revision so the history chain matches the change stream', async () => {
  const ledger = new MemoryLedger();
  const entry = {
    ...draft(),
    version: 2,
    revisions: [
      { version: 1, content: plainContent('第一版正文。'), createdAt: NOW },
      { version: 2, content: plainContent('第二版正文。'), createdAt: NOW },
    ],
    withdrawnAt: '2026-11-10T08:30:00.000Z',
  };
  const coordinator = new SyncCoordinator(remote({
    async snapshot(scope) { return { scope, asOfSeq: 40, nextSince: 40, entries: [entry] }; },
  }), ledger, () => NOW);
  const seen: Array<{ version: number; withdrawn: boolean }> = [];
  const result = await coordinator.captureSnapshot('project:alpha', async (row) => {
    seen.push({ version: row.version, withdrawn: row.entry.withdrawnAt !== null });
    return { status: 'applied' as const };
  });
  assert.deepEqual(result, { applied: 2, failed: 0, cursor: 40 });
  assert.deepEqual(seen, [{ version: 1, withdrawn: false }, { version: 2, withdrawn: true }]);
});
