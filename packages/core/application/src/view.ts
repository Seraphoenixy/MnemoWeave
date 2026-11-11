import { mayRead } from './access.ts';
import { randomUUID } from 'node:crypto';
import { MnemoWeaveError, ReadGrant, RerankOutput, View } from '../../contracts/src/index.ts';
import type { ReadGrantRecord, ViewRecord, ViewRuleRecord } from '../../contracts/src/index.ts';
import type { MemoryCatalogReader } from './catalog-ports.ts';

/**
 * Minimal read surface needed for View assembly. The Server uses the Application Core;
 * the Bridge supplies the same shape from its local replica for offline injection.
 */
export interface ViewSource {
  readonly catalogReader?: MemoryCatalogReader | undefined;
  recall(input: { query: string; limit: number }): Promise<{ memories: { id: string; content: string; score?: number | undefined }[]; complete?: boolean | undefined }>;
  recallDetailed?(input: { query: string; limit: number }): Promise<{ memories: { id: string; content: string; score?: number | undefined }[]; complete?: boolean | undefined; unregistered: string[] }>;
  readMemory(input: { memoryId: string; revisionId?: string }): Promise<{ content: string }>;
}

/**
 * Conservative token estimate: one token per three UTF-8 bytes. Declared and marked
 * estimated everywhere; never presented as an exact tokenizer count (VIEW-02).
 */
export function estimateTokens(text: string): number { return Math.ceil(Buffer.byteLength(text, 'utf8') / 3); }
export const DEFAULT_INJECTION_BUDGET_TOKENS = 4096;
/** Rules are injected whole or not at all; this budget rejects enabling, it never truncates. */
export const RULE_BUDGET_TOKENS = 1024;
/** Reserved for envelope metadata (ids, scope note, budget block) on top of memory content. */
export const ENVELOPE_RESERVE_TOKENS = 96;
/** Minimum excerpt budget for a normal pinned memory; below this it is excluded as budget. */
const MIN_EXCERPT_BYTES = 384;
const NORMAL_PINNED_EXCERPT_BYTES = 768;
/** Scores closer than this gap between top results count as ambiguous (RECALL-02 auto trigger). */
export const AMBIGUITY_SCORE_GAP = 0.05;
export const AMBIGUITY_RULE_VERSION = 'score-gap-0.05-v1';

export type GrantRevocationSource = { revocationWatermark(): number };

function grantUsable(grant: ReadGrantRecord, now: number, watermark: number): boolean {
  return grant.generation >= watermark && new Date(grant.expiresAt).getTime() > now;
}

export function deepFreezeView<T>(view: T): T {
  if (view && typeof view === 'object') {
    Object.freeze(view);
    for (const value of Object.values(view)) deepFreezeView(value);
  }
  return view;
}

/**
 * Assembles an immutable View: structured, generation-stamped, never mutated
 * after delivery. Grant, publication state and budget are all re-checked right before the
 * View is returned; rerank results are bound to a generation and stale ones are rejected.
 */
export class ViewAssembler {
  private readonly app: ViewSource;
  private readonly revocations: GrantRevocationSource | undefined;
  private readonly budgetTokens: number;
  /** Rules apply to every session, so the source is read without a project argument. */
  private readonly rules: (() => ViewRuleRecord[]) | undefined;
  private generation: number;
  constructor(app: ViewSource, options: { revocations?: GrantRevocationSource; budgetTokens?: number; generation?: number; rules?: () => ViewRuleRecord[] } = {}) {
    if (!app.catalogReader) throw new Error('View assembly requires the publication catalog');
    this.app = app; this.revocations = options.revocations;
    this.budgetTokens = options.budgetTokens ?? DEFAULT_INJECTION_BUDGET_TOKENS;
    this.rules = options.rules;
    this.generation = options.generation ?? 0;
  }
  async assemble(input: {
    grant: unknown; query?: string; projectId?: string;
    pinned?: ReadonlyArray<{ memoryId: string; tier: 'critical' | 'normal' }>;
    rerank?: boolean; limit?: number; budgetTokens?: number; reserveTokens?: number;
  }): Promise<ViewRecord> {
    const budgetTokens = Math.min(this.budgetTokens, input.budgetTokens ?? this.budgetTokens);
    const envelopeReserve = ENVELOPE_RESERVE_TOKENS + (input.reserveTokens ?? 0);
    const grant = ReadGrant.parse(input.grant);
    this.checkGrant(grant);
    if (input.projectId && !grant.projects.includes('*') && !grant.projects.includes(input.projectId)) throw new MnemoWeaveError('UNAUTHORIZED');
    const generation = this.generation++;
    const query = input.query;
    // Rules are read before assembly and delivered whole; exceeding the rule budget omits
    // the block entirely instead of trimming a rule.
    const ruleRows = this.rules?.() ?? [];
    const ruleUsed = ruleRows.reduce((sum, rule) => sum + estimateTokens(rule.body) + 8, 0);
    const rulesExceeded = ruleUsed > RULE_BUDGET_TOKENS;
    const rules = rulesExceeded ? [] : ruleRows;
    const recall = query
      ? (this.app.recallDetailed
        ? await this.app.recallDetailed({ query, limit: input.limit ?? 10 })
        : { ...(await this.app.recall({ query, limit: input.limit ?? 10 })), unregistered: [] as string[] })
      : { memories: [] as { id: string; content: string; score?: number }[], complete: true, unregistered: [] as string[] };
    const excluded: ViewRecord['excluded'] = [];
    // A Provider hit this machine never published is reported, not silently dropped.
    for (const providerId of recall.unregistered ?? []) excluded.push({ memoryId: providerId, reason: 'unregistered' });
    // Dynamic candidates: visible per the catalog; version state re-checked again before delivery.
    let dynamic = recall.memories.filter(memory => this.app.catalogReader!.currentMemoryIds(memory.id).some(id => {
      const descriptor = this.safeDescriptor(id);
      return descriptor?.state === 'active' && mayRead(grant);
    }));
    dynamic = await Promise.all(dynamic.map(async memory => {
      const id = this.app.catalogReader!.currentMemoryIds(memory.id).find(id => { const descriptor = this.safeDescriptor(id); return descriptor?.state === 'active' && mayRead(grant); })!;
      const descriptor = this.app.catalogReader!.get(id);
      const read = await this.app.readMemory({ memoryId: id, revisionId: descriptor.currentRevisionId });
      return { ...memory, content: read.content };
    }));
    // Ordering is deterministic and model-free. Reranking used to call out to a model route;
    // the decision is that the Server never calls an external model, so the recall order the
    // Provider returned (already scored) is delivered as-is.
    const rerankStatus: ViewRecord['rerank'] = { status: 'not_requested', reason: 'Deterministic ordering; the Server never calls a model' };
    // Pinned tiers: critical stays complete, normal becomes a traceable excerpt.
    const pinned: ViewRecord['memories'] = [];
    const seenPinned = new Set<string>();
    for (const item of input.pinned ?? []) {
      if (seenPinned.has(item.memoryId)) continue;
      seenPinned.add(item.memoryId);
      const descriptor = this.safeDescriptor(item.memoryId);
      if (!descriptor || descriptor.state !== 'active') { excluded.push({ memoryId: item.memoryId, reason: descriptor && descriptor.state === 'superseded' ? 'superseded' : 'not_visible' }); continue; }
      if (!mayRead(grant)) { excluded.push({ memoryId: item.memoryId, reason: 'grant_scope' }); continue; }
      const revision = descriptor.revisions.find((value: { id: string }) => value.id === descriptor.currentRevisionId)!;
      const read = await this.app.readMemory({ memoryId: item.memoryId });
      pinned.push({
        memoryId: descriptor.id, revisionId: revision.id, providerMemoryId: revision.providerMemoryId,
        tier: item.tier === 'critical' ? 'pinned-critical' : 'pinned-normal',
        applicability: descriptor.applicability,
        content: read.content, excerpt: item.tier !== 'critical',
        sourceReference: `readMemory:${revision.providerMemoryId}`,
      });
    }
    // Budget pass (VIEW-01/VIEW-02): critical must fit whole or the assembly fails loudly.
    const usedFor = (entry: { content: string }) => estimateTokens(entry.content) + 100;
    const critical = pinned.filter(entry => entry.tier === 'pinned-critical');
    const criticalTokens = critical.reduce((sum, entry) => sum + usedFor(entry), 0);
    if (criticalTokens > budgetTokens - envelopeReserve) throw new MnemoWeaveError('VIEW_BUDGET_EXCEEDED');
    let remaining = budgetTokens - envelopeReserve - criticalTokens;
    const normal = pinned.filter(entry => entry.tier === 'pinned-normal');
    const memories: ViewRecord['memories'] = [...critical];
    for (const entry of normal) {
      const allowance = Math.min(NORMAL_PINNED_EXCERPT_BYTES, Math.max(0, Math.floor((remaining * 3) / Math.max(1, normal.length))));
      if (allowance < MIN_EXCERPT_BYTES) { excluded.push({ memoryId: entry.memoryId, reason: 'budget' }); continue; }
      entry.content = utf8Prefix(entry.content, allowance);
      entry.excerpt = true;
      memories.push(entry);
      remaining -= usedFor(entry);
    }
    // Recall hits carry Provider identities: map each to the logical memories it currently
    // anchors (dedup aliases may anchor several scoped memories), then re-check version state.
    // Logical memories already delivered as pinned content are not duplicated as dynamic rows.
    const pinnedIds = new Set(pinned.map(entry => entry.memoryId));
    for (const memory of dynamic) {
      const logicalIds = this.app.catalogReader!.currentMemoryIds(memory.id);
      // The Provider answered with an id this machine never registered: it is not hidden
      // by state or grant, it was never published here.
      if (!logicalIds.length) { excluded.push({ memoryId: memory.id, reason: 'unregistered' }); continue; }
      for (const logicalId of logicalIds) {
        if (pinnedIds.has(logicalId)) continue;
        const descriptor = this.safeDescriptor(logicalId);
        if (!descriptor || descriptor.state !== 'active') { excluded.push({ memoryId: logicalId, reason: descriptor && descriptor.state === 'superseded' ? 'superseded' : 'not_visible' }); continue; }
        if (!mayRead(grant)) { excluded.push({ memoryId: logicalId, reason: 'grant_scope' }); continue; }
        const revision = descriptor.revisions.find((value: { id: string }) => value.id === descriptor.currentRevisionId)!;
        const entry: ViewRecord['memories'][number] = {
          memoryId: descriptor.id, revisionId: revision.id, providerMemoryId: revision.providerMemoryId,
          tier: 'dynamic', applicability: descriptor.applicability,
          content: (await this.app.readMemory({ memoryId: logicalId, revisionId: revision.id })).content, excerpt: false,
          ...(memory.score === undefined ? {} : { score: memory.score }),
          sourceReference: `readMemory:${revision.providerMemoryId}`,
        };
        const cost = usedFor(entry);
        if (cost > remaining) { excluded.push({ memoryId: descriptor.id, reason: 'budget' }); continue; }
        memories.push(entry);
        remaining -= cost;
      }
    }
    // Reject changed publications rather than labeling old text with a new current pointer.
    for (const memory of memories) {
      const current = this.safeDescriptor(memory.memoryId);
      if (!current || current.state !== 'active' || current.currentRevisionId !== memory.revisionId || !mayRead(grant)) throw new MnemoWeaveError('INVALID_STATE');
    }
    // Delivery checks: grant may have been revoked or expired while content was assembled.
    this.checkGrant(grant);
    const usedTokens = memories.reduce((sum, entry) => sum + usedFor(entry), 0) + envelopeReserve + (rulesExceeded ? 0 : ruleUsed);
    const view = View.parse({
      viewId: randomUUID(), generation, createdAt: new Date().toISOString(),
      grantId: grant.grantId, query: query ?? null,
      scopeNote: { projects: [...grant.projects], globalIncluded: grant.globalIncluded },
      budget: { limitTokens: budgetTokens, usedTokens, estimator: 'utf8-bytes-3', estimated: true, envelopeReserveTokens: envelopeReserve },
      memories,
      ...(rules.length > 0 ? { rules } : {}),
      ...(ruleRows.length > 0 ? { rulesBudget: { limitTokens: RULE_BUDGET_TOKENS, usedTokens: ruleUsed, exceeded: rulesExceeded } } : {}),
      excluded,
      complete: excluded.every(item => item.reason !== 'budget') && recall.complete !== false,
      rerank: rerankStatus,
    });
    // The delivered View is deeply frozen; any change requires a new assembly generation.
    return deepFreezeView(view);
  }
  /** Late results may never rewrite a delivered view: the generation binding must match exactly. */
  static applyRerank(view: ViewRecord, result: unknown): ViewRecord {
    const parsed = RerankOutput.parse(result);
    if (parsed.generation !== view.generation) throw new MnemoWeaveError('INVALID_STATE');
    const byId = new Map(view.memories.map(entry => [entry.memoryId, entry] as const));
    if (parsed.order.length !== view.memories.length || new Set(parsed.order).size !== parsed.order.length || parsed.order.some(id => !byId.has(id))) throw new MnemoWeaveError('INVALID_INPUT');
    const reordered = parsed.order.map(id => byId.get(id)!);
    return deepFreezeView(View.parse({ ...view, memories: reordered, rerank: { status: 'applied', reason: 'Late rerank bound to this view generation' } }));
  }
  private ambiguous(memories: readonly { score?: number }[]): boolean {
    const scores = memories.map(memory => memory.score).filter((score): score is number => typeof score === 'number');
    return scores.length >= 2 && Math.abs(scores[0]! - scores[1]!) < AMBIGUITY_SCORE_GAP;
  }
  private checkGrant(grant: ReadGrantRecord): void {
    if (!grantUsable(grant, Date.now(), this.revocations?.revocationWatermark() ?? 0)) throw new MnemoWeaveError('UNAUTHORIZED');
  }
  private safeDescriptor(memoryId: string): ReturnType<MemoryCatalogReader['get']> | undefined {
    try { return this.app.catalogReader!.get(memoryId); } catch { return undefined; }
  }
}

export function utf8Prefix(text: string, bytes: number): string {
  let result = ''; let used = 0;
  for (const character of text) { const cost = Buffer.byteLength(character, 'utf8'); if (used + cost > bytes) break; result += character; used += cost; }
  return result;
}
