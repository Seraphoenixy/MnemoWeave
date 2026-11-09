import type { RpcResult, UiConfigView, UiIntents, UiMemoryDetail, UiMemoryList, UiRevision, UiStatus } from '../shared/contract.ts';
import { RPC_CHANNEL } from '../shared/contract.ts';
import type { ClientConnection } from './dsh-types.ts';

export class RpcFailure extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'RpcFailure';
    this.code = code;
  }
}

function unwrap<T>(result: RpcResult<T>): T {
  if (result.ok !== true) throw new RpcFailure(result.error.message, result.error.code ?? 'RPC_FAILED');
  return result.value;
}

/** Every read the page makes goes through the Host; the page never sees the Bridge token. */
export function createApi(connection: ClientConnection) {
  const call = async <T>(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<T> => {
    const result = signal === undefined
      ? await connection.rpc.call<T>(RPC_CHANNEL, endpoint, payload)
      : await connection.rpc.call<T>(RPC_CHANNEL, endpoint, payload, signal);
    return unwrap(result);
  };
  return {
    status: (signal?: AbortSignal): Promise<UiStatus> => call<UiStatus>('status', {}, signal),
    config: (signal?: AbortSignal): Promise<UiConfigView> => call<UiConfigView>('config', {}, signal),
    memories: (input: { query?: string | undefined; limit?: number | undefined; scope?: 'project' | 'global' | undefined; projectId?: string | undefined }, signal?: AbortSignal): Promise<UiMemoryList> => call<UiMemoryList>('memories', input, signal),
    memory: (memoryId: string, signal?: AbortSignal): Promise<UiMemoryDetail> => call<UiMemoryDetail>('memory', { memoryId }, signal),
    revision: (memoryId: string, revisionId: string, signal?: AbortSignal): Promise<UiRevision> => call<UiRevision>('revision', { memoryId, revisionId }, signal),
    intents: (signal?: AbortSignal): Promise<UiIntents> => call<UiIntents>('intents', {}, signal),
  };
}

export type MnemoWeaveApi = ReturnType<typeof createApi>;
