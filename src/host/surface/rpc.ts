import { hostSyncEndpoint, saveSyncConnection, syncConnectionView, type SyncCredentialStore } from '../configuration/sync-settings.ts'
import { GlobalSyncConflict, syncAllMemory } from '../engine/server-sync.ts'
import { syncProgress } from '../engine/sync-progress.ts'
import { openWorkingRules, workingRulesActivityStore } from '../../memory/working-rules.ts'
import { activityKey } from '../../memory/activity.ts'
import { randomUUID } from 'node:crypto'
import { mutationResultCommitted } from '../engine/receipts.ts'
import { activityScope, connectActivitySync } from '../../sync/client/activity.ts'
import { workspaceActivityStore } from '../review/activity-history.ts'
import { clearMemoryActivity, recentMemoryActivity } from '../review/memory-activity.ts'
import { localSnapshotSync } from '../../sync/client/filesystem.ts'
import { SnapshotConflict, type SnapshotSync } from '../../sync/client/snapshot.ts'
import { isDefaultSourceInstance, isWorkspaceStorageScope } from '../contracts/protocol.ts'
import { diagnostics } from '../support/diagnostics.ts'
import type { HostConnectionHandle, HostRpcHandler, RpcResult } from '../support/dsh.ts'
import type { MnemonLifecycle } from '../boot/lifecycle.ts'
import type { LiveMnemonRuntime } from '../engine/runtime.ts'
import { assertParticipation } from '../support/access.ts'
import { WORKSPACE_MEMORY_EXCLUDED } from '../support/workspace-exclusion.ts'
import { sourceFailure } from '../session/source-session.ts'
import { errorMessage } from '../support/error-message.ts'
import { mainStrategyTypeId } from '../support/main-strategy.ts'
import { strategyDrives } from '../support/strategy-workflows.ts'
import { isVersionComponentId, VersionUpdateManager } from './version-updates.ts'
import type { MemoryCapability, MemoryJsonValue, MemoryOperationScope, MemorySourceManagementInstance, MemorySourceManagementRequest } from '../../core/contracts/index.ts'
import type { CreateMemorySpaceRequest, Insight, MemorySpaceCatalog, PreparedMemoryPlacement, RememberRequest } from 'dsh-mnemo-weave/source-memory-spaces/contracts'
import type { RuntimeMemoryMutation, RuntimeMemorySnapshot } from 'dsh-mnemo-weave/source-runtime/contracts'
import type { DocumentMutation } from 'dsh-mnemo-weave/source-documents/contracts'
import { MNEMON_ACTIVATION_CHANNEL, MNEMON_PACK_CHANNEL, MNEMON_READ_CHANNEL, MNEMON_REVIEW_CHANNEL, MNEMON_SYNC_CHANNEL, MNEMON_WRITE_CHANNEL, type MemoryCompositionStatus, type MnemonPackComponent, type MnemonPackImportMode, type SkillsStatusSummary } from '../contracts/protocol.ts'
import { MNEMON_PACK_COMPONENTS } from '../contracts/protocol.ts'
import { applyReconcileOperations, selectReconcileOperations, sourceApplier, type MnemonReconcileSessions } from '../engine/reconcile.ts'
export { MNEMON_ACTIVATION_CHANNEL, MNEMON_PACK_CHANNEL, MNEMON_READ_CHANNEL, MNEMON_REVIEW_CHANNEL, MNEMON_SYNC_CHANNEL, MNEMON_WRITE_CHANNEL } from '../contracts/protocol.ts'

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('payload must be an object')
  return value as Record<string, unknown>
}
function requestedScope(payload: Record<string, unknown>): { workspaceId?: string; sessionId?: string } {
  return Object.fromEntries(['workspaceId', 'sessionId'].flatMap(key => {
    const value = payload[key]
    if (value === undefined) return []
    if (typeof value !== 'string') throw new Error(key + ' must be a string')
    return value.trim() === '' ? [] : [[key, value.trim()]]
  }))
}
function scoped(runtime: LiveMnemonRuntime, payload: Record<string, unknown>, lifecycle?: MnemonLifecycle) {
  const requested = requestedScope(payload)
  const route = runtime.route(requested)
  // Browser workspace ids, and sessions whose Agents are not loaded, resolve through the
  // authenticated DSH registry.
  const workspaceId = route.selectedWorkspace?.path ?? lifecycle?.workspaceRoot(requested.sessionId)
  const scope: MemoryOperationScope = {
    storage: route.graph.config.storageScope,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(requested.sessionId === undefined ? {} : { sessionId: requested.sessionId }),
  }
  return { ...route, scope, source: (typeId: string) => route.graph.source(typeId, scope) }
}
type ScopedRuntime = ReturnType<typeof scoped>

async function manualSaveActivity<T>(
  runtime: ScopedRuntime, payload: Record<string, unknown>, source: string | undefined, operation: string, perform: () => Promise<T>,
): Promise<T> {
  if (payload.trigger !== 'manual-save' || (source === 'runtime' ? operation !== 'mutate' : !(source === 'memory-spaces' && operation === 'remember'))) return perform()
  const workspace = runtime.scope.workspaceId
  if (source !== 'runtime' && workspace === undefined) return perform()
  const store = source === 'runtime' ? workingRulesActivityStore() : workspaceActivityStore(runtime.graph.directory, workspace!)
  const write = (outcome: 'committed' | 'skipped' | 'unconfirmed' | 'failed') => {
    try {
      store.save({
        version: 1, kind: 'memory', id: activityKey('manual-save', randomUUID()), at: Date.now(),
        source: source === 'runtime' ? 'runtime' : 'memory-spaces', operation: source === 'runtime' ? 'mutate' : 'remember', outcome, trigger: 'manual-save',
        ...(runtime.scope.sessionId === undefined ? {} : { session: activityKey('session', runtime.scope.sessionId) }),
      })
    } catch { console.error('MnemoWeave could not collect manual save activity') }
  }
  try {
    const result = await perform()
    const value = result as { value?: unknown } | null | undefined
    const receipt = (value?.value ?? result) as { action?: unknown; message?: unknown; added?: unknown } | null | undefined
    const skipped = receipt?.action === 'skipped' || typeof receipt?.message === 'string' && receipt.message.startsWith('Entry already exists')
    write(skipped ? 'skipped' : mutationResultCommitted(receipt) || typeof receipt?.added === 'string' ? 'committed' : 'unconfirmed')
    return result
  } catch (error) { write('failed'); throw error }
}
function requireAligned(runtime: ScopedRuntime): void {
  if (runtime.participation.excluded) throw new Error(WORKSPACE_MEMORY_EXCLUDED)
  if (!runtime.aligned) throw new Error('the selected memory workspace differs from the current session; align the workbench before running an Agent-backed operation')
}
function requireWritable(runtime: ScopedRuntime): void {
  if (runtime.participation.excluded) throw new Error(WORKSPACE_MEMORY_EXCLUDED)
  if (!runtime.graph.config.writeEnabled) throw new Error('dsh-mnemo-weave is configured read-only (writeEnabled: false)')
}
function requireCapability(runtime: ScopedRuntime, typeId: string, capability: MemoryCapability): void {
  assertParticipation(runtime.graph.config, typeId, capability, 'manual')
}
/** A memory layer that is off takes no part in reads or writes, management and assistance included. */
function requireLayerOn(runtime: ScopedRuntime, sourceTypeId: string | undefined): void {
  if (sourceTypeId !== undefined && runtime.graph.config.memoryTopology.layers[sourceTypeId]?.enabled === false) {
    throw new Error(`Memory layer ${sourceTypeId} is off; turn it on to read or change it`)
  }
}
function sourceTypeOf(generation: { sourceInstances(): ReadonlyArray<{ sourceInstanceKey: string; sourceTypeId: string }> } | undefined, sourceInstanceKey: string): string | undefined {
  return generation?.sourceInstances().find(source => source.sourceInstanceKey === sourceInstanceKey)?.sourceTypeId
}
/** A one-off pull filter; an absent value means every component. */
function requestedComponents(value: unknown): MnemonPackComponent[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length === 0) throw new Error('components must be a non-empty array')
  const components = value.map(String) as MnemonPackComponent[]
  if (new Set(components).size !== components.length || components.some(component => !MNEMON_PACK_COMPONENTS.includes(component))) {
    throw new Error('components must be one or more of ' + MNEMON_PACK_COMPONENTS.join(', '))
  }
  return components
}
function success(value: unknown): RpcResult<unknown> { return { ok: true, value } }
function failure(error: unknown): RpcResult<unknown> {
  // A named failure, such as a sync remote that refused the credentials, carries its
  // reason so the page can state it in its own language; the message stays as written.
  const reason = error instanceof Error ? (error as { reason?: unknown }).reason : undefined
  return { ok: false, error: { code: 'internal', message: errorMessage(error), details: typeof reason === 'string' ? { reason } : {} } }
}
function badRequest(message: string): RpcResult<unknown> {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

const SPACE_READ_CAPABILITIES: Record<string, MemoryCapability> = {
  graph: 'graph', list: 'browse', entities: 'search', search: 'recall', related: 'related',
  bodies: 'status', 'body-directory': 'status', 'body-reconnect': 'status', 'provider-services': 'status', 'provider-service-check': 'status', 'embedding-status': 'status', 'local-embedding-status': 'status',
}
const SPACE_WRITE_CAPABILITIES: Record<string, MemoryCapability> = {
  remember: 'write', link: 'link', forget: 'forget', 'body-create': 'write', 'body-update': 'write',
  'body-delete': 'forget', 'body-merge': 'write', 'provider-service-update': 'maintain', 'embedding-fill': 'maintain', 'local-embedding-deploy': 'maintain', 'local-embedding-control': 'maintain',
}

// Optional product workflows. They are not Source or Core operations and are
// advertised only for the exact default instances that this Host coordinates.
const ASSISTANCE: Record<string, readonly string[]> = {
  'runtime': ['mutate'],
  'documents': ['mutate', 'archive'],
  'memory-spaces': ['agent-search', 'supervise', 'body-create', 'body-metadata-maintain', 'suggest-entities'],
  'skills': ['skill-draft', 'skill-backtest', 'skill-derive-cases', 'skill-review-now'],
}
function assistance(source: MemorySourceManagementInstance, lifecycle?: MnemonLifecycle, runtime?: ScopedRuntime): readonly string[] {
  const controls = source.sourceTypeId === 'memory-spaces' ? ['activation'] : []
  if (lifecycle === undefined || !isDefaultSourceInstance(source.sourceInstanceKey, source.sourceTypeId)) return controls
  const taskAvailable = lifecycle.snapshot(runtime?.scope.sessionId, runtime?.scope.workspaceId).taskAgentAvailable
  return [...controls, ...(ASSISTANCE[source.sourceTypeId] ?? []).filter(operation => operation === 'mutate' || taskAvailable)]
}
async function catalog(runtime: ScopedRuntime, lifecycle?: MnemonLifecycle) {
  if (runtime.graph.memoryComposition.current() === undefined) return { generationId: 'unavailable', sources: [] }
  const lease = runtime.graph.memoryComposition.acquire()
  try {
    const value = await lease.generation.managementCatalog(runtime.scope)
    return { ...value, sources: value.sources.map(source => ({ ...source, assistance: assistance(source, lifecycle, runtime) })) }
  } finally { lease.release() }
}
async function compositionStatus(runtime: ScopedRuntime): Promise<MemoryCompositionStatus> {
  const composition = runtime.graph.memoryComposition.inspect()
  const strategy = runtime.graph.memoryComposition.current()?.strategy.definition.manifest
  return {
    serving: composition.servingGenerationId !== undefined,
    ...(strategy === undefined ? {} : { strategyTypeId: strategy.typeId, workflows: {
      // Like lifecycle review, a fallback must not opt the selected Strategy into automatic review.
      idleReview: strategy.typeId === mainStrategyTypeId(runtime.graph.config) && strategyDrives(strategy, 'idle-review'),
      runtimeCapacity: strategyDrives(strategy, 'runtime-capacity'),
    } }),
    evaluation: composition.evaluation, sources: (await catalog(runtime)).sources, configuration: runtime.graph.config.memoryTopology,
  }
}

async function assisted(runtime: ScopedRuntime, lifecycle: MnemonLifecycle, typeId: string, operation: string, input: Record<string, unknown>, signal?: AbortSignal, target?: { sourceInstanceKey: string; expectedRevision: string }): Promise<unknown> {
  const sessionId = runtime.scope.sessionId ?? ''
  const workspaceRoot = runtime.scope.workspaceId
  if (typeId === 'runtime' && operation === 'mutate') {
    requireCapability(runtime, typeId, 'write')
    if ('target' in input) throw new Error('Working Rules mutations no longer accept target')
    const request = { ...input, ...(input.oldText ?? input.old_text) === undefined ? {} : { oldText: input.oldText ?? input.old_text } } as unknown as RuntimeMemoryMutation
    const lease = runtime.graph.memoryComposition.acquire()
    try {
      const sourceInstanceKey = target?.sourceInstanceKey ?? (await runtime.source(typeId).identity()).sourceInstanceKey
      const result = await lifecycle.manageSource(runtime.graph, {
        scope: runtime.scope, sourceInstanceKey, mode: 'mutate', operation: 'mutate', input: request as unknown as MemoryJsonValue,
        confirmed: true, expectedRevision: target?.expectedRevision ?? await lease.generation.managementRevision(sourceInstanceKey, runtime.scope, signal),
        ...(signal === undefined ? {} : { signal }),
      })
      return { ...object(result.value), revision: result.revision }
    } finally { lease.release() }
  }
  if (typeId === 'documents') {
    if (operation === 'archive') {
      // Without a Memory Spaces layer to index into, the coordinator archives locally (#336).
      requireCapability(runtime, typeId, 'archive')
      return lifecycle.archiveDocument(sessionId, String(input.id ?? ''), workspaceRoot, signal)
    }
    if (operation === 'mutate') {
      requireCapability(runtime, typeId, 'write')
      const request = input as unknown as DocumentMutation
      if (runtime.aligned && runtime.liveSession && sessionId !== '') return lifecycle.mutateDocument(sessionId, request, signal)
      try {
        return await runtime.source(typeId).mutate('mutate', request, signal)
      } catch (error) {
        // A conversation whose Agent is not loaded makes room as its Agent would:
        // a task Agent archives the least recently used Document, then writes.
        if (!runtime.aligned || sessionId === '' || !sourceFailure(error, 'document-capacity')) throw error
        return lifecycle.mutateDocumentTask(sessionId, request, workspaceRoot, signal)
      }
    }
  }
  if (typeId === 'skills') return skillAssistance(runtime, lifecycle, operation, input, signal)
  if (typeId !== 'memory-spaces') throw new Error('unsupported Source assistance operation')
  const source = runtime.source(typeId)
  switch (operation) {
    case 'agent-search': {
      requireCapability(runtime, typeId, 'recall')
      const recalled = await source.read<{ results: Insight[] }>('search', input, signal)
      const answer = await lifecycle.answerTask(sessionId, String(input.query ?? ''), recalled.results, workspaceRoot, signal)
      return { ...recalled, ...answer }
    }
    case 'supervise':
      requireCapability(runtime, typeId, 'write')
      return lifecycle.superviseTask(sessionId, String(input.content ?? ''), input.idempotencyKey === undefined ? undefined : String(input.idempotencyKey), workspaceRoot, signal)
    case 'body-create': {
      requireCapability(runtime, typeId, 'write')
      const request = input as unknown as CreateMemorySpaceRequest
      if (request.placement === undefined) return source.mutate('body-create', request, signal)
      requireAligned(runtime)
      const prepared = await source.read<PreparedMemoryPlacement>('prepare-body-placement', request, signal)
      const body = { name: request.name, description: request.description }
      // Without a loaded conversation Agent, a task Agent in the same workspace decides.
      const placementDecision = runtime.liveSession
        ? await lifecycle.placeProvider(sessionId, body, prepared, signal)
        : await lifecycle.placeProviderTask(sessionId, body, prepared, workspaceRoot, signal)
      return source.mutate('body-create', { request, placementDecision }, signal)
    }
    case 'suggest-entities': {
      const content = typeof input.content === 'string' ? input.content.trim() : ''
      if (content === '') throw new Error('suggest-entities requires non-empty content')
      const existingEntities = Array.isArray(input.existingEntities)
        ? input.existingEntities.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim()).slice(0, 50)
        : []
      return lifecycle.suggestEntities(sessionId, content.slice(0, 8_000), existingEntities, workspaceRoot, signal)
    }
    case 'body-metadata-maintain': {
      requireCapability(runtime, typeId, 'maintain')
      if (!Array.isArray(input.memoryBodyIds) || input.memoryBodyIds.some(id => typeof id !== 'string')) throw new Error('memoryBodyIds must be a string array')
      const ids = [...new Set((input.memoryBodyIds as string[]).map(id => id.trim()).filter(Boolean))]
      if (ids.length === 0 || ids.length > 20) throw new Error('metadata maintenance requires 1 through 20 Memory Spaces')
      const directory = await source.read<MemorySpaceCatalog>('body-directory', null, signal)
      for (const id of ids) {
        const body = directory.items.find(item => item.id === id)
        if (body === undefined || !body.active || body.providerEnabled === false) throw new Error('metadata maintenance requires an active Memory Space: ' + id)
      }
      const maintained = await lifecycle.maintainMetadata(sessionId, ids, workspaceRoot, signal)
      if (maintained.updates.length > 0) await source.mutate('body-metadata-update', { updates: maintained.updates }, signal)
      return maintained
    }
    default: throw new Error('unsupported Source assistance operation: ' + operation)
  }
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(label + ' must be a string')
  return value.trim() === '' ? undefined : value.trim()
}

/**
 * The `provider` + `model` pair a page may send with model work. Both or
 * neither: a half route cannot run, and an absent one keeps the profile's own.
 */
function modelRoute(input: Record<string, unknown>, missing = 'a draft model needs both provider and model'): { provider: string; model: string } | undefined {
  const provider = optionalString(input.provider, 'provider')
  const model = optionalString(input.model, 'model')
  if (provider === undefined && model === undefined) return undefined
  if (provider === undefined || model === undefined) throw new Error(missing)
  return { provider, model }
}

/** Skill evolution's model work: drafts and backtests run in the background, cases and reviews answer here. */
async function skillAssistance(runtime: ScopedRuntime, lifecycle: MnemonLifecycle, operation: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const skills = lifecycle.skills
  if (skills === undefined) throw new Error('skill evolution is unavailable')
  const source = runtime.source('skills')
  const workspaceRoot = runtime.scope.workspaceId
  switch (operation) {
    case 'skill-draft': {
      const root = optionalString(input.targetRoot, 'targetRoot')
      if (root !== undefined && !['project-dsh', 'project-agents', 'user-dsh', 'user-agents'].includes(root)) throw new Error('unknown skill root: ' + root)
      const suggestionId = optionalString(input.suggestionId, 'suggestionId')
      const draftId = optionalString(input.draftId, 'draftId')
      const skill = optionalString(input.skill, 'skill')
      if (suggestionId === undefined && draftId === undefined && skill === undefined) throw new Error('a draft needs a suggestion, a draft, or a skill')
      const guidance = optionalString(input.guidance, 'guidance')
      if (guidance !== undefined && guidance.length > 4_000) throw new Error('guidance is too long (max 4000 characters)')
      // The pick is a Provider and a model together, or neither: half a route
      // cannot run, and a whole one is what the page's two pickers send.
      const draftRoute = modelRoute(input)
      return skills.draft(source, workspaceRoot, {
        ...(input.backtest === true ? { backtest: true } : {}),
        ...(suggestionId === undefined ? {} : { suggestionId }), ...(skill === undefined ? {} : { skill }),
        ...(draftId === undefined ? {} : { draftId }),
        ...(guidance === undefined ? {} : { guidance }), ...(root === undefined ? {} : { targetRoot: root as never }),
        ...(draftRoute === undefined ? {} : { route: draftRoute }),
      })
    }
    case 'skill-backtest': {
      const skillName = optionalString(input.skillName, 'skillName')
      if (skillName === undefined) throw new Error('skillName is required')
      const target = object(input.target)
      if (!['current', 'draft', 'version', 'none'].includes(String(target.kind))) throw new Error('target kind must be current, draft, version or none')
      const caseIds = input.caseIds === undefined ? undefined : input.caseIds
      if (caseIds !== undefined && (!Array.isArray(caseIds) || caseIds.some(id => typeof id !== 'string'))) throw new Error('caseIds must be a string array')
      const runRoute = modelRoute(input, 'a backtest model needs both provider and model')
      return skills.backtest(source, workspaceRoot, { skillName, target: target as never, ...(caseIds === undefined ? {} : { caseIds: caseIds as string[] }), ...(runRoute === undefined ? {} : { route: runRoute }) })
    }
    case 'skill-derive-cases': {
      const trajectoryId = optionalString(input.trajectoryId, 'trajectoryId')
      const skillName = optionalString(input.skillName, 'skillName')
      if (trajectoryId === undefined || skillName === undefined) throw new Error('trajectoryId and skillName are required')
      const steps = input.steps
      if (steps !== undefined && (!Array.isArray(steps) || steps.some(step => !Number.isInteger(step)))) throw new Error('steps must be an integer array')
      return skills.deriveCases(source, workspaceRoot, { trajectoryId, skillName, ...(steps === undefined ? {} : { steps: steps as number[] }) }, signal ?? new AbortController().signal)
    }
    case 'skill-review-now': {
      const sessionId = runtime.scope.sessionId
      if (sessionId === undefined || !runtime.liveSession) throw new Error('open the conversation to review, and run it once, before reviewing its skills')
      return lifecycle.reviewSkills(sessionId)
    }
    default: throw new Error('unsupported Source assistance operation: ' + operation)
  }
}

export function createReadHandler(input: LiveMnemonRuntime, lifecycle?: MnemonLifecycle, versions?: VersionUpdateManager): HostRpcHandler {
  return async (endpoint, rawPayload, signal) => {
    try {
      const payload = object(rawPayload)
      // The Host's recent activity, read by the Status page after a failure.
      // It needs no memory capability: it describes this process, not memory.
      if (endpoint === 'diagnostics') {
        const limit = typeof payload.limit === 'number' && Number.isInteger(payload.limit) && payload.limit > 0
          ? Math.min(payload.limit, 200) : 200
        return success({ entries: diagnostics.recent(limit) })
      }
      // What memory did recently: the structured events the activity sync
      // publishes, read for the selected workspace and the global stream.
      if (endpoint === 'memory-activity') {
        const runtime = scoped(input, payload, lifecycle)
        const workspace = runtime.scope.workspaceId
        return success({
          records: recentMemoryActivity({
            ...(workspace === undefined || runtime.participation.excluded ? {} : { workspace: { root: runtime.graph.directory, path: workspace } }),
            ...(typeof payload.limit === 'number' && Number.isInteger(payload.limit) && payload.limit > 0 ? { limit: payload.limit } : {}),
          }),
        })
      }
      if (endpoint === 'versions') {
        if (versions === undefined) throw new Error('version checks are unavailable')
        return success(await versions.check())
      }
      if (endpoint === 'task-agent-models') {
        if (lifecycle === undefined) throw new Error('Mnemon task Agent model directory is unavailable')
        // The settings page asks from one conversation, so its effective route
        // is that conversation's route rather than a session-less guess.
        const requested = requestedScope(payload)
        return success(await lifecycle.taskAgentModels(payload.includeCatalog !== false, requested.sessionId))
      }
      const runtime = scoped(input, payload, lifecycle)
      if (Object.hasOwn(SPACE_READ_CAPABILITIES, endpoint)) {
        // Inspection remains available when model participation is disabled.
        if (SPACE_READ_CAPABILITIES[endpoint] !== 'status') requireCapability(runtime, 'memory-spaces', SPACE_READ_CAPABILITIES[endpoint]!)
        return success(await runtime.source('memory-spaces').read(endpoint, payload, signal))
      }
      switch (endpoint) {
        case 'source-management-catalog': return success(await catalog(runtime, lifecycle))
        case 'source-assistance': {
          const op = typeof payload.operation === 'string' ? payload.operation : ''
          if (lifecycle === undefined || (op !== 'agent-search' && op !== 'suggest-entities')) throw new Error('Read-only Host assistance is unavailable')
          const source = (await catalog(runtime, lifecycle)).sources.find(item => item.sourceInstanceKey === payload.sourceInstanceKey)
          if (source === undefined || !source.assistance.includes(op)) throw new Error('Host assistance is not available for this Source instance')
          const value = await assisted(runtime, lifecycle, source.sourceTypeId, op, object(payload.input), signal)
          const current = (await catalog(runtime)).sources.find(item => item.sourceInstanceKey === source.sourceInstanceKey)
          return success({ revision: current?.revision ?? source.revision, value })
        }
        case 'source-management-read': {
          const lease = runtime.graph.memoryComposition.acquire()
          try {
            requireLayerOn(runtime, sourceTypeOf(lease.generation, String(payload.sourceInstanceKey ?? '')))
            return success(await lease.generation.executeManagement({
              scope: runtime.scope, sourceInstanceKey: String(payload.sourceInstanceKey ?? ''), mode: 'read',
              operation: String(payload.operation ?? ''), input: (payload.input ?? null) as MemoryJsonValue, confirmed: false,
              ...(signal === undefined ? {} : { signal }),
            }))
          } finally { lease.release() }
        }
        case 'memory-system': return success(await compositionStatus(runtime))
        case 'runtime-memory':
          requireCapability(runtime, 'runtime', 'read')
          return success(await runtime.source('runtime').read('snapshot', null, signal))
        case 'documents':
        case 'document':
        case 'document-search':
          requireCapability(runtime, 'documents', endpoint === 'document-search' ? 'search' : 'read')
          return success(await runtime.source('documents').read(endpoint === 'documents' ? 'snapshot' : endpoint === 'document' ? 'document' : 'search', payload, signal))
        case 'status':
        case 'status-summary': {
          let documents
          try { documents = await runtime.source('documents').read('snapshot', null, signal) } catch { /* Optional Source may be unavailable in this scope. */ }
          const composition = await compositionStatus(runtime)
          // Every Memory System page reads this status, so each one can say what a restart would load.
          let restartPending
          try { restartPending = versions?.restartStatus() } catch { /* The reminder is optional; the status is not. */ }
          // 技能管理's card: how many skills there are and what waits for the user.
          let skills: SkillsStatusSummary | undefined
          if (composition.sources.some(source => source.sourceTypeId === 'skills')) {
            try {
              const overview = await runtime.source('skills').read<{ counts: { skills: number; pending: number; drafts: number } }>('overview', null, signal)
              skills = { evolution: lifecycle?.skills?.config().evolution ?? false, skills: overview.counts.skills, waiting: overview.counts.pending + overview.counts.drafts }
            } catch { /* The card falls back to its own note. */ }
          }
          const hasSpaces = composition.sources.some(source => source.sourceTypeId === 'memory-spaces')
          const status = hasSpaces ? await runtime.source('memory-spaces').read<Record<string, unknown>>(endpoint, payload, signal) : {
            healthy: composition.evaluation.state === 'ready', commandFound: false, cliPath: runtime.graph.config.cliPath ?? '',
            dataDir: runtime.graph.directory, mnemonDefaultStore: '', dshActiveStores: [],
            writeEnabled: runtime.graph.config.writeEnabled, defaultRecallLimit: runtime.graph.config.defaultRecallLimit,
          }
          return success({
            ...status,
            writeEnabled: !runtime.participation.excluded && status.writeEnabled === true,
            ...(versions === undefined ? {} : { dshMnemonVersion: versions.runningVersion }),
            ...(restartPending === undefined ? {} : { restartPending }),
            ...(lifecycle === undefined ? {} : { lifecycle: lifecycle.snapshot(runtime.scope.sessionId, isWorkspaceStorageScope(runtime.graph.config.storageScope) ? runtime.scope.workspaceId : undefined) }),
            ...(documents === undefined ? {} : { documents }),
            ...(skills === undefined ? {} : { skills }),
            memorySystem: composition,
            storage: runtime.graph.storage.catalog(runtime.scope.workspaceId),
            workspaceContext: {
              participation: runtime.participation,
              workspaces: input.workspaceParticipations(),
              mode: runtime.graph.config.storageScope, selectedRoot: runtime.selectedRoot, effectiveRoot: runtime.effectiveRoot, aligned: runtime.aligned,
              ...(runtime.selectedWorkspace === undefined ? {} : { selectedWorkspace: runtime.selectedWorkspace }),
              ...(runtime.effectiveWorkspace === undefined ? {} : { effectiveWorkspace: runtime.effectiveWorkspace }),
            },
          })
        }
        case 'agent-search':
          if (lifecycle === undefined) throw new Error('Mnemon Agent query is unavailable')
          return success(await assisted(runtime, lifecycle, 'memory-spaces', endpoint, payload, signal))
        case 'turn-activities':
        case 'turn-activity': {
          if (lifecycle === undefined) throw new Error('Mnemon turn activity is unavailable')
          const snapshot = lifecycle.turnActivities(String(payload.sessionId ?? ''))
          return success(endpoint === 'turn-activities' ? snapshot : snapshot.activities.find(activity => activity.turn === Number(payload.turn)) ?? null)
        }
        case 'skill-activity':
          if (lifecycle === undefined) throw new Error('Mnemon skill activity is unavailable')
          return success(await lifecycle.skillActivity(String(payload.sessionId ?? '')))
        case 'assistant-message':
          if (lifecycle === undefined) throw new Error('Mnemon assistant message is unavailable')
          return success(lifecycle.assistantMessage(String(payload.sessionId ?? ''), String(payload.messageId ?? '')))
        default: return badRequest('unknown read endpoint: ' + endpoint)
      }
    } catch (error) { return failure(error) }
  }
}

const ACTIVATION_FIELDS = new Set(['memoryBodyId', 'active', 'sessionId', 'workspaceId'])
export function createActivationHandler(input: LiveMnemonRuntime): HostRpcHandler {
  return async (endpoint, rawPayload, signal) => {
    try {
      if (endpoint === 'source-assistance') {
        const payload = object(rawPayload)
        if (payload.operation !== 'activation' || payload.confirmed !== true) throw new Error('Unsupported activation operation')
        const fields = object(payload.input)
        if (Object.keys(fields).some(key => key !== 'memoryBodyId' && key !== 'active') || typeof fields.active !== 'boolean' || typeof fields.memoryBodyId !== 'string') throw new Error('Activation accepts only a Memory Space id and boolean state')
        const runtime = scoped(input, payload)
        requireWritable(runtime)
        const lease = runtime.graph.memoryComposition.acquire()
        try {
          const source = (await lease.generation.managementCatalog(runtime.scope)).sources.find(item => item.sourceInstanceKey === payload.sourceInstanceKey && item.sourceTypeId === 'memory-spaces')
          if (source === undefined) throw new Error('Memory Spaces Source instance is unavailable')
          requireLayerOn(runtime, source.sourceTypeId)
          return success(await lease.generation.executeManagement({
            scope: runtime.scope, sourceInstanceKey: source.sourceInstanceKey, mode: 'mutate', operation: 'body-update',
            input: fields as MemoryJsonValue, confirmed: true, expectedRevision: String(payload.expectedRevision ?? ''),
            ...(signal === undefined ? {} : { signal }),
          }))
        } finally { lease.release() }
      }
      if (endpoint !== 'body') return badRequest('unknown activation endpoint: ' + endpoint)
      const payload = object(rawPayload)
      const unexpected = Object.keys(payload).filter(field => !ACTIVATION_FIELDS.has(field))
      if (unexpected.length > 0) return badRequest('unsupported activation fields: ' + unexpected.join(', '))
      if (typeof payload.memoryBodyId !== 'string' || payload.memoryBodyId.trim() === '') return badRequest('memoryBodyId must be a non-empty string')
      if (typeof payload.active !== 'boolean') return badRequest('active must be a boolean')
      const runtime = scoped(input, payload)
      requireWritable(runtime)
      return success(await runtime.source('memory-spaces').mutate('body-update', { memoryBodyId: payload.memoryBodyId.trim(), active: payload.active }, signal))
    } catch (error) { return failure(error) }
  }
}

export function createWriteHandler(input: LiveMnemonRuntime, lifecycle?: MnemonLifecycle, versions?: VersionUpdateManager): HostRpcHandler {
  return async (endpoint, rawPayload, signal) => {
    try {
      const payload = object(rawPayload)
      if (endpoint === 'version-update') {
        if (versions === undefined) throw new Error('version updates are unavailable')
        if (!input.config.writeEnabled) throw new Error('dsh-mnemo-weave is configured read-only (writeEnabled: false)')
        if (!isVersionComponentId(payload.component)) return badRequest('unknown version component')
        return success(await versions.update(payload.component))
      }
      const runtime = scoped(input, payload, lifecycle)
      requireWritable(runtime)
      if (endpoint === 'memory-activity-clear') {
        // The page lists the selected workspace beside the global stream, so a
        // clear stops showing both of them. Clearing the global stream is part
        // of the request and cannot be narrowed by a payload field.
        const workspace = runtime.scope.workspaceId
        return success(clearMemoryActivity({
          ...(workspace === undefined || runtime.participation.excluded ? {} : { workspace: { root: runtime.graph.directory, path: workspace } }),
        }))
      }
      if (endpoint === 'source-management-mutate') {
        const request: MemorySourceManagementRequest = {
          scope: runtime.scope, sourceInstanceKey: String(payload.sourceInstanceKey ?? ''), mode: 'mutate',
          operation: String(payload.operation ?? ''), input: (payload.input ?? null) as MemoryJsonValue,
          confirmed: payload.confirmed === true,
          ...(typeof payload.expectedRevision === 'string' ? { expectedRevision: payload.expectedRevision } : {}),
          ...(signal === undefined ? {} : { signal }),
        }
        const typeId = sourceTypeOf(runtime.graph.memoryComposition.current(), request.sourceInstanceKey)
        requireLayerOn(runtime, typeId)
        if (typeId === 'runtime' && isDefaultSourceInstance(request.sourceInstanceKey, typeId) &&
          (request.operation === 'mutate' || request.operation === 'pin') && 'target' in object(request.input)) {
          throw new Error('Working Rules mutations no longer accept target')
        }
        return success(await manualSaveActivity(runtime, payload, typeId, request.operation, async () => {
          if (lifecycle !== undefined) return lifecycle.manageSource(runtime.graph, request)
          const lease = runtime.graph.memoryComposition.acquire()
          try { return await lease.generation.executeManagement(request) }
          finally { lease.release() }
        }))
      }
      if (endpoint === 'source-assistance') {
        if (lifecycle === undefined) throw new Error('Host assistance is unavailable')
        const source = (await catalog(runtime, lifecycle)).sources.find(item => item.sourceInstanceKey === payload.sourceInstanceKey)
        const operation = String(payload.operation ?? '')
        if (source === undefined || !source.assistance.includes(operation)) throw new Error('Host assistance is not available for this Source instance')
        requireLayerOn(runtime, source.sourceTypeId)
        if (operation !== 'agent-search' && (payload.confirmed !== true || payload.expectedRevision !== source.revision)) throw new Error('Host assistance requires confirmation of the current Source revision')
        const value = await manualSaveActivity(runtime, payload, source.sourceTypeId, operation, () =>
          assisted(runtime, lifecycle, source.sourceTypeId, operation, object(payload.input), signal, { sourceInstanceKey: source.sourceInstanceKey, expectedRevision: source.revision }))
        if (source.sourceTypeId === 'runtime') return success({ revision: object(value).revision, value })
        const current = (await catalog(runtime)).sources.find(item => item.sourceInstanceKey === source.sourceInstanceKey)
        return success({ revision: current?.revision ?? source.revision, value })
      }
      if (endpoint === 'runtime-memory') {
        if ('target' in payload) throw new Error('Working Rules mutations no longer accept target')
        if (lifecycle !== undefined) return success(await assisted(runtime, lifecycle, 'runtime', 'mutate', payload, signal))
        requireCapability(runtime, 'runtime', 'write')
        return success(await runtime.source('runtime').mutate('mutate', payload, signal))
      }
      if (endpoint === 'document') {
        const operation = payload.action === 'archive' ? 'archive' : 'mutate'
        if (lifecycle !== undefined) return success(await assisted(runtime, lifecycle, 'documents', operation, payload, signal))
        requireCapability(runtime, 'documents', operation === 'archive' ? 'archive' : 'write')
        return success(await runtime.source('documents').mutate(operation, payload, signal))
      }
      if (endpoint === 'supervise' || endpoint === 'body-metadata-maintain' || endpoint === 'body-create' && payload.placement !== undefined) {
        if (lifecycle === undefined) throw new Error('Host assistance is unavailable')
        return success(await assisted(runtime, lifecycle, 'memory-spaces', endpoint, payload, signal))
      }
      if (Object.hasOwn(SPACE_WRITE_CAPABILITIES, endpoint)) {
        requireCapability(runtime, 'memory-spaces', SPACE_WRITE_CAPABILITIES[endpoint]!)
        if (endpoint === 'remember' && lifecycle !== undefined && runtime.aligned && runtime.liveSession && runtime.scope.sessionId) {
          return success(await lifecycle.remember(runtime.scope.sessionId, { ...payload, source: 'user' } as unknown as RememberRequest, signal))
        }
        return success(await runtime.source('memory-spaces').mutate(endpoint, endpoint === 'remember' ? { ...payload, source: 'user' } : payload, signal))
      }
      return badRequest('unknown write endpoint: ' + endpoint)
    } catch (error) { return failure(error) }
  }
}

/** Pack data stays inside the selected storage root and DSH authentication. */
export function createPackHandler(input: LiveMnemonRuntime, nativeDirectoryPicker: () => boolean = () => false): HostRpcHandler {
  return async (endpoint, rawPayload) => {
    try {
      const payload = object(rawPayload)
      const runtime = scoped(input, payload)
      const manager = runtime.graph.packs
      if (endpoint === 'target') return success({ ...manager.target(), nativeDirectoryPicker: nativeDirectoryPicker() })
      if (endpoint === 'export') return success(await manager.exportPack('full'))
      if (endpoint === 'inspect') return success(manager.inspectPack(String(payload.base64 ?? ''), payload.fileName === undefined ? undefined : String(payload.fileName)))
      if (endpoint === 'import') {
        requireWritable(runtime)
        const result = await manager.importPack(String(payload.base64 ?? ''), { mode: 'merge' })
        if ((await catalog(runtime)).sources.some(source => source.sourceTypeId === 'memory-spaces')) await runtime.source('memory-spaces').mutate('reload', {})
        return success(result)
      }
      return badRequest('unknown Pack endpoint: ' + endpoint)
    } catch (error) { return failure(error) }
  }
}

/**
 * One server sync, shared by the page's button and the Host's timer so both
 * obey the same guard and report through the same progress record.
 */
export async function runServerSync(
  input: LiveMnemonRuntime,
  credentials: SyncCredentialStore | undefined,
  options: NonNullable<Parameters<SnapshotSync['sync']>[0]>,
) {
  if (!input.config.writeEnabled) throw new Error('dsh-mnemo-weave is configured read-only (writeEnabled: false)')
  // Claim the record before any await. Checking first and claiming after
  // reading the credentials would let a second caller — the timer and a press,
  // or two windows — pass the same check and copy the same roots at once.
  const run = syncProgress.claim()
  if (run === undefined) {
    diagnostics.warning('sync', 'A sync was requested while one is already running')
    throw new Error('A server sync is already running; wait for it to finish')
  }
  const started = Date.now()
  try {
    const remote = await hostSyncEndpoint(credentials)
    if (remote === undefined) throw new Error('Configure the sync server address and password first')
    diagnostics.info('sync', 'Sync started', remote.url)
    const result = await syncAllMemory(input, remote, options, run)
    run.finish(result)
    diagnostics.info('sync', 'Sync finished',
      `pulled ${result.pulled + result.activityPulled}, pushed ${result.pushed + result.activityPushed}, ${Date.now() - started} ms`)
    return result
  } catch (error) {
    run.fail(error, error instanceof GlobalSyncConflict ? error.target : undefined)
    // The cause chain is what makes this line worth reading: `fetch failed`
    // alone names no address, no certificate and no socket.
    diagnostics.failure('sync', error instanceof GlobalSyncConflict ? `Sync stopped on a conflict in ${error.target}` : 'Sync failed', error)
    throw error
  }
}

export function createSyncHandler(input: LiveMnemonRuntime, lifecycle?: MnemonLifecycle, credentials?: SyncCredentialStore): HostRpcHandler {
  return async (endpoint, rawPayload, signal) => {
    try {
      const payload = object(rawPayload)
      if (endpoint === 'connection') return success(await syncConnectionView(credentials))
      if (endpoint === 'save-connection') return success(await saveSyncConnection(credentials, payload.url, payload.password, signal))
      // A page reads this while a run is in flight, and once after it: the run
      // itself answers with its counts when its call returns.
      if (endpoint === 'progress') return success(syncProgress.view())
      if (endpoint === 'sync-all') {
        return success(await runServerSync(input, credentials, syncOptions(payload)))
      }
      const runtime = scoped(input, payload, lifecycle)
      if (endpoint === 'server-sync-activity') {
        requireWritable(runtime)
        if (typeof payload.syncScope !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,117}$/u.test(payload.syncScope)) {
          throw new Error('A shared workspace sync scope is required')
        }
        const workspace = runtime.scope.workspaceId ?? runtime.graph.workspaceRoot
        if (workspace === undefined) throw new Error('Select a workspace to synchronize memory activity')
        const configuration = await hostSyncEndpoint(credentials)
        const remote = configuration === undefined ? undefined : { ...configuration, scope: activityScope(payload.syncScope) }
        if (remote === undefined) throw new Error('Set MNEMOWEAVE_SYNC_URL and MNEMOWEAVE_SYNC_PASSWORD in the DSH Host')
        const store = workspaceActivityStore(runtime.graph.directory, workspace)
        return success(await connectActivitySync(remote, store)(syncSignal()))
      }
      if (endpoint === 'server-sync' || endpoint === 'server-sync-rules') {
        requireWritable(runtime)
        const rules = endpoint === 'server-sync-rules'
        if (!rules && (typeof payload.syncScope !== 'string' || payload.syncScope === '')) throw new Error('A shared workspace sync scope is required')
        const configuration = await hostSyncEndpoint(credentials)
        const remote = configuration === undefined ? undefined : { ...configuration, scope: rules ? 'working-rules' : 'workspace-' + String(payload.syncScope) }
        if (remote === undefined) throw new Error('Set MNEMOWEAVE_SYNC_URL and MNEMOWEAVE_SYNC_PASSWORD in the DSH Host')
        const options = syncOptions(payload)
        if (rules) {
          const { connectSync } = openWorkingRules(runtime.graph.directory)
          return success(await connectSync(remote).sync(options))
        }
        const packs = runtime.graph.packs
        const replica = localSnapshotSync(remote, runtime.graph.directory, {
          capture: () => packs.captureWorkspaceSync(),
          apply: (bytes, matches) => packs.replaceWorkspaceSync(bytes, matches),
          assemble: entries => packs.assembleWorkspaceSync(entries),
        })
        const result = await replica.sync(options)
        if (result.action === 'pulled' && (await catalog(runtime)).sources.some(source => source.sourceTypeId === 'memory-spaces')) {
          await runtime.source('memory-spaces').mutate('reload', {})
        }
        return success(result)
      }
      return badRequest('unknown sync endpoint: ' + endpoint)
    } catch (error) {
      if (error instanceof SnapshotConflict) return {
        ok: false, error: { code: 'internal', message: error.message, details: { reason: error.reason, conflictToken: error.conflictToken,
          ...(error instanceof GlobalSyncConflict ? { target: error.target } : {}) } },
      }
      return failure(error)
    }
  }
}

/**
 * How long one server sync may take. A run copies every scope and its activity
 * records, which on a large memory outlasts a single request; the budget
 * belongs to the run, not to the call that started it.
 */
const SYNC_BUDGET_MS = 600_000

/**
 * The signal one sync runs under. It is deliberately not the caller's request
 * signal: a page that navigates away, or a connection that reconnects, ends its
 * HTTP request while the sync is still copying, and handing that signal to the
 * sync would abort it part way through — some scopes already committed, the
 * rest lost, and the record left saying it failed. The run keeps its own
 * budget, and its outcome is read from the progress record.
 */
function syncSignal(): AbortSignal {
  return AbortSignal.timeout(SYNC_BUDGET_MS)
}

function syncOptions(payload: Record<string, unknown>): NonNullable<Parameters<SnapshotSync['sync']>[0]> {
  const resolve = payload.resolve
  const deadline = syncSignal()
  if (resolve === undefined) return { signal: deadline }
  if (resolve !== 'local' && resolve !== 'server') throw new Error('Invalid sync conflict resolution')
  if (payload.confirmed !== true) throw new Error('Replacing a copy after a sync conflict requires confirmation')
  if (typeof payload.conflictToken !== 'string') throw new Error('A current sync conflict is required')
  return { signal: deadline, resolve, conflictToken: payload.conflictToken }
}
/**
 * Review is the one channel that changes memory only after a human read the
 * proposal: a reconciliation run stages an entry, opinions are recorded against
 * it, and an accepted entry is applied operation by operation.
 */
export function createReviewHandler(input: LiveMnemonRuntime, lifecycle?: MnemonLifecycle): HostRpcHandler {
  return async (endpoint, rawPayload, signal) => {
    try {
      const payload = object(rawPayload)
      const ledger = input.reviews
      if (endpoint === 'view') return success(ledger.view())
      if (endpoint === 'opinion') {
        const author = payload.author === 'agent' ? 'agent' : 'user'
        return success(ledger.addOpinion(String(payload.id ?? ''), author, String(payload.text ?? '')))
      }
      if (endpoint === 'decide') {
        const status = payload.status === 'rejected' ? 'rejected' : 'accepted'
        return success(ledger.decide(String(payload.id ?? ''), status))
      }
      if (endpoint === 'reopen') return success(ledger.reopen(String(payload.id ?? '')))
      const runtime = scoped(input, payload, lifecycle)
      requireWritable(runtime)
      if (endpoint === 'reconcile') {
        if (lifecycle === undefined) throw new Error('Mnemon memory reconciliation is unavailable')
        // The reviewer's words shape the plan and never widen it: what an operation may
        // contain is still decided by the host, and nothing is applied by running this.
        const guidance = payload.guidance
        if (guidance !== undefined && typeof guidance !== 'string') throw new Error('the reconciliation guidance must be a string')
        const rawScope = payload.scope
        if (rawScope !== undefined && rawScope !== 'working-rules' && rawScope !== 'documents' && rawScope !== 'memory-spaces') {
          throw new Error('the reconciliation scope must be working-rules, documents, or memory-spaces')
        }
        return success(await lifecycle.reconcile(runtime.graph, runtime.scope, signal ?? new AbortController().signal, {
          ...(guidance === undefined ? {} : { guidance }),
          ...(rawScope === undefined ? {} : { scope: rawScope }),
        }))
      }
      if (endpoint === 'apply') {
        if (lifecycle === undefined) throw new Error('Mnemon memory reconciliation is unavailable')
        const entry = ledger.get(String(payload.id ?? ''))
        if (entry === undefined) throw new Error('unknown review entry: ' + String(payload.id ?? ''))
        if (entry.status !== 'accepted') throw new Error('accept the review before applying it: ' + entry.id)
        const selection = payload.operations
        if (selection !== undefined && (!Array.isArray(selection) || selection.some(index => typeof index !== 'number'))) {
          throw new Error('the operations to apply must be a list of operation indexes')
        }
        const chosen = selection as number[] | undefined
        // Running an operation twice is how a plan stops meaning what its author read: the
        // second run addresses text the first one already replaced. So the ledger decides
        // what is left to do, and a plan with nothing left is refused rather than replayed.
        const pending = selectReconcileOperations(entry.operations, chosen).filter(index => !(entry.appliedOperations ?? []).includes(index))
        if (pending.length === 0) {
          throw new Error('every operation in this review has already run: ' + entry.id)
        }
        const pendingOps = pending.map(index => entry.operations[index]!)
        const touchesRuntime = pendingOps.some(op => op.kind.startsWith('runtime-'))
        const touchesDocuments = pendingOps.some(op => op.kind === 'document-archive')
        const touchesSpaces = pendingOps.some(op => op.kind.startsWith('insight-'))
        if (touchesRuntime) {
          requireCapability(runtime, 'runtime', 'write')
          const snapshot = await runtime.source('runtime').read<RuntimeMemorySnapshot>('snapshot', null, signal)
          if (snapshot.storageKind !== entry.runtimeStorageKind) throw new Error('The review targets a different runtime store. Generate a new review before applying it.')
        }
        if (touchesDocuments) requireCapability(runtime, 'documents', 'write')
        if (touchesSpaces) {
          requireCapability(runtime, 'memory-spaces', 'write')
          if (pendingOps.some(op => op.kind === 'insight-forget' || op.kind === 'insight-revise')) requireCapability(runtime, 'memory-spaces', 'forget')
          if (pendingOps.some(op => op.kind === 'insight-link')) requireCapability(runtime, 'memory-spaces', 'link')
        }
        const sessions: MnemonReconcileSessions = {
          runtime: runtime.source('runtime'),
          documents: runtime.source('documents'),
          ...(touchesSpaces ? { memorySpaces: runtime.source('memory-spaces') } : {}),
        }
        const outcome = await applyReconcileOperations(entry.operations, sourceApplier(sessions), signal ?? new AbortController().signal, pending)
        const failure = outcome.failures.length === 0 ? undefined : outcome.failures.join('; ')
        const applied = ledger.applied(entry.id, failure, pending.slice(0, outcome.applied))
        if (failure !== undefined) throw new Error(failure)
        if ((await catalog(runtime)).sources.some(source => source.sourceTypeId === 'memory-spaces')) await runtime.source('memory-spaces').mutate('reload', {})
        return success({ entry: applied, applied: outcome.applied, failures: outcome.failures })
      }
      return badRequest('unknown review endpoint: ' + endpoint)
    } catch (error) { return failure(error) }
  }
}

export function registerRpc(connection: HostConnectionHandle, input: LiveMnemonRuntime, lifecycle?: MnemonLifecycle, versions?: VersionUpdateManager, nativeDirectoryPicker?: () => boolean, credentials?: SyncCredentialStore): {
  read: HostRpcHandler
  activation: HostRpcHandler
  write: HostRpcHandler
  pack: HostRpcHandler
  sync: HostRpcHandler
  review: HostRpcHandler
} {
  const versionManager = versions ?? new VersionUpdateManager({ mnemonCliPath: () => input.config.cliPath })
  const readHandler = createReadHandler(input, lifecycle, versionManager)
  const activationHandler = createActivationHandler(input)
  const writeHandler = createWriteHandler(input, lifecycle, versionManager)
  const syncHandler = createSyncHandler(input, lifecycle, credentials)
  const reviewHandler = createReviewHandler(input, lifecycle)
  const packHandler = createPackHandler(input, nativeDirectoryPicker)
  connection.rpc.handle(MNEMON_READ_CHANNEL, readHandler)
  connection.rpc.handle(MNEMON_ACTIVATION_CHANNEL, activationHandler)
  connection.rpc.handle(MNEMON_WRITE_CHANNEL, writeHandler)
  connection.rpc.handle(MNEMON_PACK_CHANNEL, packHandler)
  connection.rpc.handle(MNEMON_SYNC_CHANNEL, syncHandler)
  connection.rpc.handle(MNEMON_REVIEW_CHANNEL, reviewHandler)
  return { read: readHandler, activation: activationHandler, write: writeHandler, pack: packHandler, sync: syncHandler, review: reviewHandler }
}
