import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ArchiveCreate, ArchiveDistillationCreate, ArchiveEdit, ArchiveSearchInput, ArchiveSegmentInput,
  ArchiveStateInput, HostEvent, InjectRequest, MemoryCreateInput, MemoryEditInput, MemoryWithdrawInput,
  MnemoWeaveError, RuleCreate, RuleEdit, SYNC_PROTOCOL_VERSION, SessionWorkspaceInput, WorkspaceBinding,
  WorkspaceCreate, WriteTaskAction, publicError, statusForCode, openapi, ExploreInput, REQUEST_BODY_MAX_BYTES,
} from '../../../core/contracts/src/index.ts';
import type { MemoryApplication } from '../../../core/application/src/index.ts';
import type {
  ArchiveCreateInput, ArchiveEditInput, ArchiveHistoryRecordValue, ArchiveListRecord, ArchiveRecordValue,
  ArchiveReleaseCandidatesRecord, ArchiveSearchInputRecord, ArchiveSearchOutputRecord, ArchiveSegmentOutputRecord, ArchiveStateInputRecord,
  DiagnosticJobRecord, EmbeddingDiagnosticsRecord, IdleReviewPendingRecord, IdleReviewRunRecord,
  IdleReviewScanRecord, IdleReviewSignalRecord, InjectionRecord, InjectionReportRecord, RuleArchiveRecordValue,
  RuleCreateInput, RuleEditInput, RuleListRecord, RuleRecordValue, StorageStatusRecord, SyncRefreshValue,
  SyncStatusValue, WorkspaceListRecord, WorkspaceRecordValue, WriteTaskReceiptRecord,
} from '../../../core/contracts/src/index.ts';

/** Liveness identity: hosts require these fields before trusting the address as MnemoWeave. */
export const LIVE_SERVICE = 'mnemoweave';
export const LIVE_PROTOCOL = 2;

/** Single source of truth for the served routes; the OpenAPI document must mirror this list. */
export const httpRoutes: ReadonlyArray<{ method: 'GET' | 'POST' | 'PATCH' | 'PUT'; path: string }> = [
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
  { method: 'GET', path: '/v1/candidates/{candidateId}' },
  { method: 'GET', path: '/v1/memories' },
  { method: 'POST', path: '/v1/memories' },
  { method: 'GET', path: '/v1/memories/{memoryId}' },
  { method: 'GET', path: '/v1/memories/graph' },
  { method: 'POST', path: '/v1/memories/explore' },
  { method: 'POST', path: '/v1/memories/related' },
  { method: 'GET', path: '/v1/conflicts/{caseId}' },
  { method: 'POST', path: '/v1/recall' },
  { method: 'POST', path: '/v1/inject' },
  { method: 'POST', path: '/v1/events' },
  { method: 'POST', path: '/v1/session/close' },
  { method: 'POST', path: '/v1/remember' },
  { method: 'POST', path: '/v1/review' },
  { method: 'POST', path: '/v1/retry' },
  { method: 'POST', path: '/v1/conflicts/resolve' },
  { method: 'POST', path: '/v1/versions/cancel' },
  { method: 'PATCH', path: '/v1/memories/{memoryId}' },
  { method: 'POST', path: '/v1/memories/{memoryId}/withdraw' },
  { method: 'GET', path: '/v1/sync/status' },
  { method: 'POST', path: '/v1/sync/refresh' },
  { method: 'GET', path: '/v1/injections/latest' },
  { method: 'GET', path: '/v1/rules' },
  { method: 'POST', path: '/v1/rules' },
  { method: 'PATCH', path: '/v1/rules/{ruleId}' },
  { method: 'GET', path: '/v1/rules/archive' },
  { method: 'GET', path: '/v1/workspaces' },
  { method: 'POST', path: '/v1/workspaces' },
  { method: 'PUT', path: '/v1/workspaces/{workspaceId}/binding' },
  { method: 'PUT', path: '/v1/sessions/{sessionId}/workspace' },
  { method: 'GET', path: '/v1/archives' },
  { method: 'POST', path: '/v1/archives' },
  { method: 'PATCH', path: '/v1/archives/{entryId}' },
  { method: 'POST', path: '/v1/archives/{entryId}/state' },
  { method: 'GET', path: '/v1/archives/{entryId}/history' },
  { method: 'GET', path: '/v1/archives/{entryId}/content' },
  { method: 'GET', path: '/v1/archives/search' },
  { method: 'GET', path: '/v1/archives/release-candidates' },
  { method: 'POST', path: '/v1/memory-write-tasks/{taskId}/actions/{index}' },
  { method: 'GET', path: '/v1/memory-write-tasks/{taskId}/actions/{index}' },
  { method: 'POST', path: '/v1/archive-distillations' },
  { method: 'GET', path: '/v1/archive-distillations/{draftId}' },
];

export { statusForCode };

/**
 * Everything a Host client reaches over HTTP. Hosts authenticate with the service token and name
 * themselves through `x-mnemoweave-host`; there is no local replica and no pairing.
 */
/**
 * Identity of one model-facing read. A host reads it from the tool execution context and sends it
 * as headers; the model body never carries it. The Server checks that the session exists and that
 * the turn is not marked "do not retain" before it spends any per-turn budget.
 */
export interface TurnIdentity {
  sessionId: string;
  turnId: string;
  agentId: string;
}

export interface ClientHttpEndpoints {
  inject(hostId: string, input: unknown): Promise<InjectionRecord>;
  lastInjection?(hostId?: string, sessionId?: string): Promise<InjectionReportRecord | null>;
  closeSession(hostId: string, sessionId: string): void;
  events(hostId: string, input: unknown): { status: 'stored' | 'replayed' | 'skipped'; eventId: string };
  memories(query: {
    query?: string; limit: number; cursor?: string;
    category?: 'preference' | 'decision' | 'fact' | 'insight' | 'context' | 'general';
    entity?: string;
    sort?: 'newest' | 'oldest' | 'importance';
  }): Promise<import('../../../core/contracts/src/index.ts').MemoryListRecord>;
  createMemory?(input: unknown): Promise<import('../../../core/contracts/src/index.ts').MemoryCreateRecord>;
  embeddingDiagnostics?(hostId: string): Promise<EmbeddingDiagnosticsRecord>;
  embeddingBackfill?(hostId: string): Promise<DiagnosticJobRecord>;
  idleReviewScan?(hostId: string, input: unknown): Promise<IdleReviewScanRecord>;
  idleReviewSignals?(hostId: string, sessionId: string): Promise<{ items: IdleReviewSignalRecord[] }>;
  idleReviewRunStart?(hostId: string, input: unknown): Promise<{ run: IdleReviewRunRecord; signals: IdleReviewSignalRecord[] }>;
  idleReviewRuns?(hostId: string, sessionId: string): Promise<{ items: IdleReviewRunRecord[] }>;
  idleReviewRunItem?(hostId: string, runId: string, input: unknown): Promise<IdleReviewRunRecord>;
  idleReviewRunFinish?(hostId: string, runId: string, input: unknown): Promise<IdleReviewRunRecord>;
  idleReviewPending?(hostId: string): Promise<IdleReviewPendingRecord>;
  graph?(hostId: string, query: { limit: number }): Promise<import('../../../core/contracts/src/index.ts').MemoryGraphRecord>;
  recall?(hostId: string, input: unknown, turn?: TurnIdentity): Promise<import('../../../core/contracts/src/index.ts').RecallResult>;
  related?(hostId: string, input: unknown, turn?: TurnIdentity): Promise<{ memories: Array<{ memoryId: string; content: string; excerpt: boolean }>; truncated: boolean }>;
  explore?(hostId: string, input: { query: string; limit: number; minScore?: number | undefined; hint?: string | undefined }, turn?: TurnIdentity): Promise<{ query: string; hits: Array<Record<string, unknown>>; unregistered: number; truncated: boolean }>;
  editMemory(memoryId: string, input: { content: string; reason?: string | undefined; entryVersion: number; category?: string | undefined; importance?: number | undefined; tags?: string[] | undefined; entities?: string[] | undefined }): Promise<import('../../../core/contracts/src/index.ts').MemoryEditRecord>;
  withdrawMemory?(memoryId: string, input: { reason: string; entryVersion: number }): Promise<{ memoryId: string; revisionId: string; entryVersion: number; withdrawnAt: string }>;
  syncStatus?(): Promise<SyncStatusValue>;
  syncRefresh?(): Promise<SyncRefreshValue>;
  rules?(query: Record<string, never>): Promise<RuleListRecord>;
  ruleArchive?(): Promise<{ items: RuleArchiveRecordValue[] }>;
  workspaces?(caller: { hostId: string; operator: boolean }): Promise<WorkspaceListRecord>;
  registerWorkspace?(input: { workspaceId: string; name: string }, operator: boolean): Promise<WorkspaceRecordValue>;
  bindWorkspace?(workspaceId: string, rootPath: string): Promise<WorkspaceRecordValue>;
  bindSession?(hostId: string, sessionId: string, input: { rootPath?: string | undefined; workspaceId?: string | undefined }): Promise<{ sessionId: string; workspaceId: string | null; boundAt: string }>;
  archives?(query: { workspaceId?: string; includeWithdrawn?: boolean; limit?: number; cursor?: string }): Promise<ArchiveListRecord>;
  archiveReleaseCandidates?(workspaceId: string | undefined, limit: number | undefined): Promise<ArchiveReleaseCandidatesRecord>;
  searchArchives?(hostId: string, input: ArchiveSearchInputRecord): Promise<{ query: string; total: number; results: Array<Record<string, unknown>>; totalChars: number; truncated: boolean; totalLimitChars: number; callsLimit: number }>;
  archiveHistory?(entryId: string): Promise<{ entryId: string; items: ArchiveHistoryRecordValue[] }>;
  archiveSegment?(hostId: string, entryId: string, cursor: string | undefined, turn: TurnIdentity | undefined): Promise<ArchiveSegmentOutputRecord>;
  searchArchivesForTurn?(hostId: string, input: { query: string; limit?: number | undefined; includeArchived?: boolean | undefined }, turn: TurnIdentity): Promise<{ query: string; total: number; results: Array<Record<string, unknown>>; totalChars: number; truncated: boolean; totalLimitChars: number; callsLimit: number }>;
  sessionWorkspace?(hostId: string, sessionId: string): string | null;
  editArchiveState?(entryId: string, input: ArchiveStateInputRecord): Promise<ArchiveRecordValue>;
  createRule?(input: RuleCreateInput): Promise<RuleRecordValue>;
  editRule?(ruleId: string, input: RuleEditInput): Promise<RuleRecordValue>;
  editArchive?(entryId: string, input: ArchiveEditInput): Promise<ArchiveRecordValue>;
  createArchive?(input: ArchiveCreateInput): Promise<ArchiveRecordValue>;
  writeTaskAction?(hostId: string, taskId: string, index: number, input: unknown): Promise<WriteTaskReceiptRecord>;
  writeTaskReceipt?(hostId: string, taskId: string, index: number): Promise<WriteTaskReceiptRecord>;
  createDistillation?(hostId: string, input: unknown): Promise<import('../../../core/contracts/src/index.ts').ArchiveDistillationRecordValue>;
  readDistillation?(hostId: string, draftId: string): Promise<import('../../../core/contracts/src/index.ts').ArchiveDistillationRecordValue>;
}

const OPERATOR_ROUTES = new Set(['/v1/review', '/v1/retry', '/v1/conflicts/resolve', '/v1/versions/cancel']);

export function createHttpServer(app: MemoryApplication, token: string, operatorToken?: string, client?: ClientHttpEndpoints, storage?: () => StorageStatusRecord) {
  if (token.length < 24) throw new Error('MNEMOWEAVE_TOKEN must contain at least 24 characters');
  if (operatorToken !== undefined && (operatorToken.length < 24 || operatorToken === token)) throw new Error('Independent operator token required');
  const expected = Buffer.from(`Bearer ${token}`);
  const operatorExpected = operatorToken ? Buffer.from(`Bearer ${operatorToken}`) : undefined;
  /**
   * Two identities exist: the service token plus a declared Host header (what a host plugin
   * uses), and an operator token for management routes that do not belong to a host — review,
   * conflicts, workspace registration and root binding.
   *
   * Memory and rule writes are user writes: they require an identity but no second credential.
   */
  return createServer(async (req, res) => {
    const traceId = randomUUID();
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-trace-id': traceId });
      res.end(JSON.stringify(value));
    };
    const url = new URL(req.url ?? '/', 'http://local.invalid');
    const path = url.pathname;
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
      /** A host identifies itself; management reads may also run as the operator. */
      const callerHost = (): string => (isOperator ? 'operator' : requireHost());
      /**
       * A model-facing read must carry the session and turn the host tool ran in. Without them a
       * budget cannot be attributed, so the call is refused instead of falling back to a
       * management-size allowance.
       */
      /** A turn identity if the host supplied a complete one; a partial one is refused. */
      const optionalTurn = (): TurnIdentity | undefined => {
        const sessionId = String(req.headers['x-mnemoweave-session-id'] ?? '').trim();
        const turnId = String(req.headers['x-mnemoweave-turn-id'] ?? '').trim();
        if (sessionId === '' && turnId === '') return undefined;
        return requireTurn();
      };
      const requireTurn = (): TurnIdentity => {
        requireHost();
        const sessionId = String(req.headers['x-mnemoweave-session-id'] ?? '').trim();
        const turnId = String(req.headers['x-mnemoweave-turn-id'] ?? '').trim();
        const agentId = String(req.headers['x-mnemoweave-agent-id'] ?? '').trim() || 'default';
        if (sessionId === '' || turnId === '' || sessionId.length > 256 || turnId.length > 256) throw new MnemoWeaveError('UNAUTHORIZED');
        return { sessionId, turnId, agentId };
      };

      // Liveness and readiness. A rejected token still names this service, so a host can tell a
      // token mismatch (keep the running Server) from another program on the port (report a
      // conflict) without probing anything else.
      if (req.method === 'GET' && path === '/health/live') return reply(200, { live: true, service: LIVE_SERVICE, protocol: LIVE_PROTOCOL });
      if (req.method === 'GET' && path === '/health/ready') return reply(200, await app.health());
      if (req.method === 'GET' && path === '/openapi.json') return reply(200, openapi);
      if (req.method === 'GET' && path === '/v1/storage') {
        if (!storage) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, storage());
      }

      // ── Workspaces ──
      if (req.method === 'GET' && path === '/v1/workspaces') {
        if (!client?.workspaces) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.workspaces({ hostId: callerHost(), operator: isOperator }));
      }
      if (req.method === 'POST' && path === '/v1/workspaces') {
        if (!isOperator) throw new MnemoWeaveError('UNAUTHORIZED');
        if (!client?.registerWorkspace) throw new MnemoWeaveError('REVIEW_REQUIRED');
        const input = WorkspaceCreate.parse(await readJson(req));
        return reply(201, await client.registerWorkspace(input, true));
      }
      const bindingMatch = /^\/v1\/workspaces\/([a-f0-9-]{36})\/binding$/.exec(path);
      if (req.method === 'PUT' && bindingMatch) {
        if (!isOperator) throw new MnemoWeaveError('UNAUTHORIZED');
        if (!client?.bindWorkspace) throw new MnemoWeaveError('REVIEW_REQUIRED');
        const input = WorkspaceBinding.parse(await readJson(req));
        return reply(200, await client.bindWorkspace(bindingMatch[1]!, input.rootPath));
      }
      const sessionWorkspaceMatch = /^\/v1\/sessions\/([^/]{1,256})\/workspace$/.exec(path);
      if (req.method === 'PUT' && sessionWorkspaceMatch) {
        if (!client?.bindSession) throw new MnemoWeaveError('REVIEW_REQUIRED');
        const hostId = requireHost();
        const sessionId = decodeURIComponent(sessionWorkspaceMatch[1]!);
        const input = SessionWorkspaceInput.parse(await readJson(req));
        return reply(200, await client.bindSession(hostId, sessionId, input));
      }

      // ── Injection ──
      if (req.method === 'POST' && path === '/v1/inject') {
        if (!client) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.inject(requireHost(), InjectRequest.parse(await readJson(req))));
      }
      if (req.method === 'GET' && path === '/v1/injections/latest') {
        if (!client?.lastInjection) throw new MnemoWeaveError('REVIEW_REQUIRED');
        const sessionId = url.searchParams.get('sessionId')?.trim() || undefined;
        if (sessionId !== undefined && sessionId.length > 200) throw new MnemoWeaveError('INVALID_INPUT');
        const report = await client.lastInjection(isOperator ? undefined : requireHost(), sessionId);
        if (!report) throw new MnemoWeaveError('NOT_FOUND');
        return reply(200, report);
      }

      // ── Rules ──
      if (req.method === 'GET' && path === '/v1/rules') {
        if (!client?.rules) throw new MnemoWeaveError('REVIEW_REQUIRED');
        callerHost();
        return reply(200, await client.rules({}));
      }
      if (req.method === 'GET' && path === '/v1/rules/archive') {
        callerHost();
        if (!client?.ruleArchive) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.ruleArchive());
      }
      if (req.method === 'POST' && path === '/v1/rules') {
        callerHost();
        if (!client?.createRule) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(201, await client.createRule(RuleCreate.parse(await readJson(req))));
      }
      const ruleMatch = /^\/v1\/rules\/([a-f0-9-]{36})$/.exec(path);
      if (req.method === 'PATCH' && ruleMatch) {
        callerHost();
        if (!client?.editRule) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.editRule(ruleMatch[1]!, RuleEdit.parse(await readJson(req))));
      }

      // ── Archives ──
      if (req.method === 'GET' && path === '/v1/archives/search') {
        if (!client?.searchArchives) throw new MnemoWeaveError('REVIEW_REQUIRED');
        const hostId = callerHost();
        const raw = {
          workspaceId: url.searchParams.get('workspaceId') ?? '',
          query: url.searchParams.get('query') ?? url.searchParams.get('q') ?? '',
          ...(url.searchParams.get('limit') === null ? {} : { limit: Number(url.searchParams.get('limit')) }),
          includeArchived: url.searchParams.get('includeArchived') === 'true',
        };
        return reply(200, await client.searchArchives(hostId, ArchiveSearchInput.parse(raw)));
      }
      if (req.method === 'GET' && path === '/v1/archives/release-candidates') {
        if (!client?.archives) throw new MnemoWeaveError('REVIEW_REQUIRED');
        if (!client.archiveReleaseCandidates) throw new MnemoWeaveError('REVIEW_REQUIRED');
        const workspaceId = url.searchParams.get('workspaceId')?.trim() || undefined;
        if (workspaceId === undefined) throw new MnemoWeaveError('WORKSPACE_REQUIRED');
        if (!/^[a-f0-9-]{36}$/.test(workspaceId)) throw new MnemoWeaveError('INVALID_INPUT');
        const rawLimit = url.searchParams.get('limit');
        const limit = rawLimit === null ? undefined : Number(rawLimit);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) throw new MnemoWeaveError('INVALID_INPUT');
        return reply(200, await client.archiveReleaseCandidates(workspaceId, limit));
      }
      if (req.method === 'GET' && path === '/v1/archives') {
        if (!client?.archives) throw new MnemoWeaveError('REVIEW_REQUIRED');
        callerHost();
        const workspaceId = url.searchParams.get('workspaceId')?.trim() || undefined;
        // The archive route family is always bounded to one workspace. Requesting the whole
        // store would return text the caller has no workspace claim to.
        if (workspaceId === undefined) throw new MnemoWeaveError('WORKSPACE_REQUIRED');
        if (!/^[a-f0-9-]{36}$/.test(workspaceId)) throw new MnemoWeaveError('INVALID_INPUT');
        const rawWithdrawn = url.searchParams.get('includeWithdrawn');
        if (rawWithdrawn !== null && rawWithdrawn !== 'true' && rawWithdrawn !== 'false') throw new MnemoWeaveError('INVALID_INPUT');
        const limit = url.searchParams.get('limit');
        const cursor = url.searchParams.get('cursor') ?? undefined;
        return reply(200, await client.archives({
          ...(workspaceId === undefined ? {} : { workspaceId }),
          includeWithdrawn: rawWithdrawn === 'true',
          ...(limit === null ? {} : { limit: Number(limit) }),
          ...(cursor === undefined ? {} : { cursor }),
        }));
      }
      if (req.method === 'POST' && path === '/v1/archives') {
        callerHost();
        if (!client?.createArchive) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(201, await client.createArchive(ArchiveCreate.parse(await readJson(req))));
      }
      const archiveMatch = /^\/v1\/archives\/([a-f0-9-]{36})$/.exec(path);
      if (req.method === 'PATCH' && archiveMatch) {
        callerHost();
        if (!client?.editArchive) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.editArchive(archiveMatch[1]!, ArchiveEdit.parse(await readJson(req))));
      }
      const archiveStateMatch = /^\/v1\/archives\/([a-f0-9-]{36})\/state$/.exec(path);
      if (req.method === 'POST' && archiveStateMatch) {
        callerHost();
        if (!client?.editArchiveState) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.editArchiveState(archiveStateMatch[1]!, ArchiveStateInput.parse(await readJson(req))));
      }
      const archiveHistoryMatch = /^\/v1\/archives\/([a-f0-9-]{36})\/history$/.exec(path);
      if (req.method === 'GET' && archiveHistoryMatch) {
        callerHost();
        if (!client?.archiveHistory) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.archiveHistory(archiveHistoryMatch[1]!));
      }
      const archiveContentMatch = /^\/v1\/archives\/([a-f0-9-]{36})\/content$/.exec(path);
      if (req.method === 'GET' && archiveContentMatch) {
        if (!client?.archiveSegment) throw new MnemoWeaveError('REVIEW_REQUIRED');
        const hostId = requireHost();
        const parsed = ArchiveSegmentInput.parse({ entryId: archiveContentMatch[1]!, ...(url.searchParams.get('cursor') === null ? {} : { cursor: url.searchParams.get('cursor')! }) });
        const turn = requireTurn();
        return reply(200, await client.archiveSegment(hostId, parsed.entryId, parsed.cursor, turn));
      }

      // ── Authorized write tasks and distillations ──
      const writeTaskMatch = /^\/v1\/memory-write-tasks\/([a-f0-9-]{36})\/actions\/(\d{1,3})$/.exec(path);
      if (writeTaskMatch) {
        const hostId = requireHost();
        const taskId = writeTaskMatch[1]!;
        const index = Number(writeTaskMatch[2]);
        if (req.method === 'POST') {
          if (!client?.writeTaskAction) throw new MnemoWeaveError('REVIEW_REQUIRED');
          return reply(200, await client.writeTaskAction(hostId, taskId, index, WriteTaskAction.parse(await readJson(req))));
        }
        if (req.method === 'GET') {
          if (!client?.writeTaskReceipt) throw new MnemoWeaveError('REVIEW_REQUIRED');
          return reply(200, await client.writeTaskReceipt(hostId, taskId, index));
        }
      }
      if (req.method === 'POST' && path === '/v1/archive-distillations') {
        if (!client?.createDistillation) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(201, await client.createDistillation(requireHost(), ArchiveDistillationCreate.parse(await readJson(req))));
      }
      const distillationMatch = /^\/v1\/archive-distillations\/([a-f0-9-]{36})$/.exec(path);
      if (req.method === 'GET' && distillationMatch) {
        if (!client?.readDistillation) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.readDistillation(requireHost(), distillationMatch[1]!));
      }

      // ── Formal memories ──
      if (req.method === 'GET' && path === '/v1/memories') {
        if (!client) throw new MnemoWeaveError('REVIEW_REQUIRED');
        callerHost();
        const query = url.searchParams.get('query')?.trim() || undefined;
        const rawLimit = url.searchParams.get('limit');
        const limit = rawLimit === null ? 50 : Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200 || (query !== undefined && query.length > 500)) throw new MnemoWeaveError('INVALID_INPUT');
        const cursor = url.searchParams.get('cursor')?.trim() || undefined;
        if (cursor !== undefined && cursor.length > 500) throw new MnemoWeaveError('INVALID_INPUT');
        const CATEGORIES = ['preference', 'decision', 'fact', 'insight', 'context', 'general'] as const;
        const rawCategory = url.searchParams.get('category')?.trim() || undefined;
        if (rawCategory !== undefined && !(CATEGORIES as readonly string[]).includes(rawCategory)) throw new MnemoWeaveError('INVALID_INPUT');
        // The knowledge-type filter was removed with its domain; a stale client is refused
        // instead of reading a silently unfiltered set.
        if (url.searchParams.get('knowledgeType') !== null) throw new MnemoWeaveError('INVALID_INPUT');
        const rawEntity = url.searchParams.get('entity')?.trim() || undefined;
        if (rawEntity !== undefined && rawEntity.length > 200) throw new MnemoWeaveError('INVALID_INPUT');
        const SORTS = ['newest', 'oldest', 'importance'] as const;
        const rawSort = url.searchParams.get('sort')?.trim() || undefined;
        if (rawSort !== undefined && !(SORTS as readonly string[]).includes(rawSort)) throw new MnemoWeaveError('INVALID_INPUT');
        // Removed fields are refused instead of ignored: a client that still sends a workspace
        // filter would otherwise read a silently different set and believe it was filtered.
        if (url.searchParams.get('projectId') !== null || url.searchParams.get('includeGlobal') !== null || url.searchParams.get('workspaceId') !== null) throw new MnemoWeaveError('INVALID_INPUT');
        return reply(200, await client.memories({
          ...(query === undefined ? {} : { query }), limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(rawCategory === undefined ? {} : { category: rawCategory as (typeof CATEGORIES)[number] }),
          ...(rawEntity === undefined ? {} : { entity: rawEntity }),
          ...(rawSort === undefined ? {} : { sort: rawSort as (typeof SORTS)[number] }),
        }));
      }
      const memoryMatch = /^\/v1\/memories\/([a-f0-9-]+)(?:\?revisionId=([a-f0-9-]+))?$/.exec(req.url ?? '');
      if (req.method === 'GET' && memoryMatch) return reply(200, await app.readMemory({ memoryId: memoryMatch[1], ...(memoryMatch[2] ? { revisionId: memoryMatch[2] } : {}) }));
      if (req.method === 'GET' && path === '/v1/memories/graph') {
        if (!client?.graph) throw new MnemoWeaveError('REVIEW_REQUIRED');
        const rawGraphLimit = url.searchParams.get('limit');
        const graphLimit = rawGraphLimit === null ? 200 : Number(rawGraphLimit);
        if (!Number.isInteger(graphLimit) || graphLimit < 1 || graphLimit > 500) throw new MnemoWeaveError('INVALID_INPUT');
        if (url.searchParams.get('projectId') !== null || url.searchParams.get('includeGlobal') !== null) throw new MnemoWeaveError('INVALID_INPUT');
        return reply(200, await client.graph(callerHost(), { limit: graphLimit }));
      }
      if (req.method === 'POST' && path === '/v1/memories') {
        if (!client?.createMemory) throw new MnemoWeaveError('REVIEW_REQUIRED');
        requireHost();
        return reply(200, await client.createMemory(MemoryCreateInput.parse(await readJson(req))));
      }
      if (req.method === 'POST' && path === '/v1/memories/explore') {
        if (!client?.explore) throw new MnemoWeaveError('REVIEW_REQUIRED');
        const input = ExploreInput.parse(await readJson(req));
        // Explore serves both the model tool and the management search box. A turn identity, when
        // the host supplies one, makes it a model read and charges the per-turn budget; without
        // one it stays a management read bounded by the administrative limit.
        const hostId = requireHost();
        const turn = optionalTurn();
        return reply(200, await client.explore(hostId, input, turn));
      }
      if (req.method === 'POST' && path === '/v1/memories/related') {
        if (!client?.related) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.related(requireHost(), await readJson(req), requireTurn()));
      }
      const editMatch = /^\/v1\/memories\/([a-f0-9-]+)$/.exec(path);
      if (req.method === 'PATCH' && editMatch) {
        if (!client) throw new MnemoWeaveError('REVIEW_REQUIRED');
        requireHost();
        return reply(200, await client.editMemory(editMatch[1]!, MemoryEditInput.parse(await readJson(req))));
      }
      const withdrawMatch = /^\/v1\/memories\/([a-f0-9-]+)\/withdraw$/.exec(path);
      if (req.method === 'POST' && withdrawMatch) {
        if (!client?.withdrawMemory) throw new MnemoWeaveError('REVIEW_REQUIRED');
        requireHost();
        return reply(200, await client.withdrawMemory(withdrawMatch[1]!, MemoryWithdrawInput.parse(await readJson(req))));
      }
      if (req.method === 'POST' && path === '/v1/recall') {
        const hostId = requireHost();
        // A turn identity marks a model call and is charged against the per-turn budget. Without
        // one this is the administrative recall the doc bounds to 50 entries; a partial identity
        // is refused rather than treated as administrative, because it claims a turn it cannot name.
        const turn = optionalTurn();
        if (client?.recall) return reply(200, await client.recall(hostId, await readJson(req), turn));
        return reply(200, await app.recall(await readJson(req)));
      }
      if (req.method === 'POST' && path === '/v1/remember') {
        requireHost();
        return reply(202, await app.remember(await readJson(req)));
      }
      const candidateMatch = /^\/v1\/candidates\/([a-f0-9-]+)$/.exec(path);
      if (req.method === 'GET' && candidateMatch) return reply(200, await app.candidateStatus({ candidateId: candidateMatch[1] }));
      const conflictMatch = /^\/v1\/conflicts\/([a-f0-9-]+)$/.exec(path);
      if (req.method === 'GET' && conflictMatch) return reply(200, await app.readConflict({ caseId: conflictMatch[1] }));

      // ── Events, sessions, idle review ──
      if (req.method === 'POST' && path === '/v1/events') {
        if (!client) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, client.events(requireHost(), HostEvent.parse(await readJson(req))));
      }
      if (req.method === 'POST' && path === '/v1/session/close') {
        if (!client) throw new MnemoWeaveError('REVIEW_REQUIRED');
        const input = await readJson(req) as { sessionId?: unknown };
        if (typeof input.sessionId !== 'string' || !input.sessionId.trim()) throw new MnemoWeaveError('INVALID_INPUT');
        client.closeSession(requireHost(), input.sessionId);
        return reply(200, { closed: true });
      }
      if (req.method === 'POST' && path === '/v1/idle-review/scan') {
        if (!client?.idleReviewScan) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.idleReviewScan(requireHost(), await readJson(req)));
      }
      if (req.method === 'GET' && path === '/v1/idle-review/signals') {
        if (!client?.idleReviewSignals) throw new MnemoWeaveError('REVIEW_REQUIRED');
        const sessionId = url.searchParams.get('sessionId')?.trim() ?? '';
        if (sessionId === '' || sessionId.length > 256) throw new MnemoWeaveError('INVALID_INPUT');
        return reply(200, await client.idleReviewSignals(requireHost(), sessionId));
      }
      if (req.method === 'POST' && path === '/v1/idle-review/runs') {
        if (!client?.idleReviewRunStart) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(201, await client.idleReviewRunStart(requireHost(), await readJson(req)));
      }
      if (req.method === 'GET' && path === '/v1/idle-review/runs') {
        if (!client?.idleReviewRuns) throw new MnemoWeaveError('REVIEW_REQUIRED');
        const sessionId = url.searchParams.get('sessionId')?.trim() ?? '';
        if (sessionId === '' || sessionId.length > 256) throw new MnemoWeaveError('INVALID_INPUT');
        return reply(200, await client.idleReviewRuns(requireHost(), sessionId));
      }
      if (req.method === 'GET' && path === '/v1/idle-review/pending') {
        if (!client?.idleReviewPending) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.idleReviewPending(requireHost()));
      }
      const idleRunItem = /^\/v1\/idle-review\/runs\/([a-f0-9-]{36})\/items$/.exec(path);
      if (req.method === 'POST' && idleRunItem) {
        if (!client?.idleReviewRunItem) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.idleReviewRunItem(requireHost(), idleRunItem[1]!, await readJson(req)));
      }
      const idleRunFinish = /^\/v1\/idle-review\/runs\/([a-f0-9-]{36})\/finish$/.exec(path);
      if (req.method === 'POST' && idleRunFinish) {
        if (!client?.idleReviewRunFinish) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.idleReviewRunFinish(requireHost(), idleRunFinish[1]!, await readJson(req)));
      }

      // ── Diagnostics ──
      if (req.method === 'GET' && path === '/v1/diagnostics/embeddings') {
        if (!client?.embeddingDiagnostics) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.embeddingDiagnostics(requireHost()));
      }
      if (req.method === 'POST' && path === '/v1/diagnostics/embeddings/backfill') {
        if (!client?.embeddingBackfill) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(202, await client.embeddingBackfill(requireHost()));
      }
      if (req.method === 'GET' && path === '/v1/sync/status') {
        if (!isOperator) requireHost();
        if (!client?.syncStatus) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.syncStatus());
      }
      if (req.method === 'POST' && path === '/v1/sync/refresh') {
        if (!isOperator) requireHost();
        if (!client?.syncRefresh) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.syncRefresh());
      }

      // ── Operator governance ──
      if (req.method === 'POST' && OPERATOR_ROUTES.has(path)) {
        if (!isOperator) throw new MnemoWeaveError('UNAUTHORIZED');
        const input = await readJson(req);
        if (path === '/v1/review') return reply(200, await app.humanReview(input, 'local-operator'));
        if (path === '/v1/retry') return reply(202, await app.retryWrite(input, 'local-operator'));
        if (path === '/v1/conflicts/resolve') return reply(200, await app.resolveConflict(input, 'local-operator'));
        if (path === '/v1/versions/cancel') return reply(200, await app.cancelVersion(input, 'local-operator'));
        throw new MnemoWeaveError('NOT_FOUND');
      }
      return reply(404, { code: 'NOT_FOUND', traceId });
    } catch (error) {
      const result = publicError(error);
      const status = statusForCode(result.code);
      process.stderr.write(`${JSON.stringify({ traceId, operation: 'http', code: result.code, protocol: SYNC_PROTOCOL_VERSION })}\n`);
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
