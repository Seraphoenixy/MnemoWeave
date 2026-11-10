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
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
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

  listMemories(query: { query?: string; limit?: number } = {}): Promise<ClientResponse<{ items: MemoryListItem[] }>> {
    const params = new URLSearchParams();
    if (query.query !== undefined) params.set('query', query.query);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const suffix = params.toString() === '' ? '' : `?${params.toString()}`;
    return this.call('GET', `/v1/memories${suffix}`);
  }

  readMemory(memoryId: string, revisionId?: string): Promise<ClientResponse<Record<string, unknown>>> {
    const suffix = revisionId === undefined ? '' : `?revisionId=${encodeURIComponent(revisionId)}`;
    return this.call('GET', `/v1/memories/${encodeURIComponent(memoryId)}${suffix}`);
  }

  editMemory(memoryId: string, input: { content: string; reason?: string; entryVersion: number }): Promise<ClientResponse<{ memoryId: string; revisionId: string; providerMemoryId: string; contentHash: string; entryVersion: number }>> {
    return this.call('PATCH', `/v1/memories/${encodeURIComponent(memoryId)}`, input);
  }

  health(): Promise<ClientResponse<{ ready: true; version: string }>> {
    return this.call('GET', '/health/ready');
  }

  /** Every rule across projects, or one scope when the operator asks for it. */
  rules(query: { scope?: 'global' | 'project' | 'all'; projectId?: string } = {}): Promise<ClientResponse<{ items: RuleListItem[] }>> {
    const params = new URLSearchParams();
    if (query.scope !== undefined) params.set('scope', query.scope);
    if (query.projectId !== undefined) params.set('projectId', query.projectId);
    const suffix = params.toString() === '' ? '' : `?${params.toString()}`;
    return this.call('GET', `/v1/rules${suffix}`);
  }

  /** Project archives; without projectId the Server returns every project. */
  archives(query: { projectId?: string; includeWithdrawn?: boolean } = {}): Promise<ClientResponse<{ items: ArchiveItem[] }>> {
    const params = new URLSearchParams();
    if (query.projectId !== undefined) params.set('projectId', query.projectId);
    if (query.includeWithdrawn !== undefined) params.set('includeWithdrawn', String(query.includeWithdrawn));
    const suffix = params.toString() === '' ? '' : `?${params.toString()}`;
    return this.call('GET', `/v1/archives${suffix}`);
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

export interface MemoryListItem {
  memoryId: string; revisionId: string; providerMemoryId: string;
  scope: 'project' | 'global'; projectId?: string;
  applicability: string; publishedAt: string; content: string;
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
