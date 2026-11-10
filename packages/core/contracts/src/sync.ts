import { z } from 'zod';

/** A scope is either the cross-project `global` scope or one project's scope. */
export const SyncScope = z.string().trim().regex(/^(?:global|project:[A-Za-z0-9._-]{1,200})$/, 'Scope must be global or project:<id>');

export const SyncKind = z.enum(['runtime', 'archive', 'formal']);
export const SyncOperation = z.enum(['create', 'update', 'delete']);

/**
 * Body envelope. `contentHash` is sha256 (hex) over the bytes of `data` as transmitted:
 * for `plain` these are the UTF-8 bytes, for `enc-v1` the decoded ciphertext bytes.
 * `byteLength` is the length of those same bytes. The remote may verify them but must
 * not parse the body: the same code has to work after encryption is switched on.
 */
export const SyncContent = z.object({
  format: z.enum(['plain', 'enc-v1']),
  data: z.string().min(1).max(20000),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().positive().max(20000),
}).strict().refine(
  (value) => value.format !== 'plain' || value.byteLength <= 8000,
  'Plain body must be at most 8000 UTF-8 bytes',
);

export const SyncRuntimePayload = z.object({ enabled: z.boolean() }).strict();
export const SyncArchivePayload = z.object({
  title: z.string().trim().min(1).max(200),
  source: z.enum(['session', 'tool', 'user']),
  verification: z.enum(['verified', 'open', 'refuted']),
  evidence: z.string().max(2000),
  tags: z.array(z.string().trim().min(1).max(100)).max(20),
}).strict();
export const SyncRevisionRef = z.object({
  entryId: z.uuid(),
  version: z.number().int().positive(),
}).strict();
export const SyncFormalRelation = z.object({
  type: z.enum(['supersedes', 'semantic', 'causal', 'entity', 'temporal']),
  from: SyncRevisionRef,
  to: SyncRevisionRef,
  metadata: z.record(z.string(), z.string()).optional(),
}).strict();
export const SyncFormalPayload = z.object({
  category: z.enum(['preference', 'decision', 'fact', 'insight', 'context', 'general']),
  importance: z.number().int().min(1).max(5),
  tags: z.array(z.string().trim().min(1).max(100)).max(20),
  entities: z.array(z.string().trim().min(1).max(200)).max(50),
  relations: z.array(SyncFormalRelation).max(200),
}).strict();
export const SyncPayload = z.union([SyncRuntimePayload, SyncArchivePayload, SyncFormalPayload]);

export const SyncRevision = z.object({
  version: z.number().int().positive(),
  content: SyncContent,
  createdAt: z.iso.datetime(),
}).strict();

/** Authoritative state of one entry. `revisions` is populated for snapshot and entry reads. */
export const SyncEntry = z.object({
  entryId: z.uuid(),
  kind: SyncKind,
  scope: SyncScope,
  version: z.number().int().positive(),
  content: SyncContent,
  payload: SyncPayload,
  withdrawnAt: z.iso.datetime().nullable(),
  revisions: z.array(SyncRevision).optional(),
}).strict();

/** What a device proposes; the remote assigns `version` and `seq`. */
export const SyncEntryDraft = z.object({
  entryId: z.uuid(),
  kind: SyncKind,
  scope: SyncScope,
  content: SyncContent,
  payload: SyncPayload,
  withdrawnAt: z.iso.datetime().nullable(),
}).strict();

export const SyncChangeInput = z.object({
  changeId: z.uuid(),
  /** Base version observed through a read call; never filled in by the server. */
  baseVersion: z.number().int().min(0),
  operation: SyncOperation,
  entry: SyncEntryDraft,
}).strict();

export const SyncAccepted = z.object({
  changeId: z.uuid(),
  entryId: z.uuid(),
  scope: SyncScope,
  version: z.number().int().positive(),
  seq: z.number().int().positive(),
  duplicate: z.boolean(),
}).strict();

export const SyncChangeRecord = z.object({
  changeId: z.uuid(),
  entryId: z.uuid(),
  scope: SyncScope,
  version: z.number().int().positive(),
  seq: z.number().int().positive(),
  operation: SyncOperation,
  entry: SyncEntry,
  deviceId: z.string().trim().min(1).max(200),
  recordedAt: z.iso.datetime(),
}).strict();

export const SyncPullInput = z.object({
  scope: SyncScope,
  since: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(200),
}).strict();

export const SyncPullPage = z.object({
  scope: SyncScope,
  changes: z.array(SyncChangeRecord).max(500),
  nextSince: z.number().int().min(0),
  hasMore: z.boolean(),
  /** Oldest seq still retained for this scope. A snapshot is required when since + 1 < retentionFloor. */
  retentionFloor: z.number().int().min(0),
}).strict();

export const SyncSnapshot = z.object({
  scope: SyncScope,
  asOfSeq: z.number().int().min(0),
  nextSince: z.number().int().min(0),
  entries: z.array(SyncEntry),
}).strict();

export const SyncScopeGrant = z.object({
  scope: SyncScope,
  canRead: z.boolean(),
  canWrite: z.boolean(),
}).strict();

export const SyncScopesOutput = z.object({
  deviceId: z.string().trim().min(1).max(200),
  scopes: z.array(SyncScopeGrant),
}).strict();

/** Operator view of the local sync state; one row per known scope. */
export const SyncStatusScope = z.object({
  scope: SyncScope,
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
  scopes: z.array(SyncStatusScope),
  updatedAt: z.iso.datetime(),
}).strict();

export const SyncRefreshOutput = z.object({
  scopes: z.array(SyncScope),
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
export type SyncScopeGrantValue = z.infer<typeof SyncScopeGrant>;
export type SyncScopesValue = z.infer<typeof SyncScopesOutput>;
export type SyncStatusScopeValue = z.infer<typeof SyncStatusScope>;
export type SyncStatusValue = z.infer<typeof SyncStatusOutput>;
export type SyncRefreshValue = z.infer<typeof SyncRefreshOutput>;
export type SyncOperationValue = z.infer<typeof SyncOperation>;
export type SyncKindValue = z.infer<typeof SyncKind>;
