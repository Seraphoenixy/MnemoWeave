import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Bridge } from '../../packages/bridge/src/index.ts';
import { ReplicaStore, contentHashOf } from '../../packages/bridge/src/replica.ts';
import type { SyncChannel } from '../../packages/bridge/src/index.ts';
import { ReadGrant } from '../../packages/core/contracts/src/index.ts';
import type { ReadGrantRecord } from '../../packages/core/contracts/src/index.ts';
import { createUiServer } from '../../apps/bridge/src/ui-server.ts';

const UI_TOKEN = 'ui-token-for-bridge-contract-0001';

const grant = (projects: string[] = ['*']): ReadGrantRecord => ReadGrant.parse({
  grantId: randomUUID(), hostId: 'host-ui', projects, globalIncluded: true,
  issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), generation: 0,
});

function channel(record: ReadGrantRecord): SyncChannel {
  const fail = async (): Promise<never> => { throw new Error('server unavailable'); };
  return {
    issueGrant: async () => record,
    changes: fail, snapshot: fail, partitionSummaries: fail,
    isRevoked: fail, licenseWatermark: fail, submitIntent: fail,
  } as unknown as SyncChannel;
}

const PROJECT_ID = 'project-ui';
const CONTENT = 'Deploy the release only after the operator confirms the window.';

async function seededBridge(record: ReadGrantRecord = grant()): Promise<{ bridge: Bridge; directory: string; memoryId: string; revisionId: string }> {
  await mkdir('work/tests', { recursive: true });
  const directory = await mkdtemp(resolve('work/tests/bridge-ui-'));
  const memoryId = randomUUID();
  const revisionId = randomUUID();
  const replica = new ReplicaStore(join(directory, 'replica.db'));
  try {
    replica.apply([
      { seq: 1, op: 'memory', entityId: memoryId, payloadHash: 'h1', opAt: new Date().toISOString(),
        payload: { id: memoryId, currentRevisionId: revisionId, state: 'active', scope: 'project', projectId: PROJECT_ID, applicability: 'ui fixture' } },
      { seq: 2, op: 'revision', entityId: revisionId, payloadHash: 'h2', opAt: new Date().toISOString(), content: CONTENT,
        payload: { id: revisionId, memoryId, number: 1, parentId: null, providerMemoryId: 'provider-ui-1', contentHash: contentHashOf(CONTENT), candidateId: randomUUID(), publishedAt: new Date().toISOString(), effectiveAt: new Date().toISOString(), applicability: 'ui fixture', scope: 'project', projectId: PROJECT_ID } },
    ]);
  } finally { replica.close(); }
  const bridge = new Bridge(directory, 'host-ui', channel(record));
  await bridge.pair();
  return { bridge, directory, memoryId, revisionId };
}

async function listen(bridge: Bridge): Promise<{ url: string; close(): Promise<void> }> {
  const server = createUiServer({ token: UI_TOKEN, api: bridge });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise(resolve => server.close(() => resolve())) };
}

test('UI status reports the paired grant, replica freshness and intent counters without writing', async () => {
  const { bridge, memoryId, revisionId } = await seededBridge();
  try {
    const status = bridge.uiStatus();
    assert.equal(status.paired, true);
    assert.equal(status.grant?.revoked, false);
    assert.equal(status.grant?.expired, false);
    assert.equal(status.replica?.available, true);
    assert.equal(status.replica?.memories, 1);
    assert.equal(status.intents.queued, 0);

    const list = bridge.uiMemories();
    assert.equal(list.status, 'ok');
    assert.equal(list.total, 1);
    assert.equal(list.items[0]?.memoryId, memoryId);
    assert.equal(list.items[0]?.excerpt, CONTENT);
    assert.equal(list.items[0]?.projectId, PROJECT_ID);
    assert.equal(list.scope, null);

    const searched = bridge.uiMemories({ query: 'operator' });
    assert.equal(searched.total, 1);
    assert.equal(bridge.uiMemories({ query: 'absent-term' }).total, 0);

    // Scope narrows the granted set and never widens it.
    assert.equal(bridge.uiMemories({ scope: 'global' }).total, 0);
    const projectOnly = bridge.uiMemories({ scope: 'project', projectId: PROJECT_ID });
    assert.equal(projectOnly.total, 1);
    assert.equal(projectOnly.scope, 'project');
    assert.equal(projectOnly.projectId, PROJECT_ID);
    assert.equal(bridge.uiMemories({ projectId: 'another-project' }).total, 0);

    const detail = bridge.uiMemory(memoryId);
    assert.equal(detail.status, 'ok');
    assert.equal(detail.content, CONTENT);
    assert.equal(detail.revisions.length, 1);
    assert.equal(detail.revisions[0]?.current, true);

    const revision = bridge.uiRevision(memoryId, revisionId);
    assert.equal(revision.status, 'ok');
    assert.equal(revision.content, CONTENT);
    assert.equal(revision.current, true);
    assert.equal(revision.number, 1);
    const missing = bridge.uiRevision(memoryId, randomUUID());
    assert.equal(missing.status, 'unavailable');
    assert.equal(missing.reason, 'not_found');
    assert.equal(missing.content, null);
  } finally { bridge.close(); }
});

test('UI reads apply the Host grant and report unpaired access explicitly', async () => {
  const { bridge, memoryId } = await seededBridge(grant(['another-project']));
  try {
    const list = bridge.uiMemories();
    assert.equal(list.status, 'ok');
    assert.equal(list.total, 0);
    const detail = bridge.uiMemory(memoryId);
    assert.equal(detail.status, 'unauthorized');
    assert.equal(detail.reason, 'out_of_grant');
    assert.equal(detail.content, null);
  } finally { bridge.close(); }

  const directory = await mkdtemp(resolve('work/tests/bridge-ui-unpaired-'));
  const unpaired = new Bridge(directory, 'host-ui', channel(grant()));
  try {
    assert.equal(unpaired.uiStatus().paired, false);
    const list = unpaired.uiMemories();
    assert.equal(list.status, 'unauthorized');
    assert.equal(list.reason, 'unpaired');
    assert.deepEqual(unpaired.uiIntents().items, []);
  } finally { unpaired.close(); }
});

test('UI endpoint requires its own token, refuses browser origins and serves only GET', async () => {
  const { bridge, memoryId, revisionId } = await seededBridge();
  const { url, close } = await listen(bridge);
  try {
    const auth = { authorization: `Bearer ${UI_TOKEN}` };
    assert.equal((await fetch(`${url}/v1/ui/status`)).status, 401);
    assert.equal((await fetch(`${url}/v1/ui/status`, { headers: { ...auth, origin: 'http://127.0.0.1:20314' } })).status, 401);
    const live = await fetch(`${url}/health/live`, { headers: auth });
    assert.equal(live.status, 200);

    const status = await fetch(`${url}/v1/ui/status`, { headers: auth });
    assert.equal(status.status, 200);
    assert.equal(((await status.json()) as { paired: boolean }).paired, true);

    const memories = await fetch(`${url}/v1/ui/memories?query=release&limit=5`, { headers: auth });
    assert.equal(memories.status, 200);
    assert.equal(((await memories.json()) as { total: number }).total, 1);

    const detail = await fetch(`${url}/v1/ui/memories/${memoryId}`, { headers: auth });
    assert.equal(detail.status, 200);
    assert.equal(((await detail.json()) as { content: string }).content, CONTENT);

    const revision = await fetch(`${url}/v1/ui/memories/${memoryId}/revisions/${revisionId}`, { headers: auth });
    assert.equal(revision.status, 200);
    assert.equal(((await revision.json()) as { content: string }).content, CONTENT);

    const scoped = await fetch(`${url}/v1/ui/memories?scope=project&projectId=${PROJECT_ID}`, { headers: auth });
    assert.equal(scoped.status, 200);
    assert.equal(((await scoped.json()) as { total: number }).total, 1);

    assert.equal((await fetch(`${url}/v1/ui/memories/not-a-uuid`, { headers: auth })).status, 400);
    assert.equal((await fetch(`${url}/v1/ui/memories?limit=999`, { headers: auth })).status, 400);
    assert.equal((await fetch(`${url}/v1/ui/memories?scope=bogus`, { headers: auth })).status, 400);
    assert.equal((await fetch(`${url}/v1/ui/memories?projectId=`, { headers: auth })).status, 400);
    assert.equal((await fetch(`${url}/v1/ui/memories/${memoryId}/revisions/nope`, { headers: auth })).status, 400);
    assert.equal((await fetch(`${url}/v1/ui/unknown`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${url}/v1/ui/status`, { method: 'POST', headers: auth })).status, 404);
  } finally {
    await close();
    bridge.close();
  }
});
