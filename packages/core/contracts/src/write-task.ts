import { z } from 'zod';
import { Category } from './catalog.ts';
import { RuleImportance, WorkspaceId } from './workspace.ts';
import { Provenance } from './catalog.ts';

/**
 * Authorized write tasks.
 *
 * A path carries a host-persisted task UUID and a zero-based action index; the Server derives
 * the idempotency key from `(hostId, taskId, index)` and refuses the same key with a different
 * payload. The entry point is for trusted host code only and is never registered as a model
 * tool: a model proposes a plan, the host validates it, the Server checks it again.
 */

export const WriteTaskKind = z.enum(['formal-memory', 'rule', 'workspace-archive']);
export const WriteTaskTrigger = z.enum(['conversation', 'organize', 'reply-save', 'archive-distill', 'idle-review']);
export const FormalMemoryAction = z.enum(['create', 'edit', 'withdraw', 'skip']);
export const RuleAction = z.enum(['create', 'edit', 'remove', 'skip']);
export const WorkspaceArchiveAction = z.enum(['create', 'edit', 'skip']);

const reason = z.string().trim().min(1).max(500);
const evidenceRefs = z.array(z.string().trim().min(1).max(500)).min(1).max(12);
const classification = {
  category: Category.optional(),
  importance: z.number().int().min(1).max(5).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  entities: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
};
const formalBody = z.string().refine(
  value => value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 8000,
  'Content must contain 1–8000 UTF-8 bytes',
);

/** `formal-memory` action: create, edit, withdraw or skip. */
export const FormalMemoryTaskAction = z.object({
  kind: z.literal('formal-memory'),
  trigger: WriteTaskTrigger,
  sessionId: z.string().min(1).max(256).optional(),
  turnId: z.string().min(1).max(256).optional(),
  action: FormalMemoryAction,
  reason,
  evidenceRefs: evidenceRefs.optional(),
  assessment: z.enum(['supported', 'uncertain', 'conflict']).optional(),
  memoryId: z.uuid().optional(),
  entryVersion: z.number().int().nonnegative().optional(),
  content: formalBody.optional(),
  ...classification,
  draftId: z.uuid().optional(),
}).strict().superRefine((value, context) => {
  const isWrite = value.action === 'create' || value.action === 'edit';
  const needsTarget = value.action === 'edit' || value.action === 'withdraw';
  if (value.draftId !== undefined) {
    // Archive distillation: the confirmed draft supplies body and classification.
    if (value.trigger !== 'archive-distill') context.addIssue({ code: 'custom', message: 'draftId is only for archive distillation' });
    if (value.action !== 'create') context.addIssue({ code: 'custom', message: 'A distilled draft only creates' });
    if (value.sessionId !== undefined || value.turnId !== undefined) context.addIssue({ code: 'custom', message: 'Archive distillation carries no session or turn' });
    // The draft is the single source of the body and classification; supplying either here would
    // publish text that was never previewed.
    for (const field of ['content', 'category', 'importance', 'tags', 'entities'] as const) {
      if (value[field] !== undefined) context.addIssue({ code: 'custom', message: `a distilled draft supplies ${field}` });
    }
  } else {
    if (needsTarget && value.memoryId === undefined) context.addIssue({ code: 'custom', message: `${value.action} requires memoryId` });
    if (needsTarget && value.entryVersion === undefined) context.addIssue({ code: 'custom', message: `${value.action} requires entryVersion` });
    if (!needsTarget && value.memoryId !== undefined) context.addIssue({ code: 'custom', message: `${value.action} forbids memoryId` });
    if (!needsTarget && value.entryVersion !== undefined) context.addIssue({ code: 'custom', message: `${value.action} forbids entryVersion` });
    if (isWrite && value.content === undefined) context.addIssue({ code: 'custom', message: `${value.action} requires content` });
    if (!isWrite && value.content !== undefined) context.addIssue({ code: 'custom', message: `${value.action} forbids content` });
    // Only a write needs an assessment: a withdrawal has nothing to judge.
    if (isWrite && value.assessment === undefined) context.addIssue({ code: 'custom', message: 'create and edit require an assessment' });
    if (!isWrite && value.assessment !== undefined) context.addIssue({ code: 'custom', message: `${value.action} forbids assessment` });
  }
  if (value.action !== 'skip' && value.evidenceRefs === undefined) context.addIssue({ code: 'custom', message: `${value.action} requires evidenceRefs` });
  if (value.action === 'skip' && value.evidenceRefs !== undefined) context.addIssue({ code: 'custom', message: 'skip does not carry evidence' });
});
export type FormalMemoryTaskActionRecord = z.infer<typeof FormalMemoryTaskAction>;

/** `rule` action: one rule change; the body and metadata follow the resource contracts. */
export const RuleTaskAction = z.object({
  kind: z.literal('rule'),
  trigger: z.enum(['conversation', 'idle-review']),
  sessionId: z.string().min(1).max(256).optional(),
  turnId: z.string().min(1).max(256).optional(),
  runId: z.uuid().optional(),
  action: RuleAction,
  reason,
  evidenceRefs: evidenceRefs.optional(),
  entryId: z.uuid().optional(),
  baseVersion: z.number().int().positive().optional(),
  body: z.string().trim().min(1).max(8 * 1024).optional(),
  enabled: z.boolean().optional(),
  importance: RuleImportance.optional(),
  pinned: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  const needsTarget = value.action === 'edit' || value.action === 'remove';
  if (needsTarget && (value.entryId === undefined || value.baseVersion === undefined)) context.addIssue({ code: 'custom', message: `${value.action} requires entryId and baseVersion` });
  if (!needsTarget && (value.entryId !== undefined || value.baseVersion !== undefined)) context.addIssue({ code: 'custom', message: `${value.action} forbids entryId and baseVersion` });
  if (value.action === 'create' && value.body === undefined) context.addIssue({ code: 'custom', message: 'create requires a body' });
  if (value.action === 'edit' && [value.body, value.enabled].every(item => item === undefined)) context.addIssue({ code: 'custom', message: 'edit requires at least one change' });
  if (value.action === 'remove' && [value.body, value.enabled, value.importance, value.pinned].some(item => item !== undefined)) context.addIssue({ code: 'custom', message: 'remove is exclusive with editing' });
  if (value.trigger === 'idle-review' && value.runId === undefined) context.addIssue({ code: 'custom', message: 'idle-review requires runId' });
});
export type RuleTaskActionRecord = z.infer<typeof RuleTaskAction>;

/** `workspace-archive` action: the target workspace comes from the session binding, never the input. */
export const WorkspaceArchiveTaskAction = z.object({
  kind: z.literal('workspace-archive'),
  trigger: z.enum(['conversation', 'idle-review']),
  sessionId: z.string().min(1).max(256).optional(),
  turnId: z.string().min(1).max(256).optional(),
  runId: z.uuid().optional(),
  action: WorkspaceArchiveAction,
  reason,
  evidenceRefs: evidenceRefs.optional(),
  entryId: z.uuid().optional(),
  baseVersion: z.number().int().positive().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().trim().min(1).optional(),
  source: z.enum(['session', 'tool', 'user']).optional(),
  verification: z.enum(['verified', 'open', 'refuted']).optional(),
  evidence: z.string().trim().min(1).max(2000).optional(),
  /** Rejected explicitly: the session binding decides the workspace. */
  workspaceId: z.never().optional(),
}).strict().superRefine((value, context) => {
  const needsTarget = value.action === 'edit';
  if (needsTarget && (value.entryId === undefined || value.baseVersion === undefined)) context.addIssue({ code: 'custom', message: 'edit requires entryId and baseVersion' });
  if (!needsTarget && (value.entryId !== undefined || value.baseVersion !== undefined)) context.addIssue({ code: 'custom', message: `${value.action} forbids entryId and baseVersion` });
  if (value.action === 'create' && (value.title === undefined || value.body === undefined)) context.addIssue({ code: 'custom', message: 'create requires title and body' });
  if (value.action === 'edit' && [value.title, value.body, value.verification, value.evidence].every(item => item === undefined)) context.addIssue({ code: 'custom', message: 'edit requires at least one change' });
  if (value.trigger === 'idle-review' && value.runId === undefined) context.addIssue({ code: 'custom', message: 'idle-review requires runId' });
});
export type WorkspaceArchiveTaskActionRecord = z.infer<typeof WorkspaceArchiveTaskAction>;

export const WriteTaskAction = z.discriminatedUnion('kind', [FormalMemoryTaskAction, RuleTaskAction, WorkspaceArchiveTaskAction]);
export type WriteTaskActionRecord = z.infer<typeof WriteTaskAction>;

/**
 * Receipt status. `published` and `duplicate` carry a logical memory id and version; rule and
 * archive success is `applied` with `entryId` and `version`. `needs_review` carries a candidate
 * id; `queued`, `unknown` and `failed` carry an error code.
 */
export const WriteTaskStatus = z.enum(['published', 'duplicate', 'applied', 'skipped', 'needs_review', 'queued', 'unknown', 'failed']);

export const WriteTaskReceipt = z.object({
  taskId: z.uuid(),
  index: z.number().int().min(0),
  kind: WriteTaskKind,
  action: z.enum(['create', 'edit', 'withdraw', 'remove', 'skip']),
  status: WriteTaskStatus,
  memoryId: z.uuid().nullable(),
  entryVersion: z.number().int().positive().nullable(),
  entryId: z.uuid().nullable(),
  candidateId: z.uuid().nullable(),
  errorCode: z.string().min(1).nullable(),
  updatedAt: z.iso.datetime(),
}).strict();
export type WriteTaskReceiptRecord = z.infer<typeof WriteTaskReceipt>;

// ── Archive distillation ──

export const ArchiveDistillationCreate = z.object({
  source: z.object({
    workspaceId: WorkspaceId,
    entryId: z.uuid(),
    entryVersion: z.number().int().positive(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  content: formalBody,
  category: Category.optional(),
  importance: z.number().int().min(1).max(5).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  entities: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  reason: z.string().trim().min(1).max(2000),
  assessment: z.enum(['supported', 'uncertain', 'conflict']),
}).strict();
export type ArchiveDistillationCreateInput = z.infer<typeof ArchiveDistillationCreate>;

export const ArchiveDistillationRecord = z.object({
  draftId: z.uuid(),
  source: z.object({
    workspaceId: WorkspaceId,
    entryId: z.uuid(),
    entryVersion: z.number().int().positive(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  content: z.string(),
  category: Category.optional(),
  importance: z.number().int().min(1).max(5).optional(),
  tags: z.array(z.string()).optional(),
  entities: z.array(z.string()).optional(),
  reason: z.string(),
  assessment: z.enum(['supported', 'uncertain', 'conflict']),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
  /** Set once a confirmed draft has an accepted write task. */
  taskId: z.uuid().nullable(),
}).strict();
export type ArchiveDistillationRecordValue = z.infer<typeof ArchiveDistillationRecord>;

/** Engineering evidence a host attaches to a conversation write. */
export const EvidenceRecordInput = z.object({
  kind: z.enum(['user-event', 'tool-result', 'source-read', 'test-run']),
  ref: z.string().min(1).max(2000),
  summary: z.string().min(1).max(2000),
  detail: z.string().max(20_000).optional(),
  turnId: z.string().min(1).max(256).optional(),
}).strict();
export type EvidenceRecordInputRecord = z.infer<typeof EvidenceRecordInput>;

export const ProvenanceInput = Provenance;
