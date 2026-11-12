import { createHash } from 'node:crypto';
import { MnemoWeaveError, SyncChangeInput, SyncPullPage, SyncSnapshot, SyncStream, streamOf } from '../../contracts/src/index.ts';
import type { SyncAcceptedValue, SyncChangeRecordValue, SyncChangeRequest, SyncContentValue, SyncEntryDraftValue, SyncEntryValue, SyncPullPageValue, SyncSnapshotValue } from '../../contracts/src/index.ts';

/**
 * Pure sync rules. No HTTP, no sqlite, no Provider: the coordinator only decides what a change
 * looks like, which pulled records may be applied, and how far a stream cursor may advance.
 *
 * Protocol 2: a stream is derived from the entry itself. A change that names a stream, or whose
 * derived stream disagrees with the page it arrived in, is refused rather than guessed at.
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
  if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) throw new MnemoWeaveError('INVALID_INPUT');
  const digest = createHash('sha256').update(bytes).digest('hex');
  return { format: 'plain', data: text, contentHash: digest, byteLength: bytes.length };
}

/**
 * `create` starts from base version 0; updates and deletions need a real base. A base of 0 on an
 * existing entry is rejected by the remote as VERSION_CONFLICT, never silently promoted.
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
  // The stream is derived, not accepted: a caller cannot place an entry in a stream of its choice.
  streamOf(input.entry.kind, input.entry.payload);
  return SyncChangeInput.parse({
    changeId: input.changeId,
    baseVersion: input.baseVersion,
    operation: input.operation,
    entry: input.entry,
  });
}

/**
 * Build an edit against the version the user saw when opening the editor. `entry.version` may
 * already be newer because a background pull advanced the local copy; using it as the base would
 * silently overwrite another machine's confirmed change, so it is deliberately ignored here.
 */
export function buildEditChange(input: {
  changeId: string;
  entryVersion: number;
  entry: SyncEntryDraftValue;
}): SyncChangeRequest {
  if (input.entryVersion < 1) throw new MnemoWeaveError('INVALID_INPUT');
  return buildChange({ changeId: input.changeId, baseVersion: input.entryVersion, operation: 'update', entry: input.entry });
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
  /** Records whose derived stream disagreed with the page; they are never applied. */
  mismatched: number;
}

/**
 * Decide what one pulled page may apply for one stream.
 *
 * Sequences are per stream and contiguous, so a gap means the page did not bring everything and
 * application must stop before it. Records at or below the cursor are duplicates (a replayed
 * page) and are ignored. A record whose derived stream is not this stream is refused: it would
 * otherwise cross an authorization boundary.
 */
export function planPull(page: SyncPullPageValue, cursor: number): PullPlan {
  const parsed = SyncPullPage.parse(page);
  const consistent = parsed.changes.filter(record => {
    try { return streamOf(record.entry.kind, record.entry.payload) === parsed.stream; } catch { return false; }
  });
  const mismatched = parsed.changes.length - consistent.length;
  if (parsed.retentionFloor > 0 && cursor + 1 < parsed.retentionFloor) {
    return { apply: [], nextCursor: cursor, needsSnapshot: true, gapAt: null, mismatched };
  }
  const ordered = [...consistent].sort((left, right) => left.seq - right.seq);
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
  return { apply, nextCursor: expected - 1, needsSnapshot: false, gapAt, mismatched };
}

/**
 * Cursor derived from applied inbox rows: only a contiguous run from `cursor + 1` advances it.
 * A row that is received but not applied holds the cursor back.
 */
export function advanceCursor(rows: readonly { seq: number; applied: boolean }[], cursor: number): number {
  const applied = new Set(rows.filter(row => row.applied).map(row => row.seq));
  let next = cursor;
  while (applied.has(next + 1)) next += 1;
  return next;
}

/** True when a snapshot's cut point can be used directly as the stream cursor. */
export function snapshotCursor(snapshot: SyncSnapshotValue): number {
  const parsed = SyncSnapshot.parse(snapshot);
  return parsed.nextSince === parsed.asOfSeq ? parsed.nextSince : parsed.asOfSeq;
}

export type SubmitFailure = 'queued' | 'unknown';

/**
 * A request that never reached the remote is safe to retry and is reported as queued. Once bytes
 * were sent, the outcome is unknown until a changeId lookup answers.
 */
export function classifySubmitFailure(reachedRemote: boolean): SubmitFailure {
  return reachedRemote ? 'unknown' : 'queued';
}

/** A user edit must carry the version it was based on; the server never substitutes the latest. */
export function assertEntryVersion(current: number, provided: number): void {
  if (current !== provided) throw new MnemoWeaveError('VERSION_CONFLICT');
}

/** Entry state to propose for an edit, keeping identity and payload stable. */
export function draftFromEntry(entry: SyncEntryValue): SyncEntryDraftValue {
  return {
    entryId: entry.entryId,
    kind: entry.kind,
    content: entry.content,
    payload: entry.payload,
    withdrawnAt: entry.withdrawnAt,
  };
}

/** A stream name must be one the protocol knows before it is used as a query parameter. */
export function assertStream(stream: string): string {
  const parsed = SyncStream.safeParse(stream);
  if (!parsed.success) throw new MnemoWeaveError('INVALID_INPUT');
  return parsed.data;
}

export type OutboxState = 'pending' | 'confirmed' | 'conflict' | 'unknown' | 'needs_review';
export type InboxState = 'received' | 'applied' | 'needs_review';

export interface SyncStateRecord {
  stream: string;
  cursor: number;
  lastPullAt: string | null;
  lastError: string | null;
}

export interface SyncOutboxRecord {
  changeId: string;
  stream: string;
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
  stream: string;
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
  state(stream: string): SyncStateRecord;
  cursor(stream: string): number;
  setCursor(stream: string, cursor: number, at: string): void;
  setError(stream: string, error: string | null, at: string): void;
  enqueue(change: SyncChangeRequest, at: string): void;
  outbox(state?: OutboxState, limit?: number): SyncOutboxRecord[];
  /**
   * The unconfirmed change for one entry, if any. A paged `outbox()` scan is not enough:
   * confirmed history pushes an entry's own row past the page limit.
   */
  outboxForEntry(entryId: string): SyncOutboxRecord | null;
  /** One change by id, independent of how much history precedes it. */
  outboxChange(changeId: string): SyncOutboxRecord | null;
  markOutbox(changeId: string, state: OutboxState, error: string | null, at: string): void;
  receive(record: SyncChangeRecordValue, at: string): boolean;
  inbox(stream: string, limit?: number): SyncInboxRecord[];
  /** The inbox row for one stream/seq, so an apply step can tell whether it is still pending. */
  inboxEntry(stream: string, seq: number): SyncInboxRecord | null;
  /** The inbox row for one change, so a confirmation is read without a paged scan. */
  inboxChange(changeId: string): SyncInboxRecord | null;
  markInbox(stream: string, seq: number, state: InboxState, error?: string | null): void;
  /** Replace the inbox after a snapshot: rows the snapshot covers are dropped. */
  resetScope?(stream: string, cursor: number, at: string): void;
  progress(stream: string, fromSeq: number, limit?: number): { seq: number; applied: boolean }[];
}

/** Remote operations the coordinator needs; `sync-client` implements them. */
export interface SyncRemotePort {
  push(change: SyncChangeRequest): Promise<SyncAcceptedValue>;
  pull(stream: string, since: number, limit: number): Promise<SyncPullPageValue>;
  snapshot(stream: string): Promise<SyncSnapshotValue>;
  receipt(changeId: string): Promise<SyncAcceptedValue | null>;
}

export type ApplyOutcome = { status: 'applied' } | { status: 'needs_review'; error?: string };

function errorCode(error: unknown): string {
  return error instanceof MnemoWeaveError ? error.code : 'INTERNAL';
}

function acceptedRecord(row: SyncOutboxRecord, accepted: SyncAcceptedValue, at: string): SyncChangeRecordValue {
  const confirmedAt = accepted.confirmedAt ?? at;
  const payload = row.entry.kind === 'workspace-archive' && 'workspaceId' in row.entry.payload && accepted.confirmedAt
    ? { ...row.entry.payload, archivedAt: row.entry.payload.state === 'archived' ? confirmedAt : null }
    : row.entry.payload;
  return {
    changeId: row.changeId,
    entryId: row.entryId,
    stream: accepted.stream,
    version: accepted.version,
    seq: accepted.seq,
    operation: row.operation,
    entry: {
      ...row.entry, payload, version: accepted.version,
      ...(accepted.confirmedAt ? { revisions: [{ version: accepted.version, content: row.entry.content, createdAt: confirmedAt }] } : {}),
    },
    deviceId: 'local',
    recordedAt: confirmedAt,
  };
}

/**
 * Drives one local Server's side of sync: push the outbox, pull into the inbox, apply received
 * changes in sequence order, and move a stream cursor only over the contiguous applied run.
 */
export class SyncCoordinator {
  private readonly remote: SyncRemotePort;
  private readonly ledger: SyncLedgerPort;
  private readonly now: () => string;
  private readonly stageSnapshot: ((snapshot: SyncSnapshotValue) => {
    apply(row: SyncInboxRecord): Promise<ApplyOutcome>;
    commit(advance: () => void): void;
  }) | undefined;

  // A snapshot and incremental apply for the same stream must not interleave.
  private readonly applyingStreams = new Map<string, Promise<void>>();

  constructor(
    remote: SyncRemotePort,
    ledger: SyncLedgerPort,
    now: () => string = () => new Date().toISOString(),
    stageSnapshot?: SyncCoordinator['stageSnapshot'],
  ) {
    this.remote = remote;
    this.ledger = ledger;
    this.now = now;
    this.stageSnapshot = stageSnapshot;
  }

  private async claimStream(stream: string): Promise<() => void> {
    const previous = this.applyingStreams.get(stream);
    let release = () => {};
    const held = new Promise<void>(done => { release = done; });
    const turn = previous ? previous.then(() => held) : held;
    this.applyingStreams.set(stream, turn);
    await previous;
    return () => {
      release();
      if (this.applyingStreams.get(stream) === turn) this.applyingStreams.delete(stream);
    };
  }

  /** Push pending changes. A confirmed push is fed back into the inbox so every path applies once. */
  async flushOutbox(limit = 20): Promise<{ confirmed: number; conflict: number; unknown: number; queued: number; needsReview: number }> {
    const counts = { confirmed: 0, conflict: 0, unknown: 0, queued: 0, needsReview: 0 };
    for (const row of this.ledger.outbox('pending', limit)) {
      const at = this.now();
      try {
        const accepted = await this.remote.push({ changeId: row.changeId, baseVersion: row.baseVersion, operation: row.operation, entry: row.entry });
        this.ledger.markOutbox(row.changeId, 'confirmed', null, at);
        if (accepted.entryId === row.entryId) this.ledger.receive(acceptedRecord(row, accepted, at), at);
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
   * Resolve changes whose submission outcome was unknown. A registered receipt means the remote
   * accepted it; an explicit absence means it never arrived, so it returns to the queue.
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
      if (accepted.entryId === row.entryId) this.ledger.receive(acceptedRecord(row, accepted, at), at);
      counts.confirmed += 1;
    }
    return counts;
  }

  /** Pull one page for a stream. The cursor still only moves during apply. */
  async pullStream(stream: string, limit = 200): Promise<{ received: number; needsSnapshot: boolean; gapAt: number | null; mismatched: number }> {
    const cursor = this.ledger.cursor(stream);
    const page = await this.remote.pull(stream, cursor, limit);
    const plan = planPull(page, cursor);
    const at = this.now();
    if (plan.needsSnapshot || (page.snapshotAtStart && this.ledger.state(stream).lastPullAt === null)) {
      this.ledger.setError(stream, 'SNAPSHOT_REQUIRED', at);
      return { received: 0, needsSnapshot: true, gapAt: null, mismatched: plan.mismatched };
    }
    let received = 0;
    for (const change of plan.apply) if (this.ledger.receive(change, at)) received += 1;
    this.ledger.setError(stream, plan.gapAt === null ? null : `GAP:${plan.gapAt}`, at);
    return { received, needsSnapshot: false, gapAt: plan.gapAt, mismatched: plan.mismatched };
  }

  /**
   * The retention floor moved past this cursor, so the change stream can no longer be replayed.
   * Take the authoritative snapshot, stage every entry it carries, verify all of it, and only
   * then switch visible state and the cursor in one local transaction.
   *
   * Applying first keeps the cursor where it was, so an interrupted pass retakes the same
   * snapshot; replay is safe because each apply is idempotent per entry version. A failed
   * snapshot keeps the previous applied state and cursor, so readers never see a partial set.
   */
  async captureSnapshot(stream: string, apply: (row: SyncInboxRecord) => Promise<ApplyOutcome>): Promise<{ applied: number; failed: number; cursor: number }> {
    const release = await this.claimStream(stream);
    try { return await this.captureSnapshotLocked(stream, apply); }
    finally { release(); }
  }

  private async captureSnapshotLocked(stream: string, apply: (row: SyncInboxRecord) => Promise<ApplyOutcome>): Promise<{ applied: number; failed: number; cursor: number }> {
    const snapshot = SyncSnapshot.parse(await this.remote.snapshot(stream));
    if (snapshot.stream !== stream) throw new MnemoWeaveError('INVALID_INPUT');
    const at = this.now();
    const cursor = snapshotCursor(snapshot);
    if (cursor < this.ledger.cursor(stream)) return { applied: 0, failed: 0, cursor: this.ledger.cursor(stream) };
    const stage = this.stageSnapshot?.(snapshot);
    const applyEntry = stage?.apply ?? apply;
    let applied = 0;
    let failed = 0;
    for (const entry of snapshot.entries) {
      if (streamOf(entry.kind, entry.payload) !== stream) throw new MnemoWeaveError('INVALID_INPUT');
      // History matters: replaying every revision rebuilds the same revision chain the change
      // stream would have produced, and the supersedes edge comes from the previous mapping.
      const revisions = entry.revisions && entry.revisions.length > 0
        ? entry.revisions
        : [{ version: entry.version, content: entry.content, createdAt: at }];
      for (const revision of revisions) {
        const row: SyncInboxRecord = {
          stream: snapshot.stream, seq: cursor, changeId: entry.entryId, entryId: entry.entryId, version: revision.version,
          operation: 'update',
          entry: {
            ...entry, version: revision.version, content: revision.content,
            withdrawnAt: revision.version === entry.version ? entry.withdrawnAt : null,
          },
          state: 'received', error: null,
        };
        const outcome = await applyEntry(row);
        if (outcome.status === 'applied') applied += 1;
        else failed += 1;
      }
    }
    if (failed > 0) {
      this.ledger.setError(stream, 'SNAPSHOT_APPLY_INCOMPLETE', at);
      return { applied: stage ? 0 : applied, failed, cursor: this.ledger.cursor(stream) };
    }
    const advance = () => {
      this.ledger.resetScope?.(stream, cursor, at);
      this.ledger.setCursor(stream, cursor, at);
      this.ledger.setError(stream, null, at);
    };
    try {
      if (stage) stage.commit(advance);
      else advance();
    } catch (error) {
      this.ledger.setError(stream, errorCode(error), at);
      return { applied: 0, failed: 1, cursor: this.ledger.cursor(stream) };
    }
    return { applied, failed, cursor: this.ledger.cursor(stream) };
  }

  /**
   * Apply received rows in order. The first row that needs review blocks the cursor, so later
   * rows are not applied out of order and readers keep the last verified version.
   */
  async applyStream(stream: string, apply: (row: SyncInboxRecord) => Promise<ApplyOutcome>, limit = 50): Promise<{ applied: number; cursor: number }> {
    const release = await this.claimStream(stream);
    try { return await this.applyStreamLocked(stream, apply, limit); }
    finally { release(); }
  }

  private async applyStreamLocked(stream: string, apply: (row: SyncInboxRecord) => Promise<ApplyOutcome>, limit: number): Promise<{ applied: number; cursor: number }> {
    const start = this.ledger.cursor(stream);
    let expected = start + 1;
    let applied = 0;
    for (const row of this.ledger.inbox(stream, limit)) {
      if (row.seq !== expected) break;
      const current = this.ledger.inboxEntry(stream, row.seq);
      if (!current || current.state === 'applied') { expected += 1; continue; }
      const outcome = await apply(row);
      if (outcome.status !== 'applied') {
        this.ledger.markInbox(stream, row.seq, 'needs_review', outcome.error ?? 'APPLY_FAILED');
        break;
      }
      this.ledger.markInbox(stream, row.seq, 'applied');
      applied += 1;
      expected += 1;
    }
    const cursor = advanceCursor(this.ledger.progress(stream, start), start);
    this.ledger.setCursor(stream, cursor, this.now());
    return { applied, cursor };
  }
}
