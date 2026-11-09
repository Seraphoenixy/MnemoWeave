import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { ARCHIVE_RETENTION_DAYS, CANDIDATE_BODY_RETENTION_DAYS, HOT_RETENTION_DAYS } from '../../packages/infrastructure/governance/src/events.ts';
import { MnemoWeaveError } from '../../packages/core/contracts/src/index.ts';
import type { RememberRequest } from '../../packages/core/contracts/src/index.ts';

const DAY_MS = 86_400_000;
const request = (key: string, content = 'Retention fixture content for candidate clearing.'): RememberRequest => ({
  idempotencyKey: key, content, knowledgeType: 'Practice', tags: [],
  scope: 'project',
  provenance: { source: 'retention-test', sourceReference: 'fixture:retention', evidence: ['fixture'], verificationStatus: 'unverified', confidence: 0.5, applicability: 'isolated retention fixture', limitations: 'not production knowledge', lastVerified: null },
});

const hostEvent = (overrides: Record<string, unknown> = {}) => ({
  protocolVersion: '1.0', adapterVersion: '1.0.0', eventId: 'event-0001-abcd', sessionId: 'session-a',
  kind: 'session.started', occurredAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
  sourceRef: 'native:hook:start', payload: {}, ...overrides,
});

async function fixture() {
  await mkdir('work/tests', { recursive: true });
  const root = await mkdtemp(resolve('work/tests/retention-'));
  const repo = new SqliteCandidates(join(root, 'governance.db'));
  return { root, repo };
}

test('Events normalize, dedup by stable identity and reject content conflicts', async () => {
  const { repo } = await fixture();
  try {
    const first = repo.events.record('host-a', hostEvent());
    assert.equal(first.status, 'stored');
    const replay = repo.events.record('host-a', hostEvent({ receivedAt: new Date().toISOString() }));
    assert.equal(replay.status, 'replayed');
    assert.throws(() => repo.events.record('host-a', hostEvent({ eventId: 'event-0001-abcd', kind: 'message.user', payload: { text: 'different content' } })), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'IDEMPOTENCY_CONFLICT');
    // Kind-specific payload validation: messages need text, session boundaries must not carry content.
    assert.throws(() => repo.events.record('host-a', hostEvent({ eventId: 'event-0002-abcd', kind: 'message.user', payload: {} })));
    assert.throws(() => repo.events.record('host-a', hostEvent({ eventId: 'event-0003-abcd', payload: { text: 'unexpected' } })));
    assert.throws(() => repo.events.record('host-a', hostEvent({ eventId: 'event-0004-abcd', protocolVersion: '2.0' })), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'INVALID_INPUT');
    // Crash recovery interruptions are explicit, inferred events.
    const crash = repo.events.record('host-a', hostEvent({ eventId: 'event-0005-abcd', kind: 'session.ended', inferred: true, occurredAt: new Date().toISOString() }));
    assert.equal(crash.status, 'stored');
    const stored = repo.events.get('host-a', 'event-0005-abcd');
    assert.equal(stored.inferred, true);
    assert.equal(stored.stage, 'hot');
  } finally { repo.close(); }
});

test('Default selection rule saves metadata, tool failures and candidate links, nothing else', async () => {
  const { repo } = await fixture();
  try {
    assert.equal(repo.events.record('host-a', hostEvent({ eventId: 'session-1-abcd' })).status, 'stored');
    assert.deepEqual(repo.events.get('host-a', 'session-1-abcd').payload, {});
    assert.equal(repo.events.record('host-a', hostEvent({ eventId: 'tool-ok-1-abcd', kind: 'tool.completed', payload: { toolName: 'read_file', outcome: 'success' } })).status, 'skipped');
    assert.equal(repo.events.record('host-a', hostEvent({ eventId: 'tool-fail-1-abcd', kind: 'tool.completed', payload: { toolName: 'write_file', outcome: 'failure' } })).status, 'stored');
    assert.equal(repo.events.record('host-a', hostEvent({ eventId: 'msg-plain-1abc', kind: 'message.user', payload: { text: 'routine chatter' } })).status, 'skipped');
    const candidateId = '123e4567-e89b-42d3-a456-426614174000';
    assert.equal(repo.events.record('host-a', hostEvent({ eventId: 'msg-cand-1abc', kind: 'message.user', payload: { text: 'source of a candidate', candidateId } })).status, 'stored');
  } finally { repo.close(); }
});

test('Selected events follow the planned 7-day hot and +90-day archive schedule without deadline shifts', async () => {
  const { repo } = await fixture();
  try {
    const receivedAt = new Date(Date.now() - (HOT_RETENTION_DAYS + 1) * DAY_MS).toISOString();
    repo.events.record('host-a', hostEvent({ eventId: 'lifecycle-1abcd', receivedAt, occurredAt: receivedAt }));
    // Sweeping one day late must still stamp the PLANNED archival boundary (received+7d).
    const late = new Date();
    const report = repo.sweepRetention(late);
    assert.equal(report.archivedEvents, 1);
    const archived = repo.events.get('host-a', 'lifecycle-1abcd');
    assert.equal(archived.stage, 'archived');
    assert.equal(archived.archivedAt, new Date(new Date(receivedAt).getTime() + HOT_RETENTION_DAYS * DAY_MS).toISOString());
    assert.ok(report.planSkewMs.events >= 1 * DAY_MS, 'late sweep reports its skew');
    // Clearing is due at archived+90d: not yet even 80 days later.
    repo.sweepRetention(new Date(late.getTime() + 80 * DAY_MS));
    assert.equal(repo.events.get('host-a', 'lifecycle-1abcd').stage, 'archived');
    repo.sweepRetention(new Date(late.getTime() + 90 * DAY_MS));
    const cleared = repo.events.get('host-a', 'lifecycle-1abcd');
    assert.equal(cleared.stage, 'cleared');
    assert.deepEqual(cleared.payload, {});
  } finally { repo.close(); }
});

test('Important markers and evidence references protect events from ordinary clearing', async () => {
  const { repo } = await fixture();
  try {
    const receivedAt = new Date(Date.now() - (HOT_RETENTION_DAYS + ARCHIVE_RETENTION_DAYS + 1) * DAY_MS).toISOString();
    repo.events.record('host-a', hostEvent({ eventId: 'protected-1abc', receivedAt, occurredAt: receivedAt }));
    repo.events.record('host-a', hostEvent({ eventId: 'ref-linked-1ab', receivedAt, occurredAt: receivedAt }));
    repo.events.protect('protected-1abc', 'host-a', 'Incident investigation reference');
    const linked = repo.submit(request('retention-protect-001'));
    // Control event: saved (candidate source) but neither important nor evidence-linked.
    repo.events.record('host-a', hostEvent({ eventId: 'plain-1abcd', receivedAt, occurredAt: receivedAt, kind: 'message.user', payload: { text: 'ordinary but selected for saving', candidateId: linked.id } }));
    repo.events.linkEvidence('ref-linked-1ab', 'host-a', linked.id);
    repo.sweepRetention(new Date());
    assert.equal(repo.events.get('host-a', 'protected-1abc').stage, 'archived');
    assert.equal(repo.events.get('host-a', 'ref-linked-1ab').stage, 'archived');
    assert.equal(repo.events.get('host-a', 'plain-1abcd').stage, 'cleared');
    assert.deepEqual(repo.events.get('host-a', 'plain-1abcd').payload, {});
  } finally { repo.close(); }
});

test('Candidate bodies clear 30 days after entering a clearable state, metadata and catalog survive', async () => {
  const { repo } = await fixture();
  try {
    const input = request('retention-clear-001');
    const candidate = repo.submit(input);
    repo.review(candidate.id, 'reject', 'operator', 'fixture rejection', null);
    assert.equal(repo.get(candidate.id).status, 'rejected');
    const early = repo.sweepRetention(new Date(Date.now() + 1 * DAY_MS));
    assert.ok(early.deferredCandidates.some(item => item.candidateId === candidate.id && item.reason === 'retention_not_due'));
    assert.equal(early.clearedCandidates, 0);
    const late = repo.sweepRetention(new Date(Date.now() + (CANDIDATE_BODY_RETENTION_DAYS + 1) * DAY_MS));
    assert.equal(late.clearedCandidates, 1);
    const cleared = repo.get(candidate.id);
    assert.equal(cleared.bodyCleared, true);
    assert.equal(cleared.request.content, '');
    // Metadata (idempotency key, provenance, hash-bearing receipt) remains queryable.
    assert.equal(cleared.request.idempotencyKey, 'retention-clear-001');
    assert.equal(cleared.request.provenance.sourceReference, 'fixture:retention');
    // Exact replay of the original input still resolves idempotently via the stored hash.
    const replay = repo.submit(input);
    assert.equal(replay.id, candidate.id);
    assert.throws(() => repo.submit(request('retention-clear-001', 'different content')), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'IDEMPOTENCY_CONFLICT');
    // Resubmission with the same key and a body again is possible only through amend rules, not here.
  } finally { repo.close(); }
});

test('Cleared candidate bodies never affect published revision reads', async () => {
  const { repo } = await fixture();
  try {
    const input = request('retention-catalog-001', 'Catalog integrity across body clearing.');
    const candidate = repo.submit(input);
    repo.review(candidate.id, 'approve', 'operator', 'fixture', null);
    repo.acquire('retention-owner', 90000);
    repo.finish(repo.claim('retention-owner')!, { id: 'retention-provider', action: 'added' }, false);
    repo.release('retention-owner');
    const publication = repo.get(candidate.id).publication!;
    const before = repo.catalog.get(publication.memoryId);
    assert.equal(before.revisions[0]!.applicability, input.provenance.applicability);
    assert.equal(before.revisions[0]!.scope, 'project');
    const report = repo.sweepRetention(new Date(Date.now() + (CANDIDATE_BODY_RETENTION_DAYS + 1) * DAY_MS));
    assert.equal(report.clearedCandidates, 1);
    const after = repo.catalog.get(publication.memoryId);
    assert.deepEqual(after, before);
    assert.equal(after.revisions[0]!.applicability, input.provenance.applicability);
  } finally { repo.close(); }
});

test('Active, conflicted and evidence-referenced candidates never clear by deadline alone', async () => {
  const { repo } = await fixture();
  try {
    const pending = repo.submit(request('retention-pending-001'));
    const base = repo.submit(request('retention-base-001', 'Base memory for conflict protection.'));
    repo.review(base.id, 'approve', 'operator', 'fixture', null);
    repo.acquire('owner-base', 90000);
    repo.finish(repo.claim('owner-base')!, { id: 'retention-provider-base', action: 'added' }, false);
    repo.release('owner-base');
    const publication = repo.get(base.id).publication!;
    const conflicted = repo.submit({ ...request('retention-conflict-001', 'Conflicting conclusion awaiting adjudication.'), change: { kind: 'conflict', targetMemoryId: publication.memoryId, expectedRevisionId: publication.revisionId, effectiveAt: new Date().toISOString(), reason: 'fixture conflict', evidence: ['fixture'] } });
    assert.ok(repo.get(conflicted.id).conflictCaseId);
    repo.review(conflicted.id, 'reject', 'operator', 'withdraw the conflict', null);
    const persisted = repo.submit(request('retention-persisted-001'));
    repo.review(persisted.id, 'approve', 'operator', 'fixture', null);
    repo.acquire('owner-persisted', 90000);
    repo.finish(repo.claim('owner-persisted')!, { id: 'retention-provider-2', action: 'added' }, false);
    repo.release('owner-persisted');
    const eventId = repo.events.record('host-a', hostEvent({ eventId: 'evidence-1abcd', kind: 'message.user', payload: { text: 'evidence source', candidateId: persisted.id } })).eventId;
    repo.events.linkEvidence(eventId, 'host-a', persisted.id);
    assert.throws(() => repo.events.linkEvidence('missing-event-1ab', 'host-a', persisted.id), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'NOT_FOUND');
    const report = repo.sweepRetention(new Date(Date.now() + (CANDIDATE_BODY_RETENTION_DAYS + 5) * DAY_MS));
    const deferred = Object.fromEntries(report.deferredCandidates.map(item => [item.candidateId, item.reason]));
    assert.match(deferred[pending.id]!, /status_/);
    assert.equal(deferred[persisted.id], 'protected_evidence');
    // The dismissed case keeps its evidence: even a resolved case protects both sides' bodies.
    assert.equal(deferred[conflicted.id], 'conflict_case_evidence');
    assert.equal(report.clearedCandidates, 1);
    assert.equal(deferred[base.id], undefined);
  } finally { repo.close(); }
});
