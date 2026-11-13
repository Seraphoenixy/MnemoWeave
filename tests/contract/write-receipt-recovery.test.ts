import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tempDir } from '../support/temp.ts';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';

/**
 * What a reopened page can ask about a write it already submitted.
 *
 * Two reads back the receipt recovery: the per-key receipt (already covered elsewhere) and the
 * list of unsettled actions for one Host. The list must be scoped to its own Host — another Host
 * learning that a write exists is the same leak as reading its receipt — and it must keep showing
 * an action whose outcome is still unknown.
 */

const HOST = 'host-a';
const OTHER = 'host-b';
const TASK = '33333333-3333-4333-8333-333333333333';
const HASH = 'b'.repeat(64);

async function open(): Promise<SqliteCandidates> {
  const dir = await tempDir('write-receipts', 'unsettled');
  return new SqliteCandidates(join(dir, 'governance.db'));
}

test('only queued and unknown actions are listed, newest first', async () => {
  const repo = await open();
  try {
    const older = '44444444-4444-4444-8444-444444444444';
    const newer = '55555555-5555-4555-8555-555555555555';
    repo.writeTasks.claim({ hostId: HOST, taskId: older, index: 0, kind: 'rule', action: 'create', requestHash: HASH });
    repo.writeTasks.settle(HOST, older, 0, { status: 'queued', errorCode: 'SYNC_QUEUED' });
    repo.writeTasks.claim({ hostId: HOST, taskId: newer, index: 0, kind: 'formal-memory', action: 'create', requestHash: HASH });
    // A settled action is not outstanding: it has an answer and needs no page entry.
    const settled = '66666666-6666-4666-8666-666666666666';
    repo.writeTasks.claim({ hostId: HOST, taskId: settled, index: 0, kind: 'rule', action: 'create', requestHash: HASH });
    repo.writeTasks.settle(HOST, settled, 0, { status: 'applied', entryId: settled, entryVersion: 1 });

    const rows = repo.writeTasks.unsettledReceipts(HOST, 50);
    assert.deepEqual(rows.map(row => row.taskId), [newer, older]);
    assert.deepEqual(rows.map(row => row.status), ['unknown', 'queued']);
  } finally { repo.close(); }
});

test('another Host sees nothing of this Host\'s outstanding writes', async () => {
  const repo = await open();
  try {
    repo.writeTasks.claim({ hostId: HOST, taskId: TASK, index: 0, kind: 'formal-memory', action: 'create', requestHash: HASH });
    repo.writeTasks.settle(HOST, TASK, 0, { status: 'unknown', errorCode: 'SYNC_OUTCOME_UNKNOWN' });
    assert.equal(repo.writeTasks.unsettledReceipts(HOST, 50).length, 1);
    assert.deepEqual(repo.writeTasks.unsettledReceipts(OTHER, 50), []);
  } finally { repo.close(); }
});

test('a receipt is readable by its own Host only', async () => {
  const repo = await open();
  try {
    repo.writeTasks.claim({ hostId: HOST, taskId: TASK, index: 0, kind: 'rule', action: 'create', requestHash: HASH });
    assert.notEqual(repo.writeTasks.receipt(HOST, TASK, 0), null);
    assert.equal(repo.writeTasks.receipt(OTHER, TASK, 0), null);
  } finally { repo.close(); }
});
