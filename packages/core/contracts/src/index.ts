import { PinInput, RuntimeContextInput } from './runtime.ts';
import { z } from 'zod';

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
export type ErrorCode = 'INVALID_INPUT' | 'UNAUTHORIZED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_PROTOCOL' | 'PROVIDER_INTEGRITY' | 'PROVIDER_TIMEOUT' | 'UNSUPPORTED_VERSION' | 'REVIEW_REQUIRED' | 'NOT_FOUND' | 'IDEMPOTENCY_CONFLICT' | 'INVALID_STATE' | 'VIEW_BUDGET_EXCEEDED' | 'QUOTA_EXCEEDED' | 'INTERNAL';
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
  scope: z.enum(['project', 'global']).default('project'),
  projectId: z.string().trim().min(1).max(200).optional(),
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
  applicability: z.string(), scope: z.enum(['project', 'global']), projectId: z.string().optional(),
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
  scope: z.enum(['project', 'global']), projectId: z.string().optional(), applicability: z.string(), revisions: z.array(RevisionDescriptor),
  relations: z.array(LogicalRelation).default([]),
  conflicts:z.array(ConflictDescriptor).default([]),
});
export const MemoryIdInput = z.object({ memoryId: z.uuid(), revisionId: z.uuid().optional() }).strict();
export const PublishedMemoryOutput = MemoryDescriptor.extend({ selectedRevisionId: z.uuid(),selectedRevision:RevisionDescriptor, content: z.string() });
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

// ── View, ReadGrant and rerank contracts (ADR-013/014/024, VIEW-01/02, RECALL-01/02) ──
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
  projectId: z.string().optional(),
  scope: z.enum(['project', 'global']), applicability: z.string(),
  content: z.string(), excerpt: z.boolean(), score: z.number().finite().optional(),
  sourceReference: z.string().min(1),
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
  // Logical memory UUID when attributed; the Provider memory id when a mid-assembly state
  // change removed the logical mapping.
  excluded: z.array(z.object({ memoryId: z.string().min(1), reason: z.enum(['not_visible', 'superseded', 'budget', 'grant_scope']) }).strict()),
  complete: z.boolean(), rerank: ViewRerank,
}).strict();
export type ViewRecord = z.infer<typeof View>;
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
    description: 'Process liveness. Still requires the service token: only local non-browser clients are served.',
    responses: { '200': { description: 'Process is live', content: jsonContent(z.object({ live: z.literal(true) }).strict()) }, '401': { description: 'Unauthorized' } },
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
  '/v1/memories/{memoryId}': { get: {
    description: 'Read selected/current published version from authoritative Provider and check content hash.',
    parameters: [{ name: 'memoryId', in: 'path', required: true, schema: z.toJSONSchema(z.uuid()) }, { name: 'revisionId', in: 'query', schema: z.toJSONSchema(z.uuid()) }],
    responses: { '200': { description: 'Published metadata and verified Provider text', content: jsonContent(PublishedMemoryOutput) }, '404': { description: 'Memory/revision not found' }, '503': { description: 'Provider missing or content integrity mismatch' } },
  } },
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
  '/v1/sync/changes': { get: {
    description: 'Bridge sync: ordered incremental window after ?since=<seq>; identity from the paired host header.',
    parameters: [{ name: 'since', in: 'query', required: true, schema: { type: 'integer', minimum: -1 } }],
    responses: { '200': { description: 'Ordered change batch with cursor window bounds' }, '401': { description: 'Unpaired host or bad token' } },
  } },
  '/v1/sync/snapshot': { get: {
    description: 'Bridge sync: curated snapshot SQLite file (replica-scope only) with an embedded SHA-256 manifest.',
    responses: { '200': { description: 'Snapshot file bytes; x-sync-latest-seq header carries the cursor' }, '401': { description: 'Unpaired host or bad token' } },
  } },
  '/v1/sync/verify': { get: {
    description: 'Bridge sync: per-memory partition summaries for the 72-hour full verification.',
    responses: { '200': { description: 'Partition summaries' }, '401': { description: 'Unpaired host or bad token' } },
  } },
  '/v1/sync/watermark': { get: {
    description: 'Bridge sync: revocation watermark and host revocation state (AUTH-02).',
    responses: { '200': { description: 'Watermark and revocation state' }, '401': { description: 'Unpaired host or bad token' } },
  } },
  '/v1/sync/grant': {
    get: {
      description: 'Bridge pairing: fetch the issued grant for this host; pairing itself is an operator action (AUTH-04).',
      responses: { '200': { description: 'Issued grant' }, '401': { description: 'Unpaired host or bad token' }, '404': { description: 'No grant issued yet' } },
    },
    post: {
      description: 'Operator-only pairing: issue a per-host read grant (AUTH-04/05).',
      security: [{ operator: [] }],
      responses: { '200': { description: 'Issued grant' }, '401': { description: 'Operator credential required' } },
    },
  },
  '/v1/sync/revoke': { post: {
    description: 'Operator-only revocation: stops reads immediately; replica and intents are kept (AUTH-02).',
    security: [{ operator: [] }],
    responses: { '200': { description: 'Revocation applied' }, '401': { description: 'Operator credential required' } },
  } },
  '/v1/sync/intents': { post: {
    description: 'Bridge offline intent intake: the server re-validates identity and review; remember/version/relation intents become candidates, never direct writes (AUTH-03).',
    responses: { '200': { description: 'Accepted (with reference) or isolated' }, '401': { description: 'Unpaired host or bad token' } },
  } },
});
Object.assign(openapi.components.securitySchemes, { operator: { type: 'http', scheme: 'bearer', description: 'Independent operator token; never pass to model Host' } });

export * from './runtime.ts';

Object.assign(openapi.paths, {
  '/v1/runtime/context': { post: { description: 'Host-scoped bounded provisional working context; never formal memory.', requestBody: { required: true, content: jsonContent(RuntimeContextInput) }, responses: { '200': { description: 'Runtime context, resident pin references and capture status' }, '401': { description: 'Invalid Host or scope' } } } },
  '/v1/runtime/pins': { post: { description: 'Operator-only persistent Global/Project/Host/Session pin configuration.', requestBody: { required: true, content: jsonContent(PinInput) }, responses: { '200': { description: 'Updated' }, '401': { description: 'Operator required' } } } },
  '/v1/runtime/projects': { post: { description: 'Operator-only explicit project registration; IDs are never inferred from paths.', requestBody: { required: true, content: jsonContent(z.object({ projectId: z.string().min(1).max(200) }).strict()) }, responses: { '200': { description: 'Registered' }, '401': { description: 'Operator required' } } } },
});
