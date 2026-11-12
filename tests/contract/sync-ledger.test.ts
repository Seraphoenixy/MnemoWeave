import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SqliteCandidates, SqliteSyncLedger } from '../../packages/infrastructure/governance/src/index.ts';
import { buildChange, plainContent } from '../../packages/core/application/src/sync.ts';
import type { SyncChangeRecordValue, SyncEntryDraftValue } from '../../packages/core/contracts/src/index.ts';

const NOW = '2026-11-10T07:00:00.000Z';

async function openLedger() {
  await mkdir('work/tests', { recursive: true });
  const path = join(await mkdtemp(resolve('work/tests/ledger-')), 'governance.db');
  const repo = new SqliteCandidates(path);
  repo.close();
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  const ledger = new SqliteSyncLedger(db, <T>(operation: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
  return { db, ledger };
}

function draft(): SyncEntryDraftValue {
  return {
    entryId: randomUUID(),
    kind: 'rule',
    content: plainContent('提交前必须运行类型检查。'),
    payload: { enabled: true },
    withdrawnAt: null,
  };
}

function record(seq: number, overrides: Partial<SyncChangeRecordValue> = {}): SyncChangeRecordValue {
  const entry = draft();
  return {
    changeId: randomUUID(),
    entryId: entry.entryId,
    stream: 'rules',
    version: seq,
    seq,
    operation: 'update',
    entry: { ...entry, version: seq },
    deviceId: 'device-a',
    recordedAt: NOW,
    ...overrides,
  };
}

test('a stream cursor starts at zero, moves forward only and records errors', async () => {
  const { db, ledger } = await openLedger();
  try {
    assert.deepEqual(ledger.state('rules'), { stream: 'rules', cursor: 0, lastPullAt: null, lastError: null });
    ledger.setCursor('project:alpha', 4, NOW);
    assert.equal(ledger.cursor('project:alpha'), 4);
    ledger.setCursor('project:alpha', 2, NOW);
    assert.equal(ledger.cursor('project:alpha'), 4);
    assert.equal(ledger.cursor('project:other'), 0);
    ledger.setError('project:alpha', 'SYNC_UNAVAILABLE', NOW);
    assert.equal(ledger.state('project:alpha').lastError, 'SYNC_UNAVAILABLE');
    assert.equal(ledger.state('project:alpha').cursor, 4);
    assert.throws(() => ledger.setCursor('project:alpha', Number.NaN, NOW));
  } finally {
    db.close();
  }
});

test('an enqueued change stays pending until the remote answers', async () => {
  const { db, ledger } = await openLedger();
  try {
    const change = buildChange({ changeId: randomUUID(), baseVersion: 1, operation: 'update', entry: draft() });
    ledger.enqueue(change, NOW);
    const pending = ledger.outbox('pending');
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.changeId, change.changeId);
    assert.equal(pending[0]?.baseVersion, 1);
    assert.equal(pending[0]?.entry.entryId, change.entry.entryId);
    ledger.markOutbox(change.changeId, 'conflict', 'VERSION_CONFLICT', NOW);
    assert.equal(ledger.outbox('pending').length, 0);
    assert.equal(ledger.outbox('conflict')[0]?.attempts, 1);
    assert.equal(ledger.outbox('conflict')[0]?.lastError, 'VERSION_CONFLICT');
  } finally {
    db.close();
  }
});

test('received changes are deduplicated and applied in sequence order', async () => {
  const { db, ledger } = await openLedger();
  try {
    const first = record(1);
    const second = record(2);
    assert.equal(ledger.receive(first, NOW), true);
    assert.equal(ledger.receive(first, NOW), false);
    ledger.receive(second, NOW);
    assert.deepEqual(ledger.inbox('rules').map((row) => row.seq), [1, 2]);
    assert.equal(ledger.inbox('rules')[0]?.entry.version, 1);
    ledger.markInbox('rules', 1, 'applied');
    assert.deepEqual(ledger.inbox('rules').map((row) => row.seq), [2]);
    assert.deepEqual(ledger.progress('rules', 0), [{ seq: 1, applied: true }, { seq: 2, applied: false }]);
    ledger.markInbox('rules', 2, 'needs_review', 'WRITE_UNKNOWN');
    assert.deepEqual(ledger.progress('rules', 0), [{ seq: 1, applied: true }, { seq: 2, applied: false }]);
    assert.equal(ledger.inbox('rules')[0]?.state, 'needs_review');
  } finally {
    db.close();
  }
});

test('streams keep independent cursors and inboxes', async () => {
  const { db, ledger } = await openLedger();
  try {
    ledger.setCursor('formal-memories', 3, NOW);
    ledger.receive(record(1, { stream: 'formal-memories' }), NOW);
    assert.equal(ledger.cursor('formal-memories'), 3);
    assert.equal(ledger.cursor('rules'), 0);
    assert.equal(ledger.inbox('rules').length, 0);
    assert.equal(ledger.inbox('formal-memories').length, 1);
  } finally {
    db.close();
  }
});

test('a snapshot reset drops covered inbox rows and clears the previous error', async () => {
  const { db, ledger } = await openLedger();
  try {
    ledger.receive(record(1), NOW);
    ledger.receive(record(2), NOW);
    ledger.receive(record(3, { stream: 'formal-memories' }), NOW);
    ledger.setError('rules', 'SNAPSHOT_REQUIRED', NOW);
    ledger.resetScope('rules', 2, NOW);
    assert.equal(ledger.cursor('rules'), 2);
    assert.equal(ledger.inbox('rules').length, 0);
    assert.equal(ledger.inbox('formal-memories').length, 1, 'other streams keep their rows');
    assert.equal(ledger.state('rules').lastError, null);
  } finally {
    db.close();
  }
});
