import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { MnemoWeaveError, REQUEST_BODY_MAX_BYTES, SYNC_PROTOCOL_HEADER, SYNC_PROTOCOL_VERSION, SyncChangeInput, SyncPullInput, publicError, statusForCode } from '../../../core/contracts/src/index.ts';
import { VersionConflictError } from '../../../core/application/src/sync.ts';
import type { SyncAcceptedValue, SyncChangeRequest, SyncEntryValue, SyncPullPageValue, SyncPullRequest, SyncSnapshotValue, SyncStreamsValue } from '../../../core/contracts/src/index.ts';

/**
 * Remote sync surface. Only the local Servers call it; hosts never see it. The gateway port keeps
 * this package free of the storage and Provider layers.
 *
 * Every request except liveness must name protocol 2. A missing or different version is HTTP 409
 * with `SYNC_PROTOCOL_MISMATCH`, so a local Server that still speaks protocol 1 stops instead of
 * sending a change whose stream the remote cannot derive the same way.
 */
export interface SyncGateway {
  submit(token: string, change: SyncChangeRequest): SyncAcceptedValue;
  pull(token: string, query: SyncPullRequest): SyncPullPageValue;
  receipt(token: string, changeId: string): SyncAcceptedValue;
  entry(token: string, entryId: string): SyncEntryValue;
  snapshot(token: string, stream: string): SyncSnapshotValue;
  streams(token: string): SyncStreamsValue;
}

/** Served routes; the sync document and tests must agree with this list. */
export const syncRoutes = [
  { method: 'POST', path: '/v1/sync/changes' },
  { method: 'GET', path: '/v1/sync/changes' },
  { method: 'GET', path: '/v1/sync/receipts/{changeId}' },
  { method: 'GET', path: '/v1/sync/entries/{entryId}' },
  { method: 'GET', path: '/v1/sync/snapshot' },
  { method: 'GET', path: '/v1/sync/streams' },
  { method: 'GET', path: '/v1/sync/health' },
] as const;

export interface SyncServerOptions {
  gateway: SyncGateway;
  enrollment?: (method: string | undefined, path: string, token: () => string, read: () => Promise<unknown>, source: string) => Promise<unknown>;
  enrollmentSource?: (request: IncomingMessage) => string;
  now?: () => Date;
}

export { SYNC_PROTOCOL_VERSION };
export const SYNC_PROTOCOL = SYNC_PROTOCOL_VERSION;
const MAX_BODY_BYTES = REQUEST_BODY_MAX_BYTES;

export function createSyncServer(options: SyncServerOptions) {
  const now = options.now ?? (() => new Date());
  return createServer(async (req, res) => {
    const traceId = randomUUID();
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-trace-id': traceId });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.headers.origin) throw new MnemoWeaveError('UNAUTHORIZED');
      const url = new URL(req.url ?? '/', 'http://sync.invalid');
      const enrollment = await options.enrollment?.(
        req.method, url.pathname, () => bearer(req), () => readJson(req, 4096),
        options.enrollmentSource?.(req) ?? req.socket.remoteAddress ?? 'unknown',
      );
      if (enrollment !== undefined) return reply(200, enrollment);
      const token = bearer(req);
      if (req.method === 'GET' && url.pathname === '/v1/sync/health') {
        // Liveness still proves the caller is a live device: an unknown or revoked token must not
        // learn anything about the service.
        options.gateway.streams(token);
        return reply(200, { ready: true, protocol: SYNC_PROTOCOL_VERSION, now: now().toISOString() });
      }
      const declared = req.headers[SYNC_PROTOCOL_HEADER];
      const value = Array.isArray(declared) ? declared[0] : declared;
      if (value === undefined || value.trim() !== String(SYNC_PROTOCOL_VERSION)) {
        return reply(409, { code: 'SYNC_PROTOCOL_MISMATCH', expected: SYNC_PROTOCOL_VERSION, traceId });
      }
      if (req.method === 'GET' && url.pathname === '/v1/sync/streams') {
        return reply(200, options.gateway.streams(token));
      }
      if (req.method === 'GET' && url.pathname === '/v1/sync/changes') {
        const query = SyncPullInput.parse({
          stream: url.searchParams.get('stream') ?? '',
          since: numberParam(url, 'since', 0),
          limit: numberParam(url, 'limit', 200),
        });
        return reply(200, options.gateway.pull(token, query));
      }
      if (req.method === 'POST' && url.pathname === '/v1/sync/changes') {
        const change = SyncChangeInput.parse(await readJson(req));
        return reply(200, options.gateway.submit(token, change));
      }
      const receiptMatch = /^\/v1\/sync\/receipts\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (req.method === 'GET' && receiptMatch) {
        return reply(200, options.gateway.receipt(token, receiptMatch[1]!));
      }
      const entryMatch = /^\/v1\/sync\/entries\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (req.method === 'GET' && entryMatch) {
        return reply(200, options.gateway.entry(token, entryMatch[1]!));
      }
      if (req.method === 'GET' && url.pathname === '/v1/sync/snapshot') {
        const stream = url.searchParams.get('stream');
        if (!stream) throw new MnemoWeaveError('INVALID_INPUT');
        return reply(200, options.gateway.snapshot(token, stream));
      }
      return reply(404, { code: 'NOT_FOUND', traceId });
    } catch (error) {
      if (error instanceof VersionConflictError) {
        process.stderr.write(`${JSON.stringify({ traceId, operation: 'sync', code: error.code, version: error.currentVersion })}\n`);
        return reply(409, { code: error.code, currentVersion: error.currentVersion, currentEntry: error.currentEntry, traceId });
      }
      const result = publicError(error);
      process.stderr.write(`${JSON.stringify({ traceId, operation: 'sync', code: result.code })}\n`);
      return reply(statusForCode(result.code), { ...result, traceId });
    }
  });
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (typeof header !== 'string') throw new MnemoWeaveError('UNAUTHORIZED');
  const match = /^Bearer (\S+)$/.exec(header.trim());
  if (!match?.[1]) throw new MnemoWeaveError('UNAUTHORIZED');
  return match[1];
}

function numberParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new MnemoWeaveError('INVALID_INPUT');
  return value;
}

async function readJson(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new MnemoWeaveError('INVALID_INPUT');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > maxBytes) throw new MnemoWeaveError('INVALID_INPUT');
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new MnemoWeaveError('INVALID_INPUT');
  }
}
