import type { MemoriesRequest, MemoryRequest, RpcResult, UiEditInput } from '../shared/contract.ts';
import { isRecord } from '../shared/contract.ts';
import type { MemorySource } from './memory-source.ts';
import type { RpcHandler } from './types.ts';

const MAX_QUERY = 500;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const MAX_CONTENT_BYTES = 8_000;
const MAX_REASON = 4_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (query !== undefined && (typeof query !== 'string' || query.length > MAX_QUERY)) {
    invalid(`query must be a string of at most ${MAX_QUERY} characters`);
  }
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)) {
    invalid(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return {
    ...(query === undefined ? {} : { query }),
    limit: limit ?? DEFAULT_LIMIT,
  };
}

function memoryRequest(payload: unknown): MemoryRequest {
  if (!isRecord(payload) || typeof payload['memoryId'] !== 'string' || !UUID.test(payload['memoryId'])) {
    invalid('memoryId must be a UUID');
  }
  return { memoryId: payload['memoryId'] };
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
  return {
    memoryId: payload['memoryId'],
    content,
    entryVersion,
    ...(trimmedReason === undefined || trimmedReason === '' ? {} : { reason: trimmedReason }),
  };
}

/** Rejection message kept for the page; the Server's own code is passed through unchanged. */
function failureOf(error: unknown): { message: string; code: string } {
  const code = isRecord(error) && typeof error['code'] === 'string' ? error['code'] : 'PROVIDER_UNAVAILABLE';
  const message = error instanceof Error ? error.message : String(error);
  return { message: message.slice(0, 300), code };
}

/**
 * Serves the page's six endpoints. Each request is validated here before anything reaches the
 * Server; a rejected request or a Server error is reported with its code instead of empty data.
 */
export function createRpcHandler(source: MemorySource): RpcHandler {
  return async (endpoint, payload) => {
    try {
      switch (endpoint) {
        case 'status': return ok(await source.status());
        case 'config': return ok(source.describe());
        case 'memories': {
          const request = memoriesRequest(payload);
          return ok(await source.memories({
            ...(request.query === undefined ? {} : { query: request.query }),
            limit: request.limit ?? DEFAULT_LIMIT,
          }));
        }
        case 'memory': return ok(await source.memory(memoryRequest(payload).memoryId));
        case 'edit': return ok(await source.edit(editRequest(payload)));
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
