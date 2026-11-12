import { z } from 'zod';

/** Error codes shared by every protocol surface. */
export type ErrorCode = 'INVALID_INPUT' | 'UNAUTHORIZED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_PROTOCOL' | 'PROVIDER_INTEGRITY' | 'PROVIDER_TIMEOUT' | 'UNSUPPORTED_VERSION' | 'REVIEW_REQUIRED' | 'NOT_FOUND' | 'IDEMPOTENCY_CONFLICT' | 'INVALID_STATE' | 'QUOTA_EXCEEDED' | 'INTERNAL'
  | 'VERSION_CONFLICT' | 'CHANGE_ID_REUSED' | 'CHANGE_ID_EXPIRED' | 'SNAPSHOT_REQUIRED' | 'DEVICE_REVOKED' | 'SCOPE_FORBIDDEN' | 'SYNC_UNAVAILABLE' | 'SYNC_QUEUED' | 'SYNC_OUTCOME_UNKNOWN' | 'NEEDS_REVIEW'
  | 'RULE_ITEM_TOO_LARGE' | 'RULE_CAPACITY_EXCEEDED'
  | 'ARCHIVE_BODY_TOO_LARGE' | 'ARCHIVE_CAPACITY_EXCEEDED' | 'ARCHIVE_NOT_ACTIVE'
  | 'WORKSPACE_REQUIRED' | 'WORKSPACE_NOT_BOUND' | 'TURN_BUDGET_EXCEEDED' | 'TURN_NO_RETENTION'
  | 'MEMORY_WRITE_TASK_INVALID' | 'ARCHIVE_DISTILLATION_INVALID';

const CONFLICT_CODES: readonly ErrorCode[] = [
  'REVIEW_REQUIRED', 'IDEMPOTENCY_CONFLICT', 'INVALID_STATE', 'QUOTA_EXCEEDED',
  'VERSION_CONFLICT', 'CHANGE_ID_REUSED', 'CHANGE_ID_EXPIRED', 'SNAPSHOT_REQUIRED',
  'SYNC_QUEUED', 'SYNC_OUTCOME_UNKNOWN', 'NEEDS_REVIEW',
  'RULE_ITEM_TOO_LARGE', 'RULE_CAPACITY_EXCEEDED',
  'ARCHIVE_BODY_TOO_LARGE', 'ARCHIVE_CAPACITY_EXCEEDED', 'ARCHIVE_NOT_ACTIVE',
  'WORKSPACE_REQUIRED', 'WORKSPACE_NOT_BOUND', 'TURN_BUDGET_EXCEEDED', 'TURN_NO_RETENTION',
  'MEMORY_WRITE_TASK_INVALID', 'ARCHIVE_DISTILLATION_INVALID',
];

/** HTTP status for an error code; every HTTP surface uses this one mapping. */
export function statusForCode(code: ErrorCode): number {
  return code === 'UNAUTHORIZED' || code === 'DEVICE_REVOKED' ? 401
    : code === 'SCOPE_FORBIDDEN' ? 403
    : code === 'INVALID_INPUT' ? 400
    : code === 'NOT_FOUND' ? 404
    : CONFLICT_CODES.includes(code) ? 409
    : 503;
}

export class MnemoWeaveError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) { super(code); this.name = 'MnemoWeaveError'; this.code = code; }
}

export function publicError(error: unknown): { code: ErrorCode } {
  return { code: error instanceof MnemoWeaveError ? error.code : error instanceof z.ZodError ? 'INVALID_INPUT' : 'INTERNAL' };
}
