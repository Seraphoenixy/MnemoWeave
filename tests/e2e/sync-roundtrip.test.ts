import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SyncEntryDraftValue } from '../../packages/core/contracts/src/index.ts';
import { buildChange, plainContent } from '../../packages/core/application/src/sync.ts';
import { SyncClient } from '../../packages/infrastructure/sync-client/src/index.ts';
import { SyncCoordinator } from '../../packages/core/application/src/sync.ts';
import { applyInboxEntry } from '../../packages/core/application/src/sync-apply.ts';
import type { FormalProviderPort } from '../../packages/core/application/src/sync-apply.ts';
import { SyncStore } from '../../packages/infrastructure/sync-store/src/index.ts';
import { createSyncServer } from '../../packages/protocols/sync-http/src/index.ts';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { MnemonCliProvider } from '../../packages/providers/mnemon/src/index.ts';
import { mnemonBinary } from './mnemon-binary.ts';

/**
 * One full local hop against the real Mnemon CLI: a change accepted by the remote
 * store is pulled, applied through the Provider, and mapped locally. Nothing here
 * touches the network beyond loopback.
 */

const DEVICE_TOKEN = 'd'.repeat(32);
const B_TOKEN = 'b'.repeat(32);
const NOW = '2026-11-10T06:00:00.000Z';
const SCOPE = 'project:alpha';
const ENTRY = '44444444-4444-4444-8444-444444444444';

let remote: SyncStore;
let server: Server;
let base: string;
let repo: SqliteCandidates;
let provider: MnemonCliProvider;
let providerAdapter: FormalProviderPort;

function formalPayload(version: number): SyncEntryDraftValue['payload'] {
  if (version === 1) return { category: 'fact', importance: 3, tags: [], entities: [], relations: [] };
  return {
    category: 'fact', importance: 3, tags: [], entities: [],
    relations: [{ type: 'supersedes', from: { entryId: ENTRY, version: 1 }, to: { entryId: ENTRY, version } }],
  };
}

function draft(version: number, body: string, withdrawnAt: string | null = null): SyncEntryDraftValue {
  return { entryId: ENTRY, kind: 'formal', scope: SCOPE, content: plainContent(body), payload: formalPayload(version), withdrawnAt };
}

before(async () => {
  const dir = join('work', 'sync-roundtrip', randomUUID());
  mkdirSync(dir, { recursive: true });
  remote = new SyncStore({ path: join(dir, 'remote.db'), now: () => NOW });
  remote.enroll('device-local', DEVICE_TOKEN, [{ scope: SCOPE, canRead: true, canWrite: true }]);
  remote.enroll('device-b', B_TOKEN, [{ scope: SCOPE, canRead: true, canWrite: true }]);
  server = createSyncServer({ gateway: remote, now: () => new Date(NOW) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  repo = new SqliteCandidates(resolve(dir, 'governance.db'));
  const mnemonDir = resolve(dir, 'mnemon');
  mkdirSync(mnemonDir, { recursive: true });
  provider = new MnemonCliProvider({ binary: mnemonBinary(), dataDir: mnemonDir, store: 'roundtrip' });
  providerAdapter = {
    remember: async (content, source) => {
      const match = /^mnemoweave:([0-9a-f-]{36}):(\d+)$/.exec(source);
      if (!match) throw new Error(`unexpected sync source ${source}`);
      const result = await provider.syncRemember(content, match[1]!, Number(match[2]));
      return { id: result.id };
    },
    linkSupersedes: (sourceId, targetId, metadata) => provider.linkSupersedes(sourceId, targetId, metadata),
    show: async (id) => provider.readMemory(id),
    forget: async (id) => provider.forget(id),
  };
});

after(() => {
  server?.close();
  repo?.close();
  remote?.close();
});

function localCoordinator(): SyncCoordinator {
  const client = new SyncClient({ baseUrl: base, deviceId: 'device-local', token: DEVICE_TOKEN });
  return new SyncCoordinator(client, repo.ledger, () => NOW);
}

function apply(coordinator: SyncCoordinator) {
  return coordinator.applyScope(SCOPE, (row) => applyInboxEntry(row, { store: repo.memory, provider: providerAdapter, now: () => NOW }));
}

test('a change written on another machine reaches the local Provider and the mapping', async () => {
  const accepted = remote.submit(B_TOKEN, buildChange({ changeId: randomUUID(), baseVersion: 0, operation: 'create', entry: draft(1, '同步链路的正式记忆。') }));
  const coordinator = localCoordinator();
  const pulled = await coordinator.pullScope(SCOPE);
  assert.equal(pulled.received, 1);
  assert.equal(repo.ledger.cursor(SCOPE), 0, 'pulling must not advance the cursor');
  const applied = await apply(coordinator);
  assert.equal(applied.applied, 1);
  assert.equal(repo.ledger.cursor(SCOPE), 1);
  const providerId = repo.memory.formalProviderId(ENTRY, 1);
  assert.ok(providerId, 'the local mapping must record the Provider id');
  assert.equal((await provider.readMemory(providerId!)).content, '同步链路的正式记忆。');
  assert.equal(repo.memory.entryVersion(ENTRY), 1);
  assert.equal(accepted.version, 1);
  // The classification travels with the entry, so the local view can show what the origin
  // machine recorded instead of guessing from the body.
  const revision = repo.catalog.get(ENTRY).revisions[0]!;
  assert.equal(revision.category, 'fact');
  assert.equal(revision.importance, 3);
  assert.deepEqual(revision.tags, []);
  assert.equal(revision.knowledgeType, undefined, 'the sync path must not claim a local knowledge type');
});

test('a later revision replaces the previous one and keeps the supersedes edge', async () => {
  remote.submit(B_TOKEN, buildChange({ changeId: randomUUID(), baseVersion: 1, operation: 'update', entry: draft(2, '第二版正式记忆。') }));
  const coordinator = localCoordinator();
  await coordinator.pullScope(SCOPE);
  const applied = await apply(coordinator);
  assert.equal(applied.applied, 1);
  assert.equal(repo.ledger.cursor(SCOPE), 2);
  const first = repo.memory.formalProviderId(ENTRY, 1);
  const second = repo.memory.formalProviderId(ENTRY, 2);
  assert.ok(first && second && first !== second);
  assert.equal((await provider.readMemory(second!)).content, '第二版正式记忆。');
  const related = await provider.related(second!, 'supersedes', 1);
  assert.deepEqual(related.map((row) => row.id), [first]);
  assert.equal(repo.memory.entryVersion(ENTRY), 2);
});

test('a withdrawal stops recall but keeps the history readable', async () => {
  remote.submit(B_TOKEN, buildChange({ changeId: randomUUID(), baseVersion: 2, operation: 'delete', entry: draft(3, '第二版正式记忆。', NOW) }));
  const coordinator = localCoordinator();
  await coordinator.pullScope(SCOPE);
  const applied = await apply(coordinator);
  assert.equal(applied.applied, 1);
  assert.equal(repo.ledger.cursor(SCOPE), 3);
  assert.equal(repo.memory.entryVersion(ENTRY), 3);
  // The protocol promises withdrawn history stays readable: the Provider copy is not deleted,
  // only the catalog stops treating it as current. Physical deletion used to make `show` fail
  // and silently drop edges pointing at the memory.
  assert.ok(repo.memory.formalProviderId(ENTRY, 2), 'the previous mapping is kept');
  const second = repo.memory.formalProviderId(ENTRY, 2);
  const preserved = await provider.readMemory(second!);
  assert.equal(preserved.content, '第二版正式记忆。', 'the withdrawn body is still inspectable');
  assert.equal(repo.catalog.get(ENTRY).state, 'superseded', 'recall and injection skip it');
});
