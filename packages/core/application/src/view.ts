import { mayReadMemory } from './access.ts';
import { randomUUID } from 'node:crypto';
import { MnemoWeaveError, ReadGrant, RerankOutput, View } from '../../contracts/src/index.ts';
import type { ReadGrantRecord, ViewRecord, ViewRuleRecord } from '../../contracts/src/index.ts';
import type { MemoryCatalogReader } from './catalog-ports.ts';
import { MODEL_EVIDENCE_BODY_BYTES, MODEL_EVIDENCE_LIMIT, MODEL_EVIDENCE_TOTAL_BYTES } from '../../contracts/src/capacity.ts';

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
/** Rules are injected whole or not at all; this budget selects entries, it never truncates. */
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
    /**
     * A View is drawn for one session: general memory plus the session's project. Attribution
     * is stored per memory, so a project memory outside this session is not a candidate even
     * when the Host holds a grant for it.
     */
    const inSessionScope = (owner: string | null | undefined): boolean => owner === null || owner === undefined || owner === input.projectId;
    const usableBy = (grant0: typeof grant, descriptor: { state: string; projectId?: string | null | undefined } | null | undefined): boolean =>
      descriptor !== null && descriptor !== undefined && descriptor.state === 'active'
      && mayReadMemory(grant0, descriptor.projectId ?? null) && inSessionScope(descriptor.projectId ?? null);
    const generation = this.generation++;
    const query = input.query;
    // Rules are read before memories and delivered whole. Selection is deterministic: pinned
    // first, then importance, then age and id. A rule that does not fit is omitted as a whole;
    // no body is ever trimmed. Rule metadata (id, version, markers) is accounted separately.
    const ruleRows = this.rules?.() ?? [];
    const rank = { critical: 0, normal: 1, low: 2 } as const;
    const orderedRules = [...ruleRows].sort((left, right) =>
      Number(right.pinned === true) - Number(left.pinned === true)
      || rank[left.importance ?? 'normal'] - rank[right.importance ?? 'normal']
      || (left.createdAt ?? '').localeCompare(right.createdAt ?? '')
      || left.entryId.localeCompare(right.entryId));
    const selectedRules: ViewRuleRecord[] = [];
    const omittedRules: string[] = [];
    let ruleBodyTokens = 0;
    let ruleUsed = 0;
    for (const rule of orderedRules) {
      const bodyTokens = estimateTokens(rule.body);
      const metadataTokens = 8;
      if (ruleUsed + bodyTokens + metadataTokens > RULE_BUDGET_TOKENS) { omittedRules.push(...orderedRules.slice(orderedRules.indexOf(rule)).map(item => item.entryId)); break; }
      selectedRules.push(rule);
      ruleBodyTokens += bodyTokens;
      ruleUsed += bodyTokens + metadataTokens;
    }
    const rulesBudget = ruleRows.length > 0
      ? {
        limitTokens: RULE_BUDGET_TOKENS, usedTokens: ruleUsed, exceeded: omittedRules.length > 0,
        omittedCount: omittedRules.length, omittedEntryIds: omittedRules,
        bodyTokens: ruleBodyTokens, metadataTokens: selectedRules.length * 8,
      }
      : undefined;
    const recall = query
      ? (this.app.recallDetailed
        ? await this.app.recallDetailed({ query, limit: Math.min(input.limit ?? MODEL_EVIDENCE_LIMIT, MODEL_EVIDENCE_LIMIT), ...(input.projectId === undefined ? {} : { projectId: input.projectId }) })
        : { ...(await this.app.recall({ query, limit: Math.min(input.limit ?? MODEL_EVIDENCE_LIMIT, MODEL_EVIDENCE_LIMIT) })), unregistered: [] as string[] })
      : { memories: [] as { id: string; content: string; score?: number }[], complete: true, unregistered: [] as string[] };
    const excluded: ViewRecord['excluded'] = [];
    // A Provider hit this machine never published is reported, not silently dropped.
    for (const providerId of recall.unregistered ?? []) excluded.push({ memoryId: providerId, reason: 'unregistered' });
    // Dynamic candidates: visible per the catalog; version state re-checked again before delivery.
    let dynamic = recall.memories.filter(memory => this.app.catalogReader!.currentMemoryIds(memory.id).some(id => usableBy(grant, this.safeDescriptor(id))));
    dynamic = await Promise.all(dynamic.map(async memory => {
      const id = this.app.catalogReader!.currentMemoryIds(memory.id).find(id => usableBy(grant, this.safeDescriptor(id)))!;
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
      if (!mayReadMemory(grant, descriptor.projectId ?? null) || !inSessionScope(descriptor.projectId ?? null)) { excluded.push({ memoryId: item.memoryId, reason: 'grant_scope' }); continue; }
      const revision = descriptor.revisions.find((value: { id: string }) => value.id === descriptor.currentRevisionId)!;
      const read = await this.app.readMemory({ memoryId: item.memoryId });
      pinned.push({
        memoryId: descriptor.id, revisionId: revision.id, providerMemoryId: revision.providerMemoryId,
        tier: item.tier === 'critical' ? 'pinned-critical' : 'pinned-normal',
        applicability: descriptor.applicability,
        projectId: descriptor.projectId ?? null,
        content: read.content, excerpt: item.tier !== 'critical',
        sourceReference: `readMemory:${revision.providerMemoryId}`,
      });
    }
    // Rules, session envelope and metadata are reserved before any memory content.
    const usedFor = (entry: { content: string }) => estimateTokens(entry.content) + 100;
    let remaining = budgetTokens - envelopeReserve - ruleUsed;
    const critical = pinned.filter(entry => entry.tier === 'pinned-critical');
    const criticalTokens = critical.reduce((sum, entry) => sum + usedFor(entry), 0);
    if (criticalTokens > remaining) throw new MnemoWeaveError('VIEW_BUDGET_EXCEEDED');
    remaining -= criticalTokens;
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
    let dynamicDelivered = 0;
    let dynamicBytes = 0;
    for (const memory of dynamic) {
      const logicalIds = this.app.catalogReader!.currentMemoryIds(memory.id);
      // The Provider answered with an id this machine never registered: it is not hidden
      // by state or grant, it was never published here.
      if (!logicalIds.length) { excluded.push({ memoryId: memory.id, reason: 'unregistered' }); continue; }
      for (const logicalId of logicalIds) {
        if (pinnedIds.has(logicalId)) continue;
        const descriptor = this.safeDescriptor(logicalId);
        if (!descriptor || descriptor.state !== 'active') { excluded.push({ memoryId: logicalId, reason: descriptor && descriptor.state === 'superseded' ? 'superseded' : 'not_visible' }); continue; }
        if (!mayReadMemory(grant, descriptor.projectId ?? null) || !inSessionScope(descriptor.projectId ?? null)) { excluded.push({ memoryId: logicalId, reason: 'grant_scope' }); continue; }
        if (dynamicDelivered >= MODEL_EVIDENCE_LIMIT) { excluded.push({ memoryId: logicalId, reason: 'budget' }); continue; }
        const revision = descriptor.revisions.find((value: { id: string }) => value.id === descriptor.currentRevisionId)!;
        const full = (await this.app.readMemory({ memoryId: logicalId, revisionId: revision.id })).content;
        const content = utf8Prefix(full, MODEL_EVIDENCE_BODY_BYTES);
        const contentBytes = Buffer.byteLength(content, 'utf8');
        if (dynamicBytes + contentBytes > MODEL_EVIDENCE_TOTAL_BYTES) { excluded.push({ memoryId: logicalId, reason: 'budget' }); continue; }
        const entry: ViewRecord['memories'][number] = {
          memoryId: descriptor.id, revisionId: revision.id, providerMemoryId: revision.providerMemoryId,
          tier: 'dynamic', applicability: descriptor.applicability,
          projectId: descriptor.projectId ?? null,
          content,
          excerpt: content.length < full.length,
          ...(memory.score === undefined ? {} : { score: memory.score }),
          sourceReference: `readMemory:${revision.providerMemoryId}`,
        };
        const cost = usedFor(entry);
        if (cost > remaining) { excluded.push({ memoryId: descriptor.id, reason: 'budget' }); continue; }
        memories.push(entry);
        dynamicDelivered += 1;
        dynamicBytes += contentBytes;
        remaining -= cost;
      }
    }
    // Reject changed publications rather than labeling old text with a new current pointer.
    for (const memory of memories) {
      const current = this.safeDescriptor(memory.memoryId);
      if (!current || current.state !== 'active' || current.currentRevisionId !== memory.revisionId || !mayReadMemory(grant, current.projectId ?? null) || !inSessionScope(current.projectId ?? null)) throw new MnemoWeaveError('INVALID_STATE');
    }
    // Delivery checks: grant may have been revoked or expired while content was assembled.
    this.checkGrant(grant);
    const usedTokens = memories.reduce((sum, entry) => sum + usedFor(entry), 0) + envelopeReserve + ruleUsed;
    if (usedTokens > budgetTokens) throw new MnemoWeaveError('VIEW_BUDGET_EXCEEDED');
    const budgetOmissions = (omittedRules.length > 0 || excluded.some(item => item.reason === 'budget'))
      ? [
        ...(omittedRules.length > 0 ? [{ kind: 'rules' as const, count: omittedRules.length, reason: 'rule budget could not hold complete rules; lower-priority rules were omitted' }] : []),
        ...(excluded.filter(item => item.reason === 'budget').length > 0 ? [{ kind: 'memories' as const, count: excluded.filter(item => item.reason === 'budget').length, reason: 'remaining token budget could not hold the next complete memory record' }] : []),
      ]
      : undefined;
    const view = View.parse({
      viewId: randomUUID(), generation, createdAt: new Date().toISOString(),
      grantId: grant.grantId, query: query ?? null,
      scopeNote: { projects: [...grant.projects], globalIncluded: grant.globalIncluded },
      budget: { limitTokens: budgetTokens, usedTokens, estimator: 'utf8-bytes-3', estimated: true, envelopeReserveTokens: envelopeReserve },
      memories,
      ...(selectedRules.length > 0 ? { rules: selectedRules } : {}),
      ...(rulesBudget === undefined ? {} : { rulesBudget }),
      ...(budgetOmissions === undefined ? {} : { budgetOmissions }),
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
