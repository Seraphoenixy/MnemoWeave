import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { MnemoWeaveError, REQUEST_BODY_MAX_BYTES, SyncChangeInput, SyncPullInput, publicError, statusForCode } from '../../../core/contracts/src/index.ts';
import { VersionConflictError } from '../../../core/application/src/sync.ts';
import type { SyncAcceptedValue, SyncChangeRequest, SyncEntryValue, SyncPullPageValue, SyncPullRequest, SyncScopesValue, SyncSnapshotValue } from '../../../core/contracts/src/index.ts';

/**
 * Remote sync surface. Only the three local Servers call it; hosts never see it.
 * The gateway port keeps this package free of the storage and Provider layers.
 */
export interface SyncGateway {
  submit(token: string, change: SyncChangeRequest): SyncAcceptedValue;
  pull(token: string, query: SyncPullRequest): SyncPullPageValue;
  receipt(token: string, changeId: string): SyncAcceptedValue;
  entry(token: string, entryId: string): SyncEntryValue;
  snapshot(token: string, scope: string): SyncSnapshotValue;
  scopes(token: string): SyncScopesValue;
}

/** Served routes; the sync document and tests must agree with this list. */
export const syncRoutes = [
  { method: 'POST', path: '/v1/sync/changes' },
  { method: 'GET', path: '/v1/sync/changes' },
  { method: 'GET', path: '/v1/sync/receipts/{changeId}' },
  { method: 'GET', path: '/v1/sync/entries/{entryId}' },
  { method: 'GET', path: '/v1/sync/snapshot' },
  { method: 'GET', path: '/v1/sync/scopes' },
  { method: 'GET', path: '/v1/sync/health' },
] as const;

export interface SyncServerOptions {
  gateway: SyncGateway;
  now?: () => Date;
}

export const SYNC_PROTOCOL_VERSION = 1;
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
      const token = bearer(req);
      const url = new URL(req.url ?? '/', 'http://sync.invalid');
      if (req.method === 'GET' && url.pathname === '/v1/sync/health') {
        // Liveness still proves the caller is a live device: an unknown or revoked
        // token must not learn anything about the service.
        options.gateway.scopes(token);
        return reply(200, { ready: true, protocol: SYNC_PROTOCOL_VERSION, now: now().toISOString() });
      }
      if (req.method === 'GET' && url.pathname === '/v1/sync/scopes') {
        return reply(200, options.gateway.scopes(token));
      }
      if (req.method === 'GET' && url.pathname === '/v1/sync/changes') {
        const query = SyncPullInput.parse({
          scope: url.searchParams.get('scope') ?? '',
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
        const scope = url.searchParams.get('scope');
        if (!scope) throw new MnemoWeaveError('INVALID_INPUT');
        return reply(200, options.gateway.snapshot(token, scope));
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

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new MnemoWeaveError('INVALID_INPUT');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new MnemoWeaveError('INVALID_INPUT');
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new MnemoWeaveError('INVALID_INPUT');
  }
}
