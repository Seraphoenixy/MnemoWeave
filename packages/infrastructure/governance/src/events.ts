import { randomUUID } from 'node:crypto';
import { HostEvent, IdleReviewRun, MnemoWeaveError } from '../../../core/contracts/src/index.ts';
import type { EventRecord, HostEventRecord, IdleReviewRunItemRecord, IdleReviewRunRecord, IdleReviewSignalRecord, RetentionSweepReport } from '../../../core/contracts/src/index.ts';

type Transaction = <T>(operation: () => T) => T;
export type DatabaseSync = import('node:sqlite').DatabaseSync;

/** Retention policy defaults (RETENTION-01/02, OPS-01); durations are configurable values. */
export const HOT_RETENTION_DAYS = 7;
export const ARCHIVE_RETENTION_DAYS = 90;
export const CANDIDATE_BODY_RETENTION_DAYS = 30;
export const DIAGNOSTIC_LOG_RETENTION_DAYS = 30;

/**
 * Default selective-persistence rule (HOST-03): metadata for session boundaries, tool
 * failures and candidate-linked or explicitly important messages; nothing else is stored.
 */
export function defaultSelectionRule(event: HostEventRecord): 'metadata' | 'body' | 'skip' {
  if (event.kind === 'session.started' || event.kind === 'session.ended') return 'metadata';
  if (event.kind === 'tool.completed') return event.payload.outcome === 'failure' || event.inferred === true ? 'body' : 'skip';
  if (event.payload.candidateId !== undefined) return 'body';
  return 'skip';
}

const DAY_MS = 86_400_000;

/**
 * Session event ledger: normalization, stable-identity dedup, selective persistence and
 * the 7-day hot → 90-day archive lifecycle with protected evidence (RETENTION-01).
 */
export class SessionEventStore {
  private readonly db: DatabaseSync;
  private readonly transaction: Transaction;
  private readonly select: (event: HostEventRecord) => 'metadata' | 'body' | 'skip';
  constructor(db: DatabaseSync, transaction: Transaction, options: { select?: (event: HostEventRecord) => 'metadata' | 'body' | 'skip' } = {}) {
    this.db = db; this.transaction = transaction; this.select = options.select ?? defaultSelectionRule;
  }
  /** Normalizes and persists one host event; replays with identical content are idempotent. */
  record(hostId: string, input: unknown, forceBody = false): { status: 'stored' | 'replayed' | 'skipped'; eventId: string } {
    const event = HostEvent.parse(input);
    if (event.protocolVersion.split('.')[0] !== '1') throw new MnemoWeaveError('INVALID_INPUT');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT payload_json FROM session_events WHERE host_id=? AND event_id=?').get(hostId, event.eventId);
      if (existing) {
        if (String(existing['payload_json']) !== JSON.stringify(event.payload)) throw new MnemoWeaveError('IDEMPOTENCY_CONFLICT');
        return { status: 'replayed' as const, eventId: event.eventId };
      }
      const selection = forceBody ? 'body' : this.select(event);
      if (selection === 'skip') return { status: 'skipped' as const, eventId: event.eventId };
      const payload = selection === 'metadata' ? {} : event.payload;
      this.db.prepare(`INSERT INTO session_events(host_id,event_id,session_id,turn_id,project_id,kind,occurred_at,received_at,source_ref,adapter_version,protocol_version,stage,important,protected_reason,archived_at,inferred,payload_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'hot',?,NULL,NULL,?,?)`).run(
        hostId, event.eventId, event.sessionId, event.turnId ?? null, null, event.kind, event.occurredAt, event.receivedAt, event.sourceRef,
        event.adapterVersion, event.protocolVersion, event.inferred === true ? 1 : this.isImportant(event) ? 1 : 0, event.inferred === true ? 1 : 0, JSON.stringify(payload),
      );
      return { status: 'stored' as const, eventId: event.eventId };
    });
  }
  /** Important markers survive dedup: the flag protects the event from ordinary clearing. */
  private isImportant(event: HostEventRecord): boolean {
    return event.payload.outcome === 'failure';
  }
  /** Links a stored event to a candidate as protected evidence; unprotectable links fail. */
  linkEvidence(eventId: string, hostId: string, candidateId: string): void {
    this.transaction(() => {
      if (!this.db.prepare('SELECT event_id FROM session_events WHERE host_id=? AND event_id=?').get(hostId, eventId)) throw new MnemoWeaveError('NOT_FOUND');
      this.db.prepare('INSERT INTO session_event_refs(event_id,host_id,candidate_id) VALUES(?,?,?)').run(eventId, hostId, candidateId);
    });
  }
  get(hostId: string, eventId: string): EventRecord {
    const row = this.db.prepare('SELECT * FROM session_events WHERE host_id=? AND event_id=?').get(hostId, eventId);
    if (!row) throw new MnemoWeaveError('NOT_FOUND');
    return this.toRecord(row);
  }
  list(hostId: string, sessionId: string): EventRecord[] {
    return this.db.prepare('SELECT * FROM session_events WHERE host_id=? AND session_id=? ORDER BY received_at, event_id').all(hostId, sessionId).map(row => this.toRecord(row));
  }
  /** Idle-review watermark and stored signals for one Host session. */
  idleReview(hostId: string, sessionId: string): { lastTurn: number; signals: IdleReviewSignalRecord[] } {
    const state = this.db.prepare('SELECT last_turn FROM idle_review_state WHERE host_id=? AND session_id=?').get(hostId, sessionId);
    const signals = this.db.prepare(`SELECT id,session_id,turn_id,event_id,text,project_id,reason,created_at
      FROM idle_review_signals WHERE host_id=? AND session_id=? ORDER BY turn_id, id`).all(hostId, sessionId).map(row => ({
      id: String(row['id']), sessionId: String(row['session_id']), turnId: Number(row['turn_id']),
      eventId: String(row['event_id']), text: String(row['text']),
      reason: String(row['reason']) as IdleReviewSignalRecord['reason'], createdAt: String(row['created_at']),
    }));
    return { lastTurn: state === undefined ? 0 : Number(state['last_turn']), signals };
  }
  /** Persist one pass: signals are idempotent by event, and the watermark only moves forward. */
  recordIdleReview(hostId: string, sessionId: string, lastTurn: number, signals: readonly IdleReviewSignalRecord[]): void {
    this.transaction(() => {
      for (const signal of signals) {
        this.db.prepare('INSERT OR IGNORE INTO idle_review_signals(host_id,session_id,id,turn_id,event_id,text,project_id,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(hostId, sessionId, signal.id, signal.turnId, signal.eventId, signal.text, null, signal.reason, signal.createdAt);
      }
      this.db.prepare(`INSERT INTO idle_review_state(host_id,session_id,last_turn,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(host_id,session_id) DO UPDATE SET last_turn=MAX(idle_review_state.last_turn, excluded.last_turn), updated_at=excluded.updated_at`)
        .run(hostId, sessionId, lastTurn, new Date().toISOString());
    });
  }

  private idleRunRow(hostId: string, runId: string): IdleReviewRunRecord {
    const row = this.db.prepare('SELECT * FROM idle_review_runs WHERE host_id=? AND id=?').get(hostId, runId);
    if (row === undefined) throw new MnemoWeaveError('NOT_FOUND');
    return IdleReviewRun.parse({
      id: row['id'], sessionId: row['session_id'], state: row['state'], attempt: row['attempt'],
      startedAt: row['started_at'], finishedAt: row['finished_at'] ?? null,
      error: row['error'] === '' ? null : row['error'], items: JSON.parse(String(row['items_json'] ?? '[]')),
    });
  }
  /** Start a run and reserve the signals it will process, in one transaction. */
  beginIdleRunWithSignals(hostId: string, sessionId: string, limit: number): { run: IdleReviewRunRecord; signals: IdleReviewSignalRecord[] } {
    return this.transaction(() => {
      if (this.db.prepare("SELECT id FROM idle_review_runs WHERE host_id=? AND session_id=? AND state='running'").get(hostId, sessionId)) throw new MnemoWeaveError('INVALID_STATE');
      const attempt = Number((this.db.prepare('SELECT COALESCE(MAX(attempt),0) n FROM idle_review_runs WHERE host_id=? AND session_id=?').get(hostId, sessionId)!['n'])) + 1;
      const id = randomUUID();
      const rows = this.db.prepare(`SELECT id,session_id,turn_id,event_id,text,project_id,reason,created_at
        FROM idle_review_signals WHERE host_id=? AND session_id=? AND run_id IS NULL ORDER BY turn_id, id LIMIT ?`).all(hostId, sessionId, limit);
      const signals = rows.map(row => ({
        id: String(row['id']), sessionId: String(row['session_id']), turnId: Number(row['turn_id']),
        eventId: String(row['event_id']), text: String(row['text']),
        reason: String(row['reason']) as IdleReviewSignalRecord['reason'], createdAt: String(row['created_at']),
      }));
      this.db.prepare('INSERT INTO idle_review_runs(id,host_id,session_id,state,attempt,started_at,finished_at,error,items_json,signal_ids_json) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, hostId, sessionId, 'running', attempt, new Date().toISOString(), null, '', '[]', JSON.stringify(signals.map(signal => signal.id)));
      for (const signal of signals) this.db.prepare('UPDATE idle_review_signals SET run_id=? WHERE host_id=? AND id=?').run(id, hostId, signal.id);
      return { run: this.idleRunRow(hostId, id), signals };
    });
  }
  /** Sessions with signals no settled run has consumed, so a host can trigger review. */
  pendingIdleSessions(hostId: string): Array<{ sessionId: string; count: number }> {
    return this.db.prepare(`SELECT session_id, COUNT(*) n FROM idle_review_signals
      WHERE host_id=? AND run_id IS NULL GROUP BY session_id ORDER BY MAX(turn_id) DESC LIMIT 20`)
      .all(hostId).map(row => ({ sessionId: String(row['session_id']), count: Number(row['n']) }));
  }
  /**
   * Release the reservations a run must not keep.
   *
   * A succeeded run consumes every signal it reserved. A failed or cancelled run keeps the ones
   * whose action reached a terminal state (applied or skipped) and releases the rest, so the next
   * attempt retries only the unfinished work instead of repeating writes that already happened.
   */
  private releaseIdleRun(hostId: string, runId: string, keep: readonly string[]): void {
    const placeholders = keep.map(() => '?').join(',');
    const sql = keep.length === 0
      ? 'UPDATE idle_review_signals SET run_id=NULL WHERE host_id=? AND run_id=?'
      : `UPDATE idle_review_signals SET run_id=NULL WHERE host_id=? AND run_id=? AND id NOT IN (${placeholders})`;
    this.db.prepare(sql).run(hostId, runId, ...keep);
  }
  /** One run by id, scoped to its Host; another Host's run is not found. */
  idleRun(hostId: string, runId: string): IdleReviewRunRecord | null {
    const row = this.db.prepare('SELECT 1 FROM idle_review_runs WHERE host_id=? AND id=?').get(hostId, runId);
    return row === undefined ? null : this.idleRunRow(hostId, runId);
  }
  idleRuns(hostId: string, sessionId: string): IdleReviewRunRecord[] {
    return this.db.prepare('SELECT id FROM idle_review_runs WHERE host_id=? AND session_id=? ORDER BY started_at DESC').all(hostId, sessionId)
      .map(row => this.idleRunRow(hostId, String(row['id'])));
  }
  /** Start a run; a session already running is refused rather than queued. */
  beginIdleRun(hostId: string, sessionId: string): IdleReviewRunRecord {
    return this.transaction(() => {
      if (this.db.prepare("SELECT id FROM idle_review_runs WHERE host_id=? AND session_id=? AND state='running'").get(hostId, sessionId)) throw new MnemoWeaveError('INVALID_STATE');
      const attempt = Number((this.db.prepare('SELECT COALESCE(MAX(attempt),0) n FROM idle_review_runs WHERE host_id=? AND session_id=?').get(hostId, sessionId)!['n'])) + 1;
      const id = randomUUID();
      this.db.prepare('INSERT INTO idle_review_runs(id,host_id,session_id,state,attempt,started_at,finished_at,error,items_json) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, hostId, sessionId, 'running', attempt, new Date().toISOString(), null, '', '[]');
      return this.idleRunRow(hostId, id);
    });
  }
  /** Append one item result; a finished or cancelled run refuses late writes. */
  recordIdleRunItem(hostId: string, runId: string, item: IdleReviewRunItemRecord): IdleReviewRunRecord {
    return this.transaction(() => {
      const run = this.idleRunRow(hostId, runId);
      if (run.state !== 'running') throw new MnemoWeaveError('INVALID_STATE');
      if (run.items.some(existing => existing.index === item.index)) throw new MnemoWeaveError('INVALID_INPUT');
      const items = [...run.items, item];
      this.db.prepare('UPDATE idle_review_runs SET items_json=? WHERE host_id=? AND id=?').run(JSON.stringify(items), hostId, runId);
      return this.idleRunRow(hostId, runId);
    });
  }
  finishIdleRun(hostId: string, runId: string, state: 'succeeded' | 'failed' | 'cancelled', error?: string): IdleReviewRunRecord {
    return this.transaction(() => {
      const run = this.idleRunRow(hostId, runId);
      if (run.state !== 'running') throw new MnemoWeaveError('INVALID_STATE');
      this.db.prepare('UPDATE idle_review_runs SET state=?, finished_at=?, error=? WHERE host_id=? AND id=?')
        .run(state, new Date().toISOString(), error ?? '', hostId, runId);
      if (state !== 'succeeded') {
        // A signal is finished when its item reached a terminal state; only the rest are retried.
        const reserved = this.reservedSignals(hostId, runId);
        const finished = run.items.filter(item => item.state === 'applied' || item.state === 'skipped').map(item => reserved[item.index]);
        this.releaseIdleRun(hostId, runId, finished.filter((id): id is string => id !== undefined));
      }
      return this.idleRunRow(hostId, runId);
    });
  }
  /** The signals a run reserved, in the order they were offered to the task. */
  private reservedSignals(hostId: string, runId: string): string[] {
    const row = this.db.prepare('SELECT signal_ids_json FROM idle_review_runs WHERE host_id=? AND id=?').get(hostId, runId);
    if (row === undefined) return [];
    try {
      const parsed: unknown = JSON.parse(String(row['signal_ids_json'] ?? '[]'));
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
    } catch { return []; }
  }
  private toRecord(row: Record<string, unknown>): EventRecord {
    return {
      eventId: String(row['event_id']), hostId: String(row['host_id']), sessionId: String(row['session_id']),
      turnId: row['turn_id'] === null ? null : String(row['turn_id']),
      kind: row['kind'] as EventRecord['kind'], occurredAt: String(row['occurred_at']), receivedAt: String(row['received_at']),
      sourceRef: String(row['source_ref']), adapterVersion: String(row['adapter_version']), protocolVersion: String(row['protocol_version']),
      stage: row['stage'] as EventRecord['stage'], important: row['important'] === 1,
      protectedReason: row['protected_reason'] === null ? null : String(row['protected_reason']),
      archivedAt: row['archived_at'] === null ? null : String(row['archived_at']), inferred: row['inferred'] === 1,
      payload: JSON.parse(String(row['payload_json'])) as EventRecord['payload'],
    };
  }
  protect(eventId: string, hostId: string, reason: string): void {
    if (!reason.trim()) throw new MnemoWeaveError('INVALID_INPUT');
    this.transaction(() => {
      const result = this.db.prepare("UPDATE session_events SET protected_reason=?, important=1 WHERE host_id=? AND event_id=? AND stage!='cleared'").run(reason, hostId, eventId);
      if (result.changes !== 1) throw new MnemoWeaveError('NOT_FOUND');
    });
  }
  /**
   * RETENTION-01 lifecycle: hot → archived at received+7d, archived → cleared at archived+90d.
   * Boundaries are computed from the planned stage times so delayed sweeps never extend them;
   * plan-vs-actual skew is reported for diagnostics instead of silently shifting deadlines.
   */
  sweepEvents(now: Date, report: RetentionSweepReport): void {
    // Skew = how long after the planned boundary the sweep actually ran; logged, never folded
    // back into deadlines (delays must not reset retention periods).
    let maxSkew = 0;
    this.transaction(() => {
      const hotBoundary = new Date(now.getTime() - HOT_RETENTION_DAYS * DAY_MS).toISOString();
      const hotDue = this.db.prepare("SELECT host_id,event_id,received_at FROM session_events WHERE stage='hot' AND received_at<=?").all(hotBoundary);
      for (const row of hotDue) {
        // The archival stamp is the PLANNED boundary, not the sweep execution time.
        const planned = new Date(new Date(String(row['received_at'])).getTime() + HOT_RETENTION_DAYS * DAY_MS).toISOString();
        this.db.prepare("UPDATE session_events SET stage='archived',archived_at=? WHERE host_id=? AND event_id=?").run(planned, String(row['host_id']), String(row['event_id']));
        maxSkew = Math.max(maxSkew, now.getTime() - new Date(planned).getTime());
        report.archivedEvents++;
      }
      const archiveBoundary = new Date(now.getTime() - ARCHIVE_RETENTION_DAYS * DAY_MS).toISOString();
      const archivedDue = this.db.prepare("SELECT host_id,event_id,archived_at FROM session_events WHERE stage='archived' AND archived_at<=?").all(archiveBoundary);
      for (const row of archivedDue) {
        const refs = this.db.prepare('SELECT count(*) n FROM session_event_refs WHERE host_id=? AND event_id=?').get(String(row['host_id']), String(row['event_id']))!;
        const meta = this.db.prepare('SELECT important,protected_reason FROM session_events WHERE host_id=? AND event_id=?').get(String(row['host_id']), String(row['event_id']))!;
        if (Number(refs['n']) > 0 || meta['important'] === 1 || meta['protected_reason'] !== null) { report.protectedEvents++; continue; }
        this.db.prepare("UPDATE session_events SET stage='cleared',payload_json='{}' WHERE host_id=? AND event_id=?").run(String(row['host_id']), String(row['event_id']));
        maxSkew = Math.max(maxSkew, now.getTime() - (new Date(String(row['archived_at'])).getTime() + ARCHIVE_RETENTION_DAYS * DAY_MS));
        report.clearedEvents++;
      }
      report.planSkewMs.events = maxSkew;
    });
  }
}
