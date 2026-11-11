import type { MemoriesRequest, MemoryRequest, RpcResult, UiCreateInput, UiEditInput, UiSettings, UiWithdrawInput } from '../shared/contract.ts';
import { isRecord } from '../shared/contract.ts';
import type { MemorySource } from './memory-source.ts';
import type { RpcHandler } from './types.ts';

/** The slice of the Host settings service this handler needs. */
export interface SettingsLike {
  settings(): UiSettings;
  saveInterface(patch: unknown): UiSettings;
  saveConnection(input: { serverUrl?: string; hostId?: string }): Promise<UiSettings>;
  saveInjection(input: { projectId?: string | null; injectTimeoutMs?: number }): UiSettings;
  saveAutoStart(input: { enabled?: boolean }): UiSettings;
  testConnection(input: { serverUrl?: string }): Promise<{ ok: boolean; reason: string; detail?: string }>;
  testWake(input?: { baseUrl?: string }): Promise<{ result: string; detail?: string }>;
}

/** Only the keys a group owns are forwarded, so one group cannot rewrite another's setting. */
function preferencesPatch(payload: unknown, keys: string[]): Record<string, unknown> {
  if (!isRecord(payload)) invalid('settings payload must be an object');
  const patch: Record<string, unknown> = {};
  for (const key of keys) if (payload[key] !== undefined) patch[key] = payload[key];
  if (Object.keys(patch).length === 0) invalid(`expected one of: ${keys.join(', ')}`);
  return patch;
}

/** Address and Host identity, validated here before any probe runs. */
function connectionRequest(payload: unknown, serverUrlOnly = false): { serverUrl?: string; hostId?: string } {
  if (payload === undefined || payload === null) return {};
  if (!isRecord(payload)) invalid('connection payload must be an object');
  const serverUrl = payload['serverUrl'];
  const hostId = payload['hostId'];
  if (serverUrl !== undefined) {
    if (typeof serverUrl !== 'string') invalid('serverUrl must be a string');
    if (serverUrl !== '' && !SERVER_URL.test(serverUrl)) invalid('serverUrl must be a loopback http(s) URL');
  }
  if (!serverUrlOnly && hostId !== undefined) {
    if (typeof hostId !== 'string' || hostId.trim() === '' || hostId.length > 200) invalid('hostId must be 1–200 characters');
  }
  return {
    ...(typeof serverUrl === 'string' && serverUrl !== '' ? { serverUrl } : {}),
    ...(!serverUrlOnly && typeof hostId === 'string' ? { hostId: hostId.trim() } : {}),
  };
}

const MAX_QUERY = 500;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const MAX_CONTENT_BYTES = 8_000;
const MAX_REASON = 4_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The page may only point at this machine; a remote address would leak the service token.
const SERVER_URL = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?\/?$/i;
// Mirrors the Server's enumerations: an unknown value is refused here, not sent as an empty filter.
const CATEGORIES = ['preference', 'decision', 'fact', 'insight', 'context', 'general'] as const;
const KNOWLEDGE_TYPES = ['Concept', 'Practice', 'Architecture', 'Troubleshooting', 'Constraint', 'Procedure', 'Reference'] as const;
const SORTS = ['newest', 'oldest', 'importance'] as const;

function ok<T>(value: T): RpcResult<T> { return { ok: true, value }; }
function fail(message: string, code: string): RpcResult<never> { return { ok: false, error: { message, code } }; }
function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: 'INVALID_INPUT' });
}

function memoriesRequest(payload: unknown): MemoriesRequest {
  if (payload === undefined || payload === null) return { limit: DEFAULT_LIMIT };
  if (!isRecord(payload)) invalid('memories payload must be an object');
  const query = payload['query'];
  const limit = payload['limit'];
  const scope = payload['scope'];
  const projectId = payload['projectId'];
  const cursor = payload['cursor'];
  if (query !== undefined && (typeof query !== 'string' || query.length > MAX_QUERY)) {
    invalid(`query must be a string of at most ${MAX_QUERY} characters`);
  }
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)) {
    invalid(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  if (scope !== undefined && scope !== 'all' && scope !== 'global' && scope !== 'project') {
    invalid('scope must be all, global or project');
  }
  if (projectId !== undefined && (typeof projectId !== 'string' || projectId.trim() === '' || projectId.length > 200)) {
    invalid('projectId must be a non-empty string of at most 200 characters');
  }
  if (scope === 'project' && projectId === undefined) invalid('scope=project requires projectId');
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor === '' || cursor.length > 500)) {
    invalid('cursor must be a non-empty string of at most 500 characters');
  }
  const category = payload['category'];
  if (category !== undefined && (typeof category !== 'string' || !(CATEGORIES as readonly string[]).includes(category))) {
    invalid(`category must be one of: ${CATEGORIES.join(', ')}`);
  }
  const knowledgeType = payload['knowledgeType'];
  if (knowledgeType !== undefined && (typeof knowledgeType !== 'string' || !(KNOWLEDGE_TYPES as readonly string[]).includes(knowledgeType))) {
    invalid(`knowledgeType must be one of: ${KNOWLEDGE_TYPES.join(', ')}`);
  }
  const entity = payload['entity'];
  if (entity !== undefined && (typeof entity !== 'string' || entity.trim() === '' || entity.trim().length > 200)) {
    invalid('entity must be a non-empty string of at most 200 characters');
  }
  const sort = payload['sort'];
  if (sort !== undefined && (typeof sort !== 'string' || !(SORTS as readonly string[]).includes(sort))) {
    invalid(`sort must be one of: ${SORTS.join(', ')}`);
  }
  return {
    ...(query === undefined ? {} : { query }),
    limit: limit ?? DEFAULT_LIMIT,
    ...(scope === undefined ? {} : { scope }),
    ...(projectId === undefined ? {} : { projectId: projectId.trim() }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(category === undefined ? {} : { category: category as (typeof CATEGORIES)[number] }),
    ...(knowledgeType === undefined ? {} : { knowledgeType: knowledgeType as (typeof KNOWLEDGE_TYPES)[number] }),
    ...(entity === undefined ? {} : { entity: (entity as string).trim() }),
    ...(sort === undefined ? {} : { sort: sort as (typeof SORTS)[number] }),
  };
}

function memoryRequest(payload: unknown): MemoryRequest {
  if (!isRecord(payload) || typeof payload['memoryId'] !== 'string' || !UUID.test(payload['memoryId'])) {
    invalid('memoryId must be a UUID');
  }
  // A specific revision means "show me this historical version"; omitting it means "current".
  const revisionId = payload['revisionId'];
  if (revisionId !== undefined && (typeof revisionId !== 'string' || !UUID.test(revisionId))) {
    invalid('revisionId must be a UUID');
  }
  return {
    memoryId: payload['memoryId'],
    ...(revisionId === undefined ? {} : { revisionId }),
  };
}

/**
 * A withdrawal always needs a reason: it removes the memory from recall and injection, and the
 * reason is what the history shows later about why.
 */
/** The graph is scoped like the list: same scope semantics, same bounds. */
function graphRequest(payload: unknown): { scope?: 'all' | 'global' | 'project'; projectId?: string; limit?: number } {
  if (payload === undefined) return {};
  if (!isRecord(payload)) invalid('graph payload must be an object');
  const scope = payload['scope'];
  if (scope !== undefined && scope !== 'all' && scope !== 'global' && scope !== 'project') invalid('scope must be all, global or project');
  const projectId = payload['projectId'];
  if (scope === 'project' && typeof projectId !== 'string') invalid('scope=project requires projectId');
  if (projectId !== undefined && (typeof projectId !== 'string' || projectId.trim() === '' || projectId.trim().length > 200)) {
    invalid('projectId must be a non-empty string of at most 200 characters');
  }
  const limit = payload['limit'];
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 500)) {
    invalid('limit must be an integer between 1 and 500');
  }
  return {
    ...(scope === undefined ? {} : { scope }),
    ...(projectId === undefined ? {} : { projectId: (projectId as string).trim() }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/** Explore is a read: a query is required, and the page size stays small by design. */
function exploreRequest(payload: unknown): { query: string; limit: number; minScore: number } {
  if (!isRecord(payload)) invalid('explore payload must be an object');
  const query = payload['query'];
  if (typeof query !== 'string' || query.trim() === '') invalid('query must be a non-empty string');
  if (query.trim().length > MAX_QUERY) invalid(`query must contain at most ${MAX_QUERY} characters`);
  const limit = payload['limit'];
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50)) {
    invalid('limit must be an integer between 1 and 50');
  }
  const minScore = payload['minScore'];
  if (minScore !== undefined && (typeof minScore !== 'number' || !Number.isFinite(minScore) || minScore < 0 || minScore > 1)) {
    invalid('minScore must be a number between 0 and 1');
  }
  return { query: query.trim(), limit: limit ?? 20, minScore: minScore ?? 0 };
}

function withdrawRequest(payload: unknown): UiWithdrawInput {
  if (!isRecord(payload) || typeof payload['memoryId'] !== 'string' || !UUID.test(payload['memoryId'])) {
    invalid('memoryId must be a UUID');
  }
  const reason = payload['reason'];
  if (typeof reason !== 'string' || reason.trim() === '') invalid('reason must be a non-empty string');
  if (reason.trim().length > MAX_REASON) invalid(`reason must contain at most ${MAX_REASON} characters`);
  const entryVersion = payload['entryVersion'];
  if (typeof entryVersion !== 'number' || !Number.isInteger(entryVersion) || entryVersion < 0) invalid('entryVersion must be a non-negative integer');
  return { memoryId: payload['memoryId'], reason: reason.trim(), entryVersion };
}

/**
 * A new memory carries no previous revision, so its knowledge type is required rather than
 * inherited. Everything else is optional, and validation matches the Server's exactly.
 */
function createRequest(payload: unknown): UiCreateInput {
  if (!isRecord(payload)) invalid('create payload must be an object');
  const content = payload['content'];
  if (typeof content !== 'string' || content.trim() === '') invalid('content must be a non-empty string');
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) invalid(`content must be at most ${MAX_CONTENT_BYTES} UTF-8 bytes`);
  const knowledgeType = payload['knowledgeType'];
  if (typeof knowledgeType !== 'string' || !(KNOWLEDGE_TYPES as readonly string[]).includes(knowledgeType)) {
    invalid(`knowledgeType must be one of: ${KNOWLEDGE_TYPES.join(', ')}`);
  }
  const category = payload['category'];
  if (category !== undefined && (typeof category !== 'string' || !(CATEGORIES as readonly string[]).includes(category))) {
    invalid(`category must be one of: ${CATEGORIES.join(', ')}`);
  }
  const importance = payload['importance'];
  if (importance !== undefined && (typeof importance !== 'number' || !Number.isInteger(importance) || importance < 1 || importance > 5)) {
    invalid('importance must be an integer between 1 and 5');
  }
  const tags = payload['tags'];
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.length > 20) invalid('tags must be an array of at most 20 strings');
    for (const tag of tags) {
      if (typeof tag !== 'string' || tag.trim() === '' || tag.trim().length > 100) invalid('each tag must be 1–100 characters');
    }
  }
  const entities = payload['entities'];
  if (entities !== undefined) {
    if (!Array.isArray(entities) || entities.length > 50) invalid('entities must be an array of at most 50 strings');
    for (const entity of entities) {
      if (typeof entity !== 'string' || entity.trim() === '' || entity.trim().length > 200) invalid('each entity must be 1–200 characters');
    }
  }
  const scope = payload['scope'];
  if (scope !== undefined && scope !== 'global' && scope !== 'project') invalid('scope must be global or project');
  const projectId = payload['projectId'];
  if (scope === 'project' && typeof projectId !== 'string') invalid('scope=project requires projectId');
  if (projectId !== undefined && (typeof projectId !== 'string' || projectId.trim() === '' || projectId.trim().length > 200)) {
    invalid('projectId must be a non-empty string of at most 200 characters');
  }
  const reason = payload['reason'];
  if (reason !== undefined && (typeof reason !== 'string' || reason.trim() === '' || reason.trim().length > MAX_REASON)) {
    invalid(`reason must be a non-empty string of at most ${MAX_REASON} characters`);
  }
  return {
    content,
    knowledgeType,
    ...(category === undefined ? {} : { category: category as string }),
    ...(importance === undefined ? {} : { importance: importance as number }),
    ...(tags === undefined ? {} : { tags: (tags as string[]).map(tag => tag.trim()) }),
    ...(entities === undefined ? {} : { entities: (entities as string[]).map(entity => entity.trim()) }),
    ...(scope === undefined ? {} : { scope }),
    ...(projectId === undefined ? {} : { projectId: (projectId as string).trim() }),
    ...(reason === undefined ? {} : { reason: (reason as string).trim() }),
  };
}

function editRequest(payload: unknown): UiEditInput {
  if (!isRecord(payload) || typeof payload['memoryId'] !== 'string' || !UUID.test(payload['memoryId'])) {
    invalid('memoryId must be a UUID');
  }
  const content = payload['content'];
  if (typeof content !== 'string' || content.trim() === '') invalid('content must be a non-empty string');
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) invalid(`content must contain at most ${MAX_CONTENT_BYTES} UTF-8 bytes`);
  const reason = payload['reason'];
  if (reason !== undefined && typeof reason !== 'string') invalid('reason must be a string');
  const entryVersion = payload['entryVersion'];
  if (typeof entryVersion !== 'number' || !Number.isInteger(entryVersion) || entryVersion < 0) invalid('entryVersion must be a non-negative integer');
  const trimmedReason = typeof reason === 'string' ? reason.trim() : undefined;
  if (trimmedReason !== undefined && trimmedReason.length > MAX_REASON) invalid(`reason must contain at most ${MAX_REASON} characters`);
  // Classification is optional: an omitted field is inherited by the new revision, not cleared.
  const category = payload['category'];
  if (category !== undefined && (typeof category !== 'string' || !(CATEGORIES as readonly string[]).includes(category))) {
    invalid(`category must be one of: ${CATEGORIES.join(', ')}`);
  }
  const knowledgeType = payload['knowledgeType'];
  if (knowledgeType !== undefined && (typeof knowledgeType !== 'string' || !(KNOWLEDGE_TYPES as readonly string[]).includes(knowledgeType))) {
    invalid(`knowledgeType must be one of: ${KNOWLEDGE_TYPES.join(', ')}`);
  }
  const importance = payload['importance'];
  if (importance !== undefined && (typeof importance !== 'number' || !Number.isInteger(importance) || importance < 1 || importance > 5)) {
    invalid('importance must be an integer between 1 and 5');
  }
  const tags = payload['tags'];
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.length > 20) invalid('tags must be an array of at most 20 strings');
    for (const tag of tags) {
      if (typeof tag !== 'string' || tag.trim() === '' || tag.trim().length > 100) invalid('each tag must be 1–100 characters');
    }
  }
  return {
    memoryId: payload['memoryId'],
    content,
    entryVersion,
    ...(trimmedReason === undefined || trimmedReason === '' ? {} : { reason: trimmedReason }),
    ...(category === undefined ? {} : { category: category as string }),
    ...(knowledgeType === undefined ? {} : { knowledgeType: knowledgeType as string }),
    ...(importance === undefined ? {} : { importance: importance as number }),
    ...(tags === undefined ? {} : { tags: (tags as string[]).map(tag => tag.trim()) }),
  };
}

/** Rejection message kept for the page; the Server's own code is passed through unchanged. */
function failureOf(error: unknown): { message: string; code: string } {
  const code = isRecord(error) && typeof error['code'] === 'string' ? error['code'] : 'PROVIDER_UNAVAILABLE';
  const message = error instanceof Error ? error.message : String(error);
  return { message: message.slice(0, 300), code };
}

/**
 * Serves the page's endpoints. Each request is validated here before anything reaches the
 * Server; a rejected request or a Server error is reported with its code instead of empty data.
 *
 * Settings endpoints go to the Host's own configuration, not to the Server: they change what this
 * plugin and the injection hook read, and the token never travels back to the browser.
 */
export function createRpcHandler(source: MemorySource, settings?: SettingsLike): RpcHandler {
  return async (endpoint, payload) => {
    try {
      switch (endpoint) {
        case 'status': return ok(await source.status());
        case 'config': return ok(source.describe());
        case 'settings': {
          if (settings === undefined) return fail('settings are unavailable in this build', 'PROVIDER_UNAVAILABLE');
          return ok(settings.settings());
        }
        case 'saveInterface': {
          if (settings === undefined) return fail('settings are unavailable in this build', 'PROVIDER_UNAVAILABLE');
          return ok(settings.saveInterface(preferencesPatch(payload, ['defaultTab', 'defaultScope', 'pageSize'])));
        }
        case 'saveConnection': {
          if (settings === undefined) return fail('settings are unavailable in this build', 'PROVIDER_UNAVAILABLE');
          const request = connectionRequest(payload);
          return ok(await settings.saveConnection(request));
        }
        case 'saveInjection': {
          if (settings === undefined) return fail('settings are unavailable in this build', 'PROVIDER_UNAVAILABLE');
          return ok(settings.saveInjection(preferencesPatch(payload, ['projectId', 'injectTimeoutMs'])));
        }
        case 'saveAutoStart': {
          if (settings === undefined) return fail('settings are unavailable in this build', 'PROVIDER_UNAVAILABLE');
          const enabled = isRecord(payload) ? payload['enabled'] : undefined;
          if (typeof enabled !== 'boolean') invalid('enabled must be a boolean');
          return ok(settings.saveAutoStart({ enabled }));
        }
        case 'testConnection': {
          if (settings === undefined) return fail('settings are unavailable in this build', 'PROVIDER_UNAVAILABLE');
          return ok(await settings.testConnection(connectionRequest(payload, true)));
        }
        case 'testWake': {
          if (settings === undefined) return fail('settings are unavailable in this build', 'PROVIDER_UNAVAILABLE');
          const baseUrl = isRecord(payload) ? payload['serverUrl'] : undefined;
          if (baseUrl !== undefined && typeof baseUrl !== 'string') invalid('serverUrl must be a string');
          return ok(await settings.testWake(baseUrl === undefined ? {} : { baseUrl }));
        }
        case 'memories': {
          const request = memoriesRequest(payload);
          // Every validated field has to be forwarded. Dropping one here silently disables the
          // matching control in the page: the request succeeds and returns unfiltered data, which
          // looks like a filter that simply matches everything.
          return ok(await source.memories({
            ...(request.query === undefined ? {} : { query: request.query }),
            limit: request.limit ?? DEFAULT_LIMIT,
            ...(request.scope === undefined ? {} : { scope: request.scope }),
            ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
            ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
            ...(request.category === undefined ? {} : { category: request.category }),
            ...(request.knowledgeType === undefined ? {} : { knowledgeType: request.knowledgeType }),
            ...(request.entity === undefined ? {} : { entity: request.entity }),
            ...(request.sort === undefined ? {} : { sort: request.sort }),
          }));
        }
        case 'memory': {
          const request = memoryRequest(payload);
          return ok(await source.memory(request.memoryId, request.revisionId));
        }
        case 'create': return ok(await source.create(createRequest(payload)));
        case 'edit': return ok(await source.edit(editRequest(payload)));
        case 'withdraw': return ok(await source.withdraw(withdrawRequest(payload)));
        case 'graph': return ok(await source.graph(graphRequest(payload)));
        case 'explore': {
          const request = exploreRequest(payload);
          return ok(await source.explore(request));
        }
        case 'injection': return ok(await source.injection());
        case 'rules': return ok(await source.rules());
        case 'archives': return ok(await source.archives());
        case 'sync': return ok(await source.sync());
        case 'syncRefresh': return ok(await source.refreshSync());
        default: return fail(`unknown MnemoWeave RPC endpoint: ${String(endpoint).slice(0, 80)}`, 'UNKNOWN_ENDPOINT');
      }
    } catch (error) {
      const failure = failureOf(error);
      return fail(failure.message, failure.code);
    }
  };
}
