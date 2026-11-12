import { z } from 'zod';
import { ARCHIVE_BODY_MAX_BYTES, RULE_CAPACITY_BYTES } from './capacity.ts';

/**
 * Sync protocol 2.
 *
 * A stream is the unit of device authorization, log sequence, cursor, snapshot and retention.
 * The stream is derived from the entry: rules and formal memories each have one fixed stream,
 * a workspace archive belongs to its workspace. Clients never choose a stream, and the remote
 * rejects a change that tries to name one.
 */

export const UUID = z.uuid();
export const RULES_STREAM = 'rules';
export const FORMAL_STREAM = 'formal-memories';
export const WORKSPACE_ARCHIVE_PREFIX = 'workspace-archives:';

const STREAM_PATTERN = /^(?:rules|formal-memories|workspace-archives:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const SyncStream = z.string().regex(STREAM_PATTERN, 'Stream must be rules, formal-memories or workspace-archives:<workspaceId>');

/** Request header that names the protocol; a mismatch is HTTP 409 SYNC_PROTOCOL_MISMATCH. */
export const SYNC_PROTOCOL_HEADER = 'x-mnemoweave-sync-protocol';
export const SYNC_PROTOCOL_VERSION = 2;

export const SyncKind = z.enum(['rule', 'formal-memory', 'workspace-archive']);
export const SyncOperation = z.enum(['create', 'update', 'delete']);

/**
 * Body envelope. `contentHash` is sha256 (hex) over the bytes of `data` as transmitted:
 * for `plain` these are the UTF-8 bytes, for `enc-v1` the decoded ciphertext bytes.
 * `byteLength` is the length of those same bytes. The remote may verify them but must
 * not parse the body: the same code has to work after encryption is switched on.
 */
export const SyncContent = z.object({
  format: z.enum(['plain', 'enc-v1']),
  data: z.string().min(1).max(ARCHIVE_BODY_MAX_BYTES),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().positive().max(ARCHIVE_BODY_MAX_BYTES),
}).strict().refine(
  (value) => value.format !== 'plain' || value.byteLength <= ARCHIVE_BODY_MAX_BYTES,
  `Plain body must be at most ${ARCHIVE_BODY_MAX_BYTES} UTF-8 bytes`,
);

export const SyncRulePayload = z.object({
  enabled: z.boolean(),
  importance: z.enum(['critical', 'normal', 'low']).optional(),
  pinned: z.boolean().optional(),
}).strict();
export const SyncFormalRelation = z.object({
  type: z.enum(['supersedes', 'semantic', 'causal', 'entity', 'temporal']),
  from: z.object({ entryId: UUID, version: z.number().int().positive() }).strict(),
  to: z.object({ entryId: UUID, version: z.number().int().positive() }).strict(),
  metadata: z.record(z.string(), z.string()).optional(),
}).strict();
export const SyncFormalPayload = z.object({
  category: z.enum(['preference', 'decision', 'fact', 'insight', 'context', 'general']),
  importance: z.number().int().min(1).max(5),
  tags: z.array(z.string().trim().min(1).max(100)).max(20),
  entities: z.array(z.string().trim().min(1).max(200)).max(50),
  relations: z.array(SyncFormalRelation).max(200),
}).strict();
export const SyncWorkspaceArchivePayload = z.object({
  workspaceId: UUID,
  title: z.string().trim().min(1).max(200),
  source: z.enum(['session', 'tool', 'user']),
  verification: z.enum(['verified', 'open', 'refuted']),
  evidence: z.string().max(2000),
  tags: z.array(z.string().trim().min(1).max(100)).max(20),
  state: z.enum(['active', 'archived']).optional(),
  archivedAt: z.iso.datetime().nullable().optional(),
}).strict();
export const SyncPayload = z.union([SyncRulePayload, SyncFormalPayload, SyncWorkspaceArchivePayload]);

/** Stream an entry belongs to; this is the only place the mapping is decided. */
export function streamOf(kind: z.infer<typeof SyncKind>, payload: unknown): string {
  if (kind === 'rule') return RULES_STREAM;
  if (kind === 'formal-memory') return FORMAL_STREAM;
  const workspaceId = (payload as { workspaceId?: unknown } | null)?.workspaceId;
  if (typeof workspaceId !== 'string' || !UUID.safeParse(workspaceId).success) throw new Error('A workspace archive payload must name its workspaceId');
  return `${WORKSPACE_ARCHIVE_PREFIX}${workspaceId}`;
}

export const SyncRevision = z.object({
  version: z.number().int().positive(),
  content: SyncContent,
  createdAt: z.iso.datetime(),
}).strict();

/** Authoritative state of one entry. `revisions` is populated for snapshot and entry reads. */
export const SyncEntry = z.object({
  entryId: UUID,
  kind: SyncKind,
  version: z.number().int().positive(),
  content: SyncContent,
  payload: SyncPayload,
  withdrawnAt: z.iso.datetime().nullable(),
  revisions: z.array(SyncRevision).optional(),
}).strict();

/** What a device proposes; the remote assigns `version` and `seq`. */
export const SyncEntryDraft = z.object({
  entryId: UUID,
  kind: SyncKind,
  content: SyncContent,
  payload: SyncPayload,
  withdrawnAt: z.iso.datetime().nullable(),
}).strict();

export const SyncChangeInput = z.object({
  changeId: UUID,
  /** Base version observed through a read call; never filled in by the server. */
  baseVersion: z.number().int().min(0),
  operation: SyncOperation,
  entry: SyncEntryDraft,
}).strict();

export const SyncAccepted = z.object({
  changeId: UUID,
  entryId: UUID,
  stream: SyncStream,
  version: z.number().int().positive(),
  seq: z.number().int().nonnegative(),
  duplicate: z.boolean(),
  confirmedAt: z.iso.datetime().optional(),
}).strict();

export const SyncChangeRecord = z.object({
  changeId: UUID,
  entryId: UUID,
  stream: SyncStream,
  version: z.number().int().positive(),
  seq: z.number().int().positive(),
  operation: SyncOperation,
  entry: SyncEntry,
  deviceId: z.string().trim().min(1).max(200),
  recordedAt: z.iso.datetime(),
}).strict();

export const SyncPullInput = z.object({
  stream: SyncStream,
  since: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(200),
}).strict();

export const SyncPullPage = z.object({
  stream: SyncStream,
  changes: z.array(SyncChangeRecord).max(500),
  nextSince: z.number().int().min(0),
  hasMore: z.boolean(),
  /** Oldest seq still retained for this stream. A snapshot is required when since + 1 < retentionFloor. */
  retentionFloor: z.number().int().min(0),
  snapshotAtStart: z.boolean().optional(),
}).strict();

export const SyncSnapshot = z.object({
  stream: SyncStream,
  asOfSeq: z.number().int().min(0),
  nextSince: z.number().int().min(0),
  entries: z.array(SyncEntry),
}).strict();

export const SyncStreamGrant = z.object({
  stream: SyncStream,
  canRead: z.boolean(),
  canWrite: z.boolean(),
}).strict();

export const SyncStreamsOutput = z.object({
  deviceId: z.string().trim().min(1).max(200),
  streams: z.array(SyncStreamGrant),
}).strict();

/** Operator view of the local sync state; one row per known stream. */
export const SyncStatusStream = z.object({
  stream: SyncStream,
  cursor: z.number().int().nonnegative(),
  lastPullAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  pending: z.number().int().nonnegative(),
  /** Changes already sent whose outcome is not yet confirmed; resolved by changeId, never guessed. */
  unknown: z.number().int().nonnegative(),
  unapplied: z.number().int().nonnegative(),
}).strict();

export const SyncStatusOutput = z.object({
  enabled: z.boolean(),
  protocol: z.literal(SYNC_PROTOCOL_VERSION),
  streams: z.array(SyncStatusStream),
  updatedAt: z.iso.datetime(),
}).strict();

export const SyncRefreshOutput = z.object({
  streams: z.array(SyncStream),
  pulled: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  errors: z.array(z.string()),
  skipped: z.boolean(),
}).strict();

export type SyncContentValue = z.infer<typeof SyncContent>;
export type SyncEntryValue = z.infer<typeof SyncEntry>;
export type SyncEntryDraftValue = z.infer<typeof SyncEntryDraft>;
export type SyncChangeRequest = z.infer<typeof SyncChangeInput>;
export type SyncAcceptedValue = z.infer<typeof SyncAccepted>;
export type SyncChangeRecordValue = z.infer<typeof SyncChangeRecord>;
export type SyncPullRequest = z.infer<typeof SyncPullInput>;
export type SyncPullPageValue = z.infer<typeof SyncPullPage>;
export type SyncSnapshotValue = z.infer<typeof SyncSnapshot>;
export type SyncStreamGrantValue = z.infer<typeof SyncStreamGrant>;
export type SyncStreamsValue = z.infer<typeof SyncStreamsOutput>;
export type SyncStatusStreamValue = z.infer<typeof SyncStatusStream>;
export type SyncStatusValue = z.infer<typeof SyncStatusOutput>;
export type SyncRefreshValue = z.infer<typeof SyncRefreshOutput>;
export type SyncOperationValue = z.infer<typeof SyncOperation>;
export type SyncKindValue = z.infer<typeof SyncKind>;
export type SyncRulePayloadValue = z.infer<typeof SyncRulePayload>;
export type SyncFormalPayloadValue = z.infer<typeof SyncFormalPayload>;
export type SyncWorkspaceArchivePayloadValue = z.infer<typeof SyncWorkspaceArchivePayload>;

/** The rule capacity check the remote performs before assigning a version. */
export const RULE_STREAM_CAPACITY_BYTES = RULE_CAPACITY_BYTES;
