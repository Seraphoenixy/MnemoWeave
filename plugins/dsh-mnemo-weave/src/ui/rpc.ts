import type { MemoriesRequest, MemoryRequest, RpcResult, UiCreateInput, UiEditInput, UiRegisterTest, UiRuleCreateInput, UiRuleEditInput, UiSettings, UiWithdrawInput } from '../shared/contract.ts';
import { isRecord } from '../shared/contract.ts';
import type { MemorySource } from './memory-source.ts';
import type { RpcHandler } from './types.ts';
import { reviewSkill } from './skill-review.ts';
import { backtestSkill } from './skill-backtest.ts';
import { organizeMemory } from './organize-memory.ts';
import { confirmDistillation, previewDistillation } from './archive-distillation.ts';
import type { createTaskRunner } from './task-runner.ts';
import { runIdleReview } from './idle-review-task.ts';
import { applyOrganizeMemories, previewOrganizeMemories } from './organize-memory-task.ts';
import { listSkills } from './skills.ts';
import { adoptSkill, createSkill, readSkillText, readVersionText, restoreSkill, skillVersions } from './skills-write.ts';
import { autoAdoptSkill, parseAdoptionReview, readSkillPreferences, saveSkillPreferences } from './skills-adopt.ts';
import { listTrash, restoreTrash, trashSkill } from './skills-trash.ts';
import { adoptStoredDraft, dismissSkillDraft, listSkillDrafts, saveSkillDraft } from './skill-drafts.ts';
import type { UiSkillDraft } from '../shared/contract.ts';

function workspaceOf(payload: unknown): string {
  const input = isRecord(payload) ? payload : {};
  return typeof input['workspace'] === 'string' && input['workspace'].trim() !== '' ? input['workspace'].trim() : process.cwd();
}

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
  const entity = payload['entity'];
  if (entity !== undefined && (typeof entity !== 'string' || entity.trim() === '' || entity.trim().length > 200)) {
    invalid('entity must be a non-empty string of at most 200 characters');
  }
  const sort = payload['sort'];
  if (sort !== undefined && (typeof sort !== 'string' || !(SORTS as readonly string[]).includes(sort))) {
    invalid(`sort must be one of: ${SORTS.join(', ')}`);
  }
  // The shared collection has no workspace filter. A client that still sends one is refused
  // rather than silently shown an unfiltered list that looks filtered.
  for (const removed of ['projectId', 'includeGlobal']) {
    if (payload[removed] !== undefined) invalid(`${removed} was removed: formal memories are one shared collection`);
  }
  return {
    ...(query === undefined ? {} : { query }),
    limit: limit ?? DEFAULT_LIMIT,
    ...(cursor === undefined ? {} : { cursor }),
    ...(category === undefined ? {} : { category: category as (typeof CATEGORIES)[number] }),
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
  for (const removed of ['projectId', 'includeGlobal']) {
    if (payload[removed] !== undefined) invalid(`${removed} was removed: the graph covers the shared collection`);
  }
  return { ...(limit === undefined ? {} : { limit }) };
}

/** Explore is a read: a query is required, and the page size stays small by design. */
function exploreRequest(payload: unknown): { query: string; limit: number; minScore: number; hint?: string } {
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
  // An optional workspace name: a recall cue appended to the query, never a filter.
  const hint = payload['hint'];
  if (hint !== undefined && (typeof hint !== 'string' || hint.trim() === '' || hint.trim().length > 200)) {
    invalid('hint must be a non-empty string of at most 200 characters');
  }
  return {
    query: query.trim(), limit: limit ?? 20, minScore: minScore ?? 0,
    ...(hint === undefined ? {} : { hint: (hint as string).trim() }),
  };
}

/** A management archive request must name the workspace it is scoped to. */
function workspaceRequest(payload: unknown): string {
  if (!isRecord(payload) || typeof payload['workspaceId'] !== 'string' || !UUID.test(payload['workspaceId'])) {
    invalid('workspaceId must be a UUID');
  }
  return payload['workspaceId'];
}

/** One user-confirmed save: a formal memory or a workspace archive, chosen by the user. */
function organizeSaveRequest(payload: unknown): UiCreateInput {
  const request = createRequest(payload);
  if (!isRecord(payload)) invalid('Invalid organize request');
  const target = payload['target'];
  if (target !== undefined && target !== 'formal-memory' && target !== 'workspace-archive' && target !== 'rule') {
    invalid('target must be formal-memory, workspace-archive or rule');
  }
  return { ...request, ...(target === undefined ? {} : { target }) };
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
  for (const removed of ['projectId', 'scope', 'workspaceId']) {
    if (payload[removed] !== undefined) invalid(`${removed} was removed: a formal memory carries no workspace`);
  }
  // The knowledge-type dimension was removed; a caller that still sends one is told, rather
  // than having the field dropped and believing it was recorded.
  if (payload['knowledgeType'] !== undefined) invalid('knowledgeType was removed: a formal memory carries no knowledge type');
  const reason = payload['reason'];
  if (reason !== undefined && (typeof reason !== 'string' || reason.trim() === '' || reason.trim().length > MAX_REASON)) {
    invalid(`reason must be a non-empty string of at most ${MAX_REASON} characters`);
  }
  return {
    content,
    ...(category === undefined ? {} : { category: category as string }),
    ...(importance === undefined ? {} : { importance: importance as number }),
    ...(tags === undefined ? {} : { tags: (tags as string[]).map(tag => tag.trim()) }),
    ...(entities === undefined ? {} : { entities: (entities as string[]).map(entity => entity.trim()) }),
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
  const importance = payload['importance'];
  if (importance !== undefined && importance !== 'critical' && importance !== 'normal' && importance !== 'low') {
    invalid('importance must be critical, normal or low');
  }
  const pinned = payload['pinned'];
  if (pinned !== undefined && typeof pinned !== 'boolean') invalid('pinned must be a boolean');
  const remove = payload['remove'];
  if (remove !== undefined && remove !== true) invalid('remove must be true when present');
  const changes = [body, enabled, importance, pinned, remove].filter(item => item !== undefined).length;
  if (changes === 0) invalid('editRule requires a change');
  if (remove === true && changes > 1) invalid('removing a rule is exclusive with editing it');
  // The version the editor was opened at is mandatory: without it a concurrent change from another
  // host would be overwritten silently.
  const baseVersion = payload['baseVersion'];
  if (typeof baseVersion !== 'number' || !Number.isInteger(baseVersion) || baseVersion < 1) {
    invalid('baseVersion must be a positive integer read before editing');
  }
  return {
    ruleId: payload['ruleId'],
    ...(body === undefined ? {} : { body: (body as string).trim() }),
    ...(enabled === undefined ? {} : { enabled: enabled as boolean }),
    ...(importance === undefined ? {} : { importance }),
    ...(pinned === undefined ? {} : { pinned: pinned as boolean }),
    ...(remove === true ? { remove: true as const } : {}),
    baseVersion,
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
            ...(request.entity === undefined ? {} : { entity: request.entity }),
            ...(request.sort === undefined ? {} : { sort: request.sort }),
          }));
        }
        case 'memory': {
          const request = memoryRequest(payload);
          return ok(await source.memory(request.memoryId, request.revisionId));
        }
        case 'skillsList': {
          const input = isRecord(payload) ? payload : {};
          const workspace = typeof input['workspace'] === 'string' && input['workspace'].trim() !== '' ? input['workspace'].trim() : process.cwd();
          if (workspace.length > 4096) invalid('Invalid workspace');
          return ok(await listSkills(workspace));
        }
        case 'skillAdoptDraft': {
          const input = isRecord(payload) ? payload : {};
          const id = typeof input['id'] === 'string' ? input['id'] : '';
          const baselineHash = typeof input['baselineHash'] === 'string' ? input['baselineHash'] : '';
          if (id === '' || !/^[a-f0-9]{64}$/.test(baselineHash)) invalid('Invalid draft adoption');
          return ok(await adoptStoredDraft({ id, baselineHash }));
        }
        case 'skillDrafts': {
          const input = isRecord(payload) ? payload : {};
          return ok(await listSkillDrafts({
            ...(typeof input['workspace'] === 'string' && input['workspace'] !== '' ? { workspace: input['workspace'] } : {}),
            ...(typeof input['skillPath'] === 'string' && input['skillPath'] !== '' ? { skillPath: input['skillPath'] } : {}),
          }));
        }
        case 'skillSaveDraft': {
          const input = isRecord(payload) ? payload : {};
          const workspace = typeof input['workspace'] === 'string' ? input['workspace'].trim() : '';
          const skillPath = input['skillPath'] === null ? null : typeof input['skillPath'] === 'string' ? input['skillPath'] : undefined;
          const reason = typeof input['reason'] === 'string' ? input['reason'] : '';
          const baseline = typeof input['baseline'] === 'string' ? input['baseline'] : '';
          const candidate = typeof input['candidate'] === 'string' ? input['candidate'] : '';
          const scenario = typeof input['scenario'] === 'string' ? input['scenario'] : '';
          const checks = Array.isArray(input['checks']) ? input['checks'].filter((item): item is string => typeof item === 'string') : undefined;
          const evidence = Array.isArray(input['evidence']) ? input['evidence'] : [];
          if (workspace === '' || skillPath === undefined || reason === '' || candidate === '' || scenario === '' || checks === undefined) invalid('Invalid skill draft');
          const report = input['report'] === null || input['report'] === undefined ? null : parseAdoptionReview({ report: input['report'], checks, completedAt: new Date().toISOString() })?.report ?? null;
          return ok(await saveSkillDraft({
            workspace, skillPath, reason, baseline, candidate, scenario, checks,
            evidence: evidence.filter((item): item is UiSkillDraft['evidence'][number] => isRecord(item) && typeof item['step'] === 'number'
              && (item['role'] === 'user' || item['role'] === 'assistant') && typeof item['text'] === 'string'),
            report,
            backtestError: typeof input['backtestError'] === 'string' ? input['backtestError'] : null,
          }));
        }
        case 'skillDismissDraft': {
          const input = isRecord(payload) ? payload : {};
          const id = typeof input['id'] === 'string' ? input['id'] : '';
          if (id === '') invalid('Invalid draft');
          return ok(await dismissSkillDraft(id));
        }
        case 'skillRead': {
          const input = isRecord(payload) ? payload : {};
          const path = typeof input['path'] === 'string' ? input['path'] : '';
          if (path === '') invalid('Invalid skill path');
          return ok(await readSkillText({ workspace: workspaceOf(payload), path }));
        }
        case 'skillVersionText': {
          const input = isRecord(payload) ? payload : {};
          const path = typeof input['path'] === 'string' ? input['path'] : '';
          const versionId = typeof input['versionId'] === 'string' ? input['versionId'] : '';
          if (path === '' || versionId === '') invalid('Invalid version read');
          return ok(await readVersionText({ workspace: workspaceOf(payload), path, versionId }));
        }
        case 'skillTrash': {
          const input = isRecord(payload) ? payload : {};
          const workspace = workspaceOf(payload);
          const path = typeof input['path'] === 'string' ? input['path'] : '';
          if (path === '') invalid('Invalid skill path');
          return ok(await trashSkill({ workspace, path }));
        }
        case 'skillTrashList': return ok(await listTrash());
        case 'skillTrashRestore': {
          const input = isRecord(payload) ? payload : {};
          const workspace = workspaceOf(payload);
          const id = typeof input['id'] === 'string' ? input['id'] : '';
          if (id === '') invalid('Invalid trash entry');
          return ok(await restoreTrash({ id, workspace }));
        }
        case 'skillPreferences': return ok(await readSkillPreferences());
        case 'setSkillAutoAdopt': {
          const input = isRecord(payload) ? payload : {};
          if (typeof input['autoAdopt'] !== 'boolean') invalid('Invalid preference');
          return ok(await saveSkillPreferences({ autoAdopt: input['autoAdopt'] }));
        }
        case 'skillAutoAdopt': {
          const input = isRecord(payload) ? payload : {};
          const workspace = typeof input['workspace'] === 'string' && input['workspace'].trim() !== '' ? input['workspace'].trim() : process.cwd();
          const path = typeof input['path'] === 'string' ? input['path'] : '';
          const candidate = typeof input['candidate'] === 'string' ? input['candidate'] : '';
          const baselineHash = typeof input['baselineHash'] === 'string' ? input['baselineHash'] : '';
          const review = parseAdoptionReview(input['review']);
          if (path === '' || candidate === '' || !/^[a-f0-9]{64}$/.test(baselineHash) || review === null) invalid('Invalid adoption review');
          return ok(await autoAdoptSkill({ workspace, path, candidate, baselineHash, review }));
        }
        case 'skillCreate': {
          const input = isRecord(payload) ? payload : {};
          const workspace = typeof input['workspace'] === 'string' && input['workspace'].trim() !== '' ? input['workspace'].trim() : process.cwd();
          const root = typeof input['root'] === 'string' ? input['root'] : '';
          const name = typeof input['name'] === 'string' ? input['name'] : '';
          const description = typeof input['description'] === 'string' ? input['description'] : '';
          if (root === '' || name === '' || description === '') invalid('Invalid skill');
          return ok(await createSkill({ workspace, root, name, description, ...(typeof input['body'] === 'string' ? { body: input['body'] } : {}) }));
        }
        case 'skillVersions': {
          const input = isRecord(payload) ? payload : {};
          const workspace = typeof input['workspace'] === 'string' && input['workspace'].trim() !== '' ? input['workspace'].trim() : process.cwd();
          const path = typeof input['path'] === 'string' ? input['path'] : '';
          if (path === '' || workspace.length > 4096) invalid('Invalid skill path');
          return ok(await skillVersions({ workspace, path }));
        }
        case 'skillAdopt': {
          const input = isRecord(payload) ? payload : {};
          const workspace = typeof input['workspace'] === 'string' && input['workspace'].trim() !== '' ? input['workspace'].trim() : process.cwd();
          const path = typeof input['path'] === 'string' ? input['path'] : '';
          const candidate = typeof input['candidate'] === 'string' ? input['candidate'] : '';
          const baselineHash = typeof input['baselineHash'] === 'string' ? input['baselineHash'] : '';
          if (path === '' || candidate === '' || !/^[a-f0-9]{64}$/.test(baselineHash)) invalid('Invalid skill write');
          return ok(await adoptSkill({ workspace, path, candidate, baselineHash }));
        }
        case 'skillRestore': {
          const input = isRecord(payload) ? payload : {};
          const workspace = typeof input['workspace'] === 'string' && input['workspace'].trim() !== '' ? input['workspace'].trim() : process.cwd();
          const path = typeof input['path'] === 'string' ? input['path'] : '';
          const versionId = typeof input['versionId'] === 'string' ? input['versionId'] : '';
          const baselineHash = typeof input['baselineHash'] === 'string' ? input['baselineHash'] : '';
          if (path === '' || versionId === '' || !/^[a-f0-9]{64}$/.test(baselineHash)) invalid('Invalid skill restore');
          return ok(await restoreSkill({ workspace, path, versionId, baselineHash }));
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
          return ok(await organizeMemory(source, task, organizeSaveRequest(payload), signal));
        case 'create': return ok(await source.create(createRequest(payload)));
        case 'edit': return ok(await source.edit(editRequest(payload)));
        case 'withdraw': return ok(await source.withdraw(withdrawRequest(payload)));
        case 'graph': return ok(await source.graph(graphRequest(payload)));
        case 'embeddingDiagnostics': return ok(await source.embeddingDiagnostics());
        case 'organizeMemories': {
          if (task === undefined) return fail('task agents are unavailable in this build', 'PROVIDER_UNAVAILABLE');
          if (!isRecord(payload)) invalid('Invalid organize request');
          const instruction = typeof payload['instruction'] === 'string' ? payload['instruction'].trim() : '';
          if (instruction === '' || instruction.length > 2000) invalid('instruction is required');
          if (payload['projectId'] !== undefined) invalid('projectId was removed: formal memories are one shared collection');
          const workspaceId = typeof payload['workspaceId'] === 'string' && payload['workspaceId'].trim() !== '' ? payload['workspaceId'].trim() : undefined;
          if (workspaceId !== undefined && !UUID.test(workspaceId)) invalid('workspaceId must be a UUID');
          if (payload['apply'] === true) {
            // Only confirmed items run; the plan carries the versions the Agent was shown so a
            // change made in between stops that one item instead of overwriting it.
            const plan = isRecord(payload['plan']) ? payload['plan'] : null;
            const confirmed = Array.isArray(payload['confirmed'])
              ? payload['confirmed'].filter((item): item is number => typeof item === 'number' && Number.isInteger(item) && item >= 0).slice(0, 8)
              : [];
            if (plan === null) invalid('A confirmed plan is required');
            return ok(await applyOrganizeMemories(source, plan as never, confirmed));
          }
          return ok(await previewOrganizeMemories(source, task, { instruction }, signal));
        }
        case 'distillArchive': {
          // Preview only: the draft is created, nothing is published. Management code reads the
          // full body through the history route; the model segment tool is not used here.
          if (task === undefined) return fail('task agents are unavailable in this build', 'PROVIDER_UNAVAILABLE');
          if (!isRecord(payload) || typeof payload['entryId'] !== 'string' || !UUID.test(payload['entryId'])) invalid('entryId must be a UUID');
          return ok(await previewDistillation(source, task, payload['entryId'], signal));
        }
        case 'readDistillation': {
          if (!isRecord(payload) || typeof payload['draftId'] !== 'string' || !UUID.test(payload['draftId'])) invalid('draftId must be a UUID');
          return ok(await source.distillation(payload['draftId']));
        }
        case 'reviseDistillation': {
          if (!isRecord(payload) || typeof payload['draftId'] !== 'string' || !UUID.test(payload['draftId'])
            || typeof payload['content'] !== 'string' || typeof payload['category'] !== 'string') invalid('Invalid distillation revision');
          const { kind: _kind, draftId: _draftId, usedRange, taskId, ...draft } = await source.distillation(payload['draftId']);
          if (taskId !== undefined) invalid('The distillation was already confirmed');
          const revised = await source.createDistillation({
            ...draft,
            content: payload['content'],
            ...(typeof payload['category'] === 'string' ? { category: payload['category'] } : {}),
          });
          return ok({ ...revised, usedRange });
        }
        case 'confirmDistillation': {
          if (!isRecord(payload)) invalid('Invalid distillation confirmation');
          const { draftId } = payload;
          if (typeof draftId !== 'string' || !UUID.test(draftId)) invalid('draftId must be a UUID');
          const reason = typeof payload['reason'] === 'string' && payload['reason'].trim() !== ''
            ? payload['reason'].trim().slice(0, 500) : '用户确认从档案提炼';
          return ok(await confirmDistillation(source, { draftId, reason }));
        }
        case 'idleReviewRun': {
          if (task === undefined) return fail('task agents are unavailable in this build', 'PROVIDER_UNAVAILABLE');
          const input = isRecord(payload) ? payload : {};
          const sessionId = typeof input['sessionId'] === 'string' ? input['sessionId'].trim() : '';
          if (sessionId === '') invalid('sessionId is required.');
          if (input['projectId'] !== undefined) invalid('projectId was removed: formal memories are one shared collection');
          return ok(await runIdleReview(source, task, sessionId, undefined, signal));
        }
        case 'explore': {
          const request = exploreRequest(payload);
          return ok(await source.explore(request));
        }
        case 'injection': return ok(await source.injection());
        case 'rules': return ok(await source.rules());
        case 'ruleUsage': return ok(await source.ruleUsage());
        case 'workspaces': return ok(await source.workspaces());
        case 'archiveCapacities': {
          const workspaceId = workspaceRequest(payload);
          return ok(await source.archiveCapacities(workspaceId));
        }
        case 'archiveReleaseCandidates': {
          const workspaceId = workspaceRequest(payload);
          const limit = isRecord(payload) && typeof payload['limit'] === 'number' ? payload['limit'] : undefined;
          if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) invalid('Invalid release candidate limit');
          return ok(await source.archiveReleaseCandidates(workspaceId, limit));
        }
        case 'archiveSearch': {
          if (!isRecord(payload)) invalid('Invalid archive search');
          const { workspaceId, query, limit, includeArchived } = payload;
          if (typeof workspaceId !== 'string' || !UUID.test(workspaceId) || typeof query !== 'string' || query.trim() === '') invalid('Invalid archive search');
          if (limit !== undefined && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)) invalid('Invalid archive search limit');
          if (includeArchived !== undefined && typeof includeArchived !== 'boolean') invalid('Invalid archive search scope');
          return ok(await source.searchArchives({ workspaceId, query, ...(limit === undefined ? {} : { limit }), ...(includeArchived === undefined ? {} : { includeArchived }) }));
        }
        case 'archiveHistory': {
          if (!isRecord(payload) || typeof payload['entryId'] !== 'string') invalid('Invalid archive history request');
          return ok(await source.archiveHistory(payload['entryId']));
        }
        case 'setArchiveState': {
          if (!isRecord(payload)) invalid('Invalid archive state request');
          const { entryId, state, baseVersion, changeId } = payload;
          if (typeof entryId !== 'string' || (state !== 'active' && state !== 'archived')
            || typeof baseVersion !== 'number' || !Number.isSafeInteger(baseVersion) || baseVersion < 1) invalid('Invalid archive state request');
          if (changeId !== undefined && typeof changeId !== 'string') invalid('Invalid archive change ID');
          return ok(await source.setArchiveState(entryId, state, baseVersion, changeId));
        }
        case 'createRule': return ok(await source.createRule(ruleCreateRequest(payload)));
        case 'editRule': {
          const request = ruleEditRequest(payload);
          const { ruleId, ...input } = request;
          return ok(await source.editRule(ruleId, input));
        }
        case 'saveArchive': {
          if (!isRecord(payload)) invalid('Invalid archive');
          const { entryId, baseVersion, workspaceId, title, body, verification, evidence } = payload;
          if (typeof workspaceId !== 'string' || !UUID.test(workspaceId) || typeof title !== 'string' || typeof body !== 'string'
            || typeof evidence !== 'string' || (verification !== 'open' && verification !== 'verified' && verification !== 'refuted')) invalid('Invalid archive fields');
          const input = { workspaceId, title, body, verification, evidence } as const;
          if (entryId === undefined && baseVersion === undefined) return ok(await source.saveArchive(input));
          if (typeof entryId !== 'string' || !UUID.test(entryId) || typeof baseVersion !== 'number'
            || !Number.isSafeInteger(baseVersion) || baseVersion < 1) invalid('Invalid archive version');
          return ok(await source.saveArchive(input, { entryId, baseVersion }));
        }
        case 'archives': return ok(await source.archives(workspaceRequest(payload)));
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
