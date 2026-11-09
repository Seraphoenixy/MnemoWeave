import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { SyncSource } from '../../packages/infrastructure/governance/src/sync-source.ts';
import { createHttpServer } from '../../packages/protocols/http/src/index.ts';
import type { SyncHttpEndpoints } from '../../packages/protocols/http/src/index.ts';
import { Bridge } from '../../packages/bridge/src/index.ts';
import { verifySnapshotFile } from '../../packages/bridge/src/replica.ts';
import { HttpSyncChannel } from '../../apps/bridge/src/http-channel.ts';
import { MemoryApplication } from '../../packages/core/application/src/index.ts';
import type { RememberRequest } from '../../packages/core/contracts/src/index.ts';

const request = (key: string, content: string): RememberRequest => ({
  idempotencyKey: key, content, knowledgeType: 'Practice', tags: [], scope: 'project',
  provenance: { source: 'sync-http-test', sourceReference: 'fixture:sync-http', evidence: ['fixture'], verificationStatus: 'verified', confidence: 0.8, applicability: 'sync http fixture', limitations: 'test only', lastVerified: '2026-11-08T00:00:00.000Z' },
});

async function fixture() {
  await mkdir('work/tests', { recursive: true });
  const root = await mkdtemp(resolve('work/tests/sync-http-'));
  const path = join(root, 'governance.db');
  const repo = new SqliteCandidates(path);
  const contents = new Map<string, string>();
  let writes = 0;
  const provider = {
    async health() { return { ready: true as const, version: '0.2.13' as const, capabilities: ['health'] }; },
    async recall() { return { memories: [] }; },
    async readMemory(id: string) { const c = contents.get(id); if (c === undefined) throw new Error('missing'); return { id, content: c }; },
    async inspectExact(content: string) { return { complete: true, matches: [...contents].filter(([, t]) => t === content).map(([id, text]) => ({ id, content: text })) }; },
    async verifyContent(id: string, content: string) { return contents.get(id) === content; },
    async persistReviewed(content: string) { const id = `provider-${++writes}`; contents.set(id, content); return { id, action: 'added' as const }; },
  };
  const publish = async (key: string, content: string) => {
    const candidate = repo.submit(request(key, content));
    repo.review(candidate.id, 'approve', 'operator', 'fixture', null);
    const written = await provider.persistReviewed(content);
    repo.acquire('http-owner', 90000);
    repo.finish(repo.claim('http-owner')!, written, false);
    repo.release('http-owner');
    const persisted = repo.get(candidate.id);
    const receipt = persisted.executionReceipts[persisted.executionReceipts.length - 1] as { providerMemoryId: string };
    return { memoryId: persisted.publication!.memoryId, providerMemoryId: receipt.providerMemoryId, content };
  };
  const source = new SyncSource(repo, async id => { const c = contents.get(id); if (c === undefined) throw new Error('missing'); return c; });
  const snapshotDir = join(root, 'server-snapshots');
  const sync: SyncHttpEndpoints = {
    currentGrant: hostId => source.grantFor(hostId),
    issueGrant: async (hostId, projects, globalIncluded, ttlMs) => source.issueGrant(hostId, projects, globalIncluded, ttlMs),
    revoke: async (hostId, global) => { source.revokeHost(hostId, global); },
    isRevoked: async hostId => source.isHostRevoked(hostId),
    watermark: () => source.revocationWatermark(),
    changes: sinceSeq => source.changes(sinceSeq),
    snapshot: async () => {
      const served = join(snapshotDir, `snapshot-${randomUUID()}.db`);
      const manifest = await source.snapshot(served);
      return { path: served, latestSeq: manifest.latestSeq };
    },
    partitionSummaries: async () => source.partitionSummaries(),
    submitIntent: async (hostId, intent) => source.submitIntent(hostId, { intentId: intent.intentId, kind: intent.kind, payload: intent.payload, ...(intent.baselineRef !== undefined ? { baselineRef: intent.baselineRef } : {}) }),
  };
  const app = new MemoryApplication({ ...provider, async health(): Promise<{ ready: true; version: '0.2.13'; capabilities: ['health'] }> { return { ready: true, version: '0.2.13', capabilities: ['health'] }; } });
  const server = createHttpServer(app, 'local-sync-http-token-0123456789', 'local-sync-operator-012345678', sync);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  return { root, repo, contents, publish, source, base, server, hostId: 'host-http-bridge' };
}

const operatorHeaders = { authorization: 'Bearer local-sync-operator-012345678', 'content-type': 'application/json' };
const hostHeaders = (hostId: string) => ({ authorization: 'Bearer local-sync-http-token-0123456789', 'x-mnemoweave-host': hostId });

test('Pairing is operator-gated; the bridge fetches its grant over HTTP', async () => {
  const f = await fixture();
  try {
    const denied = await fetch(`${f.base}/v1/sync/grant`, { method: 'POST', headers: { ...hostHeaders(f.hostId), 'content-type': 'application/json' }, body: JSON.stringify({ hostId: f.hostId, projects: ['*'], globalIncluded: true }) });
    assert.equal(denied.status, 401, 'normal token cannot issue grants');
    const issued = await fetch(`${f.base}/v1/sync/grant`, { method: 'POST', headers: operatorHeaders, body: JSON.stringify({ hostId: f.hostId, projects: ['*'], globalIncluded: true }) });
    assert.equal(issued.status, 200);
    const grant = await issued.json() as { grantId: string; hostId: string; expiresAt: string };
    assert.equal(grant.hostId, f.hostId);
    const fetched = await fetch(`${f.base}/v1/sync/grant`, { headers: hostHeaders(f.hostId) });
    assert.equal(fetched.status, 200);
    const refetched = await fetched.json() as { grantId: string };
    assert.equal(refetched.grantId, grant.grantId);
    const unpaired = await fetch(`${f.base}/v1/sync/changes?since=0`, { headers: hostHeaders('host-unknown') });
    assert.equal(unpaired.status, 401);
    const noHeader = await fetch(`${f.base}/v1/sync/changes?since=0`, { headers: { authorization: 'Bearer local-sync-http-token-0123456789' } });
    assert.equal(noHeader.status, 401);
  } finally { f.server.close(); f.repo.close(); }
});

test('Bridge syncs snapshot and incrementals over HTTP and recalls locally', async () => {
  const f = await fixture();
  try {
    await f.publish('http-sync-001', 'Published over HTTP transport test.');
    const channel = new HttpSyncChannel(f.base, 'local-sync-http-token-0123456789', f.hostId, join(f.root, 'bridge', 'snapshots'));
    const bridge = new Bridge(join(f.root, 'bridge'), f.hostId, channel);
    // Pairing fetch fails while the operator has not issued a grant yet.
    await assert.rejects(bridge.pair());
    await fetch(`${f.base}/v1/sync/grant`, { method: 'POST', headers: operatorHeaders, body: JSON.stringify({ hostId: f.hostId, projects: ['*'], globalIncluded: true }) });
    await bridge.pair();
    const first = await bridge.sync();
    assert.equal(first.mode, 'snapshot');
    assert.equal(bridge.recall('HTTP transport test').recall!.memories[0]!.content, 'Published over HTTP transport test.');
    await f.publish('http-sync-002', 'Incremental over HTTP.');
    const second = await bridge.sync();
    assert.equal(second.mode, 'incremental');
    assert.ok(second.applied >= 2);
    assert.equal(bridge.recall('Incremental over HTTP').recall!.memories[0]!.content, 'Incremental over HTTP.');
    // Snapshot bytes fetched over HTTP verify against the embedded manifest.
    const served = await channel.snapshot();
    assert.equal(verifySnapshotFile(served.path).ok, true);
    bridge.close();
  } finally { f.server.close(); f.repo.close(); }
});

test('Verify, watermark and intent intake endpoints behave per contract', async () => {
  const f = await fixture();
  try {
    await fetch(`${f.base}/v1/sync/grant`, { method: 'POST', headers: operatorHeaders, body: JSON.stringify({ hostId: f.hostId, projects: ['*'], globalIncluded: true }) });
    const before = await (await fetch(`${f.base}/v1/sync/verify`, { headers: hostHeaders(f.hostId) })).json() as unknown[];
    assert.equal(before.length, 0, 'no memories published yet');
    await f.publish('http-verify-001', 'Summary fixture content.');
    const summaries = await (await fetch(`${f.base}/v1/sync/verify`, { headers: hostHeaders(f.hostId) })).json() as { memoryId: string; contentHashes: string[] }[];
    assert.equal(summaries.length, 1);
    const watermark = await (await fetch(`${f.base}/v1/sync/watermark`, { headers: hostHeaders(f.hostId) })).json() as { watermark: number; revoked: boolean };
    assert.equal(watermark.revoked, false);
    // Intent intake creates a candidate; malformed intents are rejected.
    const intent = await fetch(`${f.base}/v1/sync/intents`, { method: 'POST', headers: { ...hostHeaders(f.hostId), 'content-type': 'application/json' }, body: JSON.stringify({ intentId: 'intent-1', kind: 'remember', payload: request('http-intent-001', 'Intent delivered over HTTP.') }) });
    assert.equal(intent.status, 200);
    const intentResult = await intent.json() as { status: string; reference?: string };
    assert.equal(intentResult.status, 'accepted');
    assert.ok(intentResult.reference, 'accepted intents carry a candidate reference');
    const badKind = await fetch(`${f.base}/v1/sync/intents`, { method: 'POST', headers: { ...hostHeaders(f.hostId), 'content-type': 'application/json' }, body: JSON.stringify({ intentId: 'intent-2', kind: 'direct_write', payload: {} }) });
    assert.equal(badKind.status, 400);
    const inspect = new DatabaseSync(join(f.root, 'governance.db'));
    try {
      const row = inspect.prepare("SELECT c.id, l.status FROM governance_candidates c LEFT JOIN governance_lifecycle l ON l.candidate_id=c.id WHERE c.idempotency_key='http-intent-001'").get()!;
      assert.equal(row['status'] ?? 'pending_review', 'pending_review');
    } finally { inspect.close(); }
    // Operator revocation propagates through the watermark endpoint.
    await fetch(`${f.base}/v1/sync/revoke`, { method: 'POST', headers: operatorHeaders, body: JSON.stringify({ hostId: f.hostId }) });
    const revokedWatermark = await (await fetch(`${f.base}/v1/sync/watermark`, { headers: hostHeaders(f.hostId) })).json() as { revoked: boolean };
    assert.equal(revokedWatermark.revoked, true);
    const isolated = await fetch(`${f.base}/v1/sync/intents`, { method: 'POST', headers: { ...hostHeaders(f.hostId), 'content-type': 'application/json' }, body: JSON.stringify({ intentId: 'intent-3', kind: 'remember', payload: request('http-intent-002', 'Should stay isolated.') }) });
    assert.deepEqual(await isolated.json() as { status: string }, { status: 'isolated' });
  } finally { f.server.close(); f.repo.close(); }
});

test('Bridge over HTTP isolates intents after revocation and never submits them', async () => {
  const f = await fixture();
  try {
    await fetch(`${f.base}/v1/sync/grant`, { method: 'POST', headers: operatorHeaders, body: JSON.stringify({ hostId: f.hostId, projects: ['*'], globalIncluded: true }) });
    await f.publish('http-revoke-001', 'Content before revocation.');
    const channel = new HttpSyncChannel(f.base, 'local-sync-http-token-0123456789', f.hostId, join(f.root, 'bridge', 'snapshots'));
    const bridge = new Bridge(join(f.root, 'bridge'), f.hostId, channel);
    await bridge.pair();
    await bridge.sync();
    assert.equal(bridge.recall('before revocation').status, 'ok');
    bridge.queueIntent('remember', request('http-revoked-intent', 'Queued then revoked.') as unknown as Record<string, unknown>);
    await fetch(`${f.base}/v1/sync/revoke`, { method: 'POST', headers: operatorHeaders, body: JSON.stringify({ hostId: f.hostId }) });
    assert.equal(await bridge.isRevokedNow(), true);
    assert.equal(bridge.recall('before revocation').status, 'unauthorized');
    assert.equal(existsSync(join(f.root, 'bridge', 'replica.db')), true, 'replica retained');
    const intent = bridge.queueIntent('remember', request('http-isolated-intent', 'Isolated intent.') as unknown as Record<string, unknown>);
    assert.equal(intent.state, 'isolated');
    const drain = await bridge.drainIntents();
    // The pre-revocation queued intent is attempted but the server isolates it without processing.
    assert.equal(drain.submitted, 1);
    assert.equal(drain.isolated, 2);
    const inspect = new DatabaseSync(join(f.root, 'governance.db'));
    try {
      assert.equal(inspect.prepare("SELECT count(*) n FROM governance_candidates WHERE idempotency_key IN ('http-isolated-intent','http-revoked-intent')").get()!['n'], 0);
    } finally { inspect.close(); }
    bridge.close();
  } finally { f.server.close(); f.repo.close(); }
});

test('Snapshot endpoint serves verifiable bytes for the HTTP channel', async () => {
  const f = await fixture();
  try {
    await fetch(`${f.base}/v1/sync/grant`, { method: 'POST', headers: operatorHeaders, body: JSON.stringify({ hostId: f.hostId, projects: ['*'], globalIncluded: true }) });
    await f.publish('http-snap-001', 'Snapshot bytes fixture.');
    const response = await fetch(`${f.base}/v1/sync/snapshot`, { headers: hostHeaders(f.hostId) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /octet-stream/);
    const latestSeq = Number(response.headers.get('x-sync-latest-seq'));
    assert.ok(latestSeq > 0);
    const path = join(f.root, 'downloaded-snapshot.db');
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
    assert.equal(verifySnapshotFile(path).ok, true);
  } finally { f.server.close(); f.repo.close(); }
});


test('Sync data endpoints reject partial, expired and revoked grants', async () => {
  const f = await fixture();
  try {
    for (const mode of ['partial', 'expired', 'revoked']) {
      f.source.issueGrant(f.hostId, mode === 'partial' ? ['proj-1'] : ['*'], true, mode === 'expired' ? 1 : 3600000);
      if (mode === 'expired') await new Promise(resolve => setTimeout(resolve, 5));
      if (mode === 'revoked') f.source.revokeHost(f.hostId);
      for (const endpoint of ['changes?since=0', 'snapshot', 'verify']) {
        const response = await fetch(`${f.base}/v1/sync/${endpoint}`, { headers: hostHeaders(f.hostId) });
        assert.equal(response.status, 401, `${mode}: ${endpoint}`);
      }
    }
  } finally { f.server.close(); f.repo.close(); }
});
