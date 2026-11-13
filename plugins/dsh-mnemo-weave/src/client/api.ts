import type {
  MemoriesRequest, RpcResult, UiArchive, UiArchiveCapacity, UiArchiveHistory, UiArchiveSearch, UiCreateInput, UiCreateResult, UiConfigView, UiConnectionTest, UiEditInput, UiEditResult, UiExplore, UiGraph, UiInjection, UiMemoryDetail, UiMemoryList, UiRegisterTest, UiRule, UiRuleCreateInput, UiRuleEditInput, UiRuleUsage, UiSettings, UiStatus, UiSyncPass, UiSyncStatus, UiWakeTest, UiWithdrawInput, UiWithdrawResult, UiWorkspace,
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
    skillsList: (input: { workspace?: string }, signal?: AbortSignal) => call<import('../shared/contract.ts').UiSkillReport>('skillsList', input, signal),
    skillVersions: (input: { path: string; workspace?: string }, signal?: AbortSignal) => call<import('../shared/contract.ts').UiSkillVersion[]>('skillVersions', input, signal),
    skillCreate: (input: { root: string; name: string; description: string; body?: string; workspace?: string }, signal?: AbortSignal) => call<import('../shared/contract.ts').UiSkillCreateResult>('skillCreate', input, signal),
    skillAdoptDraft: (input: { id: string; baselineHash: string }, signal?: AbortSignal) => call<{ draft: import('../shared/contract.ts').UiSkillDraft; hash: string; version: import('../shared/contract.ts').UiSkillVersion }>('skillAdoptDraft', input, signal),
    skillDrafts: (input: { workspace?: string; skillPath?: string }, signal?: AbortSignal) => call<import('../shared/contract.ts').UiSkillDraft[]>('skillDrafts', input, signal),
    skillSaveDraft: (input: Omit<import('../shared/contract.ts').UiSkillDraft, 'id' | 'createdAt' | 'adoptedAt' | 'dismissedAt'>, signal?: AbortSignal) => call<import('../shared/contract.ts').UiSkillDraft>('skillSaveDraft', input, signal),
    skillDismissDraft: (input: { id: string }, signal?: AbortSignal) => call<import('../shared/contract.ts').UiSkillDraft>('skillDismissDraft', input, signal),
    skillRead: (input: { path: string; workspace?: string }, signal?: AbortSignal) => call<import('../shared/contract.ts').UiSkillText>('skillRead', input, signal),
    skillVersionText: (input: { path: string; versionId: string; workspace?: string }, signal?: AbortSignal) => call<import('../shared/contract.ts').UiSkillText>('skillVersionText', input, signal),
    skillTrash: (input: { path: string; workspace?: string }, signal?: AbortSignal) => call<import('../shared/contract.ts').UiTrashEntry>('skillTrash', input, signal),
    skillTrashList: (signal?: AbortSignal) => call<import('../shared/contract.ts').UiTrashEntry[]>('skillTrashList', {}, signal),
    skillTrashRestore: (input: { id: string; workspace?: string }, signal?: AbortSignal) => call<import('../shared/contract.ts').UiTrashEntry>('skillTrashRestore', input, signal),
    skillAdopt: (input: { path: string; candidate: string; baselineHash: string; workspace?: string }, signal?: AbortSignal) => call<import('../shared/contract.ts').UiSkillWrite>('skillAdopt', input, signal),
    skillRestore: (input: { path: string; versionId: string; baselineHash: string; workspace?: string }, signal?: AbortSignal) => call<import('../shared/contract.ts').UiSkillWrite>('skillRestore', input, signal),
    skillBacktest: (input: import('../shared/contract.ts').SkillBacktestInput, signal?: AbortSignal) =>
      call<import('../shared/contract.ts').SkillBacktestResult>('skillBacktest', input, signal),
    organizeMemory: (input: UiCreateInput, signal?: AbortSignal) => call<import('../shared/contract.ts').UiSaveResult>('organizeMemory', input, signal),
    organizeMemories: (input: { instruction: string; workspaceId?: string }, signal?: AbortSignal) => call<import('../shared/contract.ts').UiOrganizePlan>('organizeMemories', input, signal),
    /** Apply only the ticked plan items; the task id keeps a retry on the same receipts. */
    applyOrganizeMemories: (input: { instruction: string; plan: import('../shared/contract.ts').UiOrganizePlan; confirmed: number[]; taskId: string }, signal?: AbortSignal) =>
      call<import('../shared/contract.ts').UiOrganizeResult>('organizeMemories', { ...input, apply: true }, signal),
    embeddingBackfill: () => call<import('../shared/contract.ts').UiDiagnosticJob>('embeddingBackfill', {}),
    embeddingBackfillHistory: (signal?: AbortSignal) => call<{ items: import('../shared/contract.ts').UiDiagnosticJob[] }>('embeddingBackfillHistory', {}, signal),
    idleReviewRecent: (signal?: AbortSignal) => call<{ items: import('../shared/contract.ts').UiIdleReviewRun[] }>('idleReviewRecent', {}, signal),
    idleReviewSkips: (signal?: AbortSignal) => call<{ items: import('../shared/contract.ts').UiIdleSkip[] }>('idleReviewSkips', {}, signal),
    writeTasks: (signal?: AbortSignal) => call<{ items: import('../shared/contract.ts').UiPendingWrite[] }>('writeTasks', {}, signal),
    resolveWrite: (input: { taskId: string; index: number }, signal?: AbortSignal) =>
      call<import('../shared/contract.ts').WriteTaskOutcome>('resolveWrite', input, signal),
    retryWrite: (input: { taskId: string; index: number }, signal?: AbortSignal) =>
      call<import('../shared/contract.ts').WriteTaskOutcome>('retryWrite', input, signal),
    replyPreview: (input: { sessionId: string; replyId: string }, signal?: AbortSignal) =>
      call<{ text: string; turnId: string } | null>('replyPreview', input, signal),
    replySave: (input: { taskId: string; sessionId: string; replyId: string; turnId: string; content: string; category?: string; reason?: string }, signal?: AbortSignal) =>
      call<import('../shared/contract.ts').WriteTaskOutcome>('replySave', input, signal),
    create: (input: UiCreateInput, signal?: AbortSignal): Promise<UiCreateResult> => call<UiCreateResult>('create', input, signal),
    edit: (input: UiEditInput, signal?: AbortSignal): Promise<UiEditResult> => call<UiEditResult>('edit', input, signal),
    withdraw: (input: UiWithdrawInput, signal?: AbortSignal): Promise<UiWithdrawResult> => call<UiWithdrawResult>('withdraw', input, signal),
    explore: (input: { query: string; limit?: number; hint?: string; mode?: 'smart' | 'keyword' | 'basic'; category?: string }, signal?: AbortSignal): Promise<UiExplore> => call<UiExplore>('explore', input, signal),
    graph: (input: { limit?: number }, signal?: AbortSignal): Promise<UiGraph> => call<UiGraph>('graph', input, signal),
    /** Workspaces this Host may reach. A host response carries no local path. */
    workspaces: (signal?: AbortSignal): Promise<UiWorkspace[]> => call<UiWorkspace[]>('workspaces', {}, signal),
    /** Official embedding coverage and the recall mode; shown on the settings page. */
    embeddingDiagnostics: (signal?: AbortSignal): Promise<import('../shared/contract.ts').UiEmbeddingDiagnostics> =>
      call<import('../shared/contract.ts').UiEmbeddingDiagnostics>('embeddingDiagnostics', {}, signal),
    injection: (signal?: AbortSignal): Promise<UiInjection | null> => call<UiInjection | null>('injection', {}, signal),
    rules: (signal?: AbortSignal): Promise<UiRule[]> => call<UiRule[]>('rules', {}, signal),
    ruleUsage: (signal?: AbortSignal): Promise<UiRuleUsage> => call<UiRuleUsage>('ruleUsage', {}, signal),
    saveRuleLimits: (input: { capacityBytes: number; itemMaxBytes: number }): Promise<true> => call<true>('saveRuleLimits', input),
    createRule: (input: UiRuleCreateInput, signal?: AbortSignal): Promise<UiRule> => call<UiRule>('createRule', input, signal),
    editRule: (input: UiRuleEditInput & { ruleId: string }, signal?: AbortSignal): Promise<UiRule> => call<UiRule>('editRule', input, signal),
    saveArchive: (input: import('../shared/contract.ts').UiArchiveDraft & { entryId?: string; baseVersion?: number }): Promise<UiArchive> => call<UiArchive>('saveArchive', input),
    archives: (workspaceId: string, signal?: AbortSignal): Promise<UiArchive[]> => call<UiArchive[]>('archives', { workspaceId }, signal),
    archiveCapacities: (workspaceId: string, signal?: AbortSignal): Promise<UiArchiveCapacity[]> => call<UiArchiveCapacity[]>('archiveCapacities', { workspaceId }, signal),
    archiveSearch: (input: { workspaceId: string; query: string; limit?: number; includeArchived?: boolean }): Promise<UiArchiveSearch> => call<UiArchiveSearch>('archiveSearch', input),
    archiveHistory: (entryId: string, signal?: AbortSignal): Promise<UiArchiveHistory[]> => call<UiArchiveHistory[]>('archiveHistory', { entryId }, signal),
    /** Capacity maintenance: what would free room, oldest-confirmed first. */
    archiveReleaseCandidates: (workspaceId: string, limit?: number, signal?: AbortSignal): Promise<import('../shared/contract.ts').UiArchiveReleaseCandidates> =>
      call<import('../shared/contract.ts').UiArchiveReleaseCandidates>('archiveReleaseCandidates', { workspaceId, ...(limit === undefined ? {} : { limit }) }, signal),
    setArchiveState: (input: { entryId: string; state: 'active' | 'archived'; baseVersion: number; changeId?: string }): Promise<UiArchive> => call<UiArchive>('setArchiveState', input),
    /** 「提炼为正式记忆」 preview: creates a draft, publishes nothing. */
    distillArchive: (entryId: string, signal?: AbortSignal): Promise<import('../shared/contract.ts').UiDistillationDraft | import('../shared/contract.ts').UiDistillationSkip> =>
      call<import('../shared/contract.ts').UiDistillationDraft | import('../shared/contract.ts').UiDistillationSkip>('distillArchive', { entryId }, signal),
    readDistillation: (draftId: string): Promise<import('../shared/contract.ts').UiDistillationDraft> =>
      call<import('../shared/contract.ts').UiDistillationDraft>('readDistillation', { draftId }),
    reviseDistillation: (input: { draftId: string; content: string; category: string }): Promise<import('../shared/contract.ts').UiDistillationDraft> =>
      call<import('../shared/contract.ts').UiDistillationDraft>('reviseDistillation', input),
    confirmDistillation: (input: { draftId: string; reason?: string }): Promise<import('../shared/contract.ts').UiDistillationResult> =>
      call<import('../shared/contract.ts').UiDistillationResult>('confirmDistillation', input),
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
