import { z } from 'zod';
import { ARCHIVE_ACTIVE_CAPACITY_BYTES, ARCHIVE_BODY_MAX_BYTES, ARCHIVE_SEARCH_LIMIT_DEFAULT, ARCHIVE_SEARCH_LIMIT_MAX, ARCHIVE_SEGMENT_CHARS, ARCHIVE_SEARCH_TOTAL_CHARS } from './capacity.ts';

/**
 * Workspaces and their archives.
 *
 * A workspace is a stable UUID shared by every device; each device binds its own local root
 * directory to it. An archive belongs to exactly one workspace. The workspace id is the access
 * boundary for reads, writes, capacity and sync, and it never enters a formal-memory record.
 */

export const WorkspaceId = z.uuid();
export const WorkspaceName = z.string().trim().min(1).max(200);

export const WorkspaceCreate = z.object({
  workspaceId: WorkspaceId,
  name: WorkspaceName,
}).strict();
export const WorkspaceBinding = z.object({
  /** Absolute local directory, resolved by the Server before it is stored. */
  rootPath: z.string().trim().min(1).max(4096),
}).strict();
export const WorkspaceRecord = z.object({
  workspaceId: WorkspaceId,
  name: WorkspaceName,
  createdAt: z.iso.datetime(),
  /** Present only when the caller is allowed to see local bindings; never on a host response. */
  boundRootCount: z.number().int().nonnegative().optional(),
}).strict();
export const WorkspaceList = z.object({ items: z.array(WorkspaceRecord) }).strict();
export type WorkspaceRecordValue = z.infer<typeof WorkspaceRecord>;
export type WorkspaceListRecord = z.infer<typeof WorkspaceList>;

/** A session claims one workspace at start. An empty payload explicitly records no binding. */
export const SessionWorkspaceInput = z.object({
  rootPath: z.string().trim().min(1).max(4096).optional(),
  workspaceId: WorkspaceId.optional(),
}).strict();
export const SessionWorkspaceRecord = z.object({
  sessionId: z.string().min(1).max(256),
  workspaceId: WorkspaceId.nullable(),
  boundAt: z.iso.datetime(),
}).strict();
export type SessionWorkspaceRecordValue = z.infer<typeof SessionWorkspaceRecord>;

// ── Rules ──
export const RuleImportance = z.enum(['critical', 'normal', 'low']);
const ruleBody = z.string().trim().min(1);
export const RuleCreate = z.object({
  body: ruleBody,
  enabled: z.boolean().default(true),
  importance: RuleImportance.default('normal'),
  pinned: z.boolean().default(false),
}).strict();
/**
 * The editor carries the version it opened. `remove` is mutually exclusive with a body, state,
 * importance or pinned change: removing appends a version, leaves the capacity count and the
 * resident set, and keeps the text readable in the archive.
 */
export const RuleEdit = z.object({
  body: ruleBody.optional(),
  enabled: z.boolean().optional(),
  importance: RuleImportance.optional(),
  pinned: z.boolean().optional(),
  remove: z.literal(true).optional(),
  baseVersion: z.number().int().positive(),
}).strict().superRefine((value, context) => {
  const edits = [value.body, value.enabled, value.importance, value.pinned, value.remove].filter(item => item !== undefined);
  if (edits.length === 0) context.addIssue({ code: 'custom', message: 'Rule edit requires a body, state, importance, pinned or remove change' });
  if (value.remove === true && edits.length > 1) context.addIssue({ code: 'custom', message: 'Removing a rule is exclusive with editing it' });
});
export const RuleRecord = z.object({
  entryId: z.uuid(),
  body: z.string().min(1),
  enabled: z.boolean(),
  version: z.number().int().positive(),
  withdrawnAt: z.iso.datetime().nullable(),
  importance: RuleImportance,
  pinned: z.boolean(),
  bodyBytes: z.number().int().positive(),
}).strict();
/**
 * The active rule set is one byte-accounted collection. `usedBytes` includes the separator
 * between entries; a write above `limitBytes` is refused instead of trimmed.
 */
export const RuleUsage = z.object({
  limitBytes: z.number().int().positive(),
  itemMaxBytes: z.number().int().positive(),
  usedBytes: z.number().int().nonnegative(),
  entryCount: z.number().int().nonnegative(),
  exceeded: z.boolean(),
  overByBytes: z.number().int().nonnegative(),
}).strict();
export const RuleList = z.object({ items: z.array(RuleRecord), usage: RuleUsage }).strict();
/** Exact rule text that left the resident set, with its source version. */
export const RuleArchiveRecord = z.object({
  archiveId: z.uuid(),
  ruleId: z.uuid(),
  ruleVersion: z.number().int().positive(),
  body: z.string().min(1),
  importance: RuleImportance,
  pinned: z.boolean(),
  archivedAt: z.iso.datetime(),
  reason: z.enum(['capacity', 'manual']),
}).strict();
export const RuleArchiveList = z.object({ items: z.array(RuleArchiveRecord) }).strict();
export type RuleCreateInput = z.infer<typeof RuleCreate>;
export type RuleEditInput = z.infer<typeof RuleEdit>;
export type RuleRecordValue = z.infer<typeof RuleRecord>;
export type RuleListRecord = z.infer<typeof RuleList>;
export type RuleUsageRecord = z.infer<typeof RuleUsage>;
export type RuleArchiveRecordValue = z.infer<typeof RuleArchiveRecord>;

// ── Workspace archives ──
export const ArchiveState = z.enum(['active', 'archived']);
const archiveBody = z.string().trim().min(1);
export const ArchiveCreate = z.object({
  workspaceId: WorkspaceId,
  title: z.string().trim().min(1).max(200),
  body: archiveBody,
  source: z.enum(['session', 'tool', 'user']),
  verification: z.enum(['verified', 'open', 'refuted']),
  evidence: z.string().trim().min(1).max(2000),
}).strict();
export const ArchiveEdit = ArchiveCreate.pick({ title: true, body: true, verification: true, evidence: true }).extend({
  baseVersion: z.number().int().positive(),
}).strict();
export type ArchiveEditInput = z.infer<typeof ArchiveEdit>;
export const ArchiveRecord = z.object({
  entryId: z.uuid(), workspaceId: WorkspaceId, title: z.string().min(1), body: z.string().min(1),
  source: z.enum(['session', 'tool', 'user']), verification: z.enum(['verified', 'open', 'refuted']),
  evidence: z.string().min(1), version: z.number().int().positive(), withdrawnAt: z.iso.datetime().nullable(),
  state: ArchiveState, archivedAt: z.iso.datetime().nullable(), bodyBytes: z.number().int().positive(),
}).strict();
export type ArchiveRecordValue = z.infer<typeof ArchiveRecord>;
export type ArchiveCreateInput = z.infer<typeof ArchiveCreate>;
export const ArchiveCapacity = z.object({
  workspaceId: WorkspaceId,
  activeBytes: z.number().int().nonnegative(),
  limitBytes: z.number().int().positive(),
  activeCount: z.number().int().nonnegative(),
  archivedCount: z.number().int().nonnegative(),
  exceeded: z.boolean(),
}).strict();
export type ArchiveUsageRecord = z.infer<typeof ArchiveCapacity>;
/**
 * One archive offered for capacity release.
 *
 * The order is the remote-confirmed update time, oldest first, ties broken by id: the suggestion
 * is "release what has been idle longest", and it is deterministic so two devices agree.
 */
export const ArchiveReleaseCandidate = z.object({
  entryId: z.uuid(),
  title: z.string().min(1),
  bodyBytes: z.number().int().positive(),
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
}).strict();
export type ArchiveReleaseCandidateValue = z.infer<typeof ArchiveReleaseCandidate>;
export const ArchiveReleaseCandidates = z.object({
  workspaceId: WorkspaceId,
  capacity: ArchiveCapacity,
  items: z.array(ArchiveReleaseCandidate),
  /** How many more active archives exist beyond the returned page. */
  remaining: z.number().int().nonnegative(),
}).strict();
export type ArchiveReleaseCandidatesRecord = z.infer<typeof ArchiveReleaseCandidates>;

export const ArchiveList = z.object({
  items: z.array(ArchiveRecord),
  capacities: z.array(ArchiveCapacity),
  nextCursor: z.string().optional(),
}).strict();
export type ArchiveListRecord = z.infer<typeof ArchiveList>;
/** Management search: one workspace, an explicit query, a bounded page. */
export const ArchiveSearchInput = z.object({
  workspaceId: WorkspaceId,
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(ARCHIVE_SEARCH_LIMIT_MAX).default(ARCHIVE_SEARCH_LIMIT_DEFAULT),
  includeArchived: z.boolean().default(false),
}).strict();
export const ArchiveSearchHit = z.object({
  entryId: z.uuid(), workspaceId: WorkspaceId, title: z.string().min(1),
  state: ArchiveState, version: z.number().int().positive(),
  verification: z.enum(['verified', 'open', 'refuted']),
  excerpt: z.string(), excerptChars: z.number().int().nonnegative(),
  excerptTruncated: z.boolean(), bodyChars: z.number().int().nonnegative(), score: z.number().int().nonnegative(),
}).strict();
export const ArchiveSearchOutput = z.object({
  query: z.string(), total: z.number().int().nonnegative(), results: z.array(ArchiveSearchHit),
  totalChars: z.number().int().nonnegative(), truncated: z.boolean(),
  totalLimitChars: z.literal(ARCHIVE_SEARCH_TOTAL_CHARS),
  callsLimit: z.literal(4),
}).strict();
export type ArchiveSearchInputRecord = z.infer<typeof ArchiveSearchInput>;
export type ArchiveSearchOutputRecord = z.infer<typeof ArchiveSearchOutput>;

/** Moves one archive between active and archived; the version must match what the caller read. */
export const ArchiveStateInput = z.object({
  state: ArchiveState,
  baseVersion: z.number().int().positive(),
}).strict();
export type ArchiveStateInputRecord = z.infer<typeof ArchiveStateInput>;
export const ArchiveHistoryRecord = z.object({
  revisionId: z.uuid(), entryId: z.uuid(), workspaceId: WorkspaceId, version: z.number().int().positive(),
  title: z.string().min(1), body: z.string().min(1),
  source: z.enum(['session', 'tool', 'user']), verification: z.enum(['verified', 'open', 'refuted']),
  evidence: z.string().min(1), state: ArchiveState, archivedAt: z.iso.datetime().nullable(),
  recordedAt: z.iso.datetime(),
}).strict();
export type ArchiveHistoryRecordValue = z.infer<typeof ArchiveHistoryRecord>;
export const ArchiveHistory = z.object({ entryId: z.uuid(), items: z.array(ArchiveHistoryRecord) }).strict();

/** One model-facing segment of an archive body; the cursor is bound to host, session, id and version. */
export const ArchiveSegmentInput = z.object({
  entryId: z.uuid(),
  cursor: z.string().min(1).max(2000).optional(),
}).strict();
export const ArchiveSegmentOutput = z.object({
  entryId: z.uuid(),
  workspaceId: WorkspaceId,
  version: z.number().int().positive(),
  title: z.string().min(1),
  content: z.string(),
  nextCursor: z.string().optional(),
  /** True when this segment reaches the end of the body at this version. */
  complete: z.boolean(),
  totalChars: z.number().int().nonnegative(),
}).strict();
export type ArchiveSegmentOutputRecord = z.infer<typeof ArchiveSegmentOutput>;

/** Model-facing archive search in the session's bound workspace. */
export const ArchiveToolSearchInput = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(ARCHIVE_SEARCH_LIMIT_MAX).optional(),
  includeArchived: z.boolean().optional(),
}).strict();

export const ARCHIVE_LIMITS = {
  bodyMaxBytes: ARCHIVE_BODY_MAX_BYTES,
  activeCapacityBytes: ARCHIVE_ACTIVE_CAPACITY_BYTES,
  segmentChars: ARCHIVE_SEGMENT_CHARS,
} as const;
