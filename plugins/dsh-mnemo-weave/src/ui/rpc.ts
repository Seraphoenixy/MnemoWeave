import type { MemoriesRequest, MemoryRequest, RpcResult, UiCreateInput, UiEditInput, UiRegisterTest, UiRuleCreateInput, UiRuleEditInput, UiSettings, UiWithdrawInput } from '../shared/contract.ts';
import { isRecord } from '../shared/contract.ts';
import type { MemorySource } from './memory-source.ts';
import type { RpcHandler } from './types.ts';
import { reviewSkill } from './skill-review.ts';
import { backtestSkill } from './skill-backtest.ts';
import { organizeMemory } from './organize-memory.ts';
import type { createTaskRunner } from './task-runner.ts';

/** The slice of the Host settings service this handler needs. */
export interface SettingsLike {
  settings(): UiSettings;
  saveInterface(patch: unknown): UiSettings;
  saveConnection(input: { serverUrl?: string; hostId?: string }): Promise<UiSettings>;
  saveInjection(input: { injectTimeoutMs?: number }): UiSettings;
  saveAutoStart(input: { enabled?: boolean }): UiSettings;
  /** Register the scheduled task; only the settings page's own button calls this. */
  registerTask(): Promise<UiRegisterTest>;
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
/** The Server's rule body limit, in characters rather than UTF-8 bytes. */
const MAX_RULE_BODY = 4_000;
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
  const cursor = payload['cursor'];
  if (query !== undefined && (typeof query !== 'string' || query.length > MAX_QUERY)) {
    invalid(`query must be a string of at most ${MAX_QUERY} characters`);
  }
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)) {
    invalid(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
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
/** The graph is a whole-catalog read; only the node cap is an argument. */
function graphRequest(payload: unknown): { limit?: number } {
  if (payload === undefined) return {};
  if (!isRecord(payload)) invalid('graph payload must be an object');
  const limit = payload['limit'];
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 500)) {
    invalid('limit must be an integer between 1 and 500');
  }
  return {
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

/** A rule needs a scope before it can be budgeted: a project rule competes with global ones. */
function ruleCreateRequest(payload: unknown): UiRuleCreateInput {
  if (!isRecord(payload)) invalid('createRule payload must be an object');
  const body = payload['body'];
  if (typeof body !== 'string' || body.trim() === '') invalid('body must be a non-empty string');
  if (body.trim().length > MAX_RULE_BODY) invalid(`body must contain at most ${MAX_RULE_BODY} characters`);
  const enabled = payload['enabled'];
  if (enabled !== undefined && typeof enabled !== 'boolean') invalid('enabled must be a boolean');
  return {
    body: body.trim(),
    ...(enabled === undefined ? {} : { enabled }),
  };
}

/**
 * An edit always carries the version it was opened at, so a rule changed by another host is
 * refused rather than silently overwritten. At least one field must actually change.
 */
function ruleEditRequest(payload: unknown): { ruleId: string } & UiRuleEditInput {
  if (!isRecord(payload) || typeof payload['ruleId'] !== 'string' || !UUID.test(payload['ruleId'])) {
    invalid('ruleId must be a UUID');
  }
  const body = payload['body'];
  if (body !== undefined) {
    if (typeof body !== 'string' || body.trim() === '') invalid('body must be a non-empty string');
    if (body.trim().length > MAX_RULE_BODY) invalid(`body must contain at most ${MAX_RULE_BODY} characters`);
  }
  const enabled = payload['enabled'];
  if (enabled !== undefined && typeof enabled !== 'boolean') invalid('enabled must be a boolean');
  if (body === undefined && enabled === undefined) invalid('editRule requires body or enabled');
  const baseVersion = payload['baseVersion'];
  if (baseVersion !== undefined && (typeof baseVersion !== 'number' || !Number.isInteger(baseVersion) || baseVersion < 0)) {
    invalid('baseVersion must be a non-negative integer');
  }
  return {
    ruleId: payload['ruleId'],
    ...(body === undefined ? {} : { body: (body as string).trim() }),
    ...(enabled === undefined ? {} : { enabled: enabled as boolean }),
    ...(baseVersion === undefined ? {} : { baseVersion: baseVersion as number }),
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
export function createRpcHandler(source: MemorySource, settings?: SettingsLike, task?: ReturnType<typeof createTaskRunner>): RpcHandler {
  return async (endpoint, payload, signal) => {
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
          return ok(settings.saveInterface(preferencesPatch(payload, ['defaultTab', 'pageSize'])));
        }
        case 'saveConnection': {
          if (settings === undefined) return fail('settings are unavailable in this build', 'PROVIDER_UNAVAILABLE');
          const request = connectionRequest(payload);
          return ok(await settings.saveConnection(request));
        }
        case 'saveInjection': {
          if (settings === undefined) return fail('settings are unavailable in this build', 'PROVIDER_UNAVAILABLE');
          return ok(settings.saveInjection(preferencesPatch(payload, ['injectTimeoutMs'])));
        }
        case 'saveAutoStart': {
          if (settings === undefined) return fail('settings are unavailable in this build', 'PROVIDER_UNAVAILABLE');
          const enabled = isRecord(payload) ? payload['enabled'] : undefined;
          if (typeof enabled !== 'boolean') invalid('enabled must be a boolean');
          return ok(settings.saveAutoStart({ enabled }));
        }
        case 'registerTask': {
          // The only path from the page to an elevation prompt: the user pressed the button.
          if (settings === undefined) return fail('settings are unavailable in this build', 'PROVIDER_UNAVAILABLE');
          return ok(await settings.registerTask());
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
        case 'skillConversations':
          return ok(task?.conversations?.() ?? []);
        case 'skillReview': {
          if (!task) return fail('DSH skill review is unavailable.', 'PROVIDER_UNAVAILABLE');
          if (!isRecord(payload)) invalid('Invalid skill review');
          const { sessionId, baseline } = payload;
          if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200
            || typeof baseline !== 'string' || baseline.length > 24000) invalid('Invalid conversation or baseline');
          return ok(await reviewSkill(task, sessionId, baseline, signal));
        }
        case 'skillBacktest': {
          if (!task) return fail('DSH skill evaluation is unavailable.', 'PROVIDER_UNAVAILABLE');
          if (!isRecord(payload)) invalid('Invalid skill backtest');
          const { baseline, candidate, scenario, checks } = payload;
          if (typeof baseline !== 'string' || baseline.length > 24000
            || typeof candidate !== 'string' || !candidate.trim() || candidate.length > 24000
            || typeof scenario !== 'string' || !scenario.trim() || scenario.length > 4000
            || !Array.isArray(checks) || checks.length < 1 || checks.length > 20
            || checks.some(check => typeof check !== 'string' || !check.trim() || check.length > 500)) {
            invalid('Invalid skill text, scenario or checks');
          }
          return ok(await backtestSkill(task, { baseline, candidate, scenario, checks }, signal));
        }
        case 'organizeMemory':
          if (!task) return fail('DSH memory tasks are unavailable.', 'PROVIDER_UNAVAILABLE');
          return ok(await organizeMemory(source, task, createRequest(payload), signal));
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
        case 'createRule': return ok(await source.createRule(ruleCreateRequest(payload)));
        case 'editRule': {
          const request = ruleEditRequest(payload);
          const { ruleId, ...input } = request;
          return ok(await source.editRule(ruleId, input));
        }
        case 'saveArchive': {
          if (!isRecord(payload)) invalid('Invalid archive');
          const { entryId, baseVersion, projectId, title, body, verification, evidence } = payload;
          if (typeof projectId !== 'string' || typeof title !== 'string' || typeof body !== 'string'
            || typeof evidence !== 'string' || (verification !== 'open' && verification !== 'verified' && verification !== 'refuted')) invalid('Invalid archive fields');
          const input = { projectId, title, body, verification, evidence } as const;
          if (entryId === undefined && baseVersion === undefined) return ok(await source.saveArchive(input));
          if (typeof entryId !== 'string' || !UUID.test(entryId) || typeof baseVersion !== 'number'
            || !Number.isSafeInteger(baseVersion) || baseVersion < 1) invalid('Invalid archive version');
          return ok(await source.saveArchive(input, { entryId, baseVersion }));
        }
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
