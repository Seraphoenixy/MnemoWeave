/**
 * The Server-facing half of the DSH memory page.
 *
 * `packages/client` owns transport, authentication and the `x-mnemoweave-host` header; this
 * module only calls it and turns the answers into the plugin's own view types. Response shapes
 * are checked field by field: a mismatch is reported as `PROVIDER_PROTOCOL`, never rendered as
 * data. `createRpcHandler` calls this layer only after validating the request.
 */
import { MemoryClient, type ClientResponse, type ServerProbe, type ServerProbeFailure } from '../../../../packages/client/src/index.ts';
import type { ServerPhaseReason } from '../shared/contract.ts';
import type {
  UiArchive, UiConfigView, UiEditInput, UiEditResult, UiInjection, UiMemoryDetail, UiMemoryList,
  ListSort, UiCreateInput, UiCreateResult, UiExplore, UiExploreHit, UiGraph, UiGraphEdge, UiGraphNode, UiMemoryConflict, UiMemoryRelation, UiMemoryRevision, UiMemorySummary, UiWithdrawInput, UiWithdrawResult, UiRule, UiStatus, UiSyncPass, UiSyncScope, UiSyncStatus,
} from '../shared/contract.ts';

const PROTOCOL = 'PROVIDER_PROTOCOL';

/**
 * Map a probe failure onto the page's phase reason. `starting` is a lifecycle phase rather
 * than a failure, so a probe that gave up while starting is reported as `task_failed`: the
 * wake was tried and the Server did not become ready in time.
 */
function toPhaseReason(reason: ServerProbeFailure): ServerPhaseReason {
  switch (reason) {
    case 'connection_refused': return 'connection_refused';
    case 'timeout': return 'timeout';
    case 'address_conflict': return 'address_conflict';
    case 'unauthorized': return 'unauthorized';
    case 'task_failed':
    case 'starting':
    default: return 'task_failed';
  }
}

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
  const nextCursor = root['nextCursor'];
  const projects = root['projects'];
  return {
    query: query ?? null,
    limit,
    returned: items.length,
    items,
    ...(nextCursor === undefined ? {} : { nextCursor: asString(nextCursor, 'memories.nextCursor') }),
    ...(projects === undefined ? {} : {
      projects: asArray(projects, 'memories.projects').map((entry, index) => {
        const row = asRecord(entry, `memories.projects[${index}]`);
        return {
          projectId: asString(row['projectId'], `memories.projects[${index}].projectId`),
          count: asCount(row['count'], `memories.projects[${index}].count`),
        };
      }),
    }),
    ...(root['categories'] === undefined ? {} : {
      categories: asArray(root['categories'], 'memories.categories').map((entry, index) => {
        const row = asRecord(entry, `memories.categories[${index}]`);
        return { value: asString(row['value'], `memories.categories[${index}].value`), count: asCount(row['count'], `memories.categories[${index}].count`) };
      }),
    }),
    ...(root['entities'] === undefined ? {} : {
      entities: asArray(root['entities'], 'memories.entities').map((entry, index) => {
        const row = asRecord(entry, `memories.entities[${index}]`);
        return { value: asString(row['value'], `memories.entities[${index}].value`), count: asCount(row['count'], `memories.entities[${index}].count`) };
      }),
    }),
    ...(root['knowledgeTypes'] === undefined ? {} : {
      knowledgeTypes: asArray(root['knowledgeTypes'], 'memories.knowledgeTypes').map((entry, index) => {
        const row = asRecord(entry, `memories.knowledgeTypes[${index}]`);
        return { value: asString(row['value'], `memories.knowledgeTypes[${index}].value`), count: asCount(row['count'], `memories.knowledgeTypes[${index}].count`) };
      }),
    }),
  };
}

function asSummary(value: unknown, what: string): UiMemorySummary {
  const row = asRecord(value, what);
  const projectId = row['projectId'];
  const knowledgeType = row['knowledgeType'];
  const category = row['category'];
  const importance = row['importance'];
  const tags = row['tags'];
  const entities = row['entities'];
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
    // Optional: absence means the revision recorded no classification, not an empty one.
    ...(knowledgeType === undefined || knowledgeType === null ? {} : { knowledgeType: asString(knowledgeType, `${what}.knowledgeType`) }),
    ...(category === undefined || category === null ? {} : { category: asString(category, `${what}.category`) }),
    ...(importance === undefined || importance === null ? {} : { importance: asInteger(importance, `${what}.importance`) }),
    ...(tags === undefined ? {} : { tags: asArray(tags, `${what}.tags`).map((tag, at) => asString(tag, `${what}.tags[${at}]`)) }),
    ...(entities === undefined ? {} : { entities: asArray(entities, `${what}.entities`).map((entity, at) => asString(entity, `${what}.entities[${at}]`)) }),
  };
}

/** `PublishedMemoryOutput` from `GET /v1/memories/{id}`. */
export function parseMemoryDetail(value: unknown): UiMemoryDetail {
  const root = asRecord(value, 'memory');
  const selectedRevisionId = asString(root['selectedRevisionId'], 'memory.selectedRevisionId');
  // The Server reports the current revision separately. Inferring "current" from the selected
  // revision made a historical read look like the live one, so the page could not tell which
  // version it was comparing against.
  const currentRevisionId = asString(root['currentRevisionId'], 'memory.currentRevisionId');
  const selected = asRecord(root['selectedRevision'], 'memory.selectedRevision');
  const revisions: UiMemoryRevision[] = asArray(root['revisions'], 'memory.revisions').map((item, index) => {
    const row = asRecord(item, `memory.revisions[${index}]`);
    const revisionId = asString(row['id'], `memory.revisions[${index}].id`);
    const parentId = row['parentId'];
    const contentHash = asString(row['contentHash'], `memory.revisions[${index}].contentHash`);
    const candidateId = asString(row['candidateId'], `memory.revisions[${index}].candidateId`);
    const knowledgeType = row['knowledgeType'];
    const category = row['category'];
    const importance = row['importance'];
    const tags = row['tags'];
    const entities = row['entities'];
    return {
      revisionId,
      number: asInteger(row['number'], `memory.revisions[${index}].number`),
      parentId: parentId === null || parentId === undefined ? null : asString(parentId, `memory.revisions[${index}].parentId`),
      contentHash,
      candidateId,
      publishedAt: asString(row['publishedAt'], `memory.revisions[${index}].publishedAt`),
      effectiveAt: asString(row['effectiveAt'], `memory.revisions[${index}].effectiveAt`),
      // Classification is optional in the contract: absent means it was never recorded.
      ...(knowledgeType === undefined || knowledgeType === null ? {} : { knowledgeType: asString(knowledgeType, `memory.revisions[${index}].knowledgeType`) }),
      ...(category === undefined || category === null ? {} : { category: asString(category, `memory.revisions[${index}].category`) }),
      ...(importance === undefined || importance === null ? {} : { importance: asInteger(importance, `memory.revisions[${index}].importance`) }),
      ...(tags === undefined ? {} : { tags: asArray(tags, `memory.revisions[${index}].tags`).map((tag, at) => asString(tag, `memory.revisions[${index}].tags[${at}]`)) }),
      ...(entities === undefined ? {} : { entities: asArray(entities, `memory.revisions[${index}].entities`).map((entity, at) => asString(entity, `memory.revisions[${index}].entities[${at}]`)) }),
      current: revisionId === currentRevisionId,
      selected: revisionId === selectedRevisionId,
    };
  });
  const projectId = root['projectId'];
  return {
    memoryId: asString(root['id'], 'memory.id'),
    revisionId: selectedRevisionId,
    currentRevisionId,
    isCurrent: selectedRevisionId === currentRevisionId,
    providerMemoryId: asString(selected['providerMemoryId'], 'memory.selectedRevision.providerMemoryId'),
    scope: asScope(root['scope'], 'memory.scope'),
    ...(projectId === undefined ? {} : { projectId: asString(projectId, 'memory.projectId') }),
    applicability: asString(root['applicability'], 'memory.applicability'),
    state: asState(root['state'], 'memory.state'),
    content: asString(root['content'], 'memory.content'),
    publishedAt: asString(selected['publishedAt'], 'memory.selectedRevision.publishedAt'),
    revisions,
    entryVersion: asInteger(root['entryVersion'], 'memory.entryVersion'),
    relations: asArray(root['relations'] ?? [], 'memory.relations').map((item, index): UiMemoryRelation => {
      const row = asRecord(item, `memory.relations[${index}]`);
      const kind = asString(row['kind'], `memory.relations[${index}].kind`);
      if (kind !== 'Supersedes' && kind !== 'RelatedTo') throw malformed(`memory.relations[${index}].kind`);
      return {
        relationId: asString(row['id'], `memory.relations[${index}].id`),
        kind,
        sourceMemoryId: asString(row['sourceMemoryId'], `memory.relations[${index}].sourceMemoryId`),
        sourceRevisionId: asString(row['sourceRevisionId'], `memory.relations[${index}].sourceRevisionId`),
        targetMemoryId: asString(row['targetMemoryId'], `memory.relations[${index}].targetMemoryId`),
        targetRevisionId: asString(row['targetRevisionId'], `memory.relations[${index}].targetRevisionId`),
        effectiveAt: asString(row['effectiveAt'], `memory.relations[${index}].effectiveAt`),
        reason: asString(row['reason'], `memory.relations[${index}].reason`),
        evidence: asArray(row['evidence'] ?? [], `memory.relations[${index}].evidence`).map((entry, at) => asString(entry, `memory.relations[${index}].evidence[${at}]`)),
        nativeProjected: row['nativeProjected'] === true,
      };
    }),
    conflicts: asArray(root['conflicts'] ?? [], 'memory.conflicts').map((item, index): UiMemoryConflict => {
      const row = asRecord(item, `memory.conflicts[${index}]`);
      const state = asString(row['state'], `memory.conflicts[${index}].state`);
      if (state !== 'open' && state !== 'resolving' && state !== 'resolved' && state !== 'unverified') throw malformed(`memory.conflicts[${index}].state`);
      return {
        caseId: asString(row['id'], `memory.conflicts[${index}].id`),
        state,
        baseRevisionId: asString(row['baseRevisionId'], `memory.conflicts[${index}].baseRevisionId`),
        decisions: asArray(row['decisions'] ?? [], `memory.conflicts[${index}].decisions`).map((entry, at) => {
          const decision = asRecord(entry, `memory.conflicts[${index}].decisions[${at}]`);
          return {
            actor: asString(decision['actor'], `memory.conflicts[${index}].decisions[${at}].actor`),
            decision: asString(decision['decision'], `memory.conflicts[${index}].decisions[${at}].decision`),
            reason: asString(decision['reason'], `memory.conflicts[${index}].decisions[${at}].reason`),
            evidence: asArray(decision['evidence'] ?? [], `memory.conflicts[${index}].decisions[${at}].evidence`).map((proof, proofAt) => asString(proof, `memory.conflicts[${index}].decisions[${at}].evidence[${proofAt}]`)),
            createdAt: asString(decision['createdAt'], `memory.conflicts[${index}].decisions[${at}].createdAt`),
          };
        }),
      };
    }),
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
  /** Which layer supplied each setting, for the settings page. */
  sources?: Record<string, string>;
  /**
   * Bring the local Server up before a request, waking the scheduled task when nothing is
   * listening. Omitted in tests that only exercise parsing.
   */
  ensureServer?: (budgetMs: number) => Promise<ServerProbe>;
}

export class MemorySource {
  private client: MemoryClient;
  private serverUrl: string;
  private hasToken: boolean;
  /** Which layer supplied each setting; shown on the settings page. */
  private sources: Record<string, string> | undefined;
  private readonly ensure: ((budgetMs: number) => Promise<ServerProbe>) | undefined;

  constructor(options: MemorySourceOptions) {
    this.client = options.client;
    this.serverUrl = options.serverUrl;
    this.hasToken = options.hasToken;
    this.sources = options.sources;
    this.ensure = options.ensureServer;
  }

  /** Server URL and Host identity only; the token value never leaves the Host process. */  describe(): UiConfigView {
    return {
      serverUrl: this.serverUrl, hostId: this.client.hostId, hasToken: this.hasToken,
      ...(this.sources === undefined ? {} : { sources: this.sources }),
    };
  }

  /**
   * Adopt a connection that the settings page already validated and tested. The caller switches
   * this only after a successful save, so a rejected address never replaces a working client.
   */
  useConnection(next: { client: MemoryClient; serverUrl: string; hostId: string; hasToken: boolean; sources?: Record<string, string> }): void {
    this.client = next.client;
    this.serverUrl = next.serverUrl;
    this.hasToken = next.hasToken;
    this.sources = next.sources;
  }

  /**
   * Health plus the local Server's lifecycle.
   *
   * A refused connection is not a dead end: the Server is hosted by a scheduled task, so this
   * attempts a wake and reports `starting` while it comes up. Every other outcome is reported
   * as the specific failure, so the page can say "token mismatch" or "port taken" rather than
   * a generic unavailable.
   */
  async status(): Promise<UiStatus> {
    const base = { serverUrl: this.serverUrl, hostId: this.client.hostId, checkedAt: new Date().toISOString() };
    const probe = this.ensure === undefined ? undefined : await this.ensure(20_000).catch(() => undefined);
    if (probe !== undefined && probe.state === 'starting') {
      return { status: 'unavailable', reason: 'SERVER_STARTING', ...base, server: { phase: 'starting', detail: probe.detail, taskRun: false } };
    }
    if (probe !== undefined && probe.state === 'failed') {
      return {
        status: probe.reason === 'unauthorized' ? 'unauthorized' : 'unavailable',
        reason: probe.reason.toUpperCase(),
        ...base,
        server: { phase: 'failed', reason: toPhaseReason(probe.reason), detail: probe.detail, taskRun: probe.taskRun },
      };
    }
    const health = await this.client.health();
    if (health.ok) {
      const version = health.value.version;
      return {
        status: 'ok',
        ...base,
        ...(typeof version === 'string' && version !== '' ? { version } : {}),
        server: { phase: 'connected', taskRun: false },
      };
    }
    // Reached when no probe was configured, or the probe said ready but /health/ready then
    // failed: report it as still starting only for the transient Provider codes.
    const unauthorized = health.error.code === 'UNAUTHORIZED';
    return {
      status: unauthorized ? 'unauthorized' : 'unavailable',
      reason: health.error.code,
      ...base,
      server: unauthorized
        ? { phase: 'failed', reason: 'unauthorized', detail: 'the Server rejected the service token', taskRun: false }
        : { phase: 'starting', detail: 'the Server is up and its memory provider is still starting', taskRun: false },
    };
  }

  async memories(input: { query?: string; limit: number; scope?: 'all' | 'global' | 'project'; projectId?: string; cursor?: string; category?: string; knowledgeType?: string; entity?: string; sort?: ListSort }): Promise<UiMemoryList> {
    const response = await this.client.listMemories({
      ...(input.query === undefined ? {} : { query: input.query }),
      limit: input.limit,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.knowledgeType === undefined ? {} : { knowledgeType: input.knowledgeType }),
      ...(input.entity === undefined ? {} : { entity: input.entity }),
      ...(input.sort === undefined ? {} : { sort: input.sort }),
    });
    return parseMemoryList(unwrap(response), input.query, input.limit);
  }

  /** Read the current revision, or one historical revision when `revisionId` is given. */
  async memory(memoryId: string, revisionId?: string): Promise<UiMemoryDetail> {
    return parseMemoryDetail(unwrap(await this.client.readMemory(memoryId, revisionId)));
  }

  /** The relation graph over the visible catalog. Structure only: nodes carry no body. */
  async graph(input: { scope?: 'all' | 'global' | 'project'; projectId?: string; limit?: number }): Promise<UiGraph> {
    const response = await this.client.graph({
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    const value = unwrap(response);
    return {
      nodes: asArray(value['nodes'], 'graph.nodes').map((item, index): UiGraphNode => {
        const row = asRecord(item, `graph.nodes[${index}]`);
        const where = `graph.nodes[${index}]`;
        const projectId = row['projectId'];
        const category = row['category'];
        const knowledgeType = row['knowledgeType'];
        const importance = row['importance'];
        return {
          memoryId: asString(row['memoryId'], `${where}.memoryId`),
          scope: asScope(row['scope'], `${where}.scope`),
          ...(projectId === undefined ? {} : { projectId: asString(projectId, `${where}.projectId`) }),
          state: asState(row['state'], `${where}.state`),
          publishedAt: asString(row['publishedAt'], `${where}.publishedAt`),
          ...(category === undefined || category === null ? {} : { category: asString(category, `${where}.category`) }),
          ...(knowledgeType === undefined || knowledgeType === null ? {} : { knowledgeType: asString(knowledgeType, `${where}.knowledgeType`) }),
          ...(importance === undefined || importance === null ? {} : { importance: asInteger(importance, `${where}.importance`) }),
        };
      }),
      edges: asArray(value['edges'], 'graph.edges').map((item, index): UiGraphEdge => {
        const row = asRecord(item, `graph.edges[${index}]`);
        const where = `graph.edges[${index}]`;
        const kind = asString(row['kind'], `${where}.kind`);
        if (kind !== 'Supersedes' && kind !== 'RelatedTo') throw malformed(`${where}.kind`);
        return {
          relationId: asString(row['relationId'], `${where}.relationId`),
          kind,
          sourceMemoryId: asString(row['sourceMemoryId'], `${where}.sourceMemoryId`),
          targetMemoryId: asString(row['targetMemoryId'], `${where}.targetMemoryId`),
          reason: asString(row['reason'], `${where}.reason`),
          effectiveAt: asString(row['effectiveAt'], `${where}.effectiveAt`),
        };
      }),
      truncated: value['truncated'] === true,
    };
  }

  /**
   * Provider-ranked search. This is not the list with a different query: the Provider ranks by
   * similarity, and the Server maps each hit to a memory this machine can open.
   */
  async explore(input: { query: string; limit: number; minScore: number }): Promise<UiExplore> {
    const response = await this.client.explore(input.query, input.limit, input.minScore);
    const value = unwrap(response);
    return {
      query: asString(value['query'], 'explore.query'),
      unregistered: asCount(value['unregistered'], 'explore.unregistered'),
      truncated: value['truncated'] === true,
      minScore: input.minScore,
      hits: asArray(value['hits'], 'explore.hits').map((item, index): UiExploreHit => {
        const row = asRecord(item, `explore.hits[${index}]`);
        const where = `explore.hits[${index}]`;
        const projectId = row['projectId'];
        const category = row['category'];
        const knowledgeType = row['knowledgeType'];
        const tags = row['tags'];
        const score = row['score'];
        if (typeof score !== 'number' || !Number.isFinite(score)) throw malformed(`${where}.score`);
        const state = asString(row['state'], `${where}.state`);
        if (state !== 'active' && state !== 'superseded' && state !== 'unverified') throw malformed(`${where}.state`);
        return {
          memoryId: asString(row['memoryId'], `${where}.memoryId`),
          revisionId: asString(row['revisionId'], `${where}.revisionId`),
          providerMemoryId: asString(row['providerMemoryId'], `${where}.providerMemoryId`),
          scope: asScope(row['scope'], `${where}.scope`),
          ...(projectId === undefined ? {} : { projectId: asString(projectId, `${where}.projectId`) }),
          state,
          content: asString(row['content'], `${where}.content`),
          score,
          publishedAt: asString(row['publishedAt'], `${where}.publishedAt`),
          ...(category === undefined || category === null ? {} : { category: asString(category, `${where}.category`) }),
          ...(knowledgeType === undefined || knowledgeType === null ? {} : { knowledgeType: asString(knowledgeType, `${where}.knowledgeType`) }),
          ...(tags === undefined ? {} : { tags: asArray(tags, `${where}.tags`).map((tag, at) => asString(tag, `${where}.tags[${at}]`)) }),
        };
      }),
    };
  }

  /**
   * Withdraw a memory. The Server keeps every revision readable and stops recall and injection.
   */
  async withdraw(input: UiWithdrawInput): Promise<UiWithdrawResult> {
    const response = await this.client.withdrawMemory(input.memoryId, { reason: input.reason, entryVersion: input.entryVersion });
    const value = unwrap(response);
    return {
      memoryId: asString(value['memoryId'], 'withdraw.memoryId'),
      revisionId: asString(value['revisionId'], 'withdraw.revisionId'),
      entryVersion: asInteger(value['entryVersion'], 'withdraw.entryVersion'),
      withdrawnAt: asString(value['withdrawnAt'], 'withdraw.withdrawnAt'),
    };
  }

  /** Publish a new formal memory. The Server treats user input as already confirmed. */
  async create(input: UiCreateInput): Promise<UiCreateResult> {
    const response = await this.client.createMemory({
      content: input.content,
      knowledgeType: input.knowledgeType,
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.importance === undefined ? {} : { importance: input.importance }),
      ...(input.tags === undefined ? {} : { tags: input.tags }),
      ...(input.entities === undefined ? {} : { entities: input.entities }),
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    const root = asRecord(unwrap(response), 'create');
    return {
      memoryId: asString(root['memoryId'], 'create.memoryId'),
      revisionId: asString(root['revisionId'], 'create.revisionId'),
      providerMemoryId: asString(root['providerMemoryId'], 'create.providerMemoryId'),
      contentHash: asString(root['contentHash'], 'create.contentHash'),
      entryVersion: asInteger(root['entryVersion'], 'create.entryVersion'),
    };
  }

  async edit(input: UiEditInput): Promise<UiEditResult> {
    const response = await this.client.editMemory(input.memoryId, {
      content: input.content,
      entryVersion: input.entryVersion,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      // Only the fields the user changed; the Server inherits the rest.
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.knowledgeType === undefined ? {} : { knowledgeType: input.knowledgeType }),
      ...(input.importance === undefined ? {} : { importance: input.importance }),
      ...(input.tags === undefined ? {} : { tags: input.tags }),
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
