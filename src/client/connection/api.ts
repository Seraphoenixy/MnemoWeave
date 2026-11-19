import {
  MNEMON_ACTIVATION_CHANNEL,
  MNEMON_PACK_CHANNEL,
  MNEMON_READ_CHANNEL,
  MNEMON_REVIEW_CHANNEL,
  MNEMON_SYNC_CHANNEL,
  MNEMON_WRITE_CHANNEL,
  MNEMON_VIEW_CHANNEL,
  MNEMON_VIEW_WRITE_CHANNEL,
  type ActivityClearResult,
  type ActivityRecordView,
  type MemoryViewDashboard,
  type MemoryViewConfigurationRequest,
  type AssistantMessageText,
  type SkillActivitySnapshot,
  type ClientConnectionHandle,
  type DiagnosticEntry,
  type JsonValue,
  type MemoryCompositionStatus,
  type MemorySourceManagementCatalog,
  type MemorySourceManagementResult,
  type MnemonPackComponent,
  type MnemonRpcChannel,
  type MnemonRpcEndpoint,
  type MnemonPackExport,
  type MnemonPackImportResult,
  type MnemonPackPreview,
  type MnemonPackTarget,
  type MnemonReconcileResult,
  type MnemonReviewApplyResult,
  type MnemonReviewEntry,
  type MnemonReviewLedgerView,
  type StatusView,
  type SupervisedWritebackResult,
  type SyncProgressView,
  type TaskAgentModelCatalog,
  type TurnMemoryActivity,
  type TurnMemoryActivitySnapshot,
  type VersionComponentId,
  type VersionStatus,
  type VersionUpdateResult,
} from "../../host/contracts/protocol.ts"
import { callMnemonRpc } from './remote-rpc.ts'

/** The channel a component's read or write operation goes on. */
type ComponentChannel<Mode extends 'read' | 'write'> = Mode extends 'read' ? typeof MNEMON_READ_CHANNEL : typeof MNEMON_WRITE_CHANNEL

interface TurnActivityCacheEntry {
  cursor: number
  activities: Map<number, TurnMemoryActivity>
  inFlight?: Promise<TurnMemoryActivitySnapshot>
}

const turnActivityCache = new WeakMap<ClientConnectionHandle, Map<string, TurnActivityCacheEntry>>()

async function loadTurnActivities(connection: ClientConnectionHandle, sessionId: string | undefined, requiredCursor: number): Promise<TurnMemoryActivitySnapshot> {
  let sessions = turnActivityCache.get(connection)
  if (sessions === undefined) {
    sessions = new Map()
    turnActivityCache.set(connection, sessions)
  }
  const key = sessionId ?? ''
  let entry = sessions.get(key)
  if (entry === undefined) {
    entry = { cursor: -1, activities: new Map() }
    sessions.set(key, entry)
  }
  if (entry.cursor >= requiredCursor) return { cursor: entry.cursor, activities: [...entry.activities.values()] }
  if (entry.inFlight !== undefined) {
    const snapshot = await entry.inFlight
    return snapshot.cursor >= requiredCursor ? snapshot : loadTurnActivities(connection, sessionId, requiredCursor)
  }

  const request = callMnemonRpc(connection, MNEMON_READ_CHANNEL, 'turn-activities', sessionId === undefined ? {} : { sessionId })
    .then(response => {
      if (!response.ok) throw new Error(response.error.message)
      const snapshot = response.value as TurnMemoryActivitySnapshot
      entry!.cursor = snapshot.cursor
      entry!.activities = new Map(snapshot.activities.map(activity => [activity.turn, activity]))
      return snapshot
    })
    .finally(() => { delete entry!.inFlight })
  entry.inFlight = request
  return request
}

export class MnemonClient {
  constructor(private readonly connection: ClientConnectionHandle, private readonly sessionId?: string, private readonly workspaceId?: string) {}

  private async call<T, Channel extends MnemonRpcChannel = MnemonRpcChannel>(channel: Channel, endpoint: MnemonRpcEndpoint<Channel>, payload: unknown): Promise<T> {
    const response = await callMnemonRpc(this.connection, channel, endpoint, payload)
    if (!response.ok) {
      // A failure the Host could name keeps that name, so the page can translate it.
      const { reason, conflictToken, target } = response.error.details as { reason?: unknown; conflictToken?: unknown; target?: unknown } | undefined ?? {}
      throw Object.assign(new Error(response.error.message), {
        ...(typeof reason === 'string' ? { reason } : {}),
        ...(typeof conflictToken === 'string' ? { conflictToken } : {}),
        ...(typeof target === 'string' ? { target } : {}),
      })
    }
    return response.value as T
  }

  private scoped<T extends object = Record<string, never>>(payload: T = {} as T): T & { sessionId?: string; workspaceId?: string } {
    return {
      ...payload,
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
      ...(this.workspaceId === undefined ? {} : { workspaceId: this.workspaceId }),
    }
  }

  /** The Host's recent activity, newest first, for the Status page's log view. */
  diagnostics(limit?: number): Promise<{ entries: DiagnosticEntry[] }> {
    return this.call(MNEMON_READ_CHANNEL, 'diagnostics', limit === undefined ? {} : { limit })
  }

  /** The structured memory events this Host recorded, newest first, for the Status page. */
  memoryActivity(limit?: number): Promise<{ records: ActivityRecordView[] }> {
    return this.call(MNEMON_READ_CHANNEL, 'memory-activity', this.scoped(limit === undefined ? {} : { limit }))
  }

  /**
   * Delete every activity event the selected workspace's stream and the global
   * Working Rules stream hold now. Each stream keeps one boundary event, which
   * travels through the sync so the server and other clients drop the same
   * records instead of keeping a history this machine no longer has.
   */
  clearMemoryActivity(): Promise<ActivityClearResult> {
    return this.call(MNEMON_WRITE_CHANNEL, 'memory-activity-clear', this.scoped())
  }

  status(): Promise<StatusView> {
    return this.call(MNEMON_READ_CHANNEL, 'status', this.scoped())
  }

  statusSummary(): Promise<StatusView> {
    return this.call(MNEMON_READ_CHANNEL, 'status-summary', this.scoped())
  }

  memorySystem(): Promise<MemoryCompositionStatus> {
    return this.call(MNEMON_READ_CHANNEL, 'memory-system', this.scoped())
  }

  viewDashboard(): Promise<MemoryViewDashboard> { return this.call(MNEMON_VIEW_CHANNEL, 'dashboard', this.scoped()) }
  applyView(configuration: MemoryViewConfigurationRequest): Promise<{ saved: true }> {
    return this.call(MNEMON_VIEW_WRITE_CHANNEL, 'apply', this.scoped({ configuration, confirmed: true }))
  }

  sourceManagementCatalog(): Promise<MemorySourceManagementCatalog> {
    return this.call(MNEMON_READ_CHANNEL, 'source-management-catalog', this.scoped())
  }

  readSourceManagement(sourceInstanceKey: string, operation: string, input: JsonValue = null): Promise<MemorySourceManagementResult> {
    return this.call(MNEMON_READ_CHANNEL, 'source-management-read', this.scoped({ sourceInstanceKey, operation, input }))
  }

  mutateSourceManagement(sourceInstanceKey: string, operation: string, input: JsonValue, expectedRevision: string, confirmed: boolean, trigger?: 'manual-save'): Promise<MemorySourceManagementResult> {
    return this.call(MNEMON_WRITE_CHANNEL, 'source-management-mutate', this.scoped({ sourceInstanceKey, operation, input, expectedRevision, confirmed, ...(trigger === undefined ? {} : { trigger }) }))
  }

  assistSource(sourceInstanceKey: string, operation: string, input: JsonValue, expectedRevision: string, confirmed: boolean, trigger?: 'manual-save'): Promise<MemorySourceManagementResult> {
    return this.call(operation === 'activation' ? MNEMON_ACTIVATION_CHANNEL : confirmed ? MNEMON_WRITE_CHANNEL : MNEMON_READ_CHANNEL, 'source-assistance', this.scoped({ sourceInstanceKey, operation, input, expectedRevision, confirmed, ...(trigger === undefined ? {} : { trigger }) }))
  }

  /** A session-scoped call reports the route that conversation's background work uses. */
  taskAgentModels(includeCatalog?: boolean): Promise<TaskAgentModelCatalog> {
    return this.call(MNEMON_READ_CHANNEL, 'task-agent-models', this.scoped(includeCatalog === undefined ? {} : { includeCatalog }))
  }

  versions(): Promise<VersionStatus> {
    return this.call(MNEMON_READ_CHANNEL, 'versions', {})
  }

  updateVersion(component: VersionComponentId): Promise<VersionUpdateResult> {
    return this.call(MNEMON_WRITE_CHANNEL, 'version-update', { component })
  }

  /**
   * One of the Host operations a page lends a component's settings, by its
   * endpoint name (component-host.ts): Memory Spaces reads its Providers and
   * embedding through these.
   */
  componentOperation<T, Mode extends 'read' | 'write' = 'read' | 'write'>(mode: Mode, endpoint: MnemonRpcEndpoint<ComponentChannel<Mode>>, payload: object): Promise<T> {
    return this.call(mode === 'read' ? MNEMON_READ_CHANNEL : MNEMON_WRITE_CHANNEL, endpoint, this.scoped(payload))
  }

  /** Settled memory-tool activity of one turn, shared across all mounted tails. */
  async turnActivity(turn: number, cursor = 0): Promise<TurnMemoryActivity | null> {
    const snapshot = await loadTurnActivities(this.connection, this.sessionId, cursor)
    return snapshot.activities.find(activity => activity.turn === turn) ?? null
  }

  /** What this conversation did with skills: each turn's uses and each review, for the turn bars. */
  skillActivity(): Promise<SkillActivitySnapshot> {
    return this.call(MNEMON_READ_CHANNEL, 'skill-activity', { sessionId: this.sessionId })
  }

  /** Plain text of one finalized assistant message; null when absent or empty. */
  assistantMessageText(messageId: string): Promise<AssistantMessageText | null> {
    return this.call(MNEMON_READ_CHANNEL, 'assistant-message', { sessionId: this.sessionId, messageId })
  }

  supervise(content: string, idempotencyKey?: string): Promise<SupervisedWritebackResult> {
    return this.call(MNEMON_WRITE_CHANNEL, 'supervise', this.scoped({ content, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) }))
  }

  packTarget(): Promise<MnemonPackTarget> {
    return this.call(MNEMON_PACK_CHANNEL, 'target', this.scoped())
  }

  exportPack(): Promise<MnemonPackExport> {
    return this.call(MNEMON_PACK_CHANNEL, 'export', this.scoped())
  }

  inspectPack(base64: string, fileName?: string): Promise<MnemonPackPreview> {
    return this.call(MNEMON_PACK_CHANNEL, 'inspect', this.scoped({ base64, ...(fileName === undefined ? {} : { fileName }) }))
  }

  importPack(base64: string): Promise<MnemonPackImportResult> {
    return this.call(MNEMON_PACK_CHANNEL, 'import', this.scoped({ base64 }))
  }

  /** Every reconciliation proposal this machine still holds. */
  reviewLedger(): Promise<MnemonReviewLedgerView> {
    return this.call(MNEMON_REVIEW_CHANNEL, 'view', {})
  }

  /**
   * One reconciliation run: it stages a proposal and writes no memory. Guidance is what
   * the reviewer wants the plan to accomplish, in their own words; blank means the plan
   * reads the memory and the branch with no instruction beyond its own rules.
   */
  reconcile(guidance?: string, scope?: import('../../host/contracts/protocol.ts').MnemonReconcileScope): Promise<MnemonReconcileResult> {
    const text = guidance?.trim() ?? ''
    return this.call(MNEMON_REVIEW_CHANNEL, 'reconcile', this.scoped({
      ...(text === '' ? {} : { guidance: text }),
      ...(scope === undefined ? {} : { scope }),
    }))
  }

  reviewOpinion(id: string, text: string, author: 'user' | 'agent' = 'user'): Promise<MnemonReviewEntry> {
    return this.call(MNEMON_REVIEW_CHANNEL, 'opinion', { id, text, author })
  }

  decideReview(id: string, status: 'accepted' | 'rejected'): Promise<MnemonReviewEntry> {
    return this.call(MNEMON_REVIEW_CHANNEL, 'decide', { id, status })
  }

  reopenReview(id: string): Promise<MnemonReviewEntry> {
    return this.call(MNEMON_REVIEW_CHANNEL, 'reopen', { id })
  }

  /** Applying a subset leaves the rest in the entry, which stays accepted. */
  applyReview(id: string, operations?: number[]): Promise<MnemonReviewApplyResult> {
    return this.call(MNEMON_REVIEW_CHANNEL, 'apply', this.scoped({ id, ...(operations === undefined ? {} : { operations }) }))
  }

  syncConnection(): Promise<{ url: string; configured: boolean; writable: boolean }> {
    return this.call(MNEMON_SYNC_CHANNEL, 'connection', {})
  }

  saveSyncConnection(url: string, password: string): ReturnType<MnemonClient['syncConnection']> {
    return this.call(MNEMON_SYNC_CHANNEL, 'save-connection', { url, password })
  }

  /** The server sync this Host runs now, and how the previous one ended. */
  syncProgress(): Promise<SyncProgressView> {
    return this.call(MNEMON_SYNC_CHANNEL, 'progress', {})
  }

  syncWithServer(resolution?: { resolve: 'local' | 'server'; conflictToken: string }): Promise<{ pulled: number; pushed: number; activityPulled: number; activityPushed: number }> {
    return this.call(MNEMON_SYNC_CHANNEL, 'sync-all', resolution === undefined ? {} : { ...resolution, confirmed: true })
  }
}
