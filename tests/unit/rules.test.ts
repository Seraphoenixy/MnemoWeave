import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RuleCreate, RuleEdit, ArchiveCreate } from '../../packages/core/contracts/src/index.ts';
import { MnemoWeaveError } from '../../packages/core/contracts/src/index.ts';
import { planArchive, planRuleCreate, planRuleEdit, ruleCost, toArchiveRecord, toRuleRecord } from '../../packages/core/application/src/rules.ts';
import type { LocalRuleRow } from '../../packages/core/application/src/sync-apply.ts';

const NOW = '2026-11-10T12:00:00.000Z';

function rule(overrides: Partial<LocalRuleRow> = {}): LocalRuleRow {
  return { entryId: randomUUID(), body: '短准则', scope: 'project', projectId: 'alpha', enabled: true, version: 1, withdrawnAt: null, ...overrides };
}

test('a rule that fits the budget is created at version 1', () => {
  const created = planRuleCreate(RuleCreate.parse({ scope: 'project', projectId: 'alpha', body: '提交前必须运行类型检查。' }), []);
  assert.equal(created.version, 1);
  assert.equal(created.enabled, true);
  assert.equal(created.scope, 'project');
  assert.equal(created.projectId, 'alpha');
  assert.equal(toRuleRecord(created).projectId, 'alpha');
});

test('a rule that no longer fits rejects the write instead of being truncated', () => {
  const existing = [rule({ body: 'a'.repeat(3000) })];
  assert.throws(
    () => planRuleCreate(RuleCreate.parse({ scope: 'project', projectId: 'alpha', body: 'b'.repeat(300) }), existing),
    (error: unknown) => error instanceof MnemoWeaveError && error.code === 'RULE_BUDGET_EXCEEDED',
  );
  assert.equal(ruleCost('a'.repeat(3000)) + ruleCost('b'.repeat(300)) > 1024, true);
});

test('a project rule is checked against global rules as well', () => {
  const blocking = [rule({ scope: 'global', projectId: null, body: 'g'.repeat(4000) })];
  assert.throws(
    () => planRuleCreate(RuleCreate.parse({ scope: 'project', projectId: 'beta', body: 'short' }), blocking),
    (error: unknown) => error instanceof MnemoWeaveError && error.code === 'RULE_BUDGET_EXCEEDED',
  );
  // A global write only competes with global rules.
  const global = [rule({ scope: 'global', projectId: null, body: 'g'.repeat(3000) })];
  const created = planRuleCreate(RuleCreate.parse({ scope: 'global', body: 'short' }), global);
  assert.equal(created.scope, 'global');
});

test('editing appends a version and re-checks the budget', () => {
  const current = rule({ body: 'a'.repeat(3000) });
  const others = [rule({ entryId: randomUUID(), body: 'b'.repeat(300) })];
  assert.throws(
    () => planRuleEdit(current, RuleEdit.parse({ body: 'c'.repeat(3000) }), [current, ...others]),
    (error: unknown) => error instanceof MnemoWeaveError && error.code === 'RULE_BUDGET_EXCEEDED',
  );
  const updated = planRuleEdit(current, RuleEdit.parse({ enabled: false }), [current, ...others]);
  assert.equal(updated.version, 2);
  assert.equal(updated.enabled, false);
  // Disabling the large rule leaves room for a new one.
  const created = planRuleCreate(RuleCreate.parse({ scope: 'project', projectId: 'alpha', body: 'new rule' }), [updated, ...others]);
  assert.equal(created.version, 1);
});

test('archive writes keep verification state and evidence', () => {
  const row = planArchive(ArchiveCreate.parse({ projectId: 'alpha', title: '游标按范围', body: '正文', source: 'session', verification: 'open', evidence: '三次实验' }));
  const record = toArchiveRecord(row);
  assert.equal(record.projectId, 'alpha');
  assert.equal(record.verification, 'open');
  assert.equal(record.version, 1);
});
