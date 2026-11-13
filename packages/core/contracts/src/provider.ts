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
  /**
   * Retrieval mode. `smart` is the intent-aware ranking, `keyword` the token-scored `search`
   * command, and `basic` plain SQL LIKE. The three answer differently, so the caller picks rather
   * than the adapter guessing.
   */
  mode: z.enum(['smart', 'keyword', 'basic']).optional(),
  /** Keep only rows of this classification, filtered by the Provider. */
  category: z.string().trim().min(1).max(100).optional(),
  /** Keep only rows this provenance source wrote, filtered by the Provider. */
  source: z.string().trim().min(1).max(200).optional(),
}).strict();
export const Memory = z.object({
  id: z.string().min(1), content: z.string(), score: z.number().finite().optional(), superseded: z.boolean().optional(),
  /**
   * The logical memory id the Provider hit belongs to, when the Server can map it. A model tool
   * needs this to open the body: `id` is the Provider's own identifier.
   */
  memoryId: z.string().min(1).optional(),
  /**
   * What the Provider said about the row. These are carried through rather than dropped: a list
   * that hides classification makes the caller filter in memory over a page it did not ask for,
   * and a score without its relevance band cannot be compared across Providers.
   */
  category: z.string().optional(),
  importance: z.number().int().min(1).max(5).optional(),
  tags: z.array(z.string()).optional(),
  entities: z.array(z.string()).optional(),
  source: z.string().optional(),
  confidence: z.string().optional(),
});
export const RecallOutput = z.object({ memories: z.array(Memory), complete: z.boolean().optional() });
export type RecallRequest = z.infer<typeof RecallInput>;
export type RecallResult = z.infer<typeof RecallOutput>;

/**
 * What the Provider reports about its store as a whole.
 *
 * Every field comes from the Provider's own accounting. `topEntities` is the frequency table the
 * store maintains, not a recount of whatever page the caller happens to be looking at, so the
 * entity view and the list agree even when the list is filtered or paged.
 */
export const ProviderStats = z.object({
  totalInsights: z.number().int().nonnegative(),
  deletedInsights: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
  byCategory: z.record(z.string(), z.number().int().nonnegative()),
  /** Most frequent entity names with how many memories name them, already ordered by count. */
  topEntities: z.array(z.object({ entity: z.string().min(1), count: z.number().int().nonnegative() })),
});
export type ProviderStatsRecord = z.infer<typeof ProviderStats>;

/** One edge of the Provider's own graph, with the type the Provider assigned it. */
export const ProviderGraphEdge = z.object({
  sourceId: z.string().min(1),
  targetId: z.string().min(1),
  /** The Provider's own label: `entity`, `backbone`, and whatever else it emits. */
  label: z.string(),
});
export const ProviderGraph = z.object({
  nodes: z.array(z.object({ id: z.string().min(1), label: z.string() })),
  edges: z.array(ProviderGraphEdge),
  /** True when the read hit a cap, so the caller can say the picture is partial. */
  truncated: z.boolean(),
});
export type ProviderGraphRecord = z.infer<typeof ProviderGraph>;

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
