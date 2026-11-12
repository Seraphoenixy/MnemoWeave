import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MnemoWeaveError } from '../../packages/core/contracts/src/index.ts';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';

/**
 * The authorized write-task receipt is the only record that a host's delegated action happened,
 * so its idempotency, status vocabulary and turn binding are contract. A model never reaches this
 * table: the route is host code, and the key is (Host, task, action index).
 */

const HOST = 'host-a';
const TASK = '22222222-2222-4222-8222-222222222222';
const HASH = 'a'.repeat(64);

function open() {
  mkdirSync('work/tests', { recursive: true });
  const dir = mkdtempSync(resolve('work/tests/write-task-'));
  return new SqliteCandidates(join(dir, 'governance.db'));
}

test('a claim writes an unknown receipt before the action runs', () => {
  const repo = open();
  try {
    assert.equal(repo.writeTasks.receipt(HOST, TASK, 0), null);
    const first = repo.writeTasks.claim({ hostId: HOST, taskId: TASK, index: 0, kind: 'formal-memory', action: 'create', requestHash: HASH });
    assert.equal(first.existing, null);
    const stored = repo.writeTasks.receipt(HOST, TASK, 0);
    assert.equal(stored?.status, 'unknown', 'a crash leaves "unknown", never "nothing happened"');
    assert.equal(stored?.requestHash, HASH);
  } finally { repo.close(); }
});

test('the same key with the same payload returns the original receipt', () => {
  const repo = open();
  try {
    repo.writeTasks.claim({ hostId: HOST, taskId: TASK, index: 0, kind: 'formal-memory', action: 'create', requestHash: HASH });
    const settled = repo.writeTasks.settle(HOST, TASK, 0, { status: 'published', memoryId: 'm-1', entryVersion: 1 });
    assert.equal(settled.status, 'published');
    const replay = repo.writeTasks.claim({ hostId: HOST, taskId: TASK, index: 0, kind: 'formal-memory', action: 'create', requestHash: HASH });
    assert.equal(replay.existing?.status, 'published');
    assert.equal(replay.existing?.memoryId, 'm-1');
  } finally { repo.close(); }
});

test('the same key with a different payload is an idempotency conflict, not a second write', () => {
  const repo = open();
  try {
    repo.writeTasks.claim({ hostId: HOST, taskId: TASK, index: 0, kind: 'formal-memory', action: 'create', requestHash: HASH });
    assert.throws(
      () => repo.writeTasks.claim({ hostId: HOST, taskId: TASK, index: 0, kind: 'formal-memory', action: 'create', requestHash: 'b'.repeat(64) }),
      (error: unknown) => error instanceof MnemoWeaveError && error.code === 'IDEMPOTENCY_CONFLICT',
    );
    // A different action index is a different action, not a conflict.
    assert.equal(repo.writeTasks.claim({ hostId: HOST, taskId: TASK, index: 1, kind: 'formal-memory', action: 'create', requestHash: 'b'.repeat(64) }).existing, null);
    // Nor is another Host's task the same key.
    assert.equal(repo.writeTasks.claim({ hostId: 'host-b', taskId: TASK, index: 0, kind: 'formal-memory', action: 'create', requestHash: HASH }).existing, null);
  } finally { repo.close(); }
});

test('the task receipt list is ordered by action index with the fields a host reports', () => {
  const repo = open();
  try {
    for (const index of [2, 0, 1]) {
      repo.writeTasks.claim({ hostId: HOST, taskId: TASK, index, kind: 'rule', action: 'create', requestHash: `${index}`.padStart(64, 'c') });
    }
    repo.writeTasks.settle(HOST, TASK, 0, { status: 'applied', entryId: 'rule-1', entryVersion: 1 });
    repo.writeTasks.settle(HOST, TASK, 1, { status: 'skipped' });
    repo.writeTasks.settle(HOST, TASK, 2, { status: 'failed', errorCode: 'RULE_CAPACITY_EXCEEDED' });
    const rows = repo.writeTasks.taskReceipts(HOST, TASK);
    assert.deepEqual(rows.map(row => row.index), [0, 1, 2]);
    assert.deepEqual(rows.map(row => row.status), ['applied', 'skipped', 'failed']);
    assert.equal(rows[0]?.entryId, 'rule-1');
    assert.equal(rows[0]?.entryVersion, 1);
    assert.equal(rows[2]?.errorCode, 'RULE_CAPACITY_EXCEEDED');
    // Another Host sees none of this task's receipts.
    assert.deepEqual(repo.writeTasks.taskReceipts('host-b', TASK), []);
  } finally { repo.close(); }
});

test('a no-retention turn is remembered against that turn, then forgotten with age', () => {
  const repo = open();
  try {
    const observed = repo.turns.observe(HOST, {
      protocolVersion: '1', adapterVersion: '0.1.0', eventId: 'event-1', sessionId: 's-1', turnId: '4',
      kind: 'message.user', occurredAt: '2026-11-10T00:00:00.000Z', receivedAt: '2026-11-10T00:00:00.000Z',
      sourceRef: 'test', payload: { text: '这次不要留存', noRetention: true },
    });
    assert.equal(observed.status, 'stored');
    assert.equal(repo.turns.isNoRetention(HOST, 's-1', '4'), true);
    // The marker covers that turn only.
    assert.equal(repo.turns.isNoRetention(HOST, 's-1', '5'), false);
    assert.equal(repo.turns.isNoRetention('host-b', 's-1', '4'), false);
    // An unidentified turn cannot claim the marker.
    assert.equal(repo.turns.isNoRetention(HOST, 's-1', undefined), false);
  } finally { repo.close(); }
});

test('a distillation draft fixes its source version and refuses a second body for the same draft', () => {
  const repo = open();
  try {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    repo.workspaces.register(workspaceId, '甲工作区');
    const draft = repo.distillations.create({
      hostId: HOST, workspaceId, entryId: 'archive-1', entryVersion: 3, sourceContentHash: HASH,
      content: '提炼出的通用正文', knowledgeType: 'Practice', reason: '可复用结论', assessment: 'supported',
      category: null, importance: null, tags: null, entities: null,
      contentHash: 'd'.repeat(64),
    });
    assert.equal(draft.entryVersion, 3);
    assert.equal(draft.sourceContentHash, HASH, 'the source version is fixed at creation');
    assert.equal(repo.distillations.get(draft.draftId)?.content, '提炼出的通用正文');
    // An unknown draft is a not-found answer, not an empty record.
    assert.equal(repo.distillations.get('33333333-3333-4333-8333-333333333333'), null);
  } finally { repo.close(); }
});
