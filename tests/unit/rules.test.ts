import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ArchiveCreate, RuleCreate, RuleEdit } from '../../packages/core/contracts/src/index.ts';
import { MnemoWeaveError, RULE_CAPACITY_BYTES } from '../../packages/core/contracts/src/index.ts';
import {
  planArchive, planArchiveEdit, planArchiveState, planRuleCreate, planRuleEdit,
  archiveActiveBytes, ruleBytes, ruleUsage, toArchiveRecord, toRuleRecord,
} from '../../packages/core/application/src/rules.ts';
import type { LocalRuleRow } from '../../packages/core/application/src/sync-apply.ts';

const NOW = '2026-11-10T12:00:00.000Z';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';

function rule(overrides: Partial<LocalRuleRow> = {}): LocalRuleRow {
  return {
    entryId: randomUUID(), body: '短准则', enabled: true, version: 1, withdrawnAt: null,
    importance: 'normal', pinned: false, createdAt: NOW, ...overrides,
  };
}

function archiveDraft(body = '正文', workspaceId = WORKSPACE) {
  return ArchiveCreate.parse({ workspaceId, title: '标题', body, source: 'user', verification: 'open', evidence: '证据' });
}

test('a rule that fits is created at version 1', () => {
  const plan = planRuleCreate(RuleCreate.parse({ body: '提交前必须运行类型检查。' }), []);
  assert.equal(plan.row.version, 1);
  assert.equal(plan.row.enabled, true);
  assert.equal(toRuleRecord(plan.row).body, '提交前必须运行类型检查。');
});

test('a body over the per-rule byte limit is refused before any write', () => {
  assert.throws(
    () => planRuleCreate(RuleCreate.parse({ body: 'x'.repeat(9000) }), []),
    (error: unknown) => error instanceof MnemoWeaveError && error.code === 'RULE_ITEM_TOO_LARGE',
  );
});

test('capacity is 10,000 UTF-8 bytes plus the entry delimiter, with no maintenance target', () => {
  const rows = [rule({ body: 'a'.repeat(100) }), rule({ body: 'b'.repeat(100) })];
  assert.equal(ruleBytes(rows), 204);
  const usage = ruleUsage(rows);
  assert.equal(usage.usedBytes, 204);
  assert.equal(usage.limitBytes, RULE_CAPACITY_BYTES);
  assert.equal(RULE_CAPACITY_BYTES, 10_000);
  assert.equal(usage.itemMaxBytes, 8 * 1024);
  // Nothing is packed down to a lower target: the whole visible set stays resident.
  assert.equal(Object.hasOwn(usage, 'targetBytes'), false);
});

test('a write above capacity is refused and leaves the existing set unchanged', () => {
  const critical = rule({ body: 'c'.repeat(5000), importance: 'critical' });
  const normal = rule({ body: 'n'.repeat(4000), importance: 'normal' });
  // 9,000 bytes plus delimiters is close to the limit, so a small addition still fits.
  assert.equal(planRuleCreate(RuleCreate.parse({ body: 'pending' }), [critical, normal]).active.length, 3);
  assert.throws(
    () => planRuleCreate(RuleCreate.parse({ body: 'p'.repeat(2000) }), [critical, normal]),
    (error: unknown) => error instanceof MnemoWeaveError && error.code === 'RULE_CAPACITY_EXCEEDED',
  );
});

test('an over-capacity set is refused rather than trimmed, even when lower priorities would fit', () => {
  // 6,000 + 4,000 + 1,000 with delimiters exceeds 10,000. No entry is archived to make room.
  const critical = rule({ body: 'c'.repeat(6000), importance: 'critical' });
  const normal = rule({ body: 'n'.repeat(3000), importance: 'normal' });
  assert.throws(
    () => planRuleCreate(RuleCreate.parse({ body: 'p'.repeat(1200) }), [critical, normal]),
    (error: unknown) => error instanceof MnemoWeaveError && error.code === 'RULE_CAPACITY_EXCEEDED',
  );
  assert.equal(critical.body.length, 6000);
  assert.equal(normal.body.length, 3000);
});

test('a collection exactly at the capacity limit is accepted and one byte more is not', () => {
  // Per-entry limit is 8 KiB, so the collection limit is reached with two entries plus the
  // 4-byte delimiter: 8,192 + 1,804 + 4 = 10,000.
  const first = rule({ body: 'x'.repeat(8_192) });
  const atLimit = planRuleCreate(RuleCreate.parse({ body: 'y'.repeat(1_804) }), [first]);
  assert.equal(atLimit.usage.usedBytes, 10_000);
  assert.throws(
    () => planRuleCreate(RuleCreate.parse({ body: 'y'.repeat(1_805) }), [first]),
    (error: unknown) => error instanceof MnemoWeaveError && error.code === 'RULE_CAPACITY_EXCEEDED',
  );
});

test('disabling keeps the bytes measured; only a removal frees capacity', () => {
  const existing = rule({ body: 'x'.repeat(8_192) });
  const second = rule({ body: 'y'.repeat(1_798) });
  assert.equal(ruleBytes([existing, second]), 9_994);
  // A disabled rule is not injected, but it still occupies the collection: the contract counts
  // every non-removed rule, so disabling cannot be used to make room for another.
  const disabled = planRuleEdit(existing, RuleEdit.parse({ enabled: false, baseVersion: 1 }), [existing, second]);
  assert.equal(disabled.row.enabled, false);
  assert.equal(disabled.usage.usedBytes, ruleBytes([existing, second]));
  assert.deepEqual(disabled.active.map(row => row.entryId), [second.entryId], 'only the enabled rows are injected');
  assert.throws(
    () => planRuleCreate(RuleCreate.parse({ body: 'z'.repeat(10) }), [disabled.row, second]),
    (error: unknown) => error instanceof MnemoWeaveError && error.code === 'RULE_CAPACITY_EXCEEDED',
  );
  // A removal leaves the measured set and frees its bytes.
  const removed = planRuleEdit(existing, RuleEdit.parse({ remove: true, baseVersion: 1 }), [existing, second]);
  assert.equal(removed.row.enabled, false);
  assert.notEqual(removed.row.withdrawnAt, null);
  assert.equal(removed.usage.usedBytes, ruleBytes([second]));
  // A removal that makes the set smaller is always accepted, even from an over-capacity state.
  const over = rule({ body: 'o'.repeat(8_192) });
  const big = rule({ body: 'b'.repeat(8_192) });
  assert.throws(() => planRuleCreate(RuleCreate.parse({ body: 'x' }), [over, big]));
  assert.equal(planRuleEdit(over, RuleEdit.parse({ remove: true, baseVersion: 1 }), [over, big]).usage.usedBytes, 8_192);
});

test('editing appends a version and keeps the edit inside the measured set', () => {
  const current = rule({ body: 'short', importance: 'low' });
  const plan = planRuleEdit(current, RuleEdit.parse({ body: 'shorter', enabled: false, baseVersion: 1 }), [current]);
  assert.equal(plan.row.version, 2);
  assert.equal(plan.row.enabled, false);
  assert.equal(plan.row.body, 'shorter');
});

test('a rule record reports importance, pinning and body bytes without a scope', () => {
  const record = toRuleRecord(rule({ version: 3, importance: 'critical', pinned: true }));
  assert.deepEqual(Object.keys(record).sort(), ['body', 'bodyBytes', 'enabled', 'entryId', 'importance', 'pinned', 'version', 'withdrawnAt']);
  assert.equal(record.version, 3);
  assert.equal(record.bodyBytes, Buffer.byteLength('短准则', 'utf8'));
  assert.equal(record.pinned, true);
});

test('UTF-8 byte accounting keeps multi-byte text inside the per-rule limit', () => {
  const body = '界'.repeat(2000);
  assert.equal(Buffer.byteLength(body, 'utf8'), 6000);
  const plan = planRuleCreate(RuleCreate.parse({ body }), []);
  assert.equal(plan.row.body, body);
  assert.equal(toRuleRecord(plan.row).bodyBytes, 6000);
});

test('archive capacity excludes archived and withdrawn entries', () => {
  const active = planArchive(archiveDraft());
  const archived = planArchiveState(active, 'archived', [active]);
  const rows = [archived, { ...active, entryId: randomUUID(), withdrawnAt: NOW }];
  assert.equal(archiveActiveBytes(rows), 0);
});

test('an archive over the workspace capacity is refused without touching existing rows', () => {
  const existing = planArchive(archiveDraft('a'.repeat(100)));
  assert.throws(
    () => planArchive(archiveDraft('b'.repeat(100)), [existing], NOW, 150),
    (error: unknown) => error instanceof MnemoWeaveError && error.code === 'ARCHIVE_CAPACITY_EXCEEDED',
  );
});

test('capacity is per workspace: another workspace does not consume this one', () => {
  const other = '22222222-2222-4222-8222-222222222222';
  const existing = planArchive(archiveDraft('a'.repeat(100)));
  // The same workspace is full, the other one is empty.
  assert.throws(() => planArchive(archiveDraft('b'.repeat(100), WORKSPACE), [existing], NOW, 150));
  assert.equal(planArchive(archiveDraft('b'.repeat(100), other), [existing], NOW, 150).workspaceId, other);
});

test('an archive body over 2 MiB is refused with its own code', () => {
  assert.throws(
    () => planArchive(archiveDraft('x'.repeat(2 * 1024 * 1024 + 1))),
    (error: unknown) => error instanceof MnemoWeaveError && error.code === 'ARCHIVE_BODY_TOO_LARGE',
  );
});

test('an archive keeps its workspace, verification state and active byte count', () => {
  const row = planArchive(archiveDraft());
  const record = toArchiveRecord(row);
  assert.equal(record.workspaceId, WORKSPACE);
  assert.equal(record.verification, 'open');
  assert.equal(record.version, 1);
  assert.equal(record.withdrawnAt, null);
  assert.equal(record.state, 'active');
  assert.equal(record.bodyBytes, Buffer.byteLength('正文', 'utf8'));
});

test('archived archives do not consume active capacity and can be restored', () => {
  const base = planArchive(archiveDraft());
  const archived = planArchiveState(base, 'archived', [base]);
  assert.equal(archived.state, 'archived');
  assert.equal(archived.version, 2);
  assert.equal(archived.archivedAt !== null, true);
  assert.throws(
    () => planArchiveEdit(archived, { title: '新标题' }, [archived]),
    (error: unknown) => error instanceof MnemoWeaveError && error.code === 'ARCHIVE_NOT_ACTIVE',
  );
  const restored = planArchiveState(archived, 'active', [archived]);
  assert.equal(restored.state, 'active');
  assert.equal(restored.version, 3);
});

test('restoring into a full workspace is refused instead of dropping another archive', () => {
  const active = planArchive(archiveDraft('a'.repeat(100)));
  const archived = planArchiveState(active, 'archived', [active]);
  const other = planArchive(archiveDraft('b'.repeat(100)));
  assert.throws(
    () => planArchiveState(archived, 'active', [archived, other], NOW, 150),
    (error: unknown) => error instanceof MnemoWeaveError && error.code === 'ARCHIVE_CAPACITY_EXCEEDED',
  );
});
