import type { DatabaseSync } from 'node:sqlite';
import { SyncChangeInput, SyncChangeRecord, SyncEntry, streamOf } from '../../../core/contracts/src/index.ts';
import type { SyncChangeRecordValue, SyncChangeRequest, SyncEntryDraftValue } from '../../../core/contracts/src/index.ts';
import type {
  InboxState, OutboxState, SyncInboxRecord, SyncLedgerPort, SyncOutboxRecord, SyncStateRecord,
} from '../../../core/application/src/sync.ts';

/**
 * Local sync ledgers.
 *
 * Outbox: a change the user confirmed locally and that still needs the remote to assign a
 * version. Inbox: a received remote change that still needs applying to the local Mnemon. The
 * stream cursor only advances over applied inbox rows. Both ledgers are keyed by stream, which is
 * derived from the entry — never supplied by the caller.
 */

export type { InboxState, OutboxState, SyncInboxRecord, SyncOutboxRecord, SyncStateRecord };
export type SyncStateRow = SyncStateRecord;
export type SyncOutboxRow = SyncOutboxRecord;
export type SyncInboxRow = SyncInboxRecord;

type Transaction = <T>(operation: () => T) => T;

interface OutboxDbRow {
  change_id: string; stream: string; entry_id: string; base_version: number; operation: string;
  entry_json: string; state: string; attempts: number; last_error: string | null; created_at: string; updated_at: string;
}

interface InboxDbRow {
  stream: string; seq: number; change_id: string; entry_id: string; version: number; operation: string;
  entry_json: string; state: string; error: string | null;
}

export class SqliteSyncLedger implements SyncLedgerPort {
  private readonly db: DatabaseSync;
  private readonly transaction: Transaction;

  constructor(db: DatabaseSync, transaction: Transaction) {
    this.db = db;
    this.transaction = transaction;
  }

  state(stream: string): SyncStateRow {
    const row = this.db.prepare('SELECT stream, cursor, last_pull_at, last_error FROM sync_state WHERE stream = ?').get(stream) as
      { stream: string; cursor: number; last_pull_at: string | null; last_error: string | null } | undefined;
    return row
      ? { stream: row.stream, cursor: row.cursor, lastPullAt: row.last_pull_at, lastError: row.last_error }
      : { stream, cursor: 0, lastPullAt: null, lastError: null };
  }

  cursor(stream: string): number {
    return this.state(stream).cursor;
  }

  /** Cursors only move forward; a stale worker must not rewind a stream. */
  setCursor(stream: string, cursor: number, at: string): void {
    if (!Number.isInteger(cursor) || cursor < 0) throw new Error('Cursor must be a non-negative integer');
    this.transaction(() => {
      const current = this.cursor(stream);
      if (cursor <= current) return;
      this.db.prepare(`
        INSERT INTO sync_state(stream, cursor, last_pull_at, last_error) VALUES(?, ?, ?, NULL)
        ON CONFLICT(stream) DO UPDATE SET cursor = excluded.cursor, last_pull_at = excluded.last_pull_at
      `).run(stream, cursor, at);
    });
  }

  /**
   * A snapshot replaced the change stream for this stream: drop the inbox rows it already covers,
   * clear the previous error, and move the cursor to its cut point.
   */
  resetScope(stream: string, cursor: number, at: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM sync_inbox WHERE stream = ? AND seq <= ?').run(stream, cursor);
      if (cursor > this.cursor(stream)) {
        this.db.prepare(`
          INSERT INTO sync_state(stream, cursor, last_pull_at, last_error) VALUES(?, ?, ?, NULL)
          ON CONFLICT(stream) DO UPDATE SET cursor = excluded.cursor, last_pull_at = excluded.last_pull_at
        `).run(stream, cursor, at);
      }
      this.db.prepare('UPDATE sync_state SET last_error = NULL WHERE stream = ?').run(stream);
    });
  }

  setError(stream: string, error: string | null, at: string): void {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO sync_state(stream, cursor, last_pull_at, last_error) VALUES(?, 0, NULL, ?)
        ON CONFLICT(stream) DO UPDATE SET last_error = excluded.last_error, last_pull_at = ?
      `).run(stream, error, at);
    });
  }

  enqueue(request: SyncChangeRequest, at: string): void {
    const change = SyncChangeInput.parse(request);
    // The stream is derived, so a hand-built change cannot be filed under a stream of its choice.
    const stream = streamOf(change.entry.kind, change.entry.payload);
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO sync_outbox(change_id, stream, entry_id, base_version, operation, entry_json, state, attempts, last_error, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)
      `).run(change.changeId, stream, change.entry.entryId, change.baseVersion, change.operation, JSON.stringify(change.entry), at, at);
    });
  }

  outbox(state?: OutboxState, limit = 100): SyncOutboxRow[] {
    const rows = (state
      ? this.db.prepare('SELECT * FROM sync_outbox WHERE state = ? ORDER BY created_at ASC LIMIT ?').all(state, limit)
      : this.db.prepare('SELECT * FROM sync_outbox ORDER BY created_at ASC LIMIT ?').all(limit)) as unknown as OutboxDbRow[];
    return rows.map(row => this.outboxRow(row));
  }

  /**
   * Unconfirmed work for one entry, ignoring page limits. Confirmed history is kept in the same
   * table, so a bounded newest-N scan would silently stop seeing an entry's own row once enough
   * history accumulated.
   */
  outboxForEntry(entryId: string): SyncOutboxRow | null {
    const row = this.db.prepare(`
      SELECT * FROM sync_outbox WHERE entry_id = ? AND state IN ('pending', 'unknown')
      ORDER BY created_at DESC LIMIT 1
    `).get(entryId) as unknown as OutboxDbRow | undefined;
    return row ? this.outboxRow(row) : null;
  }

  outboxChange(changeId: string): SyncOutboxRow | null {
    const row = this.db.prepare('SELECT * FROM sync_outbox WHERE change_id = ?').get(changeId) as unknown as OutboxDbRow | undefined;
    return row ? this.outboxRow(row) : null;
  }

  markOutbox(changeId: string, state: OutboxState, error: string | null, at: string): void {
    this.transaction(() => {
      this.db.prepare('UPDATE sync_outbox SET state = ?, last_error = ?, attempts = attempts + 1, updated_at = ? WHERE change_id = ?')
        .run(state, error, at, changeId);
    });
  }

  /** A received record is stored once; a replayed page over the same sequence is a no-op. */
  receive(change: SyncChangeRecordValue, at: string): boolean {
    const parsed = SyncChangeRecord.parse(change);
    return this.transaction(() => {
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO sync_inbox(stream, seq, change_id, entry_id, version, operation, entry_json, state, error, received_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, 'received', NULL, ?)
      `).run(parsed.stream, parsed.seq, parsed.changeId, parsed.entryId, parsed.version, parsed.operation, JSON.stringify(parsed.entry), at);
      return result.changes === 1;
    });
  }

  /** Inbox rows not yet applied, in sequence order; an applied row is no longer pending. */
  inbox(stream: string, limit = 100): SyncInboxRow[] {
    return this.db.prepare(`
      SELECT stream, seq, change_id, entry_id, version, operation, entry_json, state, error
      FROM sync_inbox WHERE stream = ? AND state <> 'applied' ORDER BY seq ASC LIMIT ?
    `).all(stream, limit).map(row => this.inboxRow(row as unknown as InboxDbRow));
  }

  /** One inbox row by stream/seq; applied rows stay readable so a pending check is accurate. */
  inboxEntry(stream: string, seq: number): SyncInboxRow | null {
    const row = this.db.prepare(`
      SELECT stream, seq, change_id, entry_id, version, operation, entry_json, state, error
      FROM sync_inbox WHERE stream = ? AND seq = ?
    `).get(stream, seq) as unknown as InboxDbRow | undefined;
    return row ? this.inboxRow(row) : null;
  }

  inboxChange(changeId: string): SyncInboxRow | null {
    const row = this.db.prepare(`
      SELECT stream, seq, change_id, entry_id, version, operation, entry_json, state, error
      FROM sync_inbox WHERE change_id = ? ORDER BY seq ASC LIMIT 1
    `).get(changeId) as unknown as InboxDbRow | undefined;
    return row ? this.inboxRow(row) : null;
  }

  markInbox(stream: string, seq: number, state: InboxState, error: string | null = null): void {
    this.transaction(() => {
      this.db.prepare('UPDATE sync_inbox SET state = ?, error = ? WHERE stream = ? AND seq = ?').run(state, error, stream, seq);
    });
  }

  progress(stream: string, fromSeq: number, limit = 200): { seq: number; applied: boolean }[] {
    return this.db.prepare(`
      SELECT seq, state FROM sync_inbox WHERE stream = ? AND seq > ? ORDER BY seq ASC LIMIT ?
    `).all(stream, fromSeq, limit).map(row => ({ seq: Number(row['seq']), applied: row['state'] === 'applied' }));
  }

  private outboxRow(row: OutboxDbRow): SyncOutboxRow {
    return {
      changeId: row.change_id, stream: row.stream, entryId: row.entry_id,
      baseVersion: row.base_version, operation: row.operation as SyncChangeRequest['operation'],
      entry: JSON.parse(row.entry_json) as SyncEntryDraftValue,
      state: row.state as OutboxState, attempts: row.attempts, lastError: row.last_error,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  private inboxRow(row: InboxDbRow): SyncInboxRow {
    return {
      stream: row.stream, seq: row.seq, changeId: row.change_id, entryId: row.entry_id,
      version: row.version, operation: row.operation as SyncChangeRequest['operation'],
      entry: SyncEntry.parse(JSON.parse(row.entry_json)),
      state: row.state as InboxState, error: row.error,
    };
  }
}
