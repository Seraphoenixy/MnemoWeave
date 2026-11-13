import { z } from 'zod';
import { ARCHIVE_BODY_MAX_BYTES } from './capacity.ts';

/**
 * Formal-memory catalog and user-write contracts.
 *
 * Formal memories live in one shared Mnemon Store. No catalog record, request or response
 * carries a workspace or project field: a workspace name may appear in a *query* as a recall
 * hint, but it never narrows or widens access to an entry.
 */

export const CATEGORIES = ['preference', 'decision', 'fact', 'insight', 'context', 'general'] as const;
export const Category = z.enum(CATEGORIES);

const memoryBody = z.string().refine(
  value => value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 8000,
  'Content must contain 1–8000 UTF-8 bytes',
);

/**
 * Where a memory came from, and nothing else.
 *
 * `source` and `sourceReference` are the two fields a read path actually consults: the catalog
 * keys a synced revision by its reference, and sync distinguishes its own writes by source.
 * Four more fields once sat here — an evidence list, a verification status, a confidence score,
 * a limitations note and a last-verified date — and no production code path ever read any of
 * them; every writer filled in a fixed string. A field that only records what the writer typed
 * describes nothing the system verifies, so it is gone rather than kept as decoration.
 *
 * Verification is expressed where it is observable: a memory is `unverified` in the catalog until
 * a publication receipt exists, and a withdrawal is its own operation. What a fact applies to is
 * part of the fact's own text, which is also how the Provider decides two entries are the same.
 */
export const Provenance = z.object({
  source: z.string().trim().min(1).max(200),
  sourceReference: z.string().trim().min(1).max(2000),
}).strict();
export const ChangeIntent = z.object({
  kind: z.enum(['revise', 'supersede', 'coexist', 'conflict']),
  targetMemoryId: z.uuid(), expectedRevisionId: z.uuid(),
  effectiveAt: z.iso.datetime(), reason: z.string().trim().min(1).max(4000),
  evidence: z.array(z.string().trim().min(1).max(2000)).min(1).max(20),
}).strict();

/**
 * A candidate submission. Candidate review is the route for a host that has a trusted session
 * and turn binding but no write-task delegation; it never publishes directly.
 */
export const RememberInput = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  content: memoryBody,
  tags: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  category: Category.optional(),
  importance: z.number().int().min(1).max(5).optional(),
  entities: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  /** Engineering evidence supplied by the host: persisted user events or verified observations. */
  evidenceRefs: z.array(z.string().min(1).max(500)).max(12).optional(),
  change: ChangeIntent.optional(),
  provenance: Provenance,
}).strict();
export type RememberRequest = z.infer<typeof RememberInput>;

export const CandidateIdInput = z.object({ candidateId: z.uuid() }).strict();
/**
 * Candidate output form: identical to RememberInput but tolerates the cleared-body
 * tombstone (content ''), which only appears after 30-day retention clearing.
 */
export const CandidateRequest = RememberInput.extend({ content: z.string() });
export const SubmissionReceipt = z.object({
  id: z.uuid(), candidateId: z.uuid(), idempotencyKey: z.string(),
  status: z.literal('candidate'), submittedAt: z.iso.datetime(),
});

/**
 * A review is a decision and the reason for it. There is no structured assessment: the Server
 * does not call a model, so nothing produces one, and a field that only ever holds null would
 * describe a judgement the system never makes.
 */
export const ReviewRecord = z.object({
  id: z.uuid(), decision: z.enum(['approve', 'reject', 'human', 'retry', 'resubmitted']),
  actor: z.string(), reason: z.string(), createdAt: z.iso.datetime(),
});

const ExecutionBase = { id: z.uuid(), taskId: z.uuid(), runId: z.uuid(), createdAt: z.iso.datetime(), writeKey: z.string() };
export const ExecutionReceipt = z.discriminatedUnion('status', [
  z.object({ ...ExecutionBase, status: z.literal('persisted'), providerMemoryId: z.string().min(1), providerAction: z.enum(['added', 'skipped']), reconciled: z.boolean(), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ ...ExecutionBase, status: z.literal('failed'), code: z.string(), uncertain: z.boolean() }),
]);

export const PublicationRef = z.object({ memoryId: z.uuid(), revisionId: z.uuid() });

export const RevisionDescriptor = z.object({
  id: z.uuid(), memoryId: z.uuid(), number: z.number().int().positive(), parentId: z.uuid().nullable(),
  providerMemoryId: z.string().min(1), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  candidateId: z.uuid(), publishedAt: z.iso.datetime(), effectiveAt: z.iso.datetime(),
  /** Classification attached to this revision; omitted when none was recorded. */
  category: Category.optional(),
  importance: z.number().int().min(1).max(5).optional(),
  /** Absent means no classification was recorded; an empty array means it was recorded as empty. */
  tags: z.array(z.string()).optional(),
  entities: z.array(z.string()).optional(),
});

export const LogicalRelation = z.object({
  id: z.uuid(), kind: z.enum(['Supersedes', 'RelatedTo']), sourceMemoryId: z.uuid(), sourceRevisionId: z.uuid(),
  targetMemoryId: z.uuid(), targetRevisionId: z.uuid(),
  effectiveAt: z.iso.datetime(), reason: z.string(), evidence: z.array(z.string()), nativeProjected: z.boolean(),
});

export const ConflictDescriptor = z.object({
  id: z.uuid(), candidateId: z.uuid(), targetMemoryId: z.uuid(), baseRevisionId: z.uuid(),
  state: z.enum(['open', 'resolving', 'resolved', 'unverified']), followUpCandidateId: z.uuid().nullable(),
  decisions: z.array(z.object({ actor: z.string(), decision: z.string(), reason: z.string(), evidence: z.array(z.string()), createdAt: z.iso.datetime() })),
});
export type ConflictRecord = z.infer<typeof ConflictDescriptor>;
export const ConflictIdInput = z.object({ caseId: z.uuid() }).strict();
export const ConflictResolutionInput = z.object({
  caseId: z.uuid(), decision: z.enum(['keep_existing', 'revise', 'supersede', 'coexist', 'unverified']),
  reason: z.string().trim().min(1).max(4000), evidence: z.array(z.string().trim().min(1).max(2000)).min(1).max(20),
  replacement: RememberInput.optional(),
}).strict().superRefine((value, context) => {
  if ((value.decision === 'coexist') !== (value.replacement !== undefined)) context.addIssue({ code: 'custom', message: 'Coexist resolution requires an amended replacement; other resolutions cannot change the candidate' });
});
export type ConflictResolutionRequest = z.infer<typeof ConflictResolutionInput>;

/** Catalog metadata for one formal memory: pointers and revisions only, never the body. */
export const MemoryDescriptor = z.object({
  id: z.uuid(), currentRevisionId: z.uuid(), state: z.enum(['active', 'superseded', 'unverified']),
  revisions: z.array(RevisionDescriptor),
  relations: z.array(LogicalRelation).default([]),
  conflicts: z.array(ConflictDescriptor).default([]),
}).strict();
export type MemoryCatalogRecord = z.infer<typeof MemoryDescriptor>;

export const MemoryIdInput = z.object({ memoryId: z.uuid(), revisionId: z.uuid().optional() }).strict();

/** One entry of the client-facing memory list; content comes from the authoritative Provider. */
export const MemoryListItem = z.object({
  memoryId: z.uuid(), revisionId: z.uuid(), providerMemoryId: z.string().min(1),
  publishedAt: z.iso.datetime(), content: z.string(),
  entryVersion: z.number().int().nonnegative(),
  category: Category.optional(),
  importance: z.number().int().min(1).max(5).optional(),
  tags: z.array(z.string()).optional(),
  entities: z.array(z.string()).optional(),
}).strict();
export type MemoryListItemRecord = z.infer<typeof MemoryListItem>;

export const MemoryListQuery = z.object({
  query: z.string().trim().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  category: Category.optional(),
  /** Keep only memories whose current revision names this entity (case-insensitive). */
  entity: z.string().trim().min(1).max(200).optional(),
  sort: z.enum(['newest', 'oldest', 'importance']).optional(),
  /**
   * Opaque position in the stable scan order. It records how far the scan reached rather than
   * how many rows matched, so candidates skipped for not matching the query do not stall paging.
   */
  cursor: z.string().trim().max(500).optional(),
}).strict();

export const MemoryList = z.object({
  items: z.array(MemoryListItem),
  /** Present when more candidates remain; absent once the scan is exhausted. */
  nextCursor: z.string().optional(),
  categories: z.array(z.object({ value: z.string(), count: z.number().int().nonnegative() }).strict()).optional(),
  /** Entities named by the current revisions in the browsable set, in their recorded spelling. */
  entities: z.array(z.object({ value: z.string(), count: z.number().int().nonnegative() }).strict()).optional(),
  /**
   * How many memories the catalog holds, before any query or entity filter.
   *
   * `items` answers "what this page shows"; a tab that counted it would report the filtered size
   * as the size of the library, so picking one entity would look like losing twelve memories.
   */
  total: z.number().int().nonnegative().optional(),
}).strict();
export type MemoryListRecord = z.infer<typeof MemoryList>;

/**
 * Semantic search over the Provider, mapped back to this machine's catalog. An optional
 * `hint` is a recall cue such as a workspace name; it goes into the query text only.
 */
export const ExploreInput = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  minScore: z.coerce.number().min(0).max(1).default(0),
  /** Optional workspace display name used as an extra relevance line in the query. */
  hint: z.string().trim().min(1).max(200).optional(),
}).strict();
export const ExploreHit = z.object({
  memoryId: z.uuid(), revisionId: z.uuid(), providerMemoryId: z.string().min(1),
  state: z.enum(['active', 'superseded', 'unverified']),
  content: z.string(), score: z.number(), publishedAt: z.iso.datetime(),
  category: z.string().optional(), tags: z.array(z.string()).optional(),
}).strict();
export const ExploreOutput = z.object({
  query: z.string(),
  hits: z.array(ExploreHit),
  /** Provider memories that matched but were never published here. */
  unregistered: z.number().int().nonnegative(),
  truncated: z.boolean(),
}).strict();
export type ExploreInputRecord = z.infer<typeof ExploreInput>;
export type ExploreOutputRecord = z.infer<typeof ExploreOutput>;

/**
 * The relation graph over the visible catalog. Structure only: a node carries what the catalog
 * knows, not the body. Withdrawn memories never appear; superseded ones stay because a
 * supersede edge points at them.
 */
export const MemoryGraphQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
}).strict();
export const MemoryGraphNode = z.object({
  /**
   * The memory id, or the entity name for an entity node.
   *
   * Entities are nodes because most of what connects these memories is the entities they share —
   * the Provider indexes that, and a drawing that only showed catalogued decisions would show
   * almost nothing. An entity name is not a uuid, so this is a plain string.
   */
  memoryId: z.string().min(1),
  kind: z.enum(['memory', 'entity']).optional(),
  state: z.enum(['active', 'superseded', 'unverified']),
  publishedAt: z.iso.datetime(),
  category: z.string().optional(),
  importance: z.number().int().min(1).max(5).optional(),
  /** Memory content or the entity name, whichever the node stands for. */
  label: z.string().optional(),
  /** How many memories name this entity; absent for a memory node. */
  occurrenceCount: z.number().int().nonnegative().optional(),
}).strict();
export const MemoryGraphEdge = z.object({
  relationId: z.string().min(1),
  /**
   * `Entity` is not a catalogued decision: it records that two memories share an entity, which no
   * review produced. Keeping it distinguishable is what lets the drawing style it differently.
   */
  kind: z.enum(['Supersedes', 'RelatedTo', 'Conflicts', 'Entity']),
  sourceMemoryId: z.string().min(1),
  targetMemoryId: z.string().min(1),
  reason: z.string(),
  effectiveAt: z.iso.datetime(),
}).strict();
export const MemoryGraph = z.object({
  nodes: z.array(MemoryGraphNode),
  edges: z.array(MemoryGraphEdge),
  truncated: z.boolean(),
}).strict();
export type MemoryGraphRecord = z.infer<typeof MemoryGraph>;

/** Direct user creation: publishes without a review round and is recorded as `local-user`. */
export const MemoryCreateInput = z.object({
  content: memoryBody,
  category: Category.optional(),
  importance: z.number().int().min(1).max(5).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  entities: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  reason: z.string().trim().min(1).max(4000).optional(),
}).strict();
export const MemoryCreateOutput = z.object({
  memoryId: z.uuid(), revisionId: z.uuid(), providerMemoryId: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  entryVersion: z.number().int().nonnegative(),
  duplicate: z.boolean().optional(),
}).strict();
export type MemoryCreateRecord = z.infer<typeof MemoryCreateOutput>;

/** Direct user edit: appends an immutable revision; classification is inherited when omitted. */
export const MemoryEditInput = z.object({
  content: memoryBody,
  reason: z.string().trim().min(1).max(4000).optional(),
  entryVersion: z.number().int().nonnegative(),
  category: Category.optional(),
  importance: z.number().int().min(1).max(5).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  entities: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
}).strict();
export const MemoryEditOutput = z.object({
  memoryId: z.uuid(), revisionId: z.uuid(), providerMemoryId: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  entryVersion: z.number().int().positive(),
  duplicate: z.boolean().optional(),
}).strict();
export type MemoryEditRecord = z.infer<typeof MemoryEditOutput>;

/**
 * Withdrawal stops recall and injection but keeps history readable. It carries the version the
 * caller read, because it appends a revision like any other write.
 */
export const MemoryWithdrawInput = z.object({
  reason: z.string().trim().min(1).max(4000),
  entryVersion: z.number().int().nonnegative(),
}).strict();
export const MemoryWithdrawOutput = z.object({
  memoryId: z.uuid(),
  revisionId: z.uuid(),
  entryVersion: z.number().int().positive(),
  withdrawnAt: z.iso.datetime(),
}).strict();

export const PublishedMemoryOutput = MemoryDescriptor.extend({
  selectedRevisionId: z.uuid(),
  selectedRevision: RevisionDescriptor,
  content: z.string(),
  entryVersion: z.number().int().nonnegative(),
});
/** One formal memory read for the model: current or a named historical revision. */
export const MemoryReadOutput = PublishedMemoryOutput;

export const WriteTaskState = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export const WriteTask = z.object({
  id: z.uuid(), write_key: z.string(), state: WriteTaskState,
  checkpoint: z.enum(['ready', 'writing', 'retry']), attempts: z.number().int().nonnegative(), next_at: z.number().nullable(),
});

export const Candidate = z.object({
  id: z.uuid(),
  status: z.enum(['pending_review', 'needs_review', 'approved', 'rejected', 'persisting', 'persisted', 'failed']),
  submittedAt: z.iso.datetime(),
  request: CandidateRequest, receipt: SubmissionReceipt,
  reviews: z.array(ReviewRecord).default([]), executionReceipts: z.array(ExecutionReceipt).default([]), task: WriteTask.optional(),
  publication: PublicationRef.optional(),
  conflictCaseId: z.uuid().optional(),
  bodyCleared: z.boolean().optional(),
});
export type CandidateRecord = z.infer<typeof Candidate>;

export const HumanReviewInput = z.object({
  candidateId: z.uuid(), decision: z.enum(['approve', 'reject', 'amend']),
  reason: z.string().trim().min(1).max(4000),
  replacement: RememberInput.optional(),
}).strict().superRefine((value, context) => {
  if ((value.decision === 'amend') !== (value.replacement !== undefined)) context.addIssue({ code: 'custom', message: 'Only amend requires replacement' });
});
export const RetryInput = z.object({ candidateId: z.uuid(), reason: z.string().trim().min(1).max(4000), confirmNoActiveWrite: z.literal(true) }).strict();
export const CancelVersionInput = RetryInput;

export const StorageStatus = z.object({
  usedBytes: z.number().int().nonnegative(),
  state: z.enum(['ok', 'soft', 'hard']),
  softBytes: z.number().int().nonnegative().optional(),
  hardBytes: z.number().int().nonnegative().optional(),
}).strict();
export type StorageStatusRecord = z.infer<typeof StorageStatus>;

/** The formal body limit shared by the request schemas and the archive segment contract. */
export const FORMAL_BODY_MAX_BYTES = 8_000;
export const ARCHIVE_BODY_LIMIT_BYTES = ARCHIVE_BODY_MAX_BYTES;
