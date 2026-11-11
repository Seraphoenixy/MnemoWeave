import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ArchiveCreate, RuleCreate, RuleEdit } from '../../packages/core/contracts/src/index.ts';
import { MnemoWeaveError } from '../../packages/core/contracts/src/index.ts';
import {
  planArchive, planArchiveEdit, planArchiveState, planRuleCreate, planRuleEdit,
  archiveActiveBytes, ruleBytes, ruleUsage, toArchiveRecord, toRuleRecord,
} from '../../packages/core/application/src/rules.ts';
import type { LocalRuleRow } from '../../packages/core/application/src/sync-apply.ts';

const NOW = '2026-11-10T12:00:00.000Z';

function rule(overrides: Partial<LocalRuleRow> = {}): LocalRuleRow {
  return {
    entryId: randomUUID(), body: '短准则', enabled: true, version: 1, withdrawnAt: null,
    importance: 'normal', pinned: false, createdAt: NOW, ...overrides,
  };
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

test('capacity is measured in UTF-8 bytes plus the entry delimiter', () => {
  const rows = [rule({ body: 'a'.repeat(100) }), rule({ body: 'b'.repeat(100) })];
  assert.equal(ruleBytes(rows), 204);
  const usage = ruleUsage(rows);
  assert.equal(usage.usedBytes, 204);
  assert.equal(usage.limitBytes, 14 * 1024);
  assert.equal(usage.itemMaxBytes, 8 * 1024);
  assert.equal(usage.targetBytes, Math.floor(14 * 1024 * 0.7));
});

test('the pending rule and pinned entries survive, lower priority entries are archived', () => {
  const critical = rule({ body: 'c'.repeat(8000), importance: 'critical' });
  const normal = rule({ body: 'n'.repeat(8000), importance: 'normal' });
  const plan = planRuleCreate(RuleCreate.parse({ body: 'pending' }), [critical, normal]);
  assert.equal(plan.active.length, 2);
  assert.deepEqual(plan.active.map(row => row.entryId).sort(), [critical.entryId, plan.row.entryId].sort());
  assert.equal(plan.archived.length, 1);
  assert.equal(plan.archived[0]!.ruleId, normal.entryId);
  assert.equal(plan.archived[0]!.body, normal.body);
  assert.equal(plan.archived[0]!.ruleVersion, normal.version);
  assert.equal(plan.archived[0]!.importance, 'normal');
  assert.equal(plan.archived[0]!.reason, 'capacity');
});

test('pinned entries win over importance when maintenance has to choose', () => {
  const pinned = rule({ body: 'p'.repeat(400), importance: 'low', pinned: true });
  const normal = rule({ body: 'n'.repeat(300), importance: 'normal' });
  const plan = planRuleCreate(RuleCreate.parse({ body: 'pending' }), [pinned, normal], { capacityBytes: 600, itemMaxBytes: 1000 });
  assert.equal(plan.archived.length, 1);
  assert.equal(plan.archived[0]!.ruleId, normal.entryId);
  assert.deepEqual(plan.active.map(row => row.entryId).sort(), [pinned.entryId, plan.row.entryId].sort());
});

test('mandatory entries that cannot fit are refused, not silently dropped', () => {
  const pinned = rule({ body: 'p'.repeat(8000), pinned: true });
  assert.throws(
    () => planRuleCreate(RuleCreate.parse({ body: 'q'.repeat(8000) }), [pinned]),
    (error: unknown) => error instanceof MnemoWeaveError && error.code === 'RULE_CAPACITY_EXCEEDED',
  );
});

test('editing appends a version and runs capacity maintenance with the edit applied', () => {
  const current = rule({ body: 'c'.repeat(12000), importance: 'low' });
  const plan = planRuleEdit(current, RuleEdit.parse({ body: 'short', enabled: false }), [current]);
  assert.equal(plan.row.version, 2);
  assert.equal(plan.row.enabled, false);
  assert.equal(plan.row.body, 'short');
});

test('a rule record reports importance, pinning and body bytes without a scope', () => {
  const record = toRuleRecord(rule({ version: 3, importance: 'critical', pinned: true }));
  assert.deepEqual(Object.keys(record).sort(), ['body', 'bodyBytes', 'enabled', 'entryId', 'importance', 'pinned', 'version', 'withdrawnAt']);
  assert.equal(record.version, 3);
  assert.equal(record.bodyBytes, Buffer.byteLength('短准则', 'utf8'));
  assert.equal(record.pinned, true);
});

test('maintenance keeps priority order instead of skipping to a smaller lower-priority rule', () => {
  const critical = rule({ body: 'c'.repeat(400), importance: 'critical' });
  const normal = rule({ body: 'n'.repeat(200), importance: 'normal' });
  const low = rule({ body: 'l'.repeat(10), importance: 'low' });
  const plan = planRuleCreate(RuleCreate.parse({ body: 'pending' }), [critical, normal, low], { capacityBytes: 600, itemMaxBytes: 1000 });
  assert.deepEqual(plan.active.map(row => row.entryId).sort(), [critical.entryId, plan.row.entryId].sort());
  assert.deepEqual(plan.archived.map(row => row.ruleId).sort(), [normal.entryId, low.entryId].sort());
});

test('UTF-8 byte accounting keeps multi-byte text inside the per-rule limit', () => {
  const body = '界'.repeat(2000);
  assert.equal(Buffer.byteLength(body, 'utf8'), 6000);
  const plan = planRuleCreate(RuleCreate.parse({ body }), []);
  assert.equal(plan.row.body, body);
  assert.equal(toRuleRecord(plan.row).bodyBytes, 6000);
});

test('archive capacity excludes archived and withdrawn entries', () => {
  const active = planArchive(ArchiveCreate.parse({ projectId: 'alpha', title: 'a', body: '正文', source: 'user', verification: 'open', evidence: '证据' }));
  const archived = planArchiveState(active, 'archived', [active]);
  const rows = [archived, { ...active, entryId: randomUUID(), withdrawnAt: NOW }];
  assert.equal(archiveActiveBytes(rows), 0);
});

test('an archive over the project capacity is refused without touching existing rows', () => {
  const existing = planArchive(ArchiveCreate.parse({ projectId: 'alpha', title: 'a', body: 'a'.repeat(100), source: 'user', verification: 'open', evidence: '证据' }));
  assert.throws(
    () => planArchive(ArchiveCreate.parse({ projectId: 'alpha', title: 'b', body: 'b'.repeat(100), source: 'user', verification: 'open', evidence: '证据' }), [existing], NOW, 150),
    (error: unknown) => error instanceof MnemoWeaveError && error.code === 'ARCHIVE_CAPACITY_EXCEEDED',
  );
});

test('an archive body over 2 MiB is refused with its own code', () => {
  assert.throws(
    () => planArchive(ArchiveCreate.parse({ projectId: 'alpha', title: 'a', body: 'x'.repeat(2 * 1024 * 1024 + 1), source: 'user', verification: 'open', evidence: '证据' })),
    (error: unknown) => error instanceof MnemoWeaveError && error.code === 'ARCHIVE_BODY_TOO_LARGE',
  );
});
test('an archive keeps its project, verification state and active byte count', () => {
  const draft = ArchiveCreate.parse({
    projectId: 'alpha', title: '标题', body: '正文', source: 'user', verification: 'open', evidence: '证据',
  });
  const row = planArchive(draft);
  const record = toArchiveRecord(row);
  assert.equal(record.projectId, 'alpha');
  assert.equal(record.verification, 'open');
  assert.equal(record.version, 1);
  assert.equal(record.withdrawnAt, null);
  assert.equal(record.state, 'active');
  assert.equal(record.bodyBytes, Buffer.byteLength('正文', 'utf8'));
});

test('archived archives do not consume active capacity and can be restored', () => {
  const base = planArchive(ArchiveCreate.parse({
    projectId: 'alpha', title: '标题', body: '正文', source: 'user', verification: 'open', evidence: '证据',
  }));
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
