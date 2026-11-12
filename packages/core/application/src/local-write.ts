import { createHash, randomUUID } from 'node:crypto';
import { MnemoWeaveError, SyncChangeInput } from '../../contracts/src/index.ts';
import type { SyncChangeRequest, SyncEntryDraftValue, SyncFormalPayloadValue } from '../../contracts/src/index.ts';
import { buildChange } from './sync.ts';
import type { SyncLedgerPort } from './sync.ts';
import type { LocalArchiveRow, LocalRuleRow } from './sync-apply.ts';
import { streamOf } from '../../contracts/src/index.ts';

/**
 * Local writes become changes only after they are applied locally.
 *
 * The change is queued and one flush is attempted: an unreachable remote leaves it queued, a
 * timeout leaves the outcome unknown, and a conflict is reported back to the caller. Nothing here
 * retries on its own — `resolveUnknown` owns unknown outcomes, and the periodic pass owns the
 * queue. A change never names its stream: the stream is derived from the entry kind and, for a
 * workspace archive, from `payload.workspaceId`.
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
  const record = ports.ledger.inboxChange(change.changeId);
  return { state: 'confirmed', accepted: record ? { version: record.version, seq: record.seq } : null };
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function plain(text: string): SyncEntryDraftValue['content'] {
  return { format: 'plain', data: text, contentHash: sha256(text), byteLength: Buffer.byteLength(text, 'utf8') };
}

/**
 * A formal-memory edit travels as a new version with a `supersedes` edge to the version the
 * editor read. Without a confirmed base (version 0) it is a create with no edge: the remote has
 * nothing to replace yet.
 */
export function planEditChange(input: {
  entryId: string; content: string; entryVersion: number;
  category: SyncFormalPayloadValue['category'];
  importance: number;
  tags: string[];
  entities: string[];
}): LocalWriteInput {
  const baseVersion = input.entryVersion;
  const relations = baseVersion > 0
    ? [{
      type: 'supersedes' as const,
      from: { entryId: input.entryId, version: baseVersion },
      to: { entryId: input.entryId, version: baseVersion + 1 },
    }]
    : [];
  return {
    operation: baseVersion === 0 ? 'create' : 'update',
    baseVersion,
    entry: {
      entryId: input.entryId,
      kind: 'formal-memory',
      content: plain(input.content),
      payload: { category: input.category, importance: input.importance, tags: input.tags, entities: input.entities, relations },
      withdrawnAt: null,
    },
  };
}

/** A formal-memory creation: first version, no relations. */
export function planCreateChange(input: {
  entryId: string; content: string;
  category: SyncFormalPayloadValue['category'];
  importance: number;
  tags: string[];
  entities: string[];
}): LocalWriteInput {
  return {
    operation: 'create',
    baseVersion: 0,
    entry: {
      entryId: input.entryId,
      kind: 'formal-memory',
      content: plain(input.content),
      payload: { category: input.category, importance: input.importance, tags: input.tags, entities: input.entities, relations: [] },
      withdrawnAt: null,
    },
  };
}

/** A formal-memory withdrawal: a new version whose `withdrawnAt` is set; the body is unchanged. */
export function planWithdrawChange(input: {
  entryId: string; content: string; entryVersion: number; at: string;
  category: SyncFormalPayloadValue['category'];
  importance: number;
  tags: string[];
  entities: string[];
}): LocalWriteInput {
  return {
    operation: 'delete',
    baseVersion: input.entryVersion,
    entry: {
      entryId: input.entryId,
      kind: 'formal-memory',
      content: plain(input.content),
      payload: { category: input.category, importance: input.importance, tags: input.tags, entities: input.entities, relations: [] },
      withdrawnAt: input.at,
    },
  };
}

/** Rules live in the one `rules` stream and carry no workspace field. */
export function ruleDraft(row: LocalRuleRow): SyncEntryDraftValue {
  const entry: SyncEntryDraftValue = {
    entryId: row.entryId,
    kind: 'rule',
    content: plain(row.body),
    payload: {
      enabled: row.enabled,
      ...(row.importance !== undefined && row.importance !== 'normal' ? { importance: row.importance } : {}),
      ...(row.pinned === true ? { pinned: true } : {}),
    },
    withdrawnAt: row.withdrawnAt,
  };
  // A payload that cannot derive a stream must never be queued.
  streamOf(entry.kind, entry.payload);
  return entry;
}

/** A workspace archive: the workspace id travels in the payload, never in the envelope. */
export function archiveDraft(row: LocalArchiveRow): SyncEntryDraftValue {
  const entry: SyncEntryDraftValue = {
    entryId: row.entryId,
    kind: 'workspace-archive',
    content: plain(row.body),
    payload: {
      workspaceId: row.workspaceId,
      title: row.title,
      source: row.source as 'session' | 'tool' | 'user',
      verification: row.verification,
      evidence: row.evidence,
      tags: [],
      ...(row.state === 'archived' ? { state: 'archived' as const, archivedAt: row.archivedAt ?? null } : {}),
    },
    withdrawnAt: row.withdrawnAt,
  };
  streamOf(entry.kind, entry.payload);
  return entry;
}

/** The stream an entry belongs to, used by callers that need to read the right inbox. */
export function streamFor(entry: SyncEntryDraftValue): string {
  return streamOf(entry.kind, entry.payload);
}
