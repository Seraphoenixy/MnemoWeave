import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { MnemoWeaveError } from '../../../packages/core/contracts/src/index.ts';
import type { UiIntentsRecord, UiMemoryDetailRecord, UiMemoryListRecord, UiRevisionRecord, UiStatusRecord } from '../../../packages/bridge/src/ui-read.ts';

/** The Bridge surface the UI server reads; the Bridge itself implements it. */
export interface UiApi {
  uiStatus(): UiStatusRecord;
  uiMemories(input: { query?: string | undefined; limit?: number | undefined; scope?: 'project' | 'global' | undefined; projectId?: string | undefined }): UiMemoryListRecord;
  uiMemory(memoryId: string): UiMemoryDetailRecord;
  uiRevision(memoryId: string, revisionId: string): UiRevisionRecord;
  uiIntents(): UiIntentsRecord;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUERY_LENGTH = 500;
const MAX_PROJECT_LENGTH = 200;

/**
 * Read-only loopback endpoint for the DSH client UI (WP8). It answers only GET requests
 * with a dedicated UI token, refuses any browser Origin (the page must reach it through
 * the Host plugin, never directly), and re-checks the Host grant on every read.
 */
export function createUiServer(options: { token: string; api: UiApi }) {
  if (options.token.length < 24) throw new Error('Bridge UI token must contain at least 24 characters');
  const expected = Buffer.from(`Bearer ${options.token}`);
  return createServer((req, res) => {
    const traceId = randomUUID();
    const reply = (status: number, value: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-trace-id': traceId });
      res.end(JSON.stringify(value));
    };
    const fail = (code: 'UNAUTHORIZED' | 'NOT_FOUND' | 'INVALID_INPUT' | 'PROVIDER_UNAVAILABLE'): void => {
      reply(code === 'UNAUTHORIZED' ? 401 : code === 'NOT_FOUND' ? 404 : code === 'INVALID_INPUT' ? 400 : 503, { code });
    };
    try {
      const actual = Buffer.from(req.headers.authorization ?? '');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return fail('UNAUTHORIZED');
      // A browser page must never read memory directly; only the Host plugin calls this.
      if (req.headers.origin) return fail('UNAUTHORIZED');
      if (req.method === 'GET' && req.url === '/health/live') return reply(200, { live: true });
      if (req.method !== 'GET') return fail('NOT_FOUND');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/v1/ui/status') return reply(200, options.api.uiStatus());
      if (url.pathname === '/v1/ui/intents') return reply(200, options.api.uiIntents());
      if (url.pathname === '/v1/ui/memories') {
        const rawQuery = url.searchParams.get('query') ?? '';
        if (rawQuery.length > MAX_QUERY_LENGTH) return fail('INVALID_INPUT');
        const rawLimit = url.searchParams.get('limit');
        const limit = rawLimit === null ? undefined : Number(rawLimit);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) return fail('INVALID_INPUT');
        const rawScope = url.searchParams.get('scope');
        if (rawScope !== null && rawScope !== 'project' && rawScope !== 'global') return fail('INVALID_INPUT');
        const rawProject = url.searchParams.get('projectId');
        if (rawProject !== null && (rawProject.trim() === '' || rawProject.length > MAX_PROJECT_LENGTH)) return fail('INVALID_INPUT');
        return reply(200, options.api.uiMemories({
          ...(rawQuery.trim() ? { query: rawQuery } : {}),
          ...(limit === undefined ? {} : { limit }),
          ...(rawScope === null ? {} : { scope: rawScope }),
          ...(rawProject === null ? {} : { projectId: rawProject }),
        }));
      }
      const revisionMatch = /^\/v1\/ui\/memories\/([^/]+)\/revisions\/([^/]+)$/.exec(url.pathname);
      if (revisionMatch) {
        const memoryId = revisionMatch[1]!;
        const revisionId = revisionMatch[2]!;
        if (!UUID.test(memoryId) || !UUID.test(revisionId)) return fail('INVALID_INPUT');
        return reply(200, options.api.uiRevision(memoryId, revisionId));
      }
      const match = /^\/v1\/ui\/memories\/([^/]+)$/.exec(url.pathname);
      if (match) {
        const memoryId = match[1]!;
        if (!UUID.test(memoryId)) return fail('INVALID_INPUT');
        return reply(200, options.api.uiMemory(memoryId));
      }
      return fail('NOT_FOUND');
    } catch (error) {
      if (error instanceof MnemoWeaveError) return error.code === 'NOT_FOUND' ? fail('NOT_FOUND') : error.code === 'INVALID_INPUT' ? fail('INVALID_INPUT') : fail('PROVIDER_UNAVAILABLE');
      process.stderr.write(`${JSON.stringify({ traceId, event: 'bridge_ui_failed', message: String(error).slice(0, 200) })}\n`);
      return fail('PROVIDER_UNAVAILABLE');
    }
  });
}
