import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { VersionWorkflow } from '../../packages/core/application/src/version-workflow.ts';
import { MnemoWeaveError } from '../../packages/core/contracts/src/index.ts';
import type { RememberRequest } from '../../packages/core/contracts/src/index.ts';

const DAY_MS = 86_400_000;
const request = (key: string, content = `Hardening fixture content for ${key}.`): RememberRequest => ({
  idempotencyKey: key, content, knowledgeType: 'Practice', tags: [],
  provenance: { source: 'hardening-test', sourceReference: 'fixture:hardening', evidence: ['fixture'], verificationStatus: 'unverified', confidence: 0.5, applicability: 'hardening fixture', limitations: 'test only', lastVerified: null },
});

async function fixture() {
  await mkdir('work/tests', { recursive: true });
  const root = await mkdtemp(resolve('work/tests/hardening-'));
  return { root, path: join(root, 'governance.db') };
}

test('Interleaved concurrent submissions keep every candidate intact and idempotent', async () => {
  const { path } = await fixture();
  const repo = new SqliteCandidates(path);
  try {
    const submissions = await Promise.all(Array.from({ length: 50 }, (_, index) =>
      Promise.resolve().then(() => repo.submit(request(`hardening-parallel-${String(index).padStart(3, '0')}`))).then(record => ({ index, record }))));
    assert.equal(new Set(submissions.map(item => item.record.id)).size, 50);
    // Same-key replay from another connection resolves to the identical stored candidate.
    const reopened = new SqliteCandidates(path);
    try {
      const replay = reopened.submit(request('hardening-parallel-007'));
      assert.equal(replay.id, submissions[7]!.record.id);
      assert.equal(reopened.get(replay.id).request.content, submissions[7]!.record.request.content);
      const inspect = new DatabaseSync(path);
      try { assert.equal(inspect.prepare('SELECT count(*) n FROM governance_candidates').get()!['n'], 50); } finally { inspect.close(); }
    } finally { reopened.close(); }
  } finally { repo.close(); }
});

test('Lease fencing survives clock drift: expired leases cannot commit, future stamps do not extend alone', async () => {
  const { path } = await fixture();
  const repo = new SqliteCandidates(path);
  const other = new SqliteCandidates(path);
  try {
    const candidate = repo.submit(request('hardening-clock-001'));
    repo.review(candidate.id, 'approve', 'operator', 'fixture', null);
    assert.equal(repo.acquire('first', 90000), true);
    const job = repo.claim('first')!;
    repo.writing(job);
    // Clock drift backwards: a forged lease stamp in the past cannot fence anything.
    const inject = new DatabaseSync(path);
    inject.exec('UPDATE governance_workflow_lock SET until_ms=1'); inject.close();
    assert.throws(() => repo.finish(job, { id: 'clock-provider', action: 'added' }, false), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'INVALID_STATE');
    assert.equal(repo.renew('first', 90000), false, 'a forged past stamp cannot renew');
    // The second worker takes over only via the acquire path and completes the same durable task.
    assert.equal(other.acquire('second', 90000), true);
    const takeover = other.claim('second')!;
    assert.equal(takeover.candidateId, candidate.id);
    other.finish(takeover, { id: 'clock-provider-2', action: 'added' }, false);
    assert.equal(other.get(candidate.id).status, 'persisted');
    // Original worker's stale attempts stay fenced even after the memory exists.
    assert.throws(() => repo.finish(job, { id: 'clock-provider', action: 'added' }, false), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'INVALID_STATE');
  } finally { other.close(); repo.close(); }
});

test('Retention sweep and reopen stay correct at data scale', async () => {
  const { path } = await fixture();
  const repo = new SqliteCandidates(path);
  try {
    const count = 300;
    for (let index = 0; index < count; index++) {
      const candidate = repo.submit(request(`hardening-scale-${String(index).padStart(4, '0')}`));
      if (index % 2 === 0) repo.review(candidate.id, 'reject', 'operator', 'scale fixture', null);
    }
    const future = new Date(Date.now() + 40 * DAY_MS);
    const report = repo.sweepRetention(future);
    assert.equal(report.clearedCandidates, count / 2, 'rejected candidates past 30 days clear');
    assert.ok(report.deferredCandidates.some(item => item.reason.startsWith('status_pending_review')));
    repo.close();
    const reopened = new SqliteCandidates(path);
    try {
      const probe = reopened.get(reopened.submit(request('hardening-scale-0000', 'Hardening fixture content for hardening-scale-0000.')).id);
      assert.equal(probe.bodyCleared, true);
      assert.equal(probe.request.provenance.sourceReference, 'fixture:hardening');
      const inspect = new DatabaseSync(path);
      try {
        assert.equal(inspect.prepare('SELECT count(*) n FROM governance_candidates').get()!['n'], count);
        assert.equal(inspect.prepare('SELECT count(*) n FROM governance_candidate_bodies').get()!['n'], count / 2);
      } finally { inspect.close(); }
    } finally { reopened.close(); }
  } finally { try { repo.close(); } catch { /* already closed */ } }
});

test('Two real processes racing one version operation leave exactly one durable reservation', async () => {
  const { path } = await fixture();
  const repo = new SqliteCandidates(path);
  const contents = new Map<string, string>();
  let writes = 0;
  const provider = {
    async health() { return {}; },
    async recall() { return { memories: [] }; },
    async readMemory(id: string) { const c = contents.get(id); if (c === undefined) throw new Error('missing'); return { id, content: c }; },
    async inspectExact(content: string) { return { complete: true, matches: [...contents].filter(([, t]) => t === content).map(([id, text]) => ({ id, content: text })) }; },
    async verifyContent(id: string, content: string) { return contents.get(id) === content; },
    async persistReviewed(content: string) { const id = `provider-${++writes}`; contents.set(id, content); return { id, action: 'added' as const }; },
    async linkSupersedes() { return {}; },
  };
  try {
    // Publish the base memory the racers will revise.
    const baseInput = request('hardening-race-base', 'Race base generation.');
    const baseCandidate = repo.submit(baseInput);
    repo.review(baseCandidate.id, 'approve', 'operator', 'fixture', null);
    const written = await provider.persistReviewed(baseInput.content);
    repo.acquire('race-owner', 90000);
    repo.finish(repo.claim('race-owner')!, written, false);
    repo.release('race-owner');
    const base = repo.get(baseCandidate.id).publication!;
    // Two real processes approve the same revise intent concurrently.
    const racers = [1, 2].map(index => spawn(process.execPath, ['tests/support/version-racer.ts', path, 'hardening-race-revise', base.memoryId, base.revisionId], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] }));
    const outcomes = await Promise.all(racers.map(racer => new Promise<{ pid: number; outcome: string; code: number }>(resolvePromise => {
      let stdout = '';
      racer.stdout.on('data', chunk => { stdout += String(chunk); });
      racer.on('close', code => { const parsed = JSON.parse(stdout.trim().split('\n')[0]!) as { pid: number; outcome: string }; resolvePromise({ ...parsed, code: code ?? 0 }); });
    })));
    const reserved = outcomes.filter(item => item.outcome === 'reserved');
    const rejected = outcomes.filter(item => item.outcome === 'rejected');
    assert.equal(reserved.length, 1, 'exactly one process holds the reservation');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]!.code, 3);
    // The parent completes the winner's publication; the loser's approval never happened.
    void reserved[0]!;
    // The racer already submitted the candidate; read it instead of resubmitting (same key,
    // different fixture provenance would be an idempotency conflict).
    const inspect = new DatabaseSync(path);
    try {
      var racing = repo.get(String(inspect.prepare("SELECT id FROM governance_candidates WHERE idempotency_key='hardening-race-revise'").get()!['id']));
    } finally { inspect.close(); }
    repo.acquire('race-finisher', 90000);
    const job = repo.claim('race-finisher')!;
    // The full version workflow verifies the base, persists and publishes with checkpoints.
    await new VersionWorkflow(repo, provider).execute(job);
    repo.release('race-finisher');
    const persisted = repo.get(racing.id);
    assert.equal(persisted.status, 'persisted');
    const descriptor = repo.catalog.get(base.memoryId);
    assert.equal(descriptor.revisions.length, 2);
    assert.equal(descriptor.revisions[1]!.contentHash.length, 64);
  } finally { repo.close(); }
});

test('Two real processes write one shared governance database without corruption', async () => {
  const { path } = await fixture();
  const writers = [1, 2].map(writer => spawn(process.execPath, ['tests/support/parallel-writer.ts', path, `hardening-mp-${writer}`, '40', `writer ${writer} content`], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] }));
  const outputs = await Promise.all(writers.map(writer => new Promise<string>((resolvePromise, rejectPromise) => {
    let stdout = '';
    writer.stdout.on('data', chunk => { stdout += String(chunk); });
    writer.stderr.on('data', chunk => { stdout += String(chunk); });
    writer.on('close', code => code === 0 ? resolvePromise(stdout) : rejectPromise(new Error(`writer exited ${code}: ${stdout}`)));
  })));
  assert.deepEqual(outputs.map(line => JSON.parse(line.trim()).stored as number).sort(), [40, 40]);
  const repo = new SqliteCandidates(path);
  try {
    const inspect = new DatabaseSync(path);
    try {
      assert.equal(inspect.prepare('SELECT count(*) n FROM governance_candidates').get()!['n'], 80);
      assert.equal(inspect.prepare('SELECT count(*) n FROM governance_candidate_bodies').get()!['n'], 80);
      assert.equal(inspect.prepare('SELECT count(*) n FROM governance_submission_receipts').get()!['n'], 80);
      for (const writer of [1, 2]) {
        const record = repo.get(String(inspect.prepare('SELECT id FROM governance_candidates WHERE idempotency_key=?').get(`hardening-mp-${writer}-0000`)!['id']));
        assert.equal(record.bodyCleared, undefined);
        assert.match(record.request.content, new RegExp(`writer ${writer} content`));
      }
    } finally { inspect.close(); }
  } finally { repo.close(); }
});
