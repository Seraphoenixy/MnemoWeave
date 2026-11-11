import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { RememberInput, MnemoWeaveError } from '../../packages/core/contracts/src/index.ts';

const fixture = (key = 'candidate-key-001') => RememberInput.parse({
  idempotencyKey: key, content: 'Immutable candidate content, not yet approved.', knowledgeType: 'Practice',
  provenance: { source: 'test', sourceReference: 'fixture:1', evidence: ['a deterministic test'], verificationStatus: 'unverified', confidence: 0.5, applicability: 'isolated fixture', limitations: 'not production knowledge', lastVerified: null },
});
test('Candidate and submission receipt persist atomically with stable idempotency', async () => {
  await mkdir('work/tests', { recursive: true });
  const path = join(await mkdtemp(resolve('work/tests/governance-')), 'state.db');
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
  const path = join(await mkdtemp(resolve('work/tests/rollback-')), 'state.db');
  const repo = new SqliteCandidates(path);
  const inject = new DatabaseSync(path);
  inject.exec('CREATE TRIGGER fail_receipt BEFORE INSERT ON governance_submission_receipts BEGIN SELECT RAISE(ABORT, \'injected receipt failure\'); END');
  assert.throws(() => repo.submit(fixture()));
  assert.equal(inject.prepare('SELECT count(*) n FROM governance_candidates').get()!['n'], 0);
  inject.exec('DROP TRIGGER fail_receipt');
  assert.equal(repo.submit(fixture()).status, 'pending_review');
  repo.close(); inject.close();
});
test('schema v17 keeps formal memories and rules global and adds archive state and memory ownership', async () => {
  await mkdir('work/tests', { recursive: true });
  const path = join(await mkdtemp(resolve('work/tests/schema12-')), 'governance.db');
  const repo = new SqliteCandidates(path);
  repo.close();
  const inspect = new DatabaseSync(path);
  try {
    assert.equal(Number(inspect.prepare('PRAGMA user_version').get()!['user_version']), 21);
    const tables = new Set((inspect.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((row) => row.name));
    for (const name of ['entry_versions', 'share_outbox', 'sync_state', 'sync_outbox', 'sync_inbox', 'formal_map', 'runtime_rules', 'project_archives', 'project_bindings', 'runtime_injections', 'runtime_rule_archive', 'project_archive_revisions', 'diagnostic_jobs']) assert.ok(tables.has(name), name);
    for (const legacy of ['sync_log', 'sync_grants', 'sync_license_state']) assert.equal(tables.has(legacy), false, legacy);
    const ruleColumns = new Set((inspect.prepare("SELECT name FROM pragma_table_info('runtime_rules')").all() as { name: string }[]).map(row => row.name));
    for (const name of ['importance', 'pinned', 'created_at', 'archived_at']) assert.ok(ruleColumns.has(name), name);
    const archiveColumns = new Set((inspect.prepare("SELECT name FROM pragma_table_info('project_archives')").all() as { name: string }[]).map(row => row.name));
    for (const name of ['state', 'archived_at']) assert.ok(archiveColumns.has(name), name);
    // v14 adds classification columns to an existing table rather than a new table.
    const revisionColumns = new Set((inspect.prepare("SELECT name FROM pragma_table_info('catalog_revisions')").all() as { name: string }[]).map(row => row.name));
    for (const name of ['knowledge_type', 'category', 'importance', 'tags_json', 'entities_json']) assert.ok(revisionColumns.has(name), name);
    // v17 adds the owner to the memory itself; revisions keep their scope column.
    const memoryColumns = new Set((inspect.prepare("SELECT name FROM pragma_table_info('catalog_memories')").all() as { name: string }[]).map(row => row.name));
    assert.ok(memoryColumns.has('project_id'), 'project_id');
  } finally {
    inspect.close();
  }
});
test('a v16 store gains memory ownership and durable jobs without rewriting existing rows', async () => {  await mkdir('work/tests', { recursive: true });
  const path = join(await mkdtemp(resolve('work/tests/schema17-')), 'governance.db');
  const created = new SqliteCandidates(path);
  created.close();
  // Rebuild the previous shape: the owner column and its index did not exist at v16.
  const downgrade = new DatabaseSync(path);
  downgrade.exec('DROP INDEX IF EXISTS catalog_memories_project; ALTER TABLE catalog_memories DROP COLUMN project_id; PRAGMA user_version=16;');
  downgrade.close();
  const migrated = new SqliteCandidates(path);
  migrated.close();
  const inspect = new DatabaseSync(path);
  try {
    assert.equal(Number(inspect.prepare('PRAGMA user_version').get()!['user_version']), 21);
    const columns = new Set((inspect.prepare("SELECT name FROM pragma_table_info('catalog_memories')").all() as { name: string }[]).map(row => row.name));
    assert.ok(columns.has('project_id'), 'the owner column is added');
    // Old records were general knowledge; the migration must not invent an owner for them.
    assert.equal(inspect.prepare('SELECT count(*) n FROM catalog_memories WHERE project_id IS NOT NULL').get()!['n'], 0);
  } finally {
    inspect.close();
  }
});
test('diagnostic jobs are single-flight and a killed run is marked interrupted', async () => {
  await mkdir('work/tests', { recursive: true });
  const path = join(await mkdtemp(resolve('work/tests/jobs-')), 'governance.db');
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
  const path = join(await mkdtemp(resolve('work/tests/runs-')), 'governance.db');
  let repo = new SqliteCandidates(path);
  const run = repo.events.beginIdleRun('host-1', 's-1');
  assert.equal(run.state, 'running');
  assert.equal(run.attempt, 1);
  assert.throws(() => repo.events.beginIdleRun('host-1', 's-1'), (error: unknown) => (error as { code?: string }).code === 'INVALID_STATE');
  const updated = repo.events.recordIdleRunItem('host-1', run.id, { index: 0, action: 'create', state: 'applied', targetId: 'memory-1' });
  assert.equal(updated.items.length, 1);
  assert.throws(() => repo.events.recordIdleRunItem('host-1', run.id, { index: 0, action: 'create', state: 'applied' }), (error: unknown) => (error as { code?: string }).code === 'INVALID_INPUT');
  const finished = repo.events.finishIdleRun('host-1', run.id, 'succeeded');
  assert.equal(finished.state, 'succeeded');
  assert.ok(finished.finishedAt !== null);
  assert.throws(() => repo.events.recordIdleRunItem('host-1', run.id, { index: 1, action: 'skip', state: 'skipped' }), (error: unknown) => (error as { code?: string }).code === 'INVALID_STATE');
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
    const path = join(await mkdtemp(resolve('work/tests/ownership-')), 'existing.db');
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
