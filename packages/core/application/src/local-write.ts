import { createHash, randomUUID } from 'node:crypto';
import { MnemoWeaveError, SyncChangeInput } from '../../contracts/src/index.ts';
import type { SyncChangeRequest, SyncEntryDraftValue } from '../../contracts/src/index.ts';
import { buildChange } from './sync.ts';
import type { SyncLedgerPort } from './sync.ts';
import type { LocalArchiveRow, LocalRuleRow } from './sync-apply.ts';

/**
 * Local writes become changes only after they are applied locally.
 *
 * The change is queued and one flush is attempted: an unreachable remote leaves it
 * queued, a timeout leaves the outcome unknown, and a conflict is reported back to
 * the caller. Nothing here retries on its own — `resolveUnknown` owns unknown
 * outcomes, and the periodic pass owns the queue.
 */

export type LocalWriteState = 'confirmed' | 'queued' | 'unknown';

export interface LocalWriteResult {
  state: LocalWriteState;
  /** Version and seq the remote assigned; present only when the change was confirmed. */
  accepted: { version: number; seq: number } | null;
}

export interface LocalWritePorts {
  ledger: SyncLedgerPort;
  flush(): Promise<unknown>;
  now(): string;
}

export interface LocalWriteInput {
  scope: string;
  operation: SyncChangeRequest['operation'];
  entry: SyncEntryDraftValue;
  baseVersion: number;
  /** Optional caller-supplied id; lets the caller find its own inbox row after the flush. */
  changeId?: string;
}

export async function submitLocalChange(input: LocalWriteInput, ports: LocalWritePorts): Promise<LocalWriteResult> {
  const outstanding = ports.ledger.outboxForEntry(input.entry.entryId);
  if (outstanding && (outstanding.state === 'pending' || outstanding.state === 'unknown')) throw new MnemoWeaveError('SYNC_QUEUED');
  const change = SyncChangeInput.parse(buildChange({
    changeId: input.changeId ?? randomUUID(),
    baseVersion: input.baseVersion,
    operation: input.operation,
    entry: input.entry,
  }));
  ports.ledger.enqueue(change, ports.now());
  await ports.flush();
  const row = ports.ledger.outboxChange(change.changeId);
  if (!row) throw new MnemoWeaveError('INTERNAL');
  if (row.state === 'conflict') throw new MnemoWeaveError('VERSION_CONFLICT');
  if (row.state === 'needs_review') throw new MnemoWeaveError('NEEDS_REVIEW');
  if (row.state === 'unknown') return { state: 'unknown', accepted: null };
  if (row.state !== 'confirmed') return { state: 'queued', accepted: null };
  // A confirmed change is fed back into the inbox; its version is the remote's answer.
  const record = ports.ledger.inboxChange(change.changeId);
  return { state: 'confirmed', accepted: record ? { version: record.version, seq: record.seq } : null };
}

/**
 * A user edit travels as a formal entry whose new version supersedes the previous one.
 * Without a confirmed base (version 0) it is a create with no edge: there is nothing
 * on the remote to replace yet.
 */
export function planEditChange(input: { entryId: string; scope: string; content: string; entryVersion: number }): LocalWriteInput {
  const baseVersion = input.entryVersion;
  const relations = baseVersion > 0
    ? [{ type: 'supersedes' as const, from: { entryId: input.entryId, version: baseVersion }, to: { entryId: input.entryId, version: baseVersion + 1 } }]
    : [];
  return {
    scope: input.scope,
    operation: baseVersion === 0 ? 'create' : 'update',
    baseVersion,
    entry: {
      entryId: input.entryId,
      kind: 'formal',
      scope: input.scope,
      content: {
        format: 'plain',
        data: input.content,
        contentHash: sha256(input.content),
        byteLength: Buffer.byteLength(input.content, 'utf8'),
      },
      payload: { category: 'fact', importance: 3, tags: [], entities: [], relations },
      withdrawnAt: null,
    },
  };
}

/** Scope for a local rule row: global rules live in the global scope. */
export function ruleScope(row: LocalRuleRow): string {
  return row.scope === 'global' ? 'global' : `project:${row.projectId ?? ''}`;
}

export function ruleDraft(row: LocalRuleRow): SyncEntryDraftValue {
  return {
    entryId: row.entryId,
    kind: 'runtime',
    scope: ruleScope(row),
    content: {
      format: 'plain',
      data: row.body,
      contentHash: sha256(row.body),
      byteLength: Buffer.byteLength(row.body, 'utf8'),
    },
    payload: { enabled: row.enabled },
    withdrawnAt: row.withdrawnAt,
  };
}

export function archiveDraft(row: LocalArchiveRow): SyncEntryDraftValue {
  return {
    entryId: row.entryId,
    kind: 'archive',
    scope: `project:${row.projectId}`,
    content: {
      format: 'plain',
      data: row.body,
      contentHash: sha256(row.body),
      byteLength: Buffer.byteLength(row.body, 'utf8'),
    },
    payload: { title: row.title, source: row.source as 'session' | 'tool' | 'user', verification: row.verification, evidence: row.evidence, tags: [] },
    withdrawnAt: row.withdrawnAt,
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
