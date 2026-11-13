import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tempDir } from '../support/temp.ts';
import { WriteReceiptJournal } from '../../plugins/dsh-mnemo-weave/src/ui/write-receipts.ts';
import { IdleSkipJournal } from '../../plugins/dsh-mnemo-weave/src/ui/idle-skips.ts';
import { WriteTransactions, WriteRefused } from '../../plugins/dsh-mnemo-weave/src/ui/write-transactions.ts';
import { replyTaskId, replyText } from '../../plugins/dsh-mnemo-weave/src/client/reply-save-model.ts';
import { createTaskRunner } from '../../plugins/dsh-mnemo-weave/src/ui/task-runner.ts';
import { groupIdleReview } from '../../plugins/dsh-mnemo-weave/src/client/view-model.ts';
import { parseDiagnosticJob, parseWriteTaskReceipt } from '../../plugins/dsh-mnemo-weave/src/ui/memory-source.ts';

/**
 * A confirmed write must happen once, and a page reopened after a crash must be able to find out
 * what happened to it. These tests pin the three parts that make that true: the journal keeps the
 * request per key, the transaction resolves that key instead of minting a new one, and the reply
 * button always derives the same key from the same reply.
 */

async function journal(): Promise<WriteReceiptJournal> {
  const dir = await tempDir('write-receipts', 'journal');
  return new WriteReceiptJournal(dir);
}

/** A source whose write-task entry replays `outcome` and counts how often it was asked. */
function source(outcome: () => Promise<Record<string, unknown>>) {
  const calls: Array<{ taskId: string; index: number }> = [];
  return {
    calls,
    source: {
      writeTaskAction: async (taskId: string, index: number, _request?: Record<string, unknown>): Promise<Record<string, unknown>> => {
        calls.push({ taskId, index });
        return outcome();
      },
      writeTaskReceipt: async (taskId: string, index: number): Promise<Record<string, unknown>> => { calls.push({ taskId, index }); return outcome(); },
      unsettledWriteTasks: async () => [],
    },
  };
}

const RECEIPT = {
  taskId: '11111111-1111-4111-8111-111111111111', index: 0,
  kind: 'formal-memory', action: 'create', status: 'published',
  memoryId: '22222222-2222-4222-8222-222222222222', entryId: null, entryVersion: 1,
  candidateId: null, errorCode: null, updatedAt: '2026-11-13T00:00:00.000Z',
};

test('one submission is recorded once and a repeat returns the recorded result', async () => {
  const store = await journal();
  const stub = source(async () => RECEIPT);
  const writes = new WriteTransactions(stub.source as never, store);
  const taskId = '11111111-1111-4111-8111-111111111111';
  const first = await writes.submit({ taskId, index: 0, kind: 'formal-memory', action: 'create', request: { content: 'x' } });
  assert.equal(first.status, 'published');
  assert.equal(stub.calls.length, 1);
  // The second call answers from the journal: no second request reaches the Server.
  const second = await writes.submit({ taskId, index: 0, kind: 'formal-memory', action: 'create', request: { content: 'x' } });
  assert.equal(second.status, 'published');
  assert.equal(stub.calls.length, 1);
});

test('a lost response leaves the action pending, and resolving it never resubmits', async () => {
  const store = await journal();
  let attempt = 0;
  const stub = source(async () => {
    attempt += 1;
    if (attempt === 1) throw Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
    return RECEIPT;
  });
  const writes = new WriteTransactions(stub.source as never, store);
  const taskId = '11111111-1111-4111-8111-111111111111';
  await assert.rejects(() => writes.submit({ taskId, index: 0, kind: 'formal-memory', action: 'create', request: { content: 'x' } }));
  // The entry is still unsettled, so the page can offer both the check and the replay.
  const pending = await writes.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.status, 'pending');
  const resolved = await writes.resolve(taskId, 0);
  assert.equal(resolved.status, 'published');
  // Resolution read the receipt; it did not execute the action again.
  assert.equal(stub.calls.length, 2);
});

test('a refusal before the key is claimed is final and is not left pending', async () => {
  const store = await journal();
  const stub = source(async () => { throw Object.assign(new Error('no retention'), { code: 'TURN_NO_RETENTION' }); });
  const writes = new WriteTransactions(stub.source as never, store);
  await assert.rejects(
    () => writes.submit({ taskId: '11111111-1111-4111-8111-111111111111', index: 0, kind: 'rule', action: 'create', request: {} }),
    (error: unknown) => error instanceof WriteRefused && error.code === 'TURN_NO_RETENTION',
  );
  assert.deepEqual((await writes.pending()).map(row => row.status), ['failed']);
});

test('the recorded request is what a retry resends, verbatim', async () => {
  const store = await journal();
  const seen: Array<Record<string, unknown>> = [];
  const stub = source(async () => RECEIPT);
  const original = stub.source.writeTaskAction;
  stub.source.writeTaskAction = async (taskId: string, index: number, request?: Record<string, unknown>) => {
    seen.push(request ?? {});
    return original(taskId, index);
  };
  stub.source.writeTaskReceipt = async () => { throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' }); };
  const writes = new WriteTransactions(stub.source as never, store);
  const taskId = '11111111-1111-4111-8111-111111111111';
  writes.prepare([{ taskId, index: 0, kind: 'formal-memory', action: 'create', request: { content: 'x', reason: 'r' } }]);
  await writes.retry(taskId, 0);
  await writes.retry(taskId, 0);
  assert.deepEqual(seen[0], { content: 'x', reason: 'r' });
  // The replay carries the identical payload: the Server can only see a replay, not a new write.
  assert.equal(seen.length, 1);
});

test('a reply save derives the same task id for the same reply', () => {
  const first = replyTaskId('s-1', 'm-1');
  assert.equal(first, replyTaskId('s-1', 'm-1'));
  assert.notEqual(first, replyTaskId('s-1', 'm-2'));
  assert.notEqual(first, replyTaskId('s-2', 'm-1'));
  // The Server validates it as a UUID, so the derived value has to be one.
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('reply lookup binds a completed assistant message to its actual session and turn', () => {
  const events = [
    { type: 'turn/start', data: { turn: 7 } },
    { type: 'assistant/message', data: { message: { id: 'message-42', content: [{ type: 'text', text: '结论' }] } } },
  ];
  const runner = createTaskRunner(() => ({ roots: () => [{ id: 's-1', session: { snapshotEvents: () => events } }] }));
  assert.equal(runner.completedReply?.('s-1', 'message-42'), null);
  events.push({ type: 'turn/end', data: { turn: 7 } });
  assert.deepEqual(runner.completedReply?.('s-1', 'message-42'), { text: '结论', turnId: '7' });
  assert.equal(runner.completedReply?.('s-2', 'message-42'), null);
});

test('a reply with no text blocks offers nothing to save', () => {
  assert.equal(replyText(undefined), null);
  assert.equal(replyText({ kind: 'assistant', blocks: [] }), null);
  assert.equal(replyText({ kind: 'assistant', blocks: [{ kind: 'reasoning', text: '想' }] }), null);
  assert.equal(replyText({ kind: 'assistant', blocks: [{ kind: 'text', text: '结论' }] }), '结论');
  // Only prose is saved; a reply that mixes reasoning and text keeps the text alone.
  assert.equal(replyText({ kind: 'assistant', blocks: [{ kind: 'reasoning', text: 'a' }, { kind: 'text', text: 'b' }] }), 'b');
});

test('idle runs group by session, newest first', () => {
  const run = (id: string, sessionId: string, startedAt: string) => ({
    id, sessionId, state: 'succeeded' as const, attempt: 1, startedAt,
    finishedAt: null, error: null, items: [],
  });
  const grouped = groupIdleReview([
    run('a', 's-1', '2026-11-13T01:00:00.000Z'),
    run('b', 's-2', '2026-11-13T03:00:00.000Z'),
    run('c', 's-1', '2026-11-13T02:00:00.000Z'),
  ]);
  assert.deepEqual(grouped.map(entry => entry.sessionId), ['s-2', 's-1']);
  assert.deepEqual(grouped[1]?.runs.map(item => item.id), ['c', 'a']);
});

test('a receipt with an unknown status or kind is a protocol error, not data', () => {
  const parsed = parseWriteTaskReceipt({ ...RECEIPT }, 0);
  assert.equal(parsed.status, 'published');
  for (const broken of [{ ...RECEIPT, status: 'done' }, { ...RECEIPT, kind: 'memory' }, { ...RECEIPT, action: 'merge' }]) {
    assert.throws(() => parseWriteTaskReceipt(broken, 0), (error: unknown) => (error as { code?: string }).code === 'PROVIDER_PROTOCOL');
  }
});

test('a backfill job keeps its detail so coverage movement survives a reload', () => {
  const job = parseDiagnosticJob({
    id: '33333333-3333-4333-8333-333333333333', kind: 'embedding-backfill', state: 'succeeded',
    startedAt: '2026-11-13T00:00:00.000Z', finishedAt: '2026-11-13T00:01:00.000Z',
    detail: { embeddedBefore: 2, embeddedAfter: 9, coverageAfter: 0.9 },
  }, 'job');
  assert.equal(job.state, 'succeeded');
  assert.equal(job.detail?.['embeddedAfter'], 9);
  assert.throws(() => parseDiagnosticJob({ state: 'done', startedAt: 'x', finishedAt: null }, 'job'),
    (error: unknown) => (error as { code?: string }).code === 'PROVIDER_PROTOCOL');
});

test('a damaged journal does not take the write path down with it', async () => {
  const dir = await tempDir('write-receipts', 'damaged');
  const store = new WriteReceiptJournal(dir);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, 'mnemoweave-write-receipts.json'), '{not json', 'utf8');
  // The Server still holds the receipts, so an unreadable local journal just means an empty one.
  assert.deepEqual(store.list(), []);
  const stub = source(async () => RECEIPT);
  const writes = new WriteTransactions(stub.source as never, store);
  const submitted = await writes.submit({ kind: 'rule', action: 'create', request: { body: 'x' } });
  assert.equal(submitted.status, 'published');
});

test('a decline is recorded once per session and reason, not once per tick', async () => {
  const dir = await tempDir('idle-skips', 'decline');
  const skips = new IdleSkipJournal(dir);
  skips.record({ sessionId: 's-1', reason: 'cooldown', at: '2026-11-13T00:00:00.000Z' });
  skips.record({ sessionId: 's-1', reason: 'cooldown', at: '2026-11-13T00:10:00.000Z' });
  const list = skips.list();
  assert.equal(list.length, 1);
  // The latest timestamp wins: the page shows the most recent time the condition held.
  assert.equal(list[0]?.at, '2026-11-13T00:10:00.000Z');
});

test('a decline cleared when a run starts, and a damaged file reads as no declines', async () => {
  const dir = await tempDir('idle-skips', 'clear');
  const skips = new IdleSkipJournal(dir);
  skips.record({ sessionId: 's-1', reason: 'no-route' });
  skips.record({ sessionId: 's-2', reason: 'attempts' });
  skips.clear('s-1');
  assert.deepEqual(skips.list().map(item => item.sessionId), ['s-2']);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, 'mnemoweave-idle-skips.json'), '{bad', 'utf8');
  assert.deepEqual(skips.list(), []);
});
