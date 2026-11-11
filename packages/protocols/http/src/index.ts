import { ArchiveCreate, ArchiveEdit, ArchiveSearchInput, ArchiveStateInput, type ArchiveEditInput, PinInput, RuntimeContextInput, RuleCreate, RuleEdit } from '../../../core/contracts/src/index.ts';
import type { MemoryCreateRecord, MemoryGraphRecord, MemoryListRecord, MemoryEditRecord, RuntimeContext, PinRecord } from '../../../core/contracts/src/index.ts';
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { MemoryApplication } from '../../../core/application/src/index.ts';
import { ExploreInput, MnemoWeaveError, openapi, publicError, REQUEST_BODY_MAX_BYTES, statusForCode } from '../../../core/contracts/src/index.ts';
import type { ArchiveCreateInput, ArchiveHistoryRecordValue, ArchiveListRecord, ArchiveRecordValue, ArchiveSearchInputRecord, ArchiveSearchOutputRecord, ArchiveStateInputRecord, DiagnosticJobRecord, EmbeddingDiagnosticsRecord, IdleReviewPendingRecord, IdleReviewRunRecord, IdleReviewScanRecord, IdleReviewSignalRecord, InjectionReportRecord, RuleArchiveRecordValue, RuleCreateInput, RuleEditInput, RuleListRecord, RuleRecordValue, StorageStatusRecord, SyncRefreshValue, SyncStatusValue, ViewRecord } from '../../../core/contracts/src/index.ts';

/** Liveness identity: hosts require these fields before trusting the address as MnemoWeave. */
export const LIVE_SERVICE = 'mnemoweave';
export const LIVE_PROTOCOL = 1;

/** A host may declare its project once per request; the body may repeat it but not contradict it. */
const PROJECT_HEADER = 'x-mnemoweave-project';
function withProjectHeader(headers: Record<string, string | string[] | undefined>, input: unknown): unknown {
  const raw = headers[PROJECT_HEADER];
  const declared = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!declared) return input;
  if (declared.length > 200) throw new MnemoWeaveError('INVALID_INPUT');
  if (typeof input !== 'object' || input === null) return input;
  const body = input as Record<string, unknown>;
  const current = body['projectId'];
  if (current !== undefined && current !== declared) throw new MnemoWeaveError('INVALID_INPUT');
  return { ...body, projectId: declared };
}

/** Single source of truth for the served routes; the OpenAPI document must mirror this list. */
export const httpRoutes: ReadonlyArray<{ method: 'GET' | 'POST' | 'PATCH'; path: string }> = [
  { method: 'POST', path: '/v1/runtime/context' },
  { method: 'POST', path: '/v1/runtime/pins' },
  { method: 'POST', path: '/v1/runtime/projects' },
  { method: 'GET', path: '/health/live' },
  { method: 'GET', path: '/health/ready' },
  { method: 'GET', path: '/openapi.json' },
  { method: 'GET', path: '/v1/storage' },
  { method: 'GET', path: '/v1/diagnostics/embeddings' },
  { method: 'POST', path: '/v1/diagnostics/embeddings/backfill' },
  { method: 'POST', path: '/v1/idle-review/scan' },
  { method: 'GET', path: '/v1/idle-review/signals' },
  { method: 'POST', path: '/v1/idle-review/runs' },
  { method: 'GET', path: '/v1/idle-review/runs' },
  { method: 'GET', path: '/v1/idle-review/pending' },
  { method: 'POST', path: '/v1/idle-review/runs/{runId}/items' },
  { method: 'POST', path: '/v1/idle-review/runs/{runId}/finish' },
  { method: 'GET', path: '/v1/reviews/due' },
  { method: 'GET', path: '/v1/candidates/{candidateId}' },
  { method: 'GET', path: '/v1/projects' },
  { method: 'GET', path: '/v1/memories' },
  { method: 'POST', path: '/v1/memories' },
  { method: 'GET', path: '/v1/memories/{memoryId}' },
  { method: 'GET', path: '/v1/memories/graph' },
  { method: 'POST', path: '/v1/memories/explore' },
  { method: 'GET', path: '/v1/conflicts/{caseId}' },
  { method: 'POST', path: '/v1/recall' },
  { method: 'POST', path: '/v1/view' },
  { method: 'POST', path: '/v1/inject' },
  { method: 'POST', path: '/v1/events' },
  { method: 'POST', path: '/v1/session/close' },
  { method: 'POST', path: '/v1/remember' },
  { method: 'POST', path: '/v1/review' },
  { method: 'POST', path: '/v1/retry' },
  { method: 'POST', path: '/v1/conflicts/resolve' },
  { method: 'POST', path: '/v1/versions/cancel' },
  { method: 'POST', path: '/v1/reviews/complete' },
  { method: 'PATCH', path: '/v1/memories/{memoryId}' },
  { method: 'POST', path: '/v1/memories/{memoryId}/withdraw' },
  { method: 'GET', path: '/v1/sync/status' },
  { method: 'POST', path: '/v1/sync/refresh' },
  { method: 'GET', path: '/v1/injections/latest' },
  { method: 'GET', path: '/v1/rules' },
  { method: 'POST', path: '/v1/rules' },
  { method: 'PATCH', path: '/v1/rules/{ruleId}' },
  { method: 'GET', path: '/v1/rules/archive' },
  { method: 'GET', path: '/v1/archives' },
  { method: 'POST', path: '/v1/archives' },
  { method: 'PATCH', path: '/v1/archives/{entryId}' },
  { method: 'POST', path: '/v1/archives/{entryId}/state' },
  { method: 'GET', path: '/v1/archives/{entryId}/history' },
  { method: 'GET', path: '/v1/archives/search' },
];

/** Error code → HTTP status mapping from the contract error model. */
export { statusForCode };

/**
 * Everything a Host client reaches over HTTP. Hosts authenticate with the service token and
 * name themselves through `x-mnemoweave-host`; there is no local replica and no pairing.
 */
export interface ClientHttpEndpoints {
  view(hostId: string, input: unknown): Promise<ViewRecord>;
  context(hostId: string, input: ReturnType<typeof RuntimeContextInput.parse>): RuntimeContext;
  pin(input: PinRecord): void;
  register(projectId: string): void;
  closeSession(hostId: string, sessionId: string): void;
  events(hostId: string, input: unknown): { status: 'stored' | 'replayed' | 'skipped'; eventId: string };
  memories(query: {
    query?: string; limit: number; cursor?: string;
    /** Keep only memories whose current revision carries this classification. */
    category?: 'preference' | 'decision' | 'fact' | 'insight' | 'context' | 'general';
    knowledgeType?: 'Concept' | 'Practice' | 'Architecture' | 'Troubleshooting' | 'Constraint' | 'Procedure' | 'Reference';
    /** Case-insensitive match against an entity named by the current revision. */
    entity?: string;
    /** Scan order; a cursor only applies to the order it was issued for. */
    sort?: 'newest' | 'oldest' | 'importance';
    /** Management-page project filter; general memory is included unless excluded. */
    projectId?: string | undefined;
    includeGlobal?: boolean | undefined;
  }): Promise<MemoryListRecord>;
  /** Direct creation: publishes a formal memory without a review round. */
  createMemory?(input: unknown): Promise<MemoryCreateRecord>;
  /** Official embedding coverage and derived recall mode, for the status page. */
  embeddingDiagnostics?(hostId: string): Promise<EmbeddingDiagnosticsRecord>;
  /** Start one vector backfill; a running job is refused rather than queued. */
  embeddingBackfill?(hostId: string): Promise<DiagnosticJobRecord>;
  /** Deterministic idle-review signal selection over completed turns. */
  idleReviewScan?(hostId: string, input: unknown): Promise<IdleReviewScanRecord>;
  idleReviewSignals?(hostId: string, sessionId: string): Promise<{ items: IdleReviewSignalRecord[] }>;
  idleReviewRunStart?(hostId: string, input: unknown): Promise<{ run: IdleReviewRunRecord; signals: IdleReviewSignalRecord[] }>;
  idleReviewRuns?(hostId: string, sessionId: string): Promise<{ items: IdleReviewRunRecord[] }>;
  idleReviewRunItem?(hostId: string, runId: string, input: unknown): Promise<IdleReviewRunRecord>;
  idleReviewRunFinish?(hostId: string, runId: string, input: unknown): Promise<IdleReviewRunRecord>;
  idleReviewPending?(hostId: string): Promise<IdleReviewPendingRecord>;
  /** Relation graph over the visible catalog: structure only, no bodies. */
  graph?(hostId: string, query: { limit: number; projectId?: string; includeGlobal?: boolean }): Promise<MemoryGraphRecord>;
  /** Project ids this Server knows, for the management page's selector. */
  projects?(hostId: string): Promise<{ projects: string[] }>;
  /** Provider-ranked search, mapped to memories this machine knows. */
  recall?(hostId: string, input: unknown): Promise<{ memories: Array<{ id: string; content: string; score?: number | undefined; superseded?: boolean | undefined }> }>;
  explore?(hostId: string, input: { query: string; limit: number; minScore?: number; projectId?: string | undefined }): Promise<{ query: string; hits: Array<Record<string, unknown>>; unregistered: number; truncated: boolean }>;
  editMemory(memoryId: string, input: { content: string; reason?: string; entryVersion: number }): Promise<MemoryEditRecord>;
  /** Withdraw a memory: it leaves recall and injection, its history stays readable. */
  withdrawMemory?(memoryId: string, input: { reason: string; entryVersion: number }): Promise<{ memoryId: string; revisionId: string; entryVersion: number; withdrawnAt: string }>;
  /** Operator diagnostics; absent when sync is not configured. */
  syncStatus?(): Promise<SyncStatusValue>;
  syncRefresh?(): Promise<SyncRefreshValue>;
  /** Last injection result, or null before any injection happened. */
  lastInjection?(hostId?: string, sessionId?: string): Promise<InjectionReportRecord | null>;
  rules?(query: Record<string, never>): Promise<RuleListRecord>;
  ruleArchive?(): Promise<{ items: RuleArchiveRecordValue[] }>;
  archives?(query: { projectId?: string; includeWithdrawn?: boolean; limit?: number; cursor?: string }): Promise<ArchiveListRecord>;
  searchArchives?(hostId: string, input: ArchiveSearchInputRecord): Promise<ArchiveSearchOutputRecord>;
  archiveHistory?(entryId: string): Promise<{ entryId: string; items: ArchiveHistoryRecordValue[] }>;
  editArchiveState?(entryId: string, input: ArchiveStateInputRecord): Promise<ArchiveRecordValue>;
  createRule?(input: RuleCreateInput): Promise<RuleRecordValue>;
  editRule?(ruleId: string, input: RuleEditInput): Promise<RuleRecordValue>;
  editArchive?(entryId: string, input: ArchiveEditInput): Promise<ArchiveRecordValue>;
  createArchive?(input: ArchiveCreateInput): Promise<ArchiveRecordValue>;
}

const OPERATOR_ROUTES = new Set(['/v1/review', '/v1/retry', '/v1/conflicts/resolve', '/v1/versions/cancel', '/v1/reviews/complete', '/v1/runtime/pins', '/v1/runtime/projects', '/v1/reviews/due']);

export function createHttpServer(app: MemoryApplication, token: string, operatorToken?: string, client?: ClientHttpEndpoints, storage?: () => StorageStatusRecord) {
  if (token.length < 24) throw new Error('MNEMOWEAVE_TOKEN must contain at least 24 characters');
  if (operatorToken !== undefined && (operatorToken.length < 24 || operatorToken === token)) throw new Error('Independent operator token required');
  const expected = Buffer.from(`Bearer ${token}`);
  const operatorExpected = operatorToken ? Buffer.from(`Bearer ${operatorToken}`) : undefined;
  /**
   * Two identities exist: the service token plus a declared Host header (what a host plugin
   * uses), and an operator token for management routes that do not belong to a host — review,
   * conflicts, runtime pins, archives.
   *
   * Memory and rule writes are user writes: they require an identity but no second credential.
   * A confirmation value was removed earlier because the caller that requests it is also the
   * caller that consumes it, so it proved nothing about a person being present.
   */
  return createServer(async (req, res) => {
    const traceId = randomUUID();
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-trace-id': traceId });
      res.end(JSON.stringify(value));
    };
    try {
      const actual = Buffer.from(req.headers.authorization ?? '');
      const isOperator = !!operatorExpected && actual.length === operatorExpected.length && timingSafeEqual(actual, operatorExpected);
      if (!isOperator && (actual.length !== expected.length || !timingSafeEqual(actual, expected))) throw new MnemoWeaveError('UNAUTHORIZED');
      if (req.headers.origin) throw new MnemoWeaveError('UNAUTHORIZED');
      const requireHost = (): string => {
        const host = req.headers['x-mnemoweave-host'];
        if (typeof host !== 'string' || !host.trim()) throw new MnemoWeaveError('UNAUTHORIZED');
        return host;
      };

      // The identity fields let a host tell "our Server answered" apart from "some other
      // program holds this port". A bare `{live:true}` cannot: any process that returns 200
      // on the loopback port would pass, and the host would then send its token to it.
      if (req.method === 'GET' && req.url === '/health/live') return reply(200, { live: true, service: LIVE_SERVICE, protocol: LIVE_PROTOCOL });
      if (req.method === 'GET' && req.url === '/health/ready') return reply(200, await app.health());
      if (req.method === 'GET' && req.url === '/openapi.json') return reply(200, openapi);
      if (req.method === 'GET' && req.url === '/v1/storage') {
        if (!storage) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, storage());
      }
      if (req.method === 'GET' && req.url === '/v1/diagnostics/embeddings') {
        if (!client?.embeddingDiagnostics) throw new MnemoWeaveError('REVIEW_REQUIRED');
        // Read-only diagnosis: the Host identity is required like any other management read, but
        // the answer describes the local Provider, not that Host's memories.
        return reply(200, await client.embeddingDiagnostics(requireHost()));
      }
      if (req.method === 'POST' && req.url === '/v1/idle-review/runs') {
        if (!client?.idleReviewRunStart) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(201, await client.idleReviewRunStart(requireHost(), await readJson(req)));
      }
      if (req.method === 'GET' && req.url !== undefined && (req.url === '/v1/idle-review/runs' || req.url.startsWith('/v1/idle-review/runs?'))) {
        if (!client?.idleReviewRuns) throw new MnemoWeaveError('REVIEW_REQUIRED');
        const sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId')?.trim() ?? '';
        if (sessionId === '' || sessionId.length > 256) throw new MnemoWeaveError('INVALID_INPUT');
        return reply(200, await client.idleReviewRuns(requireHost(), sessionId));
      }
      if (req.method === 'GET' && req.url === '/v1/idle-review/pending') {
        if (!client?.idleReviewPending) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.idleReviewPending(requireHost()));
      }
      const idleRunItem = /^\/v1\/idle-review\/runs\/([a-f0-9-]{36})\/items$/.exec(req.url ?? '');
      if (req.method === 'POST' && idleRunItem) {
        if (!client?.idleReviewRunItem) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.idleReviewRunItem(requireHost(), idleRunItem[1]!, await readJson(req)));
      }
      const idleRunFinish = /^\/v1\/idle-review\/runs\/([a-f0-9-]{36})\/finish$/.exec(req.url ?? '');
      if (req.method === 'POST' && idleRunFinish) {
        if (!client?.idleReviewRunFinish) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.idleReviewRunFinish(requireHost(), idleRunFinish[1]!, await readJson(req)));
      }
      if (req.method === 'POST' && req.url === '/v1/idle-review/scan') {
        if (!client?.idleReviewScan) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.idleReviewScan(requireHost(), await readJson(req)));
      }
      if (req.method === 'GET' && req.url !== undefined && (req.url === '/v1/idle-review/signals' || req.url.startsWith('/v1/idle-review/signals?'))) {
        if (!client?.idleReviewSignals) throw new MnemoWeaveError('REVIEW_REQUIRED');
        const sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId')?.trim() ?? '';
        if (sessionId === '' || sessionId.length > 256) throw new MnemoWeaveError('INVALID_INPUT');
        return reply(200, await client.idleReviewSignals(requireHost(), sessionId));
      }
      if (req.method === 'POST' && req.url === '/v1/diagnostics/embeddings/backfill') {
        if (!client?.embeddingBackfill) throw new MnemoWeaveError('REVIEW_REQUIRED');
        // A local maintenance write, like a rule write: the Host identifies the initiator and the
        // Server owns the single-flight job.
        return reply(202, await client.embeddingBackfill(requireHost()));
      }
      if (req.method === 'GET' && req.url === '/v1/sync/status') {
        if (!isOperator) requireHost();
        if (!client?.syncStatus) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.syncStatus());
      }
      if (req.method === 'POST' && req.url === '/v1/sync/refresh') {
        if (!isOperator) requireHost();
        if (!client?.syncRefresh) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.syncRefresh());
      }
      if (req.method === 'GET' && req.url !== undefined && (req.url === '/v1/injections/latest' || req.url.startsWith('/v1/injections/latest?'))) {
        if (!client?.lastInjection) throw new MnemoWeaveError('REVIEW_REQUIRED');
        const params = new URL(req.url, 'http://localhost').searchParams;
        const sessionId = params.get('sessionId')?.trim() || undefined;
        if (sessionId !== undefined && sessionId.length > 200) throw new MnemoWeaveError('INVALID_INPUT');
        // An operator reads the newest report across hosts; a host reads only its own rows.
        const report = await client.lastInjection(isOperator ? undefined : requireHost(), sessionId);
        if (!report) throw new MnemoWeaveError('NOT_FOUND');
        return reply(200, report);
      }
      if (req.method === 'GET' && req.url !== undefined && (req.url === '/v1/rules' || req.url.startsWith('/v1/rules?'))) {
        if (!client?.rules) throw new MnemoWeaveError('REVIEW_REQUIRED');
        // Rules apply to every session, so there is nothing to narrow.
        if (!isOperator) requireHost();
        return reply(200, await client.rules({}));
      }
      if (req.method === 'GET' && req.url === '/v1/rules/archive') {
        if (!isOperator) requireHost();
        if (!client?.ruleArchive) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.ruleArchive());
      }
      if (req.method === 'GET' && req.url !== undefined && (req.url === '/v1/archives/search' || req.url.startsWith('/v1/archives/search?'))) {
        if (!client?.searchArchives) throw new MnemoWeaveError('REVIEW_REQUIRED');
        const params = new URL(req.url, 'http://localhost').searchParams;
        if (!isOperator) requireHost();
        const limit = params.get('limit');
        return reply(200, await client.searchArchives(
          req.headers['x-mnemoweave-host']?.toString() || 'operator',
          ArchiveSearchInput.parse({
            projectId: params.get('projectId') ?? '',
            query: params.get('query') ?? params.get('q') ?? '',
            ...(limit === null ? {} : { limit: Number(limit) }),
            includeArchived: params.get('includeArchived') === 'true',
          }),
        ));
      }
      if (req.method === 'POST' && req.url === '/v1/rules') {
        // A rule is a user write like a memory: the caller must identify itself, and no second
        // credential is required on a single-user deployment.
        if (!isOperator) requireHost();
        if (!client?.createRule) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(201, await client.createRule(RuleCreate.parse(await readJson(req))));
      }
      const ruleMatch = /^\/v1\/rules\/([a-f0-9-]+)$/.exec(req.url ?? '');
      if (req.method === 'PATCH' && ruleMatch) {
        // Same rule: the audit trail records who sent the change, not that a person was present.
        if (!isOperator) requireHost();
        if (!client?.editRule) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.editRule(ruleMatch[1]!, RuleEdit.parse(await readJson(req))));
      }
      if (req.method === 'GET' && req.url !== undefined && (req.url === '/v1/archives' || req.url.startsWith('/v1/archives?'))) {
        if (!client?.archives) throw new MnemoWeaveError('REVIEW_REQUIRED');
        const params = new URL(req.url, 'http://localhost').searchParams;
        const projectId = params.get('projectId')?.trim() || undefined;
        if (projectId !== undefined && projectId.length > 200) throw new MnemoWeaveError('INVALID_INPUT');
        const rawWithdrawn = params.get('includeWithdrawn');
        if (rawWithdrawn !== null && rawWithdrawn !== 'true' && rawWithdrawn !== 'false') throw new MnemoWeaveError('INVALID_INPUT');
        // Without a project the read covers every project; hosts must still identify themselves.
        if (!isOperator) requireHost();
        const limit = params.get('limit');
        const cursor = params.get('cursor') ?? undefined;
        return reply(200, await client.archives({
          ...(projectId ? { projectId } : {}), includeWithdrawn: rawWithdrawn === 'true',
          ...(limit === null ? {} : { limit: Number(limit) }),
          ...(cursor === undefined ? {} : { cursor }),
        }));
      }
      if (req.method === 'POST' && req.url === '/v1/archives') {
        if (!isOperator) requireHost();
        if (!client?.createArchive) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(201, await client.createArchive(ArchiveCreate.parse(await readJson(req))));
      }
      const archiveMatch = /^\/v1\/archives\/([a-f0-9-]{36})$/.exec(req.url ?? '');
      if (req.method === 'PATCH' && archiveMatch) {
        if (!isOperator) requireHost();
        if (!client?.editArchive) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.editArchive(archiveMatch[1]!, ArchiveEdit.parse(await readJson(req))));
      }
      const archiveStateMatch = /^\/v1\/archives\/([a-f0-9-]{36})\/state$/.exec(req.url ?? '');
      if (req.method === 'POST' && archiveStateMatch) {
        if (!isOperator) requireHost();
        if (!client?.editArchiveState) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.editArchiveState(archiveStateMatch[1]!, ArchiveStateInput.parse(await readJson(req))));
      }
      const archiveHistoryMatch = /^\/v1\/archives\/([a-f0-9-]{36})\/history$/.exec(req.url ?? '');
      if (req.method === 'GET' && archiveHistoryMatch) {
        if (!isOperator) requireHost();
        if (!client?.archiveHistory) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.archiveHistory(archiveHistoryMatch[1]!));
      }
      if (req.method === 'GET' && req.url === '/v1/reviews/due') {
        if (!isOperator) throw new MnemoWeaveError('UNAUTHORIZED');
        return reply(200, await app.reviewDue());
      }
      const candidateMatch = /^\/v1\/candidates\/([a-f0-9-]+)$/.exec(req.url ?? '');
      if (req.method === 'GET' && candidateMatch) return reply(200, await app.candidateStatus({ candidateId: candidateMatch[1] }));
      if (req.method === 'GET' && req.url === '/v1/projects') {
        if (!client?.projects) throw new MnemoWeaveError('REVIEW_REQUIRED');
        // Read-only: any identified Host may list the projects so the page can offer a selector.
        return reply(200, await client.projects(requireHost()));
      }
      if (req.method === 'GET' && req.url !== undefined && (req.url === '/v1/memories' || req.url.startsWith('/v1/memories?'))) {
        if (!client) throw new MnemoWeaveError('REVIEW_REQUIRED');
        const params = new URL(req.url, 'http://localhost').searchParams;
        const query = params.get('query')?.trim() || undefined;
        const rawLimit = params.get('limit');
        const limit = rawLimit === null ? 50 : Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200 || (query !== undefined && query.length > 500)) throw new MnemoWeaveError('INVALID_INPUT');
        const cursor = params.get('cursor')?.trim() || undefined;
        if (cursor !== undefined && cursor.length > 500) throw new MnemoWeaveError('INVALID_INPUT');
        // Classification filters are validated here so an unknown value is a 400, not a silently
        // empty list.
        const CATEGORIES = ['preference', 'decision', 'fact', 'insight', 'context', 'general'] as const;
        const KNOWLEDGE = ['Concept', 'Practice', 'Architecture', 'Troubleshooting', 'Constraint', 'Procedure', 'Reference'] as const;
        const rawCategory = params.get('category')?.trim() || undefined;
        if (rawCategory !== undefined && !(CATEGORIES as readonly string[]).includes(rawCategory)) throw new MnemoWeaveError('INVALID_INPUT');
        const rawKnowledge = params.get('knowledgeType')?.trim() || undefined;
        if (rawKnowledge !== undefined && !(KNOWLEDGE as readonly string[]).includes(rawKnowledge)) throw new MnemoWeaveError('INVALID_INPUT');
        const rawEntity = params.get('entity')?.trim() || undefined;
        if (rawEntity !== undefined && rawEntity.length > 200) throw new MnemoWeaveError('INVALID_INPUT');
        const SORTS = ['newest', 'oldest', 'importance'] as const;
        const rawSort = params.get('sort')?.trim() || undefined;
        if (rawSort !== undefined && !(SORTS as readonly string[]).includes(rawSort)) throw new MnemoWeaveError('INVALID_INPUT');
        // The management page's project is a view filter, not the session scope. It selects one
        // owner; `includeGlobal=false` hides general memory from that view.
        const rawProject = params.get('projectId')?.trim() || undefined;
        if (rawProject !== undefined && rawProject.length > 200) throw new MnemoWeaveError('INVALID_INPUT');
        const rawIncludeGlobal = params.get('includeGlobal');
        if (rawIncludeGlobal !== null && rawIncludeGlobal !== 'true' && rawIncludeGlobal !== 'false') throw new MnemoWeaveError('INVALID_INPUT');
        return reply(200, await client.memories({
          ...(query === undefined ? {} : { query }), limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(rawCategory === undefined ? {} : { category: rawCategory as (typeof CATEGORIES)[number] }),
          ...(rawKnowledge === undefined ? {} : { knowledgeType: rawKnowledge as (typeof KNOWLEDGE)[number] }),
          ...(rawEntity === undefined ? {} : { entity: rawEntity }),
          ...(rawSort === undefined ? {} : { sort: rawSort as (typeof SORTS)[number] }),
          ...(rawProject === undefined ? {} : { projectId: rawProject }),
          ...(rawIncludeGlobal === null ? {} : { includeGlobal: rawIncludeGlobal === 'true' }),
        }));
      }
      const memoryMatch = /^\/v1\/memories\/([a-f0-9-]+)(?:\?revisionId=([a-f0-9-]+))?$/.exec(req.url ?? '');
      if (req.method === 'GET' && memoryMatch) return reply(200, await app.readMemory({ memoryId: memoryMatch[1], ...(memoryMatch[2] ? { revisionId: memoryMatch[2] } : {}) }));
      if (req.method === 'GET' && (req.url ?? '').startsWith('/v1/memories/graph')) {
        if (!client?.graph) throw new MnemoWeaveError('REVIEW_REQUIRED');
        const params = new URL(req.url ?? '', 'http://127.0.0.1').searchParams;
        const rawGraphLimit = params.get('limit');
        const graphLimit = rawGraphLimit === null ? 200 : Number(rawGraphLimit);
        if (!Number.isInteger(graphLimit) || graphLimit < 1 || graphLimit > 500) throw new MnemoWeaveError('INVALID_INPUT');
        const rawGraphProject = params.get('projectId')?.trim() || undefined;
        if (rawGraphProject !== undefined && rawGraphProject.length > 200) throw new MnemoWeaveError('INVALID_INPUT');
        const rawGraphGlobal = params.get('includeGlobal');
        if (rawGraphGlobal !== null && rawGraphGlobal !== 'true' && rawGraphGlobal !== 'false') throw new MnemoWeaveError('INVALID_INPUT');
        return reply(200, await client.graph(requireHost(), {
          limit: graphLimit,
          ...(rawGraphProject === undefined ? {} : { projectId: rawGraphProject }),
          ...(rawGraphGlobal === null ? {} : { includeGlobal: rawGraphGlobal === 'true' }),
        }));
      }
      if (req.method === 'POST' && req.url === '/v1/memories') {
        if (!client?.createMemory) throw new MnemoWeaveError('REVIEW_REQUIRED');
        // Creating a formal memory is a user write, like an edit: identity is required, a second
        // credential is not.
        requireHost();
        return reply(200, await client.createMemory(await readJson(req)));
      }
      if (req.method === 'POST' && req.url === '/v1/memories/explore') {
        if (!client?.explore) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.explore(requireHost(), ExploreInput.parse(await readJson(req))));
      }
      const editMatch = /^\/v1\/memories\/([a-f0-9-]+)$/.exec(req.url ?? '');
      if (req.method === 'PATCH' && editMatch) {
        if (!client) throw new MnemoWeaveError('REVIEW_REQUIRED');
        // This is a single-user deployment: the service token and the Host header are the whole
        // identity model, and a second credential for editing would only be a second copy of the
        // same secret. The caller is still identified, so the change is attributable to a host.
        requireHost();
        return reply(200, await client.editMemory(editMatch[1]!, (await readJson(req)) as { content: string; reason?: string; entryVersion: number }));
      }
      const withdrawMatch = /^\/v1\/memories\/([a-f0-9-]+)\/withdraw$/.exec(req.url ?? '');
      if (req.method === 'POST' && withdrawMatch) {
        if (!client?.withdrawMemory) throw new MnemoWeaveError('REVIEW_REQUIRED');
        // Same rule as an edit: a withdrawal is a memory write, attributed to the calling host.
        requireHost();
        return reply(200, await client.withdrawMemory(withdrawMatch[1]!, (await readJson(req)) as { reason: string; entryVersion: number }));
      }
      const conflictMatch = /^\/v1\/conflicts\/([a-f0-9-]+)$/.exec(req.url ?? '');
      if (req.method === 'GET' && conflictMatch) return reply(200, await app.readConflict({ caseId: conflictMatch[1] }));

      if (!httpRoutes.some(route => route.method === req.method && route.path === req.url)) {
        const known = httpRoutes.some(route => route.method === req.method && route.path.startsWith('/v1/memories/') && req.url?.startsWith('/v1/memories/'));
        if (!known) return reply(404, { code: 'NOT_FOUND' });
      }
      if (req.method === 'GET') throw new MnemoWeaveError('INVALID_INPUT');
      if (OPERATOR_ROUTES.has(req.url ?? '') && !isOperator) throw new MnemoWeaveError('UNAUTHORIZED');
      const input = await readJson(req);
      if (req.url?.startsWith('/v1/runtime/')) {
        if (!client) throw new MnemoWeaveError('REVIEW_REQUIRED');
        if (req.url === '/v1/runtime/pins') { client.pin(PinInput.parse(input)); return reply(200, { updated: true }); }
        if (req.url === '/v1/runtime/projects') {
          const id = (input as Record<string, unknown>)?.['projectId'];
          if (typeof id !== 'string') throw new MnemoWeaveError('INVALID_INPUT');
          client.register(id); return reply(200, { registered: true });
        }
        return reply(200, client.context(requireHost(), RuntimeContextInput.parse(withProjectHeader(req.headers, input))));
      }
      if (req.url === '/v1/review') return reply(200, await app.humanReview(input, 'local-operator'));
      if (req.url === '/v1/retry') return reply(202, await app.retryWrite(input, 'local-operator'));
      if (req.url === '/v1/conflicts/resolve') return reply(200, await app.resolveConflict(input, 'local-operator'));
      if (req.url === '/v1/versions/cancel') return reply(200, await app.cancelVersion(input, 'local-operator'));
      if (req.url === '/v1/reviews/complete') return reply(200, await app.completeReview(input, 'local-operator'));
      if (req.url === '/v1/inject' || req.url === '/v1/view') {
        if (!client) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.view(requireHost(), withProjectHeader(req.headers, input)));
      }
      if (req.url === '/v1/events') {
        if (!client) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, client.events(requireHost(), withProjectHeader(req.headers, input)));
      }
      if (req.url === '/v1/session/close') {
        if (!client) throw new MnemoWeaveError('REVIEW_REQUIRED');
        const sessionId = (input as Record<string, unknown>)?.['sessionId'];
        if (typeof sessionId !== 'string' || !sessionId.trim()) throw new MnemoWeaveError('INVALID_INPUT');
        client.closeSession(requireHost(), sessionId);
        return reply(200, { closed: true });
      }
      if (req.url === '/v1/recall') {
        // Recall reads the Provider, so it must be attributed like every other read: the service
        // token alone used to be enough here, which bypassed the visibility the View enforces.
        const hostId = requireHost();
        // With a catalog the read is scoped to what this host may see; without one there is no
        // visibility set to filter by, but the caller is still identified.
        if (client?.recall) return reply(200, await client.recall(hostId, input));
        return reply(200, await app.recall(input));
      }
      return reply(202, await app.remember(input));
    } catch (error) {
      const result = publicError(error);
      const status = statusForCode(result.code);
      process.stderr.write(`${JSON.stringify({ traceId, operation: 'http', code: result.code })}\n`);
      // A rejected token must still say who rejected it. Without this a host cannot tell a
      // token mismatch (keep the running Server, tell the user) from another program that
      // happens to answer 401 on this port (report a port conflict).
      reply(status, { ...result, ...(status === 401 ? { service: LIVE_SERVICE, protocol: LIVE_PROTOCOL } : {}), traceId });
    }
  });
}

async function readJson(req: import('node:http').IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new MnemoWeaveError('INVALID_INPUT');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length;
    if (size > REQUEST_BODY_MAX_BYTES) throw new MnemoWeaveError('INVALID_INPUT');
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new MnemoWeaveError('INVALID_INPUT'); }
}
