import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RuleCreate, RuleEdit, ArchiveCreate } from '../../packages/core/contracts/src/index.ts';
import { MnemoWeaveError } from '../../packages/core/contracts/src/index.ts';
import { planArchive, planRuleCreate, planRuleEdit, ruleCost, toArchiveRecord, toRuleRecord } from '../../packages/core/application/src/rules.ts';
import type { LocalRuleRow } from '../../packages/core/application/src/sync-apply.ts';

const NOW = '2026-11-10T12:00:00.000Z';

function rule(overrides: Partial<LocalRuleRow> = {}): LocalRuleRow {
  return { entryId: randomUUID(), body: '短准则', enabled: true, version: 1, withdrawnAt: null, ...overrides };
}

test('a rule that fits the budget is created at version 1', () => {
  const created = planRuleCreate(RuleCreate.parse({ body: '提交前必须运行类型检查。' }), []);
  assert.equal(created.version, 1);
  assert.equal(created.enabled, true);
  assert.equal(toRuleRecord(created).body, '提交前必须运行类型检查。');
});

test('a rule that no longer fits rejects the write instead of being truncated', () => {
  const existing = [rule({ body: 'a'.repeat(3000) })];
  assert.throws(
    () => planRuleCreate(RuleCreate.parse({ body: 'b'.repeat(300) }), existing),
    (error: unknown) => error instanceof MnemoWeaveError && error.code === 'RULE_BUDGET_EXCEEDED',
  );
  assert.equal(ruleCost('a'.repeat(3000)) + ruleCost('b'.repeat(300)) > 1024, true);
});

test('every rule competes with every other rule for the one budget', () => {
  const blocking = [rule({ body: 'g'.repeat(4000) })];
  assert.throws(
    () => planRuleCreate(RuleCreate.parse({ body: 'short' }), blocking),
    (error: unknown) => error instanceof MnemoWeaveError && error.code === 'RULE_BUDGET_EXCEEDED',
  );
  const room = [rule({ body: 'g'.repeat(3000) })];
  assert.equal(planRuleCreate(RuleCreate.parse({ body: 'short' }), room).version, 1);
});

test('editing appends a version and re-checks the budget', () => {
  const current = rule({ body: 'a'.repeat(3000) });
  const others = [rule({ entryId: randomUUID(), body: 'b'.repeat(300) })];
  assert.throws(
    () => planRuleEdit(current, RuleEdit.parse({ body: 'c'.repeat(3000) }), [current, ...others]),
    (error: unknown) => error instanceof MnemoWeaveError && error.code === 'RULE_BUDGET_EXCEEDED',
  );
  const edited = planRuleEdit(current, RuleEdit.parse({ enabled: false }), [current, ...others]);
  assert.equal(edited.version, 2);
  assert.equal(edited.enabled, false);
  assert.equal(edited.body, current.body);
});

test('a rule record reports body, state and version without a scope', () => {
  const record = toRuleRecord(rule({ version: 3 }));
  assert.deepEqual(Object.keys(record).sort(), ['body', 'enabled', 'entryId', 'version', 'withdrawnAt']);
  assert.equal(record.version, 3);
});

test('an archive keeps its project and verification state', () => {
  const draft = ArchiveCreate.parse({
    projectId: 'alpha', title: '标题', body: '正文', source: 'user', verification: 'open', evidence: '证据',
  });
  const row = planArchive(draft);
  const record = toArchiveRecord(row);
  assert.equal(record.projectId, 'alpha');
  assert.equal(record.verification, 'open');
  assert.equal(record.version, 1);
  assert.equal(record.withdrawnAt, null);
});
