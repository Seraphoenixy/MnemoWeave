import { tempDir } from '../support/temp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { SyncEntryDraftValue } from '../../packages/core/contracts/src/index.ts';
import { SyncCoordinator, buildChange, plainContent } from '../../packages/core/application/src/sync.ts';
import type { SyncRemotePort } from '../../packages/core/application/src/sync.ts';
import { applyInboxEntry } from '../../packages/core/application/src/sync-apply.ts';
import type { FormalProviderPort } from '../../packages/core/application/src/sync-apply.ts';
import { SyncStore } from '../../packages/infrastructure/sync-store/src/index.ts';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { MnemonCliProvider } from '../../packages/providers/mnemon/src/index.ts';
import { mnemonBinary } from './mnemon-binary.ts';

/**
 * Retention can move a stream's floor past a device cursor. The device then takes the
 * snapshot and rebuilds the same Revision chain the change stream would have produced.
 */

const TOKEN = 'f'.repeat(32);
const STREAM = 'formal-memories';
const ENTRY = '55555555-5555-4555-8555-555555555555';
const NOW = '2026-11-10T09:00:00.000Z';

function draft(version: number, body: string): SyncEntryDraftValue {
  return {
    entryId: ENTRY, kind: 'formal-memory', content: plainContent(body), withdrawnAt: null,
    payload: {
      category: 'fact', importance: 3, tags: [], entities: [],
      relations: version === 1 ? [] : [{ type: 'supersedes', from: { entryId: ENTRY, version: 1 }, to: { entryId: ENTRY, version } }],
    },
  };
}

test('a snapshot rebuilds the revision history when the retention floor passed the cursor', async () => {
  const dir = await tempDir('snapshot-rebuild', 'snapshot-rebuild');
  mkdirSync(join(dir, 'mnemon'), { recursive: true });
  const remotePath = join(dir, 'remote.db');
  const remote = new SyncStore({ path: remotePath, now: () => NOW });
  remote.enroll('device-local', TOKEN, [{ stream: STREAM, canRead: true, canWrite: true }]);
  remote.submit(TOKEN, buildChange({ changeId: randomUUID(), baseVersion: 0, operation: 'create', entry: draft(1, '第一版正式记忆。') }));
  remote.submit(TOKEN, buildChange({ changeId: randomUUID(), baseVersion: 1, operation: 'update', entry: draft(2, '第二版正式记忆。') }));
  assert.deepEqual(remote.changeRange(STREAM), { floor: 1, head: 2, count: 2 });

  // Simulate retention: the first change is gone, so the floor is now 2 while the
  // device cursor is still 0.
  const raw = new DatabaseSync(remotePath, { timeout: 5000 });
  raw.exec(`DELETE FROM sync_change_receipts WHERE seq = 1`);
  raw.exec(`DELETE FROM sync_changes WHERE stream = '${STREAM}' AND seq = 1`);
  raw.close();
  assert.deepEqual(remote.changeRange(STREAM), { floor: 2, head: 2, count: 1 });

  const repo = new SqliteCandidates(resolve(join(dir, 'governance.db')));
  const provider = new MnemonCliProvider({ binary: mnemonBinary(), dataDir: resolve(join(dir, 'mnemon')), store: 'snapshot' });
  const adapter: FormalProviderPort = {
    remember: async (content, source) => {
      const match = /^mnemoweave:([0-9a-f-]{36}):(\d+)$/.exec(source);
      if (!match) throw new Error(`unexpected sync source ${source}`);
      return { id: (await provider.syncRemember(content, match[1]!, Number(match[2]))).id };
    },
    linkSupersedes: (sourceId, targetId, metadata) => provider.linkSupersedes(sourceId, targetId, metadata),
    show: async (id) => provider.readMemory(id),
    forget: async (id) => provider.forget(id),
  };
  const port: Partial<SyncRemotePort> = {
    snapshot: async (stream) => remote.snapshot(TOKEN, stream),
    pull: async (stream, since, limit) => remote.pull(TOKEN, { stream, since, limit }),
  };
  const coordinator = new SyncCoordinator(port as SyncRemotePort, repo.ledger, () => NOW);
  try {
    const page = await coordinator.pullStream(STREAM);
    assert.equal(page.needsSnapshot, true, 'a cursor below the floor must ask for a snapshot');

    const applied: string[] = [];
    const result = await coordinator.captureSnapshot(STREAM, async (row) => {
      applied.push(`${row.version}:${row.entry.content.data}`);
      return applyInboxEntry(row, { store: repo.memory, provider: adapter, now: () => NOW });
    });
    assert.deepEqual(applied, ['1:第一版正式记忆。', '2:第二版正式记忆。']);
    assert.deepEqual(result, { applied: 2, failed: 0, cursor: 2 });
    assert.equal(repo.ledger.cursor(STREAM), 2);
    assert.equal(repo.ledger.inbox(STREAM).length, 0);
    assert.equal(repo.memory.entryVersion(ENTRY), 2);

    const first = repo.memory.formalProviderId(ENTRY, 1);
    const second = repo.memory.formalProviderId(ENTRY, 2);
    assert.ok(first && second && first !== second);
    assert.equal((await provider.readMemory(second)).content, '第二版正式记忆。');
    const related = await provider.related(second, 'supersedes', 1);
    assert.ok(related.some((item) => item.id === first), 'the rebuilt revision must still point at its predecessor');
    assert.equal(repo.memory.formalProviderId(ENTRY, 3), null);
  } finally {
    repo.close();
    remote.close();
  }
});

test('a device behind a fully pruned scope snapshots from the head and keeps pulling', async () => {
  const dir = await tempDir('snapshot-rebuild', 'snapshot-pruned');
  mkdirSync(join(dir, 'mnemon'), { recursive: true });
  const remote = new SyncStore({ path: join(dir, 'remote.db'), now: () => NOW });
  remote.enroll('device-local', TOKEN, [{ stream: STREAM, canRead: true, canWrite: true }]);
  remote.submit(TOKEN, buildChange({ changeId: randomUUID(), baseVersion: 0, operation: 'create', entry: draft(1, '第一版正式记忆。') }));
  remote.submit(TOKEN, buildChange({ changeId: randomUUID(), baseVersion: 1, operation: 'update', entry: draft(2, '第二版正式记忆。') }));

  // Retention removes every change row; the scope head must survive it.
  assert.equal(remote.prune({ now: new Date(Date.parse(NOW) + 100 * 86_400_000).toISOString(), retentionDays: 90 }).changes, 2);
  assert.deepEqual(remote.changeRange(STREAM), { floor: 0, head: 0, count: 0 });

  const repo = new SqliteCandidates(resolve(join(dir, 'governance.db')));
  const provider = new MnemonCliProvider({ binary: mnemonBinary(), dataDir: resolve(join(dir, 'mnemon')), store: 'snapshot_pruned' });
  const adapter: FormalProviderPort = {
    remember: async (content, source) => {
      const match = /^mnemoweave:([0-9a-f-]{36}):(\d+)$/.exec(source);
      if (!match) throw new Error(`unexpected sync source ${source}`);
      return { id: (await provider.syncRemember(content, match[1]!, Number(match[2]))).id };
    },
    linkSupersedes: (sourceId, targetId, metadata) => provider.linkSupersedes(sourceId, targetId, metadata),
    show: async (id) => provider.readMemory(id),
    forget: async (id) => provider.forget(id),
  };
  const port: Partial<SyncRemotePort> = {
    snapshot: async (stream) => remote.snapshot(TOKEN, stream),
    pull: async (stream, since, limit) => remote.pull(TOKEN, { stream, since, limit }),
  };
  const coordinator = new SyncCoordinator(port as SyncRemotePort, repo.ledger, () => NOW);
  try {
    const page = await coordinator.pullStream(STREAM);
    assert.equal(page.needsSnapshot, true, 'a cursor inside a fully pruned range must snapshot');

    const result = await coordinator.captureSnapshot(STREAM, async (row) =>
      applyInboxEntry(row, { store: repo.memory, provider: adapter, now: () => NOW }));
    assert.deepEqual(result, { applied: 2, failed: 0, cursor: 2 });
    assert.equal(repo.ledger.cursor(STREAM), 2);
    assert.equal(repo.memory.entryVersion(ENTRY), 2);

    // A change registered after the cleanup continues the sequence.
    const accepted = remote.submit(TOKEN, buildChange({ changeId: randomUUID(), baseVersion: 2, operation: 'update', entry: draft(3, '第三版正式记忆。') }));
    assert.equal(accepted.seq, 3);
    const next = await coordinator.pullStream(STREAM);
    assert.equal(next.needsSnapshot, false);
    assert.equal(next.received, 1);
    const appliedNext = await coordinator.applyStream(STREAM, async (row) =>
      applyInboxEntry(row, { store: repo.memory, provider: adapter, now: () => NOW }));
    assert.equal(appliedNext.applied, 1);
    assert.equal(repo.ledger.cursor(STREAM), 3);
    assert.equal(repo.memory.entryVersion(ENTRY), 3);
  } finally {
    repo.close();
    remote.close();
  }
});
