import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { MnemoWeaveError } from '../../../core/contracts/src/index.ts';
import type { WorkspaceRecordValue } from '../../../core/contracts/src/index.ts';

type Transaction = <T>(operation: () => T) => T;

/**
 * Workspace registry, local root bindings and session bindings.
 *
 * The workspace id is a stable UUID shared by every device; the directory is per device. Nothing
 * derives an id from a path, a repository URL, a branch or a session id, because two devices must
 * be able to agree on the id without agreeing on their local filesystem layout.
 */

export interface WorkspaceRow extends WorkspaceRecordValue {
  createdAt: string;
}

export class SqliteWorkspaceStore {
  private readonly db: DatabaseSync;
  private readonly transaction: Transaction;

  constructor(db: DatabaseSync, transaction: Transaction) {
    this.db = db;
    this.transaction = transaction;
  }

  /** Register a workspace. The same id with the same name is idempotent; a rename is refused. */
  register(workspaceId: string, name: string): WorkspaceRow {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 200) throw new MnemoWeaveError('INVALID_INPUT');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT workspace_id, name, created_at FROM workspaces WHERE workspace_id=?').get(workspaceId) as
        { workspace_id: string; name: string; created_at: string } | undefined;
      if (existing) {
        if (String(existing.name) !== trimmed) throw new MnemoWeaveError('INVALID_STATE');
        return { workspaceId: String(existing.workspace_id), name: String(existing.name), createdAt: String(existing.created_at) };
      }
      const createdAt = new Date().toISOString();
      this.db.prepare('INSERT INTO workspaces(workspace_id, name, created_at) VALUES(?,?,?)').run(workspaceId, trimmed, createdAt);
      return { workspaceId, name: trimmed, createdAt };
    });
  }

  has(workspaceId: string): boolean {
    return this.db.prepare('SELECT 1 FROM workspaces WHERE workspace_id=?').get(workspaceId) !== undefined;
  }

  get(workspaceId: string): WorkspaceRow | null {
    const row = this.db.prepare('SELECT workspace_id, name, created_at FROM workspaces WHERE workspace_id=?').get(workspaceId) as
      { workspace_id: string; name: string; created_at: string } | undefined;
    return row === undefined ? null : { workspaceId: String(row.workspace_id), name: String(row.name), createdAt: String(row.created_at) };
  }

  list(): WorkspaceRow[] {
    return this.db.prepare('SELECT workspace_id, name, created_at FROM workspaces ORDER BY name ASC, workspace_id ASC').all().map(row => ({
      workspaceId: String(row['workspace_id']), name: String(row['name']), createdAt: String(row['created_at']),
    }));
  }

  /**
   * Bind one local directory to a workspace.
   *
   * The path is resolved to a real directory first, so `..` segments and symlinks cannot make two
   * different strings name the same place. Bindings are additions: an existing directory never
   * moves to another workspace, and the same pair is idempotent.
   */
  bind(workspaceId: string, rootPath: string): void {
    if (!this.has(workspaceId)) throw new MnemoWeaveError('NOT_FOUND');
    let resolved: string;
    try {
      resolved = realpathSync(rootPath);
      if (!statSync(resolved).isDirectory()) throw new MnemoWeaveError('INVALID_INPUT');
    } catch (error) {
      if (error instanceof MnemoWeaveError) throw error;
      throw new MnemoWeaveError('INVALID_INPUT');
    }
    this.transaction(() => {
      const owner = this.db.prepare('SELECT workspace_id FROM workspace_bindings WHERE root_path=?').get(resolved) as { workspace_id: string } | undefined;
      if (owner !== undefined && String(owner.workspace_id) !== workspaceId) throw new MnemoWeaveError('INVALID_STATE');
      this.db.prepare('INSERT OR IGNORE INTO workspace_bindings(workspace_id, root_path, created_at) VALUES(?,?,?)')
        .run(workspaceId, resolved, new Date().toISOString());
    });
  }

  /** The workspace bound to one exact directory, if any. */
  workspaceForRoot(rootPath: string): string | null {
    let resolved: string;
    try { resolved = realpathSync(rootPath); } catch { return null; }
    const row = this.db.prepare('SELECT workspace_id FROM workspace_bindings WHERE root_path=?').get(resolved) as { workspace_id: string } | undefined;
    return row === undefined ? null : String(row.workspace_id);
  }

  bindingCount(workspaceId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM workspace_bindings WHERE workspace_id=?').get(workspaceId) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /**
   * Record the workspace one host session works in.
   *
   * A session that already has a binding cannot switch it: a changed value mid-session would move
   * every later archive read and write to a different access boundary. A new session gets the new
   * value on its next start instead.
   */
  bindSession(hostId: string, sessionId: string, workspaceId: string | null): { workspaceId: string | null; boundAt: string } {
    if (workspaceId !== null && !this.has(workspaceId)) throw new MnemoWeaveError('INVALID_INPUT');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT workspace_id, bound_at FROM session_workspaces WHERE host_id=? AND session_id=?').get(hostId, sessionId) as
        { workspace_id: string | null; bound_at: string } | undefined;
      const current = existing === undefined ? undefined : existing.workspace_id === null ? null : String(existing.workspace_id);
      if (existing !== undefined) {
        if (current === workspaceId) return { workspaceId: current, boundAt: String(existing.bound_at) };
        // An empty payload against an empty binding is still "no binding"; anything else is a
        // change of workspace, which this session cannot make.
        if (current === null && workspaceId === null) return { workspaceId: null, boundAt: String(existing.bound_at) };
        throw new MnemoWeaveError('INVALID_STATE');
      }
      const boundAt = new Date().toISOString();
      this.db.prepare('INSERT INTO session_workspaces(host_id, session_id, workspace_id, bound_at) VALUES(?,?,?,?)')
        .run(hostId, sessionId, workspaceId, boundAt);
      return { workspaceId, boundAt };
    });
  }

  sessionWorkspace(hostId: string, sessionId: string): string | null {
    const row = this.db.prepare('SELECT workspace_id FROM session_workspaces WHERE host_id=? AND session_id=?').get(hostId, sessionId) as
      { workspace_id: string | null } | undefined;
    return row === undefined || row.workspace_id === null ? null : String(row.workspace_id);
  }

  /** Workspaces that have an archive, used to bound an authorized listing without a selector. */
  archiveWorkspaces(): string[] {
    return this.db.prepare('SELECT DISTINCT workspace_id FROM project_archives ORDER BY workspace_id').all().map(row => String(row['workspace_id']));
  }

  /**
   * Whether a host may reach a workspace: it either has a root binding on this machine or a
   * session that is currently bound to it. Access is granted by a local claim, never inferred
   * from a workspace name.
   */
  accessibleTo(workspaceId: string, hostId: string): boolean {
    if (this.bindingCount(workspaceId) > 0) return true;
    const row = this.db.prepare('SELECT 1 FROM session_workspaces WHERE host_id=? AND workspace_id=?').get(hostId, workspaceId);
    return row !== undefined;
  }
}

/** One durable receipt row; the key is (host, task, index) and is never reused for another plan. */
export interface WriteTaskReceiptRow {
  hostId: string;
  taskId: string;
  index: number;
  kind: string;
  action: string;
  requestHash: string;
  status: string;
  memoryId: string | null;
  entryVersion: number | null;
  entryId: string | null;
  candidateId: string | null;
  errorCode: string | null;
  updatedAt: string;
}

export class SqliteWriteTaskStore {
  private readonly db: DatabaseSync;
  private readonly transaction: Transaction;

  constructor(db: DatabaseSync, transaction: Transaction) {
    this.db = db;
    this.transaction = transaction;
  }

  /** The stored plan for one action, so a replay can tell "same plan" from "different payload". */
  receipt(hostId: string, taskId: string, index: number): WriteTaskReceiptRow | null {
    const row = this.db.prepare(`SELECT host_id, task_id, action_index, kind, action, request_hash, status,
      memory_id, entry_version, entry_id, candidate_id, error_code, updated_at
      FROM write_task_receipts WHERE host_id=? AND task_id=? AND action_index=?`).get(hostId, taskId, index);
    return row === undefined ? null : this.toRow(row);
  }

  private toRow(row: Record<string, unknown>): WriteTaskReceiptRow {
    return {
      hostId: String(row['host_id']), taskId: String(row['task_id']), index: Number(row['action_index']),
      kind: String(row['kind']), action: String(row['action']), requestHash: String(row['request_hash']),
      status: String(row['status']),
      memoryId: row['memory_id'] === null ? null : String(row['memory_id']),
      entryVersion: row['entry_version'] === null ? null : Number(row['entry_version']),
      entryId: row['entry_id'] === null ? null : String(row['entry_id']),
      candidateId: row['candidate_id'] === null ? null : String(row['candidate_id']),
      errorCode: row['error_code'] === null ? null : String(row['error_code']),
      updatedAt: String(row['updated_at']),
    };
  }

  /**
   * Claim one action before executing it.
   *
   * Returns the existing row when the same key is replayed with the same payload; a different
   * payload under the same key is an idempotency conflict, not a second write. The claim is
   * written in its own transaction so a crash leaves "unknown" rather than "nothing happened".
   */
  claim(input: {
    hostId: string; taskId: string; index: number; kind: string; action: string; requestHash: string;
  }): { existing: WriteTaskReceiptRow | null } {
    return this.transaction(() => {
      const existing = this.receipt(input.hostId, input.taskId, input.index);
      if (existing) {
        if (existing.requestHash !== input.requestHash) throw new MnemoWeaveError('IDEMPOTENCY_CONFLICT');
        return { existing };
      }
      this.db.prepare(`INSERT INTO write_task_receipts(host_id, task_id, action_index, kind, action, request_hash, status,
        memory_id, entry_version, entry_id, candidate_id, error_code, updated_at)
        VALUES(?,?,?,?,?,?, 'unknown', NULL, NULL, NULL, NULL, NULL, ?)`)
        .run(input.hostId, input.taskId, input.index, input.kind, input.action, input.requestHash, new Date().toISOString());
      return { existing: null };
    });
  }

  settle(hostId: string, taskId: string, index: number, result: {
    status: string;
    memoryId?: string | null;
    entryVersion?: number | null;
    entryId?: string | null;
    candidateId?: string | null;
    errorCode?: string | null;
  }): WriteTaskReceiptRow {
    this.transaction(() => {
      this.db.prepare(`UPDATE write_task_receipts SET status=?, memory_id=?, entry_version=?, entry_id=?, candidate_id=?, error_code=?, updated_at=?
        WHERE host_id=? AND task_id=? AND action_index=?`)
        .run(
          result.status, result.memoryId ?? null, result.entryVersion ?? null, result.entryId ?? null,
          result.candidateId ?? null, result.errorCode ?? null, new Date().toISOString(),
          hostId, taskId, index,
        );
    });
    return this.receipt(hostId, taskId, index)!;
  }

  /** Every action of one task, ordered, so a host can show the plan and its per-item receipts. */
  taskReceipts(hostId: string, taskId: string): WriteTaskReceiptRow[] {
    return this.db.prepare(`SELECT host_id, task_id, action_index, kind, action, request_hash, status,
      memory_id, entry_version, entry_id, candidate_id, error_code, updated_at
      FROM write_task_receipts WHERE host_id=? AND task_id=? ORDER BY action_index ASC`).all(hostId, taskId).map(row => this.toRow(row));
  }
}

/** One immutable distillation draft; the source version is fixed at creation. */
export interface DistillationRow {
  draftId: string;
  hostId: string;
  workspaceId: string;
  entryId: string;
  entryVersion: number;
  sourceContentHash: string;
  content: string;
  category: string | null;
  importance: number | null;
  tags: string[] | null;
  entities: string[] | null;
  reason: string;
  assessment: string;
  contentHash: string;
  createdAt: string;
  taskId: string | null;
}

export class SqliteDistillationStore {
  private readonly db: DatabaseSync;
  private readonly transaction: Transaction;

  constructor(db: DatabaseSync, transaction: Transaction) {
    this.db = db;
    this.transaction = transaction;
  }

  private toRow(row: Record<string, unknown>): DistillationRow {
    return {
      draftId: String(row['draft_id']), hostId: String(row['host_id']),
      workspaceId: String(row['workspace_id']), entryId: String(row['entry_id']),
      entryVersion: Number(row['entry_version']), sourceContentHash: String(row['source_content_hash']),
      content: String(row['content']),
      category: row['category'] === null ? null : String(row['category']),
      importance: row['importance'] === null ? null : Number(row['importance']),
      tags: row['tags_json'] === null ? null : JSON.parse(String(row['tags_json'])) as string[],
      entities: row['entities_json'] === null ? null : JSON.parse(String(row['entities_json'])) as string[],
      reason: String(row['reason']), assessment: String(row['assessment']),
      contentHash: String(row['content_hash']), createdAt: String(row['created_at']),
      taskId: row['task_id'] === null ? null : String(row['task_id']),
    };
  }

  create(draft: Omit<DistillationRow, 'draftId' | 'createdAt' | 'taskId'>): DistillationRow {
    const draftId = randomUUID();
    const createdAt = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare(`INSERT INTO archive_distillations(draft_id, host_id, workspace_id, entry_id, entry_version,
        source_content_hash, content, category, importance, tags_json, entities_json, reason,
        assessment, content_hash, created_at, task_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`)
        .run(draftId, draft.hostId, draft.workspaceId, draft.entryId, draft.entryVersion, draft.sourceContentHash,
          draft.content, draft.category, draft.importance,
          draft.tags === null ? null : JSON.stringify(draft.tags),
          draft.entities === null ? null : JSON.stringify(draft.entities),
          draft.reason, draft.assessment, draft.contentHash, createdAt);
    });
    return this.get(draftId)!;
  }

  get(draftId: string): DistillationRow | null {
    const row = this.db.prepare('SELECT * FROM archive_distillations WHERE draft_id=?').get(draftId);
    return row === undefined ? null : this.toRow(row);
  }

  /** Bind the accepted write task once; a second create for the same draft is refused. */
  attachTask(draftId: string, taskId: string): void {
    this.transaction(() => {
      const changed = this.db.prepare('UPDATE archive_distillations SET task_id=? WHERE draft_id=? AND task_id IS NULL').run(taskId, draftId);
      if (changed.changes !== 1) throw new MnemoWeaveError('INVALID_STATE');
    });
  }
}
