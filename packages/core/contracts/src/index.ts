import { PinInput, RuntimeContextInput } from './runtime.ts';
import { SyncRefreshOutput, SyncStatusOutput } from './sync.ts';
import { z } from 'zod';

export * from './sync.ts';

export const RecallInput = z.object({
  query: z.string().trim().min(1).max(2000),
  limit: z.number().int().min(1).max(100).default(10),
}).strict();
export const Memory = z.object({ id: z.string().min(1), content: z.string(), score: z.number().finite().optional(), superseded: z.boolean().optional() });
export const RecallOutput = z.object({ memories: z.array(Memory), complete: z.boolean().optional() });
export const ProviderHealth = z.object({ ready: z.literal(true), version: z.literal('0.2.13'), capabilities: z.array(z.enum(['health', 'recall', 'remember'])) });
export type RecallRequest = z.infer<typeof RecallInput>;
export type RecallResult = z.infer<typeof RecallOutput>;
export type Health = z.infer<typeof ProviderHealth>;
export type ErrorCode = 'INVALID_INPUT' | 'UNAUTHORIZED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_PROTOCOL' | 'PROVIDER_INTEGRITY' | 'PROVIDER_TIMEOUT' | 'UNSUPPORTED_VERSION' | 'REVIEW_REQUIRED' | 'NOT_FOUND' | 'IDEMPOTENCY_CONFLICT' | 'INVALID_STATE' | 'VIEW_BUDGET_EXCEEDED' | 'QUOTA_EXCEEDED' | 'INTERNAL'
  | 'VERSION_CONFLICT' | 'CHANGE_ID_REUSED' | 'CHANGE_ID_EXPIRED' | 'SNAPSHOT_REQUIRED' | 'DEVICE_REVOKED' | 'SCOPE_FORBIDDEN' | 'SYNC_UNAVAILABLE' | 'SYNC_QUEUED' | 'SYNC_OUTCOME_UNKNOWN' | 'RULE_BUDGET_EXCEEDED' | 'NEEDS_REVIEW';

const CONFLICT_CODES: readonly ErrorCode[] = [
  'REVIEW_REQUIRED', 'IDEMPOTENCY_CONFLICT', 'INVALID_STATE', 'VIEW_BUDGET_EXCEEDED', 'QUOTA_EXCEEDED',
  'VERSION_CONFLICT', 'CHANGE_ID_REUSED', 'CHANGE_ID_EXPIRED', 'SNAPSHOT_REQUIRED',
  'SYNC_QUEUED', 'SYNC_OUTCOME_UNKNOWN', 'RULE_BUDGET_EXCEEDED', 'NEEDS_REVIEW',
];

/** HTTP status for an error code; every HTTP surface uses this one mapping. */
export function statusForCode(code: ErrorCode): number {
  return code === 'UNAUTHORIZED' || code === 'DEVICE_REVOKED' ? 401
    : code === 'SCOPE_FORBIDDEN' ? 403
    : code === 'INVALID_INPUT' ? 400
    : code === 'NOT_FOUND' ? 404
    : CONFLICT_CODES.includes(code) ? 409
    : 503;
}
export class MnemoWeaveError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) { super(code); this.name = 'MnemoWeaveError'; this.code = code; }
}
export function publicError(error: unknown): { code: ErrorCode } {
  return { code: error instanceof MnemoWeaveError ? error.code : error instanceof z.ZodError ? 'INVALID_INPUT' : 'INTERNAL' };
}
export const Provenance = z.object({
  source: z.string().trim().min(1).max(200),
  sourceReference: z.string().trim().min(1).max(2000),
  evidence: z.array(z.string().trim().min(1).max(2000)).min(1).max(20),
  verificationStatus: z.enum(['unverified', 'verified', 'disputed']),
  confidence: z.number().min(0).max(1),
  applicability: z.string().trim().min(1).max(2000),
  limitations: z.string().trim().min(1).max(2000),
  lastVerified: z.iso.datetime().nullable(),
}).strict();
export const ChangeIntent = z.object({
  kind: z.enum(['revise', 'supersede', 'coexist', 'conflict']),
  targetMemoryId: z.uuid(), expectedRevisionId: z.uuid(),
  effectiveAt: z.iso.datetime(), reason: z.string().trim().min(1).max(4000),
  evidence: z.array(z.string().trim().min(1).max(2000)).min(1).max(20),
}).strict();
export const RememberInput = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  content: z.string().min(1).refine(value => value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 8000, 'Content must contain 1–8000 UTF-8 bytes'),
  knowledgeType: z.enum(['Concept', 'Practice', 'Architecture', 'Troubleshooting', 'Constraint', 'Procedure', 'Reference']),
  tags: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  /** Classification a publication may carry; absent means it was never recorded. */
  category: z.enum(['preference', 'decision', 'fact', 'insight', 'context', 'general']).optional(),
  importance: z.number().int().min(1).max(5).optional(),
  entities: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  change: ChangeIntent.optional(),
  provenance: Provenance,
}).strict();
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
const Check = z.object({ result: z.enum(['pass', 'fail', 'uncertain']), reason: z.string().min(1).max(2000) }).strict();
export const SemanticAssessment = z.object({
  checks: z.object({ source: Check, accuracy: Check, reuse: Check, scope: Check, duplication: Check, consistency: Check }).strict(),
  requiresHuman: z.boolean(), conflict: z.enum(['none', 'uncertain', 'factual', 'evolution', 'supersedes', 'different_scope']),
  summary: z.string().min(1).max(2000),
}).strict();
export type Assessment = z.infer<typeof SemanticAssessment>;
export const ReviewRecord = z.object({
  id: z.uuid(), decision: z.enum(['approve', 'reject', 'human', 'retry', 'resubmitted']),
  actor: z.string(), reason: z.string(), createdAt: z.iso.datetime(), assessment: SemanticAssessment.nullable(),
});
const ExecutionBase = { id: z.uuid(), taskId: z.uuid(), runId: z.uuid(), createdAt: z.iso.datetime(), writeKey: z.string() };
export const PublicationRef = z.object({ memoryId: z.uuid(), revisionId: z.uuid() });
export const RevisionDescriptor = z.object({
  id: z.uuid(), memoryId: z.uuid(), number: z.number().int().positive(), parentId: z.uuid().nullable(),
  providerMemoryId: z.string().min(1), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  candidateId: z.uuid(), publishedAt: z.iso.datetime(), effectiveAt: z.iso.datetime(),
  applicability: z.string(),
  /**
   * Classification attached to this revision. `knowledgeType` comes from a local Remember; the
   * rest arrive with a synced formal entry. They are separate dimensions, not synonyms, so a
   * revision may carry one, both or neither — never a value invented by mapping one to the other.
   */
  knowledgeType: z.enum(['Concept', 'Practice', 'Architecture', 'Troubleshooting', 'Constraint', 'Procedure', 'Reference']).optional(),
  category: z.enum(['preference', 'decision', 'fact', 'insight', 'context', 'general']).optional(),
  importance: z.number().int().min(1).max(5).optional(),
  /** Absent means no classification was recorded; an empty array means it was recorded as empty. */
  tags: z.array(z.string()).optional(),
  entities: z.array(z.string()).optional(),
});
export const LogicalRelation = z.object({
  id: z.uuid(), kind: z.enum(['Supersedes', 'RelatedTo']), sourceMemoryId: z.uuid(), sourceRevisionId: z.uuid(), targetMemoryId: z.uuid(), targetRevisionId: z.uuid(),
  effectiveAt: z.iso.datetime(), reason: z.string(), evidence: z.array(z.string()), nativeProjected: z.boolean(),
});
export const ConflictDescriptor = z.object({
  id:z.uuid(), candidateId:z.uuid(), targetMemoryId:z.uuid(), baseRevisionId:z.uuid(),
  state:z.enum(['open','resolving','resolved','unverified']), followUpCandidateId:z.uuid().nullable(),
  decisions:z.array(z.object({actor:z.string(),decision:z.string(),reason:z.string(),evidence:z.array(z.string()),createdAt:z.iso.datetime()})),
});
export const ConflictIdInput=z.object({caseId:z.uuid()}).strict();
export const ConflictResolutionInput=z.object({
  caseId:z.uuid(), decision:z.enum(['keep_existing','revise','supersede','coexist','unverified']),
  reason:z.string().trim().min(1).max(4000), evidence:z.array(z.string().trim().min(1).max(2000)).min(1).max(20),
  replacement:RememberInput.optional(),
}).strict().superRefine((value,context)=>{
  if((value.decision==='coexist')!==(value.replacement!==undefined))context.addIssue({code:'custom',message:'Coexist resolution requires an amended, scope-qualified replacement; other resolutions cannot change the candidate'});
});
export type ConflictResolutionRequest=z.infer<typeof ConflictResolutionInput>;
export type ConflictRecord=z.infer<typeof ConflictDescriptor>;
export const MemoryDescriptor = z.object({
  id: z.uuid(), currentRevisionId: z.uuid(), state: z.enum(['active', 'superseded', 'unverified']),
  applicability: z.string(), revisions: z.array(RevisionDescriptor),
  relations: z.array(LogicalRelation).default([]),
  conflicts:z.array(ConflictDescriptor).default([]),
});
export const MemoryIdInput = z.object({ memoryId: z.uuid(), revisionId: z.uuid().optional() }).strict();
/** One entry of the client-facing memory list; content comes from the authoritative Provider. */
export const MemoryListItem = z.object({
  memoryId: z.uuid(), revisionId: z.uuid(), providerMemoryId: z.string().min(1),
  applicability: z.string(), publishedAt: z.iso.datetime(), content: z.string(),
  entryVersion: z.number().int().nonnegative(),
  /**
   * Classification of the current revision, so a card can show what the memory is without
   * opening it. Absent means it was never recorded.
   */
  knowledgeType: z.enum(['Concept', 'Practice', 'Architecture', 'Troubleshooting', 'Constraint', 'Procedure', 'Reference']).optional(),
  category: z.enum(['preference', 'decision', 'fact', 'insight', 'context', 'general']).optional(),
  importance: z.number().int().min(1).max(5).optional(),
  tags: z.array(z.string()).optional(),
  entities: z.array(z.string()).optional(),
}).strict();
export const MemoryListQuery = z.object({
  query: z.string().trim().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /**
   * Keep only memories whose current revision carries this classification. Applied to the
   * candidate set before the body is read, so a filtered page costs no more than an
   * unfiltered one.
   */
  category: z.enum(['preference', 'decision', 'fact', 'insight', 'context', 'general']).optional(),
  knowledgeType: z.enum(['Concept', 'Practice', 'Architecture', 'Troubleshooting', 'Constraint', 'Procedure', 'Reference']).optional(),
  /** Keep only memories whose current revision names this entity (case-insensitive). */
  entity: z.string().trim().min(1).max(200).optional(),
  /** Scan order. Changing it invalidates any cursor issued for a different one. */
  sort: z.enum(['newest', 'oldest', 'importance']).optional(),
  /**
   * Opaque position in the stable scan order. It records how far the scan reached rather than
   * how many rows matched, so candidates skipped for not matching the query do not stall paging.
   */
  cursor: z.string().trim().max(500).optional(),
}).strict();
/**
 * Semantic search over the Provider, mapped back to this machine's catalog.
 *
 * This is not the list endpoint with a different query: the list matches body text over a stable
 * scan, while explore ranks by the Provider's own similarity. Only memories this machine knows
 * and may read are returned; Provider hits with no catalog entry are counted, never shown.
 */
export const ExploreInput = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /**
   * Drop hits the Provider scored below this. Scores are the Provider's own, observed in `[0, 1]`,
   * where an unrelated query still returns low-scoring matches — so a threshold is what turns a
   * ranked list into an answer.
   */
  minScore: z.coerce.number().min(0).max(1).default(0),
}).strict();
export const ExploreHit = z.object({
  memoryId: z.uuid(), revisionId: z.uuid(), providerMemoryId: z.string().min(1),
  state: z.enum(['active', 'superseded', 'unverified']),
  content: z.string(), score: z.number(), publishedAt: z.iso.datetime(),
  /** Classification of the current revision, when it was recorded. */
  category: z.string().optional(), knowledgeType: z.string().optional(), tags: z.array(z.string()).optional(),
}).strict();
export const ExploreOutput = z.object({
  query: z.string(),
  hits: z.array(ExploreHit),
  /**
   * Provider memories that matched but were never published here. Counted so the page can say so
   * rather than presenting a short list as complete.
   */
  unregistered: z.number().int().nonnegative(),
  /**
   * True when the result filled the requested limit, so more matches may exist. Explore is a
   * ranking, not a scan: there is no cursor, and asking again with a larger limit is the only way
   * to see further down the same order.
   */
  truncated: z.boolean(),
}).strict();
export type ExploreInputRecord = z.infer<typeof ExploreInput>;
export type ExploreOutputRecord = z.infer<typeof ExploreOutput>;

/**
 * The relation graph over the visible catalog.
 *
 * Structure only: a node carries what the catalog knows, not the body. Bodies are Provider reads,
 * and a graph of a few hundred nodes would otherwise cost one CLI process per node just to draw a
 * label; a renderer resolves the names of the nodes it actually shows.
 */
export const MemoryGraphQuery = z.object({
  /** Cap on nodes; edges are then limited to those whose endpoints are both present. */
  limit: z.coerce.number().int().min(1).max(500).default(200),
}).strict();
export const MemoryGraphNode = z.object({
  memoryId: z.uuid(),
  /**
   * A retired memory is still a node: a supersede edge points *at* one by definition, so excluding
   * them would make every supersede edge undrawable. Withdrawn memories never appear.
   */
  state: z.enum(['active', 'superseded', 'unverified']),
  publishedAt: z.iso.datetime(),
  category: z.string().optional(),
  knowledgeType: z.string().optional(),
  importance: z.number().int().min(1).max(5).optional(),
}).strict();
export const MemoryGraphEdge = z.object({
  relationId: z.string().min(1),
  /** Conflicts links two memories that disagree and both still exist. */
  kind: z.enum(['Supersedes', 'RelatedTo', 'Conflicts']),
  sourceMemoryId: z.uuid(),
  targetMemoryId: z.uuid(),
  reason: z.string(),
  effectiveAt: z.iso.datetime(),
}).strict();
export const MemoryGraph = z.object({
  nodes: z.array(MemoryGraphNode),
  /** Every edge has both endpoints in `nodes`; a dangling edge would be undrawable. */
  edges: z.array(MemoryGraphEdge),
  /** True when the node cap was reached, so the graph is a subset rather than the whole set. */
  truncated: z.boolean(),
}).strict();
export type MemoryGraphRecord = z.infer<typeof MemoryGraph>;

export const MemoryList = z.object({  items: z.array(MemoryListItem),
  /** Present when more candidates remain; absent once the scan is exhausted. */
  nextCursor: z.string().optional(),
  /**
   * Classification values present in the browsable set. Indexed before the category filter is
   * applied, so choosing one category cannot remove the others from the picker.
   */
  categories: z.array(z.object({ value: z.string(), count: z.number().int().nonnegative() }).strict()).optional(),
  knowledgeTypes: z.array(z.object({ value: z.string(), count: z.number().int().nonnegative() }).strict()).optional(),
  /** Entities named by the current revisions in the browsable set, in their recorded spelling. */
  entities: z.array(z.object({ value: z.string(), count: z.number().int().nonnegative() }).strict()).optional(),
}).strict();
export type MemoryListItemRecord = z.infer<typeof MemoryListItem>;
export type MemoryListRecord = z.infer<typeof MemoryList>;

// ── Runtime rules and project archives (operator write surface) ──
export const RuleCreate = z.object({
  body: z.string().trim().min(1).max(4000),
  enabled: z.boolean().default(true),
}).strict();
export const RuleEdit = z.object({
  body: z.string().trim().min(1).max(4000).optional(),
  enabled: z.boolean().optional(),
  /**
   * The version the editor was opened at. When supplied, a stale value is refused instead of
   * overwriting a change this caller never read.
   */
  baseVersion: z.number().int().nonnegative().optional(),
}).strict().refine(value => value.body !== undefined || value.enabled !== undefined, 'Rule edit requires body or enabled');
export const RuleRecord = z.object({
  entryId: z.uuid(),
  body: z.string().min(1),
  enabled: z.boolean(),
  version: z.number().int().positive(),
  withdrawnAt: z.iso.datetime().nullable(),
}).strict();
export const RuleList = z.object({ items: z.array(RuleRecord) }).strict();
export const ArchiveCreate = z.object({
  projectId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(8000),
  source: z.enum(['session', 'tool', 'user']),
  verification: z.enum(['verified', 'open', 'refuted']),
  evidence: z.string().trim().min(1).max(2000),
}).strict();
export const ArchiveEdit = ArchiveCreate.pick({ title: true, body: true, verification: true, evidence: true }).extend({
  baseVersion: z.number().int().positive(),
}).strict();
export type ArchiveEditInput = z.infer<typeof ArchiveEdit>;
export const ArchiveRecord = z.object({
  entryId: z.uuid(), projectId: z.string().min(1), title: z.string().min(1), body: z.string().min(1),
  source: z.enum(['session', 'tool', 'user']), verification: z.enum(['verified', 'open', 'refuted']),
  evidence: z.string().min(1), version: z.number().int().positive(), withdrawnAt: z.iso.datetime().nullable(),
}).strict();
export type RuleCreateInput = z.infer<typeof RuleCreate>;
export type RuleEditInput = z.infer<typeof RuleEdit>;
export type RuleRecordValue = z.infer<typeof RuleRecord>;
export type RuleListRecord = z.infer<typeof RuleList>;
export const ArchiveList = z.object({ items: z.array(ArchiveRecord) }).strict();
export type ArchiveCreateInput = z.infer<typeof ArchiveCreate>;
export type ArchiveRecordValue = z.infer<typeof ArchiveRecord>;
export type ArchiveListRecord = z.infer<typeof ArchiveList>;
export type MemoryEditRecord = z.infer<typeof MemoryEditOutput>;
/**
 * Direct user creation: publishes a formal memory without a review round.
 *
 * The user's own input is treated as already-confirmed knowledge, so this is deliberately not a
 * candidate submission — but it still goes through the same publication pipeline (Provider write,
 * catalog record, sync outbox), and it is recorded as a `local-user` review decision so the
 * history says who asked for it. Model output has no such path.
 */
export const MemoryCreateInput = z.object({
  content: z.string().refine(value => value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 8000, 'Content must contain 1–8000 UTF-8 bytes'),
  /** Knowledge type is required on creation: there is no previous revision to inherit from. */
  knowledgeType: z.enum(['Concept', 'Practice', 'Architecture', 'Troubleshooting', 'Constraint', 'Procedure', 'Reference']),
  category: z.enum(['preference', 'decision', 'fact', 'insight', 'context', 'general']).optional(),
  importance: z.number().int().min(1).max(5).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  entities: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  reason: z.string().trim().min(1).max(4000).optional(),
}).strict();
export const MemoryCreateOutput = z.object({
  memoryId: z.uuid(), revisionId: z.uuid(), providerMemoryId: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  /** Always 1 for a new memory, but returned so the page can open the editor on a known base. */
  entryVersion: z.number().int().nonnegative(),
}).strict();
export type MemoryCreateRecord = z.infer<typeof MemoryCreateOutput>;
/** Direct user edit: appends an immutable revision to an existing memory without a review round. */
export const MemoryEditInput = z.object({
  content: z.string().refine(value => value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 8000, 'Content must contain 1–8000 UTF-8 bytes'),
  reason: z.string().trim().min(1).max(4000).optional(),
  /** Base version read from the list/detail API; the server never fills it in. */
  entryVersion: z.number().int().nonnegative(),
  /**
   * Classification the new revision should carry. Omitted fields are inherited from the revision
   * being edited, so a body-only edit cannot silently drop what the memory was classified as.
   */
  category: z.enum(['preference', 'decision', 'fact', 'insight', 'context', 'general']).optional(),
  knowledgeType: z.enum(['Concept', 'Practice', 'Architecture', 'Troubleshooting', 'Constraint', 'Procedure', 'Reference']).optional(),
  importance: z.number().int().min(1).max(5).optional(),
  /** An empty array clears the tags; omitting the field keeps them. */
  tags: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
}).strict();
export const MemoryEditOutput = z.object({
  memoryId: z.uuid(), revisionId: z.uuid(), providerMemoryId: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  entryVersion: z.number().int().positive(),
}).strict();
/**
 * Withdrawing stops recall and injection but keeps the history readable. It carries the same
 * base version as an edit, because it appends a revision like any other write.
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
export const PublishedMemoryOutput = MemoryDescriptor.extend({ selectedRevisionId: z.uuid(),selectedRevision:RevisionDescriptor, content: z.string(), entryVersion: z.number().int().nonnegative() });
export type MemoryCatalogRecord = z.infer<typeof MemoryDescriptor>;
export const ExecutionReceipt = z.discriminatedUnion('status', [
  z.object({ ...ExecutionBase, status: z.literal('persisted'), providerMemoryId: z.string().min(1), providerAction: z.enum(['added', 'skipped']), reconciled: z.boolean(), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ ...ExecutionBase, status: z.literal('failed'), code: z.string(), uncertain: z.boolean() }),
]);
export const WriteTask = z.object({ id: z.uuid(), write_key: z.string(), state: z.enum(['queued', 'running', 'succeeded', 'failed','cancelled']), checkpoint: z.enum(['ready', 'writing', 'retry']), attempts: z.number().int().nonnegative(), next_at: z.number().nullable() });
export const Candidate = z.object({
  id: z.uuid(), status: z.enum(['pending_review', 'needs_review', 'approved', 'rejected', 'persisting', 'persisted', 'failed']), submittedAt: z.iso.datetime(),
  request: CandidateRequest, receipt: SubmissionReceipt,
  reviews: z.array(ReviewRecord).default([]), executionReceipts: z.array(ExecutionReceipt).default([]), task: WriteTask.optional(),
  publication: PublicationRef.optional(),
  conflictCaseId:z.uuid().optional(),
  bodyCleared: z.boolean().optional(),
});

// ── Host event envelope (HOST-03; normalized MnemoWeave contract, not an upstream API) ──
export const HostEventKind = z.enum(['session.started', 'session.ended', 'message.user', 'message.assistant.final', 'tool.completed']);
export const HostEvent = z.object({
  protocolVersion: z.string().regex(/^\d+(\.\d+){0,2}$/), adapterVersion: z.string().min(1),
  eventId: z.string().min(8).max(128),
  sessionId: z.string().min(1).max(256), turnId: z.string().min(1).max(256).optional(),
  projectId: z.string().min(1).max(256).optional(),
  kind: HostEventKind,
  occurredAt: z.iso.datetime(), receivedAt: z.iso.datetime(),
  sourceRef: z.string().min(1).max(2000),
  payload: z.object({
    text: z.string().max(20000).optional(),
    toolName: z.string().min(1).max(500).optional(),
    outcome: z.enum(['success', 'failure']).optional(),
    candidateId: z.uuid().optional(),
  }).strict(),
  /** Crash-recovery interruptions are explicitly marked as inferred, never native endings. */
  inferred: z.boolean().optional(),
}).strict().superRefine((event, context) => {
  if ((event.kind === 'message.user' || event.kind === 'message.assistant.final') && event.payload.text === undefined) context.addIssue({ code: 'custom', message: `${event.kind} requires payload.text` });
  if (event.kind === 'tool.completed' && (event.payload.toolName === undefined || event.payload.outcome === undefined)) context.addIssue({ code: 'custom', message: 'tool.completed requires payload.toolName and payload.outcome' });
  if ((event.kind === 'session.started' || event.kind === 'session.ended') && (event.payload.text !== undefined || event.payload.toolName !== undefined || event.payload.outcome !== undefined)) context.addIssue({ code: 'custom', message: `${event.kind} carries no content payload` });
});
export type HostEventRecord = z.infer<typeof HostEvent>;
export type EventRecord = {
  eventId: string; hostId: string; sessionId: string; turnId: string | null; projectId: string | null;
  kind: z.infer<typeof HostEventKind>; occurredAt: string; receivedAt: string; sourceRef: string;
  adapterVersion: string; protocolVersion: string; stage: 'hot' | 'archived' | 'cleared';
  important: boolean; protectedReason: string | null; archivedAt: string | null; inferred: boolean;
  payload: { text?: string; toolName?: string; outcome?: 'success' | 'failure'; candidateId?: string };
};
export type RetentionSweepReport = {
  archivedEvents: number; clearedEvents: number; protectedEvents: number;
  clearedCandidates: number; deferredCandidates: { candidateId: string; reason: string }[];
  planSkewMs: { events: number; candidates: number };
};
export const HumanReviewInput = z.object({
  candidateId: z.uuid(), decision: z.enum(['approve', 'reject', 'amend']),
  reason: z.string().trim().min(1).max(4000),
  replacement: RememberInput.optional(),
}).strict().superRefine((value, context) => {
  if ((value.decision === 'amend') !== (value.replacement !== undefined)) context.addIssue({ code: 'custom', message: 'Only amend requires replacement' });
});
export const RetryInput = z.object({ candidateId: z.uuid(), reason: z.string().trim().min(1).max(4000), confirmNoActiveWrite: z.literal(true) }).strict();
export const CancelVersionInput=RetryInput;

// ── View, ReadGrant and rerank contracts (VIEW-01/02, RECALL-01/02) ──
/** Server-issued offline read authorization; expiry and generation watermark enforce revocation. */
export const ReadGrant = z.object({
  grantId: z.uuid(), hostId: z.string().min(1),
  projects: z.array(z.string().min(1)), globalIncluded: z.boolean(),
  issuedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  generation: z.number().int().nonnegative(),
}).strict();
export type ReadGrantRecord = z.infer<typeof ReadGrant>;
export const ViewMemory = z.object({
  memoryId: z.uuid(), revisionId: z.uuid(), providerMemoryId: z.string().min(1),
  tier: z.enum(['pinned-critical', 'pinned-normal', 'dynamic']),
  applicability: z.string(),
  content: z.string(), excerpt: z.boolean(), score: z.number().finite().optional(),
  sourceReference: z.string().min(1),
}).strict();
export const ViewRule = z.object({
  entryId: z.uuid(), version: z.number().int().positive(), body: z.string().min(1),
}).strict();
export const ViewRerank = z.object({
  status: z.enum(['not_requested', 'applied', 'unavailable', 'failed']),
  reason: z.string().min(1), route: z.string().optional(),
}).strict();
export const View = z.object({
  viewId: z.uuid(), generation: z.number().int().nonnegative(), createdAt: z.iso.datetime(),
  grantId: z.uuid(), query: z.string().nullable(),
  scopeNote: z.object({ projects: z.array(z.string()), globalIncluded: z.boolean() }).strict(),
  budget: z.object({ limitTokens: z.number().int().positive(), usedTokens: z.number().int().nonnegative(), estimator: z.literal('utf8-bytes-3'), estimated: z.literal(true), envelopeReserveTokens: z.number().int().nonnegative() }).strict(),
  memories: z.array(ViewMemory),
  delivery: z.enum(['server', 'local_replica']).optional(),
  dataTime: z.iso.datetime().optional(), stale: z.boolean().optional(),
  guidance: z.string().optional(),
  workingContext: z.array(z.object({ eventId: z.string(), text: z.string(), kind: z.enum(['user', 'task', 'tool']) }).strict()).optional(),
  runtime: z.object({ sessionId: z.string(), task: z.string().nullable(), capture: z.string(), revision: z.number() }).optional(),
  // Runtime rules are injected whole or not at all; never truncated to fit.
  rules: z.array(ViewRule).optional(),
  rulesBudget: z.object({ limitTokens: z.number().int().positive(), usedTokens: z.number().int().nonnegative(), exceeded: z.boolean() }).strict().optional(),
  // Logical memory UUID when attributed; the Provider memory id when a mid-assembly state
  // change removed the logical mapping.
  excluded: z.array(z.object({ memoryId: z.string().min(1), reason: z.enum(['not_visible', 'superseded', 'budget', 'grant_scope', 'unregistered']) }).strict()),
  complete: z.boolean(), rerank: ViewRerank,
}).strict();
export type ViewRecord = z.infer<typeof View>;
/** What one injection actually delivered; the operator surface reads the latest row. */
export const InjectionReport = z.object({
  id: z.uuid(), hostId: z.string().min(1), sessionId: z.string().min(1),
  rulesInjected: z.number().int().nonnegative(),
  rulesOmitted: z.enum(['budget_exceeded']).nullable(),
  memoriesInjected: z.number().int().nonnegative(),
  usedTokens: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
}).strict();
export type InjectionReportRecord = z.infer<typeof InjectionReport>;
export type ViewRuleRecord = z.infer<typeof ViewRule>;
/** One View delivery request; identity comes from the paired Host header, never from the body. */
export const ViewRequest = z.object({
  query: z.string().trim().min(1).max(2000).optional(),
  projectId: z.string().trim().min(1).optional(),
  pinned: z.array(z.object({ memoryId: z.uuid(), tier: z.enum(['critical', 'normal']) }).strict()).max(20).optional(),
  rerank: z.boolean().optional(),
  sessionId: z.string().min(1).max(200).optional(),
  task: z.string().trim().min(1).max(2000).optional(),
  budgetTokens: z.number().int().min(128).max(4096).optional(),
}).strict();
export type ViewRequestInput = z.infer<typeof ViewRequest>;
/** STORAGE-02 capacity state: soft triggers cleanup prompts, hard rejects non-critical growth. */
export const StorageStatus = z.object({
  usedBytes: z.number().int().nonnegative(),
  state: z.enum(['ok', 'soft', 'hard']),
  softBytes: z.number().int().nonnegative().optional(),
  hardBytes: z.number().int().nonnegative().optional(),
}).strict();
export type StorageStatusRecord = z.infer<typeof StorageStatus>;
/** KNOWLEDGE-01: review-due is derived from publication time and knowledge type; never auto-invalidates. */
export const ReviewDueItem = z.object({
  memoryId: z.uuid(), knowledgeType: z.string().min(1), intervalDays: z.number().int().positive(),
  dueAt: z.iso.datetime(), lastReviewedAt: z.iso.datetime().nullable(),
}).strict();
export type ReviewDueItemRecord = z.infer<typeof ReviewDueItem>;
export const ReviewDueOutput = z.object({ items: z.array(ReviewDueItem) }).strict();
export const ReviewCompleteInput = z.object({ memoryId: z.uuid(), reason: z.string().trim().min(1).max(4000) }).strict();
/** Rerank output is bound to the request generation it was computed for; stale results are rejected.
 *  `order` holds the exact identity kind the reranker received: Provider ids at assembly time,
 *  logical memory UUIDs when re-binding to a delivered View. */
export const RerankOutput = z.object({ generation: z.number().int().nonnegative(), order: z.array(z.string().min(1)) }).strict();
export type RerankResult = z.infer<typeof RerankOutput>;
export type RememberRequest = z.infer<typeof RememberInput>;
export type CandidateRecord = z.infer<typeof Candidate>;
// These schemas describe MnemoWeave's own HTTP contract, not an upstream Mnemon API.
const jsonContent = (schema: z.ZodType) => ({ 'application/json': { schema: z.toJSONSchema(schema) } });
export const openapi = {
  openapi: '3.1.0', info: { title: 'MnemoWeave development API', version: '0.1.0' },
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
  security: [{ bearer: [] }],
  paths: { '/health/live': { get: {
    description: 'Process liveness. Still requires the service token: only local non-browser clients are served. `service` and `protocol` identify the responder so a host can tell this Server apart from another program holding the port; a rejected token carries the same identity fields so a host reports a token mismatch rather than an intruder.',
    responses: { '200': { description: 'Process is live', content: jsonContent(z.object({ live: z.literal(true), service: z.literal('mnemoweave'), protocol: z.number().int().positive() }).strict()) }, '401': { description: 'Unauthorized; the body still names this service so the caller reports a token mismatch', content: jsonContent(z.object({ code: z.string(), service: z.literal('mnemoweave'), protocol: z.number().int().positive(), traceId: z.string() })) } },
  } },
  '/health/ready': { get: {
    description: 'Provider dependency readiness.',
    responses: { '200': { description: 'Provider health', content: jsonContent(ProviderHealth) }, '401': { description: 'Unauthorized' }, '503': { description: 'Provider unavailable' } },
  } },
  '/openapi.json': { get: {
    description: 'This contract document.',
    responses: { '200': { description: 'OpenAPI 3.1 document' }, '401': { description: 'Unauthorized' } },
  } },
  '/v1/recall': { post: {
    requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(RecallInput) } } },
    responses: { '200': { description: 'Recall result', content: { 'application/json': { schema: z.toJSONSchema(RecallOutput) } } }, '400': { description: 'Invalid input' }, '401': { description: 'Unauthorized' }, '503': { description: 'Provider unavailable' } },
  } } },
};

Object.assign(openapi.paths, {
  '/v1/view': { post: {
    description: 'Assemble one immutable View for the paired Host. Grant, revocation, publication state and token budget are checked before delivery; identity comes from the x-mnemoweave-host header, never from the body.',
    parameters: [{ name: 'x-mnemoweave-host', in: 'header', required: true, schema: z.toJSONSchema(z.string().min(1)) }],
    requestBody: { required: true, content: jsonContent(ViewRequest) },
    responses: { '200': { description: 'Immutable View', content: jsonContent(View) }, '400': { description: 'Invalid input' }, '401': { description: 'Unauthorized or grant unusable' }, '409': { description: 'Budget exceeded or View unavailable' }, '503': { description: 'Provider unavailable' } },
  } },
  '/v1/storage': { get: {
    description: 'Capacity state for the governance store (STORAGE-02). Soft prompts cleanup; hard rejects non-critical growth.',
    responses: { '200': { description: 'Storage status', content: jsonContent(StorageStatus) }, '401': { description: 'Unauthorized' } },
  } },
  '/v1/reviews/due': { get: {
    description: 'Operator review queue (KNOWLEDGE-01): memories whose review interval has elapsed. Due entries are not invalidated or hidden.',
    security: [{ operator: [] }],
    responses: { '200': { description: 'Due reviews', content: jsonContent(ReviewDueOutput) }, '401': { description: 'Operator credential required' } },
  } },
  '/v1/reviews/complete': { post: {
    description: 'Operator records a completed review and reschedules the interval from now.',
    security: [{ operator: [] }],
    requestBody: { required: true, content: jsonContent(ReviewCompleteInput) },
    responses: { '200': { description: 'Rescheduled memory', content: jsonContent(ReviewDueItem) }, '400': { description: 'Invalid input' }, '401': { description: 'Operator credential required' }, '404': { description: 'Memory not found' } },
  } },
  '/v1/review': { post: {
    description: 'Operator-only exception review. approve/reject/amend; unresolved replacement/version conflicts cannot be approved as independent facts.',
    security: [{ operator: [] }],
    requestBody: { required: true, content: jsonContent(HumanReviewInput) },
    responses: { '200': { description: 'Recorded decision', content: jsonContent(Candidate) }, '401': { description: 'Independent operator credential required' }, '409': { description: 'Invalid state or unresolved conflict' } },
  } },
  '/v1/retry': { post: {
    description: 'Operator confirms original writer is stopped; retry still reconciles Provider first.', security: [{ operator: [] }],
    requestBody: { required: true, content: jsonContent(RetryInput) },
    responses: { '202': { description: 'Write queued with original stable write key', content: jsonContent(Candidate) }, '401': { description: 'Operator credential required' }, '409': { description: 'Candidate is not failed' } },
  } },
  '/v1/remember': { post: {
    description: 'Create a candidate only; no formal Mnemon write happens in this call. Approved candidates are written by the background worker, and candidates carrying a change intent enter the version publication flow after human confirmation.',
    requestBody: { required: true, content: jsonContent(RememberInput) },
    responses: {
      '202': { description: 'Candidate accepted for future review', content: jsonContent(Candidate) },
      '400': { description: 'Invalid input' }, '401': { description: 'Unauthorized' },
      '409': { description: 'Idempotency key conflict or candidate persistence not configured' },
    },
  } },
  '/v1/candidates/{candidateId}': { get: {
    parameters: [{ name: 'candidateId', in: 'path', required: true, schema: z.toJSONSchema(z.uuid()) }],
    responses: { '200': { description: 'Persisted candidate and submission receipt', content: jsonContent(Candidate) }, '404': { description: 'Candidate not found' } },
  } },
  '/v1/conflicts/{caseId}': { get: {
    description: 'Conflict case with both sides\' evidence references and recorded decisions.',
    parameters: [{ name: 'caseId', in: 'path', required: true, schema: z.toJSONSchema(z.uuid()) }],
    responses: { '200': { description: 'Conflict case descriptor', content: jsonContent(ConflictDescriptor) }, '401': { description: 'Unauthorized' }, '404': { description: 'Conflict case not found' }, '409': { description: 'Candidate storage not configured' } },
  } },
  '/v1/conflicts/resolve': { post: {
    description: 'Operator-only conflict adjudication: keep_existing/revise/supersede/coexist/unverified; coexist requires a scope-qualified replacement candidate.',
    security: [{ operator: [] }],
    requestBody: { required: true, content: jsonContent(ConflictResolutionInput) },
    responses: { '200': { description: 'Adjudication recorded, follow-up candidate returned', content: jsonContent(Candidate) }, '401': { description: 'Operator credential required' }, '409': { description: 'Case state, CAS or replacement invalid' } },
  } },
  '/v1/versions/cancel': { post: {
    description: 'Operator-only cancellation of an unpublished version operation. The Provider was not written, so the receipt is uncertain=true and means "never published", not a Provider rollback.',
    security: [{ operator: [] }],
    requestBody: { required: true, content: jsonContent(CancelVersionInput) },
    responses: { '200': { description: 'Operation cancelled; candidate rejected', content: jsonContent(Candidate) }, '401': { description: 'Operator credential required' }, '409': { description: 'Operation already published, invoking or verified' } },
  } },
  '/v1/memories': {
    get: {
      description: 'List published memories with their current Provider text; optional space-separated query filters the list.',
      parameters: [{ name: 'query', in: 'query', schema: z.toJSONSchema(z.string().max(500)) }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } }],
      responses: { '200': { description: 'Memory list', content: jsonContent(MemoryList) }, '401': { description: 'Unauthorized' }, '503': { description: 'Provider unavailable' } },
    },
    post: {
      description: 'Create a formal memory directly, without a review round. User input is treated as already-confirmed knowledge; the write still goes through the ordinary publication pipeline and is recorded as a local-user review decision. Model output has no such path.',
      parameters: [{ name: 'x-mnemoweave-host', in: 'header', required: true, schema: z.toJSONSchema(z.string().min(1)) }],
      requestBody: { required: true, content: jsonContent(MemoryCreateInput) },
      responses: { '200': { description: 'Memory published', content: jsonContent(MemoryCreateOutput) }, '400': { description: 'Invalid input' }, '401': { description: 'Missing host identity' }, '409': { description: 'The publisher is not running, or the write failed' }, '503': { description: 'Provider unavailable, or the outcome is not yet known' } },
    },
  },
  '/v1/memories/{memoryId}': {
    get: {
      description: 'Read selected/current published version from authoritative Provider and check content hash.',
      parameters: [{ name: 'memoryId', in: 'path', required: true, schema: z.toJSONSchema(z.uuid()) }, { name: 'revisionId', in: 'query', schema: z.toJSONSchema(z.uuid()) }],
      responses: { '200': { description: 'Published metadata and verified Provider text', content: jsonContent(PublishedMemoryOutput) }, '404': { description: 'Memory/revision not found' }, '503': { description: 'Provider missing or content integrity mismatch' } },
    },
    patch: {
      description: 'User edit: append an immutable revision with the new text, supersede the previous Provider memory and move the current pointer. No review round is inserted; the edit is recorded as a local-user review decision attributed to the calling Host.',
      parameters: [{ name: 'memoryId', in: 'path', required: true, schema: z.toJSONSchema(z.uuid()) }],
      requestBody: { required: true, content: jsonContent(MemoryEditInput) },
      responses: { '200': { description: 'New revision published', content: jsonContent(MemoryEditOutput) }, '400': { description: 'Invalid input' }, '401': { description: 'Service token rejected or Host identity missing' }, '404': { description: 'Memory not found' }, '409': { description: 'Memory is superseded, unverified, or the base version is stale' }, '503': { description: 'Provider unavailable or content mismatch' } },
    },
  },
  '/v1/memories/graph': { get: {
    description: 'The relation graph over the visible catalog. Structure only — nodes carry what the catalog knows, not the body, because reading bodies would cost one Provider process per node. Every edge has both endpoints present.',
    parameters: [
      { name: 'x-mnemoweave-host', in: 'header', required: true, schema: z.toJSONSchema(z.string().min(1)) },
      { name: 'limit', in: 'query', schema: z.toJSONSchema(z.coerce.number().int().min(1).max(500)) },
    ],
    responses: { '200': { description: 'Nodes and edges, with `truncated` when the node cap was reached', content: jsonContent(MemoryGraph) }, '400': { description: 'An out-of-range limit' }, '401': { description: 'Missing host identity' } },
  } },
  '/v1/memories/explore': { post: {
    description: 'Provider-ranked semantic search, mapped to memories this machine published. Distinct from the list endpoint, which matches body text over a stable scan. Provider hits with no catalog entry are counted in `unregistered` and never returned.',
    parameters: [{ name: 'x-mnemoweave-host', in: 'header', required: true, schema: z.toJSONSchema(z.string().min(1)) }],
    requestBody: { required: true, content: jsonContent(ExploreInput) },
    responses: { '200': { description: 'Ranked hits and the count of unpublished Provider matches', content: jsonContent(ExploreOutput) }, '400': { description: 'Empty query or invalid limit' }, '401': { description: 'Missing host identity' }, '503': { description: 'Provider unavailable' } },
  } },
  '/v1/memories/{memoryId}/withdraw': { post: {
    description: 'Withdraw a published memory. Recall and injection stop serving it; its revisions remain readable. Appends the withdrawal as a new version so every machine stops recalling it.',
    parameters: [{ name: 'memoryId', in: 'path', required: true, schema: z.toJSONSchema(z.uuid()) }],
    requestBody: { required: true, content: jsonContent(MemoryWithdrawInput) },
    responses: { '200': { description: 'Withdrawal recorded', content: jsonContent(MemoryWithdrawOutput) }, '400': { description: 'Invalid input' }, '401': { description: 'Service token rejected or Host identity missing' }, '404': { description: 'Memory not found' }, '409': { description: 'Version conflict, already withdrawn, or the change is queued/unknown' }, '503': { description: 'Provider unavailable' } },
  } },
  '/v1/inject': { post: {
    description: 'One-call Host injection: assemble the immutable View for a session. Identity comes from the x-mnemoweave-host header.',
    parameters: [{ name: 'x-mnemoweave-host', in: 'header', required: true, schema: z.toJSONSchema(z.string().min(1)) }],
    requestBody: { required: true, content: jsonContent(ViewRequest) },
    responses: { '200': { description: 'Immutable View', content: jsonContent(View) }, '401': { description: 'Unauthorized' }, '409': { description: 'Budget exceeded or View unavailable' }, '503': { description: 'Provider unavailable' } },
  } },
  '/v1/events': { post: {
    description: 'Host event intake: normalizes and persists one event with idempotent replay.',
    parameters: [{ name: 'x-mnemoweave-host', in: 'header', required: true, schema: z.toJSONSchema(z.string().min(1)) }],
    requestBody: { required: true, content: jsonContent(HostEvent) },
    responses: { '200': { description: 'Stored, replayed or skipped event id' }, '400': { description: 'Invalid event' }, '409': { description: 'Same event id with different payload' } },
  } },
  '/v1/session/close': { post: {
    description: 'Close one Host session so late results no longer bind to it.',
    parameters: [{ name: 'x-mnemoweave-host', in: 'header', required: true, schema: z.toJSONSchema(z.string().min(1)) }],
    requestBody: { required: true, content: jsonContent(z.object({ sessionId: z.string().min(1).max(256) }).strict()) },
    responses: { '200': { description: 'Session closed' }, '400': { description: 'Invalid input' } },
  } },
});
Object.assign(openapi.components.securitySchemes, { operator: { type: 'http', scheme: 'bearer', description: 'Independent operator token; never pass to model Host' } });

export * from './runtime.ts';

Object.assign(openapi.paths, {
  '/v1/runtime/context': { post: { description: 'Host-scoped bounded provisional working context; never formal memory.', requestBody: { required: true, content: jsonContent(RuntimeContextInput) }, responses: { '200': { description: 'Runtime context, resident pin references and capture status' }, '401': { description: 'Invalid Host or scope' } } } },
  '/v1/runtime/pins': { post: { description: 'Operator-only persistent Global/Project/Host/Session pin configuration.', requestBody: { required: true, content: jsonContent(PinInput) }, responses: { '200': { description: 'Updated' }, '401': { description: 'Operator required' } } } },
  '/v1/sync/status': { get: {
    description: 'View of this local Server\'s sync state with the remote sync Server, per scope: cursor, last pull, last error, pending, unknown and unapplied counts. Served to the operator and, read-only, to a Host that names itself.',
    security: [{ operator: [] }, { bearer: [] }],
    responses: { '200': { description: 'Local sync state', content: jsonContent(SyncStatusOutput) }, '401': { description: 'Operator credential or Host header required' } },
  } },
  '/v1/sync/refresh': { post: {
    description: 'Manual sync pass: resolve unknown submissions, push the outbox, pull and apply each readable scope. Overlapping passes are skipped rather than queued. The operator and a Host that names itself may trigger it.',
    security: [{ operator: [] }, { bearer: [] }],
    responses: { '200': { description: 'Pass result', content: jsonContent(SyncRefreshOutput) }, '401': { description: 'Operator credential or Host header required' } },
  } },
  '/v1/injections/latest': { get: {
    description: 'Operator-only last injection result: rules delivered, whether the rule block was omitted for budget, memories delivered and estimated tokens. 404 means no injection happened yet.',
    security: [{ operator: [] }],
    responses: { '200': { description: 'Last injection', content: jsonContent(InjectionReport) }, '401': { description: 'Operator credential required' }, '404': { description: 'No injection yet' } },
  } },
  '/v1/rules': {
    get: {
      description: 'Rule list for the operator or a Host that names itself. Rules apply to every session; disabled rules are listed, withdrawn ones are not.',
      parameters: [],
      security: [{ operator: [] }, { bearer: [] }],
      responses: { '200': { description: 'Rules', content: jsonContent(RuleList) }, '401': { description: 'Operator credential or Host header required' } },
    },
    post: {
      description: 'Rule creation by the operator or a Host that names itself. Rejects with RULE_BUDGET_EXCEEDED when the applicable rules no longer fit the rule budget; a truncated rule is never stored.',
      security: [{ operator: [] }, { bearer: [] }],
      requestBody: { required: true, content: jsonContent(RuleCreate) },
      responses: { '201': { description: 'Created rule', content: jsonContent(RuleRecord) }, '400': { description: 'Invalid input' }, '401': { description: 'Operator credential or Host header required' }, '409': { description: 'RULE_BUDGET_EXCEEDED' } },
    },
  },
  '/v1/rules/{ruleId}': { patch: {
    description: 'Rule edit by the operator or a Host that names itself; appends a version and re-checks the rule budget. A supplied baseVersion that no longer matches the current version is refused with VERSION_CONFLICT.',
    parameters: [{ name: 'ruleId', in: 'path', required: true, schema: z.toJSONSchema(z.uuid()) }],
    security: [{ operator: [] }, { bearer: [] }],
    requestBody: { required: true, content: jsonContent(RuleEdit) },
    responses: { '200': { description: 'Updated rule', content: jsonContent(RuleRecord) }, '400': { description: 'Invalid input' }, '401': { description: 'Operator credential or Host header required' }, '404': { description: 'Rule not found' }, '409': { description: 'RULE_BUDGET_EXCEEDED or VERSION_CONFLICT' } },
  } },
  '/v1/archives/{entryId}': {
    patch: {
      description: 'Edit an archive using the version read by the editor.',
      parameters: [{ in: 'path', name: 'entryId', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: { required: true, content: jsonContent(ArchiveEdit) },
      responses: { '200': { description: 'Updated archive', content: jsonContent(ArchiveRecord) }, '409': { description: 'Archive version conflict' } },
    },
  },
  '/v1/archives': {
    get: {
      description: 'Project archive read for the operator or a Host that names itself. Without projectId every project is returned; withdrawn entries appear only when asked.',
      parameters: [
        { name: 'projectId', in: 'query', required: false, schema: z.toJSONSchema(z.string().min(1).max(200)) },
        { name: 'includeWithdrawn', in: 'query', required: false, schema: z.toJSONSchema(z.boolean()) },
      ],
      security: [{ operator: [] }, { bearer: [] }],
      responses: { '200': { description: 'Archives', content: jsonContent(ArchiveList) }, '400': { description: 'Invalid input' }, '401': { description: 'Operator credential or Host header required' } },
    },
    post: {
      description: 'Create a project archive from a named Host or with the operator credential.',
      security: [{ operator: [] }],
      requestBody: { required: true, content: jsonContent(ArchiveCreate) },
      responses: { '201': { description: 'Created archive', content: jsonContent(ArchiveRecord) }, '400': { description: 'Invalid input' }, '401': { description: 'Operator credential or Host header required' } },
    },
  },
  '/v1/runtime/projects': { post: { description: 'Operator-only explicit project registration; IDs are never inferred from paths.', requestBody: { required: true, content: jsonContent(z.object({ projectId: z.string().min(1).max(200) }).strict()) }, responses: { '200': { description: 'Registered' }, '401': { description: 'Operator required' } } } },
});
