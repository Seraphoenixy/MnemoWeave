import type { DatabaseSync } from 'node:sqlite';
import { SyncChangeInput, SyncChangeRecord, SyncEntry } from '../../../core/contracts/src/index.ts';
import type { SyncChangeRecordValue, SyncChangeRequest, SyncEntryDraftValue } from '../../../core/contracts/src/index.ts';
import type {
  InboxState, OutboxState, SyncInboxRecord, SyncLedgerPort, SyncOutboxRecord, SyncStateRecord,
} from '../../../core/application/src/sync.ts';

/**
 * Local sync ledgers (schema v11).
 *
 * Outbox: a change the user confirmed locally and that still needs the remote to
 * assign a version. Inbox: a received remote change that still needs applying to
 * the local Mnemon; the scope cursor only advances over applied inbox rows.
 */

export type { InboxState, OutboxState, SyncInboxRecord, SyncOutboxRecord, SyncStateRecord };
export type SyncStateRow = SyncStateRecord;
export type SyncOutboxRow = SyncOutboxRecord;
export type SyncInboxRow = SyncInboxRecord;

type Transaction = <T>(operation: () => T) => T;

interface OutboxDbRow {
  change_id: string; scope: string; entry_id: string; base_version: number; operation: string;
  entry_json: string; state: string; attempts: number; last_error: string | null; created_at: string; updated_at: string;
}

interface InboxDbRow {
  scope: string; seq: number; change_id: string; entry_id: string; version: number; operation: string;
  entry_json: string; state: string; error: string | null;
}

export class SqliteSyncLedger implements SyncLedgerPort {
  private readonly db: DatabaseSync;
  private readonly transaction: Transaction;

  constructor(db: DatabaseSync, transaction: Transaction) {
    this.db = db;
    this.transaction = transaction;
  }

  state(scope: string): SyncStateRow {
    const row = this.db.prepare('SELECT scope, cursor, last_pull_at, last_error FROM sync_state WHERE scope = ?').get(scope) as
      { scope: string; cursor: number; last_pull_at: string | null; last_error: string | null } | undefined;
    return row ? { scope: row.scope, cursor: row.cursor, lastPullAt: row.last_pull_at, lastError: row.last_error } : { scope, cursor: 0, lastPullAt: null, lastError: null };
  }

  cursor(scope: string): number {
    return this.state(scope).cursor;
  }

  /** Cursors only move forward; a stale worker must not rewind a scope. */
  setCursor(scope: string, cursor: number, at: string): void {
    if (!Number.isInteger(cursor) || cursor < 0) throw new Error('Cursor must be a non-negative integer');
    this.transaction(() => {
      const current = this.cursor(scope);
      if (cursor <= current) return;
      this.db.prepare(`
        INSERT INTO sync_state(scope, cursor, last_pull_at, last_error) VALUES(?, ?, ?, NULL)
        ON CONFLICT(scope) DO UPDATE SET cursor = excluded.cursor, last_pull_at = excluded.last_pull_at
      `).run(scope, cursor, at);
    });
  }

  /**
   * A snapshot replaced the change stream for this scope: drop the inbox rows it
   * already covers, clear the previous error, and move the cursor to its cut point.
   */
  resetScope(scope: string, cursor: number, at: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM sync_inbox WHERE scope = ? AND seq <= ?').run(scope, cursor);
      // Inlined instead of calling setCursor: a caller's transaction wrapper may not be reentrant.
      if (cursor > this.cursor(scope)) {
        this.db.prepare(`
          INSERT INTO sync_state(scope, cursor, last_pull_at, last_error) VALUES(?, ?, ?, NULL)
          ON CONFLICT(scope) DO UPDATE SET cursor = excluded.cursor, last_pull_at = excluded.last_pull_at
        `).run(scope, cursor, at);
      }
      this.db.prepare('UPDATE sync_state SET last_error = NULL WHERE scope = ?').run(scope);
    });
  }

  setError(scope: string, error: string | null, at: string): void {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO sync_state(scope, cursor, last_pull_at, last_error) VALUES(?, 0, NULL, ?)
        ON CONFLICT(scope) DO UPDATE SET last_error = excluded.last_error, last_pull_at = ?
      `).run(scope, error, at);
    });
  }

  enqueue(request: SyncChangeRequest, at: string): void {
    const change = SyncChangeInput.parse(request);
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO sync_outbox(change_id, scope, entry_id, base_version, operation, entry_json, state, attempts, last_error, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)
      `).run(change.changeId, change.entry.scope, change.entry.entryId, change.baseVersion, change.operation, JSON.stringify(change.entry), at, at);
    });
  }

  outbox(state?: OutboxState, limit = 100): SyncOutboxRow[] {
    const rows = (state
      ? this.db.prepare('SELECT * FROM sync_outbox WHERE state = ? ORDER BY created_at ASC LIMIT ?').all(state, limit)
      : this.db.prepare('SELECT * FROM sync_outbox ORDER BY created_at ASC LIMIT ?').all(limit)) as unknown as OutboxDbRow[];
    return rows.map(row => this.outboxRow(row));
  }

  /**
   * Unconfirmed work for one entry, ignoring page limits. Confirmed history is kept in the
   * same table, so a bounded newest-N scan would silently stop seeing an entry's own row
   * once enough history accumulated, both for duplicate suppression and for result lookup.
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

  private outboxRow(row: OutboxDbRow): SyncOutboxRow {
    return {
      changeId: row.change_id,
      scope: row.scope,
      entryId: row.entry_id,
      baseVersion: row.base_version,
      operation: row.operation as SyncChangeRequest['operation'],
      entry: JSON.parse(row.entry_json) as SyncEntryDraftValue,
      state: row.state as OutboxState,
      attempts: row.attempts,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  markOutbox(changeId: string, state: OutboxState, error: string | null, at: string): void {
    this.transaction(() => {
      this.db.prepare('UPDATE sync_outbox SET state = ?, last_error = ?, attempts = attempts + 1, updated_at = ? WHERE change_id = ?').run(state, error, at, changeId);
    });
  }

  /** Returns false when the scope/seq pair was already received (replayed page). */
  receive(record: SyncChangeRecordValue, at: string): boolean {
    const change = SyncChangeRecord.parse(record);
    return this.transaction(() => {
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO sync_inbox(scope, seq, change_id, entry_id, version, operation, entry_json, state, error, received_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, 'received', NULL, ?)
      `).run(change.scope, change.seq, change.changeId, change.entryId, change.version, change.operation, JSON.stringify(change.entry), at);
      return Number(result.changes) > 0;
    });
  }

  inbox(scope: string, limit = 100): SyncInboxRow[] {
    const rows = this.db.prepare(`
      SELECT scope, seq, change_id, entry_id, version, operation, entry_json, state, error
      FROM sync_inbox WHERE scope = ? AND state <> 'applied' ORDER BY seq ASC LIMIT ?
    `).all(scope, limit) as unknown as InboxDbRow[];
    return rows.map(row => this.inboxRow(row));
  }

  /** One inbox row by scope/seq; applied rows stay readable so a pending check is accurate. */
  inboxEntry(scope: string, seq: number): SyncInboxRow | null {
    const row = this.db.prepare(`
      SELECT scope, seq, change_id, entry_id, version, operation, entry_json, state, error
      FROM sync_inbox WHERE scope = ? AND seq = ?
    `).get(scope, seq) as unknown as InboxDbRow | undefined;
    return row ? this.inboxRow(row) : null;
  }

  /** One inbox row by change id; applied rows stay readable so a confirmation can be read back. */
  inboxChange(changeId: string): SyncInboxRow | null {
    const row = this.db.prepare(`
      SELECT scope, seq, change_id, entry_id, version, operation, entry_json, state, error
      FROM sync_inbox WHERE change_id = ? ORDER BY seq ASC LIMIT 1
    `).get(changeId) as unknown as InboxDbRow | undefined;
    return row ? this.inboxRow(row) : null;
  }

  private inboxRow(row: InboxDbRow): SyncInboxRow {
    return {
      scope: row.scope,
      seq: row.seq,
      changeId: row.change_id,
      entryId: row.entry_id,
      version: row.version,
      operation: row.operation as SyncChangeRequest['operation'],
      entry: SyncEntry.parse(JSON.parse(row.entry_json)),
      state: row.state as InboxState,
      error: row.error,
    };
  }

  markInbox(scope: string, seq: number, state: InboxState, error: string | null = null): void {
    this.transaction(() => {
      this.db.prepare('UPDATE sync_inbox SET state = ?, error = ? WHERE scope = ? AND seq = ?').run(state, error, scope, seq);
    });
  }

  /** Applied flags for cursor computation; rows are returned in sequence order. */
  progress(scope: string, fromSeq: number, limit = 200): { seq: number; applied: boolean }[] {
    const rows = this.db.prepare(`
      SELECT seq, state FROM sync_inbox WHERE scope = ? AND seq > ? ORDER BY seq ASC LIMIT ?
    `).all(scope, fromSeq, limit) as unknown as { seq: number; state: string }[];
    return rows.map((row) => ({ seq: row.seq, applied: row.state === 'applied' }));
  }
}
