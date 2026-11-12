import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { RememberInput, MnemoWeaveError } from '../../packages/core/contracts/src/index.ts';
import { tempDir } from '../support/temp.ts';

const fixture = (key = 'candidate-key-001') => RememberInput.parse({
  idempotencyKey: key, content: 'Immutable candidate content, not yet approved.',
  provenance: { source: 'test', sourceReference: 'fixture:1', evidence: ['a deterministic test'], verificationStatus: 'unverified', confidence: 0.5, applicability: 'isolated fixture', limitations: 'not production knowledge', lastVerified: null },
});
test('Candidate and submission receipt persist atomically with stable idempotency', async () => {
  await mkdir('work/tests', { recursive: true });
  const path = join(await tempDir('governance', 'governance'), 'state.db');
  const repo = new SqliteCandidates(path);
  const first = repo.submit(fixture());
  assert.equal(first.status, 'pending_review');
  assert.equal(first.receipt.status, 'candidate');
  assert.deepEqual(repo.submit(fixture()), first);
  assert.throws(() => repo.submit({ ...fixture(), content: 'conflicting payload' }), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'IDEMPOTENCY_CONFLICT');
  repo.close();
  const reopened = new SqliteCandidates(path);
  try { assert.deepEqual(reopened.get(first.id), first); } finally { reopened.close(); }
  const inspect = new DatabaseSync(path);
  try {
    assert.equal(inspect.prepare('SELECT count(*) n FROM governance_candidates').get()!['n'], 1);
    assert.equal(inspect.prepare('SELECT count(*) n FROM governance_submission_receipts').get()!['n'], 1);
  } finally { inspect.close(); }
});
test('Failed receipt insertion rolls back candidate insertion', async () => {
  await mkdir('work/tests', { recursive: true });
  const path = join(await tempDir('governance', 'rollback'), 'state.db');
  const repo = new SqliteCandidates(path);
  const inject = new DatabaseSync(path);
  inject.exec('CREATE TRIGGER fail_receipt BEFORE INSERT ON governance_submission_receipts BEGIN SELECT RAISE(ABORT, \'injected receipt failure\'); END');
  assert.throws(() => repo.submit(fixture()));
  assert.equal(inject.prepare('SELECT count(*) n FROM governance_candidates').get()!['n'], 0);
  inject.exec('DROP TRIGGER fail_receipt');
  assert.equal(repo.submit(fixture()).status, 'pending_review');
  repo.close(); inject.close();
});
test('schema v23 is the workspace model: no owner on a memory, workspaces and streams on the rest', async () => {
  await mkdir('work/tests', { recursive: true });
  const path = join(await tempDir('governance', 'schema22'), 'governance.db');
  const repo = new SqliteCandidates(path);
  repo.close();
  const inspect = new DatabaseSync(path);
  try {
    assert.equal(Number(inspect.prepare('PRAGMA user_version').get()!['user_version']), 23);
    const tables = new Set((inspect.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((row) => row.name));
    for (const name of [
      'entry_versions', 'share_outbox', 'sync_state', 'sync_outbox', 'sync_inbox', 'formal_map',
      'runtime_rules', 'project_archives', 'project_bindings', 'runtime_injections',
      'runtime_rule_archive', 'project_archive_revisions', 'diagnostic_jobs',
      'workspaces', 'workspace_bindings', 'session_workspaces', 'write_task_receipts',
      'archive_distillations', 'turn_sessions', 'turn_no_retention',
    ]) assert.ok(tables.has(name), name);
    for (const legacy of ['sync_log', 'sync_grants', 'sync_license_state', 'legacy_project_owners']) {
      // The backup table exists only when there was something to preserve.
      if (legacy === 'legacy_project_owners') continue;
      assert.equal(tables.has(legacy), false, legacy);
    }
    const ruleColumns = new Set((inspect.prepare("SELECT name FROM pragma_table_info('runtime_rules')").all() as { name: string }[]).map(row => row.name));
    for (const name of ['importance', 'pinned', 'created_at', 'archived_at']) assert.ok(ruleColumns.has(name), name);
    const revisionColumns = new Set((inspect.prepare("SELECT name FROM pragma_table_info('catalog_revisions')").all() as { name: string }[]).map(row => row.name));
    for (const name of ['category', 'importance', 'tags_json', 'entities_json']) assert.ok(revisionColumns.has(name), name);
    // v23 removed the knowledge-type column; the migration test proves it is gone.
    assert.ok(!revisionColumns.has('knowledge_type'), 'the removed dimension has no column');
    // A memory has no owner: the shared collection is the whole store.
    const memoryColumns = new Set((inspect.prepare("SELECT name FROM pragma_table_info('catalog_memories')").all() as { name: string }[]).map(row => row.name));
    assert.equal(memoryColumns.has('project_id'), false, 'no owner column on a formal memory');
    // An archive is keyed by a workspace instead.
    const archiveColumns = new Set((inspect.prepare("SELECT name FROM pragma_table_info('project_archives')").all() as { name: string }[]).map(row => row.name));
    for (const name of ['state', 'archived_at', 'workspace_id']) assert.ok(archiveColumns.has(name), name);
    assert.equal(archiveColumns.has('project_id'), false);
    // Sync ledgers are keyed by stream.
    for (const table of ['sync_state', 'sync_outbox', 'sync_inbox']) {
      const columns = new Set((inspect.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map(row => row.name));
      assert.ok(columns.has('stream'), `${table} keeps one row per stream`);
      assert.equal(columns.has('scope'), false, `${table} has no scope`);
    }
  } finally {
    inspect.close();
  }
});
test('a v21 store loses the memory owner column and keeps the attribution as a backup', async () => {
  await mkdir('work/tests', { recursive: true });
  const path = join(await tempDir('governance', 'schema21'), 'governance.db');
  const created = new SqliteCandidates(path);
  created.close();
  // Rebuild the v21 shape: the owner column and its index existed, and a memory carried one.
  const downgrade = new DatabaseSync(path);
  downgrade.exec(`
    ALTER TABLE catalog_memories ADD COLUMN project_id TEXT;
    CREATE INDEX IF NOT EXISTS catalog_memories_project ON catalog_memories(project_id);
    PRAGMA user_version=21;
  `);
  downgrade.close();
  const migrated = new SqliteCandidates(path);
  migrated.close();
  const inspect = new DatabaseSync(path);
  try {
    assert.equal(Number(inspect.prepare('PRAGMA user_version').get()!['user_version']), 23);
    const columns = new Set((inspect.prepare("SELECT name FROM pragma_table_info('catalog_memories')").all() as { name: string }[]).map(row => row.name));
    assert.equal(columns.has('project_id'), false, 'the owner column is dropped, not merely ignored');
    // The attribution survives in the backup table so an operator can still answer where a
    // memory came from; no read path consults it.
    const backup = inspect.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='legacy_project_owners'").get();
    assert.ok(backup, 'the legacy attribution is preserved');
  } finally {
    inspect.close();
  }
});
test('v21 archive migration requires a project mapping and preserves the version history', async () => {
  await mkdir('work/tests', { recursive: true });
  const path = join(await tempDir('governance', 'schema21-archive'), 'governance.db');
  const source = new SqliteCandidates(path);
  const entryId = '22222222-2222-4222-8222-222222222222';
  const at = '2026-11-10T00:00:00.000Z';
  const archive = { entryId, workspaceId: 'alpha', title: 'archive', body: 'first', source: 'user' as const,
    verification: 'open' as const, evidence: '', withdrawnAt: null, version: 1, updatedAt: at };
  source.memory.upsertArchive(archive, at);
  source.memory.upsertArchive({ ...archive, body: 'second', version: 2, state: 'archived', archivedAt: at }, at);
  const request = fixture();
  const candidate = source.submit(request);
  const hash = createHash('sha256').update(request.content).digest('hex');
  const memoryId = source.catalog.publishInitial(candidate.id, request, 'legacy-provider-id', hash, at).memoryId;
  source.memory.upsertFormalMap({ entryId: memoryId, version: 1, providerId: 'legacy-provider-id',
    contentHash: hash, state: 'applied', appliedAt: at }, at);
  source.close();
  const old = new DatabaseSync(path);
  old.exec(`
    ALTER TABLE project_archives RENAME COLUMN workspace_id TO project_id;
    ALTER TABLE project_archive_revisions RENAME COLUMN workspace_id TO project_id;
    ALTER TABLE sync_state RENAME COLUMN stream TO scope;
    ALTER TABLE sync_outbox RENAME COLUMN stream TO scope;
    ALTER TABLE sync_inbox RENAME COLUMN stream TO scope;
    PRAGMA user_version=21;
  `);
  old.close();
  assert.throws(() => new SqliteCandidates(path), /Missing workspace migration mapping/);
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const migrated = new SqliteCandidates(path, { legacyWorkspaces: { alpha: { workspaceId, name: 'Alpha' } } });
  try {
    assert.equal(migrated.memory.archive(entryId)?.workspaceId, workspaceId);
    assert.equal(migrated.memory.archive(entryId)?.state, 'archived');
    assert.deepEqual(migrated.memory.archiveHistory(entryId).map(row => [row.version, row.workspace_id, row.body]),
      [[2, workspaceId, 'second'], [1, workspaceId, 'first']]);
    assert.deepEqual(migrated.catalog.visibleProviderIds(), []);
    assert.throws(() => migrated.catalog.get(memoryId), { code: 'NOT_FOUND' });
    migrated.catalog.verifyMigratedFormalEntries([memoryId]);
    assert.deepEqual(migrated.catalog.visibleProviderIds(), ['legacy-provider-id']);
    assert.equal(migrated.catalog.get(memoryId).id, memoryId);
  } finally { migrated.close(); }
});
test('snapshot stages hide changes until the cursor and projection commit together', async () => {
  await mkdir('work/tests', { recursive: true });
  const path = join(await tempDir('governance', 'snapshot-stage'), 'governance.db');
  const repo = new SqliteCandidates(path);
  const at = '2026-11-10T00:00:00.000Z';
  const row = { entryId: '22222222-2222-4222-8222-222222222222', version: 1, body: 'original', enabled: true, withdrawnAt: null };
  try {
    repo.memory.upsertRule(row, at);
    repo.ledger.setCursor('rules', 1, at);
    const stage = repo.memory.stageSnapshot();
    stage.store.upsertRule({ ...row, version: 2, body: 'new' }, at);
    assert.equal(repo.memory.rule(row.entryId)?.body, 'original');
    assert.throws(() => stage.commit(() => {
      repo.ledger.resetScope('rules', 2, at);
      throw new Error('switch failed');
    }), /switch failed/);
    assert.equal(repo.memory.rule(row.entryId)?.body, 'original');
    assert.equal(repo.ledger.cursor('rules'), 1);
    stage.commit(() => repo.ledger.resetScope('rules', 2, at));
    assert.equal(repo.memory.rule(row.entryId)?.body, 'new');
    assert.equal(repo.ledger.cursor('rules'), 2);
  } finally { repo.close(); }
});
test('diagnostic jobs are single-flight and a killed run is marked interrupted', async () => {
  await mkdir('work/tests', { recursive: true });
  const path = join(await tempDir('governance', 'jobs'), 'governance.db');
  let repo = new SqliteCandidates(path);
  const job = repo.memory.beginDiagnosticJob('embedding-backfill');
  assert.equal(job.state, 'running');
  assert.throws(() => repo.memory.beginDiagnosticJob('embedding-backfill'), (error: unknown) => (error as { code?: string }).code === 'INVALID_STATE');
  repo.memory.finishDiagnosticJob(job.id, 'succeeded', { embeddedAfter: 3 });
  assert.equal(repo.memory.diagnosticJob('embedding-backfill')?.state, 'succeeded');
  assert.equal(repo.memory.diagnosticJob('embedding-backfill')?.detail?.['embeddedAfter'], 3);
  repo.memory.beginDiagnosticJob('embedding-backfill');
  repo.close();
  // Reopening proves the process that owned the running job is gone.
  repo = new SqliteCandidates(path);
  try {
    assert.equal(repo.memory.diagnosticJob('embedding-backfill')?.state, 'interrupted');
  } finally { repo.close(); }
});
test('idle-review runs are single-flight and refuse late items after finishing', async () => {
  await mkdir('work/tests', { recursive: true });
  const path = join(await tempDir('governance', 'runs'), 'governance.db');
  let repo = new SqliteCandidates(path);
  const run = repo.events.beginIdleRun('host-1', 's-1');
  assert.equal(run.state, 'running');
  assert.equal(run.attempt, 1);
  assert.throws(() => repo.events.beginIdleRun('host-1', 's-1'), (error: unknown) => (error as { code?: string }).code === 'INVALID_STATE');
  const updated = repo.events.recordIdleRunItem('host-1', run.id, { index: 0, action: 'create', kind: 'rule', state: 'applied', targetId: 'memory-1' });
  assert.equal(updated.items.length, 1);
  assert.throws(() => repo.events.recordIdleRunItem('host-1', run.id, { index: 0, action: 'create', kind: 'rule', state: 'applied' }), (error: unknown) => (error as { code?: string }).code === 'INVALID_INPUT');
  const finished = repo.events.finishIdleRun('host-1', run.id, 'succeeded');
  assert.equal(finished.state, 'succeeded');
  assert.ok(finished.finishedAt !== null);
  assert.throws(() => repo.events.recordIdleRunItem('host-1', run.id, { index: 1, action: 'skip', kind: 'formal-memory', state: 'skipped' }), (error: unknown) => (error as { code?: string }).code === 'INVALID_STATE');
  const second = repo.events.beginIdleRun('host-1', 's-1');
  assert.equal(second.attempt, 2);
  repo.close();
  // A run still running when the process dies is interrupted on the next open.
  repo = new SqliteCandidates(path);
  try {
    assert.equal(repo.events.idleRuns('host-1', 's-1').find(item => item.id === second.id)?.state, 'interrupted');
  } finally { repo.close(); }
});
test('Rejected existing databases preserve their journal mode, data and version', async () => {
  await mkdir('work/tests', { recursive: true });
  for (const version of [0, 1, 2]) {
    const path = join(await tempDir('governance', 'ownership'), 'existing.db');
    const original = new DatabaseSync(path);
    original.exec(`CREATE TABLE user_data(value TEXT); INSERT INTO user_data VALUES('preserve'); PRAGMA user_version=${version}`);
    const mode = original.prepare('PRAGMA journal_mode').get()!['journal_mode'];
    original.close();
    assert.throws(() => new SqliteCandidates(path));
    const inspect = new DatabaseSync(path);
    try {
      assert.equal(inspect.prepare('PRAGMA journal_mode').get()!['journal_mode'], mode);
      assert.equal(inspect.prepare('PRAGMA user_version').get()!['user_version'], version);
      assert.equal(inspect.prepare('SELECT value FROM user_data').get()!['value'], 'preserve');
      assert.equal(inspect.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'governance_%'").get()!['n'], 0);
    } finally { inspect.close(); }
  }
});

test('a partially failed idle-review run keeps finished actions and releases the rest', async () => {
  await mkdir('work/tests', { recursive: true });
  const path = join(await tempDir('governance', 'idle-retry'), 'governance.db');
  const repo = new SqliteCandidates(path);
  try {
    // Two turns carrying a durable signal each.
    for (const [index, text] of ['以后都用 pnpm，不要用 npm', '默认分支是 main，不要直接推送'].entries()) {
      repo.turns.observe('host-1', {
        protocolVersion: '1', adapterVersion: '0.1.0', eventId: `event-${index}`, sessionId: 's-1', turnId: String(index + 1),
        kind: 'message.user', occurredAt: '2026-11-10T00:00:00.000Z', receivedAt: '2026-11-10T00:00:00.000Z',
        sourceRef: 'test', payload: { text },
      });
    }
    repo.events.recordIdleReview('host-1', 's-1', 2, [
      { id: '11111111-1111-4111-8111-111111111111', sessionId: 's-1', turnId: 1, eventId: 'event-0', text: '以后都用 pnpm，不要用 npm', reason: 'standing-instruction', createdAt: '2026-11-10T00:00:00.000Z' },
      { id: '22222222-2222-4222-8222-222222222222', sessionId: 's-1', turnId: 2, eventId: 'event-1', text: '默认分支是 main，不要直接推送', reason: 'standing-instruction', createdAt: '2026-11-10T00:00:00.000Z' },
    ]);
    const started = repo.events.beginIdleRunWithSignals('host-1', 's-1', 10);
    assert.equal(started.signals.length, 2);
    // One action finished, the other failed.
    repo.events.recordIdleRunItem('host-1', started.run.id, { index: 0, action: 'create', kind: 'rule', state: 'applied', targetId: 'rule-1' });
    repo.events.recordIdleRunItem('host-1', started.run.id, { index: 1, action: 'create', kind: 'rule', state: 'failed', detail: { reason: 'RULE_CAPACITY_EXCEEDED' } });
    repo.events.finishIdleRun('host-1', started.run.id, 'failed', 'RULE_CAPACITY_EXCEEDED');
    // Only the unfinished signal is offered to the next attempt.
    const pending = repo.events.pendingIdleSessions('host-1');
    assert.deepEqual(pending, [{ sessionId: 's-1', count: 1 }]);
    const retry = repo.events.beginIdleRunWithSignals('host-1', 's-1', 10);
    assert.deepEqual(retry.signals.map(signal => signal.id), ['22222222-2222-4222-8222-222222222222']);
    // A succeeded run consumes everything it reserved.
    repo.events.recordIdleRunItem('host-1', retry.run.id, { index: 0, action: 'create', kind: 'rule', state: 'applied' });
    repo.events.finishIdleRun('host-1', retry.run.id, 'succeeded');
    assert.deepEqual(repo.events.pendingIdleSessions('host-1'), []);
  } finally { repo.close(); }
});

test('the user\'s own turn text is kept as review evidence and expires with the turn bookkeeping', async () => {
  await mkdir('work/tests', { recursive: true });
  const path = join(await tempDir('governance', 'turn-messages'), 'governance.db');
  const repo = new SqliteCandidates(path);
  try {
    const turn = (turnId: string, text: string, noRetention = false) => ({
      protocolVersion: '1', adapterVersion: '0.1.0', eventId: `message-${turnId}`, sessionId: 's-1', turnId,
      kind: 'message.user' as const, occurredAt: '2026-11-10T00:00:00.000Z', receivedAt: '2026-11-10T00:00:00.000Z',
      sourceRef: 'test', payload: { text, ...(noRetention ? { noRetention: true as const } : {}) },
    });
    repo.turns.observe('host-a', turn('1', '以后都用 pnpm，不要用 npm'));
    repo.turns.observe('host-a', turn('2', '这次不要留存', true));
    // An assistant turn is not stored: only the user's own text is evidence.
    repo.turns.observe('host-a', {
      protocolVersion: '1', adapterVersion: '0.1.0', eventId: 'assistant-1', sessionId: 's-1', turnId: '2',
      kind: 'message.assistant.final', occurredAt: '2026-11-10T00:00:00.000Z', receivedAt: '2026-11-10T00:00:00.000Z',
      sourceRef: 'test', payload: { text: 'final reply' },
    });
    const messages = repo.turns.messages('host-a', 's-1');
    assert.deepEqual(messages.map(message => message.turnId), ['1', '2']);
    assert.equal(messages[0]?.text, '以后都用 pnpm，不要用 npm', 'the wording is kept as the user wrote it');
    assert.equal(messages[1]?.noRetention, true, 'the marker travels so a scan can skip that turn');
    // Another host or session sees nothing.
    assert.deepEqual(repo.turns.messages('host-b', 's-1'), []);
    assert.deepEqual(repo.turns.messages('host-a', 's-9'), []);
    // The same event id replayed does not add a second row.
    repo.turns.observe('host-a', turn('1', '以后都用 pnpm，不要用 npm'));
    assert.equal(repo.turns.messages('host-a', 's-1').length, 2);
  } finally { repo.close(); }
});

test('an idle-review action must name the open run and may not write a formal memory', async () => {
  await mkdir('work/tests', { recursive: true });
  const path = join(await tempDir('governance', 'idle-run-bound'), 'governance.db');
  const repo = new SqliteCandidates(path);
  try {
    const run = repo.events.beginIdleRun('host-1', 's-1');
    // The run is found by id for its own Host only.
    assert.equal(repo.events.idleRun('host-1', run.id)?.state, 'running');
    assert.equal(repo.events.idleRun('host-2', run.id), null);
    repo.events.finishIdleRun('host-1', run.id, 'succeeded');
    // A finished run no longer accepts an action, so a late write cannot be authorized by it.
    assert.equal(repo.events.idleRun('host-1', run.id)?.state, 'succeeded');
    assert.throws(
      () => repo.events.recordIdleRunItem('host-1', run.id, { index: 5, action: 'skip', kind: 'rule', state: 'skipped' }),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_STATE',
    );
  } finally { repo.close(); }
});
