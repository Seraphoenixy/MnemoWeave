import { createHash } from 'node:crypto';
import { MnemoWeaveError, SyncChangeInput, SyncPullPage, SyncSnapshot } from '../../contracts/src/index.ts';
import type { SyncAcceptedValue, SyncChangeRecordValue, SyncChangeRequest, SyncContentValue, SyncEntryDraftValue, SyncEntryValue, SyncPullPageValue, SyncSnapshotValue } from '../../contracts/src/index.ts';

/**
 * Pure sync rules. No HTTP, no sqlite, no Provider: the coordinator only decides
 * what a change looks like, which pulled records may be applied, and how far a
 * scope cursor may advance.
 */

/** A change carried the wrong base version; the caller needs the current state to rebase. */
export class VersionConflictError extends MnemoWeaveError {
  readonly currentVersion: number;
  readonly currentEntry: SyncEntryValue;
  constructor(entry: SyncEntryValue) {
    super('VERSION_CONFLICT');
    this.name = 'VersionConflictError';
    this.currentVersion = entry.version;
    this.currentEntry = entry;
  }
}

/** Encode a plain body for transport. The remote only ever checks hash and length. */
export function plainContent(text: string): SyncContentValue {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length === 0 || bytes.length > 8000) throw new MnemoWeaveError('INVALID_INPUT');
  const digest = createHash('sha256').update(bytes).digest('hex');
  return { format: 'plain', data: text, contentHash: digest, byteLength: bytes.length };
}

/**
 * `create` starts from base version 0; updates and deletions need a real base.
 * A base of 0 on an existing entry is rejected by the remote as VERSION_CONFLICT,
 * never silently promoted to the current version.
 */
export function assertBaseVersion(operation: SyncChangeRequest['operation'], baseVersion: number): void {
  if (operation === 'create' ? baseVersion !== 0 : baseVersion < 1) throw new MnemoWeaveError('INVALID_INPUT');
}

export function buildChange(input: {
  changeId: string;
  baseVersion: number;
  operation: SyncChangeRequest['operation'];
  entry: SyncEntryDraftValue;
}): SyncChangeRequest {
  assertBaseVersion(input.operation, input.baseVersion);
  return SyncChangeInput.parse({
    changeId: input.changeId,
    baseVersion: input.baseVersion,
    operation: input.operation,
    entry: input.entry,
  });
}

/**
 * Build an edit against the version the user saw when opening the editor.
 * `entry.version` may already be newer because a background pull advanced the
 * local copy; using it as the base would silently overwrite another machine's
 * confirmed change, so it is deliberately ignored here.
 */
export function buildEditChange(input: {
  changeId: string;
  entryVersion: number;
  entry: SyncEntryDraftValue;
}): SyncChangeRequest {
  if (input.entryVersion < 1) throw new MnemoWeaveError('INVALID_INPUT');
  return buildChange({
    changeId: input.changeId,
    baseVersion: input.entryVersion,
    operation: 'update',
    entry: input.entry,
  });
}

export interface PullPlan {
  /** Records that may be applied, in seq order, forming a contiguous run. */
  apply: SyncPullPageValue['changes'];
  /** Cursor to store after applying. Never advances across a gap. */
  nextCursor: number;
  /** The retention floor moved past the cursor; the caller must take a snapshot. */
  needsSnapshot: boolean;
  /** First missing seq when the page has a gap, otherwise null. */
  gapAt: number | null;
}

/**
 * Decide what one pulled page may apply for one scope.
 *
 * Sequences are per scope and contiguous, so a gap means the page did not bring
 * everything and application must stop before it. Records at or below the cursor
 * are duplicates (a replayed page) and are ignored.
 */
export function planPull(page: SyncPullPageValue, cursor: number): PullPlan {
  const parsed = SyncPullPage.parse(page);
  if (parsed.retentionFloor > 0 && cursor + 1 < parsed.retentionFloor) {
    return { apply: [], nextCursor: cursor, needsSnapshot: true, gapAt: null };
  }
  const ordered = [...parsed.changes].sort((left, right) => left.seq - right.seq);
  const apply: SyncPullPageValue['changes'] = [];
  let expected = cursor + 1;
  let gapAt: number | null = null;
  for (const record of ordered) {
    if (record.seq <= cursor) continue;
    if (record.seq !== expected) {
      gapAt = expected;
      break;
    }
    apply.push(record);
    expected += 1;
  }
  return { apply, nextCursor: expected - 1, needsSnapshot: false, gapAt };
}

/**
 * Cursor derived from applied inbox rows: only a contiguous run from `cursor + 1`
 * advances it. A row that is received but not applied holds the cursor back.
 */
export function advanceCursor(rows: readonly { seq: number; applied: boolean }[], cursor: number): number {
  const applied = new Set(rows.filter((row) => row.applied).map((row) => row.seq));
  let next = cursor;
  while (applied.has(next + 1)) next += 1;
  return next;
}

/** True when a snapshot's cut point can be used directly as the scope cursor. */
export function snapshotCursor(snapshot: SyncSnapshotValue): number {
  const parsed = SyncSnapshot.parse(snapshot);
  return parsed.nextSince === parsed.asOfSeq ? parsed.nextSince : parsed.asOfSeq;
}

export type SubmitFailure = 'queued' | 'unknown';

/**
 * A request that never reached the remote is safe to retry and is reported as
 * queued. Once bytes were sent, the outcome is unknown until a changeId lookup
 * answers, so the caller must not infer failure from a timeout.
 */
export function classifySubmitFailure(reachedRemote: boolean): SubmitFailure {
  return reachedRemote ? 'unknown' : 'queued';
}

/** A user edit must carry the version it was based on; the server never substitutes the latest. */
export function assertEntryVersion(current: number, provided: number): void {
  if (current !== provided) throw new MnemoWeaveError('VERSION_CONFLICT');
}

/** Entry state to propose for an edit, keeping identity and scope stable. */export function draftFromEntry(entry: SyncEntryValue): SyncEntryDraftValue {
  return {
    entryId: entry.entryId,
    kind: entry.kind,
    scope: entry.scope,
    content: entry.content,
    payload: entry.payload,
    withdrawnAt: entry.withdrawnAt,
  };
}

export type OutboxState = 'pending' | 'confirmed' | 'conflict' | 'unknown' | 'needs_review';
export type InboxState = 'received' | 'applied' | 'needs_review';

export interface SyncStateRecord {
  scope: string;
  cursor: number;
  lastPullAt: string | null;
  lastError: string | null;
}

export interface SyncOutboxRecord {
  changeId: string;
  scope: string;
  entryId: string;
  baseVersion: number;
  operation: SyncChangeRequest['operation'];
  entry: SyncEntryDraftValue;
  state: OutboxState;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SyncInboxRecord {
  scope: string;
  seq: number;
  changeId: string;
  entryId: string;
  version: number;
  operation: SyncChangeRequest['operation'];
  entry: SyncEntryValue;
  state: InboxState;
  error: string | null;
}

/** Local ledgers the coordinator needs; storage lives in the governance package. */
export interface SyncLedgerPort {
  state(scope: string): SyncStateRecord;
  cursor(scope: string): number;
  setCursor(scope: string, cursor: number, at: string): void;
  setError(scope: string, error: string | null, at: string): void;
  enqueue(change: SyncChangeRequest, at: string): void;
  outbox(state?: OutboxState, limit?: number): SyncOutboxRecord[];
  markOutbox(changeId: string, state: OutboxState, error: string | null, at: string): void;
  receive(record: SyncChangeRecordValue, at: string): boolean;
  inbox(scope: string, limit?: number): SyncInboxRecord[];
  markInbox(scope: string, seq: number, state: InboxState, error?: string | null): void;
  /** Replace the inbox after a snapshot: rows the snapshot covers are dropped. */
  resetScope?(scope: string, cursor: number, at: string): void;
  progress(scope: string, fromSeq: number, limit?: number): { seq: number; applied: boolean }[];
}

/** Remote operations the coordinator needs; `sync-client` implements them. */
export interface SyncRemotePort {
  push(change: SyncChangeRequest): Promise<SyncAcceptedValue>;
  pull(scope: string, since: number, limit: number): Promise<SyncPullPageValue>;
  snapshot(scope: string): Promise<SyncSnapshotValue>;
  receipt(changeId: string): Promise<SyncAcceptedValue | null>;
}

export type ApplyOutcome = { status: 'applied' } | { status: 'needs_review'; error?: string };

function errorCode(error: unknown): string {
  return error instanceof MnemoWeaveError ? error.code : 'INTERNAL';
}

function acceptedRecord(row: SyncOutboxRecord, accepted: SyncAcceptedValue, at: string): SyncChangeRecordValue {
  return {
    changeId: row.changeId,
    entryId: row.entryId,
    scope: accepted.scope,
    version: accepted.version,
    seq: accepted.seq,
    operation: row.operation,
    entry: { ...row.entry, version: accepted.version },
    deviceId: 'local',
    recordedAt: at,
  };
}

/**
 * Drives one local Server's side of sync: push the outbox, pull into the inbox,
 * apply received changes in sequence order, and move the scope cursor only over
 * the contiguous applied run.
 */
export class SyncCoordinator {
  private readonly remote: SyncRemotePort;
  private readonly ledger: SyncLedgerPort;
  private readonly now: () => string;

  constructor(remote: SyncRemotePort, ledger: SyncLedgerPort, now: () => string = () => new Date().toISOString()) {
    this.remote = remote;
    this.ledger = ledger;
    this.now = now;
  }

  /** Push pending changes. A confirmed push is fed back into the inbox so every path applies once. */
  async flushOutbox(limit = 20): Promise<{ confirmed: number; conflict: number; unknown: number; queued: number; needsReview: number }> {
    const counts = { confirmed: 0, conflict: 0, unknown: 0, queued: 0, needsReview: 0 };
    for (const row of this.ledger.outbox('pending', limit)) {
      const at = this.now();
      try {
        const accepted = await this.remote.push({ changeId: row.changeId, baseVersion: row.baseVersion, operation: row.operation, entry: row.entry });
        this.ledger.markOutbox(row.changeId, 'confirmed', null, at);
        this.ledger.receive(acceptedRecord(row, accepted, at), at);
        counts.confirmed += 1;
      } catch (error) {
        if (error instanceof VersionConflictError) {
          this.ledger.markOutbox(row.changeId, 'conflict', 'VERSION_CONFLICT', at);
          counts.conflict += 1;
          continue;
        }
        const reached = (error as { reachedRemote?: unknown }).reachedRemote;
        if (typeof reached === 'boolean') {
          if (reached) {
            this.ledger.markOutbox(row.changeId, 'unknown', 'SYNC_OUTCOME_UNKNOWN', at);
            counts.unknown += 1;
          } else {
            this.ledger.markOutbox(row.changeId, 'pending', 'SYNC_QUEUED', at);
            counts.queued += 1;
          }
          continue;
        }
        this.ledger.markOutbox(row.changeId, 'needs_review', errorCode(error), at);
        counts.needsReview += 1;
      }
    }
    return counts;
  }

  /**
   * Resolve changes whose submission outcome was unknown. A registered receipt means
   * the remote accepted it; an explicit absence means it never arrived, so it returns
   * to the queue. Neither case is inferred from a timeout.
   */
  async resolveUnknown(limit = 20): Promise<{ confirmed: number; requeued: number }> {
    const counts = { confirmed: 0, requeued: 0 };
    for (const row of this.ledger.outbox('unknown', limit)) {
      const at = this.now();
      const accepted = await this.remote.receipt(row.changeId);
      if (!accepted) {
        this.ledger.markOutbox(row.changeId, 'pending', 'SYNC_QUEUED', at);
        counts.requeued += 1;
        continue;
      }
      this.ledger.markOutbox(row.changeId, 'confirmed', null, at);
      this.ledger.receive(acceptedRecord(row, accepted, at), at);
      counts.confirmed += 1;
    }
    return counts;
  }

  /** Pull one page for a scope. The cursor still only moves during apply. */
  async pullScope(scope: string, limit = 200): Promise<{ received: number; needsSnapshot: boolean; gapAt: number | null }> {
    const cursor = this.ledger.cursor(scope);
    const page = await this.remote.pull(scope, cursor, limit);
    const plan = planPull(page, cursor);
    const at = this.now();
    if (plan.needsSnapshot) {
      this.ledger.setError(scope, 'SNAPSHOT_REQUIRED', at);
      return { received: 0, needsSnapshot: true, gapAt: null };
    }
    let received = 0;
    for (const change of plan.apply) if (this.ledger.receive(change, at)) received += 1;
    this.ledger.setError(scope, plan.gapAt === null ? null : `GAP:${plan.gapAt}`, at);
    return { received, needsSnapshot: false, gapAt: plan.gapAt };
  }

  /**
   * The retention floor moved past this cursor, so the change stream can no longer be
   * replayed. Take the authoritative snapshot, drop the inbox rows it supersedes, set
   * the cursor to its cut point, and apply every entry it carries.
   */
  async captureSnapshot(scope: string, apply: (row: SyncInboxRecord) => Promise<ApplyOutcome>): Promise<{ applied: number; failed: number; cursor: number }> {
    const snapshot = SyncSnapshot.parse(await this.remote.snapshot(scope));
    const at = this.now();
    const cursor = snapshotCursor(snapshot);
    this.ledger.resetScope?.(scope, cursor, at);
    this.ledger.setCursor(scope, cursor, at);
    let applied = 0;
    let failed = 0;
    for (const entry of snapshot.entries) {
      // History matters: replaying every revision rebuilds the same Revision chain the
      // change stream would have produced, and the supersedes edge comes from the
      // version-N-1 mapping rather than from a change payload.
      const revisions = entry.revisions && entry.revisions.length > 0
        ? entry.revisions
        : [{ version: entry.version, content: entry.content, createdAt: at }];
      for (const revision of revisions) {
        const row: SyncInboxRecord = {
          scope: snapshot.scope, seq: cursor, changeId: entry.entryId, entryId: entry.entryId, version: revision.version,
          operation: 'update',
          entry: {
            ...entry, version: revision.version, content: revision.content,
            withdrawnAt: revision.version === entry.version ? entry.withdrawnAt : null,
          },
          state: 'received', error: null,
        };
        const outcome = await apply(row);
        if (outcome.status === 'applied') applied += 1;
        else failed += 1;
      }
    }
    this.ledger.setError(scope, failed === 0 ? null : 'SNAPSHOT_APPLY_INCOMPLETE', at);
    return { applied, failed, cursor };
  }

  /**
   * Apply received rows in order. The first row that needs review blocks the cursor,
   * so later rows are not applied out of order and the UI keeps showing the last
   * verified version.
   */
  async applyScope(scope: string, apply: (row: SyncInboxRecord) => Promise<ApplyOutcome>, limit = 50): Promise<{ applied: number; cursor: number }> {
    const start = this.ledger.cursor(scope);
    let expected = start + 1;
    let applied = 0;
    for (const row of this.ledger.inbox(scope, limit)) {
      if (row.seq !== expected) break;
      const outcome = await apply(row);
      if (outcome.status !== 'applied') {
        this.ledger.markInbox(scope, row.seq, 'needs_review', outcome.error ?? 'APPLY_FAILED');
        break;
      }
      this.ledger.markInbox(scope, row.seq, 'applied');
      applied += 1;
      expected += 1;
    }
    const cursor = advanceCursor(this.ledger.progress(scope, start), start);
    this.ledger.setCursor(scope, cursor, this.now());
    return { applied, cursor };
  }
}
