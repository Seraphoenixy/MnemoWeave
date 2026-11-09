import { HostEvent, MnemoWeaveError } from '../../../core/contracts/src/index.ts';
import type { EventRecord, HostEventRecord, RetentionSweepReport } from '../../../core/contracts/src/index.ts';

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
        hostId, event.eventId, event.sessionId, event.turnId ?? null, event.projectId ?? null, event.kind, event.occurredAt, event.receivedAt, event.sourceRef,
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
  private toRecord(row: Record<string, unknown>): EventRecord {
    return {
      eventId: String(row['event_id']), hostId: String(row['host_id']), sessionId: String(row['session_id']),
      turnId: row['turn_id'] === null ? null : String(row['turn_id']),
      projectId: row['project_id'] === null ? null : String(row['project_id']),
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
