import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { MnemoWeaveError } from '../../../core/contracts/src/index.ts';
import type { HostEventRecord } from '../../../core/contracts/src/index.ts';

type Transaction = <T>(operation: () => T) => T;

/** How long a turn no-retention marker and a closed-session marker are kept. */
const SESSION_RETENTION_MS = 7 * 86_400_000;

/**
 * Session and turn bookkeeping.
 *
 * The local store keeps only what an operation needs to be attributable and repeatable: which
 * session exists, whether it is closed, which turns the user marked "do not retain", the user's
 * own turn text as review evidence, and the evidence a write task cites. It does not keep a
 * session transcript — assistant output, tool output and attachments stay with the host, which
 * supplies a task's working context when it asks for a write.
 */
export class SqliteTurnStore {
  private readonly db: DatabaseSync;
  private readonly transaction: Transaction;

  constructor(db: DatabaseSync, transaction: Transaction) {
    this.db = db;
    this.transaction = transaction;
  }

  /** Record that a session exists; the row is created once and only its close flag changes. */
  observe(hostId: string, event: HostEventRecord): { status: 'stored' | 'replayed' | 'skipped'; eventId: string } {
    const eventHash = createHash('sha256').update(JSON.stringify({ sessionId: event.sessionId, kind: event.kind, payload: event.payload })).digest('hex');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT event_hash FROM turn_event_ids WHERE host_id=? AND event_id=?').get(hostId, event.eventId) as { event_hash: string } | undefined;
      if (existing) {
        if (String(existing.event_hash) !== eventHash) throw new MnemoWeaveError('IDEMPOTENCY_CONFLICT');
        return { status: 'replayed' as const, eventId: event.eventId };
      }
      const closed = this.db.prepare('SELECT closed FROM turn_sessions WHERE host_id=? AND session_id=?').get(hostId, event.sessionId) as { closed: number } | undefined;
      if (closed?.closed === 1) throw new MnemoWeaveError('INVALID_STATE');
      this.db.prepare('INSERT INTO turn_event_ids(host_id, event_id, event_hash, created_ms) VALUES(?,?,?,?)')
        .run(hostId, event.eventId, eventHash, Date.now());
      this.db.prepare(`INSERT INTO turn_sessions(host_id, session_id, closed, updated_ms) VALUES(?,?,0,?)
        ON CONFLICT(host_id, session_id) DO UPDATE SET updated_ms=excluded.updated_ms`).run(hostId, event.sessionId, Date.now());
      // A turn the user marked "do not retain" is remembered per turn, not per session: it only
      // covers that turn, and a later turn in the same session is retained normally.
      if (event.payload.noRetention === true && event.turnId !== undefined) {
        this.db.prepare('INSERT OR IGNORE INTO turn_no_retention(host_id, session_id, turn_id, created_ms) VALUES(?,?,?,?)')
          .run(hostId, event.sessionId, event.turnId, Date.now());
      }
      // The user's own turn text is the evidence an idle review and a write task read back. It is
      // kept per turn, replaced by the retention sweep with the same schedule as the rest of the
      // turn bookkeeping; nothing else from the session is copied here.
      if (event.kind === 'message.user' && event.payload.text !== undefined && event.turnId !== undefined) {
        this.db.prepare(`INSERT INTO turn_messages(host_id, session_id, turn_id, event_id, text, no_retention, created_ms)
          VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(host_id, event_id) DO NOTHING`).run(
          hostId, event.sessionId, event.turnId, event.eventId, event.payload.text,
          event.payload.noRetention === true ? 1 : 0, Date.now(),
        );
      }
      if (event.kind === 'session.ended') this.closeSession(hostId, event.sessionId);
      return { status: 'stored' as const, eventId: event.eventId };
    });
  }

  /**
   * The user turns one session recorded, oldest first.
   *
   * This is what an idle-review scan and a write task read as session evidence. A turn marked
   * "do not retain" is included so the scan can count and skip it; the selector is what refuses
   * to score or cite it.
   */
  messages(hostId: string, sessionId: string): Array<{ eventId: string; turnId: string; text: string; noRetention: boolean }> {
    return (this.db.prepare(`SELECT event_id, turn_id, text, no_retention FROM turn_messages
      WHERE host_id=? AND session_id=? ORDER BY created_ms ASC, event_id ASC`).all(hostId, sessionId) as Array<Record<string, unknown>>)
      .map(row => ({
        eventId: String(row['event_id']), turnId: String(row['turn_id']),
        text: String(row['text']), noRetention: Number(row['no_retention']) === 1,
      }));
  }

  closeSession(hostId: string, sessionId: string): void {
    this.transaction(() => {
      this.db.prepare(`INSERT INTO turn_sessions(host_id, session_id, closed, updated_ms) VALUES(?,?,1,?)
        ON CONFLICT(host_id, session_id) DO UPDATE SET closed=1, updated_ms=excluded.updated_ms`).run(hostId, sessionId, Date.now());
    });
  }

  isClosed(hostId: string, sessionId: string): boolean {
    const row = this.db.prepare('SELECT closed FROM turn_sessions WHERE host_id=? AND session_id=?').get(hostId, sessionId) as { closed: number } | undefined;
    return row?.closed === 1;
  }

  /**
   * Has the user marked this turn as not to be retained?
   *
   * The caller must present the exact host, session and turn. A turn id that does not match any
   * marker is retained; the check never falls back to "the session has one marker somewhere".
   */
  isNoRetention(hostId: string, sessionId: string, turnId: string | undefined): boolean {
    if (turnId === undefined) return false;
    return this.db.prepare('SELECT 1 FROM turn_no_retention WHERE host_id=? AND session_id=? AND turn_id=?').get(hostId, sessionId, turnId) !== undefined;
  }

  /** The newest completed turn this host recorded for a session, if any. */
  lastTurn(hostId: string, sessionId: string): number | null {
    const row = this.db.prepare(`SELECT turn_id FROM session_events WHERE host_id=? AND session_id=? AND turn_id IS NOT NULL
      ORDER BY CAST(turn_id AS INTEGER) DESC, received_at DESC LIMIT 1`).get(hostId, sessionId) as { turn_id: string } | undefined;
    if (row === undefined) return null;
    const parsed = Number(row.turn_id);
    return Number.isInteger(parsed) ? parsed : null;
  }

  /** Retention housekeeping: markers and dedup hashes older than the window are dropped. */
  tick(): void {
    const cutoff = Date.now() - SESSION_RETENTION_MS;
    this.transaction(() => {
      this.db.prepare('DELETE FROM turn_event_ids WHERE created_ms<?').run(cutoff);
      this.db.prepare('DELETE FROM turn_no_retention WHERE created_ms<?').run(cutoff);
    // The turn text goes with the rest of the turn bookkeeping: it is evidence, not a transcript.
    this.db.prepare('DELETE FROM turn_messages WHERE created_ms<?').run(cutoff);
    });
  }
}

/** A stable id for one write-task action, so the same plan is replayable. */
export function writeTaskKey(hostId: string, taskId: string, index: number): string {
  return `${hostId}:${taskId}:${index}`;
}

export function newTaskId(): string {
  return randomUUID();
}
