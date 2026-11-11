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
test('schema v14 adds revision classification and keeps the v13 tables', async () => {
  await mkdir('work/tests', { recursive: true });
  const path = join(await mkdtemp(resolve('work/tests/schema12-')), 'governance.db');
  const repo = new SqliteCandidates(path);
  repo.close();
  const inspect = new DatabaseSync(path);
  try {
    assert.equal(Number(inspect.prepare('PRAGMA user_version').get()!['user_version']), 14);
    const tables = new Set((inspect.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((row) => row.name));
    for (const name of ['entry_versions', 'share_outbox', 'sync_state', 'sync_outbox', 'sync_inbox', 'formal_map', 'runtime_rules', 'project_archives', 'project_bindings', 'runtime_injections']) assert.ok(tables.has(name), name);
    for (const legacy of ['sync_log', 'sync_grants', 'sync_license_state']) assert.equal(tables.has(legacy), false, legacy);
    assert.ok(tables.has('catalog_memories'));
    assert.ok(tables.has('runtime_sessions'));
    // v14 adds classification columns to an existing table rather than a new table.
    const revisionColumns = new Set((inspect.prepare("SELECT name FROM pragma_table_info('catalog_revisions')").all() as { name: string }[]).map(row => row.name));
    for (const name of ['knowledge_type', 'category', 'importance', 'tags_json', 'entities_json']) assert.ok(revisionColumns.has(name), name);
  } finally {
    inspect.close();
  }
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
