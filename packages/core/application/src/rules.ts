import { randomUUID } from 'node:crypto';
import { MnemoWeaveError } from '../../contracts/src/index.ts';
import {
  ARCHIVE_ACTIVE_CAPACITY_BYTES, ARCHIVE_BODY_MAX_BYTES, RULE_CAPACITY_BYTES,
  RULE_ITEM_MAX_BYTES, RULE_MAINTENANCE_TARGET_RATIO, RULE_DELIMITER,
} from '../../contracts/src/index.ts';
import type { ArchiveCreateInput, ArchiveRecordValue, ArchiveUsageRecord, RuleCreateInput, RuleEditInput, RuleRecordValue, RuleUsageRecord } from '../../contracts/src/index.ts';
import type { LocalArchiveRow, LocalRuleRow } from './sync-apply.ts';

/**
 * Planning for operator writes to runtime rules and project archives.
 *
 * Runtime rules apply to every session, so they are not scoped to a project. The active set is
 * measured in UTF-8 bytes, including the `\n§\n` separator between entries. Injection metadata is
 * accounted for separately by View assembly. A write that would exceed the hard limit first
 * archives the lowest-priority entries locally; a pinned entry or the pending write that cannot
 * fit is refused instead of truncated.
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

export interface RuleMaintenancePlan {
  row: LocalRuleRow;
  /** Every active, non-withdrawn rule after maintenance. */
  active: LocalRuleRow[];
  archived: RuleArchiveRow[];
  usage: RuleUsageRecord;
}

const IMPORTANCE_RANK = { critical: 0, normal: 1, low: 2 } as const;

export function normalizeImportance(value: LocalRuleRow['importance']): 'critical' | 'normal' | 'low' {
  return value === 'critical' || value === 'low' ? value : 'normal';
}

export function ruleBytes(rows: readonly LocalRuleRow[]): number {
  return rows.reduce((sum, row, index) => sum
    + Buffer.byteLength(row.body, 'utf8')
    + (index === 0 ? 0 : Buffer.byteLength(RULE_DELIMITER, 'utf8')), 0);
}

function activeRules(rows: readonly LocalRuleRow[]): LocalRuleRow[] {
  return rows.filter(row => row.enabled && row.withdrawnAt === null);
}

export function ruleUsage(rows: readonly LocalRuleRow[], limits: RuleLimits = DEFAULT_RULE_LIMITS): RuleUsageRecord {
  const active = activeRules(rows);
  const usedBytes = ruleBytes(active);
  const targetBytes = Math.floor(limits.capacityBytes * RULE_MAINTENANCE_TARGET_RATIO);
  return {
    limitBytes: limits.capacityBytes,
    itemMaxBytes: limits.itemMaxBytes,
    targetBytes,
    usedBytes,
    entryCount: active.length,
    exceeded: usedBytes > limits.capacityBytes,
    overByBytes: Math.max(0, usedBytes - limits.capacityBytes),
  };
}

function validateLimits(limits: RuleLimits): void {
  if (!Number.isInteger(limits.capacityBytes) || limits.capacityBytes < 1) throw new Error('rule capacity must be a positive integer');
  if (!Number.isInteger(limits.itemMaxBytes) || limits.itemMaxBytes < 1) throw new Error('rule item limit must be a positive integer');
}

export function planRuleCreate(input: RuleCreateInput, existing: LocalRuleRow[], limits: RuleLimits = DEFAULT_RULE_LIMITS): RuleMaintenancePlan {
  const row: LocalRuleRow = {
    entryId: randomUUID(),
    body: input.body,
    enabled: input.enabled,
    importance: input.importance ?? 'normal',
    pinned: input.pinned === true,
    version: 1,
    withdrawnAt: null,
  };
  return maintain([...existing, row], row.entryId, limits, new Date().toISOString());
}

export function planRuleEdit(current: LocalRuleRow, input: RuleEditInput, existing: LocalRuleRow[], limits: RuleLimits = DEFAULT_RULE_LIMITS): RuleMaintenancePlan {
  const updated: LocalRuleRow = {
    ...current,
    body: input.body ?? current.body,
    enabled: input.enabled ?? current.enabled,
    // Explicit human edits may change importance and pinned state. Automatic maintenance never
    // calls this path, so it can never lower an entry's importance.
    importance: input.importance ?? current.importance,
    pinned: input.pinned ?? current.pinned,
    version: current.version + 1,
  };
  return maintain([...existing.filter(row => row.entryId !== current.entryId), updated], updated.entryId, limits, new Date().toISOString());
}

/**
 * Keep pinned and pending entries first, then `critical → normal → low` in stable creation order.
 * Maintenance only runs above the hard limit, and then packs down to the 70% target. A pending
 * write or the pinned set that alone cannot fit is refused with a specific reason.
 */
export function maintain(
  rows: LocalRuleRow[],
  pendingId: string,
  limits: RuleLimits = DEFAULT_RULE_LIMITS,
  now = new Date().toISOString(),
): RuleMaintenancePlan {
  validateLimits(limits);
  const pending = rows.find(row => row.entryId === pendingId);
  if (pending === undefined) throw new MnemoWeaveError('INVALID_STATE');
  if (Buffer.byteLength(pending.body, 'utf8') > limits.itemMaxBytes) throw new MnemoWeaveError('RULE_ITEM_TOO_LARGE');
  const active = activeRules(rows);
  if (!pending.enabled || pending.withdrawnAt !== null) {
    return { row: pending, active, archived: [], usage: ruleUsage(active, limits) };
  }

  const before = ruleBytes(active);
  if (before <= limits.capacityBytes) {
    return {
      row: pending,
      active,
      archived: [],
      usage: ruleUsage(active, limits),
    };
  }

  const pinned = active.filter(row => row.pinned === true && row.entryId !== pendingId);
  const mandatory = [...pinned, pending];
  const mandatoryBytes = ruleBytes(mandatory);
  if (mandatoryBytes > limits.capacityBytes) {
    // A pinned entry or the write being committed cannot be moved out; refuse rather than truncate.
    throw new MnemoWeaveError(pinned.length > 0 && pending.pinned !== true ? 'RULE_CAPACITY_EXCEEDED' : 'RULE_CAPACITY_EXCEEDED');
  }

  const targetBytes = Math.floor(limits.capacityBytes * RULE_MAINTENANCE_TARGET_RATIO);
  const ordered = active
    .filter(row => row.entryId !== pendingId && row.pinned !== true)
    .sort((left, right) => {
      const importance = IMPORTANCE_RANK[normalizeImportance(left.importance)] - IMPORTANCE_RANK[normalizeImportance(right.importance)];
      if (importance !== 0) return importance;
      const created = (left.createdAt ?? '').localeCompare(right.createdAt ?? '');
      if (created !== 0) return created;
      return left.entryId.localeCompare(right.entryId);
    });
  const kept = new Set(mandatory.map(row => row.entryId));
  let used = mandatoryBytes;
  for (const row of ordered) {
    const addition = Buffer.byteLength(row.body, 'utf8') + Buffer.byteLength(RULE_DELIMITER, 'utf8');
    if (used + addition > targetBytes) break;
    kept.add(row.entryId);
    used += addition;
  }
  const nextActive = active.filter(row => kept.has(row.entryId));
  const archived = active
    .filter(row => !kept.has(row.entryId))
    .map((row): RuleArchiveRow => ({
      archiveId: randomUUID(),
      ruleId: row.entryId,
      ruleVersion: row.version,
      body: row.body,
      importance: normalizeImportance(row.importance),
      pinned: row.pinned === true,
      archivedAt: now,
      reason: 'capacity',
    }));
  const usage = ruleUsage(nextActive, limits);
  if (usage.usedBytes > limits.capacityBytes) throw new MnemoWeaveError('RULE_CAPACITY_EXCEEDED');
  return { row: pending, active: nextActive, archived, usage };
}

/** Legacy callers that only need the hard check; maintenance planning is the write path. */
export function assertRuleBudget(rules: LocalRuleRow[], limits: RuleLimits = DEFAULT_RULE_LIMITS): void {
  if (ruleBytes(activeRules(rules)) > limits.capacityBytes) throw new MnemoWeaveError('RULE_CAPACITY_EXCEEDED');
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

// ── Project archives ──

export function archiveBodyBytes(body: string): number { return Buffer.byteLength(body, 'utf8'); }

export function assertArchiveBody(body: string): void {
  if (archiveBodyBytes(body) > ARCHIVE_BODY_MAX_BYTES) throw new MnemoWeaveError('ARCHIVE_BODY_TOO_LARGE');
}

/** Capacity belongs to one project scope; archived entries do not consume it. */
export function archiveActiveBytes(rows: readonly LocalArchiveRow[]): number {
  return rows.reduce((sum, row) => sum + (row.state === 'archived' || row.withdrawnAt !== null ? 0 : archiveBodyBytes(row.body)), 0);
}

export function archiveUsage(projectId: string, rows: readonly LocalArchiveRow[], limitBytes = ARCHIVE_ACTIVE_CAPACITY_BYTES): ArchiveUsageRecord {
  const projectRows = rows.filter(row => row.projectId === projectId);
  const active = projectRows.filter(row => row.state !== 'archived' && row.withdrawnAt === null);
  const used = archiveActiveBytes(projectRows);
  return {
    projectId,
    activeBytes: used,
    limitBytes,
    activeCount: active.length,
    archivedCount: projectRows.length - active.length,
    exceeded: used > limitBytes,
  };
}

export function planArchive(input: ArchiveCreateInput, existing: readonly LocalArchiveRow[] = [], now = new Date().toISOString(), limitBytes = ARCHIVE_ACTIVE_CAPACITY_BYTES): LocalArchiveRow {
  assertArchiveBody(input.body);
  const projectRows = existing.filter(row => row.projectId === input.projectId);
  if (archiveActiveBytes(projectRows) + archiveBodyBytes(input.body) > limitBytes) {
    throw new MnemoWeaveError('ARCHIVE_CAPACITY_EXCEEDED');
  }
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
    state: 'active',
    archivedAt: null,
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
  const others = existing.filter(row => row.entryId !== current.entryId && row.projectId === current.projectId);
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
    const others = existing.filter(row => row.entryId !== current.entryId && row.projectId === current.projectId);
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
    projectId: row.projectId,
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
