import { z } from 'zod'

export const WORKING_RULES_ACTIVITY_SCOPE = 'activity-working-rules'
export const WORKSPACE_ACTIVITY_PREFIX = 'activity-workspace-'

export function isActivityScope(scope: string): boolean {
  return scope === WORKING_RULES_ACTIVITY_SCOPE || /^activity-workspace-[a-f0-9]{64}$/u.test(scope)
}

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const activityId = z.string().regex(/^[a-f0-9]{64}$/u)
const base = {
  version: z.literal(1),
  id: activityId,
  at: count.optional(),
  session: activityId.optional(),
  parentSession: activityId.optional(),
  turn: count.optional(),
}
export const activityEvent = z.discriminatedUnion('kind', [
  z.strictObject({
    ...base, kind: z.literal('memory'),
    source: z.enum(['runtime', 'documents', 'memory-spaces']),
    trigger: z.literal('manual-save').optional(),
    operation: z.enum(['recall', 'related', 'search', 'read-working-rules', 'append-working-rules', 'mutate', 'manage', 'remember', 'link', 'forget', 'create', 'update', 'merge', 'manage-spaces']),
    outcome: z.enum(['returned', 'empty', 'skipped', 'committed', 'unconfirmed', 'failed', 'unknown']),
    skipReason: z.enum(['budget', 'not-run', 'unavailable']).optional(),
    replayed: z.literal(true).optional(),
    results: count.optional(),
    records: z.array(activityId).max(16).optional(),
    durationMs: count.optional(),
  }),
  z.strictObject({
    ...base, kind: z.literal('subagent'),
    operation: z.enum(['write', 'answer', 'review', 'placement', 'migration', 'compaction', 'document-archive', 'metadata-maintenance', 'reconcile', 'skill']),
    childSession: activityId.optional(),
    outcome: z.enum(['completed', 'skipped', 'failed', 'cancelled']),
    trigger: z.enum(['manual-save', 'automatic-distillation']).optional(),
    skipReason: z.enum(['no-writable-target', 'agent-team', 'fork-unavailable', 'no-qualifying-write']).optional(),
    durationMs: count,
    committedWrites: count,
    usage: z.strictObject({ uncachedInputTokens: count, outputTokens: count, cacheReadTokens: count, cacheWriteTokens: count }).optional(),
  }),
  /**
   * A clear ends the activity a person no longer wants: every event recorded at
   * or before `before` stops being kept, on this machine and on the server. The
   * record itself is one small event, so clearing a long stream costs one batch
   * rather than a growing list of the events it removed.
   */
  z.strictObject({
    ...base, kind: z.literal('clear'),
    before: count,
  }),
])

export type ActivityEvent = z.infer<typeof activityEvent>
export type MemoryActivityEvent = Extract<ActivityEvent, { kind: 'memory' }>
export type SubagentActivityEvent = Extract<ActivityEvent, { kind: 'subagent' }>
export type ClearActivityEvent = Extract<ActivityEvent, { kind: 'clear' }>

/** Whether one change carries a clear, which compacts the stream it was pushed to. */
export function isActivityClear(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'clear'
}
