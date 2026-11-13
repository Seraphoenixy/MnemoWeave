import { tempDir } from '../support/temp.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SyncEntryDraftValue } from '../../packages/core/contracts/src/index.ts';
import { buildChange, plainContent } from '../../packages/core/application/src/sync.ts';
import { SyncStore } from '../../packages/infrastructure/sync-store/src/index.ts';
import { createSyncServer, syncRoutes, SYNC_PROTOCOL_VERSION } from '../../packages/protocols/sync-http/src/index.ts';

const TOKEN = 'a'.repeat(32);
const NOW = '2026-11-10T05:00:00.000Z';

let store: SyncStore;
let server: Server;
let base: string;

before(async () => {
  const dir = await tempDir('sync-http', 'sync-http-test');
  mkdirSync(dir, { recursive: true });
  store = new SyncStore({ path: join(dir, 'sync.db'), now: () => NOW });
  store.enroll('device-a', TOKEN);
  store.enroll('device-b', 'b'.repeat(32));
  server = createSyncServer({ gateway: store, now: () => new Date(NOW) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  // Keep-alive sockets from earlier requests would otherwise hold the server open.
  server.closeAllConnections();
  server.close();
  store.close();
});

const auth = { authorization: `Bearer ${TOKEN}` };

function draft(overrides: Partial<SyncEntryDraftValue> = {}): SyncEntryDraftValue {
  return {
    entryId: overrides.entryId ?? randomUUID(),
    kind: overrides.kind ?? 'rule',
    content: overrides.content ?? plainContent('提交前必须运行类型检查。'),
    payload: overrides.payload ?? { enabled: true },
    withdrawnAt: overrides.withdrawnAt ?? null,
  };
}

const PROTOCOL = { 'x-mnemoweave-sync-protocol': String(SYNC_PROTOCOL_VERSION) };

function headers(extra: Record<string, string> = {}) {
  return { ...auth, ...PROTOCOL, ...extra };
}

async function post(change: unknown) {
  return fetch(`${base}/v1/sync/changes`, { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify(change) });
}

test('the served route list matches the documented surface', () => {
  assert.deepEqual(syncRoutes.map((route) => `${route.method} ${route.path}`), [
    'POST /v1/sync/changes',
    'GET /v1/sync/changes',
    'GET /v1/sync/receipts/{changeId}',
    'GET /v1/sync/entries/{entryId}',
    'GET /v1/sync/snapshot',
    'GET /v1/sync/streams',
    'GET /v1/sync/health',
  ]);
});

test('health and streams require a device token', async () => {
  assert.equal((await fetch(`${base}/v1/sync/health`)).status, 401);
  const health = await fetch(`${base}/v1/sync/health`, { headers: auth });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ready: true, protocol: 2, now: NOW });
  const streams = await fetch(`${base}/v1/sync/streams`, { headers: headers() });
  assert.deepEqual((await streams.json() as { streams: { stream: string }[] }).streams.map((item) => item.stream).sort(), ['formal-memories', 'rules']);
});

test('a request without protocol 2 answers 409 with SYNC_PROTOCOL_MISMATCH', async () => {
  // A protocol-1 client is told to stop rather than being handed stream-shaped data it cannot apply.
  for (const request of [
    fetch(`${base}/v1/sync/streams`, { headers: auth }),
    fetch(`${base}/v1/sync/changes?stream=rules&since=0`, { headers: auth }),
  ]) {
    const response = await request;
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code: string }).code, 'SYNC_PROTOCOL_MISMATCH');
  }
  const mismatched = await fetch(`${base}/v1/sync/streams`, { headers: { ...auth, 'x-mnemoweave-sync-protocol': '1' } });
  assert.equal(mismatched.status, 409);
  // Health stays reachable without the header: it is how a caller learns the version.
  assert.equal((await fetch(`${base}/v1/sync/health`, { headers: auth })).status, 200);
});

test('browser-origin requests are refused', async () => {
  const response = await fetch(`${base}/v1/sync/health`, { headers: { ...headers(), origin: 'http://example.invalid' } });
  assert.equal(response.status, 401);
});

test('a change is accepted, deduplicated and reported with its sequence', async () => {
  const entry = draft();
  const change = buildChange({ changeId: randomUUID(), baseVersion: 0, operation: 'create', entry });
  const first = await post(change);
  assert.equal(first.status, 200);
  const accepted = await first.json() as { version: number; seq: number; duplicate: boolean };
  assert.equal(accepted.version, 1);
  assert.equal(accepted.duplicate, false);
  const replay = await post(change);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as { duplicate: boolean }).duplicate, true);
  const receipt = await fetch(`${base}/v1/sync/receipts/${change.changeId}`, { headers: headers() });
  assert.equal(receipt.status, 200);
  assert.equal((await receipt.json() as { version: number }).version, accepted.version);
  assert.equal((await fetch(`${base}/v1/sync/receipts/${randomUUID()}`, { headers: headers() })).status, 404);
});

test('a stale base version answers 409 with the current state', async () => {
  const entry = draft();
  await post(buildChange({ changeId: randomUUID(), baseVersion: 0, operation: 'create', entry }));
  await post(buildChange({ changeId: randomUUID(), baseVersion: 1, operation: 'update', entry: { ...entry, content: plainContent('第二版正文。') } }));
  const stale = await post(buildChange({ changeId: randomUUID(), baseVersion: 1, operation: 'update', entry: { ...entry, content: plainContent('基于旧版本的更正。') } }));
  assert.equal(stale.status, 409);
  const body = await stale.json() as { code: string; currentVersion: number; currentEntry: { version: number } };
  assert.equal(body.code, 'VERSION_CONFLICT');
  assert.equal(body.currentVersion, 2);
  assert.equal(body.currentEntry.version, 2);
});

test('pull pages expose contiguous sequences and honour since and limit', async () => {
  // Earlier tests share this store, so the page is read from the current head rather than from 0.
  const before = (await (await fetch(`${base}/v1/sync/changes?stream=rules&since=0&limit=500`, { headers: headers() })).json() as { nextSince: number }).nextSince;
  const entry = draft({ payload: { enabled: true } });
  await post(buildChange({ changeId: randomUUID(), baseVersion: 0, operation: 'create', entry }));
  await post(buildChange({ changeId: randomUUID(), baseVersion: 1, operation: 'update', entry: { ...entry, content: plainContent('第二条全局准则。') } }));
  const all = await fetch(`${base}/v1/sync/changes?stream=rules&since=${before}&limit=10`, { headers: headers() });
  const page = await all.json() as { changes: { seq: number }[]; nextSince: number; hasMore: boolean; retentionFloor: number };
  assert.deepEqual(page.changes.map((item) => item.seq), [before + 1, before + 2]);
  assert.equal(page.nextSince, before + 2);
  assert.equal(page.retentionFloor, 1);
  const tail = await fetch(`${base}/v1/sync/changes?stream=rules&since=${before + 1}&limit=1`, { headers: headers() });
  const tailPage = await tail.json() as { changes: { seq: number }[]; hasMore: boolean };
  assert.deepEqual(tailPage.changes.map((item) => item.seq), [before + 2]);
  assert.equal(tailPage.hasMore, false);
  assert.equal((await fetch(`${base}/v1/sync/changes?stream=rules&since=abc`, { headers: headers() })).status, 400);
  assert.equal((await fetch(`${base}/v1/sync/changes?stream=project:alpha&since=0`, { headers: headers() })).status, 400);
});

test('authenticated devices can read entries and snapshots across streams', async () => {
  const entry = draft({ kind: 'formal-memory', payload: { category: 'fact', importance: 3, tags: [], entities: [], relations: [] } });
  await post(buildChange({ changeId: randomUUID(), baseVersion: 0, operation: 'create', entry }));
  const read = await fetch(`${base}/v1/sync/entries/${entry.entryId}`, { headers: headers() });
  assert.equal(read.status, 200);
  assert.equal((await read.json() as { entryId: string }).entryId, entry.entryId);
  assert.equal((await fetch(`${base}/v1/sync/entries/${randomUUID()}`, { headers: headers() })).status, 404);
  const snapshot = await fetch(`${base}/v1/sync/snapshot?stream=formal-memories`, { headers: headers() });
  const body = await snapshot.json() as { asOfSeq: number; nextSince: number; entries: unknown[] };
  assert.equal(body.asOfSeq, body.nextSince);
  assert.ok(body.entries.length >= 1);
  const deviceB = { authorization: `Bearer ${'b'.repeat(32)}`, ...PROTOCOL };
  assert.equal((await fetch(`${base}/v1/sync/snapshot?stream=formal-memories`, { headers: deviceB })).status, 200);
  assert.equal((await fetch(`${base}/v1/sync/snapshot`, { headers: headers() })).status, 400);
});

test('unknown routes and malformed bodies are refused', async () => {
  assert.equal((await fetch(`${base}/v1/sync/unknown`, { headers: headers() })).status, 404);
  const wrongType = await fetch(`${base}/v1/sync/changes`, { method: 'POST', headers: headers(), body: '{}' });
  assert.equal(wrongType.status, 400);
  const badChange = await post({ changeId: randomUUID(), baseVersion: 0, operation: 'create' });
  assert.equal(badChange.status, 400);
});
