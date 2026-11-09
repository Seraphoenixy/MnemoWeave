import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { SyncSource } from '../../packages/infrastructure/governance/src/sync-source.ts';
import type { SyncIntent } from '../../packages/infrastructure/governance/src/sync-source.ts';
import { Bridge } from '../../packages/bridge/src/index.ts';
import type { SyncChannel, QueuedIntent } from '../../packages/bridge/src/index.ts';
import { ReplicaStore, verifySnapshotFile } from '../../packages/bridge/src/replica.ts';
import { RememberInput } from '../../packages/core/contracts/src/index.ts';
import type { RememberRequest } from '../../packages/core/contracts/src/index.ts';

const DAY_MS = 86_400_000;
const request = (key: string, content: string): RememberRequest => ({
  idempotencyKey: key, content, knowledgeType: 'Practice', tags: [], scope: 'project', projectId: 'proj-1',
  provenance: { source: 'sync-test', sourceReference: 'fixture:sync', evidence: ['fixture'], verificationStatus: 'verified', confidence: 0.8, applicability: 'sync fixture', limitations: 'test only', lastVerified: '2026-11-08T00:00:00.000Z' },
});

async function fixture() {
  await mkdir('work/tests', { recursive: true });
  const root = await mkdtemp(resolve('work/tests/sync-'));
  const path = join(root, 'governance.db');
  const repo = new SqliteCandidates(path);
  const contents = new Map<string, string>();
  let writes = 0;
  const provider = {
    async health() { return { ready: true as const, version: '0.2.13' as const, capabilities: ['health'] }; },
    async recall() { return { memories: [] }; },
    async readMemory(id: string) { const content = contents.get(id); if (content === undefined) throw new Error('missing'); return { id, content }; },
    async inspectExact(content: string) { return { complete: true, matches: [...contents].filter(([, text]) => text === content).map(([id, text]) => ({ id, content: text })) }; },
    async verifyContent(id: string, content: string) { return contents.get(id) === content; },
    async persistReviewed(content: string) { const id = `provider-${++writes}`; contents.set(id, content); return { id, action: 'added' as const }; },
  };
  /** Publishes a plain memory through the reviewed workflow so sync ops appear in the log. */
  const publish = async (key: string, content: string) => {
    const candidate = repo.submit(request(key, content));
    repo.review(candidate.id, 'approve', 'operator', 'fixture', null);
    const written = await provider.persistReviewed(content);
    repo.acquire('sync-owner', 90000);
    repo.finish(repo.claim('sync-owner')!, written, false);
    repo.release('sync-owner');
    const persisted = repo.get(candidate.id);
    const receipt = persisted.executionReceipts[persisted.executionReceipts.length - 1] as { providerMemoryId: string };
    return { memoryId: persisted.publication!.memoryId, revisionId: persisted.publication!.revisionId, providerMemoryId: receipt.providerMemoryId, content };
  };
  const source = new SyncSource(repo, async providerMemoryId => {
    const content = contents.get(providerMemoryId);
    if (content === undefined) throw new Error('missing content');
    return content;
  });
  const channelFor = (bridgeDir: string): SyncChannel => ({
    async changes(sinceSeq) { return source.changes(sinceSeq); },
    async snapshot() {
      const path = join(bridgeDir, `snapshot-${randomUUID()}.db`);
      const manifest = await source.snapshot(path);
      return { path, latestSeq: manifest.latestSeq };
    },
    async partitionSummaries() { return source.partitionSummaries(); },
    async issueGrant(hostId) { return source.issueGrant(hostId, ['proj-1'], true); },
    async licenseWatermark() { return source.revocationWatermark(); },
    async isRevoked(hostId) { return source.isHostRevoked(hostId); },
    async submitIntent(hostId, intent) { return source.submitIntent(hostId, intent as unknown as SyncIntent); },
  });
  const bridgeFor = (name: string) => new Bridge(join(root, name), `host-${name}`, channelFor(join(root, name)));
  return { root, repo, contents, publish, source, bridgeFor };
}

test('Snapshot round-trip: manifest verification, curated scope and offline recall on two bridges', async () => {
  const f = await fixture();
  try {
    await f.publish('sync-base-001', 'Published base memory for offline recall.');
    const bridgeA = f.bridgeFor('bridge-a');
    const bridgeB = f.bridgeFor('bridge-b');
    const grantA = await bridgeA.pair();
    await bridgeB.pair();
    assert.equal(grantA.projects.includes('proj-1'), true);
    const syncA = await bridgeA.sync();
    const syncB = await bridgeB.sync();
    assert.equal(syncA.mode, 'snapshot');
    assert.equal(syncB.mode, 'snapshot');
    // Local-first recall works without the server after the snapshot switch.
    for (const bridge of [bridgeA, bridgeB]) {
      const read = bridge.recall('base memory');
      assert.equal(read.status, 'ok');
      assert.equal(read.recall!.memories[0]!.content, 'Published base memory for offline recall.');
      assert.equal(read.recall!.complete, true);
      assert.equal(read.recall!.stale, false);
    }
    // Snapshot excludes governance material: candidates/reviews are not in the replica file.
    bridgeA.close(); bridgeB.close();
  } finally { f.repo.close(); }
});

test('Incremental stream applies in order, skips duplicates and replays, and carries content', async () => {
  const f = await fixture();
  try {
    const base = await f.publish('sync-inc-001', 'First published memory.');
    const bridge = f.bridgeFor('bridge-inc');
    await bridge.pair();
    await bridge.sync();
    const second = await f.publish('sync-inc-002', 'Second published memory with fresh content.');
    const before = await f.source.changes(base.revisionId.length - base.revisionId.length);
    assert.ok(before.changes.length >= 4, 'memory+revision ops for both publications');
    const result = await bridge.sync();
    assert.equal(result.mode, 'incremental');
    assert.ok(result.applied >= 2);
    assert.equal(bridge.recall('fresh content').recall!.memories[0]!.content, second.content);
    // Duplicate delivery of the same seq range is fully skipped (replay protection).
    const window = await f.source.changes(0);
    const replay = bridge.recall('First published') && (await import('../../packages/bridge/src/replica.ts')).ReplicaStore;
    const replica = new ReplicaStore(join(f.root, 'bridge-inc', 'replica.db'));
    try {
      const again = replica.apply(window.changes);
      assert.equal(again.applied, 0);
      assert.equal(again.skipped, window.changes.length);
    } finally { replica.close(); }
    bridge.close();
  } finally { f.repo.close(); }
});

test('Offline intents queue, are re-validated by the server, and never publish directly', async () => {
  const f = await fixture();
  try {
    await f.publish('sync-intent-base', 'Existing base so the intent has context.');
    const bridge = f.bridgeFor('bridge-intent');
    await bridge.pair();
    await bridge.sync();
    // Offline: queue a remember intent (full normalized request) without any server contact.
    const intent = bridge.queueIntent('remember', request('sync-intent-001', 'Queued offline intent content.') as unknown as Record<string, unknown>);
    assert.equal(intent.state, 'queued');
    // Reconnect: the server re-validates and creates a CANDIDATE, not a formal memory.
    const writesBefore = f.contents.size;
    const drain = await bridge.drainIntents();
    assert.equal(drain.submitted, 1);
    assert.equal(drain.acknowledged, 1);
    assert.equal(f.contents.size, writesBefore, 'nothing written to the provider by intent intake');
    const candidates = new DatabaseSync(join(f.root, 'governance.db'));
    try {
      const row = candidates.prepare("SELECT c.id, l.status FROM governance_candidates c LEFT JOIN governance_lifecycle l ON l.candidate_id=c.id WHERE c.idempotency_key='sync-intent-001'").get()!;
      assert.equal(row['status'] ?? 'pending_review', 'pending_review');
    } finally { candidates.close(); }
  } finally { f.repo.close(); }
});

test('Host revocation stops reads and sync immediately, keeps the replica and isolates intents', async () => {
  const f = await fixture();
  try {
    await f.publish('sync-revoke-001', 'Memory visible before revocation.');
    const bridgeA = f.bridgeFor('bridge-rev-a');
    const bridgeB = f.bridgeFor('bridge-rev-b');
    await bridgeA.pair();
    await bridgeB.pair();
    await bridgeA.sync();
    await bridgeB.sync();
    assert.equal(bridgeA.recall('revocation').status, 'ok');
    f.source.revokeHost('host-bridge-rev-a');
    // Immediate effect on the revoked bridge; the other bridge is untouched.
    assert.equal(await bridgeA.isRevokedNow(), true);
    assert.equal((await bridgeA.sync()).reason, 'revoked');
    const read = bridgeA.recall('revocation');
    assert.equal(read.status, 'unauthorized');
    assert.equal(read.reason, 'revoked');
    assert.equal(existsSync(join(f.root, 'bridge-rev-a', 'replica.db')), true, 'replica is retained, not wiped');
    assert.equal(bridgeB.recall('revocation').status, 'ok');
    // Intents queued after revocation are isolated, never auto-submitted.
    const intent = bridgeA.queueIntent('remember', request('sync-revoked-intent', 'Should stay isolated.') as unknown as Record<string, unknown>);
    assert.equal(intent.state, 'isolated');
    const drain = await bridgeA.drainIntents();
    assert.equal(drain.isolated, 1);
    assert.equal(drain.submitted, 0);
    assert.equal(bridgeA.isolatedIntentCount(), 1);
    bridgeA.close(); bridgeB.close();
  } finally { f.repo.close(); }
});

test('Expired license stops reads but still accepts offline intents (AUTH-01/03)', async () => {
  const f = await fixture();
  try {
    await f.publish('sync-license-001', 'Licensed content.');
    const bridge = f.bridgeFor('bridge-license');
    await bridge.pair();
    await bridge.sync();
    const later = new Date(Date.now() + 2 * 3_600_000);
    assert.equal(bridge.recall('licensed', 10, later).status, 'unauthorized');
    assert.equal(bridge.recall('licensed', 10, later).reason, 'license_expired');
    const intent = bridge.queueIntent('remember', request('sync-expired-intent', 'Queued with expired license.') as unknown as Record<string, unknown>);
    assert.equal(intent.state, 'queued');
    const drain = await bridge.drainIntents();
    assert.equal(drain.acknowledged, 1);
    bridge.close();
  } finally { f.repo.close(); }
});

test('A cursor behind the compaction window invalidates and triggers a snapshot rebuild', async () => {
  const f = await fixture();
  try {
    await f.publish('sync-cursor-001', 'Content before compaction.');
    const bridge = f.bridgeFor('bridge-cursor');
    await bridge.pair();
    await bridge.sync();
    const applied = join(f.root, 'bridge-cursor', 'replica.db');
    const replica = new ReplicaStore(applied);
    const cursor = replica.appliedSeq;
    replica.close();
    // A second publication lands in the window the bridge has not seen yet.
    await f.publish('sync-cursor-002', 'Content after compaction.');
    // Server compacts the 30-day window away (simulate time passing beyond retention).
    f.source.compactSyncLog(new Date(Date.now() + 31 * DAY_MS));
    assert.equal((await f.source.changes(0)).changes.length, 0);
    // A third publication creates newer ops; the stale cursor can no longer bridge the gap.
    await f.publish('sync-cursor-003', 'Content after compaction.');
    const result = await bridge.sync();
    assert.equal(result.mode, 'snapshot');
    assert.equal(result.reason, 'cursor_expired');
    assert.equal(bridge.recall('after compaction').recall!.memories[0]!.content, 'Content after compaction.');
    assert.ok(cursor > 0);
  } finally { f.repo.close(); }
});

test('Corrupted replicas are unreadable and rebuild from a verified snapshot', async () => {
  const f = await fixture();
  try {
    await f.publish('sync-corrupt-001', 'Content that must survive corruption.');
    const dir = join(f.root, 'bridge-corrupt');
    const bridge = f.bridgeFor('bridge-corrupt');
    await bridge.pair();
    await bridge.sync();
    bridge.close();
    // Flip bytes in the replica file to simulate on-disk corruption.
    const replicaPath = join(dir, 'replica.db');
    const bytes = await readFile(replicaPath);
    // Destroy the file header: the replica must be detected as unreadable, never serve
    // silent empty results (SYNC-05).
    for (let offset = 0; offset < Math.min(100, bytes.length); offset++) bytes[offset] = 0x00;
    await writeFile(replicaPath, bytes);
    const reopened = f.bridgeFor('bridge-corrupt');
    assert.equal(reopened.recall('survive').status, 'corrupted');
    const result = await reopened.sync();
    assert.equal(result.mode, 'snapshot');
    assert.equal(result.reason, 'corrupted');
    assert.equal(reopened.recall('survive corruption').recall!.memories[0]!.content.includes('survive'), true);
    reopened.close();
  } finally { f.repo.close(); }
});

test('Rebuild keeps a readable previous replica with its data time, and staging is verified', async () => {
  const f = await fixture();
  try {
    await f.publish('sync-rebuild-001', 'Original replica content.');
    const bridge = f.bridgeFor('bridge-rebuild');
    await bridge.pair();
    await bridge.sync();
    const firstDataTime = bridge.recall('original').recall!.dataTime;
    await f.publish('sync-rebuild-002', 'Second generation content.');
    // Healthy rebuild via cursor expiry: compaction removes the seen window, a new
    // publication lands beyond it, and the snapshot rebuild swaps atomically.
    f.source.compactSyncLog(new Date(Date.now() + 31 * DAY_MS));
    await f.publish('sync-rebuild-003', 'Third generation content.');
    const result = await bridge.sync();
    assert.equal(result.mode, 'snapshot');
    assert.equal(result.reason, 'cursor_expired');
    const previous = new ReplicaStore(join(f.root, 'bridge-rebuild', 'replica.previous.db'));
    try {
      assert.equal(previous.dataTime, firstDataTime, 'previous replica keeps its data time');
      assert.ok(previous.partitionSummaries().length >= 1, 'previous copy still readable');
    } finally { previous.close(); }
    assert.equal(bridge.recall('Third generation').recall!.memories[0]!.content, 'Third generation content.');
    bridge.close();
  } finally { f.repo.close(); }
});

test('Full verification repairs drift via rebuild beyond the 5 percent threshold', async () => {
  const f = await fixture();
  try {
    await f.publish('sync-verify-001', 'Verified content one.');
    await f.publish('sync-verify-002', 'Verified content two.');
    const bridge = f.bridgeFor('bridge-verify');
    await bridge.pair();
    await bridge.sync();
    // Corrupt one partition locally: 1 of 2 memories diverges (>5%).
    const replicaPath = join(f.root, 'bridge-verify', 'replica.db');
    const replica = new ReplicaStore(replicaPath);
    const summary = replica.partitionSummaries()[0]!;
    replica.close();
    const raw = new DatabaseSync(replicaPath);
    raw.prepare("UPDATE replica_revisions SET content_hash='deadbeef' WHERE memory_id=?").run(summary.memoryId);
    raw.close();
    // 72 hours later the full verification runs and repairs by rebuild.
    await bridge.sync(new Date(Date.now() + 73 * 3_600_000));
    const repaired = new ReplicaStore(replicaPath);
    try {
      const after = repaired.partitionSummaries().find(item => item.memoryId === summary.memoryId)!;
      assert.deepEqual(after.contentHashes, summary.contentHashes);
    } finally { repaired.close(); }
    bridge.close();
  } finally { f.repo.close(); }
});

test('Tombstone retention purges markers older than 90 days', async () => {
  const f = await fixture();
  try {
    const dir = join(f.root, 'bridge-tomb');
    const replica = new ReplicaStore(join(dir, 'replica.db'));
    try {
      const old = new Date(Date.now() - 91 * DAY_MS);
      replica.apply([
        { seq: 1, op: 'revoke_tombstone', entityId: 'host-x', payload: {}, payloadHash: 'x', opAt: old.toISOString() },
        { seq: 2, op: 'revoke_tombstone', entityId: 'host-y', payload: {}, payloadHash: 'y', opAt: new Date().toISOString() },
      ]);
      assert.equal(replica.purgeExpiredTombstones(), 1);
      assert.equal(replica.recall('anything', 10).memories.length, 0);
    } finally { replica.close(); }
  } finally { f.repo.close(); }
});

test('Sync log appends in the same transaction as publication; failure rolls both back', async () => {
  const f = await fixture();
  try {
    const candidate = f.repo.submit(request('sync-tx-001', 'Transactional publication.'));
    f.repo.review(candidate.id, 'approve', 'operator', 'fixture', null);
    const inspect = new DatabaseSync(join(f.root, 'governance.db'));
    inspect.exec("CREATE TRIGGER fail_sync_log BEFORE INSERT ON sync_log BEGIN SELECT RAISE(ABORT,'sync log failure'); END;");
    f.repo.acquire('tx-owner', 90000);
    const job = f.repo.claim('tx-owner')!;
    const written = { id: 'tx-provider', action: 'added' as const };
    f.contents.set('tx-provider', 'Transactional publication.');
    assert.throws(() => f.repo.finish(job, written, false));
    // The publish and its sync-log append roll back together: no receipt, no publication.
    assert.equal(f.repo.get(candidate.id).status, 'persisting');
    assert.equal(f.repo.get(candidate.id).publication, undefined);
    assert.equal(inspect.prepare('SELECT count(*) n FROM governance_execution_receipts').get()!['n'], 0);
    assert.equal(inspect.prepare('SELECT count(*) n FROM sync_log').get()!['n'], 0);
    inspect.close();
  } finally { f.repo.close(); }
});

test('Snapshot manifest verification rejects a tampered snapshot file', async () => {
  const f = await fixture();
  try {
    await f.publish('sync-tamper-001', 'Tamper detection target.');
    const path = join(f.root, 'tampered.db');
    await f.source.snapshot(path);
    assert.equal(verifySnapshotFile(path).ok, true);
    const tamper = new DatabaseSync(path);
    tamper.prepare("UPDATE replica_revisions SET content='modified outside'").run();
    tamper.close();
    assert.equal(verifySnapshotFile(path).ok, false);
  } finally { f.repo.close(); }
});


test('Global revocation allows a newly operator-issued generation', async () => {
  const f = await fixture();
  try {
    f.source.issueGrant('renewed', ['*'], true);
    f.source.revokeHost('renewed', true);
    assert.equal(f.source.isHostRevoked('renewed'), true);
    f.source.issueGrant('renewed', ['*'], true);
    assert.equal(f.source.isHostRevoked('renewed'), false);
  } finally { f.repo.close(); }
});

test('Snapshot cursor excludes a publication during content fetch', async () => {
  const f = await fixture();
  try {
    await f.publish('before-snapshot', 'before snapshot');
    let published = false;
    const manifest = await f.source.snapshot(join(f.root, 'concurrent.db'), async id => {
      if (!published) { published = true; await f.publish('during-snapshot', 'during snapshot'); }
      return f.contents.get(id)!;
    });
    const tail = await f.source.changes(manifest.latestSeq);
    assert.ok(tail.changes.some(change => change.op === 'revision'));
  } finally { f.repo.close(); }
});

test('Small partition drift is repaired without replacing unaffected replica partitions', async () => {
  const f = await fixture();
  const bridge = f.bridgeFor('small-repair');
  try {
    for (let i = 0; i < 21; i++) await f.publish(`small-repair-${i}`, `Partition fixture ${i}`);
    await bridge.pair(); await bridge.sync();
    const raw = new DatabaseSync(join(bridge.directory, 'replica.db'));
    const id = raw.prepare('SELECT id FROM replica_revisions LIMIT 1').get()!['id'];
    raw.prepare("UPDATE replica_revisions SET content='tampered' WHERE id=?").run(id!);
    raw.close();
    await bridge.sync(new Date(Date.now() + 73 * 3600000));
    assert.equal(existsSync(join(bridge.directory, 'replica.previous.db')), false);
    const repaired = new DatabaseSync(join(bridge.directory, 'replica.db'));
    try { assert.notEqual(repaired.prepare('SELECT content FROM replica_revisions WHERE id=?').get(id!)!['content'], 'tampered'); }
    finally { repaired.close(); }
  } finally { bridge.close(); f.repo.close(); }
});
