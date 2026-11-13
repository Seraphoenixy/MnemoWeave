import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { MemoryApplication } from '../../packages/core/application/src/index.ts';
import { RememberInput, MnemoWeaveError } from '../../packages/core/contracts/src/index.ts';
import { createHash } from 'node:crypto';
import { tempDir } from '../support/temp.ts';

async function fixture() {
  const root = await tempDir('catalog', 'catalog'); const path = join(root, 'governance.db');
  const repo = new SqliteCandidates(path);
  const request = RememberInput.parse({ idempotencyKey: 'catalog-test-key', content: 'Authoritative Provider text.', provenance: { source: 'test', sourceReference: 'fixture:catalog'} });
  const candidate = repo.submit(request); repo.review(candidate.id, 'approve', 'fixture-operator', 'fixture');
  assert.equal(repo.acquire('fixture-owner', 90000), true);
  const job = repo.claim('fixture-owner')!;
  repo.finish(job, { id: 'provider-original', action: 'added' }, false); repo.release('fixture-owner');
  const publication = repo.get(candidate.id).publication!;
  return { root, path, repo, request, candidate, publication };
}
test('Initial publication is atomic, immutable metadata and current pointer survive reopening', async () => {
  const f = await fixture();
  const memory = f.repo.catalog.get(f.publication.memoryId);
  assert.equal(memory.currentRevisionId, f.publication.revisionId);
  assert.equal(memory.revisions.length, 1);
  assert.equal(memory.revisions[0]!.contentHash, createHash('sha256').update(f.request.content).digest('hex'));
  assert.equal('content' in memory.revisions[0]!, false);
  f.repo.close();
  const reopened = new SqliteCandidates(f.path);
  try { assert.deepEqual(reopened.catalog.get(memory.id), memory); } finally { reopened.close(); }
  const inspect = new DatabaseSync(f.path);
  try {
    assert.throws(() => inspect.exec("UPDATE catalog_revisions SET content_hash='changed'"));
    assert.throws(() => inspect.exec('DELETE FROM catalog_revisions'));
  } finally { inspect.close(); }
});
test('Published reads use Provider text and reject corruption instead of falling back to candidate text', async () => {
  const f = await fixture();
  try {
    let actual = f.request.content;
    const app = new MemoryApplication({
      async health() { return { ready: true, version: '0.2.13', capabilities: ['health'] }; },
      async recall() { return { memories: [] }; },
      async readMemory(id) { return { id, content: actual }; },
    }, f.repo);
    assert.equal((await app.readMemory(f.publication)).content, actual);
    actual = 'Changed outside MnemoWeave';
    await assert.rejects(app.readMemory(f.publication), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'PROVIDER_INTEGRITY');
    assert.equal(f.repo.get(f.candidate.id).request.content, f.request.content);
  } finally { f.repo.close(); }
});
test('v2 published receipts backfill v3 without changing Candidate or Provider identity', async () => {
  const f = await fixture(); f.repo.close();
  const old = new DatabaseSync(f.path);
  // Rebuild an authentic v2 store: drop the version catalog and revert the v6 governance
  // changes (failure-tracking columns, outbox enqueue journal) so the upgrade chain replays.
  // v23 no longer creates the review tables, so the revert must tolerate their absence.
  old.exec(`DROP TABLE IF EXISTS catalog_review_history; DROP TABLE IF EXISTS catalog_review_state; DROP TABLE catalog_conflict_decisions; DROP TABLE catalog_conflicts; DROP TRIGGER catalog_operation_plan_immutable; DROP TABLE catalog_reservations; DROP TABLE catalog_relations; DROP TABLE catalog_operations; DROP TRIGGER catalog_revisions_immutable_update; DROP TRIGGER catalog_revisions_immutable_delete; DROP TABLE catalog_revisions; DROP TABLE catalog_memories;
    ALTER TABLE governance_tasks DROP COLUMN first_failed_at; ALTER TABLE governance_tasks DROP COLUMN alerted_at;
    CREATE TABLE governance_outbox_v2(id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES governance_tasks(id), state TEXT NOT NULL);
    INSERT INTO governance_outbox_v2(id, task_id, state) SELECT id, task_id, 'pending' FROM governance_outbox;
    DROP TABLE governance_outbox; ALTER TABLE governance_outbox_v2 RENAME TO governance_outbox;
    -- Revert the v7 body split too: a genuine v2 store keeps full content in request_json.
    UPDATE governance_candidates SET request_json=json_set(request_json,'$.content',(SELECT content FROM governance_candidate_bodies WHERE candidate_id=governance_candidates.id));
    DROP TABLE session_event_refs; DROP TABLE session_events; DROP TABLE governance_candidate_bodies;
    DROP TABLE IF EXISTS entry_versions; DROP TABLE IF EXISTS sync_state; DROP TABLE IF EXISTS sync_outbox; DROP TABLE IF EXISTS sync_inbox; DROP TABLE IF EXISTS formal_map; DROP TABLE IF EXISTS runtime_rules; DROP TABLE IF EXISTS runtime_rule_archive; DROP TABLE IF EXISTS project_archives; DROP TABLE IF EXISTS project_archive_revisions; DROP TABLE IF EXISTS project_bindings; DROP TABLE IF EXISTS runtime_injections;
    DROP TABLE IF EXISTS sync_log; DROP TABLE IF EXISTS sync_grants; DROP TABLE IF EXISTS sync_license_state;
    -- v13's share queue did not exist in a genuine v2 store.
    DROP TABLE IF EXISTS share_outbox;
    ALTER TABLE governance_candidates DROP COLUMN body_cleared_at; ALTER TABLE governance_lifecycle DROP COLUMN changed_at;
    DROP TABLE IF EXISTS runtime_user_events; DROP TABLE IF EXISTS runtime_projects; DROP TABLE IF EXISTS runtime_pins; DROP TABLE IF EXISTS runtime_sessions; DROP TABLE IF EXISTS runtime_event_ids; DROP TABLE IF EXISTS runtime_capture_tasks; DROP TABLE IF EXISTS runtime_capture_runs; DROP TABLE IF EXISTS runtime_capture_receipts;
    PRAGMA user_version=2;`); old.close();
  const upgraded = new SqliteCandidates(f.path);
  try {
    const candidate = upgraded.get(f.candidate.id);
    assert.equal(candidate.status, 'persisted'); assert.ok(candidate.publication);
    assert.equal(upgraded.catalog.get(candidate.publication.memoryId).revisions[0]!.providerMemoryId, 'provider-original');
    assert.equal(candidate.executionReceipts.length, 1);
  } finally { upgraded.close(); }
  assert.ok((await readdir(f.root)).some(name => name.includes('pre-v3')));
});

/**
 * Classification must survive storage, not just the wire. A synced entry records category,
 * importance, tags and entities; a missing value stays missing instead of turning into an
 * empty one.
 */
test('revision classification is stored and read back without inventing values', async () => {
  const f = await fixture();
  try {
    const memory = f.repo.catalog.get(f.publication.memoryId);
    const first = memory.revisions[0]!;
    assert.deepEqual(first.tags, []);
    assert.equal(first.category, undefined, 'a local Remember records no category');
    assert.equal(first.importance, undefined);

    // A synced revision carries the payload's classification instead.
    const second = f.repo.catalog.publishSynced(
      memory.id,
      RememberInput.parse({ idempotencyKey: 'synced-meta', content: '另一台机器的正文。', tags: [], provenance: { source: 'sync', sourceReference: 'x'} }),
      'provider-synced',
      createHash('sha256').update('另一台机器的正文。').digest('hex'),
      '2026-11-11T00:00:00.000Z',
      'sync',
      'synced revision 2',
      { category: 'decision', importance: 4, tags: ['发布'], entities: ['MnemoWeave'] },
    );
    const updated = f.repo.catalog.get(memory.id);
    const row = updated.revisions.find(revision => revision.id === second.revisionId)!;
    assert.equal(row.category, 'decision');
    assert.equal(row.importance, 4);
    assert.deepEqual(row.tags, ['发布']);
    assert.deepEqual(row.entities, ['MnemoWeave']);
    assert.equal(row.category, 'decision', 'a synced revision keeps the category its payload carried');
  } finally { f.repo.close(); }
});
