/**
 * The Server-facing half of the DSH memory page.
 *
 * `packages/client` owns transport, authentication and the `x-mnemoweave-host` header; this
 * module only calls it and turns the answers into the plugin's own view types. Response shapes
 * are checked field by field: a mismatch is reported as `PROVIDER_PROTOCOL`, never rendered as
 * data. `createRpcHandler` calls this layer only after validating the request.
 */
import { MemoryClient, type ClientResponse } from '../../../../packages/client/src/index.ts';
import type {
  UiArchive, UiConfigView, UiEditInput, UiEditResult, UiInjection, UiMemoryDetail, UiMemoryList,
  UiMemoryRevision, UiMemorySummary, UiRule, UiStatus, UiSyncPass, UiSyncScope, UiSyncStatus,
} from '../shared/contract.ts';

const PROTOCOL = 'PROVIDER_PROTOCOL';

function malformed(what: string): Error {
  return Object.assign(new Error(`${what}: unexpected Server response`), { code: PROTOCOL });
}

function rejected(code: string): Error {
  return Object.assign(new Error(`MnemoWeave Server rejected the request (${code})`), { code });
}

function unwrap<T>(response: ClientResponse<T>): T {
  if (!response.ok) throw rejected(response.error.code);
  return response.value;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw malformed(what);
  return value as Record<string, unknown>;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw malformed(what);
  return value;
}

function asInteger(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw malformed(what);
  return value;
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw malformed(what);
  return value;
}

function asCount(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw malformed(what);
  return value;
}

function asBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw malformed(what);
  return value;
}

function nullableString(value: unknown, what: string): string | null {
  return value === null ? null : asString(value, what);
}

function asScope(value: unknown, what: string): 'project' | 'global' {
  if (value !== 'project' && value !== 'global') throw malformed(what);
  return value;
}

function asState(value: unknown, what: string): 'active' | 'superseded' | 'unverified' {
  if (value !== 'active' && value !== 'superseded' && value !== 'unverified') throw malformed(what);
  return value;
}

/** `MemoryList` from `GET /v1/memories`; the Server never returns scope or grant metadata. */
export function parseMemoryList(value: unknown, query: string | undefined, limit: number): UiMemoryList {
  const root = asRecord(value, 'memories');
  const items = asArray(root['items'], 'memories.items').map((item, index) => asSummary(item, `memories.items[${index}]`));
  return { query: query ?? null, limit, returned: items.length, items };
}

function asSummary(value: unknown, what: string): UiMemorySummary {
  const row = asRecord(value, what);
  const projectId = row['projectId'];
  return {
    memoryId: asString(row['memoryId'], `${what}.memoryId`),
    revisionId: asString(row['revisionId'], `${what}.revisionId`),
    providerMemoryId: asString(row['providerMemoryId'], `${what}.providerMemoryId`),
    scope: asScope(row['scope'], `${what}.scope`),
    ...(projectId === undefined ? {} : { projectId: asString(projectId, `${what}.projectId`) }),
    applicability: asString(row['applicability'], `${what}.applicability`),
    publishedAt: asString(row['publishedAt'], `${what}.publishedAt`),
    content: asString(row['content'], `${what}.content`),
    entryVersion: asInteger(row['entryVersion'], `${what}.entryVersion`),
  };
}

/** `PublishedMemoryOutput` from `GET /v1/memories/{id}`. */
export function parseMemoryDetail(value: unknown): UiMemoryDetail {
  const root = asRecord(value, 'memory');
  const selectedRevisionId = asString(root['selectedRevisionId'], 'memory.selectedRevisionId');
  const selected = asRecord(root['selectedRevision'], 'memory.selectedRevision');
  const revisions: UiMemoryRevision[] = asArray(root['revisions'], 'memory.revisions').map((item, index) => {
    const row = asRecord(item, `memory.revisions[${index}]`);
    const revisionId = asString(row['id'], `memory.revisions[${index}].id`);
    return {
      revisionId,
      number: asInteger(row['number'], `memory.revisions[${index}].number`),
      publishedAt: asString(row['publishedAt'], `memory.revisions[${index}].publishedAt`),
      effectiveAt: asString(row['effectiveAt'], `memory.revisions[${index}].effectiveAt`),
      current: revisionId === selectedRevisionId,
    };
  });
  const projectId = root['projectId'];
  return {
    memoryId: asString(root['id'], 'memory.id'),
    revisionId: selectedRevisionId,
    providerMemoryId: asString(selected['providerMemoryId'], 'memory.selectedRevision.providerMemoryId'),
    scope: asScope(root['scope'], 'memory.scope'),
    ...(projectId === undefined ? {} : { projectId: asString(projectId, 'memory.projectId') }),
    applicability: asString(root['applicability'], 'memory.applicability'),
    state: asState(root['state'], 'memory.state'),
    content: asString(root['content'], 'memory.content'),
    publishedAt: asString(selected['publishedAt'], 'memory.selectedRevision.publishedAt'),
    revisions,
    entryVersion: asInteger(root['entryVersion'], 'memory.entryVersion'),
  };
}

/** `MemoryEditOutput` from `PATCH /v1/memories/{id}`. */
export function parseEditResult(value: unknown): UiEditResult {
  const root = asRecord(value, 'edit');
  return {
    memoryId: asString(root['memoryId'], 'edit.memoryId'),
    revisionId: asString(root['revisionId'], 'edit.revisionId'),
    providerMemoryId: asString(root['providerMemoryId'], 'edit.providerMemoryId'),
    contentHash: asString(root['contentHash'], 'edit.contentHash'),
    entryVersion: asInteger(root['entryVersion'], 'edit.entryVersion'),
  };
}

/** `InjectionReport` from `GET /v1/injections/latest`, already scoped to this host by the Server. */
export function parseInjection(value: unknown): UiInjection {
  const root = asRecord(value, 'injection');
  const omitted = root['rulesOmitted'];
  if (omitted !== null && omitted !== 'budget_exceeded') throw malformed('injection.rulesOmitted');
  return {
    id: asString(root['id'], 'injection.id'),
    sessionId: asString(root['sessionId'], 'injection.sessionId'),
    rulesInjected: asInteger(root['rulesInjected'], 'injection.rulesInjected'),
    rulesOmitted: omitted,
    memoriesInjected: asInteger(root['memoriesInjected'], 'injection.memoriesInjected'),
    usedTokens: asInteger(root['usedTokens'], 'injection.usedTokens'),
    createdAt: asString(root['createdAt'], 'injection.createdAt'),
  };
}

/** `RuleList` from `GET /v1/rules`; the Server returns every project to a named Host. */
export function parseRuleList(value: unknown): UiRule[] {
  const root = asRecord(value, 'rules');
  return asArray(root['items'], 'rules.items').map((item, index) => {
    const what = `rules.items[${index}]`;
    const row = asRecord(item, what);
    const projectId = row['projectId'];
    return {
      entryId: asString(row['entryId'], `${what}.entryId`),
      scope: asScope(row['scope'], `${what}.scope`),
      projectId: projectId === null ? null : asString(projectId, `${what}.projectId`),
      body: asString(row['body'], `${what}.body`),
      enabled: asBoolean(row['enabled'], `${what}.enabled`),
      version: asInteger(row['version'], `${what}.version`),
      withdrawnAt: nullableString(row['withdrawnAt'], `${what}.withdrawnAt`),
    };
  });
}

/** `ArchiveList` from `GET /v1/archives`; without a project the Server returns all of them. */
export function parseArchiveList(value: unknown): UiArchive[] {
  const root = asRecord(value, 'archives');
  return asArray(root['items'], 'archives.items').map((item, index) => {
    const what = `archives.items[${index}]`;
    const row = asRecord(item, what);
    const source = row['source'];
    if (source !== 'session' && source !== 'tool' && source !== 'user') throw malformed(`${what}.source`);
    const verification = row['verification'];
    if (verification !== 'verified' && verification !== 'open' && verification !== 'refuted') throw malformed(`${what}.verification`);
    return {
      entryId: asString(row['entryId'], `${what}.entryId`),
      projectId: asString(row['projectId'], `${what}.projectId`),
      title: asString(row['title'], `${what}.title`),
      body: asString(row['body'], `${what}.body`),
      source,
      verification,
      evidence: asString(row['evidence'], `${what}.evidence`),
      version: asInteger(row['version'], `${what}.version`),
      withdrawnAt: nullableString(row['withdrawnAt'], `${what}.withdrawnAt`),
    };
  });
}

/** `SyncStatusOutput` from `GET /v1/sync/status`: this local Server against the remote one. */
export function parseSyncStatus(value: unknown): UiSyncStatus {
  const root = asRecord(value, 'sync');
  const scopes = asArray(root['scopes'], 'sync.scopes').map((item, index): UiSyncScope => {
    const what = `sync.scopes[${index}]`;
    const row = asRecord(item, what);
    return {
      scope: asString(row['scope'], `${what}.scope`),
      cursor: asCount(row['cursor'], `${what}.cursor`),
      lastPullAt: nullableString(row['lastPullAt'], `${what}.lastPullAt`),
      lastError: nullableString(row['lastError'], `${what}.lastError`),
      pending: asCount(row['pending'], `${what}.pending`),
      unknown: asCount(row['unknown'], `${what}.unknown`),
      unapplied: asCount(row['unapplied'], `${what}.unapplied`),
    };
  });
  return { enabled: asBoolean(root['enabled'], 'sync.enabled'), scopes, updatedAt: asString(root['updatedAt'], 'sync.updatedAt') };
}

/** `SyncRefreshOutput` from `POST /v1/sync/refresh`. */
export function parseSyncPass(value: unknown): UiSyncPass {
  const root = asRecord(value, 'syncRefresh');
  return {
    scopes: asArray(root['scopes'], 'syncRefresh.scopes').map((item, index) => asString(item, `syncRefresh.scopes[${index}]`)),
    pulled: asCount(root['pulled'], 'syncRefresh.pulled'),
    applied: asCount(root['applied'], 'syncRefresh.applied'),
    errors: asArray(root['errors'], 'syncRefresh.errors').map((item, index) => asString(item, `syncRefresh.errors[${index}]`)),
    skipped: asBoolean(root['skipped'], 'syncRefresh.skipped'),
  };
}

export interface MemorySourceOptions {
  client: MemoryClient;
  serverUrl: string;
  hasToken: boolean;
}

export class MemorySource {
  private readonly client: MemoryClient;
  private readonly serverUrl: string;
  private readonly hasToken: boolean;

  constructor(options: MemorySourceOptions) {
    this.client = options.client;
    this.serverUrl = options.serverUrl;
    this.hasToken = options.hasToken;
  }

  /** Server URL and Host identity only; the token value never leaves the Host process. */
  describe(): UiConfigView {
    return { serverUrl: this.serverUrl, hostId: this.client.hostId, hasToken: this.hasToken };
  }

  async status(): Promise<UiStatus> {
    const health = await this.client.health();
    const base = { serverUrl: this.serverUrl, hostId: this.client.hostId, checkedAt: new Date().toISOString() };
    if (health.ok) {
      const version = health.value.version;
      return { status: 'ok', ...base, ...(typeof version === 'string' && version !== '' ? { version } : {}) };
    }
    return {
      status: health.error.code === 'UNAUTHORIZED' ? 'unauthorized' : 'unavailable',
      reason: health.error.code,
      ...base,
    };
  }

  async memories(input: { query?: string; limit: number }): Promise<UiMemoryList> {    const response = await this.client.listMemories({
      ...(input.query === undefined ? {} : { query: input.query }),
      limit: input.limit,
    });
    return parseMemoryList(unwrap(response), input.query, input.limit);
  }

  async memory(memoryId: string): Promise<UiMemoryDetail> {
    return parseMemoryDetail(unwrap(await this.client.readMemory(memoryId)));
  }

  async edit(input: UiEditInput): Promise<UiEditResult> {
    const response = await this.client.editMemory(input.memoryId, {
      content: input.content,
      entryVersion: input.entryVersion,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    return parseEditResult(unwrap(response));
  }

  /** NOT_FOUND means this host has never assembled a View; that is a normal first run. */
  async injection(): Promise<UiInjection | null> {
    const response = await this.client.lastInjection();
    if (!response.ok && response.error.code === 'NOT_FOUND') return null;
    return parseInjection(unwrap(response));
  }

  async rules(): Promise<UiRule[]> {
    return parseRuleList(unwrap(await this.client.rules()));
  }

  async archives(): Promise<UiArchive[]> {
    return parseArchiveList(unwrap(await this.client.archives()));
  }

  /** The local Server's state against the remote sync Server. */
  async sync(): Promise<UiSyncStatus> {
    return parseSyncStatus(unwrap(await this.client.syncStatus()));
  }

  async refreshSync(): Promise<UiSyncPass> {
    return parseSyncPass(unwrap(await this.client.syncRefresh()));
  }
}
