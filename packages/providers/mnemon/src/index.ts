import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { MnemoWeaveError } from '../../../core/contracts/src/index.ts';
import type { Health, ProviderEmbeddingStatusRecord, ProviderGraphRecord, ProviderStatsRecord, RecallRequest, RecallResult } from '../../../core/contracts/src/index.ts';
import type { MemoryProvider } from '../../../core/application/src/index.ts';

export type Runner = (args: string[]) => Promise<string>;
/**
 * `binary` is whatever the environment already provides: a bare command name resolved
 * through PATH (the default) or an explicit path. Nothing is resolved relative to the repo.
 */
export function createRunner(binary: string, timeout = 15000, maxBuffer = 2 * 1024 * 1024): Runner {
  if (!binary.trim()) throw new Error('MNEMON_BINARY must name a command');
  return args => new Promise((resolve, reject) => {
    execFile(binary, args, { shell: false, windowsHide: true, timeout, maxBuffer, encoding: 'utf8', env: { ...process.env, MNEMON_MAX_INSIGHTS: '0' } }, (error, stdout) => {
      if (error) {
        reject(new MnemoWeaveError(error.killed ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE'));
      } else resolve(stdout);
    });
  });
}
const NativeInsightRow = z.object({
  id: z.string().min(1), content: z.string(), score: z.number().finite().optional(), superseded: z.boolean().optional(),
  category: z.string().optional(), importance: z.number().int().optional(),
  tags: z.array(z.string()).optional(), entities: z.array(z.string()).optional(),
  source: z.string().optional(), confidence: z.string().optional(),
}).passthrough();
/**
 * `recall --verbose` wraps the row it used to return flat: `{insight: {id, content, ...}, score,
 * via, signals}`. `signals.similarity` is the vector similarity, which is the only calibrated
 * relevance the Provider reports; a store with no embeddings reports it as 0.
 */
const NativeSemanticRow = z.object({
  insight: z.object({
    id: z.string().min(1), content: z.string(),
    category: z.string().optional(), importance: z.number().int().optional(),
    tags: z.array(z.string()).optional(), entities: z.array(z.string()).optional(),
    source: z.string().optional(), created_at: z.string().optional(),
  }).passthrough(),
  score: z.number().finite().optional(), superseded: z.boolean().optional(),
  intent: z.string().optional(), via: z.string().optional(), confidence: z.string().optional(),
  signals: z.object({ similarity: z.number().finite().optional() }).passthrough().optional(),
}).passthrough();
/**
 * `recall` wraps its rows in `{results}`, while `search` returns a bare array. Both are official
 * shapes, so one decoder accepts either rather than the caller having to know which command ran.
 */
const NativeRecall = z.union([
  z.object({ results: z.array(z.unknown()) }),
  z.array(z.unknown()).transform((rows): { results: unknown[] } => ({ results: rows })),
]);
/** One decoded recall row: the body this Server keeps, plus what the row says about relevance. */
interface RecallRow {
  memory: NonNullable<RecallResult['memories']>[number];
  similarity: number | undefined;
  superseded: boolean;
}
/**
 * Decode one recall row from either official shape.
 *
 * A row that names no id or body is a shape this adapter does not know, so it fails the read
 * instead of disappearing from a page that would then look complete.
 */
function decodeRecallRow(value: unknown): RecallRow {
  const semantic = NativeSemanticRow.safeParse(value);
  if (semantic.success) {
    const row = semantic.data;
    const { created_at: _createdAt, ...insight } = row.insight;
    const memory: NonNullable<RecallResult['memories']>[number] = { ...insight };
    if (row.score !== undefined) memory.score = row.score;
    if (row.confidence !== undefined) memory.confidence = row.confidence;
    return { memory, similarity: row.signals?.similarity, superseded: row.superseded === true };
  }
  const flat = NativeInsightRow.safeParse(value);
  if (!flat.success) throw new MnemoWeaveError('PROVIDER_PROTOCOL');
  return { memory: { ...flat.data }, similarity: undefined, superseded: flat.data.superseded === true };
}
/**
 * How many candidates a semantic recall asks the Provider for.
 *
 * The CLI truncates by its fused score before any quality policy runs, so the pool is widened
 * beyond the page the caller wants; without that, a page of 10 could only ever be re-ranked out of
 * the Provider's own top 10.
 */
function recallCandidateLimit(limit: number): number {
  return Math.max(limit, Math.min(50, Math.max(20, limit * 4)));
}
/**
 * The whole-store read returns a bare array, while a limited read wraps it in `{results}`. Both
 * shapes appear in the CLI, so the decode accepts either instead of failing on one.
 */
const NativeAllInsights = z.union([
  z.array(NativeInsightRow),
  z.object({ results: z.array(NativeInsightRow) }).transform(value => value.results),
]);
/**
 * `status` is the Provider's own accounting. `top_entities` is the frequency table it maintains,
 * which is why the entity view reads it instead of recounting a page.
 */
const NativeStatus = z.object({
  total_insights: z.number().int().nonnegative(),
  deleted_insights: z.number().int().nonnegative().optional(),
  edge_count: z.number().int().nonnegative().optional(),
  by_category: z.record(z.string(), z.number().int().nonnegative()).optional(),
  top_entities: z.array(z.object({ entity: z.string().min(1), count: z.number().int().nonnegative() })).optional(),
}).passthrough();
/**
 * How many edges one graph read may return.
 *
 * The official export has no cursor, so a store large enough to exceed this is reported as
 * truncated rather than silently cut: a picture that is missing edges must say so.
 */
const PROVIDER_GRAPH_EDGE_LIMIT = 2000;
/**
 * Parse the DOT export `mnemon viz --format dot` writes.
 *
 * Only the two statement shapes that carry meaning are read: a node line and an edge line. Labels
 * are unescaped from the quoted form and the rest of the attributes are ignored, because the
 * caller draws its own styles and only needs to know what connects to what.
 */
function parseDotGraph(dot: string, edgeLimit: number): { nodes: { id: string; label: string }[]; edges: { sourceId: string; targetId: string; label: string }[]; truncated: boolean } {
  const nodes = new Map<string, string>();
  const edges: { sourceId: string; targetId: string; label: string }[] = [];
  let truncated = false;
  const unquote = (value: string): string => value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  for (const rawLine of dot.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('digraph') || line === '{' || line === '}') continue;
    // `"a" -> "b" [label="entity", ...]`
    const edge = /^"((?:[^"\\]|\\.)*)"\s*->\s*"((?:[^"\\]|\\.)*)"\s*(?:\[(.*)\])?;?$/.exec(line);
    if (edge !== null) {
      if (edges.length >= edgeLimit) { truncated = true; continue; }
      const attributes = edge[3] ?? '';
      const labelMatch = /label="((?:[^"\\]|\\.)*)"/.exec(attributes);
      edges.push({
        sourceId: unquote(edge[1]!), targetId: unquote(edge[2]!),
        label: labelMatch === null ? '' : unquote(labelMatch[1]!),
      });
      continue;
    }
    // `"id" [label="...", fillcolor="..."];`
    const node = /^"((?:[^"\\]|\\.)*)"\s*(?:\[(.*)\])?;?$/.exec(line);
    if (node !== null) {
      const attributes = node[2] ?? '';
      const labelMatch = /label="((?:[^"\\]|\\.)*)"/.exec(attributes);
      nodes.set(unquote(node[1]!), labelMatch === null ? '' : unquote(labelMatch[1]!));
    }
  }
  return { nodes: [...nodes].map(([id, label]) => ({ id, label })), edges, truncated };
}
const NativeRemember = z.discriminatedUnion('action', [
  z.object({ id: z.string().min(1), action: z.literal('added') }),
  z.object({ id: z.string().min(1), action: z.literal('skipped'), replaced_id: z.string().min(1) }),
]);
const Status = z.object({ total_insights: z.number().int().nonnegative() });
/**
 * `embed --status` is the official coverage report. It answers whether the embedding service is
 * reachable (`ollama_available`), whether the configured model is usable (`embedding_available`)
 * and how many insights already carry a vector — the three facts a recall diagnosis needs.
 */
const NativeEmbeddingStatus = z.object({
  coverage: z.string(),
  embedded: z.number().int().nonnegative(),
  embedding_available: z.boolean(),
  model: z.string().min(1),
  ollama_available: z.boolean(),
  protocol: z.string().min(1),
  total_insights: z.number().int().nonnegative(),
});
const NativeMemory = z.object({ id: z.string().min(1), content: z.string() });
/** `--basic` recall rows carry the source, which is how a lost sync write is found again. */
const NativeSourcedMemory = z.object({ id: z.string().min(1), content: z.string(), source: z.string().optional() });
const NativeForget = z.object({ id: z.string().min(1), status: z.literal('deleted') });
const NativeRelated = z.array(z.object({ id: z.string().min(1), content: z.string(), depth: z.number().int().optional(), via_edge_type: z.string().optional() }));
const EdgeTypes = ['supersedes', 'semantic', 'causal', 'entity', 'temporal'] as const;
function decode<T>(schema: z.ZodType<T>, text: string): T {
  try { return schema.parse(JSON.parse(text)); } catch { throw new MnemoWeaveError('PROVIDER_PROTOCOL'); }
}

export class MnemonCliProvider implements MemoryProvider {
  private readonly runner: Runner;
  private readonly prefix: string[];
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * The version check used to run before every command, which cost one extra CLI process per
   * call (~85 ms on Windows) — `/health/ready` alone started two processes. The version string is
   * fixed for a given binary, so it is cached; the TTL still notices an in-place upgrade within
   * a minute, and a failed check is never cached.
   */
  private versionCheckedAt = 0;
  private static readonly VERSION_TTL_MS = 60_000;
  /**
   * Readiness is polled by the page and by monitoring. Caching it for a second keeps a burst of
   * page opens from spawning one process each, and every consumer is documented as at most this
   * stale.
   */
  private healthCache: { at: number; value: Health } | undefined;
  private readonly healthTtlMs: number;
  constructor(options: { binary: string; dataDir: string; store: string; runner?: Runner; healthTtlMs?: number }) {
    if (!isAbsolute(options.dataDir) || !/^[a-zA-Z0-9_-]+$/.test(options.store)) throw new Error('Explicit absolute dataDir and safe store are required');
    this.runner = options.runner ?? createRunner(options.binary);
    this.prefix = ['--data-dir', options.dataDir, '--store', options.store];
    this.healthTtlMs = options.healthTtlMs ?? 1_000;
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async checked(args: string[]): Promise<string> {
    // A cached "supported" answer still re-verifies after the TTL, so replacing the binary in
    // place cannot leave the Server believing in a version that is no longer there.
    if (this.versionCheckedAt === 0 || Date.now() - this.versionCheckedAt > MnemonCliProvider.VERSION_TTL_MS) {
      const version = (await this.runner(['--version'])).trim();
      if (version !== 'mnemon version 0.2.13') throw new MnemoWeaveError('UNSUPPORTED_VERSION');
      this.versionCheckedAt = Date.now();
    }
    const output = await this.runner([...this.prefix, ...args]);
    this.storeOpened = true;
    return output;
  }
  /**
   * Read-only commands run against an immutable snapshot. The CLI documents `--readonly` as
   * "open an immutable database snapshot (reject writes; create no WAL files)", which is both
   * safer than a read-write open for a pure lookup and measurably cheaper (~20% here).
   *
   * The one exception is the first read of this process: a store that does not exist yet cannot
   * be opened read-only (the CLI answers "database not found"), so that read opens normally and
   * creates it. After any successful call the store provably exists and every read uses the
   * snapshot. Deliberately not a retry-on-failure: that would swallow a genuine Provider outage.
   */
  private async checkedRead(args: string[]): Promise<string> {
    if (!this.storeOpened) return this.checked(args);
    return this.checked(['--readonly', ...args]);
  }
  /**
   * Bodies are immutable per memory id: an edit writes a new memory and supersedes the old one,
   * and a withdrawal removes the id. So a body, once read, stays valid until that id is
   * forgotten — which is the only path that clears it. Without this cache every page load paid
   * one CLI process per visible row.
   */
  /** Set once a call has proved the store exists; enables the read-only snapshot path. */
  private storeOpened = false;
  private readonly bodyCache = new Map<string, string>();
  private static readonly BODY_CACHE_LIMIT = 500;
  private rememberBody(id: string, content: string): void {
    if (this.bodyCache.size >= MnemonCliProvider.BODY_CACHE_LIMIT) {
      // Oldest first: Map preserves insertion order.
      const oldest = this.bodyCache.keys().next();
      if (!oldest.done) this.bodyCache.delete(oldest.value);
    }
    this.bodyCache.set(id, content);
  }
  health(): Promise<Health> {
    const cached = this.healthCache;
    if (cached !== undefined && Date.now() - cached.at < this.healthTtlMs) return Promise.resolve(cached.value);
    return this.serial(async () => {
      // Re-check inside the queue: a batch of callers may all have arrived before the first
      // answer landed, and only one spawn should happen.
      const again = this.healthCache;
      if (again !== undefined && Date.now() - again.at < this.healthTtlMs) return again.value;
      decode(Status, await this.checkedRead(['status']));
      const value: Health = { ready: true, version: '0.2.13', capabilities: ['health', 'recall', 'remember'] };
      this.healthCache = { at: Date.now(), value };
      return value;
    });
  }
  /**
   * Official embedding coverage. `embed --status` answers even when the embedding service is
   * down, so an unreachable service is reported rather than turned into a probe failure.
   */
  async embeddingStatus(): Promise<ProviderEmbeddingStatusRecord> {
    const report = decode(NativeEmbeddingStatus, await this.checkedRead(['embed', '--status']));
    return {
      serviceAvailable: report.ollama_available,
      modelAvailable: report.embedding_available,
      protocol: report.protocol,
      model: report.model,
      embedded: report.embedded,
      total: report.total_insights,
    };
  }
  /**
   * Backfill vectors with the official command. The CLI reports a missing embedding service on
   * stderr with a usage block, so the caller treats a thrown error as the failure signal and
   * re-reads `embed --status` for the authoritative outcome.
   */
  async embedAll(): Promise<{ error: string | null }> {
    try {
      await this.checked(['embed', '--all']);
      return { error: null };
    } catch (error) {
      return { error: error instanceof MnemoWeaveError ? error.code : 'PROVIDER_UNAVAILABLE' };
    }
  }
  recall(request: RecallRequest): Promise<RecallResult> {
    return this.serial(async () => {
      // Three retrieval modes answer differently, so the caller's choice is honoured rather than
      // approximated: `search` scores tokens, `recall --basic` is SQL LIKE, plain `recall` is the
      // intent-aware ranking.
      const semantic = request.mode === undefined || request.mode === 'smart';
      // The ranking truncates by its fused score, so a page-sized request would only ever re-rank
      // the Provider's own top page. Ask for the wider pool the quality policy selects from.
      const limit = semantic ? recallCandidateLimit(request.limit) : request.limit;
      const args = request.mode === 'keyword'
        ? ['search', '--limit', String(limit)]
        : request.mode === 'basic'
          ? ['recall', '--basic', '--limit', String(limit)]
          : ['recall', '--limit', String(limit), '--verbose'];
      if (request.mode !== 'keyword') {
        if (request.category !== undefined) args.push('--cat', request.category);
        if (request.source !== undefined) args.push('--source', request.source);
      }
      args.push('--', request.query);
      const result = decode(NativeRecall, await this.checkedRead(args));
      const rows = result.results.map(decodeRecallRow).filter(({ memory }) =>
        request.mode !== 'keyword'
        || ((request.category === undefined || memory.category === request.category)
          && (request.source === undefined || memory.source === request.source)));
      // Every row the Provider reported is carried through; only the score is replaced when the
      // Provider reported a real vector similarity. Dropping classification here would force every
      // caller to re-filter a page it did not ask for.
      const scored = rows.some(row => row.similarity !== undefined && row.similarity > 0);
      if (!scored) {
        // No embeddings, or an unreachable embedding service: the similarities are absent or all
        // zero, so the Provider's own order and fused scores stay authoritative. Re-scoring them
        // here would replace a ranking that has meaning with one that does not.
        return { memories: rows.map(row => row.memory) };
      }
      const ranked = rows.map(row => {
        const memory = { ...row.memory };
        // The compact `confidence` label describes the fused score being discarded, so keeping it
        // beside a similarity would state a relevance band that no longer matches the number.
        delete memory.confidence;
        if (row.similarity === undefined) {
          // Unknown relevance must not inherit an optimistic fused score; an explicit supersession
          // demotion stands even without a vector.
          if (!row.superseded) delete memory.score;
        } else {
          const relevance = Math.min(1, Math.max(0, row.similarity));
          // A corrected fact keeps the Provider's demotion even when its old wording is the
          // closest vector match to the new question.
          memory.score = row.superseded ? Math.min(relevance, memory.score ?? 0) : relevance;
        }
        return memory;
      });
      ranked.sort((left, right) => (right.score ?? -1) - (left.score ?? -1));
      return { memories: ranked };
    });
  }
  /**
   * Every memory the Provider holds.
   *
   * Read-only and unbounded on purpose: this is what the library contains, and a page of it would
   * let a caller mistake "not on this page" for "not in the store". The cap is the output buffer,
   * which surfaces as a real error instead of a silently short list.
   */
  listAll(): Promise<NonNullable<RecallResult['memories']>> {
    return this.serial(async () => {
      const rows = decode(NativeAllInsights, await this.checkedRead(['recall', '', '--basic', '--limit', '100000']));
      return rows.map(row => ({ ...row }));
    });
  }
  /** The Provider's own accounting, including the entity frequency table it maintains. */
  stats(): Promise<ProviderStatsRecord> {
    return this.serial(async () => {
      const status = decode(NativeStatus, await this.checkedRead(['status']));
      return {
        totalInsights: status.total_insights,
        deletedInsights: status.deleted_insights ?? 0,
        edgeCount: status.edge_count ?? 0,
        byCategory: status.by_category ?? {},
        topEntities: (status.top_entities ?? []).map(entry => ({ entity: entry.entity, count: entry.count })),
      };
    });
  }
  /**
   * The Provider's own relation graph.
   *
   * `viz` is the official export, so these are the edges the store actually holds rather than the
   * ones this Server happened to write. DOT is parsed instead of the HTML payload: its lines are a
   * stable shape, while the HTML carries a generated vis.js dataset.
   */
  graph(): Promise<ProviderGraphRecord> {
    return this.serial(async () => {
      const dot = await this.checkedRead(['viz', '--format', 'dot']);
      const parsed = parseDotGraph(dot, PROVIDER_GRAPH_EDGE_LIMIT);
      return parsed;
    });
  }
  /** Bounded official CLI lookup; absence alone never authorizes retrying an uncertain write. */
  inspectExact(content: string): Promise<{ matches: { id: string; content: string }[]; complete: boolean }> {
    if (!content.trim() || Buffer.byteLength(content, 'utf8') > 8000) return Promise.reject(new MnemoWeaveError('INVALID_INPUT'));
    return this.serial(async () => {
      const rows = decode(z.array(NativeMemory).nullable(), await this.checkedRead(['recall', '--basic', '--limit', '200', '--', content])) ?? [];
      // LIKE treats % and _ as patterns. Filter exact content and report truncation.
      return { matches: rows.filter(row => row.content === content), complete: rows.length < 200 };
    });
  }
  verifyContent(id: string, expectedContent: string): Promise<boolean> {
    if (!id.trim()) return Promise.reject(new MnemoWeaveError('INVALID_INPUT'));
    return this.serial(async () => {
      const memory = decode(NativeMemory, await this.checkedRead(['show', '--', id]));
      return memory.id === id && memory.content === expectedContent;
    });
  }
  readMemory(id: string): Promise<{ id: string; content: string }> {
    if (!id.trim()) return Promise.reject(new MnemoWeaveError('INVALID_INPUT'));
    const cached = this.bodyCache.get(id);
    if (cached !== undefined) return Promise.resolve({ id, content: cached });
    return this.serial(async () => {
      const again = this.bodyCache.get(id);
      if (again !== undefined) return { id, content: again };
      const result = decode(NativeMemory, await this.checkedRead(['show', '--', id]));
      if (result.id !== id) throw new MnemoWeaveError('PROVIDER_PROTOCOL');
      this.rememberBody(result.id, result.content);
      return result;
    });
  }
  /**
   * Read several bodies at once.
   *
   * The whole batch is serialized against writes (so it cannot interleave with one), but misses
   * inside it run a few at a time: each miss is its own CLI process, and the list view needs one
   * body per row. Cached bodies cost nothing.
   *
   * The default window is deliberately small. Measured on this machine over 25 rows: one process
   * per row 2219 ms, window 2 1256 ms, window 3 1290 ms, window 4 1336 ms, window 8 1490 ms,
   * window 16 1852 ms. Spawning is CPU-bound and every read opens an immutable snapshot, so
   * running wider only adds contention.
   */
  readMany(ids: string[], concurrency = 4): Promise<{ id: string; content: string }[]> {
    if (ids.length === 0) return Promise.resolve([]);
    const missing = ids.filter(id => !this.bodyCache.has(id));
    if (missing.length === 0) return Promise.resolve(ids.map(id => ({ id, content: this.bodyCache.get(id)! })));
    return this.serial(async () => {
      const stillMissing = missing.filter(id => !this.bodyCache.has(id));
      const queue = [...stillMissing];
      /**
       * The first call on a fresh adapter must not be one of several at once. Until a call has
       * succeeded the adapter does not know the store exists, so reads run without `--readonly`
       * and the CLI takes a write lock to migrate the store first. Measured with four of them in
       * flight against a store the process had not opened yet: 20 of 27 reads failed with
       * `SQLITE_BUSY`, and a failed body is silently absent from the batch, so the page showed a
       * short list instead of an error. One serial read settles the store and every later read
       * uses the read-only snapshot path.
       */
      if (!this.storeOpened && queue.length > 0) {
        const first = queue.shift()!;
        await this.readOne(first);
      }
      const worker = async (): Promise<void> => {
        for (;;) {
          const id = queue.shift();
          if (id === undefined) return;
          await this.readOne(id);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
      // A batch may still lose a row to a transient error; one serial retry separates a genuinely
      // unreadable id from contention, so a page never shrinks without saying so.
      for (const id of ids) {
        if (this.bodyCache.has(id)) continue;
        await this.readOne(id);
      }
      return ids.flatMap(id => {
        const content = this.bodyCache.get(id);
        return content === undefined ? [] : [{ id, content }];
      });
    });
  }
  /** One body read; a failure leaves the id uncached so the caller can decide what it means. */
  private async readOne(id: string): Promise<void> {
    try {
      const result = decode(NativeMemory, await this.checkedRead(['show', '--', id]));
      if (result.id === id) this.rememberBody(result.id, result.content);
    } catch {
      // Reported by the caller, which knows whether a short page is acceptable.
    }
  }
  /** Internal relation projection only; approval and publication are owned by the workflow. */
  linkSupersedes(sourceId: string, targetId: string, metadata: { operationId: string; reason: string; effectiveAt: string }): Promise<{ sourceId: string; targetId: string; edgeType: 'supersedes' }> {
    const input = z.object({ sourceId: z.uuid(), targetId: z.uuid(), metadata: z.object({ operationId: z.uuid(), reason: z.string().trim().min(1).max(4000), effectiveAt: z.iso.datetime() }).strict() }).strict().parse({ sourceId, targetId, metadata });
    if (input.sourceId === input.targetId) return Promise.reject(new MnemoWeaveError('INVALID_INPUT'));
    return this.serial(async () => {
      const ack = decode(z.object({ status: z.literal('linked'), source_id: z.string(), target_id: z.string(), edge_type: z.literal('supersedes'), metadata: z.record(z.string(), z.string()) }), await this.checked(['link', input.sourceId, input.targetId, '--type', 'supersedes', '--meta', JSON.stringify(input.metadata)]));
      if (ack.source_id !== input.sourceId || ack.target_id !== input.targetId || Object.entries(input.metadata).some(([key, value]) => ack.metadata[key] !== value)) throw new MnemoWeaveError('PROVIDER_PROTOCOL');
      return { sourceId: input.sourceId, targetId: input.targetId, edgeType: 'supersedes' };
    });
  }
  /** Internal write port; only the reviewed, durably queued workflow invokes it. */
  persistReviewed(content: string, writeKey: string): Promise<{ id: string; action: 'added' | 'skipped' }> {
    if (!content.trim() || Buffer.byteLength(content, 'utf8') > 8000 || !/^candidate:[a-f0-9-]{36}$/.test(writeKey)) return Promise.reject(new MnemoWeaveError('INVALID_INPUT'));
    return this.serial(async () => {
      const result = decode(NativeRemember, await this.checked(['remember', '--source', `mnemoweave:${writeKey}`, '--', content]));
      return { id: result.action === 'skipped' ? result.replaced_id : result.id, action: result.action };
    });
  }
  /** Provider acceptance only. Business Remember must enter Candidate/Review first. */
  acceptanceRemember(content: string): Promise<{ id: string; action: 'added' | 'skipped' }> {
    if (!content.trim() || Buffer.byteLength(content, 'utf8') > 8000) return Promise.reject(new MnemoWeaveError('INVALID_INPUT'));
    return this.serial(async () => {
      const result = decode(NativeRemember, await this.checked(['remember', '--source', 'external', '--', content]));
      return { id: result.action === 'skipped' ? result.replaced_id : result.id, action: result.action };
    });
  }
  /**
   * Cross-machine rebuild write. `--no-diff` is deliberate: the same body may already
   * exist on this machine, and duplicate detection would return `skipped` without a new
   * id. The source carries changeId and version so a lost response can be located later.
   */
  syncRemember(content: string, changeId: string, version: number): Promise<{ id: string; action: 'added' | 'skipped'; replacedId: string | null }> {
    if (!content.trim() || Buffer.byteLength(content, 'utf8') > 8000) return Promise.reject(new MnemoWeaveError('INVALID_INPUT'));
    if (!z.uuid().safeParse(changeId).success || !Number.isInteger(version) || version < 1) return Promise.reject(new MnemoWeaveError('INVALID_INPUT'));
    return this.serial(async () => {
      const result = decode(NativeRemember, await this.checked(['remember', '--source', `mnemoweave:${changeId}:${version}`, '--no-diff', '--', content]));
      return { id: result.action === 'skipped' ? result.replaced_id : result.id, action: result.action, replacedId: result.action === 'skipped' ? result.replaced_id : null };
    });
  }
  /**
   * Locate a memory written under an exact `source`. `remember --no-diff` has no
   * idempotency, so a sync write that lost its response is recovered here instead of
   * being re-issued. `recall --basic` needs a keyword, so the source text itself is
   * used and the rows are then filtered to an exact source match.
   */
  findBySource(source: string): Promise<{ id: string; content: string } | null> {
    if (!source.trim() || source.length > 200) return Promise.reject(new MnemoWeaveError('INVALID_INPUT'));
    return this.serial(async () => {
      const rows = decode(z.array(NativeSourcedMemory).nullable(), await this.checked(['recall', '--basic', '--source', source, '--limit', '200', '--', source])) ?? [];
      const matches = rows.filter(row => row.source === source);
      // More than one row means a previous replay already duplicated the write; the caller
      // must not pick one silently.
      if (matches.length > 1) throw new MnemoWeaveError('PROVIDER_INTEGRITY');
      return matches.length === 1 ? { id: matches[0]!.id, content: matches[0]!.content } : null;
    });
  }
  /** Soft delete. Historical edges pointing at the insight disappear, so sync never uses this for withdrawal. */
  forget(id: string): Promise<{ id: string; status: 'deleted' }> {
    if (!id.trim()) return Promise.reject(new MnemoWeaveError('INVALID_INPUT'));
    return this.serial(async () => {
      const result = decode(NativeForget, await this.checked(['forget', id]));
      if (result.id !== id) throw new MnemoWeaveError('PROVIDER_PROTOCOL');
      // The body cache is keyed by id and a deleted id must never be served again.
      this.bodyCache.delete(id);
      return result;
    });
  }
  /** Read native relations back, used to verify rebuilt supersedes chains. */
  related(id: string, edge: (typeof EdgeTypes)[number] = 'supersedes', depth = 1): Promise<{ id: string; content: string; depth: number; viaEdgeType: string | null }[]> {
    if (!id.trim() || !EdgeTypes.includes(edge) || !Number.isInteger(depth) || depth < 1 || depth > 5) return Promise.reject(new MnemoWeaveError('INVALID_INPUT'));
    return this.serial(async () => {
      const rows = decode(NativeRelated, await this.checkedRead(['related', id, '--edge', edge, '--depth', String(depth)]));
      return rows.map((row) => ({ id: row.id, content: row.content, depth: row.depth ?? 1, viaEdgeType: row.via_edge_type ?? null }));
    });
  }
}
