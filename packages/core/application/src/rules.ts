import { randomUUID } from 'node:crypto';
import { MnemoWeaveError } from '../../contracts/src/index.ts';
import type { ArchiveCreateInput, ArchiveRecordValue, RuleCreateInput, RuleEditInput, RuleRecordValue } from '../../contracts/src/index.ts';
import type { LocalArchiveRow, LocalRuleRow } from './sync-apply.ts';
import { RULE_BUDGET_TOKENS, estimateTokens } from './view.ts';

/**
 * Planning for operator writes to runtime rules and project archives.
 *
 * Runtime rules apply to every session, so they are not scoped to a project any more. A rule is
 * accepted only if every rule still fits the rule budget; enabling is the point where the budget is
 * enforced, because injection never trims a rule.
 */

export function ruleCost(body: string): number { return estimateTokens(body) + 8; }

export function planRuleCreate(input: RuleCreateInput, existing: LocalRuleRow[]): LocalRuleRow {
  const row: LocalRuleRow = {
    entryId: randomUUID(),
    body: input.body,
    enabled: input.enabled,
    version: 1,
    withdrawnAt: null,
  };
  assertRuleBudget([...existing, row]);
  return row;
}

export function planRuleEdit(current: LocalRuleRow, input: RuleEditInput, existing: LocalRuleRow[]): LocalRuleRow {
  const updated: LocalRuleRow = {
    ...current,
    body: input.body ?? current.body,
    enabled: input.enabled ?? current.enabled,
    version: current.version + 1,
  };
  const others = existing.filter(row => row.entryId !== current.entryId);
  assertRuleBudget([...others, updated]);
  return updated;
}

export function assertRuleBudget(rules: LocalRuleRow[]): void {
  const used = rules
    .filter(row => row.enabled && row.withdrawnAt === null)
    .reduce((sum, row) => sum + ruleCost(row.body), 0);
  if (used > RULE_BUDGET_TOKENS) throw new MnemoWeaveError('RULE_BUDGET_EXCEEDED');
}

export function toRuleRecord(row: LocalRuleRow): RuleRecordValue {
  return {
    entryId: row.entryId,
    body: row.body,
    enabled: row.enabled,
    version: row.version,
    withdrawnAt: row.withdrawnAt,
  };
}

export function planArchive(input: ArchiveCreateInput): LocalArchiveRow {
  return {
    entryId: randomUUID(),
    projectId: input.projectId,
    title: input.title,
    body: input.body,
    source: input.source,
    verification: input.verification,
    evidence: input.evidence,
    version: 1,
    withdrawnAt: null,
  };
}

export function toArchiveRecord(row: LocalArchiveRow): ArchiveRecordValue {
  return {
    entryId: row.entryId,
    projectId: row.projectId,
    title: row.title,
    body: row.body,
    source: row.source as ArchiveRecordValue['source'],
    verification: row.verification,
    evidence: row.evidence,
    version: row.version,
    withdrawnAt: row.withdrawnAt,
  };
}
