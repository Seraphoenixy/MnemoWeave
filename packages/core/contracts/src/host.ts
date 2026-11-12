import { z } from 'zod';
import { RULE_CAPACITY_BYTES } from './capacity.ts';

/**
 * Host admission and injection.
 *
 * The only thing a host receives at prompt-assembly time is the complete set of visible enabled
 * rules. There is no aggregate View, no session projection and no per-turn memory selection:
 * archives and formal memories are read through tools when a task needs them.
 */

export const RuleInjectionItem = z.object({
  entryId: z.uuid(),
  version: z.number().int().positive(),
  body: z.string().min(1),
  importance: z.enum(['critical', 'normal', 'low']).optional(),
  bodyBytes: z.number().int().positive(),
}).strict();
export type RuleInjectionItemRecord = z.infer<typeof RuleInjectionItem>;

/**
 * What one injection delivered. `complete` is false only when the host could not deliver every
 * rule whole (output limit, failed request or deadline); a partial set is never delivered in
 * place of it.
 */
export const InjectionOutput = z.object({
  hostId: z.string().min(1),
  sessionId: z.string().min(1).max(256),
  rules: z.array(RuleInjectionItem),
  usedBytes: z.number().int().nonnegative(),
  limitBytes: z.number().int().positive(),
  complete: z.boolean(),
  createdAt: z.iso.datetime(),
}).strict();
export type InjectionRecord = z.infer<typeof InjectionOutput>;

export const InjectionReport = z.object({
  id: z.uuid(), hostId: z.string().min(1), sessionId: z.string().min(1),
  ruleCount: z.number().int().nonnegative(),
  usedBytes: z.number().int().nonnegative(),
  /** Why delivery failed; absent on a complete delivery. */
  failure: z.enum(['deadline', 'output_limit', 'request_failed']).optional(),
  createdAt: z.iso.datetime(),
}).strict();
export type InjectionReportRecord = z.infer<typeof InjectionReport>;

/** The request only names the session; host identity comes from the header. */
export const InjectRequest = z.object({
  sessionId: z.string().min(1).max(256),
}).strict();
export type InjectRequestInput = z.infer<typeof InjectRequest>;

export const RULE_INJECTION_LIMIT_BYTES = RULE_CAPACITY_BYTES;

// ── Host events and idle-review signals ──
export const HostEventKind = z.enum(['session.started', 'session.ended', 'message.user', 'message.assistant.final', 'tool.completed']);
export const HostEvent = z.object({
  protocolVersion: z.string().regex(/^\d+(\.\d+){0,2}$/), adapterVersion: z.string().min(1),
  eventId: z.string().min(8).max(128),
  sessionId: z.string().min(1).max(256), turnId: z.string().min(1).max(256).optional(),
  kind: HostEventKind,
  occurredAt: z.iso.datetime(), receivedAt: z.iso.datetime(),
  sourceRef: z.string().min(1).max(2000),
  payload: z.object({
    text: z.string().max(20000).optional(),
    toolName: z.string().min(1).max(500).optional(),
    toolKind: z.string().min(1).max(200).optional(),
    outcome: z.enum(['success', 'failure']).optional(),
    candidateId: z.uuid().optional(),
    /** A `no-retention` request covers only the turn that carries it. */
    noRetention: z.literal(true).optional(),
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
  eventId: string; hostId: string; sessionId: string; turnId: string | null;
  kind: z.infer<typeof HostEventKind>; occurredAt: string; receivedAt: string; sourceRef: string;
  adapterVersion: string; protocolVersion: string; stage: 'hot' | 'archived' | 'cleared';
  important: boolean; protectedReason: string | null; archivedAt: string | null; inferred: boolean;
  payload: { text?: string; toolName?: string; toolKind?: string; outcome?: 'success' | 'failure'; candidateId?: string; noRetention?: true };
};

export type RetentionSweepReport = {
  archivedEvents: number; clearedEvents: number; protectedEvents: number;
  clearedCandidates: number; deferredCandidates: { candidateId: string; reason: string }[];
  planSkewMs: { events: number; candidates: number };
};

// ── Idle review ──
export const IdleReviewScanInput = z.object({
  sessionId: z.string().min(1).max(256),
  /** Highest completed turn the Host vouches for; later turns are not read. */
  completedThroughTurn: z.number().int().nonnegative(),
  maxSignals: z.number().int().min(1).max(50).default(20),
}).strict();
export const IdleReviewSignal = z.object({
  id: z.uuid(), sessionId: z.string().min(1), turnId: z.number().int().nonnegative(),
  eventId: z.string().min(1), text: z.string().min(1),
  reason: z.enum(['correction', 'standing-instruction', 'durable-fact']), createdAt: z.iso.datetime(),
}).strict();
export type IdleReviewSignalRecord = z.infer<typeof IdleReviewSignal>;
export const IdleReviewScanOutput = z.object({
  signals: z.array(IdleReviewSignal),
  lastTurn: z.number().int().nonnegative(),
  skipped: z.object({
    tooShort: z.number().int().nonnegative(), question: z.number().int().nonnegative(),
    noTurn: z.number().int().nonnegative(), outOfWindow: z.number().int().nonnegative(),
    duplicate: z.number().int().nonnegative(),
    /** Turns the user marked "do not retain": excluded from scoring and from evidence. */
    noRetention: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export type IdleReviewScanRecord = z.infer<typeof IdleReviewScanOutput>;
export const IdleReviewSignalsOutput = z.object({ items: z.array(IdleReviewSignal) }).strict();
/** One item result reported by the task Agent; the writes themselves already happened. */
export const IdleReviewRunItem = z.object({
  index: z.number().int().min(0).max(63),
  action: z.enum(['create', 'edit', 'remove', 'skip']),
  kind: z.enum(['rule', 'workspace-archive', 'formal-memory']).default('formal-memory'),
  state: z.enum(['applied', 'failed', 'skipped']),
  targetId: z.string().min(1).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type IdleReviewRunItemRecord = z.infer<typeof IdleReviewRunItem>;
export const IdleReviewRun = z.object({
  id: z.uuid(), sessionId: z.string().min(1),
  state: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  attempt: z.number().int().positive(),
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable(), error: z.string().nullable(),
  items: z.array(IdleReviewRunItem),
}).strict();
export type IdleReviewRunRecord = z.infer<typeof IdleReviewRun>;
export const IdleReviewRunStartInput = z.object({
  sessionId: z.string().min(1).max(256),
  maxSignals: z.number().int().min(1).max(50).default(10),
}).strict();
export const IdleReviewRunStartOutput = z.object({ run: IdleReviewRun, signals: z.array(IdleReviewSignal) }).strict();
export const IdleReviewRunsOutput = z.object({ items: z.array(IdleReviewRun) }).strict();
export const IdleReviewPendingOutput = z.object({
  sessions: z.array(z.object({ sessionId: z.string().min(1), count: z.number().int().positive() }).strict()),
}).strict();
export type IdleReviewPendingRecord = z.infer<typeof IdleReviewPendingOutput>;
export const IdleReviewRunFinishInput = z.object({
  state: z.enum(['succeeded', 'failed', 'cancelled']),
  error: z.string().trim().min(1).max(500).optional(),
}).strict();
