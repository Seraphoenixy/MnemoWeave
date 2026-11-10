import type {
  RpcResult, UiArchive, UiConfigView, UiEditInput, UiEditResult, UiInjection, UiMemoryDetail, UiMemoryList, UiRule, UiStatus, UiSyncPass, UiSyncStatus,
} from '../shared/contract.ts';
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

/** Every read and the edit call go through the Host; the page never sees the Server token. */
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
    memories: (input: { query?: string; limit: number }, signal?: AbortSignal): Promise<UiMemoryList> => call<UiMemoryList>('memories', input, signal),
    memory: (memoryId: string, signal?: AbortSignal): Promise<UiMemoryDetail> => call<UiMemoryDetail>('memory', { memoryId }, signal),
    edit: (input: UiEditInput, signal?: AbortSignal): Promise<UiEditResult> => call<UiEditResult>('edit', input, signal),
    injection: (signal?: AbortSignal): Promise<UiInjection | null> => call<UiInjection | null>('injection', {}, signal),
    rules: (signal?: AbortSignal): Promise<UiRule[]> => call<UiRule[]>('rules', {}, signal),
    archives: (signal?: AbortSignal): Promise<UiArchive[]> => call<UiArchive[]>('archives', {}, signal),
    sync: (signal?: AbortSignal): Promise<UiSyncStatus> => call<UiSyncStatus>('sync', {}, signal),
    syncRefresh: (signal?: AbortSignal): Promise<UiSyncPass> => call<UiSyncPass>('syncRefresh', {}, signal),
  };
}

export type MnemoWeaveApi = ReturnType<typeof createApi>;
