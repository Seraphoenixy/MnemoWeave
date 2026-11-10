import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MnemoWeaveError } from '../../packages/core/contracts/src/index.ts';
import type { SyncInboxRecord, SyncLedgerPort, SyncOutboxRecord, SyncStateRecord } from '../../packages/core/application/src/sync.ts';
import type { SyncChangeRecordValue, SyncChangeRequest } from '../../packages/core/contracts/src/index.ts';
import { archiveDraft, planEditChange, ruleDraft, ruleScope, submitLocalChange } from '../../packages/core/application/src/local-write.ts';

const NOW = '2026-11-10T13:00:00.000Z';

interface FakeLedger extends SyncLedgerPort {
  rows: SyncOutboxRecord[];
  inboxRows: SyncInboxRecord[];
  nextState: SyncOutboxRecord['state'];
}

function ledger(nextState: SyncOutboxRecord['state'] = 'confirmed'): FakeLedger {
  const rows: SyncOutboxRecord[] = [];
  const inboxRows: SyncInboxRecord[] = [];
  const fake: FakeLedger = {
    rows,
    inboxRows,
    nextState,
    state: (scope: string): SyncStateRecord => ({ scope, cursor: 0, lastPullAt: null, lastError: null }),
    cursor: () => 0,
    setCursor: () => undefined,
    setError: () => undefined,
    enqueue: (change: SyncChangeRequest, at: string) => {
      rows.push({
        changeId: change.changeId, scope: change.entry.scope, entryId: change.entry.entryId,
        baseVersion: change.baseVersion, operation: change.operation, entry: change.entry,
        state: 'pending', attempts: 0, lastError: null, createdAt: at, updatedAt: at,
      });
    },
    outbox: (state?: SyncOutboxRecord['state'], limit = 100) => (state ? rows.filter((row) => row.state === state) : rows).slice(0, limit),
    markOutbox: (changeId: string, state: SyncOutboxRecord['state']) => {
      const row = rows.find((item) => item.changeId === changeId);
      if (row) row.state = state;
    },
    receive: (_record: SyncChangeRecordValue) => true,
    inbox: (scope: string, limit = 100) => inboxRows.filter((row) => row.scope === scope).slice(0, limit),
    markInbox: () => undefined,
    progress: () => [],
  };
  return fake;
}

function flushTo(fake: FakeLedger) {
  return async () => {
    for (const row of fake.rows) {
      if (row.state !== 'pending') continue;
      row.state = fake.nextState;
      if (fake.nextState === 'confirmed') {
        fake.inboxRows.push({
          scope: row.scope, seq: 1, changeId: row.changeId, entryId: row.entryId, version: row.baseVersion + 1,
          operation: row.operation, entry: { ...row.entry, version: row.baseVersion + 1 }, state: 'received', error: null,
        });
      }
    }
  };
}

const draft = () => ({
  entryId: randomUUID(), kind: 'runtime' as const, scope: 'global',
  content: { format: 'plain' as const, data: 'x', contentHash: 'a'.repeat(64), byteLength: 1 },
  payload: { enabled: true }, withdrawnAt: null,
});

test('a local write reports what the remote answered', async () => {
  for (const [state, expected] of [['confirmed', 'confirmed'], ['pending', 'queued'], ['unknown', 'unknown']] as const) {
    const fake = ledger(state);
    const result = await submitLocalChange({ scope: 'global', operation: 'create', entry: draft(), baseVersion: 0 }, { ledger: fake, flush: flushTo(fake), now: () => NOW });
    assert.equal(result.state, expected, state);
    assert.equal(fake.rows.length, 1);
    assert.equal(fake.rows[0]?.baseVersion, 0);
    if (state === 'confirmed') assert.deepEqual(result.accepted, { version: 1, seq: 1 });
    else assert.equal(result.accepted, null);
  }
});

test('a conflict or review demand fails the write instead of claiming success', async () => {
  for (const [state, code] of [['conflict', 'VERSION_CONFLICT'], ['needs_review', 'NEEDS_REVIEW']] as const) {
    const fake = ledger(state);
    await assert.rejects(
      submitLocalChange({ scope: 'global', operation: 'update', entry: draft(), baseVersion: 3 }, { ledger: fake, flush: flushTo(fake), now: () => NOW }),
      (error: unknown) => error instanceof MnemoWeaveError && error.code === code,
    );
  }
});

test('a second write waits while the same entry is still unconfirmed', async () => {
  const fake = ledger('pending');
  const entry = draft();
  await submitLocalChange({ scope: 'global', operation: 'create', entry, baseVersion: 0 }, { ledger: fake, flush: flushTo(fake), now: () => NOW });
  await assert.rejects(
    submitLocalChange({ scope: 'global', operation: 'update', entry, baseVersion: 0 }, { ledger: fake, flush: flushTo(fake), now: () => NOW }),
    (error: unknown) => error instanceof MnemoWeaveError && error.code === 'SYNC_QUEUED',
  );
  assert.equal(fake.rows.length, 1, 'the queued change must not be duplicated');
});

test('rule and archive drafts carry their scope and payload', () => {  const rule = { entryId: randomUUID(), body: '准则正文', scope: 'project' as const, projectId: 'alpha', enabled: false, version: 2, withdrawnAt: null };
  assert.equal(ruleScope(rule), 'project:alpha');
  const ruleEntry = ruleDraft(rule);
  assert.equal(ruleEntry.kind, 'runtime');
  assert.deepEqual(ruleEntry.payload, { enabled: false });
  assert.equal(ruleEntry.content.format, 'plain');
  assert.equal(ruleEntry.content.byteLength, Buffer.byteLength('准则正文', 'utf8'));

  const archive = { entryId: randomUUID(), projectId: 'alpha', title: '标题', body: '正文', source: 'tool', verification: 'open' as const, evidence: '证据', version: 1, withdrawnAt: null };
  const archiveEntry = archiveDraft(archive);
  assert.equal(archiveEntry.kind, 'archive');
  assert.equal(archiveEntry.scope, 'project:alpha');
  assert.deepEqual(archiveEntry.payload, { title: '标题', source: 'tool', verification: 'open', evidence: '证据', tags: [] });
});

test('an edit becomes a formal change that supersedes its previous version', () => {
  const entryId = randomUUID();
  const first = planEditChange({ entryId, scope: 'project:alpha', content: '第一版正文', entryVersion: 0 });
  assert.equal(first.operation, 'create');
  assert.equal(first.baseVersion, 0);
  assert.equal(first.entry.kind, 'formal');
  assert.deepEqual((first.entry.payload as { relations: unknown[] }).relations, []);

  const second = planEditChange({ entryId, scope: 'project:alpha', content: '第二版正文', entryVersion: 3 });
  assert.equal(second.operation, 'update');
  assert.equal(second.baseVersion, 3);
  assert.equal(second.entry.content.data, '第二版正文');
  assert.equal(second.entry.content.byteLength, Buffer.byteLength('第二版正文', 'utf8'));
  assert.deepEqual((second.entry.payload as { relations: unknown[] }).relations, [
    { type: 'supersedes', from: { entryId, version: 3 }, to: { entryId, version: 4 } },
  ]);
});
