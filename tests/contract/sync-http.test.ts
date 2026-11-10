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
import { createSyncServer, syncRoutes } from '../../packages/protocols/sync-http/src/index.ts';

const TOKEN = 'a'.repeat(32);
const NOW = '2026-11-10T05:00:00.000Z';

let store: SyncStore;
let server: Server;
let base: string;

before(async () => {
  const dir = join('work', 'sync-http-test', randomUUID());
  mkdirSync(dir, { recursive: true });
  store = new SyncStore({ path: join(dir, 'sync.db'), now: () => NOW });
  store.enroll('device-a', TOKEN, [
    { scope: 'global', canRead: true, canWrite: true },
    { scope: 'project:alpha', canRead: true, canWrite: true },
  ]);
  store.enroll('device-b', 'b'.repeat(32), [{ scope: 'project:beta', canRead: true, canWrite: true }]);
  server = createSyncServer({ gateway: store, now: () => new Date(NOW) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  store.close();
});

const auth = { authorization: `Bearer ${TOKEN}` };

function draft(overrides: Partial<SyncEntryDraftValue> = {}): SyncEntryDraftValue {
  return {
    entryId: overrides.entryId ?? randomUUID(),
    kind: overrides.kind ?? 'runtime',
    scope: overrides.scope ?? 'project:alpha',
    content: overrides.content ?? plainContent('提交前必须运行类型检查。'),
    payload: overrides.payload ?? { enabled: true },
    withdrawnAt: overrides.withdrawnAt ?? null,
  };
}

async function post(change: unknown) {
  return fetch(`${base}/v1/sync/changes`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(change) });
}

test('the served route list matches the documented surface', () => {
  assert.deepEqual(syncRoutes.map((route) => `${route.method} ${route.path}`), [
    'POST /v1/sync/changes',
    'GET /v1/sync/changes',
    'GET /v1/sync/receipts/{changeId}',
    'GET /v1/sync/entries/{entryId}',
    'GET /v1/sync/snapshot',
    'GET /v1/sync/scopes',
    'GET /v1/sync/health',
  ]);
});

test('health and scopes require a device token', async () => {
  assert.equal((await fetch(`${base}/v1/sync/health`)).status, 401);
  const health = await fetch(`${base}/v1/sync/health`, { headers: auth });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ready: true, protocol: 1, now: NOW });
  const scopes = await fetch(`${base}/v1/sync/scopes`, { headers: auth });
  assert.deepEqual((await scopes.json() as { scopes: { scope: string }[] }).scopes.map((item) => item.scope).sort(), ['global', 'project:alpha']);
});

test('browser-origin requests are refused', async () => {
  const response = await fetch(`${base}/v1/sync/health`, { headers: { ...auth, origin: 'http://example.invalid' } });
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
  const receipt = await fetch(`${base}/v1/sync/receipts/${change.changeId}`, { headers: auth });
  assert.equal(receipt.status, 200);
  assert.equal((await receipt.json() as { version: number }).version, accepted.version);
  assert.equal((await fetch(`${base}/v1/sync/receipts/${randomUUID()}`, { headers: auth })).status, 404);
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
  const scope = 'global';
  const entry = draft({ scope, payload: { enabled: true } });
  await post(buildChange({ changeId: randomUUID(), baseVersion: 0, operation: 'create', entry }));
  await post(buildChange({ changeId: randomUUID(), baseVersion: 1, operation: 'update', entry: { ...entry, content: plainContent('第二条全局准则。') } }));
  const all = await fetch(`${base}/v1/sync/changes?scope=global&since=0&limit=10`, { headers: auth });
  const page = await all.json() as { changes: { seq: number }[]; nextSince: number; hasMore: boolean; retentionFloor: number };
  assert.deepEqual(page.changes.map((item) => item.seq), [1, 2]);
  assert.equal(page.nextSince, 2);
  assert.equal(page.retentionFloor, 1);
  const tail = await fetch(`${base}/v1/sync/changes?scope=global&since=1&limit=1`, { headers: auth });
  const tailPage = await tail.json() as { changes: { seq: number }[]; hasMore: boolean };
  assert.deepEqual(tailPage.changes.map((item) => item.seq), [2]);
  assert.equal(tailPage.hasMore, false);
  assert.equal((await fetch(`${base}/v1/sync/changes?scope=project:alpha&since=abc`, { headers: auth })).status, 400);
});

test('entry and snapshot reads are scope checked', async () => {
  const entry = draft({ kind: 'formal', payload: { category: 'fact', importance: 3, tags: [], entities: [], relations: [] } });
  await post(buildChange({ changeId: randomUUID(), baseVersion: 0, operation: 'create', entry }));
  const read = await fetch(`${base}/v1/sync/entries/${entry.entryId}`, { headers: auth });
  assert.equal(read.status, 200);
  assert.equal((await read.json() as { entryId: string }).entryId, entry.entryId);
  assert.equal((await fetch(`${base}/v1/sync/entries/${randomUUID()}`, { headers: auth })).status, 404);
  const snapshot = await fetch(`${base}/v1/sync/snapshot?scope=project:alpha`, { headers: auth });
  const body = await snapshot.json() as { asOfSeq: number; nextSince: number; entries: unknown[] };
  assert.equal(body.asOfSeq, body.nextSince);
  assert.ok(body.entries.length >= 1);
  assert.equal((await fetch(`${base}/v1/sync/snapshot?scope=project:beta`, { headers: auth })).status, 403);
  assert.equal((await fetch(`${base}/v1/sync/snapshot`, { headers: auth })).status, 400);
});

test('unknown routes and malformed bodies are refused', async () => {
  assert.equal((await fetch(`${base}/v1/sync/unknown`, { headers: auth })).status, 404);
  const wrongType = await fetch(`${base}/v1/sync/changes`, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(wrongType.status, 400);
  const badChange = await post({ changeId: randomUUID(), baseVersion: 0, operation: 'create' });
  assert.equal(badChange.status, 400);
});
