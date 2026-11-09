import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { MemoryWorkflow } from '../../packages/core/application/src/workflow.ts';
import { MemoryApplication } from '../../packages/core/application/src/index.ts';
import { RememberInput, SemanticAssessment } from '../../packages/core/contracts/src/index.ts';
import type { WriteProvider, ModelGateway, WorkflowRepository } from '../../packages/core/application/src/workflow-ports.ts';

const checks = Object.fromEntries(['source', 'accuracy', 'reuse', 'scope', 'duplication', 'consistency'].map(key => [key, { result: 'pass', reason: 'Test fixture assessment' }]));
const assessment = () => SemanticAssessment.parse({ checks, requiresHuman: false, conflict: 'none', summary: 'Test only; not real technical validation.' });
const request = (key = 'workflow-test-001') => RememberInput.parse({
  idempotencyKey: key, content: `Workflow immutable ${key}`, knowledgeType: 'Practice',
  provenance: { source: 'contract-test', sourceReference: 'fixture:1', evidence: ['fixture'], verificationStatus: 'verified', confidence: 0.5, applicability: 'test only', limitations: 'not production knowledge', lastVerified: '2026-11-08T00:00:00Z' },
});
async function setup() {
  await mkdir('work/tests', { recursive: true });
  const root = await mkdtemp(resolve('work/tests/workflow-'));
  const path = join(root, 'governance.db');
  const repo = new SqliteCandidates(path);
  const memories = new Map<string, string>();
  let writes = 0;
  const provider: WriteProvider = {
    async health() { return {}; },
    async recall() { return { memories: [] }; },
    async inspectExact(content) { return { complete: true, matches: [...memories].filter(([, text]) => text === content).map(([id, text]) => ({ id, content: text })) }; },
    async verifyContent(id, content) { return memories.get(id) === content; },
    async persistReviewed(content) { const id = `memory-${++writes}`; memories.set(id, content); return { id, action: 'added' }; },
  };
  const gateway: ModelGateway = { async assess() { return assessment(); } };
  return { root, path, repo, provider, gateway, memories, writes: () => writes };
}

test('Auto review enqueues approved task atomically and persists a verified execution receipt', async () => {
  const t = await setup();
  try {
    const candidate = t.repo.submit(request());
    await new MemoryWorkflow(t.repo, t.provider, t.gateway).tick();
    const result = t.repo.get(candidate.id);
    assert.equal(result.status, 'persisted');
    assert.equal(t.writes(), 1);
    assert.equal(result.reviews.length, 1);
    assert.equal((result.executionReceipts[0] as { status: string }).status, 'persisted');
    const inspect = new DatabaseSync(t.path);
    try {
      assert.equal(inspect.prepare('SELECT count(*) n FROM governance_tasks').get()!['n'], 1);
      assert.equal(inspect.prepare('SELECT count(*) n FROM governance_runs').get()!['n'], 1);
      // Outbox is an enqueue journal: one row per task, no independent dispatch states.
      assert.equal(inspect.prepare('SELECT count(*) n FROM governance_outbox').get()!['n'], 1);
      assert.equal(inspect.prepare("SELECT count(*) n FROM pragma_table_info('governance_outbox') WHERE name='state'").get()!['n'], 0);
    } finally { inspect.close(); }
  } finally { t.repo.close(); }
});

test('Missing/malformed/uncertain model, important/global knowledge and conflicts never auto approve', async () => {
  for (const kind of ['missing', 'invalid', 'uncertain', 'architecture', 'global', 'conflict', 'unverified']) {
    const t = await setup();
    try {
      const input = request();
      if (kind === 'architecture') input.knowledgeType = 'Architecture';
      if (kind === 'global') input.scope = 'global';
      if (kind === 'unverified') input.provenance.verificationStatus = 'unverified';
      const candidate = t.repo.submit(input);
      const gateway: ModelGateway | undefined = kind === 'missing' ? undefined : { async assess() {
        if (kind === 'invalid') throw new Error('bad model');
        const output = assessment();
        if (kind === 'uncertain') output.checks.accuracy.result = 'uncertain';
        if (kind === 'conflict') output.conflict = 'factual';
        return output;
      } };
      await new MemoryWorkflow(t.repo, t.provider, gateway).tick();
      assert.equal(t.repo.get(candidate.id).status, 'needs_review', kind);
      assert.equal(t.writes(), 0, kind);
      if (kind === 'conflict') {
        const app = new MemoryApplication({ ...t.provider, async health() { return { ready: true, version: '0.2.13', capabilities: ['health'] }; } }, t.repo, t.repo);
        await assert.rejects(app.humanReview({ candidateId: candidate.id, decision: 'approve', reason: 'cannot bypass conflict resolution' }, 'operator'));
        const inspect = new DatabaseSync(t.path);
        try { assert.equal(inspect.prepare('SELECT kind FROM governance_review_tasks').get()!['kind'], 'conflict'); } finally { inspect.close(); }
      }
    } finally { t.repo.close(); }
  }
});

test('Exact duplicates and clear lack of reuse are rejected without writes', async () => {
  for (const kind of ['duplicate', 'reuse']) {
    const t = await setup();
    try {
      const candidate = t.repo.submit(request());
      if (kind === 'duplicate') {
        await new MemoryWorkflow(t.repo, t.provider, t.gateway).tick();
        const duplicate = t.repo.submit({ ...candidate.request, idempotencyKey: 'workflow-known-duplicate' });
        await new MemoryWorkflow(t.repo, t.provider, t.gateway).tick();
        assert.equal(t.repo.get(duplicate.id).status, 'rejected'); assert.equal(t.writes(), 1); continue;
      }
      const gateway: ModelGateway = { async assess() { const result = assessment(); result.checks.reuse.result = 'fail'; return result; } };
      await new MemoryWorkflow(t.repo, t.provider, gateway).tick();
      assert.equal(t.repo.get(candidate.id).status, 'rejected'); assert.equal(t.writes(), 0);
    } finally { t.repo.close(); }
  }
});
test('Identical content with unknown or different applicability is not silently rejected as duplicate', async () => {
  const t = await setup();
  try {
    const candidate = t.repo.submit(request()); t.memories.set('external-unknown', candidate.request.content);
    await new MemoryWorkflow(t.repo, t.provider, t.gateway).tick();
    assert.equal(t.repo.get(candidate.id).status, 'needs_review'); assert.equal(t.writes(), 0);
  } finally { t.repo.close(); }
});

test('Review/outbox transaction failure leaves approval, task and outbox all uncommitted', async () => {
  const t = await setup();
  try {
    const candidate = t.repo.submit(request());
    const inspect = new DatabaseSync(t.path);
    inspect.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON governance_outbox BEGIN SELECT RAISE(ABORT,'outbox failure'); END");
    assert.throws(() => t.repo.review(candidate.id, 'approve', 'operator', 'fixture', null));
    assert.equal(t.repo.get(candidate.id).status, 'pending_review');
    assert.equal(t.repo.get(candidate.id).reviews.length, 0);
    assert.equal(inspect.prepare('SELECT count(*) n FROM governance_tasks').get()!['n'], 0);
    inspect.close();
  } finally { t.repo.close(); }
});

test('Interrupted write checkpoint reconciles a commit after repository restart without reissuing write', async () => {
  const t = await setup();
  const candidate = t.repo.submit(request());
  t.repo.review(candidate.id, 'approve', 'operator', 'fixture', null);
  assert.equal(t.repo.acquire('old-worker', 90000), true);
  const job = t.repo.claim('old-worker')!;
  t.repo.writing(job);
  const actual = await t.provider.persistReviewed(candidate.request.content, job.writeKey);
  t.repo.close();
  const inject = new DatabaseSync(t.path); inject.exec('UPDATE governance_workflow_lock SET until_ms=0'); inject.close();
  const reopened = new SqliteCandidates(t.path);
  try {
    await new MemoryWorkflow(reopened, t.provider, t.gateway).tick();
    const result = reopened.get(candidate.id);
    assert.equal(result.status, 'persisted'); assert.equal(t.writes(), 1);
    assert.equal((result.executionReceipts[0] as { providerMemoryId: string }).providerMemoryId, actual.id);
  } finally { reopened.close(); }
});

test('Unknown outcome with no matched memory is held for explicit retry, not replayed automatically', async () => {
  const t = await setup();
  try {
    const candidate = t.repo.submit(request());
    t.repo.review(candidate.id, 'approve', 'operator', 'fixture', null);
    assert.equal(t.repo.acquire('abandoned', 90000), true);
    t.repo.writing(t.repo.claim('abandoned')!); t.repo.release('abandoned');
    await new MemoryWorkflow(t.repo, t.provider).tick();
    assert.equal(t.repo.get(candidate.id).status, 'failed'); assert.equal(t.writes(), 0);
    await new MemoryWorkflow(t.repo, t.provider).tick(); assert.equal(t.writes(), 0);
    t.repo.retry(candidate.id, 'operator', 'Confirmed original writer stopped and no commit occurred');
    await new MemoryWorkflow(t.repo, t.provider).tick();
    assert.equal(t.repo.get(candidate.id).status, 'persisted'); assert.equal(t.writes(), 1);
  } finally { t.repo.close(); }
});

test('Lease fences stale workers and serializes provider dispatch across repository connections', async () => {
  const t = await setup(); const other = new SqliteCandidates(t.path);
  try {
    const candidate = t.repo.submit(request()); t.repo.review(candidate.id, 'approve', 'operator', 'fixture', null);
    assert.equal(t.repo.acquire('first', 90000), true); const stale = t.repo.claim('first')!;
    assert.equal(other.acquire('second', 90000), false);
    const inject = new DatabaseSync(t.path); inject.exec('UPDATE governance_workflow_lock SET until_ms=0'); inject.close();
    assert.equal(other.acquire('second', 90000), true);
    assert.throws(() => t.repo.writing(stale));
    assert.throws(() => t.repo.finish(stale, { id: 'bad', action: 'added' }, false));
    other.release('second');
  } finally { other.close(); t.repo.close(); }
});

test('Amend preserves original input and records both sides; provider binding prevents wrong-store resume', async () => {
  const t = await setup();
  try {
    const original = t.repo.submit(request()); t.repo.review(original.id, 'human', 'rules', 'needs clarification', null);
    const replacement = t.repo.amend(original.id, { ...request('workflow-amended-001'), content: 'Clarified scope and evidence' }, 'operator', 'corrected scope');
    assert.equal(t.repo.get(original.id).request.content, original.request.content);
    assert.equal(t.repo.get(original.id).status, 'rejected'); assert.equal(replacement.status, 'pending_review');
    assert.ok(replacement.reviews.length > 0);
    t.repo.bindProvider('store-A'); assert.throws(() => t.repo.bindProvider('store-B'));
    const backups = (await readdir(t.root)).filter(name => name.includes('pre-v2'));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(t.root, backups[0]!), { readOnly: true });
    try { assert.equal(backup.prepare('PRAGMA user_version').get()!['user_version'], 1); } finally { backup.close(); }
  } finally { t.repo.close(); }
});
test('A pre-write Provider outage retries the same durable task without duplicate dispatch', async () => {
  const t = await setup();
  try {
    const candidate = t.repo.submit(request());
    t.repo.review(candidate.id, 'approve', 'operator', 'fixture', null);
    let healthCalls = 0;
    const provider: WriteProvider = { ...t.provider, async health() { if (++healthCalls === 1) throw new Error('pre-write outage'); return {}; } };
    const workflow = new MemoryWorkflow(t.repo, provider);
    await workflow.tick();
    const failed = t.repo.get(candidate.id);
    assert.equal(failed.status, 'failed'); assert.equal(t.writes(), 0);
    const inject = new DatabaseSync(t.path); inject.exec('UPDATE governance_tasks SET next_at=0'); inject.close();
    await workflow.tick();
    const persisted = t.repo.get(candidate.id);
    assert.equal(persisted.status, 'persisted'); assert.equal(t.writes(), 1);
    assert.equal(persisted.task!.id, failed.task!.id);
    assert.equal(persisted.executionReceipts.length, 2);
    assert.equal(persisted.executionReceipts[0]!.writeKey, persisted.executionReceipts[1]!.writeKey);
  } finally { t.repo.close(); }
});

test('Non-model recoverable failures keep retrying with capped backoff and alert once past 24 hours', async () => {
  const t = await setup();
  try {
    const candidate = t.repo.submit(request());
    t.repo.review(candidate.id, 'approve', 'operator', 'fixture', null);
    const provider: WriteProvider = { ...t.provider, async health() { throw new Error('persistent outage'); } };
    const workflow = new MemoryWorkflow(t.repo, provider);
    const stderr: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      // TASK-04: no attempt cap — every due retry schedules a new attempt with exponential
      // backoff capped at 15 minutes, well beyond the old three-attempt abandonment.
      for (let attempt = 1; attempt <= 4; attempt++) {
        await workflow.tick();
        const record = t.repo.get(candidate.id);
        assert.equal(record.status, 'failed');
        assert.equal(record.task!.attempts, attempt);
        assert.ok(record.task!.next_at !== null, `attempt ${attempt} scheduled`);
        const expected = Math.min(2000 * 2 ** (attempt - 1), 900000);
        assert.ok(Math.abs(record.task!.next_at! - Date.now() - expected) < 5000, `attempt ${attempt} backoff ${record.task!.next_at! - Date.now()}`);
        if (attempt < 4) {
          const inject = new DatabaseSync(t.path); inject.exec('UPDATE governance_tasks SET next_at=0'); inject.close();
        }
      }
      assert.equal(stderr.filter(line => line.includes('task_retry_alert')).length, 0);
      // A failure older than 24 hours alerts once and keeps the task scheduled, not abandoned.
      const inject = new DatabaseSync(t.path);
      inject.exec(`UPDATE governance_tasks SET next_at=0, first_failed_at=${Date.now() - 86_500_000}`);
      inject.close();
      await workflow.tick();
      assert.equal(t.repo.get(candidate.id).status, 'failed');
      assert.ok(t.repo.get(candidate.id).task!.next_at !== null, 'still scheduled for recovery');
      const alertsAfterFirst = stderr.filter(line => line.includes('task_retry_alert')).length;
      assert.equal(alertsAfterFirst, 1);
      const injectAgain = new DatabaseSync(t.path); injectAgain.exec('UPDATE governance_tasks SET next_at=0'); injectAgain.close();
      await workflow.tick();
      assert.equal(stderr.filter(line => line.includes('task_retry_alert')).length, alertsAfterFirst, 'alert not repeated per retry');
      assert.equal(t.writes(), 0);
    } finally { process.stderr.write = originalWrite; }
  } finally { t.repo.close(); }
});

test('Background model reviews run concurrently with at most two in-flight assessments', async () => {
  const t = await setup();
  try {
    const first = t.repo.submit(request('workflow-parallel-001'));
    const second = t.repo.submit(request('workflow-parallel-002'));
    let inFlight = 0; let peak = 0;
    const gateway: ModelGateway = { async assess() { inFlight++; peak = Math.max(peak, inFlight); await new Promise(resolve => setTimeout(resolve, 30)); inFlight--; return assessment(); } };
    const workflow = new MemoryWorkflow(t.repo, t.provider, gateway);
    await workflow.tick();
    assert.equal(peak, 2);
    assert.equal(t.repo.get(first.id).status, 'persisted');
    assert.equal(t.repo.get(second.id).status, 'approved');
    // Writes stay serialized behind the concurrent reviews: the next tick drains the second task.
    await workflow.tick();
    assert.equal(t.repo.get(second.id).status, 'persisted');
    assert.equal(t.writes(), 2);
  } finally { t.repo.close(); }
});

test('A v1 database with real candidate data upgrades, backs up, and preserves legacy idempotency', async () => {
  await mkdir('work/tests', { recursive: true });
  const root = await mkdtemp(resolve('work/tests/migration-')); const path = join(root, 'governance.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE governance_candidates(id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,request_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status='pending_review'),submitted_at TEXT NOT NULL) STRICT;
    CREATE TABLE governance_submission_receipts(id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL UNIQUE REFERENCES governance_candidates(id),status TEXT NOT NULL CHECK(status='candidate')) STRICT; PRAGMA user_version=1;`);
  const input = request('legacy-input-001'); const { scope: _newDefault, ...oldInput } = input;
  const id = randomUUID(); const receiptId = randomUUID();
  legacy.prepare('INSERT INTO governance_candidates VALUES(?,?,?,?,?,?)').run(id, input.idempotencyKey, 'legacy-hash', JSON.stringify(oldInput), 'pending_review', '2026-11-08T00:00:00Z');
  legacy.prepare('INSERT INTO governance_submission_receipts VALUES(?,?,?)').run(receiptId, id, 'candidate'); legacy.close();
  const upgraded = new SqliteCandidates(path);
  try { assert.equal(upgraded.submit(input).id, id); assert.equal(upgraded.get(id).receipt.id, receiptId); } finally { upgraded.close(); }
  const backupPath = join(root, (await readdir(root)).find(name => name.includes('pre-v2'))!);
  const inspect = new DatabaseSync(backupPath, { readOnly: true });
  try { assert.equal(inspect.prepare('SELECT id FROM governance_candidates').get()!['id'], id); assert.equal(inspect.prepare('PRAGMA user_version').get()!['user_version'], 1); } finally { inspect.close(); }
});

test('Lease owner runs the retention sweep at most once per interval', async () => {
  let sweeps = 0;
  const repo = {
    acquire: () => true, renew: () => true, release: () => {},
    pending: () => undefined, claim: () => undefined,
    sweepRetention: () => { sweeps++; },
  } as unknown as WorkflowRepository;
  const workflow = new MemoryWorkflow(repo, {} as WriteProvider, undefined, 90_000, undefined, 2, undefined, 60_000);
  await workflow.tick();
  await workflow.tick();
  assert.equal(sweeps, 1);
});

test('Retention sweep failure is logged and does not fail the workflow tick', async () => {
  const repo = {
    acquire: () => true, renew: () => true, release: () => {},
    pending: () => undefined, claim: () => undefined,
    sweepRetention: () => { throw new Error('sweep failed'); },
  } as unknown as WorkflowRepository;
  const workflow = new MemoryWorkflow(repo, {} as WriteProvider, undefined, 90_000, undefined, 2, undefined, 0);
  await assert.doesNotReject(workflow.tick());
});

test('Approved writes drain before a long background review completes', async () => {
  const t = await setup();
  try {
    const ready = t.repo.submit(request('workflow-priority-ready'));
    t.repo.review(ready.id, 'approve', 'fixture-operator', 'fixture', null);
    const pending = t.repo.submit(request('workflow-priority-pending'));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slowGateway: ModelGateway = { async assess() { await gate; return assessment(); } };
    const workflow = new MemoryWorkflow(t.repo, t.provider, slowGateway);
    const tick = workflow.tick();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(t.repo.get(ready.id).status, 'persisted');
    assert.equal(t.repo.get(pending.id).status, 'pending_review');
    release();
    await tick;
    assert.equal(t.repo.get(pending.id).status, 'persisted');
  } finally { t.repo.close(); }
});
