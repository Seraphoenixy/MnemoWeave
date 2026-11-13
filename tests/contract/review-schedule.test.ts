import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import type { RememberRequest } from '../../packages/core/contracts/src/index.ts';
import { tempDir } from '../support/temp.ts';

/**
 * v23 removed the knowledge-type domain together with the review schedule derived from it.
 *
 * The interesting case is not a fresh store - that one simply never creates the tables - but a
 * library written by v22, which carries the column, the schedule rows and drafts that named a
 * type. Upgrading has to clear all three, or a removed dimension keeps answering queries.
 */

const request = (key: string): RememberRequest => ({
  idempotencyKey: key, content: `Migration fixture content ${key}.`, tags: [],
  provenance: {
    source: 'migration-test', sourceReference: `fixture:${key}`,
  },
});

async function published() {
  const root = await tempDir('review-schedule', 'v23');
  const repo = new SqliteCandidates(join(root, 'governance.db'));
  const candidate = repo.submit(request('v23-migration-001'));
  const stored = repo.get(candidate.id).request;
  const hash = createHash('sha256').update(stored.content).digest('hex');
  const { memoryId } = repo.catalog.publishInitial(candidate.id, stored, 'provider-v23', hash, '2026-01-01T00:00:00.000Z');
  return { repo, memoryId, root, path: join(root, 'governance.db') };
}

const version = (db: DatabaseSync): number => Number(db.prepare('PRAGMA user_version').get()?.['user_version']);
const hasTable = (db: DatabaseSync, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
const hasColumn = (db: DatabaseSync, table: string, column: string): boolean =>
  db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(column) !== undefined;

test('a fresh library is created at v23 with no review schedule and no knowledge-type column', async () => {
  const { repo, path } = await published();
  repo.close();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(version(db), 23);
    assert.equal(hasTable(db, 'catalog_review_state'), false, 'the review schedule is gone');
    assert.equal(hasTable(db, 'catalog_review_history'), false);
    assert.equal(hasColumn(db, 'catalog_revisions', 'knowledge_type'), false, 'the removed dimension cannot be read back');
    assert.equal(hasColumn(db, 'archive_distillations', 'knowledge_type'), false);
  } finally { db.close(); }
});

test('upgrading a v22 library keeps reviews impossible and clears stored knowledge types', async () => {
  const { repo, memoryId, root, path } = await published();
  repo.close();

  // Rebuild the v22 shape on this library: the column, the schedule tables and a v22 draft.
  // The column is added with a default instead of an UPDATE: revisions are immutable, and the
  // trigger that enforces it is exactly what a real v22 library also carried.
  const old = new DatabaseSync(path);
  old.exec(`
    ALTER TABLE catalog_revisions ADD COLUMN knowledge_type TEXT DEFAULT 'Architecture';
    CREATE TABLE catalog_review_state(memory_id TEXT PRIMARY KEY, knowledge_type TEXT NOT NULL, interval_days INTEGER NOT NULL, last_reviewed_at TEXT, due_at TEXT NOT NULL);
    CREATE TABLE catalog_review_history(id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, reviewed_at TEXT NOT NULL, reviewer TEXT NOT NULL, reason TEXT NOT NULL);
    ALTER TABLE archive_distillations ADD COLUMN knowledge_type TEXT NOT NULL DEFAULT '';
    INSERT INTO catalog_review_state VALUES('${memoryId}', 'Architecture', 180, NULL, '2026-06-30T00:00:00.000Z');
    PRAGMA user_version=22;
  `);
  old.close();

  const upgraded = new SqliteCandidates(path);
  try {
    // The memory itself survives: removing a classification dimension is not a data loss event
    // for the body, the pointer or the version.
    const revision = upgraded.catalog.get(memoryId).revisions[0]!;
    assert.equal(revision.number, 1);
    assert.equal(upgraded.catalog.get(memoryId).state, 'active');
  } finally { upgraded.close(); }

  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(version(db), 23, 'the library reports the new version');
    assert.equal(hasTable(db, 'catalog_review_state'), false, 'stale schedule rows are cleared, not left queryable');
    assert.equal(hasTable(db, 'catalog_review_history'), false);
    assert.equal(hasColumn(db, 'catalog_revisions', 'knowledge_type'), false);
    assert.equal(hasColumn(db, 'archive_distillations', 'knowledge_type'), false);
    // The rebuild keeps every column the drafts still need.
    for (const column of ['draft_id', 'host_id', 'workspace_id', 'entry_id', 'entry_version', 'source_content_hash',
      'content', 'category', 'importance', 'tags_json', 'entities_json', 'reason', 'assessment', 'content_hash',
      'created_at', 'task_id']) {
      assert.ok(hasColumn(db, 'archive_distillations', column), `archive_distillations keeps ${column}`);
    }
    // Revisions stay immutable after the trigger is recreated around the column drop.
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='catalog_revisions_immutable_update'").get() !== undefined);
  } finally { db.close(); }

  assert.ok((await readdir(root)).some(name => name.includes('pre-v23')), 'the migration takes a snapshot first');

  // A v23 library refuses to be edited into an inconsistent state by an immutable-revision update.
  const check = new DatabaseSync(path);
  try {
    assert.throws(() => check.exec("UPDATE catalog_revisions SET category='changed'"), /immutable/i);
  } finally { check.close(); }
});
