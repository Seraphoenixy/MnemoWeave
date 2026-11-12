/**
 * Shared Host client: the one place the three host plugins use to reach the MnemoWeave Server.
 *
 * There is no local proxy process and no local replica: every call is an HTTP request to the
 * Server, authenticated with the service token and scoped by the `x-mnemoweave-host` header.
 * Hosts never talk to Mnemon directly. Content budgets for model-facing reads are enforced by the
 * Server; this client only forwards the session and turn identity the host already has.
 */
export interface ClientOptions {
  baseUrl: string;
  token: string;
  hostId: string;
  timeoutMs?: number;
}

export interface ClientResult<T> { ok: true; value: T }
export interface ClientFailure { ok: false; error: { code: string; traceId?: string } }

export type ClientResponse<T> = ClientResult<T> | ClientFailure;

const DEFAULT_TIMEOUT_MS = 10_000;
/** Injection must never block a host turn; the deadline is part of the contract. */
export const INJECTION_TIMEOUT_MS = 2_000;

export class MemoryClient {
  private readonly baseUrl: string;
  private readonly token: string;
  readonly hostId: string;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    if (!/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?\/?$/i.test(options.baseUrl.trim())) {
      throw new Error('Memory client baseUrl must be a loopback http(s) URL');
    }
    if (options.token.length < 24) throw new Error('Memory client token must contain at least 24 characters');
    if (!options.hostId.trim()) throw new Error('Memory client requires a host id');
    this.baseUrl = options.baseUrl.trim().replace(/\/$/, '');
    this.token = options.token;
    this.hostId = options.hostId;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async call<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown, timeoutMs = this.timeoutMs, query?: Record<string, string | number | boolean | undefined>): Promise<ClientResponse<T>> {
    const search = query === undefined ? '' : new URLSearchParams(
      Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]),
    ).toString();
    const suffix = search === '' ? '' : `?${search}`;
    try {
      const response = await fetch(`${this.baseUrl}${path}${suffix}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          'x-mnemoweave-host': this.hostId,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      const parsed: unknown = text === '' ? {} : JSON.parse(text);
      if (!response.ok) {
        const record = parsed as { code?: unknown; traceId?: unknown };
        return { ok: false, error: { code: typeof record.code === 'string' ? record.code : 'INTERNAL', ...(typeof record.traceId === 'string' ? { traceId: record.traceId } : {}) } };
      }
      return { ok: true, value: parsed as T };
    } catch (error) {
      const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return { ok: false, error: { code: timeout ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE' } };
    }
  }

  /** The complete resident rule set for one session; a partial delivery is reported, never rendered. */
  inject(input: { sessionId: string }, timeoutMs = INJECTION_TIMEOUT_MS): Promise<ClientResponse<InjectionRecord>> {
    return this.call('POST', '/v1/inject', input, timeoutMs);
  }

  recall(input: { query: string; limit?: number }, timeoutMs = this.timeoutMs): Promise<ClientResponse<{ memories: Array<{ id: string; content: string; score?: number }> }>> {
    return this.call('POST', '/v1/recall', input, timeoutMs);
  }

  /** A candidate submission; never a publication. */
  remember(input: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<ClientResponse<Record<string, unknown>>> {
    return this.call('POST', '/v1/remember', input, timeoutMs);
  }

  event(input: Record<string, unknown>): Promise<ClientResponse<{ status: 'stored' | 'replayed' | 'skipped'; eventId: string }>> {
    return this.call('POST', '/v1/events', input);
  }

  /** Last injection result for this host; NOT_FOUND when it has never injected. */
  lastInjection(sessionId?: string): Promise<ClientResponse<InjectionReport>> {
    return this.call('GET', '/v1/injections/latest', undefined, this.timeoutMs, sessionId === undefined ? {} : { sessionId });
  }

  closeSession(sessionId: string): Promise<ClientResponse<{ closed: boolean }>> {
    return this.call('POST', '/v1/session/close', { sessionId });
  }

  /** Claim the workspace one session works in; an empty payload records no binding. */
  bindSessionWorkspace(sessionId: string, input: { rootPath?: string; workspaceId?: string }): Promise<ClientResponse<{ sessionId: string; workspaceId: string | null; boundAt: string }>> {
    return this.call('PUT', `/v1/sessions/${encodeURIComponent(sessionId)}/workspace`, input);
  }

  workspaces(): Promise<ClientResponse<{ items: WorkspaceItem[] }>> {
    return this.call('GET', '/v1/workspaces');
  }

  listMemories(query: {
    query?: string; limit?: number; cursor?: string;
    category?: string; knowledgeType?: string; entity?: string; sort?: 'newest' | 'oldest' | 'importance';
  } = {}): Promise<ClientResponse<{
    items: MemoryListItem[];
    nextCursor?: string;
    categories?: { value: string; count: number }[];
    knowledgeTypes?: { value: string; count: number }[];
    entities?: { value: string; count: number }[];
  }>> {
    return this.call('GET', '/v1/memories', undefined, this.timeoutMs, query);
  }

  readMemory(memoryId: string, revisionId?: string): Promise<ClientResponse<Record<string, unknown>>> {
    return this.call('GET', `/v1/memories/${encodeURIComponent(memoryId)}`, undefined, this.timeoutMs, revisionId === undefined ? {} : { revisionId });
  }

  /** Official embedding coverage and the recall mode that follows from it. */
  embeddingDiagnostics(): Promise<ClientResponse<EmbeddingDiagnostics>> {
    return this.call('GET', '/v1/diagnostics/embeddings');
  }

  idleReviewScan(input: { sessionId: string; completedThroughTurn: number; maxSignals?: number }): Promise<ClientResponse<IdleReviewScan>> {
    return this.call('POST', '/v1/idle-review/scan', input);
  }
  idleReviewSignals(sessionId: string): Promise<ClientResponse<{ items: Array<IdleReviewSignal> }>> {
    return this.call('GET', '/v1/idle-review/signals', undefined, this.timeoutMs, { sessionId });
  }
  idleReviewRunStart(input: { sessionId: string; maxSignals?: number }): Promise<ClientResponse<{ run: IdleReviewRun; signals: IdleReviewSignal[] }>> {
    return this.call('POST', '/v1/idle-review/runs', input);
  }
  idleReviewRunItem(runId: string, item: Record<string, unknown>): Promise<ClientResponse<IdleReviewRun>> {
    return this.call('POST', `/v1/idle-review/runs/${encodeURIComponent(runId)}/items`, item);
  }
  idleReviewRunFinish(runId: string, state: 'succeeded' | 'failed' | 'cancelled', error?: string): Promise<ClientResponse<IdleReviewRun>> {
    return this.call('POST', `/v1/idle-review/runs/${encodeURIComponent(runId)}/finish`, { state, ...(error === undefined ? {} : { error }) });
  }
  idleReviewPending(): Promise<ClientResponse<{ sessions: Array<{ sessionId: string; count: number }> }>> {
    return this.call('GET', '/v1/idle-review/pending');
  }

  embeddingBackfill(): Promise<ClientResponse<DiagnosticJob>> {
    return this.call('POST', '/v1/diagnostics/embeddings/backfill');
  }

  /** Provider-ranked search over the shared collection; `hint` is a workspace name used as a cue. */
  explore(query: string, limit = 20, minScore = 0, hint?: string): Promise<ClientResponse<{ query: string; hits: Array<Record<string, unknown>>; unregistered: number; truncated: boolean }>> {
    return this.call('POST', '/v1/memories/explore', { query, limit, minScore, ...(hint === undefined ? {} : { hint }) });
  }

  graph(query: { limit?: number } = {}): Promise<ClientResponse<{ nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>>; truncated: boolean }>> {
    return this.call('GET', '/v1/memories/graph', undefined, this.timeoutMs, query);
  }

  /** Create a formal memory directly; the Server publishes it without a review round. */
  createMemory(input: {
    content: string; knowledgeType: string;
    category?: string; importance?: number; tags?: string[]; entities?: string[]; reason?: string;
  }): Promise<ClientResponse<{ memoryId: string; revisionId: string; providerMemoryId: string; contentHash: string; entryVersion: number; duplicate?: boolean }>> {
    return this.call('POST', '/v1/memories', input);
  }

  /** Edit a formal memory against the version the editor read. */
  editMemory(memoryId: string, input: {
    content: string; reason?: string; entryVersion: number;
    category?: string; knowledgeType?: string; importance?: number; tags?: string[]; entities?: string[];
  }): Promise<ClientResponse<{ memoryId: string; revisionId: string; providerMemoryId: string; contentHash: string; entryVersion: number; duplicate?: boolean }>> {
    return this.call('PATCH', `/v1/memories/${encodeURIComponent(memoryId)}`, input);
  }

  /** Withdraw a memory: it leaves recall, its history stays readable. */
  withdrawMemory(memoryId: string, input: { reason: string; entryVersion: number }): Promise<ClientResponse<{ memoryId: string; revisionId: string; entryVersion: number; withdrawnAt: string }>> {
    return this.call('POST', `/v1/memories/${encodeURIComponent(memoryId)}/withdraw`, input);
  }

  health(): Promise<ClientResponse<{ ready: true; version: string }>> {
    return this.call('GET', '/health/ready');
  }

  /** Every resident rule; usage is the byte accounting of the enabled set. */
  rules(): Promise<ClientResponse<{ items: RuleListItem[]; usage: RuleUsage }>> {
    return this.call('GET', '/v1/rules');
  }

  /** Rules whose exact text left the resident set, with their source version. */
  ruleArchive(): Promise<ClientResponse<{ items: RuleArchiveItem[] }>> {
    return this.call('GET', '/v1/rules/archive');
  }

  createRule(input: { body: string; enabled?: boolean; importance?: 'critical' | 'normal' | 'low'; pinned?: boolean }): Promise<ClientResponse<RuleListItem>> {
    return this.call('POST', '/v1/rules', input);
  }

  /** Edit, enable/disable or remove one rule; `baseVersion` is the version the caller read. */
  editRule(ruleId: string, input: { body?: string; enabled?: boolean; importance?: 'critical' | 'normal' | 'low'; pinned?: boolean; remove?: true; baseVersion: number }): Promise<ClientResponse<RuleListItem>> {
    return this.call('PATCH', `/v1/rules/${encodeURIComponent(ruleId)}`, input);
  }

  /** Management list for one workspace; the Server refuses a request without a workspace. */
  archives(query: { workspaceId?: string; includeWithdrawn?: boolean; limit?: number; cursor?: string } = {}): Promise<ClientResponse<{ items: ArchiveItem[]; capacities: ArchiveCapacity[]; nextCursor?: string }>> {
    return this.call('GET', '/v1/archives', undefined, this.timeoutMs, query);
  }

  /** Bounded archive search inside one workspace. */
  searchArchives(query: { workspaceId: string; query: string; limit?: number; includeArchived?: boolean }): Promise<ClientResponse<ArchiveSearchResult>> {
    return this.call('GET', '/v1/archives/search', undefined, this.timeoutMs, query);
  }

  /** Capacity maintenance: active archives whose release would free room, oldest first. */
  archiveReleaseCandidates(workspaceId: string, limit?: number): Promise<ClientResponse<{
    workspaceId: string;
    capacity: ArchiveCapacity;
    items: Array<{ entryId: string; title: string; bodyBytes: number; version: number; updatedAt: string }>;
    remaining: number;
  }>> {
    return this.call('GET', '/v1/archives/release-candidates', undefined, this.timeoutMs, {
      workspaceId, ...(limit === undefined ? {} : { limit }),
    });
  }

  archiveHistory(entryId: string): Promise<ClientResponse<{ entryId: string; items: ArchiveHistoryItem[] }>> {
    return this.call('GET', `/v1/archives/${encodeURIComponent(entryId)}/history`);
  }

  /** One model-facing segment of an archive body in the session's bound workspace. */
  archiveContent(entryId: string, input: { cursor?: string; sessionId?: string } = {}): Promise<ClientResponse<ArchiveSegment>> {
    return this.call('GET', `/v1/archives/${encodeURIComponent(entryId)}/content`, undefined, this.timeoutMs, input);
  }

  editArchiveState(entryId: string, input: { state: 'active' | 'archived'; baseVersion: number }): Promise<ClientResponse<ArchiveItem>> {
    return this.call('POST', `/v1/archives/${encodeURIComponent(entryId)}/state`, input);
  }

  createArchive(input: { workspaceId: string; title: string; body: string; source: 'session' | 'tool' | 'user'; verification: 'verified' | 'open' | 'refuted'; evidence: string }): Promise<ClientResponse<ArchiveItem>> {
    return this.call('POST', '/v1/archives', input);
  }

  editArchive(entryId: string, input: { title?: string; body?: string; verification?: 'verified' | 'open' | 'refuted'; evidence?: string; baseVersion: number }): Promise<ClientResponse<ArchiveItem>> {
    return this.call('PATCH', `/v1/archives/${encodeURIComponent(entryId)}`, input);
  }

  /** Execute one action of an authorized write task. Host code only; never a model tool. */
  writeTaskAction(taskId: string, index: number, action: Record<string, unknown>): Promise<ClientResponse<WriteTaskReceipt>> {
    return this.call('POST', `/v1/memory-write-tasks/${encodeURIComponent(taskId)}/actions/${index}`, action);
  }

  /** The latest known receipt for one action of this host's task. */
  writeTaskReceipt(taskId: string, index: number): Promise<ClientResponse<WriteTaskReceipt>> {
    return this.call('GET', `/v1/memory-write-tasks/${encodeURIComponent(taskId)}/actions/${index}`);
  }

  createDistillation(input: Record<string, unknown>): Promise<ClientResponse<ArchiveDistillation>> {
    return this.call('POST', '/v1/archive-distillations', input);
  }

  readDistillation(draftId: string): Promise<ClientResponse<ArchiveDistillation>> {
    return this.call('GET', `/v1/archive-distillations/${encodeURIComponent(draftId)}`);
  }

  /** This local Server's sync state with the remote sync Server, per stream. */
  syncStatus(): Promise<ClientResponse<SyncStatus>> {
    return this.call('GET', '/v1/sync/status');
  }

  /** Trigger one sync pass; overlapping passes are skipped by the Server. */
  syncRefresh(): Promise<ClientResponse<{ streams: string[]; pulled: number; applied: number; errors: string[]; skipped: boolean }>> {
    return this.call('POST', '/v1/sync/refresh', {});
  }
}

export interface RuleListItem {
  entryId: string;
  body: string;
  enabled: boolean;
  version: number;
  withdrawnAt: string | null;
  importance: 'critical' | 'normal' | 'low';
  pinned: boolean;
  bodyBytes: number;
}

export interface RuleUsage {
  limitBytes: number;
  itemMaxBytes: number;
  usedBytes: number;
  entryCount: number;
  exceeded: boolean;
  overByBytes: number;
}

export interface RuleArchiveItem {
  archiveId: string;
  ruleId: string;
  ruleVersion: number;
  body: string;
  importance: 'critical' | 'normal' | 'low';
  pinned: boolean;
  archivedAt: string;
  reason: 'capacity' | 'manual';
}

export interface WorkspaceItem {
  workspaceId: string;
  name: string;
  createdAt: string;
}

export interface ArchiveItem {
  entryId: string;
  workspaceId: string;
  title: string;
  body: string;
  source: 'session' | 'tool' | 'user';
  verification: 'verified' | 'open' | 'refuted';
  evidence: string;
  version: number;
  withdrawnAt: string | null;
  state: 'active' | 'archived';
  archivedAt: string | null;
  bodyBytes: number;
}

export interface ArchiveCapacity {
  workspaceId: string;
  activeBytes: number;
  limitBytes: number;
  activeCount: number;
  archivedCount: number;
  exceeded: boolean;
}

export interface ArchiveSearchHit {
  entryId: string;
  workspaceId: string;
  title: string;
  state: 'active' | 'archived';
  version: number;
  verification: 'verified' | 'open' | 'refuted';
  excerpt: string;
  excerptChars: number;
  excerptTruncated: boolean;
  bodyChars: number;
  score: number;
}

export interface ArchiveSearchResult {
  query: string;
  total: number;
  results: ArchiveSearchHit[];
  totalChars: number;
  truncated: boolean;
  totalLimitChars: number;
  callsLimit: number;
}

export interface ArchiveHistoryItem {
  revisionId: string;
  entryId: string;
  workspaceId: string;
  version: number;
  title: string;
  body: string;
  source: 'session' | 'tool' | 'user';
  verification: 'verified' | 'open' | 'refuted';
  evidence: string;
  state: 'active' | 'archived';
  archivedAt: string | null;
  recordedAt: string;
}

export interface ArchiveSegment {
  entryId: string;
  workspaceId: string;
  version: number;
  title: string;
  content: string;
  nextCursor?: string;
  complete: boolean;
  totalChars: number;
}

export interface InjectionRule {
  entryId: string;
  version: number;
  body: string;
  importance?: 'critical' | 'normal' | 'low';
  bodyBytes: number;
}

export interface InjectionRecord {
  hostId: string;
  sessionId: string;
  rules: InjectionRule[];
  usedBytes: number;
  limitBytes: number;
  complete: boolean;
  createdAt: string;
}

export interface InjectionReport {
  id: string;
  hostId: string;
  sessionId: string;
  ruleCount: number;
  usedBytes: number;
  failure?: 'deadline' | 'output_limit' | 'request_failed';
  createdAt: string;
}

export interface EmbeddingDiagnostics {
  provider: 'mnemon'; model: string; protocol: string;
  serviceAvailable: boolean; modelAvailable: boolean;
  embedded: number; total: number; coverage: number;
  recallMode: 'semantic' | 'keyword' | 'unknown';
  degraded: boolean; lastError: string | null; checkedAt: string;
}

export interface DiagnosticJob {
  id: string; kind: string; state: 'running' | 'succeeded' | 'failed' | 'interrupted';
  startedAt: string; finishedAt: string | null; detail?: Record<string, unknown>;
}

export interface IdleReviewSignal {
  id: string; sessionId: string; turnId: number; eventId: string; text: string;
  reason: 'correction' | 'standing-instruction' | 'durable-fact'; createdAt: string;
}

export interface IdleReviewScan {
  signals: IdleReviewSignal[];
  lastTurn: number;
  skipped: { tooShort: number; question: number; noTurn: number; outOfWindow: number; duplicate: number; noRetention: number };
}

export interface IdleReviewRunItem {
  index: number;
  action: 'create' | 'edit' | 'remove' | 'skip';
  kind: 'rule' | 'workspace-archive' | 'formal-memory';
  state: 'applied' | 'failed' | 'skipped';
  targetId?: string;
  detail?: Record<string, unknown>;
}

export interface IdleReviewRun {
  id: string; sessionId: string;
  state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  attempt: number; startedAt: string; finishedAt: string | null; error: string | null;
  items: IdleReviewRunItem[];
}

export interface WriteTaskReceipt {
  taskId: string;
  index: number;
  kind: 'formal-memory' | 'rule' | 'workspace-archive';
  action: 'create' | 'edit' | 'withdraw' | 'remove' | 'skip';
  status: 'published' | 'duplicate' | 'applied' | 'skipped' | 'needs_review' | 'queued' | 'unknown' | 'failed';
  memoryId: string | null;
  entryVersion: number | null;
  entryId: string | null;
  candidateId: string | null;
  errorCode: string | null;
  updatedAt: string;
}

export interface ArchiveDistillation {
  draftId: string;
  source: { workspaceId: string; entryId: string; entryVersion: number; contentHash: string };
  content: string;
  knowledgeType: string;
  category?: string;
  importance?: number;
  tags?: string[];
  entities?: string[];
  reason: string;
  assessment: 'supported' | 'uncertain' | 'conflict';
  contentHash: string;
  createdAt: string;
  taskId: string | null;
}

export interface SyncStreamState {
  stream: string;
  cursor: number;
  lastPullAt: string | null;
  lastError: string | null;
  pending: number;
  unknown: number;
  unapplied: number;
}

export interface SyncStatus {
  enabled: boolean;
  protocol: number;
  streams: SyncStreamState[];
  updatedAt: string;
}

export * from './render.ts';
export * from './ensure-server.ts';
export * from './registration.ts';

export interface MemoryListItem {
  memoryId: string; revisionId: string; providerMemoryId: string;
  applicability: string; publishedAt: string; content: string;
  /** Base version for an edit; 0 until the memory has been edited. */
  entryVersion: number;
  knowledgeType?: string;
  category?: string;
  importance?: number;
  tags?: string[];
  entities?: string[];
}

/** Host processes read the same three variables; there is no proxy and no repository-relative path. */
export function clientFromEnv(env: NodeJS.ProcessEnv = process.env): MemoryClient {
  const baseUrl = env.MNEMOWEAVE_SERVER ?? 'http://127.0.0.1:4317';
  const token = env.MNEMOWEAVE_TOKEN ?? '';
  const hostId = env.MNEMOWEAVE_HOST_ID ?? '';
  return new MemoryClient({ baseUrl, token, hostId });
}
