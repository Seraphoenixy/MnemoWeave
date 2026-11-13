import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { tempDir } from '../support/temp.ts';

/**
 * A new database is created at v23 directly; an existing one is migrated through the chain.
 *
 * Two creation paths are only acceptable while they produce the same structure. This test builds
 * both — a fresh store, and a v1 store walked through all 22 migrations — and compares every
 * table, index, trigger, column and check constraint. Without it, a migration added later could
 * update the chain and leave the baseline describing an older shape, and only real user databases
 * would ever notice.
 */

/** Every persistent object the schema defines, in a form that ignores formatting. */
function structureOf(db: DatabaseSync): string[] {
  const objects = db.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
  ).all() as { type: string; name: string; sql: string }[];
  const lines: string[] = [];
  for (const object of objects) {
    lines.push(`${object.type} ${object.name}: ${object.sql.replace(/\s+/g, ' ').trim()}`);
    if (object.type === 'table') {
      const columns = db.prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)`).all(object.name) as Record<string, unknown>[];
      for (const column of columns) lines.push(`  column ${object.name}.${JSON.stringify(column)}`);
      const foreignKeys = db.prepare(`SELECT * FROM pragma_foreign_key_list(?)`).all(object.name) as Record<string, unknown>[];
      for (const key of foreignKeys) lines.push(`  foreign key ${object.name}.${JSON.stringify(key)}`);
    }
  }
  return lines;
}

/** The two tables a v1 database had, written by hand so the chain runs from its real starting point. */
function createV1(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE governance_candidates (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        request_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status='pending_review'),
        submitted_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE governance_submission_receipts (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL UNIQUE REFERENCES governance_candidates(id),
        status TEXT NOT NULL CHECK(status='candidate')
      ) STRICT;
      PRAGMA user_version=1;
    `);
  } finally { db.close(); }
}

test('a new store is created at v23 with no migration snapshots', async () => {
  const root = await tempDir('schema-baseline', 'fresh');
  const path = join(root, 'governance.db');
  const repo = new SqliteCandidates(path);
  repo.close();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(Number(db.prepare('PRAGMA user_version').get()!['user_version']), 23);
    // The lock row is part of an empty library, not of any migration.
    assert.deepEqual(
      { ...(db.prepare('SELECT id, owner, until_ms FROM governance_workflow_lock').get() as object) },
      { id: 1, owner: null, until_ms: 0 },
    );
  } finally { db.close(); }
});

test('the baseline and the migration chain produce the same v23 structure', { timeout: 300_000 }, async () => {
  const freshRoot = await tempDir('schema-baseline', 'baseline');
  const freshPath = join(freshRoot, 'governance.db');
  new SqliteCandidates(freshPath).close();

  const migratedRoot = await tempDir('schema-baseline', 'migrated');
  const migratedPath = join(migratedRoot, 'governance.db');
  createV1(migratedPath);
  new SqliteCandidates(migratedPath).close();

  const fresh = new DatabaseSync(freshPath, { readOnly: true });
  const migrated = new DatabaseSync(migratedPath, { readOnly: true });
  try {
    assert.equal(Number(migrated.prepare('PRAGMA user_version').get()!['user_version']), 23);
    const freshLines = structureOf(fresh);
    const migratedLines = structureOf(migrated);
    // Report the first difference rather than the whole schema dump.
    for (let index = 0; index < Math.max(freshLines.length, migratedLines.length); index += 1) {
      assert.equal(freshLines[index], migratedLines[index], `structure differs at line ${index + 1}: update schema-baseline.ts together with the migration that changed it`);
    }
    assert.equal(freshLines.length, migratedLines.length);
  } finally { fresh.close(); migrated.close(); }
});
