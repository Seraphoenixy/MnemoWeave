import type { MemoryRequest, MemoriesRequest, RevisionRequest, RpcResult } from '../shared/contract.ts';
import { isRecord } from '../shared/contract.ts';
import type { BridgeUiClient } from './bridge-client.ts';
import type { RpcHandler } from './types.ts';

const MAX_QUERY = 500;
const MAX_LIMIT = 200;
const MAX_PROJECT = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ok<T>(value: T): RpcResult<T> { return { ok: true, value }; }
function fail(message: string, code: string): RpcResult<never> { return { ok: false, error: { message, code } }; }

function memoriesRequest(payload: unknown): MemoriesRequest {
  if (payload === undefined || payload === null) return {};
  if (!isRecord(payload)) throw Object.assign(new Error('memories payload must be an object'), { code: 'INVALID_INPUT' });
  const query = payload['query'];
  const limit = payload['limit'];
  const scope = payload['scope'];
  const projectId = payload['projectId'];
  if (query !== undefined && (typeof query !== 'string' || query.length > MAX_QUERY)) throw Object.assign(new Error('query must be a string of at most 500 characters'), { code: 'INVALID_INPUT' });
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)) throw Object.assign(new Error('limit must be an integer between 1 and 200'), { code: 'INVALID_INPUT' });
  if (scope !== undefined && scope !== 'project' && scope !== 'global') throw Object.assign(new Error('scope must be project or global'), { code: 'INVALID_INPUT' });
  if (projectId !== undefined && (typeof projectId !== 'string' || projectId.trim() === '' || projectId.length > MAX_PROJECT)) throw Object.assign(new Error('projectId must be a non-empty string of at most 200 characters'), { code: 'INVALID_INPUT' });
  return {
    ...(query === undefined ? {} : { query }),
    ...(limit === undefined ? {} : { limit }),
    ...(scope === undefined ? {} : { scope }),
    ...(projectId === undefined ? {} : { projectId }),
  } as MemoriesRequest;
}

function revisionRequest(payload: unknown): RevisionRequest {
  if (!isRecord(payload) || typeof payload['memoryId'] !== 'string' || !UUID.test(payload['memoryId'])
    || typeof payload['revisionId'] !== 'string' || !UUID.test(payload['revisionId'])) {
    throw Object.assign(new Error('memoryId and revisionId must be UUIDs'), { code: 'INVALID_INPUT' });
  }
  return { memoryId: payload['memoryId'], revisionId: payload['revisionId'] };
}

function memoryRequest(payload: unknown): MemoryRequest {
  if (!isRecord(payload) || typeof payload['memoryId'] !== 'string' || !UUID.test(payload['memoryId'])) {
    throw Object.assign(new Error('memoryId must be a UUID'), { code: 'INVALID_INPUT' });
  }
  return { memoryId: payload['memoryId'] };
}

/**
 * Serves the client page's four reads. The page names an endpoint and a bounded payload;
 * the Host decides what the Bridge may answer and reports failures instead of empty data.
 */
export function createRpcHandler(client: BridgeUiClient): RpcHandler {
  return async (endpoint, payload, signal) => {
    try {
      switch (endpoint) {
        case 'status': return ok(await client.status(signal));
        case 'config': return ok(client.describe());
        case 'memories': return ok(await client.memories(memoriesRequest(payload), signal));
        case 'memory': return ok(await client.memory(memoryRequest(payload).memoryId, signal));
        case 'revision': {
          const request = revisionRequest(payload);
          return ok(await client.revision(request.memoryId, request.revisionId, signal));
        }
        case 'intents': return ok(await client.intents(signal));
        default: return fail(`unknown MnemoWeave UI endpoint: ${String(endpoint).slice(0, 80)}`, 'UNKNOWN_ENDPOINT');
      }
    } catch (error) {
      const code = isRecord(error) && typeof error['code'] === 'string' ? error['code'] : 'PROVIDER_UNAVAILABLE';
      const message = error instanceof Error ? error.message : String(error);
      return fail(message.slice(0, 300), code);
    }
  };
}
