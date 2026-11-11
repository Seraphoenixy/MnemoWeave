import type {
  MemoriesRequest, RpcResult, UiArchive, UiCreateInput, UiCreateResult, UiConfigView, UiConnectionTest, UiEditInput, UiEditResult, UiExplore, UiGraph, UiInjection, UiMemoryDetail, UiMemoryList, UiRegisterTest, UiRule, UiRuleCreateInput, UiRuleEditInput, UiSettings, UiStatus, UiSyncPass, UiSyncStatus, UiWakeTest, UiWithdrawInput, UiWithdrawResult,
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
    memories: (input: MemoriesRequest, signal?: AbortSignal): Promise<UiMemoryList> => call<UiMemoryList>('memories', input, signal),
    /** Omit `revisionId` for the current revision; supply one to read a historical version. */
    memory: (memoryId: string, revisionId?: string, signal?: AbortSignal): Promise<UiMemoryDetail> => call<UiMemoryDetail>('memory', { memoryId, ...(revisionId === undefined ? {} : { revisionId }) }, signal),
    skillConversations: () => call<{ id: string; workspace: string }[]>('skillConversations', {}),
    skillReview: (input: { sessionId: string; baseline: string }, signal: AbortSignal) =>
      call<import('../shared/contract.ts').SkillReviewResult>('skillReview', input, signal),
    skillBacktest: (input: import('../shared/contract.ts').SkillBacktestInput, signal?: AbortSignal) =>
      call<import('../shared/contract.ts').SkillBacktestResult>('skillBacktest', input, signal),
    organizeMemory: (input: UiCreateInput, signal?: AbortSignal) => call<import('../shared/contract.ts').UiSaveResult>('organizeMemory', input, signal),
    create: (input: UiCreateInput, signal?: AbortSignal): Promise<UiCreateResult> => call<UiCreateResult>('create', input, signal),
    edit: (input: UiEditInput, signal?: AbortSignal): Promise<UiEditResult> => call<UiEditResult>('edit', input, signal),
    withdraw: (input: UiWithdrawInput, signal?: AbortSignal): Promise<UiWithdrawResult> => call<UiWithdrawResult>('withdraw', input, signal),
    explore: (input: { query: string; limit?: number; minScore?: number }, signal?: AbortSignal): Promise<UiExplore> => call<UiExplore>('explore', input, signal),
    graph: (input: { scope?: 'all' | 'global' | 'project'; projectId?: string; limit?: number }, signal?: AbortSignal): Promise<UiGraph> => call<UiGraph>('graph', input, signal),
    injection: (signal?: AbortSignal): Promise<UiInjection | null> => call<UiInjection | null>('injection', {}, signal),
    rules: (signal?: AbortSignal): Promise<UiRule[]> => call<UiRule[]>('rules', {}, signal),
    createRule: (input: UiRuleCreateInput, signal?: AbortSignal): Promise<UiRule> => call<UiRule>('createRule', input, signal),
    editRule: (input: UiRuleEditInput & { ruleId: string }, signal?: AbortSignal): Promise<UiRule> => call<UiRule>('editRule', input, signal),
    saveArchive: (input: import('../shared/contract.ts').UiArchiveDraft & { entryId?: string; baseVersion?: number }): Promise<UiArchive> => call<UiArchive>('saveArchive', input),
    archives: (signal?: AbortSignal): Promise<UiArchive[]> => call<UiArchive[]>('archives', {}, signal),
    sync: (signal?: AbortSignal): Promise<UiSyncStatus> => call<UiSyncStatus>('sync', {}, signal),
    syncRefresh: (signal?: AbortSignal): Promise<UiSyncPass> => call<UiSyncPass>('syncRefresh', {}, signal),
    /** Grouped settings with the source of each value; never carries the token. */
    settings: (signal?: AbortSignal): Promise<UiSettings> => call<UiSettings>('settings', {}, signal),
    saveInterface: (patch: { defaultTab?: string; pageSize?: number }, signal?: AbortSignal): Promise<UiSettings> => call<UiSettings>('saveInterface', patch, signal),
    saveConnection: (input: { serverUrl?: string; hostId?: string }, signal?: AbortSignal): Promise<UiSettings> => call<UiSettings>('saveConnection', input, signal),
    saveInjection: (input: { injectTimeoutMs?: number }, signal?: AbortSignal): Promise<UiSettings> => call<UiSettings>('saveInjection', input, signal),
    saveAutoStart: (enabled: boolean, signal?: AbortSignal): Promise<UiSettings> => call<UiSettings>('saveAutoStart', { enabled }, signal),
    /** Ask the Host to register the scheduled task; it raises one elevation prompt. */
    registerTask: (signal?: AbortSignal): Promise<UiRegisterTest> => call<UiRegisterTest>('registerTask', {}, signal),
    testConnection: (input: { serverUrl?: string }, signal?: AbortSignal): Promise<UiConnectionTest> => call<UiConnectionTest>('testConnection', input, signal),
    testWake: (input: { serverUrl?: string }, signal?: AbortSignal): Promise<UiWakeTest> => call<UiWakeTest>('testWake', input, signal),
  };
}

export type MnemoWeaveApi = ReturnType<typeof createApi>;
