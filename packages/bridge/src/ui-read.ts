import { MnemoWeaveError } from '../../core/contracts/src/index.ts';
import type { ReadGrantRecord } from '../../core/contracts/src/index.ts';
import type { MemoryCatalogRecord } from '../../core/contracts/src/index.ts';
import { mayRead } from '../../core/application/src/access.ts';
import type { ReplicaStore } from './replica.ts';
import type { QueuedIntent } from './index.ts';

/** Explicit read availability over the local replica; never an empty result that hides a cause. */
export interface UiAvailability {
  status: 'ok' | 'unauthorized' | 'unavailable' | 'corrupted';
  reason?: string;
}

export interface UiGrantView {
  grantId: string;
  projects: string[];
  globalIncluded: boolean;
  issuedAt: string;
  expiresAt: string;
  generation: number;
  expired: boolean;
  revoked: boolean;
}

export interface UiReplicaView {
  available: boolean;
  corrupted: boolean;
  appliedSeq: number;
  generation: number;
  dataTime: string;
  verifiedAt: string | null;
  stale: boolean;
  pendingContent: number;
  memories: number;
  revisions: number;
}

export interface UiStatusRecord {
  schemaVersion: 1;
  hostId: string;
  generatedAt: string;
  paired: boolean;
  grant: UiGrantView | null;
  replica: UiReplicaView | null;
  intents: { queued: number; isolated: number };
}

/** One current revision as the UI lists it: enough context to pick a memory, bounded text to show. */
export interface UiMemorySummaryRecord {
  memoryId: string;
  revisionId: string;
  state: 'active' | 'superseded' | 'unverified';
  scope: 'project' | 'global';
  projectId?: string;
  applicability: string;
  revisionNumber: number;
  providerMemoryId: string;
  publishedAt: string;
  excerpt: string;
  contentLength: number;
}

export interface UiMemoryListRecord extends UiAvailability {
  query: string | null;
  scope: 'project' | 'global' | null;
  projectId: string | null;
  total: number;
  returned: number;
  complete: boolean;
  dataTime: string | null;
  items: UiMemorySummaryRecord[];
}

export interface UiRevisionRecord extends UiAvailability {
  memoryId: string;
  revisionId: string;
  number: number;
  publishedAt: string;
  effectiveAt: string;
  current: boolean;
  content: string | null;
}

export interface UiMemoryRevisionRecord {
  revisionId: string;
  number: number;
  publishedAt: string;
  effectiveAt: string;
  current: boolean;
}

export interface UiMemoryRelationRecord {
  id: string;
  kind: string;
  targetMemoryId: string;
  reason: string;
  effectiveAt: string;
}

export interface UiMemoryDetailRecord extends UiAvailability {
  memoryId: string;
  revisionId: string | null;
  state: 'active' | 'superseded' | 'unverified';
  scope: 'project' | 'global';
  projectId?: string;
  applicability: string;
  content: string | null;
  revisions: UiMemoryRevisionRecord[];
  relations: UiMemoryRelationRecord[];
}

export interface UiIntentRecord {
  intentId: string;
  kind: string;
  state: 'queued' | 'acknowledged' | 'isolated';
  createdAt: string;
  sessionId?: string;
  receiptRef?: string;
}

export interface UiIntentsRecord extends UiAvailability {
  queued: number;
  isolated: number;
  items: UiIntentRecord[];
}

/** Everything a UI read needs from the Bridge, without exposing the Bridge's internals. */
export interface UiReadState {
  hostId: string;
  grant: ReadGrantRecord | undefined;
  revoked: boolean;
  replica: ReplicaStore | undefined;
  corrupted: boolean;
  intents: readonly QueuedIntent[];
  now: Date;
}

const EXCERPT_LIMIT = 240;
const CONTENT_LIMIT = 40_000;
const INTENT_LIMIT = 50;
const STALE_AFTER_MS = 10 * 60_000;

function availability(state: UiReadState): UiAvailability {
  if (!state.grant) return { status: 'unauthorized', reason: 'unpaired' };
  if (state.revoked) return { status: 'unauthorized', reason: 'revoked' };
  if (Date.parse(state.grant.expiresAt) <= state.now.getTime()) return { status: 'unauthorized', reason: 'license_expired' };
  if (state.corrupted) return { status: 'corrupted', reason: 'integrity check failed' };
  if (!state.replica || state.replica.isEmpty) return { status: 'unavailable', reason: 'no_replica' };
  return { status: 'ok' };
}

function readable(state: UiReadState, record: MemoryCatalogRecord): boolean {
  return state.grant !== undefined && mayRead(state.grant, record);
}

function excerptOf(content: string): string {
  return content.length <= EXCERPT_LIMIT ? content : `${content.slice(0, EXCERPT_LIMIT)}…`;
}

/** Status is safe to read while unpaired or revoked: it reports why reads are closed. */
export function uiStatus(state: UiReadState): UiStatusRecord {
  const grant = state.grant;
  const replica = state.replica;
  let replicaView: UiReplicaView | null = null;
  if (replica && !state.corrupted) {
    let stats: { memories: number; revisions: number; pendingContent: number } | undefined;
    try { stats = replica.stats(); } catch { stats = undefined; }
    replicaView = {
      available: true,
      corrupted: false,
      appliedSeq: replica.appliedSeq,
      generation: replica.generation,
      dataTime: replica.dataTime,
      verifiedAt: replica.verifiedAt,
      stale: state.now.getTime() - Date.parse(replica.dataTime) > STALE_AFTER_MS,
      pendingContent: stats?.pendingContent ?? 0,
      memories: stats?.memories ?? 0,
      revisions: stats?.revisions ?? 0,
    };
  }
  return {
    schemaVersion: 1,
    hostId: state.hostId,
    generatedAt: state.now.toISOString(),
    paired: grant !== undefined,
    grant: grant === undefined ? null : {
      grantId: grant.grantId,
      projects: [...grant.projects],
      globalIncluded: grant.globalIncluded,
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      generation: grant.generation,
      expired: Date.parse(grant.expiresAt) <= state.now.getTime(),
      revoked: state.revoked,
    },
    replica: replicaView ?? (state.corrupted ? { available: false, corrupted: true, appliedSeq: 0, generation: 0, dataTime: new Date(0).toISOString(), verifiedAt: null, stale: true, pendingContent: 0, memories: 0, revisions: 0 } : null),
    intents: {
      queued: state.intents.filter(intent => intent.state === 'queued').length,
      isolated: state.intents.filter(intent => intent.state === 'isolated').length,
    },
  };
}

/**
 * Lists current, active revisions under the Host grant. `query` filters the same way local
 * recall scores terms; no query lists the newest publications instead of scoring them.
 */
export interface UiMemoriesInput {
  query?: string | undefined;
  limit?: number | undefined;
  scope?: 'project' | 'global' | undefined;
  projectId?: string | undefined;
}

/**
 * Lists current, active revisions under the Host grant. `query` filters the same way local
 * recall scores terms; no query lists the newest publications instead of scoring them.
 * Scope and project narrow the same rows the grant already allows; they cannot widen it.
 */
export function uiMemories(state: UiReadState, input: UiMemoriesInput): UiMemoryListRecord {
  const base: UiAvailability = availability(state);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const query = input.query?.trim() ? input.query.trim() : null;
  const scope = input.scope ?? null;
  const projectId = input.projectId?.trim() ? input.projectId.trim() : null;
  const dataTime = state.replica && !state.corrupted ? state.replica.dataTime : null;
  if (base.status !== 'ok' || !state.replica) return { ...base, query, scope, projectId, total: 0, returned: 0, complete: false, dataTime, items: [] };
  const replica = state.replica;
  let rows: ReturnType<ReplicaStore['listCurrent']>;
  let complete = true;
  try {
    if (query === null) rows = replica.listCurrent(limit, 0);
    else {
      const recall = replica.recall(query, limit);
      const scores = new Map(recall.memories.map(memory => [memory.id, memory.score]));
      rows = replica.listCurrent(limit, 0, [...scores.keys()]).sort((left, right) => (scores.get(right.providerMemoryId) ?? 0) - (scores.get(left.providerMemoryId) ?? 0));
      complete = recall.complete;
    }
  } catch {
    return { status: 'corrupted', reason: 'content integrity check failed', query, scope, projectId, total: 0, returned: 0, complete: false, dataTime, items: [] };
  }
  const items: UiMemorySummaryRecord[] = [];
  for (const row of rows) {
    if (scope !== null && row.scope !== scope) continue;
    if (projectId !== null && row.projectId !== projectId) continue;
    let record: MemoryCatalogRecord;
    try { record = replica.describe(row.memoryId); } catch { continue; }
    if (!readable(state, record)) continue;
    items.push({
      memoryId: row.memoryId,
      revisionId: row.revisionId,
      state: row.state,
      scope: row.scope,
      ...(row.projectId === undefined ? {} : { projectId: row.projectId }),
      applicability: row.applicability,
      revisionNumber: row.revisionNumber,
      providerMemoryId: row.providerMemoryId,
      publishedAt: row.publishedAt,
      excerpt: excerptOf(row.content),
      contentLength: row.content.length,
    });
  }
  return {
    status: 'ok', query, scope, projectId, total: items.length, returned: items.length,
    complete: complete && state.replica.pendingContentCount() === 0, dataTime, items,
  };
}

/** One memory with its full current text, revision history and relations, under the same grant. */
export function uiMemory(state: UiReadState, memoryId: string): UiMemoryDetailRecord {
  const base: UiAvailability = availability(state);
  if (base.status !== 'ok' || !state.replica) {
    return { ...base, memoryId, revisionId: null, state: 'unverified', scope: 'global', applicability: '', content: null, revisions: [], relations: [] };
  }
  const replica = state.replica;
  let record: MemoryCatalogRecord;
  try { record = replica.describe(memoryId); } catch { return { status: 'unavailable', reason: 'not_found', memoryId, revisionId: null, state: 'unverified', scope: 'global', applicability: '', content: null, revisions: [], relations: [] }; }
  if (!readable(state, record)) return { status: 'unauthorized', reason: 'out_of_grant', memoryId, revisionId: null, state: record.state, scope: record.scope, ...(record.projectId === undefined ? {} : { projectId: record.projectId }), applicability: record.applicability, content: null, revisions: [], relations: [] };
  let content: string | null = null;
  try { content = replica.readMemory(memoryId).slice(0, CONTENT_LIMIT); } catch { content = null; }
  return {
    status: 'ok',
    memoryId,
    revisionId: record.currentRevisionId,
    state: record.state,
    scope: record.scope,
    ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
    applicability: record.applicability,
    content,
    revisions: record.revisions.map(revision => ({
      revisionId: revision.id, number: revision.number, publishedAt: revision.publishedAt,
      effectiveAt: revision.effectiveAt, current: revision.id === record.currentRevisionId,
    })),
    relations: record.relations.map(relation => ({
      id: relation.id, kind: relation.kind, targetMemoryId: relation.sourceMemoryId === memoryId ? relation.targetMemoryId : relation.sourceMemoryId,
      reason: relation.reason, effectiveAt: relation.effectiveAt,
    })),
  };
}

/** One historical revision's verified text, under the same grant as its memory. */
export function uiRevision(state: UiReadState, memoryId: string, revisionId: string): UiRevisionRecord {
  const base: UiAvailability = availability(state);
  const empty = { memoryId, revisionId, number: 0, publishedAt: '', effectiveAt: '', current: false, content: null };
  if (base.status !== 'ok' || !state.replica) return { ...base, ...empty };
  const replica = state.replica;
  let record: MemoryCatalogRecord;
  try { record = replica.describe(memoryId); } catch { return { status: 'unavailable', reason: 'not_found', ...empty }; }
  if (!readable(state, record)) return { status: 'unauthorized', reason: 'out_of_grant', ...empty };
  try {
    const revision = replica.revision(memoryId, revisionId);
    return {
      status: 'ok', memoryId, revisionId,
      number: revision.number, publishedAt: revision.publishedAt, effectiveAt: revision.effectiveAt,
      current: revisionId === record.currentRevisionId,
      content: revision.content.slice(0, CONTENT_LIMIT),
    };
  } catch (error) {
    const code = error instanceof MnemoWeaveError ? error.code : undefined;
    return { status: code === 'NOT_FOUND' ? 'unavailable' : 'corrupted', reason: code === 'NOT_FOUND' ? 'not_found' : 'content_unavailable', ...empty };
  }
}

/** The offline intent queue as the UI shows it: what waits for the Server, never its full payload. */
export function uiIntents(state: UiReadState): UiIntentsRecord {
  const items = state.intents.slice(-INTENT_LIMIT).map(intent => ({
    intentId: intent.intentId,
    kind: intent.kind,
    state: intent.state,
    createdAt: intent.createdAt,
    ...(typeof intent.payload['sessionId'] === 'string' ? { sessionId: intent.payload['sessionId'] } : {}),
    ...(intent.receiptRef === undefined ? {} : { receiptRef: intent.receiptRef }),
  }));
  return {
    status: state.grant ? 'ok' : 'unauthorized',
    ...(state.grant ? {} : { reason: 'unpaired' }),
    queued: state.intents.filter(intent => intent.state === 'queued').length,
    isolated: state.intents.filter(intent => intent.state === 'isolated').length,
    items,
  };
}
