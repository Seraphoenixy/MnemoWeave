import { z } from 'zod';
import { RECALL_LIMIT_DEFAULT, RECALL_LIMIT_MAX } from './capacity.ts';

/**
 * Recall over the one shared formal-memory collection.
 *
 * There is no project or workspace parameter. A host may append the current workspace name to
 * the query as a relevance hint; it changes what the Provider ranks, never what the caller may
 * read. `Memory` is the Provider-facing row shape, not a catalog record.
 */
export const RecallInput = z.object({
  query: z.string().trim().min(1).max(2000),
  limit: z.number().int().min(1).max(RECALL_LIMIT_MAX).default(RECALL_LIMIT_DEFAULT),
}).strict();
export const Memory = z.object({
  id: z.string().min(1), content: z.string(), score: z.number().finite().optional(), superseded: z.boolean().optional(),
  /**
   * The logical memory id the Provider hit belongs to, when the Server can map it. A model tool
   * needs this to open the body: `id` is the Provider's own identifier.
   */
  memoryId: z.string().min(1).optional(),
});
export const RecallOutput = z.object({ memories: z.array(Memory), complete: z.boolean().optional() });
export type RecallRequest = z.infer<typeof RecallInput>;
export type RecallResult = z.infer<typeof RecallOutput>;

export const ProviderHealth = z.object({
  ready: z.literal(true), version: z.literal('0.2.13'),
  capabilities: z.array(z.enum(['health', 'recall', 'remember'])),
});
export type Health = z.infer<typeof ProviderHealth>;

/** What the Provider can report about its embedding backend, before any interpretation. */
export const ProviderEmbeddingStatus = z.object({
  serviceAvailable: z.boolean(),
  modelAvailable: z.boolean(),
  protocol: z.string().min(1),
  model: z.string().min(1),
  embedded: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).strict();
export type ProviderEmbeddingStatusRecord = z.infer<typeof ProviderEmbeddingStatus>;

/** One durable maintenance job; the Provider work itself runs in the Server process. */
export const DiagnosticJob = z.object({
  id: z.uuid(),
  kind: z.string().min(1),
  state: z.enum(['running', 'succeeded', 'failed', 'interrupted']),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  detail: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type DiagnosticJobRecord = z.infer<typeof DiagnosticJob>;

/**
 * Recall diagnosis for the status page. `unknown` means the interface could not answer: it is a
 * statement about coverage, not an assertion that recall is broken.
 */
export const EmbeddingDiagnostics = z.object({
  provider: z.literal('mnemon'),
  model: z.string().min(1),
  protocol: z.string().min(1),
  serviceAvailable: z.boolean(),
  modelAvailable: z.boolean(),
  embedded: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  coverage: z.number().min(0).max(1),
  recallMode: z.enum(['semantic', 'keyword', 'unknown']),
  degraded: z.boolean(),
  lastError: z.string().nullable(),
  checkedAt: z.iso.datetime(),
  /** Latest vector backfill job, when one has ever run. */
  backfill: DiagnosticJob.nullable().optional(),
}).strict();
export type EmbeddingDiagnosticsRecord = z.infer<typeof EmbeddingDiagnostics>;
