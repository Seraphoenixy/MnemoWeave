/**
 * Shared Host client: the one place the three host plugins use to reach the MnemoWeave Server.
 *
 * There is no local proxy process and no local replica: every call is an HTTP request to the
 * Server, authenticated with the service token and scoped by the `x-mnemoweave-host` header.
 * Hosts never talk to Mnemon directly.
 */
export interface ClientOptions {
  baseUrl: string;
  token: string;
  hostId: string;
  /** Project this host works on; sent as a header so every request inherits it. */
  projectId?: string;
  timeoutMs?: number;
}

export interface ClientResult<T> { ok: true; value: T }
export interface ClientFailure { ok: false; error: { code: string; traceId?: string } }

export type ClientResponse<T> = ClientResult<T> | ClientFailure;

const DEFAULT_TIMEOUT_MS = 10_000;
/** Injection must never block a host turn; callers pass a smaller budget when assembling a View. */
export const INJECTION_TIMEOUT_MS = 2_000;

export class MemoryClient {
  private readonly baseUrl: string;
  private readonly token: string;
  readonly hostId: string;
  private readonly timeoutMs: number;
  private readonly projectId: string | undefined;

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
    const project = options.projectId?.trim();
    if (project !== undefined && (project.length === 0 || project.length > 200)) throw new Error('Memory client projectId must contain 1-200 characters');
    this.projectId = project;
  }

  private async call<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<ClientResponse<T>> {
    const bearer = this.token;
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
          'x-mnemoweave-host': this.hostId,
          ...(this.projectId === undefined ? {} : { 'x-mnemoweave-project': this.projectId }),
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

  /** Assemble the injection View for one session; the deadline is part of the contract, not a nicety. */
  inject(input: Record<string, unknown>, timeoutMs = INJECTION_TIMEOUT_MS): Promise<ClientResponse<Record<string, unknown>>> {
    return this.call('POST', '/v1/inject', input, timeoutMs);
  }

  context(input: Record<string, unknown>): Promise<ClientResponse<Record<string, unknown>>> {
    return this.call('POST', '/v1/runtime/context', input);
  }

  recall(input: { query: string; limit?: number }): Promise<ClientResponse<{ memories: Array<{ id: string; content: string; score?: number }> }>> {
    return this.call('POST', '/v1/recall', input);
  }

  remember(input: Record<string, unknown>): Promise<ClientResponse<Record<string, unknown>>> {
    return this.call('POST', '/v1/remember', input);
  }

  event(input: Record<string, unknown>): Promise<ClientResponse<{ status: 'stored' | 'replayed' | 'skipped'; eventId: string }>> {
    return this.call('POST', '/v1/events', input);
  }

  /** The newest injection report for this host; NOT_FOUND when it has never injected. */
  lastInjection(sessionId?: string): Promise<ClientResponse<InjectionReport>> {
    const suffix = sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(sessionId)}`;
    return this.call('GET', `/v1/injections/latest${suffix}`);
  }

  closeSession(sessionId: string): Promise<ClientResponse<{ closed: boolean }>> {
    return this.call('POST', '/v1/session/close', { sessionId });
  }

  /**
   * Browse published memories. `cursor` continues a previous page; omit it to start over.
   */
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
    const params = new URLSearchParams();
    if (query.query !== undefined) params.set('query', query.query);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    if (query.category !== undefined) params.set('category', query.category);
    if (query.knowledgeType !== undefined) params.set('knowledgeType', query.knowledgeType);
    if (query.entity !== undefined) params.set('entity', query.entity);
    if (query.sort !== undefined) params.set('sort', query.sort);
    const suffix = params.toString() === '' ? '' : `?${params.toString()}`;
    return this.call('GET', `/v1/memories${suffix}`);
  }

  readMemory(memoryId: string, revisionId?: string): Promise<ClientResponse<Record<string, unknown>>> {
    const suffix = revisionId === undefined ? '' : `?revisionId=${encodeURIComponent(revisionId)}`;
    return this.call('GET', `/v1/memories/${encodeURIComponent(memoryId)}${suffix}`);
  }

  /**
   * Provider-ranked semantic search, mapped by the Server to memories this machine knows.
   * Distinct from `listMemories`, which matches body text over a stable scan.
   */
  explore(query: string, limit = 20, minScore = 0): Promise<ClientResponse<{
    query: string;
    hits: Array<Record<string, unknown>>;
    unregistered: number;
    truncated: boolean;
  }>> {
    return this.call('POST', '/v1/memories/explore', { query, limit, minScore });
  }

  /** Relation graph over the visible catalog: structure only, no bodies. */
  graph(query: { limit?: number } = {}): Promise<ClientResponse<{
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
    truncated: boolean;
  }>> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const suffix = params.toString() === '' ? '' : `?${params.toString()}`;
    return this.call('GET', `/v1/memories/graph${suffix}`);
  }

  /** Create a formal memory directly; the Server publishes it without a review round. */
  createMemory(input: {
    content: string; knowledgeType: string;
    category?: string; importance?: number; tags?: string[]; entities?: string[];
    reason?: string;
  }): Promise<ClientResponse<{ memoryId: string; revisionId: string; providerMemoryId: string; contentHash: string; entryVersion: number }>> {
    return this.call('POST', '/v1/memories', input);
  }

  /**
   * Edit a formal memory.
   *
   * The write records a `local-user` decision, so the Server requires the caller to identify
   * itself: the service token plus the Host header. No second credential is involved; the audit
   * trail attributes the change to the host that sent it.
   */
  editMemory(memoryId: string, input: {
    content: string; reason?: string; entryVersion: number;
    category?: string; knowledgeType?: string; importance?: number; tags?: string[];
  }): Promise<ClientResponse<{ memoryId: string; revisionId: string; providerMemoryId: string; contentHash: string; entryVersion: number }>> {
    return this.call('PATCH', `/v1/memories/${encodeURIComponent(memoryId)}`, input);
  }

  /** Withdraw a memory: it leaves recall, its history stays readable. */
  withdrawMemory(memoryId: string, input: { reason: string; entryVersion: number }): Promise<ClientResponse<{ memoryId: string; revisionId: string; entryVersion: number; withdrawnAt: string }>> {
    return this.call('POST', `/v1/memories/${encodeURIComponent(memoryId)}/withdraw`, input);
  }

  health(): Promise<ClientResponse<{ ready: true; version: string }>> {
    return this.call('GET', '/health/ready');
  }

  /** Every rule: rules apply to every session. */
  rules(): Promise<ClientResponse<{ items: RuleListItem[] }>> {
    return this.call('GET', '/v1/rules');
  }

  /** Publish a runtime rule. The Server treats user input as already confirmed. */
  createRule(input: { body: string; enabled?: boolean }): Promise<ClientResponse<RuleListItem>> {
    return this.call('POST', '/v1/rules', input);
  }

  /** Edit a runtime rule; `baseVersion` is the version the caller read before editing. */
  editRule(ruleId: string, input: { body?: string; enabled?: boolean; baseVersion?: number }): Promise<ClientResponse<RuleListItem>> {
    return this.call('PATCH', `/v1/rules/${encodeURIComponent(ruleId)}`, input);
  }

  /** Project archives; without projectId the Server returns every project. */
  archives(query: { projectId?: string; includeWithdrawn?: boolean } = {}): Promise<ClientResponse<{ items: ArchiveItem[] }>> {
    const params = new URLSearchParams();
    if (query.projectId !== undefined) params.set('projectId', query.projectId);
    if (query.includeWithdrawn !== undefined) params.set('includeWithdrawn', String(query.includeWithdrawn));
    const suffix = params.toString() === '' ? '' : `?${params.toString()}`;
    return this.call('GET', `/v1/archives${suffix}`);
  }

  createArchive(input: Pick<ArchiveItem, 'projectId' | 'title' | 'body' | 'source' | 'verification' | 'evidence'>): Promise<ClientResponse<ArchiveItem>> {
    return this.call('POST', '/v1/archives', input);
  }

  editArchive(entryId: string, input: Pick<ArchiveItem, 'title' | 'body' | 'verification' | 'evidence'> & { baseVersion: number }): Promise<ClientResponse<ArchiveItem>> {
    return this.call('PATCH', `/v1/archives/${encodeURIComponent(entryId)}`, input);
  }

  /** This local Server's sync state with the remote sync Server, per scope. */
  syncStatus(): Promise<ClientResponse<SyncStatus>> {
    return this.call('GET', '/v1/sync/status');
  }

  /** Trigger one sync pass; overlapping passes are skipped by the Server. */
  syncRefresh(): Promise<ClientResponse<{ scopes: string[]; pulled: number; applied: number; errors: string[]; skipped: boolean }>> {
    return this.call('POST', '/v1/sync/refresh', {});
  }
}

export interface RuleListItem {
  entryId: string;
  scope: 'global' | 'project';
  projectId: string | null;
  body: string;
  enabled: boolean;
  version: number;
  withdrawnAt: string | null;
}

export interface ArchiveItem {
  entryId: string;
  projectId: string;
  title: string;
  body: string;
  source: 'session' | 'tool' | 'user';
  verification: 'verified' | 'open' | 'refuted';
  evidence: string;
  version: number;
  withdrawnAt: string | null;
}

export interface SyncScopeState {
  scope: string;
  cursor: number;
  lastPullAt: string | null;
  lastError: string | null;
  pending: number;
  unknown: number;
  unapplied: number;
}

export interface SyncStatus {
  enabled: boolean;
  scopes: SyncScopeState[];
  updatedAt: string;
}

export * from './render.ts';
export * from './ensure-server.ts';
export * from './registration.ts';

export interface MemoryListItem {
  memoryId: string; revisionId: string; providerMemoryId: string;
  scope: 'project' | 'global'; projectId?: string;
  applicability: string; publishedAt: string; content: string;
  /** Base version for an edit; 0 until the memory has been edited. */
  entryVersion: number;
  /** Classification of the current revision; absent means it was never recorded. */
  knowledgeType?: string;
  category?: string;
  importance?: number;
  tags?: string[];
  entities?: string[];
}

/** What one View injection delivered; the host reads only its own rows. */
export interface InjectionReport {
  id: string; hostId: string; sessionId: string;
  rulesInjected: number;
  rulesOmitted: 'budget_exceeded' | null;
  memoriesInjected: number;
  usedTokens: number;
  createdAt: string;
}

/** Host processes read the same three variables; there is no proxy and no repository-relative path. */
export function clientFromEnv(env: NodeJS.ProcessEnv = process.env): MemoryClient {
  const baseUrl = env.MNEMOWEAVE_SERVER ?? 'http://127.0.0.1:4317';
  const token = env.MNEMOWEAVE_TOKEN ?? '';
  const hostId = env.MNEMOWEAVE_HOST_ID ?? '';
  const projectId = env.MNEMOWEAVE_PROJECT_ID?.trim();
  return new MemoryClient({ baseUrl, token, hostId, ...(projectId ? { projectId } : {}) });
}
