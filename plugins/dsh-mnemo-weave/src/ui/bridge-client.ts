import type { UiIntents, UiMemoryDetail, UiMemoryList, UiRevision, UiStatus } from '../shared/contract.ts';
import { isRecord, UI_API_VERSION } from '../shared/contract.ts';

export interface BridgeUiClientOptions {
  baseUrl: string;
  token: string;
  hostId?: string | undefined;
  timeoutMs?: number | undefined;
}

const MAX_BODY_BYTES = 2_000_000;

function failure(message: string, code: string): Error {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${what}: expected a JSON object`);
  return value;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what}: expected a string`);
  return value;
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${what}: expected a finite number`);
  return value;
}

function asBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${what}: expected a boolean`);
  return value;
}

function asStatus(value: unknown, what: string): 'ok' | 'unauthorized' | 'unavailable' | 'corrupted' {
  if (value === 'ok' || value === 'unauthorized' || value === 'unavailable' || value === 'corrupted') return value;
  throw new Error(`${what}: unknown availability status`);
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected an array`);
  return value;
}

function asScopeOrNull(value: unknown, what: string): 'project' | 'global' | null {
  if (value === null) return null;
  if (value === 'project' || value === 'global') return value;
  throw new Error(`${what}: unknown scope`);
}

/** Shape-checks what the Bridge answered; a mismatch is reported, never rendered as data. */
export function parseStatus(value: unknown): UiStatus {
  const record = asRecord(value, 'status');
  const grant = record['grant'] === null ? null : asRecord(record['grant'], 'status.grant');
  const replica = record['replica'] === null ? null : asRecord(record['replica'], 'status.replica');
  const intents = asRecord(record['intents'], 'status.intents');
  return {
    schemaVersion: asNumber(record['schemaVersion'], 'status.schemaVersion'),
    hostId: asString(record['hostId'], 'status.hostId'),
    generatedAt: asString(record['generatedAt'], 'status.generatedAt'),
    paired: asBoolean(record['paired'], 'status.paired'),
    grant: grant === null ? null : {
      grantId: asString(grant['grantId'], 'status.grant.grantId'),
      projects: asArray(grant['projects'], 'status.grant.projects').map((item, index) => asString(item, `status.grant.projects[${index}]`)),
      globalIncluded: asBoolean(grant['globalIncluded'], 'status.grant.globalIncluded'),
      issuedAt: asString(grant['issuedAt'], 'status.grant.issuedAt'),
      expiresAt: asString(grant['expiresAt'], 'status.grant.expiresAt'),
      generation: asNumber(grant['generation'], 'status.grant.generation'),
      expired: asBoolean(grant['expired'], 'status.grant.expired'),
      revoked: asBoolean(grant['revoked'], 'status.grant.revoked'),
    },
    replica: replica === null ? null : {
      available: asBoolean(replica['available'], 'status.replica.available'),
      corrupted: asBoolean(replica['corrupted'], 'status.replica.corrupted'),
      appliedSeq: asNumber(replica['appliedSeq'], 'status.replica.appliedSeq'),
      generation: asNumber(replica['generation'], 'status.replica.generation'),
      dataTime: asString(replica['dataTime'], 'status.replica.dataTime'),
      verifiedAt: replica['verifiedAt'] === null ? null : asString(replica['verifiedAt'], 'status.replica.verifiedAt'),
      stale: asBoolean(replica['stale'], 'status.replica.stale'),
      pendingContent: asNumber(replica['pendingContent'], 'status.replica.pendingContent'),
      memories: asNumber(replica['memories'], 'status.replica.memories'),
      revisions: asNumber(replica['revisions'], 'status.replica.revisions'),
    },
    intents: { queued: asNumber(intents['queued'], 'status.intents.queued'), isolated: asNumber(intents['isolated'], 'status.intents.isolated') },
  };
}

export function parseMemoryList(value: unknown): UiMemoryList {
  const record = asRecord(value, 'memories');
  const items = asArray(record['items'], 'memories.items').map((item, index) => {
    const row = asRecord(item, `memories.items[${index}]`);
    const projectId = row['projectId'];
    return {
      memoryId: asString(row['memoryId'], 'memories.items.memoryId'),
      revisionId: asString(row['revisionId'], 'memories.items.revisionId'),
      state: asString(row['state'], 'memories.items.state') as 'active' | 'superseded' | 'unverified',
      scope: asString(row['scope'], 'memories.items.scope') as 'project' | 'global',
      ...(projectId === undefined ? {} : { projectId: asString(projectId, 'memories.items.projectId') }),
      applicability: asString(row['applicability'], 'memories.items.applicability'),
      revisionNumber: asNumber(row['revisionNumber'], 'memories.items.revisionNumber'),
      providerMemoryId: asString(row['providerMemoryId'], 'memories.items.providerMemoryId'),
      publishedAt: asString(row['publishedAt'], 'memories.items.publishedAt'),
      excerpt: asString(row['excerpt'], 'memories.items.excerpt'),
      contentLength: asNumber(row['contentLength'], 'memories.items.contentLength'),
    };
  });
  const query = record['query'];
  const scope = record['scope'];
  const projectId = record['projectId'];
  const reason = record['reason'];
  const dataTime = record['dataTime'];
  return {
    status: asStatus(record['status'], 'memories.status'),
    ...(reason === undefined ? {} : { reason: asString(reason, 'memories.reason') }),
    query: query === null ? null : asString(query, 'memories.query'),
    scope: asScopeOrNull(scope, 'memories.scope'),
    projectId: projectId === null ? null : asString(projectId, 'memories.projectId'),
    total: asNumber(record['total'], 'memories.total'),
    returned: asNumber(record['returned'], 'memories.returned'),
    complete: asBoolean(record['complete'], 'memories.complete'),
    dataTime: dataTime === null ? null : asString(dataTime, 'memories.dataTime'),
    items,
  };
}

export function parseRevision(value: unknown): UiRevision {
  const record = asRecord(value, 'revision');
  const reason = record['reason'];
  const content = record['content'];
  return {
    status: asStatus(record['status'], 'revision.status'),
    ...(reason === undefined ? {} : { reason: asString(reason, 'revision.reason') }),
    memoryId: asString(record['memoryId'], 'revision.memoryId'),
    revisionId: asString(record['revisionId'], 'revision.revisionId'),
    number: asNumber(record['number'], 'revision.number'),
    publishedAt: asString(record['publishedAt'], 'revision.publishedAt'),
    effectiveAt: asString(record['effectiveAt'], 'revision.effectiveAt'),
    current: asBoolean(record['current'], 'revision.current'),
    content: content === null ? null : asString(content, 'revision.content'),
  };
}

export function parseMemoryDetail(value: unknown): UiMemoryDetail {
  const record = asRecord(value, 'memory');
  const reason = record['reason'];
  const projectId = record['projectId'];
  const revisionId = record['revisionId'];
  const content = record['content'];
  return {
    status: asStatus(record['status'], 'memory.status'),
    ...(reason === undefined ? {} : { reason: asString(reason, 'memory.reason') }),
    memoryId: asString(record['memoryId'], 'memory.memoryId'),
    revisionId: revisionId === null ? null : asString(revisionId, 'memory.revisionId'),
    state: asString(record['state'], 'memory.state') as 'active' | 'superseded' | 'unverified',
    scope: asString(record['scope'], 'memory.scope') as 'project' | 'global',
    ...(projectId === undefined ? {} : { projectId: asString(projectId, 'memory.projectId') }),
    applicability: asString(record['applicability'], 'memory.applicability'),
    content: content === null ? null : asString(content, 'memory.content'),
    revisions: asArray(record['revisions'], 'memory.revisions').map((item, index) => {
      const row = asRecord(item, `memory.revisions[${index}]`);
      return {
        revisionId: asString(row['revisionId'], 'memory.revisions.revisionId'),
        number: asNumber(row['number'], 'memory.revisions.number'),
        publishedAt: asString(row['publishedAt'], 'memory.revisions.publishedAt'),
        effectiveAt: asString(row['effectiveAt'], 'memory.revisions.effectiveAt'),
        current: asBoolean(row['current'], 'memory.revisions.current'),
      };
    }),
    relations: asArray(record['relations'], 'memory.relations').map((item, index) => {
      const row = asRecord(item, `memory.relations[${index}]`);
      return {
        id: asString(row['id'], 'memory.relations.id'),
        kind: asString(row['kind'], 'memory.relations.kind'),
        targetMemoryId: asString(row['targetMemoryId'], 'memory.relations.targetMemoryId'),
        reason: asString(row['reason'], 'memory.relations.reason'),
        effectiveAt: asString(row['effectiveAt'], 'memory.relations.effectiveAt'),
      };
    }),
  };
}

export function parseIntents(value: unknown): UiIntents {
  const record = asRecord(value, 'intents');
  const reason = record['reason'];
  return {
    status: asStatus(record['status'], 'intents.status'),
    ...(reason === undefined ? {} : { reason: asString(reason, 'intents.reason') }),
    queued: asNumber(record['queued'], 'intents.queued'),
    isolated: asNumber(record['isolated'], 'intents.isolated'),
    items: asArray(record['items'], 'intents.items').map((item, index) => {
      const row = asRecord(item, `intents.items[${index}]`);
      const sessionId = row['sessionId'];
      const receiptRef = row['receiptRef'];
      return {
        intentId: asString(row['intentId'], 'intents.items.intentId'),
        kind: asString(row['kind'], 'intents.items.kind'),
        state: asString(row['state'], 'intents.items.state') as 'queued' | 'acknowledged' | 'isolated',
        createdAt: asString(row['createdAt'], 'intents.items.createdAt'),
        ...(sessionId === undefined ? {} : { sessionId: asString(sessionId, 'intents.items.sessionId') }),
        ...(receiptRef === undefined ? {} : { receiptRef: asString(receiptRef, 'intents.items.receiptRef') }),
      };
    }),
  };
}

/**
 * Talks to the Bridge's read-only UI endpoint. The token never leaves the Host process:
 * the browser reaches this through RPC, never through the Bridge port.
 */
export class BridgeUiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly hostId: string | undefined;
  private readonly timeoutMs: number;
  constructor(options: BridgeUiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.hostId = options.hostId;
    this.timeoutMs = options.timeoutMs ?? 3_000;
  }

  /** Configuration as the page may show it: address, host and whether a token exists. */
  describe(): { bridgeUrl: string; hostId: string | null; timeoutMs: number; hasToken: boolean } {
    return { bridgeUrl: this.baseUrl, hostId: this.hostId ?? null, timeoutMs: this.timeoutMs, hasToken: this.token.length > 0 };
  }

  private async get<T>(path: string, parse: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${this.token}`, ...(this.hostId === undefined ? {} : { 'x-mnemoweave-host': this.hostId }) },
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > MAX_BODY_BYTES) throw failure('Bridge UI response is too large', 'RESPONSE_TOO_LARGE');
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) throw failure('Bridge UI response is too large', 'RESPONSE_TOO_LARGE');
    let body: unknown;
    try { body = text.length === 0 ? undefined : JSON.parse(text); } catch { throw failure(`Bridge UI returned invalid JSON (HTTP ${response.status})`, 'INVALID_RESPONSE'); }
    if (!response.ok) {
      const code = isRecord(body) && typeof body['code'] === 'string' ? body['code'] : `HTTP ${response.status}`;
      throw failure(`Bridge UI rejected the read: ${code}`, code);
    }
    return parse(body);
  }

  status(signal?: AbortSignal): Promise<UiStatus> {
    return this.get('/v1/ui/status', parseStatus, signal).then(status => {
      if (status.schemaVersion !== UI_API_VERSION) throw failure(`Bridge UI API ${status.schemaVersion} is not supported (expected ${UI_API_VERSION})`, 'API_VERSION');
      return status;
    });
  }

  memories(input: { query?: string | undefined; limit?: number | undefined; scope?: 'project' | 'global' | undefined; projectId?: string | undefined }, signal?: AbortSignal): Promise<UiMemoryList> {
    const params = new URLSearchParams();
    if (input.query !== undefined && input.query !== '') params.set('query', input.query);
    if (input.limit !== undefined) params.set('limit', String(input.limit));
    if (input.scope !== undefined) params.set('scope', input.scope);
    if (input.projectId !== undefined) params.set('projectId', input.projectId);
    const suffix = params.size === 0 ? '' : `?${params.toString()}`;
    return this.get(`/v1/ui/memories${suffix}`, parseMemoryList, signal);
  }

  memory(memoryId: string, signal?: AbortSignal): Promise<UiMemoryDetail> {
    return this.get(`/v1/ui/memories/${encodeURIComponent(memoryId)}`, parseMemoryDetail, signal);
  }

  revision(memoryId: string, revisionId: string, signal?: AbortSignal): Promise<UiRevision> {
    return this.get(`/v1/ui/memories/${encodeURIComponent(memoryId)}/revisions/${encodeURIComponent(revisionId)}`, parseRevision, signal);
  }

  intents(signal?: AbortSignal): Promise<UiIntents> {
    return this.get('/v1/ui/intents', parseIntents, signal);
  }
}
