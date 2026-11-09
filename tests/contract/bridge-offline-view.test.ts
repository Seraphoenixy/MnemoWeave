import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Bridge } from '../../packages/bridge/src/index.ts';
import { ReplicaStore, contentHashOf } from '../../packages/bridge/src/replica.ts';
import type { SyncChannel } from '../../packages/bridge/src/index.ts';
import { MnemoWeaveError, ReadGrant } from '../../packages/core/contracts/src/index.ts';
import type { ReadGrantRecord } from '../../packages/core/contracts/src/index.ts';

const grant = (): ReadGrantRecord => ReadGrant.parse({
  grantId: randomUUID(), hostId: 'host-a', projects: ['*'], globalIncluded: true,
  issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), generation: 0,
});

function channel(record: ReadGrantRecord = grant()): SyncChannel {
  const fail = async (): Promise<never> => { throw new Error('server unavailable'); };
  return {
    issueGrant: async () => record,
    changes: fail, snapshot: fail, partitionSummaries: fail,
    isRevoked: fail, licenseWatermark: fail, submitIntent: fail,
  } as unknown as SyncChannel;
}

async function seededBridge(record = grant()): Promise<Bridge> {
  await mkdir('work/tests', { recursive: true });
  const directory = await mkdtemp(resolve('work/tests/bridge-offline-'));
  const memoryId = randomUUID();
  const revisionId = randomUUID();
  const content = 'Offline bridge view content for local assembly.';
  const replica = new ReplicaStore(join(directory, 'replica.db'));
  try {
    replica.apply([
      { seq: 1, op: 'memory', entityId: memoryId, payloadHash: 'h1', opAt: new Date().toISOString(),
        payload: { id: memoryId, currentRevisionId: revisionId, state: 'active', scope: 'project', applicability: 'offline fixture' } },
      { seq: 2, op: 'revision', entityId: revisionId, payloadHash: 'h2', opAt: new Date().toISOString(), content,
        payload: { id: revisionId, memoryId, number: 1, parentId: null, providerMemoryId: 'provider-offline-1', contentHash: contentHashOf(content), candidateId: randomUUID(), publishedAt: new Date().toISOString(), effectiveAt: new Date().toISOString(), applicability: 'offline fixture', scope: 'project' } },
    ]);
  } finally { replica.close(); }
  const bridge = new Bridge(directory, 'host-a', channel(record));
  await bridge.pair();
  return bridge;
}

test('Bridge assembles a View from the local replica when the Server is unreachable', async () => {
  const bridge = await seededBridge();
  try {
    const view = await bridge.localView({ query: 'offline' });
    assert.equal(view.memories.length, 1);
    assert.match(view.memories[0]!.content, /Offline bridge view content/);
    assert.equal(view.memories[0]!.tier, 'dynamic');
    assert.equal(view.complete, true);
    assert.equal(bridge.cachedRevoked(), false);
  } finally { bridge.close(); }
});

test('Offline assembly fails closed without a replica or with revoked license state', async () => {
  await mkdir('work/tests', { recursive: true });
  const directory = await mkdtemp(resolve('work/tests/bridge-offline-empty-'));
  const bridge = new Bridge(directory, 'host-a', channel());
  try {
    await bridge.pair();
    await assert.rejects(bridge.localView({ query: 'anything' }), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'PROVIDER_UNAVAILABLE');
    assert.ok(bridge.storedGrant());
  } finally { bridge.close(); }

  const revokedDirectory = await mkdtemp(resolve('work/tests/bridge-offline-revoked-'));
  const revoked = new Bridge(revokedDirectory, 'host-a', channel());
  try {
    await revoked.pair();
    const record = new ReplicaStore(join(revokedDirectory, 'replica.db'));
    record.close();
    // Revocation is cached locally when the Server reports it; offline reads then fail closed.
    const store = (revoked as unknown as { store: { markRevoked(hostId: string): void } }).store;
    store.markRevoked('host-a');
    assert.equal(revoked.cachedRevoked(), true);
    await assert.rejects(revoked.localView({ query: 'anything' }), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'UNAUTHORIZED');
  } finally { revoked.close(); }
});
