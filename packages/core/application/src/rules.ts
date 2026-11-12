import { randomUUID } from 'node:crypto';
import { MnemoWeaveError } from '../../contracts/src/index.ts';
import {
  ARCHIVE_ACTIVE_CAPACITY_BYTES, ARCHIVE_BODY_MAX_BYTES, RULE_CAPACITY_BYTES,
  RULE_ITEM_MAX_BYTES, RULE_DELIMITER,
} from '../../contracts/src/index.ts';
import type { ArchiveCreateInput, ArchiveRecordValue, ArchiveUsageRecord, RuleCreateInput, RuleEditInput, RuleRecordValue, RuleUsageRecord } from '../../contracts/src/index.ts';
import type { LocalArchiveRow, LocalRuleRow } from './sync-apply.ts';

/**
 * Planning for user writes to the shared rule collection and workspace archives.
 *
 * Rules apply to every session, so they are not scoped. The collection is measured in UTF-8
 * bytes, including the `\n§\n` separator between entries, and every visible enabled rule is
 * injected whole. A write that would exceed the capacity is refused and the collection is left
 * unchanged: capacity maintenance never archives, compresses or rewrites rules on its own.
 */

export interface RuleLimits {
  capacityBytes: number;
  itemMaxBytes: number;
}

export const DEFAULT_RULE_LIMITS: RuleLimits = {
  capacityBytes: RULE_CAPACITY_BYTES,
  itemMaxBytes: RULE_ITEM_MAX_BYTES,
};

export interface RuleArchiveRow {
  archiveId: string;
  ruleId: string;
  ruleVersion: number;
  body: string;
  importance: NonNullable<LocalRuleRow['importance']>;
  pinned: boolean;
  archivedAt: string;
  reason: 'capacity' | 'manual';
}

/** One planned write: the row plus the collection state that follows from it. */
export interface RuleWritePlan {
  row: LocalRuleRow;
  active: LocalRuleRow[];
  usage: RuleUsageRecord;
}

export function normalizeImportance(value: LocalRuleRow['importance']): 'critical' | 'normal' | 'low' {
  return value === 'critical' || value === 'low' ? value : 'normal';
}

export function ruleBytes(rows: readonly LocalRuleRow[]): number {
  return rows.reduce((sum, row, index) => sum
    + Buffer.byteLength(row.body, 'utf8')
    + (index === 0 ? 0 : Buffer.byteLength(RULE_DELIMITER, 'utf8')), 0);
}

/**
 * The rows the collection measures.
 *
 * A disabled rule is not injected, but it still occupies the collection until it is removed: the
 * capacity contract counts every non-removed rule, so disabling one does not quietly free room for
 * another. Only a removal leaves the measured set.
 */
function measuredRules(rows: readonly LocalRuleRow[]): LocalRuleRow[] {
  return rows.filter(row => row.withdrawnAt === null);
}

/** The rows a host actually injects: enabled and not withdrawn. */
function activeRules(rows: readonly LocalRuleRow[]): LocalRuleRow[] {
  return rows.filter(row => row.enabled && row.withdrawnAt === null);
}

export function ruleUsage(rows: readonly LocalRuleRow[], limits: RuleLimits = DEFAULT_RULE_LIMITS): RuleUsageRecord {
  const measured = measuredRules(rows);
  const usedBytes = ruleBytes(measured);
  return {
    limitBytes: limits.capacityBytes,
    itemMaxBytes: limits.itemMaxBytes,
    usedBytes,
    entryCount: measured.length,
    exceeded: usedBytes > limits.capacityBytes,
    overByBytes: Math.max(0, usedBytes - limits.capacityBytes),
  };
}

function validateLimits(limits: RuleLimits): void {
  if (!Number.isInteger(limits.capacityBytes) || limits.capacityBytes < 1) throw new Error('rule capacity must be a positive integer');
  if (!Number.isInteger(limits.itemMaxBytes) || limits.itemMaxBytes < 1) throw new Error('rule item limit must be a positive integer');
}

/**
 * Commit one write against the collection.
 *
 * The per-entry limit is checked first, then the collection limit. A write that leaves the
 * enabled set within capacity is accepted; one that exceeds it is refused with
 * `RULE_CAPACITY_EXCEEDED` and the caller keeps its draft. Placing an entry that is disabled or
 * withdrawn never changes the measured set, so it cannot exceed capacity.
 */
export function commitRuleWrite(
  pending: LocalRuleRow,
  rows: readonly LocalRuleRow[],
  limits: RuleLimits = DEFAULT_RULE_LIMITS,
): RuleWritePlan {
  validateLimits(limits);
  if (Buffer.byteLength(pending.body, 'utf8') > limits.itemMaxBytes) throw new MnemoWeaveError('RULE_ITEM_TOO_LARGE');
  const measured = measuredRules(rows);
  const usage = ruleUsage(measured, limits);
  if (usage.exceeded) throw new MnemoWeaveError('RULE_CAPACITY_EXCEEDED');
  // The plan still reports the injectable rows: that is what the host renders. `rows` already
  // contains `pending` for a create and the replaced row for an edit.
  const injectable = rows.some(row => row.entryId === pending.entryId)
    ? rows
    : [...rows, pending];
  return { row: pending, active: activeRules(injectable), usage };
}

export function planRuleCreate(input: RuleCreateInput, existing: readonly LocalRuleRow[], limits: RuleLimits = DEFAULT_RULE_LIMITS): RuleWritePlan {
  const row: LocalRuleRow = {
    entryId: randomUUID(),
    body: input.body,
    enabled: input.enabled,
    importance: input.importance ?? 'normal',
    pinned: input.pinned === true,
    version: 1,
    withdrawnAt: null,
    createdAt: new Date().toISOString(),
  };
  return commitRuleWrite(row, [...existing, row], limits);
}

export function planRuleEdit(current: LocalRuleRow, input: RuleEditInput, existing: readonly LocalRuleRow[], limits: RuleLimits = DEFAULT_RULE_LIMITS): RuleWritePlan {
  const updated: LocalRuleRow = {
    ...current,
    body: input.body ?? current.body,
    enabled: input.remove === true ? false : input.enabled ?? current.enabled,
    importance: input.importance ?? current.importance,
    pinned: input.pinned ?? current.pinned,
    version: current.version + 1,
    withdrawnAt: input.remove === true ? new Date().toISOString() : current.withdrawnAt,
  };
  const others = existing.filter(row => row.entryId !== current.entryId);
  return commitRuleWrite(updated, [...others, updated], limits);
}

/** The hard check on its own, for callers that only hold rows (sync apply, tests). */
export function assertRuleBudget(rules: readonly LocalRuleRow[], limits: RuleLimits = DEFAULT_RULE_LIMITS): void {
  if (ruleBytes(measuredRules(rules)) > limits.capacityBytes) throw new MnemoWeaveError('RULE_CAPACITY_EXCEEDED');
}

export function toRuleRecord(row: LocalRuleRow): RuleRecordValue {
  return {
    entryId: row.entryId,
    body: row.body,
    enabled: row.enabled,
    version: row.version,
    withdrawnAt: row.withdrawnAt,
    importance: normalizeImportance(row.importance),
    pinned: row.pinned === true,
    bodyBytes: Buffer.byteLength(row.body, 'utf8'),
  };
}

// ── Workspace archives ──

export function archiveBodyBytes(body: string): number { return Buffer.byteLength(body, 'utf8'); }

export function assertArchiveBody(body: string): void {
  if (archiveBodyBytes(body) > ARCHIVE_BODY_MAX_BYTES) throw new MnemoWeaveError('ARCHIVE_BODY_TOO_LARGE');
}

/** Capacity belongs to one workspace; archived entries do not consume it. */
export function archiveActiveBytes(rows: readonly LocalArchiveRow[]): number {
  return rows.reduce((sum, row) => sum + (row.state === 'archived' || row.withdrawnAt !== null ? 0 : archiveBodyBytes(row.body)), 0);
}

export function archiveUsage(workspaceId: string, rows: readonly LocalArchiveRow[], limitBytes = ARCHIVE_ACTIVE_CAPACITY_BYTES): ArchiveUsageRecord {
  const workspaceRows = rows.filter(row => row.workspaceId === workspaceId);
  const active = workspaceRows.filter(row => row.state !== 'archived' && row.withdrawnAt === null);
  const used = archiveActiveBytes(workspaceRows);
  return {
    workspaceId,
    activeBytes: used,
    limitBytes,
    activeCount: active.length,
    archivedCount: workspaceRows.length - active.length,
    exceeded: used > limitBytes,
  };
}

/**
 * Active archives a user may release, oldest first.
 *
 * Only active rows count: an archived row already released its capacity, so offering it would
 * suggest an action that changes nothing. The order is the stored update time and then the entry
 * id, which is deterministic across devices.
 */
export function archiveReleaseCandidates(
  workspaceId: string,
  rows: readonly LocalArchiveRow[],
  limit = 20,
): Array<{ entryId: string; title: string; bodyBytes: number; version: number; updatedAt: string }> {
  return rows
    .filter(row => row.workspaceId === workspaceId && row.state !== 'archived' && row.withdrawnAt === null)
    .sort((left, right) => (left.updatedAt ?? '').localeCompare(right.updatedAt ?? '')
      || left.entryId.localeCompare(right.entryId))
    .slice(0, Math.max(0, limit))
    .map(row => ({
      entryId: row.entryId, title: row.title, bodyBytes: archiveBodyBytes(row.body),
      version: row.version, updatedAt: row.updatedAt ?? '',
    }));
}

export function planArchive(input: ArchiveCreateInput, existing: readonly LocalArchiveRow[] = [], now = new Date().toISOString(), limitBytes = ARCHIVE_ACTIVE_CAPACITY_BYTES): LocalArchiveRow {
  assertArchiveBody(input.body);
  const workspaceRows = existing.filter(row => row.workspaceId === input.workspaceId);
  if (archiveActiveBytes(workspaceRows) + archiveBodyBytes(input.body) > limitBytes) {
    throw new MnemoWeaveError('ARCHIVE_CAPACITY_EXCEEDED');
  }
  return {
    entryId: randomUUID(),
    workspaceId: input.workspaceId,
    title: input.title,
    body: input.body,
    source: input.source,
    verification: input.verification,
    evidence: input.evidence,
    version: 1,
    withdrawnAt: null,
    state: 'active',
    archivedAt: null,
    updatedAt: now,
  };
}

export function planArchiveEdit(
  current: LocalArchiveRow,
  input: { title?: string; body?: string; verification?: 'verified' | 'open' | 'refuted'; evidence?: string },
  existing: readonly LocalArchiveRow[],
  now = new Date().toISOString(),
  limitBytes = ARCHIVE_ACTIVE_CAPACITY_BYTES,
): LocalArchiveRow {
  if (current.state === 'archived') throw new MnemoWeaveError('ARCHIVE_NOT_ACTIVE');
  const body = input.body ?? current.body;
  assertArchiveBody(body);
  const others = existing.filter(row => row.entryId !== current.entryId && row.workspaceId === current.workspaceId);
  if (archiveActiveBytes(others) + archiveBodyBytes(body) > limitBytes) {
    throw new MnemoWeaveError('ARCHIVE_CAPACITY_EXCEEDED');
  }
  return {
    ...current,
    title: input.title ?? current.title,
    body,
    verification: input.verification ?? current.verification,
    evidence: input.evidence ?? current.evidence,
    version: current.version + 1,
    state: 'active',
    archivedAt: null,
    updatedAt: now,
  };
}

export function planArchiveState(
  current: LocalArchiveRow,
  state: 'active' | 'archived',
  existing: readonly LocalArchiveRow[],
  now = new Date().toISOString(),
  limitBytes = ARCHIVE_ACTIVE_CAPACITY_BYTES,
): LocalArchiveRow {
  if (state === current.state) throw new MnemoWeaveError('INVALID_STATE');
  if (state === 'active') {
    const others = existing.filter(row => row.entryId !== current.entryId && row.workspaceId === current.workspaceId);
    if (archiveActiveBytes(others) + archiveBodyBytes(current.body) > limitBytes) {
      throw new MnemoWeaveError('ARCHIVE_CAPACITY_EXCEEDED');
    }
  }
  return {
    ...current,
    version: current.version + 1,
    state,
    archivedAt: state === 'archived' ? now : null,
    updatedAt: now,
  };
}

export function toArchiveRecord(row: LocalArchiveRow): ArchiveRecordValue {
  return {
    entryId: row.entryId,
    workspaceId: row.workspaceId,
    title: row.title,
    body: row.body,
    source: row.source as ArchiveRecordValue['source'],
    verification: row.verification,
    evidence: row.evidence,
    version: row.version,
    withdrawnAt: row.withdrawnAt,
    state: row.state ?? 'active',
    archivedAt: row.archivedAt ?? null,
    bodyBytes: archiveBodyBytes(row.body),
  };
}
