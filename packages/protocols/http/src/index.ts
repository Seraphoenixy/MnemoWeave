import { PinInput, RuntimeContextInput, RuleCreate, RuleEdit } from '../../../core/contracts/src/index.ts';
import type { MemoryListRecord, MemoryEditRecord, RuntimeContext, PinRecord } from '../../../core/contracts/src/index.ts';
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { MemoryApplication } from '../../../core/application/src/index.ts';
import { MnemoWeaveError, openapi, publicError, statusForCode } from '../../../core/contracts/src/index.ts';
import type { ArchiveCreateInput, ArchiveListRecord, ArchiveRecordValue, InjectionReportRecord, RuleCreateInput, RuleEditInput, RuleListRecord, RuleRecordValue, StorageStatusRecord, SyncRefreshValue, SyncStatusValue, ViewRecord } from '../../../core/contracts/src/index.ts';

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
  { method: 'GET', path: '/v1/reviews/due' },
  { method: 'GET', path: '/v1/candidates/{candidateId}' },
  { method: 'GET', path: '/v1/memories' },
  { method: 'GET', path: '/v1/memories/{memoryId}' },
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
  { method: 'GET', path: '/v1/sync/status' },
  { method: 'POST', path: '/v1/sync/refresh' },
  { method: 'GET', path: '/v1/injections/latest' },
  { method: 'GET', path: '/v1/rules' },
  { method: 'POST', path: '/v1/rules' },
  { method: 'PATCH', path: '/v1/rules/{ruleId}' },
  { method: 'GET', path: '/v1/archives' },
  { method: 'POST', path: '/v1/archives' },
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
  memories(query: { query?: string; limit: number }): Promise<MemoryListRecord>;
  editMemory(memoryId: string, input: { content: string; reason?: string; entryVersion: number }): Promise<MemoryEditRecord>;
  /** Operator diagnostics; absent when sync is not configured. */
  syncStatus?(): Promise<SyncStatusValue>;
  syncRefresh?(): Promise<SyncRefreshValue>;
  /** Last injection result, or null before any injection happened. */
  lastInjection?(hostId?: string, sessionId?: string): Promise<InjectionReportRecord | null>;
  rules?(query: { scope: 'global' | 'project' | 'all'; projectId?: string }): Promise<RuleListRecord>;
  archives?(query: { projectId?: string; includeWithdrawn?: boolean }): Promise<ArchiveListRecord>;
  createRule?(input: RuleCreateInput): Promise<RuleRecordValue>;
  editRule?(ruleId: string, input: RuleEditInput): Promise<RuleRecordValue>;
  createArchive?(input: ArchiveCreateInput): Promise<ArchiveRecordValue>;
}

const OPERATOR_ROUTES = new Set(['/v1/review', '/v1/retry', '/v1/conflicts/resolve', '/v1/versions/cancel', '/v1/reviews/complete', '/v1/runtime/pins', '/v1/runtime/projects', '/v1/reviews/due']);

export function createHttpServer(app: MemoryApplication, token: string, operatorToken?: string, client?: ClientHttpEndpoints, storage?: () => StorageStatusRecord) {
  if (token.length < 24) throw new Error('MNEMOWEAVE_TOKEN must contain at least 24 characters');
  if (operatorToken !== undefined && (operatorToken.length < 24 || operatorToken === token)) throw new Error('Independent operator token required');
  const expected = Buffer.from(`Bearer ${token}`);
  const operatorExpected = operatorToken ? Buffer.from(`Bearer ${operatorToken}`) : undefined;
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

      if (req.method === 'GET' && req.url === '/health/live') return reply(200, { live: true });
      if (req.method === 'GET' && req.url === '/health/ready') return reply(200, await app.health());
      if (req.method === 'GET' && req.url === '/openapi.json') return reply(200, openapi);
      if (req.method === 'GET' && req.url === '/v1/storage') {
        if (!storage) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, storage());
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
        const params = new URL(req.url, 'http://localhost').searchParams;
        const scope = params.get('scope') ?? (isOperator ? 'global' : 'all');
        if (scope !== 'global' && scope !== 'project' && scope !== 'all') throw new MnemoWeaveError('INVALID_INPUT');
        const projectId = params.get('projectId')?.trim() || undefined;
        if (scope === 'project' && !projectId) throw new MnemoWeaveError('INVALID_INPUT');
        // An operator may narrow by scope or project; a host reads every rule.
        if (!isOperator) requireHost();
        return reply(200, await client.rules({ scope, ...(projectId ? { projectId } : {}) }));
      }
      if (req.method === 'POST' && req.url === '/v1/rules') {
        if (!isOperator) throw new MnemoWeaveError('UNAUTHORIZED');
        if (!client?.createRule) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(201, await client.createRule(RuleCreate.parse(await readJson(req))));
      }
      const ruleMatch = /^\/v1\/rules\/([a-f0-9-]+)$/.exec(req.url ?? '');
      if (req.method === 'PATCH' && ruleMatch) {
        if (!isOperator) throw new MnemoWeaveError('UNAUTHORIZED');
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
        return reply(200, await client.archives({ ...(projectId ? { projectId } : {}), includeWithdrawn: rawWithdrawn === 'true' }));
      }
      if (req.method === 'POST' && req.url === '/v1/archives') {
        if (!isOperator) throw new MnemoWeaveError('UNAUTHORIZED');
        if (!client?.createArchive) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(201, await client.createArchive(await readJson(req) as ArchiveCreateInput));
      }
      if (req.method === 'GET' && req.url === '/v1/reviews/due') {
        if (!isOperator) throw new MnemoWeaveError('UNAUTHORIZED');
        return reply(200, await app.reviewDue());
      }
      const candidateMatch = /^\/v1\/candidates\/([a-f0-9-]+)$/.exec(req.url ?? '');
      if (req.method === 'GET' && candidateMatch) return reply(200, await app.candidateStatus({ candidateId: candidateMatch[1] }));
      if (req.method === 'GET' && req.url !== undefined && req.url.startsWith('/v1/memories?')) {
        if (!client) throw new MnemoWeaveError('REVIEW_REQUIRED');
        const params = new URL(req.url, 'http://localhost').searchParams;
        const query = params.get('query')?.trim();
        const rawLimit = params.get('limit');
        const limit = rawLimit === null ? 50 : Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200 || query !== undefined && query.length > 500) throw new MnemoWeaveError('INVALID_INPUT');
        return reply(200, await client.memories({ ...(query ? { query } : {}), limit }));
      }
      if (req.method === 'GET' && req.url === '/v1/memories') {
        if (!client) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, await client.memories({ limit: 50 }));
      }
      const memoryMatch = /^\/v1\/memories\/([a-f0-9-]+)(?:\?revisionId=([a-f0-9-]+))?$/.exec(req.url ?? '');
      if (req.method === 'GET' && memoryMatch) return reply(200, await app.readMemory({ memoryId: memoryMatch[1], ...(memoryMatch[2] ? { revisionId: memoryMatch[2] } : {}) }));
      const editMatch = /^\/v1\/memories\/([a-f0-9-]+)$/.exec(req.url ?? '');
      if (req.method === 'PATCH' && editMatch) {
        if (!client) throw new MnemoWeaveError('REVIEW_REQUIRED');
        const body = await readJson(req);
        return reply(200, await client.editMemory(editMatch[1]!, body as { content: string; reason?: string; entryVersion: number }));
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
      return req.url === '/v1/recall' ? reply(200, await app.recall(input)) : reply(202, await app.remember(input));
    } catch (error) {
      const result = publicError(error);
      const status = statusForCode(result.code);
      process.stderr.write(`${JSON.stringify({ traceId, operation: 'http', code: result.code })}\n`);
      reply(status, { ...result, traceId });
    }
  });
}

async function readJson(req: import('node:http').IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new MnemoWeaveError('INVALID_INPUT');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length;
    if (size > 256000) throw new MnemoWeaveError('INVALID_INPUT');
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new MnemoWeaveError('INVALID_INPUT'); }
}
