import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tempDir } from '../support/temp.ts';
import { MnemoWeaveError, WriteTaskAction } from '../../packages/core/contracts/src/index.ts';
import { TRIGGER_ACTIONS, TRIGGER_MAX_ACTIONS } from '../../packages/core/application/src/turn-budget.ts';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';

/**
 * A write task is only as narrow as its trigger allows.
 *
 * Two layers are checked here: the payload schema (shape, versions, which fields a trigger may
 * carry) and the trigger table the Server consults (which actions and how many). Both are contract:
 * a schema that accepted a draft plus a session, or a table that let a reply save withdraw, would
 * each widen what a narrow trigger can do.
 */

async function open(): Promise<SqliteCandidates> {
  const dir = await tempDir('write-task-trigger', 'task-trigger');
  return new SqliteCandidates(join(dir, 'governance.db'));
}

const base = {
  kind: 'formal-memory' as const,
  action: 'create' as const,
  reason: '用户要求记录',
  content: '可复用的工程结论。',
  assessment: 'supported' as const,
  evidenceRefs: ['tool:typecheck'],
};

test('a reply save may only add a formal memory', () => {
  assert.deepEqual(TRIGGER_ACTIONS['reply-save'], ['create', 'skip']);
  assert.equal(TRIGGER_MAX_ACTIONS['reply-save'], 1);
  assert.equal(WriteTaskAction.safeParse({ ...base, trigger: 'reply-save' }).success, true);
  // The schema still requires the version for an edit, so a reply save cannot silently overwrite:
  // the Server refuses the trigger before the action runs.
  const edit = WriteTaskAction.safeParse({
    ...base, trigger: 'reply-save', action: 'edit', memoryId: randomUUID(), entryVersion: 2,
  });
  assert.equal(edit.success, true, 'the payload is well-formed; the trigger table is what refuses it');
});

test('the archive distillation carries a draft and nothing else', () => {
  const draft = randomUUID();
  const parsed = WriteTaskAction.safeParse({
    kind: 'formal-memory', trigger: 'archive-distill', action: 'create', draftId: draft,
    reason: '用户确认共享', evidenceRefs: [`confirm:${draft}`], assessment: 'supported',
  });
  assert.equal(parsed.success, true);
  // A distillation never names a session or turn; the draft already fixes the source.
  assert.equal(WriteTaskAction.safeParse({
    kind: 'formal-memory', trigger: 'archive-distill', action: 'create', draftId: draft,
    sessionId: 's-1', turnId: '1', reason: 'x', evidenceRefs: [`confirm:${draft}`], assessment: 'supported',
  }).success, false);
  // A draft is never combined with an explicit body: the draft supplies it.
  assert.equal(WriteTaskAction.safeParse({
    ...base, kind: 'formal-memory', trigger: 'archive-distill', action: 'create', draftId: draft, content: '显式正文',
  }).success, false);
});

test('an idle review changes one rule or adds one archive, never a formal memory', () => {
  assert.deepEqual(TRIGGER_ACTIONS['idle-review'], ['create', 'edit', 'remove', 'skip']);
  // Two slots, one per kind: a rule change and a new archive.
  assert.equal(TRIGGER_MAX_ACTIONS['idle-review'], 2);
  // A rule change requires the run the signs it.
  assert.equal(WriteTaskAction.safeParse({
    kind: 'rule', trigger: 'idle-review', action: 'create', body: '新准则', reason: '用户明确要求',
  }).success, false);
  const withRun = WriteTaskAction.safeParse({
    kind: 'rule', trigger: 'idle-review', runId: randomUUID(), action: 'create', body: '新准则', reason: '用户明确要求',
  });
  assert.equal(withRun.success, true);
  // An archive create also needs the run, and may not name a workspace.
  const archive = WriteTaskAction.safeParse({
    kind: 'workspace-archive', trigger: 'idle-review', runId: randomUUID(), action: 'create',
    title: '标题', body: '正文', evidence: '实测', reason: '可复用',
  });
  assert.equal(archive.success, true);
  assert.equal(WriteTaskAction.safeParse({
    kind: 'workspace-archive', trigger: 'idle-review', runId: randomUUID(), action: 'create',
    title: '标题', body: '正文', evidence: '实测', reason: '可复用', workspaceId: randomUUID(),
  }).success, false);
});

test('a conversation may correct or withdraw but must carry the version it read', () => {
  assert.deepEqual(TRIGGER_ACTIONS['conversation'], ['create', 'edit', 'withdraw', 'skip']);
  assert.equal(TRIGGER_MAX_ACTIONS['conversation'], 1);
  const memoryId = randomUUID();
  const edit = WriteTaskAction.safeParse({
    ...base, trigger: 'conversation', action: 'edit', memoryId, entryVersion: 3,
  });
  assert.equal(edit.success, true);
  // Without the version the action would overwrite whatever is current.
  assert.equal(WriteTaskAction.safeParse({
    ...base, trigger: 'conversation', action: 'edit', memoryId,
  }).success, false);
  // A withdrawal carries no body.
  assert.equal(WriteTaskAction.safeParse({
    kind: 'formal-memory', trigger: 'conversation', action: 'withdraw', memoryId, entryVersion: 3,
    reason: '用户明确撤回', evidenceRefs: ['user:withdraw'],
  }).success, true);
});

test('the organizer accepts up to eight actions and no more', () => {
  assert.equal(TRIGGER_MAX_ACTIONS['organize'], 8);
  assert.deepEqual(TRIGGER_ACTIONS['organize'], ['create', 'edit', 'withdraw', 'skip']);
});

test('a receipt for one host never exposes another host\'s task', async () => {
  const repo = await open();
  try {
    const taskId = randomUUID();
    repo.writeTasks.claim({ hostId: 'host-a', taskId, index: 0, kind: 'formal-memory', action: 'create', requestHash: 'a'.repeat(64) });
    repo.writeTasks.settle('host-a', taskId, 0, { status: 'published', memoryId: 'm-1', entryVersion: 1 });
    assert.equal(repo.writeTasks.receipt('host-a', taskId, 0)?.status, 'published');
    assert.equal(repo.writeTasks.receipt('host-b', taskId, 0), null);
    assert.deepEqual(repo.writeTasks.taskReceipts('host-b', taskId), []);
  } finally { repo.close(); }
});

test('an unknown action shape is invalid input, not a permissive default', () => {
  assert.throws(() => WriteTaskAction.parse({ kind: 'formal-memory', trigger: 'conversation', action: 'create' }), (error: unknown) => error instanceof Error);
  assert.equal(WriteTaskAction.safeParse({ kind: 'formal-memory', trigger: 'conversation', action: 'create', reason: 'x', content: 'y', assessment: 'supported', evidenceRefs: [] }).success, false);
  assert.equal(WriteTaskAction.safeParse({ kind: 'invented', trigger: 'conversation', action: 'create' }).success, false);
});

void MnemoWeaveError;
