import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createUiServer, type UiApi } from '../../apps/bridge/src/ui-server.ts';
import { BridgeUiClient } from '../../plugins/dsh-mnemo-weave/src/ui/bridge-client.ts';
import { createRpcHandler } from '../../plugins/dsh-mnemo-weave/src/ui/rpc.ts';
import { inject as hostInject, resolveConfig } from '../../plugins/dsh-mnemo-weave/src/ui/index.ts';
import type { UiIntentsRecord, UiMemoryDetailRecord, UiMemoryListRecord, UiRevisionRecord, UiStatusRecord } from '../../packages/bridge/src/ui-read.ts';
import type { UiIntents, UiMemoryDetail, UiMemoryList, UiRevision, UiStatus } from '../../plugins/dsh-mnemo-weave/src/shared/contract.ts';
import { RPC_CHANNEL } from '../../plugins/dsh-mnemo-weave/src/shared/contract.ts';

const TOKEN = 'dsh-ui-host-contract-token-000001';
const MEMORY_ID = '22222222-2222-4222-8222-222222222222';

/**
 * The Host half registers this name with `connection.rpc.handle`, and that service rejects a channel
 * that does not match its own pattern. Registering `mnemoweave` failed the entry with
 * `invalid or reserved RPC channel "mnemoweave"`, so the shape is asserted here.
 */
test('the RPC channel name is one the DSH connection service accepts', () => {
  assert.match(RPC_CHANNEL, /^\/[A-Za-z0-9._~-]+$/);
  assert.notEqual(RPC_CHANNEL, '/api');
  // `connection.rpc.handle` mounts the route through the reading context, which must carry the web
  // server: without it the entry failed with `cannot get property "webServer" without inject`.
  assert.deepEqual([...hostInject].sort(), ['connection', 'webServer']);
});

const status: UiStatusRecord = {
  schemaVersion: 1, hostId: 'dsh-desktop', generatedAt: new Date().toISOString(), paired: true,
  grant: { grantId: '11111111-1111-4111-8111-111111111111', projects: ['*'], globalIncluded: true, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), generation: 0, expired: false, revoked: false },
  replica: { available: true, corrupted: false, appliedSeq: 5, generation: 1, dataTime: new Date().toISOString(), verifiedAt: null, stale: false, pendingContent: 0, memories: 1, revisions: 1 },
  intents: { queued: 0, isolated: 0 },
};

const list: UiMemoryListRecord = {
  status: 'ok', query: null, scope: null, projectId: null, total: 1, returned: 1, complete: true, dataTime: new Date().toISOString(),
  items: [{ memoryId: MEMORY_ID, revisionId: '33333333-3333-4333-8333-333333333333', state: 'active', scope: 'project', projectId: 'proj-a', applicability: 'ops', revisionNumber: 1, providerMemoryId: 'provider-1', publishedAt: new Date().toISOString(), excerpt: 'Release only in the window.', contentLength: 29 }],
};

const revision: UiRevisionRecord = {
  status: 'ok', memoryId: MEMORY_ID, revisionId: '33333333-3333-4333-8333-333333333333',
  number: 1, publishedAt: new Date().toISOString(), effectiveAt: new Date().toISOString(), current: true,
  content: 'Release only in the window.',
};

const detail: UiMemoryDetailRecord = {
  status: 'ok', memoryId: MEMORY_ID, revisionId: '33333333-3333-4333-8333-333333333333', state: 'active', scope: 'project', projectId: 'proj-a',
  applicability: 'ops', content: 'Release only in the window.', revisions: [{ revisionId: '33333333-3333-4333-8333-333333333333', number: 1, publishedAt: new Date().toISOString(), effectiveAt: new Date().toISOString(), current: true }],
  relations: [],
};

const intents: UiIntentsRecord = { status: 'ok', queued: 0, isolated: 0, items: [] };

function api(overrides: Partial<UiApi> = {}): UiApi {
  return {
    uiStatus: () => status,
    uiMemories: () => list,
    uiMemory: () => detail,
    uiRevision: () => revision,
    uiIntents: () => intents,
    ...overrides,
  };
}

async function start(ui: UiApi): Promise<{ url: string; close(): Promise<void> }> {
  const server = createUiServer({ token: TOKEN, api: ui });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

async function withHandler<T>(ui: UiApi, token: string, run: (handler: ReturnType<typeof createRpcHandler>) => Promise<T>): Promise<T> {
  const { url, close } = await start(ui);
  try {
    return await run(createRpcHandler(new BridgeUiClient({ baseUrl: url, token })));
  } finally { await close(); }
}

test('the Host channel serves the reads the page makes without exposing its token', async () => {
  await withHandler(api(), TOKEN, async handler => {
    const statusResult = await handler('status', {});
    assert.equal(statusResult.ok, true);

    const configResult = await handler('config', {});
    assert.equal(configResult.ok, true);
    if (configResult.ok) {
      const view = configResult.value as { bridgeUrl: string; hasToken: boolean; hostId: string | null };
      assert.equal(view.hasToken, true);
      assert.match(view.bridgeUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(view.hostId, null);
      assert.equal(JSON.stringify(configResult.value).includes(TOKEN), false, 'the token never reaches the page');
    }

    const listResult = await handler('memories', { query: 'release', limit: 10 });
    assert.equal(listResult.ok, true);
    if (listResult.ok) assert.equal((listResult.value as UiMemoryList).items[0]?.memoryId, MEMORY_ID);

    const detailResult = await handler('memory', { memoryId: MEMORY_ID });
    assert.equal(detailResult.ok, true);
    if (detailResult.ok) assert.equal((detailResult.value as UiMemoryDetail).content, 'Release only in the window.');

    const revisionResult = await handler('revision', { memoryId: MEMORY_ID, revisionId: '33333333-3333-4333-8333-333333333333' });
    assert.equal(revisionResult.ok, true);
    if (revisionResult.ok) {
      assert.equal((revisionResult.value as UiRevision).content, 'Release only in the window.');
      assert.equal((revisionResult.value as UiRevision).current, true);
    }

    const filtered = await handler('memories', { scope: 'project', projectId: 'proj-a', limit: 10 });
    assert.equal(filtered.ok, true);

    const intentsResult = await handler('intents', {});
    assert.equal(intentsResult.ok, true);
    if (intentsResult.ok) assert.equal((intentsResult.value as UiIntents).queued, 0);
  });
});

test('the Host channel rejects unknown endpoints and invalid payloads before any read', async () => {
  let reads = 0;
  await withHandler(api({ uiMemories: () => { reads++; return list; } }), TOKEN, async handler => {
    const unknown = await handler('delete-everything', {});
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.error.code, 'UNKNOWN_ENDPOINT');

    for (const payload of [{ limit: 500 }, { limit: 0 }, { query: 'x'.repeat(501) }, { query: 7 }, [], { scope: 'other' }, { projectId: '' }, { projectId: 'x'.repeat(201) }]) {
      const rejected = await handler('memories', payload);
      assert.equal(rejected.ok, false, `expected rejection for ${JSON.stringify(payload)}`);
      if (!rejected.ok) assert.equal(rejected.error.code, 'INVALID_INPUT');
    }
    const badId = await handler('memory', { memoryId: 'not-a-uuid' });
    assert.equal(badId.ok, false);
    if (!badId.ok) assert.equal(badId.error.code, 'INVALID_INPUT');
    const badRevision = await handler('revision', { memoryId: MEMORY_ID, revisionId: 'nope' });
    assert.equal(badRevision.ok, false);
    if (!badRevision.ok) assert.equal(badRevision.error.code, 'INVALID_INPUT');
    assert.equal(reads, 0);
  });
});

test('a wrong token and a malformed answer become explicit errors, not empty data', async () => {
  await withHandler(api(), 'wrong-token-wrong-token-000000', async handler => {
    const denied = await handler('status', {});
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.match(denied.error.code ?? '', /UNAUTHORIZED/);
  });

  await withHandler(api({ uiStatus: () => ({ schemaVersion: 2, hostId: 'x', generatedAt: '', paired: false, grant: null, replica: null, intents: { queued: 0, isolated: 0 } }) as unknown as UiStatusRecord }), TOKEN, async handler => {
    const mismatch = await handler('status', {});
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.error.code, 'API_VERSION');
  });

  await withHandler(api({ uiMemory: () => ({ nope: true }) as unknown as UiMemoryDetail }), TOKEN, async handler => {
    const broken = await handler('memory', { memoryId: MEMORY_ID });
    assert.equal(broken.ok, false);
    if (!broken.ok) assert.equal(broken.error.code, 'PROVIDER_UNAVAILABLE');
  });
});

test('configuration accepts entry values and loopback environment fallbacks only', () => {
  const fromEnv = resolveConfig(undefined, { MNEMOWEAVE_BRIDGE_UI_TOKEN: TOKEN, MNEMOWEAVE_BRIDGE_UI_URL: 'http://127.0.0.1:4319' });
  assert.equal(fromEnv.token, TOKEN);
  assert.equal(fromEnv.bridgeUrl, 'http://127.0.0.1:4319');
  const fromEntry = resolveConfig({ bridgeUrl: 'http://localhost:5000/', token: TOKEN, hostId: 'dsh', timeoutMs: 1200 });
  assert.equal(fromEntry.bridgeUrl, 'http://localhost:5000');
  assert.equal(fromEntry.hostId, 'dsh');
  assert.equal(fromEntry.timeoutMs, 1200);
  assert.throws(() => resolveConfig({ bridgeUrl: 'http://10.0.0.5:4319' }), /loopback/);
  assert.throws(() => resolveConfig({ bridgeUrl: 'http://example.com:4319' }), /loopback/);
  assert.equal(resolveConfig(undefined, {}).token, undefined);
});

test('a stopped Bridge surfaces as a read failure', async () => {
  const server = createServer();
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  await new Promise<void>(resolve => server.close(() => resolve()));
  const handler = createRpcHandler(new BridgeUiClient({ baseUrl: `http://127.0.0.1:${port}`, token: TOKEN, timeoutMs: 500 }));
  const result = await handler('status', {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'PROVIDER_UNAVAILABLE');
});
