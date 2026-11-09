import { PinInput, RuntimeContextInput } from '../../../core/contracts/src/index.ts';
import type { RuntimeContext, PinRecord } from '../../../core/contracts/src/index.ts';
import { createServer } from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { MemoryApplication } from '../../../core/application/src/index.ts';
import { MnemoWeaveError, openapi, publicError } from '../../../core/contracts/src/index.ts';
import type { ErrorCode, ReadGrantRecord, StorageStatusRecord, ViewRecord } from '../../../core/contracts/src/index.ts';
import type { PartitionSummary, SyncChange } from '../../../infrastructure/governance/src/sync-source.ts';

/** Single source of truth for the served routes; the OpenAPI document must mirror this list. */
export const httpRoutes: ReadonlyArray<{ method: 'GET' | 'POST'; path: string }> = [
  { method: 'POST', path: '/v1/runtime/context' },
  { method: 'POST', path: '/v1/runtime/pins' },
  { method: 'POST', path: '/v1/runtime/projects' },
  { method: 'GET', path: '/health/live' },
  { method: 'GET', path: '/health/ready' },
  { method: 'GET', path: '/openapi.json' },
  { method: 'GET', path: '/v1/storage' },
  { method: 'GET', path: '/v1/reviews/due' },
  { method: 'GET', path: '/v1/candidates/{candidateId}' },
  { method: 'GET', path: '/v1/memories/{memoryId}' },
  { method: 'GET', path: '/v1/conflicts/{caseId}' },
  { method: 'POST', path: '/v1/recall' },
  { method: 'POST', path: '/v1/view' },
  { method: 'POST', path: '/v1/remember' },
  { method: 'POST', path: '/v1/review' },
  { method: 'POST', path: '/v1/retry' },
  { method: 'POST', path: '/v1/conflicts/resolve' },
  { method: 'POST', path: '/v1/versions/cancel' },
  { method: 'POST', path: '/v1/reviews/complete' },
  { method: 'GET', path: '/v1/sync/changes' },
  { method: 'GET', path: '/v1/sync/snapshot' },
  { method: 'GET', path: '/v1/sync/verify' },
  { method: 'GET', path: '/v1/sync/watermark' },
  { method: 'GET', path: '/v1/sync/grant' },
  { method: 'POST', path: '/v1/sync/grant' },
  { method: 'POST', path: '/v1/sync/revoke' },
  { method: 'POST', path: '/v1/sync/intents' },
];

/** Error code → HTTP status mapping from the contract error model. */
export function statusForCode(code: ErrorCode): number {
  return code === 'UNAUTHORIZED' ? 401
    : code === 'INVALID_INPUT' ? 400
    : code === 'NOT_FOUND' ? 404
    : ['REVIEW_REQUIRED', 'IDEMPOTENCY_CONFLICT', 'INVALID_STATE', 'VIEW_BUDGET_EXCEEDED', 'QUOTA_EXCEEDED'].includes(code) ? 409
    : 503;
}

/**
 * Server-side sync transport (WP6/WP7 wiring). The Bridge reaches the ordered change
 * stream, curated snapshots, partition summaries, pairing grants and intent intake here.
 */
export interface SyncHttpEndpoints {
  currentGrant(hostId: string): ReadGrantRecord | undefined;
  issueGrant(hostId: string, projects: string[], globalIncluded: boolean, ttlMs?: number): Promise<ReadGrantRecord>;
  revoke(hostId: string, global: boolean): Promise<void>;
  isRevoked(hostId: string): Promise<boolean>;
  watermark(): number;
  scoped?: boolean;
  requireHostCredential?: boolean;
  changes(sinceSeq: number, hostId?: string): Promise<{ changes: SyncChange[]; windowOldestSeq: number; latestSeq: number }>;
  snapshot(hostId?: string): Promise<{ path: string; latestSeq: number }>;
  partitionSummaries(hostId?: string): Promise<PartitionSummary[]>;
  submitIntent(hostId: string, intent: { intentId: string; kind: string; payload: Record<string, unknown>; baselineRef: string | undefined }): Promise<{ status: 'accepted' | 'isolated'; reference?: string }>;
}

export interface RuntimeHttpEndpoints {
  context(hostId: string, input: ReturnType<typeof RuntimeContextInput.parse>): RuntimeContext;
  pin(input: PinRecord): void;
  register(projectId: string): void;
}

/** Per-Host credentials are derived only at the Server; never give its master token to a Host. */
export function hostCredential(masterToken: string, hostId: string): string {
  return createHmac('sha256', masterToken).update(`mnemoweave-host:${hostId}`).digest('base64url');
}
export function createHttpServer(app: MemoryApplication, token: string, operatorToken?: string, sync?: SyncHttpEndpoints, view?: (hostId: string, input: unknown) => Promise<ViewRecord>, storage?: () => StorageStatusRecord, runtime?: RuntimeHttpEndpoints) {
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
    const replyBinary = (status: number, body: Buffer, headers: Record<string, string>) => {
      res.writeHead(status, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-trace-id': traceId, ...headers });
      res.end(body);
    };
    try {
      const actual = Buffer.from(req.headers.authorization ?? '');
      const isOperator = !!operatorExpected && actual.length === operatorExpected.length && timingSafeEqual(actual, operatorExpected);
      const claimedHost = req.headers['x-mnemoweave-host'];
      const hostExpected = sync?.requireHostCredential && typeof claimedHost === 'string' && sync.currentGrant(claimedHost) ? Buffer.from(`Bearer ${hostCredential(token, claimedHost)}`) : undefined;
      const isHost = !!hostExpected && actual.length === hostExpected.length && timingSafeEqual(actual, hostExpected);
      if (!isOperator && !isHost && (actual.length !== expected.length || !timingSafeEqual(actual, expected))) throw new MnemoWeaveError('UNAUTHORIZED');
      if (req.headers.origin) throw new MnemoWeaveError('UNAUTHORIZED');
      const requestGrant = async (write = false): Promise<ReadGrantRecord | undefined> => {
        if (isOperator || !sync) return undefined;
        if (sync.requireHostCredential && !isHost) throw new MnemoWeaveError('UNAUTHORIZED');
        const host = req.headers['x-mnemoweave-host'];
        const grant = typeof host === 'string' ? sync.currentGrant(host) : undefined;
        if (!grant || await sync.isRevoked(grant.hostId) || grant.generation < sync.watermark() || !write && Date.parse(grant.expiresAt) <= Date.now()) throw new MnemoWeaveError('UNAUTHORIZED');
        return grant;
      };

      const withRead = async <T>(operation: (grant: ReadGrantRecord | undefined) => Promise<T>): Promise<T> => {
        const grant = await requestGrant();
        const result = await operation(grant);
        const final = await requestGrant();
        if (grant?.grantId !== final?.grantId) throw new MnemoWeaveError('UNAUTHORIZED');
        return result;
      };
      if (req.method === 'GET' && req.url === '/health/live') return reply(200, { live: true });
      if (req.method === 'GET' && req.url === '/health/ready') return reply(200, await app.health());
      if (req.method === 'GET' && req.url === '/openapi.json') return reply(200, openapi);
      if (req.method === 'GET' && req.url === '/v1/storage') {
        if (!storage) throw new MnemoWeaveError('REVIEW_REQUIRED');
        return reply(200, storage());
      }
      if (req.method === 'GET' && req.url === '/v1/reviews/due') {
        if (!isOperator) throw new MnemoWeaveError('UNAUTHORIZED');
        return reply(200, await app.reviewDue());
      }
      const candidateMatch = /^\/v1\/candidates\/([a-f0-9-]+)$/.exec(req.url ?? '');
      if (req.method === 'GET' && candidateMatch) return reply(200, await withRead(grant => app.candidateStatus({ candidateId: candidateMatch[1] }, grant)));
      const memoryMatch = /^\/v1\/memories\/([a-f0-9-]+)(?:\?revisionId=([a-f0-9-]+))?$/.exec(req.url ?? '');
      if (req.method === 'GET' && memoryMatch) return reply(200, await withRead(grant => app.readMemory({ memoryId: memoryMatch[1], ...(memoryMatch[2] ? { revisionId: memoryMatch[2] } : {}) }, grant)));
      const conflictMatch=/^\/v1\/conflicts\/([a-f0-9-]+)$/.exec(req.url??'');
      if(req.method==='GET'&&conflictMatch)return reply(200,await withRead(grant => app.readConflict({caseId:conflictMatch[1]}, grant)));
      // ── Sync transport (host identity comes from the paired grant, never the payload) ──
      const syncMatch = /^\/v1\/sync\/(changes|snapshot|verify|watermark|grant)$/.exec(req.url?.split('?')[0] ?? '');
      if (syncMatch && sync) {
        if (sync.requireHostCredential && !isHost && !isOperator) throw new MnemoWeaveError('UNAUTHORIZED');
        const hostId = req.headers['x-mnemoweave-host'];
        const pairedHost = typeof hostId === 'string' && sync.currentGrant(hostId) !== undefined ? hostId : undefined;
        if (req.method === 'GET') {
          if (!pairedHost) throw new MnemoWeaveError('UNAUTHORIZED');
          const initialGrantId = sync.currentGrant(pairedHost)!.grantId;
          const authorizeData = async (): Promise<void> => {
            const grant = sync.currentGrant(pairedHost);
            if (!grant || grant.grantId !== initialGrantId || await sync.isRevoked(pairedHost) || Date.parse(grant.expiresAt) <= Date.now() || grant.generation < sync.watermark()) throw new MnemoWeaveError('UNAUTHORIZED');
            // Project identities are not yet persisted: partial replicas must fail closed.
            if (!sync.scoped && (!grant.projects.includes('*') || !grant.globalIncluded)) throw new MnemoWeaveError('UNAUTHORIZED');
          };
          if (['changes', 'snapshot', 'verify'].includes(syncMatch[1]!)) await authorizeData();
          if (syncMatch[1] === 'changes') {
            const since = Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('since') ?? '-1');
            if (!Number.isInteger(since) || since < -1) throw new MnemoWeaveError('INVALID_INPUT');
            const changes = await sync.changes(since, pairedHost);
            await authorizeData();
            return reply(200, changes);
          }
          if (syncMatch[1] === 'verify') {
            const summaries = await sync.partitionSummaries(pairedHost);
            await authorizeData();
            return reply(200, summaries);
          }
          if (syncMatch[1] === 'watermark') return reply(200, { watermark: sync.watermark(), revoked: await sync.isRevoked(pairedHost) });
          if (syncMatch[1] === 'grant') {
            const grant = sync.currentGrant(pairedHost);
            if (!grant) return reply(404, { code: 'NOT_FOUND' });
            return reply(200, grant);
          }
          const served = await sync.snapshot(pairedHost);
          const body = await readFile(served.path);
          await authorizeData();
          return replyBinary(200, body, { 'x-sync-latest-seq': String(served.latestSeq) });
        }
      }
      const operatorRoute = ['/v1/review', '/v1/retry','/v1/conflicts/resolve','/v1/versions/cancel','/v1/reviews/complete','/v1/runtime/pins','/v1/runtime/projects'].includes(req.url ?? '');
      if (operatorRoute && !isOperator) throw new MnemoWeaveError('UNAUTHORIZED');
      const syncPostRoute = req.method === 'POST' && /^\/v1\/sync\/(grant|revoke|intents)$/.test(req.url ?? '');
      if (!syncPostRoute && (req.method !== 'POST' || !['/v1/runtime/context', '/v1/runtime/pins', '/v1/runtime/projects', '/v1/recall', '/v1/view', '/v1/remember', '/v1/review', '/v1/retry','/v1/conflicts/resolve','/v1/versions/cancel','/v1/reviews/complete'].includes(req.url ?? ''))) return reply(404, { code: 'NOT_FOUND' });
      if (!req.headers['content-type']?.startsWith('application/json')) throw new MnemoWeaveError('INVALID_INPUT');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length;
        if (size > 256000) throw new MnemoWeaveError('INVALID_INPUT');
        chunks.push(bytes);
      }
      let input: unknown;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new MnemoWeaveError('INVALID_INPUT'); }
      if (req.url?.startsWith('/v1/runtime/')) {
        if (!runtime) throw new MnemoWeaveError('REVIEW_REQUIRED');
        if (req.url === '/v1/runtime/pins') { runtime.pin(PinInput.parse(input)); return reply(200, { updated: true }); }
        if (req.url === '/v1/runtime/projects') {
          const id = (input as Record<string, unknown>)?.['projectId'];
          if (typeof id !== 'string') throw new MnemoWeaveError('INVALID_INPUT');
          runtime.register(id); return reply(200, { registered: true });
        }
        const grant = await requestGrant();
        const host = grant?.hostId ?? req.headers['x-mnemoweave-host'];
        if (typeof host !== 'string') throw new MnemoWeaveError('UNAUTHORIZED');
        const contextInput = RuntimeContextInput.parse(input);
        if (grant && contextInput.projectId && !grant.projects.includes('*') && !grant.projects.includes(contextInput.projectId)) throw new MnemoWeaveError('UNAUTHORIZED');
        return reply(200, runtime.context(host, contextInput));
      }
      if (req.url === '/v1/review') return reply(200, await app.humanReview(input, 'local-operator'));
      if (req.url === '/v1/retry') return reply(202, await app.retryWrite(input, 'local-operator'));
      if(req.url==='/v1/conflicts/resolve')return reply(200,await app.resolveConflict(input,'local-operator'));
      if(req.url==='/v1/versions/cancel')return reply(200,await app.cancelVersion(input,'local-operator'));
      if(req.url==='/v1/reviews/complete')return reply(200,await app.completeReview(input,'local-operator'));
      if (sync && syncPostRoute) {
        const body = input as Record<string, unknown>;
        if (req.url === '/v1/sync/grant') {
          if (!isOperator) throw new MnemoWeaveError('UNAUTHORIZED');
          const hostId = body['hostId'];
          if (typeof hostId !== 'string' || !hostId.trim()) throw new MnemoWeaveError('INVALID_INPUT');
          const projects = Array.isArray(body['projects']) ? body['projects'].filter(item => typeof item === 'string') : [];
          const grant = await sync.issueGrant(hostId, projects, body['globalIncluded'] === true, typeof body['ttlMs'] === 'number' ? body['ttlMs'] : undefined);
          return reply(200, { ...grant, credential: hostCredential(token, hostId) });
        }
        if (req.url === '/v1/sync/revoke') {
          if (!isOperator) throw new MnemoWeaveError('UNAUTHORIZED');
          const hostId = body['hostId'];
          if (typeof hostId !== 'string' || !hostId.trim()) throw new MnemoWeaveError('INVALID_INPUT');
          await sync.revoke(hostId, body['global'] === true);
          return reply(200, { revoked: true });
        }
        // Intent intake: identity from the paired grant, never from the payload.
        if (sync.requireHostCredential && !isHost && !isOperator) throw new MnemoWeaveError('UNAUTHORIZED');
        const hostId = req.headers['x-mnemoweave-host'];
        if (typeof hostId !== 'string' || !hostId.trim() || !sync.currentGrant(hostId)) throw new MnemoWeaveError('UNAUTHORIZED');
        const intentId = body['intentId'];
        const kind = body['kind'];
        if (typeof intentId !== 'string' || !intentId.trim() || typeof kind !== 'string' || !['remember', 'event', 'version_intent', 'relation_intent'].includes(kind)) throw new MnemoWeaveError('INVALID_INPUT');
        if (body['payload'] === undefined || body['payload'] === null || typeof body['payload'] !== 'object') throw new MnemoWeaveError('INVALID_INPUT');
        const baselineRef = typeof body['baselineRef'] === 'string' ? body['baselineRef'] : undefined;
        return reply(200, await sync.submitIntent(hostId, { intentId, kind, payload: body['payload'] as Record<string, unknown>, baselineRef }));
      }
      if (req.url === '/v1/view') {
        await requestGrant();
        if (!view) throw new MnemoWeaveError('REVIEW_REQUIRED');
        const host = req.headers['x-mnemoweave-host'];
        if (typeof host !== 'string' || !host.trim()) throw new MnemoWeaveError('UNAUTHORIZED');
        return reply(200, await view(host, input));
      }
      return req.url === '/v1/recall' ? reply(200, await withRead(grant => app.recall(input, grant))) : reply(202, await app.remember(input, await requestGrant(true)));
    } catch (error) {
      const result = publicError(error);
      const status = statusForCode(result.code);
      process.stderr.write(`${JSON.stringify({ traceId, operation: 'http', code: result.code })}\n`);
      reply(status, { ...result, traceId });
    }
  });
}
