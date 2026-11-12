import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SyncEntryDraftValue } from '../../packages/core/contracts/src/index.ts';
import { MnemoWeaveError } from '../../packages/core/contracts/src/index.ts';
import { buildChange, plainContent, VersionConflictError } from '../../packages/core/application/src/sync.ts';
import { SyncStore } from '../../packages/infrastructure/sync-store/src/index.ts';
import { createSyncServer } from '../../packages/protocols/sync-http/src/index.ts';
import { SyncClient, SyncTransportError } from '../../packages/infrastructure/sync-client/src/index.ts';

const TOKEN = 'a'.repeat(32);
const NOW = '2026-11-10T06:00:00.000Z';

let store: SyncStore;
let server: Server;
let base: string;
let client: SyncClient;

before(async () => {
  const dir = join('work', 'sync-client-test', randomUUID());
  mkdirSync(dir, { recursive: true });
  store = new SyncStore({ path: join(dir, 'sync.db'), now: () => NOW });
  store.enroll('device-a', TOKEN, [
    { stream: 'rules', canRead: true, canWrite: true },
    { stream: 'formal-memories', canRead: true, canWrite: true },
  ]);
  server = createSyncServer({ gateway: store, now: () => new Date(NOW) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  client = new SyncClient({ baseUrl: base, deviceId: 'device-a', token: TOKEN, timeoutMs: 5000 });
});

after(() => {
  // Keep-alive sockets from earlier requests would otherwise hold the server open.
  server.closeAllConnections();
  server.close();
  store.close();
});

function draft(overrides: Partial<SyncEntryDraftValue> = {}): SyncEntryDraftValue {
  return {
    entryId: overrides.entryId ?? randomUUID(),
    kind: overrides.kind ?? 'rule',
    content: overrides.content ?? plainContent('提交前必须运行类型检查。'),
    payload: overrides.payload ?? { enabled: true },
    withdrawnAt: overrides.withdrawnAt ?? null,
  };
}

test('health and streams round-trip through the HTTP surface', async () => {
  assert.deepEqual(await client.health(), { ready: true, protocol: 2, now: NOW });
  assert.deepEqual((await client.streams()).streams.map((item) => item.stream).sort(), ['formal-memories', 'rules']);
});

test('a protocol-1 remote is reported as an unsupported version, not retried', async () => {
  const legacy = new SyncClient({
    baseUrl: base,
    deviceId: 'device-a',
    token: TOKEN,
    // A protocol-1 remote answers the health probe without a protocol-2 body.
    fetchImpl: (async () => new Response(JSON.stringify({ ready: true, protocol: 1, now: NOW }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });
  await assert.rejects(legacy.health(), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'UNSUPPORTED_VERSION');
  // A 409 with SYNC_PROTOCOL_MISMATCH has the same outcome for a call that is not the probe.
  const mismatched = new SyncClient({
    baseUrl: base, deviceId: 'device-a', token: TOKEN,
    fetchImpl: (async () => new Response(JSON.stringify({ code: 'SYNC_PROTOCOL_MISMATCH' }), { status: 409, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });
  await assert.rejects(mismatched.streams(), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'UNSUPPORTED_VERSION');
});

test('a change is submitted once and replayed without a second version', async () => {
  const entry = draft();
  const change = buildChange({ changeId: randomUUID(), baseVersion: 0, operation: 'create', entry });
  const accepted = await client.submitChange(change);
  assert.equal(accepted.version, 1);
  assert.equal(accepted.duplicate, false);
  assert.equal((await client.submitChange(change)).duplicate, true);
});

test('a stale base surfaces the remote state as a conflict', async () => {
  const entry = draft();
  await client.submitChange(buildChange({ changeId: randomUUID(), baseVersion: 0, operation: 'create', entry }));
  await client.submitChange(buildChange({ changeId: randomUUID(), baseVersion: 1, operation: 'update', entry: { ...entry, content: plainContent('第二版正文。') } }));
  await assert.rejects(
    client.submitChange(buildChange({ changeId: randomUUID(), baseVersion: 1, operation: 'update', entry: { ...entry, content: plainContent('基于旧版本的更正。') } })),
    (error: unknown) => error instanceof VersionConflictError && error.currentVersion === 2 && error.currentEntry.version === 2,
  );
});

test('pull, entry and snapshot read back what was submitted', async () => {
  const entry = draft({ kind: 'formal-memory', payload: { category: 'decision', importance: 4, tags: [], entities: [], relations: [] } });
  await client.submitChange(buildChange({ changeId: randomUUID(), baseVersion: 0, operation: 'create', entry }));
  await client.submitChange(buildChange({ changeId: randomUUID(), baseVersion: 1, operation: 'update', entry: { ...entry, content: plainContent('第二版正式记忆。') } }));
  const page = await client.pullChanges({ stream: 'formal-memories', since: 0, limit: 100 });
  assert.ok(page.changes.length >= 2);
  assert.equal(page.retentionFloor, 1);
  const read = await client.entry(entry.entryId);
  assert.equal(read.version, 2);
  assert.deepEqual(read.revisions?.map((item) => item.version), [1, 2]);
  const snapshot = await client.snapshot('formal-memories');
  assert.equal(snapshot.asOfSeq, snapshot.nextSince);
});

test('a rejected token is reported as unauthorized, not as a transport failure', async () => {
  const wrong = new SyncClient({ baseUrl: base, deviceId: 'device-a', token: 'z'.repeat(32), timeoutMs: 5000 });
  await assert.rejects(wrong.health(), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'UNAUTHORIZED');
  assert.throws(() => new SyncClient({ baseUrl: base, deviceId: 'device-a', token: 'short' }), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'UNAUTHORIZED');
  await assert.rejects(wrong.snapshot('rules'), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'UNAUTHORIZED');
});

test('an unreachable remote is queued, a sent-but-cut request is unknown', async () => {
  const offline = new SyncClient({ baseUrl: 'http://127.0.0.1:59999', deviceId: 'device-a', token: TOKEN, timeoutMs: 2000 });
  await assert.rejects(offline.health(), (error: unknown) => error instanceof SyncTransportError && error.reachedRemote === false);
  const cut = new SyncClient({
    baseUrl: base,
    deviceId: 'device-a',
    token: TOKEN,
    fetchImpl: (async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; }) as typeof fetch,
  });
  await assert.rejects(cut.health(), (error: unknown) => error instanceof SyncTransportError && error.reachedRemote === true);
});
