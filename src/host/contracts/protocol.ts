/** Starter Entry ids remain reserved when DSH nests them under an include. */
export function isDefaultSourceInstance(instanceKey: string, sourceTypeId: string): boolean {
  return instanceKey.startsWith('source:') && instanceKey.endsWith(':mnemon-source-' + sourceTypeId)
}
/**
 * The Source of one type a named tool works on: the Starter instance, the Entry
 * `mnemon-source-<type>` also when nested under an include, or the only instance there
 * is. Among several others there is none, and each keeps its exact offers.
 */
export function namedToolInstance<T extends { sourceInstanceKey: string }>(instances: readonly T[], sourceTypeId: string): T | undefined {
  return instances.find(source => isDefaultSourceInstance(source.sourceInstanceKey, sourceTypeId)) ?? (instances.length === 1 ? instances[0] : undefined)
}
export type MemoryParticipationMode = 'off' | 'manual' | 'automatic'
export type MemoryParticipationChannel = 'recall' | 'write' | 'projection' | 'maintenance'
export type MemoryLayerParticipation = Record<MemoryParticipationChannel, MemoryParticipationMode>
export interface MemoryCompositionStatus {
  /** Whether a composition serves new turns. A rejected change can leave the previous one serving. */
  serving: boolean
  /** The main Strategy composing the serving composition, which a fallback can make differ from the selected one. */
  strategyTypeId?: string
  /** Strategy support only; session policy and review settings can still prevent a run. */
  workflows?: { idleReview: boolean; runtimeCapacity: boolean }
  evaluation: import('../../core/contracts/index.ts').MemoryCompositionEvaluationReport
  sources: MemorySourceManagementInstance[]
  configuration: ResolvedMemoryTopologyConfig
}

import type { RecallQualityConfig, ResolvedRecallQualityConfig, MnemonEmbeddingConfig, ResolvedMnemonEmbeddingConfig } from 'dsh-mnemo-weave/source-memory-spaces/contracts'
import type {
  MemoryPersistenceStrategy,
  ResolvedMemoryPersistenceStrategy,
  MemoryProviderRuntimeStatus,
  Source,
  MemorySpaceStats,
  MemorySpaceView,
} from 'dsh-mnemo-weave/source-memory-spaces/contracts'
import type { ConnectionHandle as DshClientConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { DocumentMutationResult, DocumentSnapshot } from 'dsh-mnemo-weave/source-documents/contracts'
import type { RuntimeMemoryMutationResult } from 'dsh-mnemo-weave/source-runtime/contracts'
import type { MemoryMigrationLineage, MemoryMutationReceipt } from '../../core/contracts/index.ts'
import { MNEMON_VIEW_CHANNEL, MNEMON_VIEW_WRITE_CHANNEL } from './view-protocol.ts'

export const MNEMON_READ_CHANNEL = '/dsh-mnemo-weave-read'
export const MNEMON_ACTIVATION_CHANNEL = '/dsh-mnemo-weave-activation'
export const MNEMON_WRITE_CHANNEL = '/dsh-mnemo-weave-write'
export const MNEMON_PACK_CHANNEL = '/dsh-mnemo-weave-pack'
export const MNEMON_MACHINE_LABEL_MAX = 120
export function machineLabelValid(label: string): boolean {
  return label !== '' && label.length <= MNEMON_MACHINE_LABEL_MAX && !/[\p{Cc}\u2028\u2029]/u.test(label)
}

export const MNEMON_SYNC_CHANNEL = '/dsh-mnemo-weave-sync'
export const MNEMON_SETTINGS_CHANNEL = '/dsh-mnemo-weave-settings'
/**
 * Reconciliation is the only channel that changes memory after a human read it:
 * it stages proposals into a review ledger, takes opinions, and applies an
 * accepted entry. It is deliberately separate from the write channel.
 */
export const MNEMON_REVIEW_CHANNEL = '/dsh-mnemo-weave-review'
/** DSH API Gateway endpoints used by paired remote Web clients. */
export const MNEMON_REMOTE_CHANNEL = '/api'
export const MNEMON_REMOTE_NAMESPACE = 'dshMnemon'
export const MNEMON_REMOTE_READ_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/read`
export const MNEMON_REMOTE_ACTIVATION_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/activation`
export const MNEMON_REMOTE_WRITE_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/write`
export const MNEMON_REMOTE_PACK_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/pack`
export const MNEMON_REMOTE_SYNC_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/sync`
export const MNEMON_REMOTE_SETTINGS_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/settings`
export const MNEMON_REMOTE_VIEW_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/view`
export const MNEMON_REMOTE_VIEW_WRITE_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/viewWrite`
export const MNEMON_REMOTE_REVIEW_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/review`
export const MNEMON_SETTINGS_NAMESPACE = 'mnemon'
export const MNEMON_UI_SETTINGS_NAMESPACE = 'mnemon-ui'
/** 技能管理's settings: one live group of the dsh-mnemo-weave entry, drawn on that component's page. */
export const MNEMON_SKILLS_SETTINGS_NAMESPACE = 'mnemon-skills'
export * from './view-protocol.ts'
export * from './memory-tools.ts'

/**
 * Every endpoint the Host serves on each channel, by the names both sides use: the client's calls
 * are typed against this list, and each Host handler must serve exactly these names.
 */
export const MNEMON_RPC_ENDPOINTS = {
  [MNEMON_READ_CHANNEL]: [
    'status', 'status-summary', 'memory-system', 'versions', 'task-agent-models', 'runtime-memory', 'documents', 'document', 'document-search',
    'graph', 'bodies', 'body-directory', 'body-reconnect', 'provider-services', 'provider-service-check', 'embedding-status', 'local-embedding-status', 'list', 'entities', 'search', 'agent-search', 'related',
    'turn-activities', 'turn-activity', 'skill-activity', 'assistant-message', 'source-management-catalog', 'source-management-read', 'source-assistance',
    'diagnostics', 'memory-activity',
  ],
  [MNEMON_ACTIVATION_CHANNEL]: ['body', 'source-assistance'],
  [MNEMON_WRITE_CHANNEL]: [
    'runtime-memory', 'document', 'supervise', 'remember', 'link', 'forget', 'body-create', 'body-update', 'body-delete', 'body-merge',
    'body-metadata-maintain', 'provider-service-update', 'embedding-fill', 'local-embedding-deploy', 'local-embedding-control', 'source-management-mutate', 'source-assistance', 'version-update',
    'memory-activity-clear',
  ],
  [MNEMON_PACK_CHANNEL]: ['target', 'export', 'inspect', 'import'],
  [MNEMON_SYNC_CHANNEL]: ['connection', 'save-connection', 'progress', 'sync-all', 'server-sync', 'server-sync-rules', 'server-sync-activity'],
  [MNEMON_REVIEW_CHANNEL]: ['view', 'opinion', 'decide', 'reopen', 'reconcile', 'apply'],
  [MNEMON_SETTINGS_CHANNEL]: ['get', 'mutate'],
  [MNEMON_VIEW_CHANNEL]: ['dashboard', 'preview', 'inspect-plugin'],
  [MNEMON_VIEW_WRITE_CHANNEL]: ['apply', 'install-plugin'],
} as const satisfies Readonly<Record<string, readonly string[]>>
/** A channel the Host serves. */
export type MnemonRpcChannel = keyof typeof MNEMON_RPC_ENDPOINTS
/** An endpoint the Host serves on a channel, or on any of several. */
export type MnemonRpcEndpoint<Channel extends MnemonRpcChannel = MnemonRpcChannel> = (typeof MNEMON_RPC_ENDPOINTS)[Channel][number]

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

/**
 * What a server sync is doing now: opening the connection, walking the named
 * memory scopes, then the activity records. A page names each one in its own
 * language, so the phase stays a fixed token.
 */
export type SyncPhase = 'prepare' | 'snapshot' | 'activity'

/** How one server sync ended, kept for the page until the next run starts. */
export interface SyncOutcomeView {
  state: 'done' | 'failed'
  finishedAt: string
  durationMs: number
  pulled: number
  pushed: number
  activityPulled: number
  activityPushed: number
  /** The memory scope a conflict stopped the run on, by the name the page shows. */
  conflictTarget?: string
  error?: string
}

/**
 * One line of what the Host did, for a person reading the Status page after
 * something went wrong. A line names its area, what happened, and — when it
 * failed — why, with the cause chain a bare `fetch failed` does not carry.
 */
export type DiagnosticLevel = 'info' | 'warning' | 'error'

export interface DiagnosticEntry {
  /** Milliseconds since the epoch, so the page formats it in its own locale. */
  at: number
  level: DiagnosticLevel
  /** Where the line came from: `sync`, `memory`, `server`, … */
  area: string
  message: string
  /** Extra facts that help without being prose, such as a scope name or a duration. */
  detail?: string
}

/** One recorded memory activity event, as the Status page lists it. */
export interface ActivityRecordView {
  /** Milliseconds since the epoch, so the page formats it in its own locale. */
  at: number
  kind: 'memory' | 'subagent'
  source?: string
  operation: string
  outcome: string
  trigger?: string
  skipReason?: string
  results?: number
  /** A delegated child's task type shares `operation`; these describe its run. */
  durationMs?: number
  committedWrites?: number
  replayed?: boolean
  usage?: {
    uncachedInputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  }
  /** Local-only failure or diagnostic detail (never synced across machines). */
  detail?: string
  /** Which stream the event was recorded in: the selected workspace, or the global Working Rules stream. */
  stream: 'workspace' | 'working rules'
}

/**
 * How many events one clear stopped showing, per stream. The events themselves
 * stay on disk as immutable records; a retraction hides them here and, after a
 * sync, on every other client.
 */
export interface ActivityClearResult {
  workspace: number
  rules: number
}

/** A server sync in flight, and the one before it. */
export interface SyncProgressView {  running: boolean
  phase?: SyncPhase
  /** The memory scope being synchronized, when the step has one. */
  target?: string
  /** The step in flight, and how many the run walks; both counted from one. */
  step?: number
  steps?: number
  /** Items carried so far in the current step, and how many it holds. */
  done?: number
  total?: number
  /** Present while a run is in flight. */
  startedAt?: string
  last?: SyncOutcomeView
}

export interface MemorySourceManagementField {
  key: string
  label: string
  description?: string
  input: 'text' | 'number' | 'boolean' | 'url' | 'secret' | 'select'
  required: boolean
  secret?: boolean
  options?: Array<{ value: string; label: string }>
}

/** Browser-safe descriptor of one Source instance visible in the current scope. */
export interface MemorySourceManagementInstance {
  sourceInstanceKey: string
  sourceTypeId: string
  packageName: string
  role: string
  availability: 'ready' | 'degraded' | 'unavailable'
  revision: string
  capabilities: string[]
  assistance?: readonly string[]
  management: {
    label: string
    description: string
    fields?: MemorySourceManagementField[]
    diagnostics?: string[]
  }
  hints?: JsonValue
}

export interface MemorySourceManagementCatalog {
  generationId: string
  sources: MemorySourceManagementInstance[]
}

export interface MemorySourceManagementResult {
  revision: string
  value: JsonValue
}

export type RpcError =
  | { code: 'bad-request'; message: string; details: { issues: JsonValue[] } }
  | { code: 'settings-rejected'; message: string; details: { ns: string } }
  /** `reason` names a failure the page can state in its own language, such as a sync remote refusing credentials. */
  | { code: 'internal'; message: string; details: Record<string, never> | { reason: string } }

export type RpcResult<T = JsonValue> =
  | { ok: true; value: T }
  | { ok: false; error: RpcError }

/** Public DSH browser RPC face plus the transport boundary needed to gate local-only writes. */
export type ClientConnectionHandle = Pick<DshClientConnectionHandle, 'rpc' | 'isLoopback'>

export interface ClientSettingsSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable'
  value?: T
  base?: unknown
  user?: unknown
  revision?: number
  writable: boolean
  mode: 'host' | 'memory'
}

export interface ClientSettingsScope<T> {
  getSnapshot(): ClientSettingsSnapshot<T>
  subscribe(listener: () => void): () => void
  mutate(ops: SettingsOperation[]): Promise<void>
}

export type SettingsOperation = { op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }

export type StorageScopeKind = 'global' | 'workspace' | 'custom' | 'workspaces'

export function isWorkspaceStorageScope(scope: string | undefined): boolean {
  return scope === 'workspace' || scope === 'workspaces'
}

export interface MemoryLayerConfig {
  enabled?: boolean
  participation?: Partial<MemoryLayerParticipation>
  adapterIds?: string[]
}

export interface MemoryTopologyConfig {
  id?: string
  strategyId?: string
  layers?: Record<string, MemoryLayerConfig>
}

export interface ResolvedMemoryLayerConfig {
  enabled: boolean
  participation: MemoryLayerParticipation
  adapterIds: string[]
}

export interface ResolvedMemoryTopologyConfig {
  id: string
  strategyId: string
  layers: Record<string, ResolvedMemoryLayerConfig>
}

export interface CustomPackConfig {
  id: string
  name: string
  dataDir: string
}

export interface RuntimeMemoryConfig {
  /** Automatically project Runtime memory into newly created child Agents; off by default. */
  inheritToSubagents?: boolean
  /** Maximum UTF-8 bytes projected into MEMORY.md. */
  memoryLimitBytes?: number
  /** Maximum UTF-8 bytes projected into USER.md. */
  userLimitBytes?: number
  /** Completion-token budget for Runtime migration and compaction workers. */
  maintenanceMaxTokens?: number
}

export interface ResolvedRuntimeMemoryConfig {
  inheritToSubagents: boolean
  memoryLimitBytes: number
  userLimitBytes: number
  maintenanceMaxTokens: number
}

export { STARTER_COMPONENT_ROWS } from './starter-components.ts'
export { normalizeDisplayMode } from './display-mode.ts'
export type MnemonDisplayMode = 'sidebar' | 'builtin'

export const DEFAULT_IDLE_REVIEW = {
  enabled: true,
  runtimeMemory: true,
  persistWatermark: false,
  provider: 'spawn',
  fallback: 'spawn',
  agentTeams: 'pause',
  minIntervalMs: 300_000,
  maxPerSession: 20,
  maxContextChars: 24_000,
  maxTokens: 16_384,
} satisfies ResolvedIdleReviewConfig

export interface ResolvedIdleReviewConfig {
  enabled: boolean
  /** Whether review may change USER.md and MEMORY.md; it can create Documents either way. */
  runtimeMemory: boolean
  /** Preserve attempt quota and cooling time for the same persisted parent session. */
  persistWatermark: boolean
  provider: 'spawn' | 'fork'
  /** Applies only before a child starts; a failed run is never replayed. */
  fallback: 'spawn' | 'skip'
  /** Explicit opt-in for compatible Team policies; tool isolation is mandatory. */
  agentTeams: 'pause' | 'scoped'
  minIntervalMs: number
  maxPerSession: number
  maxContextChars: number
  maxTokens: number
}

/**
 * A server sync the Host runs on a timer, so two machines converge without
 * anyone pressing a button. A run that ends on a conflict pauses the timer
 * until a person resolves it, because only a person can decide which copy
 * survives.
 */
export const DEFAULT_AUTO_SYNC = {
  enabled: true,
  intervalMs: 900_000,
} satisfies ResolvedAutoSyncConfig

export interface ResolvedAutoSyncConfig {
  enabled: boolean
  /** How long the Host waits after one run ends before starting the next. */
  intervalMs: number
}

export interface Config {
  storageScope?: StorageScopeKind
  /** Whether USER.md follows the selected storage root or stays in the global root. */
  runtimeUserScope?: 'storage' | 'global'
  excludedWorkspaces?: string[]
  cliPath?: string
  dataDir?: string
  customPackId?: string
  customPacks?: CustomPackConfig[]
  store?: string
  timeoutMs?: number
  defaultRecallLimit?: number
  runtimeMemory?: RuntimeMemoryConfig
  /** Optional DSH-owned overrides injected into every Mnemon CLI process. */
  embedding?: MnemonEmbeddingConfig
  memoryTopology?: MemoryTopologyConfig
  /** Profile-owned plugin choices. */
  memoryView?: import('./view-protocol.ts').MemoryViewPreferences
  /** Successful import of this profile's removed settings namespaces. */
  recallQuality?: RecallQualityConfig
  routingGuidance?: boolean
  /** Entry placement only. Legacy `buildin` input is migrated to `builtin`. */
  displayMode?: MnemonDisplayMode | 'buildin'
  tabEnabled?: boolean
  writeEnabled?: boolean
  /** Remote management grant for paired pages; loopback pages keep full access. */
  remoteAccess?: 'read-only' | 'trusted-host'
  lifecycleEnabled?: boolean
  recallMode?: 'guided' | 'off'
  writebackMode?: 'guided' | 'off'
  idleReviewMs?: number
  idleReview?: Partial<ResolvedIdleReviewConfig>
  /** Whether, and how often, the Host runs a server sync on its own. */
  autoSync?: Partial<ResolvedAutoSyncConfig>
  conversationInteraction?: {
    /** @deprecated Switches nothing. Stored profiles may still hold it; the resolved config leaves it out. */
    toolviews?: boolean
    turnBar?: boolean
    saveAction?: boolean
  }
  /** 技能管理: skill evolution and where the page shows. */
  skills?: SkillsConfig
  /** Provider policy used when an Agent must create a new Memory Space while distilling memory. */
  persistenceStrategy?: MemoryPersistenceStrategy
  /** Model route used by clean, session-independent maintenance Agents. */
  taskAgentModel?: TaskAgentModelConfig
  /** Additional provider names for Hosts without enumeration and opaque provider plugins. */
  subagentProviderNames?: string[]
}

export interface TaskAgentModelConfig {
  mode?: 'inherit' | 'fixed'
  provider?: string
  model?: string
  /**
   * With `inherit`, run on the model the conversation that asked for the work
   * last used, while that conversation is open. Off by default; a switch
   * rather than a third mode, so a release that does not know it keeps
   * reading `inherit` as before.
   */
  followConversation?: boolean
}

export interface ResolvedTaskAgentModelConfig {
  mode: 'inherit' | 'fixed'
  provider?: string
  model?: string
  /** Present, and true, only on an inherited route that follows its conversation. */
  followConversation?: true
}

// The model directory lives in the browser-safe contract module so a plugin's
// client can name it; re-exported here so one declaration serves both sides.
export type {
  TaskAgentModelCatalog, TaskAgentModelCatalogFailure, TaskAgentModelCatalogGroup, TaskAgentModelCatalogModel,
} from '../../core/contracts/task-agent-model.ts'

export interface InteractionConfig {
  turnBar?: boolean
  saveAction?: boolean
}

export interface ResolvedConfig {
  storageScope: StorageScopeKind
  runtimeUserScope: 'storage' | 'global'
  excludedWorkspaces: string[]
  cliPath?: string
  dataDir?: string
  store?: string
  timeoutMs: number
  defaultRecallLimit: number
  runtimeMemory: ResolvedRuntimeMemoryConfig
  embedding: ResolvedMnemonEmbeddingConfig
  memoryTopology: ResolvedMemoryTopologyConfig
  recallQuality: ResolvedRecallQualityConfig
  routingGuidance: boolean
  displayMode: MnemonDisplayMode
  tabEnabled: boolean
  writeEnabled: boolean
  /** Remote management grant for paired pages; loopback pages keep full access. */
  remoteAccess: 'read-only' | 'trusted-host'
  lifecycleEnabled: boolean
  recallMode: 'guided' | 'off'
  writebackMode: 'guided' | 'off'
  idleReviewMs: number
  idleReview: ResolvedIdleReviewConfig
  autoSync: ResolvedAutoSyncConfig
  conversationInteraction: {
    turnBar: boolean
    saveAction: boolean
  }
  persistenceStrategy: ResolvedMemoryPersistenceStrategy
  taskAgentModel: ResolvedTaskAgentModelConfig
  subagentProviderNames: string[]
}

export interface ResolvedInteractionConfig {
  turnBar: boolean
  saveAction: boolean
}

/** 技能管理's settings, as stored; every key is optional and falls back to its default. */
export type SkillsConfig = Partial<ResolvedSkillsConfig>

export interface ResolvedSkillsConfig {
  /** Review finished conversations in the background and suggest new or better skills. */
  evolution: boolean
  /** Allow reviews to suggest new skills. Existing suggestions remain actionable. */
  allowCreate: boolean
  /** Allow reviews to suggest changes to existing skills. */
  allowUpdate: boolean
  /** Opt in to editing the original targets of linked existing skills. */
  allowLinkedUpdates: boolean
  /** Destination for new skill proposals; user preserves the pre-setting behavior. */
  targetScope: 'storage' | 'user' | 'project'
  /** Backtest a draft against the current version as soon as it is written. */
  autoBacktest: boolean
  /** Opt-in automatic drafting and evaluated adoption of new idle-review suggestions. */
  autoAdopt: boolean
  /** Candidates admitted each calendar day, shared by the Skills storage root. */
  autoAdoptDailyLimit: number
  /** IANA time zone, or local for the Host process time zone. */
  autoAdoptTimeZone: string
  /** Output budget for a complete skill draft, including model reasoning. */
  draftMaxTokens: number
  /** One fresh attempt after truncation, only when larger than draftMaxTokens. */
  draftRetryMaxTokens: number
  /** The one-line skills bar under a finished turn. */
  hints: boolean
  /** 技能管理 as a sidebar entry of its own instead of a Memory System page. */
  sidebar: boolean
  /** The post-turn score a conversation's window needs before it is reviewed. */
  reviewThreshold: number
  /** How long a conversation sits idle before its review runs. */
  idleSeconds: number
  /** The least time between two reviews of one conversation. */
  cooldownSeconds: number
  /** Suggestions below this confidence are dropped. */
  minConfidence: number
  /** A pending suggestion expires after this many days. */
  expiryDays: number
  /** At most this many pending suggestions from one conversation. */
  maxPendingPerSession: number
  /** At most this many cases in one backtest. */
  casesPerRun: number
}

export const DEFAULT_SKILLS_CONFIG: Readonly<ResolvedSkillsConfig> = Object.freeze({
  evolution: false,
  allowCreate: true,
  allowUpdate: true,
  allowLinkedUpdates: false,
  targetScope: 'user',
  autoBacktest: true,
  autoAdopt: false,
  autoAdoptDailyLimit: 2,
  autoAdoptTimeZone: 'local',
  draftMaxTokens: 32_768,
  draftRetryMaxTokens: 65_536,
  hints: true,
  sidebar: false,
  reviewThreshold: 5,
  idleSeconds: 20,
  cooldownSeconds: 150,
  minConfidence: 0.6,
  expiryDays: 7,
  maxPendingPerSession: 5,
  casesPerRun: 8,
})

/** Shared validation without exposing Host environment values to the browser. */
export function validSkillsTimeZone(value: string): boolean {
  if (value === 'local') return true
  if (!value || value.length > 100) return false
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return true } catch { return false }
}

/** One skill a turn used: the model loaded it, or the user asked for it with `/name`. */
export interface TurnSkillUse {
  name: string
  by: 'model' | 'user'
}

/** A skill review of a conversation, placed under the turn its window ended with. */
export interface TurnSkillReview {
  turn: number
  /** `scheduled` waits for the conversation to sit idle; the others say how it went. */
  state: 'scheduled' | 'reviewing' | 'suggested' | 'nothing' | 'error'
  /** The suggestions it left that still exist, newest first. */
  suggestions: Array<{ id: string; skillName: string; action: 'create' | 'update'; status: string }>
  error?: string
}

/** What one conversation did with skills: each turn's uses and each review, for the turn bars. */
export interface SkillActivitySnapshot {
  /** Whether a skills bar has anything to read: the Skills Source runs for this conversation. */
  available: boolean
  turns: Array<{ turn: number; skills: TurnSkillUse[] }>
  reviews: TurnSkillReview[]
}

/** What the Status page says about 技能管理. */
export interface SkillsStatusSummary {
  evolution: boolean
  skills: number
  /** Suggestions and drafts waiting for the user. */
  waiting: number
}

/**
 * Provider instance identity inside one Memory Spaces Source. Built-in ids
 * remain stable; third-party child modules may contribute additional ids.
 */
export type * from 'dsh-mnemo-weave/source-memory-spaces/contracts'

export type * from 'dsh-mnemo-weave/source-documents/contracts'
export type * from 'dsh-mnemo-weave/source-runtime/contracts'

export interface TurnMemoryActivity {
  turn: number
  count: number
  names: string[]
  recalls: number
  writes: number
  documentSearches: number
  inspections: number
  failures: number
  /** Successful evidence-bearing reads with tool-authored safe previews. */
  retrieved: MemoryActivityRead[]
  /** Only writes whose tool-authored result confirms durable commitment. */
  writebacks: MemoryActivityWriteback[]
}

export interface MemoryActivityItem {
  id: string
  title: string
  excerpt?: string
}

export interface MemoryActivityRead {
  callId: string
  toolName: string
  operationId: string
  reference?: string
  sourceTypeId?: string
  items: MemoryActivityItem[]
}

export interface MemoryActivityWriteback {
  callId: string
  toolName: string
  operationId: string
  reference?: string
  sourceTypeId?: string
  item: MemoryActivityItem
}

export interface TurnMemoryActivitySnapshot {
  cursor: number
  activities: TurnMemoryActivity[]
}

export interface AssistantMessageText {
  messageId: string
  text: string
}

export type StorageAreaKind = 'runtime' | 'memory-bodies' | 'documents' | 'state'
export type StorageAreaStatus = 'ready' | 'empty' | 'missing' | 'invalid'

export interface StorageAreaInventory {
  kind: StorageAreaKind
  path: string
  status: StorageAreaStatus
  bytes: number
  itemCount: number
  details: Record<string, number | string | boolean>
  issue?: string
}

export interface StorageScopeInventory {
  kind: StorageScopeKind
  root?: string
  configured: boolean
  active: boolean
  available: boolean
  totalBytes: number
  areas: StorageAreaInventory[]
  issue?: string
}

export interface StorageScopeCatalog {
  activeKind: StorageScopeKind
  activeRoot: string
  scopes: StorageScopeInventory[]
  generatedAt: string
}

export interface ReviewActivity {
  totalUserTextLength: number
  turnCount: number
  toolCallCount: number
  uniqueToolCount: number
}

export interface ReviewActivityScore extends ReviewActivity {
  textLengthScore: number
  turnScore: number
  toolCallScore: number
  toolDiversityScore: number
  score: number
  threshold: number
  eligible: boolean
}

export interface SubagentCounters {
  recalls: number
  writes: number
  answers: number
  reviews: number
  placements: number
  migrations: number
  compactions: number
  documentArchives: number
  metadataMaintenances: number
  reconciliations: number
  /** Skill reviews, drafts, backtest runs and case derivations. */
  skills?: number
  failures: number
  lastRunId?: string
  lastOperation?: 'recall' | 'write' | 'review' | 'placement' | 'migration' | 'compaction' | 'document-archive' | 'metadata-maintenance' | 'reconcile' | 'skill'
  lastAt?: string
}

/** What a delegated memory write did, as the write task Agent's receipts show it. */
export interface DelegatedWriteResult {
  delegated: true
  runId: string
  provider: string
  summary: string
  action: string
  /** Where the memory went: the spaces its receipts name, else what the writer reported. */
  memoryBodyIds: string[]
  /** Spaces that were inactive and that this write switched on. */
  activatedMemoryBodyIds?: string[]
  documentIds?: string[]
  /** Memories saved without a vector, as the Provider's receipt says (#388). */
  unembedded?: Array<{ memoryBodyId?: string; id?: string }>
  hint?: string
}

/** The `supervise` RPC result: a delegated write for the conversation that asked for it. */
export interface SupervisedWritebackResult extends DelegatedWriteResult { sessionId: string }

/** What a task Agent answered from the evidence a search recalled, as `agent-search` adds it to the results. */
export interface DelegatedAnswerResult {
  answer: string
  citations: string[]
  delegation: { runId: string; provider: string }
}

/** A Document write or archive the Host ran: the Documents Source's result, and the archival it ran, for the archive or to make room for the write. */
export type CoordinatedDocumentResult = DocumentMutationResult & {
  lineage?: MemoryMigrationLineage[]
  maintenance?: { runId: string; provider: string; summary: string; memoryBodyIds: string[]; archivedDocumentIds: string[] }
}

/** A runtime memory write the Host ran: the Runtime Source's result, and the capacity maintenance that ran with it. */
export type CoordinatedRuntimeMemoryResult = RuntimeMemoryMutationResult & {
  revision?: string
  maintenance?: { runId: string; provider: string; summary: string; memoryBodyIds: string[] }
  memoryReceipt?: Pick<MemoryMutationReceipt, 'status' | 'completion' | 'committedAt'>
}

export type LifecyclePhase = 'idle' | 'prime' | 'recall' | 'writeback' | 'review' | 'supervised' | 'error'

export interface LifecycleCounters {
  primes: number
  recallCues: number
  writebackCues: number
  supervisedRequests: number
  failures: number
}

/** Last automatic-review tool check for one live Agent, without raw errors or arguments. */
export interface ReviewAccessStatus {
  state: 'unchecked' | 'available' | 'unavailable'
  reason?: 'disposed' | 'executor-unavailable' | 'check-in-flight' | 'no-open-step' | 'approval-required' | 'handler-not-reached' | 'result-rejected' | 'timeout' | 'execution-error' | 'cancelled'
  checkedAt?: string
}

export interface WorkspaceMemoryParticipation {
  excluded: boolean
  reason?: 'workspace-unavailable'
  /** Zero-based positions of ignored invalid/unavailable configuration entries. */
  invalidEntries?: number[]
}

export interface LifecycleAgentSnapshot {
  sessionId: string
  status: 'idle' | 'running'
  startSource: 'startup' | 'resume' | 'clear' | 'compact' | 'adopted'
  primePending: boolean
  guidedTurns: number
  memoryToolCalls: number
  idleReviewPending: boolean
  reviewRunning: boolean
  reviewActivity: ReviewActivityScore
  lastPhase: LifecyclePhase
  lastReviewAt?: string
  lastReviewAction?: string
  lastReviewScore?: number
  lastReviewDocumentIds?: string[]
  idleReviewAttempts?: number
  idleReviewBlocked?: 'agent-team' | 'tool-access'
  idleReviewAccess?: ReviewAccessStatus
  idleReviewWatermark?: { state: 'ready' | 'error'; restoredAttempts: number; maxPerSession: number; error?: string }
  nextReviewAt?: string
  lastReviewFailure?: IdleReviewFailure
  lastAt?: string
  lastError?: string
}

/** Reconciliation metadata only; raw tool arguments and memory content stay private. */
export interface IdleReviewFailure {
  status: 'failed' | 'partial'
  runId?: string
  provider: string
  receipts: Array<{ tool: string; action: string; documentId?: string; target?: string; revision?: string }>
}

export interface LifecycleSnapshot {
  enabled: boolean
  recallMode: 'guided' | 'off'
  writebackMode: 'guided' | 'off'
  idleReviewMs: number
  activeAgents: number
  sessionAvailable: boolean
  /** A session-independent task Agent can be created for WebUI maintenance. */
  taskAgentAvailable: boolean
  counters: LifecycleCounters
  subagents: SubagentCounters
  current?: LifecycleAgentSnapshot
}

export interface StatusView {
  healthy: boolean
  error?: string
  version?: string
  /** The dsh-mnemo-weave version this Host runs, which an installed update replaces only when DSH restarts. */
  dshMnemonVersion?: string
  /** Updates installed while this Host runs; they load when DSH restarts. */
  restartPending?: VersionRestartStatus
  cliPath: string
  commandFound: boolean
  dataDir: string
  /** Legacy comma-separated DSH-enabled Store list. */
  store: string
  mnemonDefaultStore: string
  dshActiveStores: string[]
  writeEnabled: boolean
  timeoutMs: number
  defaultRecallLimit: number
  recallQuality: ResolvedRecallQualityConfig
  memoryBodyDirectory: string
  memoryBodies: MemorySpaceView[]
  providerServices?: MemoryProviderRuntimeStatus[]
  memorySystem?: MemoryCompositionStatus
  lifecycle?: LifecycleSnapshot
  documents?: DocumentSnapshot
  /** 技能管理, when its Source runs for this scope. */
  skills?: SkillsStatusSummary
  storage?: StorageScopeCatalog
  workspaceContext?: {
    participation?: WorkspaceMemoryParticipation
    workspaces?: Array<{ id: string; participation: WorkspaceMemoryParticipation }>
    mode: StorageScopeKind
    selectedRoot: string
    effectiveRoot: string
    aligned: boolean
    selectedWorkspace?: { id: string; title: string; path: string }
    effectiveWorkspace?: { id: string; title: string; path: string }
  }
  stats?: MemorySpaceStats & { dbPath?: string }
}

export type MnemonPackComponent = 'runtime' | 'documents' | 'memory-spaces'
/** The Sources that keep their data in Mnemon's data directory, in the order a backup lists them. */
export const MNEMON_PACK_COMPONENTS = ['runtime', 'documents', 'memory-spaces'] as const satisfies readonly MnemonPackComponent[]
export type MnemonPackScope = 'full' | MnemonPackComponent
export type MnemonPackImportMode = 'merge' | 'replace'

export interface MnemonPackComponentSummary {
  component: MnemonPackComponent
  files: number
  bytes: number
  items: number
}

export interface MnemonPackManifest {
  format: 'mnemonpack'
  version: 1
  scope: MnemonPackScope
  exportedAt: string
  source: { plugin: 'dsh-mnemon'; pluginVersion: string }
  components: MnemonPackComponent[]
  summary: MnemonPackComponentSummary[]
}

/** Where memory lives now, and where the global scope keeps it when no directory is chosen. */
export interface MnemonPackTarget {
  root: string
  scope: StorageScopeKind
  defaultRoot: string
  /** Only a native DSH backend can open an OS chooser. */
  nativeDirectoryPicker?: boolean
}

export interface MnemonPackExport {
  fileName: string
  mimeType: 'application/zip'
  bytes: number
  base64: string
  targetRoot: string
  manifest: MnemonPackManifest
}

export interface MnemonPackPreview {
  fileName?: string
  archiveBytes: number
  expandedBytes: number
  targetRoot: string
  targetScope: StorageScopeKind
  manifest: MnemonPackManifest
  occupied: Record<MnemonPackComponent, boolean>
}

/**
 * What a merge did to the runtime entries, stated as counts rather than as a file:
 * a page that reports "added" without this number is guessing.
 */
export interface MnemonRuntimeMergeReport {
  /** Incoming entries this merge admitted to hot runtime memory. */
  added: number
  /** Incoming entries left out because they did not fit; they stay in the archive. */
  held: number
  /** Exact MEMORY records newly saved in the local import-overflow archive. */
  archived?: number
}

export interface MnemonPackImportResult {
  imported: true
  mode: MnemonPackImportMode
  targetRoot: string
  components: MnemonPackComponent[]
  summary: MnemonPackComponentSummary[]
  /** Present when this import merged runtime entries. */
  runtime?: MnemonRuntimeMergeReport
}

/**
 * The identity one installation signs its entries with. It stays in the data
 * directory's state area, which no Pack component carries, and travels only
 * over the sync channel, never inside a Pack.
 */
export interface MnemonMachineIdentity {
  id: string
  label: string
  createdAt: string
}

/**
 * Where an installation's name comes from: the host name of the computer it runs on,
 * which the name then follows, or a name a person typed, which stays as given.
 */
export type MnemonMachineLabelSource = 'hostname' | 'custom'

/** Which machine wrote one runtime entry, so a merge can tell two installations apart. */
export interface MnemonEntryOrigin {
  machine: string
  label: string
  at: string
}

/** Which memory store a reconciliation run targets. */
export type MnemonReconcileScope = 'working-rules' | 'documents' | 'memory-spaces'

/** What one memory reconciliation proposes, and why. Nothing here is applied until a reviewer accepts it. */
export type MnemonReconcileOperation =
  | { kind: 'runtime-add'; target: 'memory' | 'user'; content: string; importance: 'critical' | 'normal' | 'low'; branches?: string[]; reason: string }
  | { kind: 'runtime-replace'; target: 'memory' | 'user'; oldText: string; content: string; importance?: 'critical' | 'normal' | 'low'; branches?: string[]; reason: string }
  | { kind: 'runtime-remove'; target: 'memory' | 'user'; oldText: string; reason: string }
  | { kind: 'document-archive'; documentId: string; reason: string }
  | { kind: 'insight-revise'; memoryBodyId: string; replacesId: string; content: string; category?: 'decision' | 'preference' | 'fact' | 'insight' | 'context' | 'general'; importance?: number; entities?: string[]; reason: string }
  | { kind: 'insight-forget'; memoryBodyId: string; id: string; reason: string }
  | { kind: 'insight-link'; memoryBodyId: string; sourceId: string; targetId: string; edgeType: 'temporal' | 'semantic' | 'causal' | 'entity'; weight?: number; reason: string }

export type MnemonReviewStatus = 'pending' | 'accepted' | 'rejected'

/** One reviewer's opinion on a proposal. Accepting or rejecting never replaces writing what one thinks. */
export interface MnemonReviewOpinion {
  id: string
  author: 'user' | 'agent'
  text: string
  createdAt: string
}

export interface MnemonReviewEntry {
  id: string
  reconcileScope?: MnemonReconcileScope
  runtimeStorageKind?: 'working-rules'
  createdAt: string
  updatedAt: string
  status: MnemonReviewStatus
  title: string
  summary: string
  /** The installation that produced the proposal. */
  machine: { id: string; label: string }
  /** Other installations whose entries the proposal touches, so a reviewer sees whose memory is at stake. */
  foreignMachines: string[]
  operations: MnemonReconcileOperation[]
  opinions: MnemonReviewOpinion[]
  decidedAt?: string
  appliedAt?: string
  /**
   * The positions in `operations` that have already run. Applying a plan is repeatable
   * because a reviewer can keep only part of it: a position written here is never offered
   * again, and a plan whose every operation ran is history rather than work.
   */
  appliedOperations?: number[]
  failure?: string
}

export interface MnemonReviewLedgerView {
  path: string
  entries: MnemonReviewEntry[]
  pending: number
  /**
   * The newest proposal, and only it, carried with the list so a caller can read what
   * the last run proposed without a second round trip. Its operations are withheld
   * here: the list is a summary, and one plan can hold `MAX_RECONCILE_OPERATIONS` changes.
   */
  latest?: MnemonReviewEntry
}

export interface MnemonReviewApplyResult {
  entry: MnemonReviewEntry
  applied: number
  failures: string[]
}

/** What a reconciliation run is told beyond the memory it reads. */
export interface MnemonReconcileOptions {
  /**
   * The reviewer's own words: what the plan should accomplish. It shapes the plan and
   * never widens it - the host still decides what an operation may contain.
   */
  guidance?: string
  scope?: MnemonReconcileScope
}

/** What one reconciliation run produced. A run with no findings creates no review. */
export interface MnemonReconcileResult {
  /** One line a reviewer scans in the ledger list. */
  title: string
  summary: string
  action: 'planned' | 'none' | 'failed'
  /** How many operations the proposal holds; the review entry carries the details. */
  operations: number
  foreignMachines: string[]
  /** Whether the plan was given the reviewer's own words to follow. */
  guided?: boolean
  entry?: MnemonReviewEntry
  provider: string
  runId: string
}

/**
 * An installable package: a component published on its own, as third parties do,
 * or a subpath of `dsh-mnemo-weave` for a component that ships inside it.
 */
export type VersionPackageId = `dsh-mnemo-weave-${'source' | 'strategy' | 'provider'}-${string}` | `dsh-mnemo-weave/${string}`
export type VersionComponentId = 'mnemon' | 'dsh-mnemo-weave' | VersionPackageId
export type VersionInstallMode = 'homebrew' | 'go' | 'npm' | 'link' | 'manual' | 'missing'

export interface VersionComponentStatus {
  id: VersionComponentId
  name: string
  executablePath?: string
  installPath?: string
  installProfile?: string
  current?: string
  latest?: string
  outdated: boolean
  installMode: VersionInstallMode
  updateSupported: boolean
  updateHint: string
  checkError?: string
  restartRequired?: boolean
  packages?: VersionPackageStatus[]
}

export interface VersionPackageStatus extends VersionComponentStatus {
  id: VersionPackageId
  kind: 'source' | 'strategy' | 'provider'
  managedBy: 'starter' | 'profile'
  expectedVersion?: string
}

export interface VersionStatus {
  checkedAt: string
  components: VersionComponentStatus[]
  /** How the last update this Host ran from Check versions ended, for a page DSH swapped in meanwhile. */
  lastUpdate?: VersionUpdateOutcome
}

export interface VersionUpdateOutcome {
  at: string
  component: VersionComponentId
  /** The update's reply, when it ended without an error. */
  result?: VersionUpdateResult
  /** Why it failed, when it did. */
  error?: string
}

export interface VersionRestartStatus {
  /** The dsh-mnemo-weave version this Host runs. */
  running: string
  /** The dsh-mnemo-weave version now installed, when it differs, however it was installed: Check versions or `dsh plugin`, for example. */
  installed?: string
  /** Packages Check versions updated on their own. */
  packages?: VersionPackageId[]
}

export interface VersionUpdateResult {
  component: VersionComponentId
  previousVersion?: string
  currentVersion?: string
  updated: boolean
  restartRequired: boolean
  output?: string
}
