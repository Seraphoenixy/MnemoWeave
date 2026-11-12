import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MnemoWeaveError, SyncChangeInput } from '../../packages/core/contracts/src/index.ts';
import type { SyncChangeRequest, SyncEntryDraftValue } from '../../packages/core/contracts/src/index.ts';
import { buildChange, planPull, plainContent, VersionConflictError } from '../../packages/core/application/src/sync.ts';
import { SyncStore } from '../../packages/infrastructure/sync-store/src/index.ts';

const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);
const NOW = '2026-11-10T04:00:00.000Z';

function openStore(archiveCapacityBytes?: number) {
  const dir = join('work', 'sync-store-test', randomUUID());
  mkdirSync(dir, { recursive: true });
  const store = new SyncStore({ path: join(dir, 'sync.db'), now: () => NOW, ...(archiveCapacityBytes === undefined ? {} : { archiveCapacityBytes }) });
  store.enroll('device-a', TOKEN_A, [
    { stream: 'rules', canRead: true, canWrite: true },
    { stream: 'formal-memories', canRead: true, canWrite: true },
    { stream: 'workspace-archives:11111111-1111-4111-8111-111111111111', canRead: true, canWrite: true },
  ]);
  store.enroll('device-b', TOKEN_B, [{ stream: 'formal-memories', canRead: true, canWrite: true }]);
  return store;
}

const WORKSPACE = '11111111-1111-4111-8111-111111111111';

function draft(overrides: Partial<SyncEntryDraftValue> = {}): SyncEntryDraftValue {
  return {
    entryId: overrides.entryId ?? randomUUID(),
    kind: overrides.kind ?? 'rule',
    content: overrides.content ?? plainContent('提交前必须运行类型检查。'),
    payload: overrides.payload ?? { enabled: true },
    withdrawnAt: overrides.withdrawnAt ?? null,
  };
}

function archiveDraft(overrides: Partial<SyncEntryDraftValue> = {}): SyncEntryDraftValue {
  return {
    entryId: overrides.entryId ?? randomUUID(),
    kind: 'workspace-archive',
    content: overrides.content ?? plainContent('串口约定：115200。'),
    payload: overrides.payload ?? {
      workspaceId: WORKSPACE, title: '串口约定', source: 'user', verification: 'open', evidence: '实测', tags: [],
    },
    withdrawnAt: overrides.withdrawnAt ?? null,
  };
}

function create(entry: SyncEntryDraftValue, changeId = randomUUID()): SyncChangeRequest {
  return buildChange({ changeId, baseVersion: 0, operation: 'create', entry });
}

function update(entry: SyncEntryDraftValue, baseVersion: number, changeId = randomUUID()): SyncChangeRequest {
  return buildChange({ changeId, baseVersion, operation: 'update', entry });
}

test('devices authenticate by hashed token and lose access when revoked', () => {
  const store = openStore();
  try {
    assert.deepEqual(store.streams(TOKEN_A).streams.map((item) => item.stream).sort(), ['formal-memories', 'rules', `workspace-archives:${WORKSPACE}`]);
    assert.throws(() => store.streams('c'.repeat(32)), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'UNAUTHORIZED');
    store.revoke('device-a');
    assert.throws(() => store.streams(TOKEN_A), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'DEVICE_REVOKED');
  } finally {
    store.close();
  }
});

test('a submitted change gets the next version and a per-stream sequence', () => {
  const store = openStore();
  try {
    const first = create(draft());
    const accepted = store.submit(TOKEN_A, first);
    assert.equal(accepted.version, 1);
    assert.equal(accepted.seq, 1);
    assert.equal(accepted.duplicate, false);
    assert.equal(store.submit(TOKEN_A, first).duplicate, true);
    assert.equal(store.submit(TOKEN_A, first).seq, 1);
  } finally {
    store.close();
  }
});

test('a reused change id with different content is rejected', () => {
  const store = openStore();
  try {
    const entry = draft();
    const first = create(entry);
    store.submit(TOKEN_A, first);
    const altered = buildChange({ changeId: first.changeId, baseVersion: 0, operation: 'create', entry: { ...entry, content: plainContent('另一条正文。') } });
    assert.throws(() => store.submit(TOKEN_A, altered), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'CHANGE_ID_REUSED');
  } finally {
    store.close();
  }
});

test('a stale base version is refused and reports the current version', () => {
  const store = openStore();
  try {
    const entry = draft();
    store.submit(TOKEN_A, create(entry));
    assert.throws(
      () => store.submit(TOKEN_A, SyncChangeInput.parse({ changeId: randomUUID(), baseVersion: 0, operation: 'update', entry })),
      (error: unknown) => error instanceof VersionConflictError && error.currentVersion === 1 && error.code === 'VERSION_CONFLICT',
    );
    store.submit(TOKEN_A, update({ ...entry, content: plainContent('第二版正文。') }, 1));
    assert.throws(
      () => store.submit(TOKEN_A, update({ ...entry, content: plainContent('基于旧版本的更正。') }, 1)),
      (error: unknown) => error instanceof VersionConflictError && error.currentVersion === 2,
    );
    assert.throws(
      () => store.submit(TOKEN_A, buildChange({ changeId: randomUUID(), baseVersion: 0, operation: 'create', entry })),
      (error: unknown) => error instanceof VersionConflictError && error.currentVersion === 2,
    );
  } finally {
    store.close();
  }
});

test('writing a stream the device was not granted is refused', () => {
  const store = openStore();
  try {
    assert.throws(() => store.submit(TOKEN_B, create(draft())), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'SCOPE_FORBIDDEN');
    assert.throws(() => store.submit(TOKEN_B, create(archiveDraft())), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'SCOPE_FORBIDDEN');
    assert.throws(() => store.pull(TOKEN_B, { stream: 'rules', since: 0, limit: 10 }), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'SCOPE_FORBIDDEN');
    // Holding one workspace stream grant does not grant a formal-memory stream.
    assert.throws(() => store.pull(TOKEN_B, { stream: `workspace-archives:${WORKSPACE}`, since: 0, limit: 10 }), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'SCOPE_FORBIDDEN');
  } finally {
    store.close();
  }
});

test('a change cannot name a stream, and its stream is derived from the entry', () => {
  const store = openStore();
  try {
    const entry = draft();
    // A client-supplied stream or scope is not part of the protocol: strict parsing refuses it.
    // Both a schema rejection and the public INVALID_INPUT form mean the same thing to a caller.
    const refused = (error: unknown): boolean =>
      (error instanceof MnemoWeaveError && error.code === 'INVALID_INPUT') || (error instanceof Error && error.name === 'ZodError');
    assert.throws(() => SyncChangeInput.parse({ changeId: randomUUID(), baseVersion: 0, operation: 'create', entry: { ...entry, stream: 'formal-memories' } }), refused);
    assert.throws(() => SyncChangeInput.parse({ changeId: randomUUID(), baseVersion: 0, operation: 'create', entry: { ...entry, scope: 'global' } }), refused);
    const accepted = store.submit(TOKEN_A, create(entry));
    assert.equal(accepted.stream, 'rules');
    const archived = store.submit(TOKEN_A, create(archiveDraft()));
    assert.equal(archived.stream, `workspace-archives:${WORKSPACE}`);
    // A workspace archive whose payload names a different workspace is in another stream.
    assert.throws(
      () => store.submit(TOKEN_A, create({ ...archiveDraft(), payload: { ...archiveDraft().payload, workspaceId: randomUUID() } })),
      (error: unknown) => error instanceof MnemoWeaveError && error.code === 'SCOPE_FORBIDDEN',
    );
  } finally {
    store.close();
  }
});

test('sequences stay contiguous per stream and paging never skips', () => {
  const store = openStore();
  try {
    const one = draft();
    const two = draft();
    store.submit(TOKEN_A, create(one));
    store.submit(TOKEN_A, create(two));
    store.submit(TOKEN_A, update({ ...one, content: plainContent('更新后的正文。') }, 1));
    const all = store.pull(TOKEN_A, { stream: 'rules', since: 0, limit: 10 });
    assert.deepEqual(all.changes.map((item) => item.seq), [1, 2, 3]);
    assert.equal(all.retentionFloor, 1);
    assert.equal(all.hasMore, false);
    assert.equal(all.nextSince, 3);
    const page = store.pull(TOKEN_A, { stream: 'rules', since: 1, limit: 1 });
    assert.deepEqual(page.changes.map((item) => item.seq), [2]);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextSince, 2);
    assert.deepEqual(store.pull(TOKEN_A, { stream: 'rules', since: 3, limit: 10 }).changes, []);
  } finally {
    store.close();
  }
});

test('entry reads carry the revision chain and refuse other streams', () => {
  const store = openStore();
  try {
    const entry = draft({ kind: 'formal-memory', payload: { category: 'fact', importance: 3, tags: [], entities: [], relations: [] } });
    store.submit(TOKEN_A, create(entry));
    store.submit(TOKEN_A, update({ ...entry, content: plainContent('第二版正式记忆。') }, 1));
    const current = store.entry(TOKEN_A, entry.entryId);
    assert.equal(current.version, 2);
    assert.deepEqual(current.revisions?.map((item) => item.version), [1, 2]);
    // Device B holds only the formal-memory stream, so an archive entry is outside its reach.
    const archive = archiveDraft();
    store.submit(TOKEN_A, create(archive));
    assert.throws(() => store.entry(TOKEN_B, archive.entryId), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'SCOPE_FORBIDDEN');
    assert.throws(() => store.entry(TOKEN_A, randomUUID()), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'NOT_FOUND');
  } finally {
    store.close();
  }
});

test('a snapshot is a consistent cut point and carries formal history', () => {
  const store = openStore();
  try {
    const formal = draft({ kind: 'formal-memory', payload: { category: 'decision', importance: 4, tags: ['sync'], entities: ['mnemoweave'], relations: [] } });
    store.submit(TOKEN_A, create(formal));
    store.submit(TOKEN_A, update({ ...formal, content: plainContent('第二版正式记忆。') }, 1));
    store.submit(TOKEN_A, create(draft({ payload: { enabled: true } })));
    const snapshot = store.snapshot(TOKEN_A, 'formal-memories');
    assert.equal(snapshot.asOfSeq, snapshot.nextSince);
    assert.equal(snapshot.asOfSeq, 2);
    assert.equal(snapshot.entries.length, 1);
    assert.deepEqual(snapshot.entries[0]?.revisions?.map((item) => item.version), [1, 2]);
    const rules = store.snapshot(TOKEN_A, 'rules');
    assert.equal(rules.asOfSeq, 1);
    assert.throws(() => store.snapshot(TOKEN_B, 'rules'), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'SCOPE_FORBIDDEN');
  } finally {
    store.close();
  }
});

test('pruning keeps a per-stream prefix rule and outlives changes with receipts', () => {
  const store = openStore();
  try {
    const first = create(draft());
    store.submit(TOKEN_A, first);
    store.submit(TOKEN_A, create(draft()));
    store.submit(TOKEN_A, create(draft()));
    assert.deepEqual(store.changeRange('rules'), { floor: 1, head: 3, count: 3 });

    // Hard cap keeps the newest changes and drops a prefix, never a hole.
    assert.equal(store.prune({ now: NOW, maxChangesPerStream: 2 }).changes, 1);
    assert.deepEqual(store.changeRange('rules'), { floor: 2, head: 3, count: 2 });

    // Age removes the rest; the receipt still resolves a changeId that is gone.
    assert.equal(store.prune({ now: new Date(Date.parse(NOW) + 100 * 86_400_000).toISOString(), retentionDays: 90 }).changes, 2);
    assert.deepEqual(store.changeRange('rules'), { floor: 0, head: 0, count: 0 });
    assert.equal(store.receipt(TOKEN_A, first.changeId).seq, 1);

    // Receipts themselves expire later than changes.
    const later = new Date(Date.parse(NOW) + 400 * 86_400_000).toISOString();
    assert.equal(store.prune({ now: later, receiptDays: 365 }).receipts, 3);
    assert.throws(() => store.receipt(TOKEN_A, first.changeId), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'NOT_FOUND');
  } finally {
    store.close();
  }
});

test('pruning one stream leaves other streams and their cursors alone', () => {
  const store = openStore();
  try {
    store.submit(TOKEN_A, create(draft({ kind: 'formal-memory', payload: { category: 'fact', importance: 3, tags: [], entities: [], relations: [] } })));
    store.submit(TOKEN_A, create(draft()));
    const result = store.prune({ now: new Date(Date.parse(NOW) + 100 * 86_400_000).toISOString(), retentionDays: 90 });
    assert.equal(result.streams, 2);
    assert.equal(result.changes, 2);
    assert.deepEqual(store.pull(TOKEN_A, { stream: 'rules', since: 0, limit: 10 }).changes, []);
  } finally {
    store.close();
  }
});

test('pruning a whole stream keeps the sequence head so devices are not stranded', () => {
  const store = openStore();
  try {
    store.submit(TOKEN_A, create(draft()));
    store.submit(TOKEN_A, create(draft()));
    store.submit(TOKEN_A, create(draft()));
    assert.equal(store.prune({ now: new Date(Date.parse(NOW) + 100 * 86_400_000).toISOString(), retentionDays: 90 }).changes, 3);
    assert.deepEqual(store.changeRange('rules'), { floor: 0, head: 0, count: 0 });

    const revived = create(draft());
    const accepted = store.submit(TOKEN_A, revived);
    assert.equal(accepted.seq, 4, 'sequence numbers must continue after the retained rows are gone');
    assert.deepEqual(store.changeRange('rules'), { floor: 4, head: 4, count: 1 });

    // A device at cursor 3 continues; a device at 0 must snapshot instead of hitting a gap.
    const behind = store.pull(TOKEN_A, { stream: 'rules', since: 3, limit: 10 });
    assert.equal(behind.retentionFloor, 4);
    assert.deepEqual(behind.changes.map((change) => change.seq), [4]);
    assert.equal(planPull(behind, 3).apply.length, 1);
    assert.equal(planPull(behind, 3).needsSnapshot, false);

    const stale = store.pull(TOKEN_A, { stream: 'rules', since: 0, limit: 10 });
    assert.equal(planPull(stale, 0).needsSnapshot, true, 'a cursor below the floor must use a snapshot');

    const snapshot = store.snapshot(TOKEN_A, 'rules');
    assert.equal(snapshot.asOfSeq, 4);
    assert.equal(snapshot.nextSince, 4);
  } finally {
    store.close();
  }
});

test('a protocol-1 database is switched to streams without carrying an old cursor forward', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdirSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  const { join, resolve } = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  mkdirSync(join('work', 'tests'), { recursive: true });
  const path = join(resolve('work/tests'), `sync-v2-${randomUUID()}`, 'sync.db');
  mkdirSync(resolve(path, '..'), { recursive: true });
  // Build the protocol-1 shape by hand: scope grants, a shared scope head and a few changes.
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE sync_devices(device_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, revoked_at TEXT);
    CREATE TABLE sync_device_scopes(device_id TEXT NOT NULL, scope TEXT NOT NULL, can_read INTEGER NOT NULL, can_write INTEGER NOT NULL, PRIMARY KEY(device_id, scope));
    CREATE TABLE sync_scope_heads(scope TEXT PRIMARY KEY, head INTEGER NOT NULL);
    CREATE TABLE sync_changes(scope TEXT NOT NULL, seq INTEGER NOT NULL, change_id TEXT NOT NULL UNIQUE, entry_id TEXT NOT NULL, version INTEGER NOT NULL, operation TEXT NOT NULL, entry_json TEXT NOT NULL, device_id TEXT NOT NULL, recorded_at TEXT NOT NULL, PRIMARY KEY(scope, seq));
    CREATE TABLE sync_change_receipts(change_id TEXT PRIMARY KEY, scope TEXT NOT NULL, entry_id TEXT NOT NULL, version INTEGER NOT NULL, seq INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE sync_entries(entry_id TEXT PRIMARY KEY, kind TEXT NOT NULL, version INTEGER NOT NULL, content_json TEXT NOT NULL, payload_json TEXT NOT NULL, withdrawn_at TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE sync_entry_revisions(entry_id TEXT NOT NULL, version INTEGER NOT NULL, content_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(entry_id, version));
    PRAGMA user_version=2;
  `);
  // The stored value is the SHA-256 of the device token, as `enroll` would write it.
  db.prepare("INSERT INTO sync_devices VALUES('device-a', ?, '2026-11-10T00:00:00.000Z', NULL)").run(hash('a'.repeat(32)));
  db.prepare("INSERT INTO sync_device_scopes VALUES('device-a','global',1,1)").run();
  db.prepare("INSERT INTO sync_device_scopes VALUES('device-a','project:alpha',1,1)").run();
  db.prepare("INSERT INTO sync_scope_heads VALUES('global', 4)").run();
  const ruleId = '11111111-1111-4111-8111-111111111111';
  const archiveId = '22222222-2222-4222-8222-222222222222';
  db.prepare("INSERT INTO sync_entries VALUES(?,'runtime',1,?,?,NULL,'2026-11-10T00:00:00.000Z')").run(ruleId, JSON.stringify({ format: 'plain', data: 'x', contentHash: 'a'.repeat(64), byteLength: 1 }), JSON.stringify({ enabled: true }));
  db.prepare("INSERT INTO sync_entries VALUES(?,'archive',1,?,?,NULL,'2026-11-10T00:00:00.000Z')").run(archiveId, JSON.stringify({ format: 'plain', data: 'y', contentHash: 'b'.repeat(64), byteLength: 1 }), JSON.stringify({ projectId: 'alpha', title: 't', source: 'user', verification: 'open', evidence: '', tags: [] }));
  db.close();

  assert.throws(() => new SyncStore({ path }), /Missing workspace migration mapping/);
  const alpha = { workspaceId: WORKSPACE, name: 'Alpha' };
  assert.throws(() => new SyncStore({ path, legacyWorkspaces: { alpha, beta: alpha } }), /different device permissions/);
  const store = new SyncStore({ path, legacyWorkspaces: { alpha } });
  try {
    assert.deepEqual(store.streams(TOKEN_A).streams.map(item => item.stream).sort(), ['formal-memories', 'rules', `workspace-archives:${WORKSPACE}`]);
    // Old cursors are gone: each stream starts from a snapshot at zero.
    assert.deepEqual(store.changeRange('rules'), { floor: 0, head: 0, count: 0 });
    assert.deepEqual(store.changeRange('formal-memories'), { floor: 0, head: 0, count: 0 });
    // Entries keep their version and body, re-keyed by the derived stream.
    const rules = store.snapshot('a'.repeat(32), 'rules');
    assert.deepEqual(rules.entries.map(entry => entry.entryId), [ruleId]);
    assert.equal(rules.entries[0]?.version, 1);
    assert.equal(rules.entries[0]?.kind, 'rule', 'the legacy kind is renamed to its target name');
    const archiveStream = 'workspace-archives:11111111-1111-4111-8111-111111111111';
    assert.deepEqual(store.changeRange(archiveStream), { floor: 0, head: 0, count: 0 });
    assert.equal(store.pull(TOKEN_A, { stream: archiveStream, since: 0, limit: 20 }).snapshotAtStart, true);
    assert.equal(store.snapshot(TOKEN_A, archiveStream).entries[0]?.entryId, archiveId);
  } finally { store.close(); }
});

test('remote archive capacity counts active bodies and frees space after confirmed archive', () => {
  const store = openStore(8);
  try {
    const first = archiveDraft({ content: plainContent('12345678') });
    const second = archiveDraft({ content: plainContent('a') });
    store.submit(TOKEN_A, create(first));
    assert.throws(() => store.submit(TOKEN_A, create(second)), { code: 'ARCHIVE_CAPACITY_EXCEEDED' });
    store.submit(TOKEN_A, update({ ...first, payload: { ...first.payload, state: 'archived' } } as SyncEntryDraftValue, 1));
    assert.equal(store.submit(TOKEN_A, create(second)).seq, 3);
  } finally { store.close(); }
});

test('remote rule capacity includes disabled rules', () => {
  const store = openStore();
  try {
    store.submit(TOKEN_A, create(draft({ payload: { enabled: false }, content: plainContent('a'.repeat(9999)) })));
    assert.throws(() => store.submit(TOKEN_A, create(draft())), { code: 'RULE_CAPACITY_EXCEEDED' });
  } finally { store.close(); }
});

test('remote same-body formal creates reuse the authoritative id and receipt without advancing the stream', () => {
  const store = openStore();
  try {
    const payload = { category: 'fact' as const, importance: 3, tags: [], entities: [], relations: [] };
    const entry = draft({ kind: 'formal-memory', payload });
    const first = store.submit(TOKEN_A, create(entry));
    const second = create({ ...entry, entryId: randomUUID() });
    const duplicate = store.submit(TOKEN_A, second);
    assert.equal(duplicate.entryId, first.entryId);
    assert.equal(duplicate.version, first.version);
    assert.equal(duplicate.seq, 0);
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(store.receipt(TOKEN_A, second.changeId), duplicate);
    assert.equal(store.changeRange('formal-memories').head, 1);
  } finally { store.close(); }
});
