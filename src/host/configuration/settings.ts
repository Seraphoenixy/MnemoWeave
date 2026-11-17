import type { HostConnectionHandle, HostRpcHandler, HostSettingsService, RpcResult } from "../support/dsh.ts"
import { DEFAULT_SKILLS_CONFIG, MNEMON_SETTINGS_CHANNEL, MNEMON_SETTINGS_NAMESPACE, MNEMON_SKILLS_SETTINGS_NAMESPACE, MNEMON_UI_SETTINGS_NAMESPACE } from "../contracts/protocol.ts"
import { prepareEmbeddingSettings, publicEmbeddingSettings, type EmbeddingCredentialStore } from './embedding-settings.ts'
import { normalizeDisplayMode } from '../contracts/display-mode.ts'

export { MNEMON_SETTINGS_CHANNEL, MNEMON_SETTINGS_NAMESPACE, MNEMON_SKILLS_SETTINGS_NAMESPACE, MNEMON_UI_SETTINGS_NAMESPACE } from "../contracts/protocol.ts"

function success(value: unknown): RpcResult<unknown> {
  return { ok: true, value }
}

function failure(error: unknown, namespace: string): RpcResult<unknown> {
  return {
    ok: false,
    error: {
      code: 'settings-rejected',
      message: error instanceof Error ? error.message : String(error),
      details: { ns: namespace },
    },
  }
}

function badRequest(message: string): RpcResult<unknown> {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

function descriptor(settings: HostSettingsService, namespace: string) {
  const view = settings.describe({ redactSecrets: true }).find(candidate => candidate.ns === namespace)
  if (view === undefined) throw new Error(`${namespace} settings namespace is unavailable`)
  const raw = namespace === MNEMON_SETTINGS_NAMESPACE ? settings.describe({ redactSecrets: false }).find(candidate => candidate.ns === namespace) : undefined
  const visible = namespace === MNEMON_SETTINGS_NAMESPACE ? publicEmbeddingSettings(view.value, raw?.value, true) : view.value
  return {
    status: 'ready' as const,
    value: namespace === MNEMON_SETTINGS_NAMESPACE && displayModeOf(view.value) === 'buildin'
      ? { ...object(visible), displayMode: 'builtin' }
      : visible,
    base: namespace === MNEMON_SETTINGS_NAMESPACE ? publicEmbeddingSettings(view.base, raw?.base) : view.base,
    user: namespace === MNEMON_SETTINGS_NAMESPACE ? publicEmbeddingSettings(view.user, raw?.user) : view.user,
    revision: view.revision,
    writable: settings.writable,
    mode: 'host' as const,
    applies: view.applies,
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('payload must be an object')
  return value as Record<string, unknown>
}

function displayModeOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>).displayMode
    : undefined
}

/** Canonicalize only the legacy field through DSH's locked, revision-fenced writer. */
export async function migrateLegacyDisplayMode(settings: HostSettingsService): Promise<void> {
  if (!settings.writable) return
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const view = settings.describe({ redactSecrets: true }).find(candidate => candidate.ns === MNEMON_SETTINGS_NAMESPACE)
    if (view === undefined) return
    const hasUserMode = typeof view.user === 'object' && view.user !== null && Object.hasOwn(view.user, 'displayMode')
    const mode = hasUserMode ? displayModeOf(view.user) : displayModeOf(view.base) ?? displayModeOf(view.value)
    if (mode !== 'buildin') return
    try {
      await settings.mutate(MNEMON_SETTINGS_NAMESPACE, [{ op: 'set', path: ['displayMode'], value: 'builtin' }], view.revision)
      return
    } catch (error) {
      // A concurrent explicit Sidebar choice wins; re-read instead of overwriting it.
      if (attempt === 2 || typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'SETTINGS_CONFLICT') throw error
    }
  }
}

const MUTABLE_FIELDS = [
  'storageScope', 'runtimeUserScope', 'excludedWorkspaces', 'cliPath', 'dataDir', 'customPackId', 'customPacks', 'store', 'timeoutMs', 'defaultRecallLimit',
  'runtimeMemory',
  'embedding',
  'recallQuality',
  'routingGuidance', 'lifecycleEnabled', 'recallMode', 'writebackMode', 'idleReviewMs', 'idleReview',
  'displayMode', 'tabEnabled', 'writeEnabled', 'persistenceStrategy', 'taskAgentModel',
]
// remoteAccess is intentionally absent: changing the remote management grant
// requires a local configuration edit and a Host restart.

/** Nested paths of the live in-conversation interaction toggles. */
const INTERACTION_PATHS: string[][] = [
  ['conversationInteraction', 'turnBar'],
  ['conversationInteraction', 'saveAction'],
]

/** Nested paths of the automatic server sync, both live: the timer re-reads them. */
const AUTO_SYNC_PATHS: string[][] = [
  ['autoSync', 'enabled'],
  ['autoSync', 'intervalMs'],
]

const UI_FIELDS = ['turnBar', 'saveAction']
const SKILLS_FIELDS = Object.keys(DEFAULT_SKILLS_CONFIG)
const MEMORY_LAYER_ID = /^[a-z][a-z0-9-]{0,127}$/u

function namespaceOf(payload: Record<string, unknown>): string {
  const namespace = payload.namespace === undefined ? MNEMON_SETTINGS_NAMESPACE : String(payload.namespace)
  if (namespace !== MNEMON_SETTINGS_NAMESPACE && namespace !== MNEMON_UI_SETTINGS_NAMESPACE && namespace !== MNEMON_SKILLS_SETTINGS_NAMESPACE) throw new Error(`unsupported Mnemon settings namespace: ${namespace}`)
  return namespace
}

/** Whether one mutation path targets a supported Mnemon settings field. */
function mutablePath(namespace: string, path: string[]): boolean {
  if (namespace === MNEMON_UI_SETTINGS_NAMESPACE) return path.length === 1 && UI_FIELDS.includes(path[0]!)
  if (namespace === MNEMON_SKILLS_SETTINGS_NAMESPACE) return path.length === 1 && SKILLS_FIELDS.includes(path[0]!)
  if (path.length === 1) return MUTABLE_FIELDS.includes(path[0]!)
  if (path.length === 4 && path[0] === 'memoryTopology' && path[1] === 'layers' && path[3] === 'enabled') {
    return MEMORY_LAYER_ID.test(path[2]!)
  }
  if (AUTO_SYNC_PATHS.some(allowed => allowed.length === path.length && allowed.every((segment, index) => segment === path[index]))) return true
  // Accepted only for legacy clients; the current UI writes `mnemon-ui`.
  return INTERACTION_PATHS.some(allowed => allowed.length === path.length && allowed.every((segment, index) => segment === path[index]))
}

export function createSettingsHandler(settings: HostSettingsService, credentials?: EmbeddingCredentialStore): HostRpcHandler {
  return async (endpoint, rawPayload) => {
    let namespace = MNEMON_SETTINGS_NAMESPACE
    try {
      const payload = object(rawPayload)
      namespace = namespaceOf(payload)
      if (endpoint === 'get') return success(descriptor(settings, namespace))
      if (endpoint !== 'mutate') return badRequest(`unknown settings endpoint: ${endpoint}`)
      if (!settings.writable) throw new Error('DSH settings are read-only')
      if (!Array.isArray(payload.ops) || payload.ops.length === 0 || payload.ops.length > 16) throw new Error('ops must contain 1..16 settings edits')
      const ops = payload.ops.map((raw) => {
        const op = object(raw)
        const path = Array.isArray(op.path) && op.path.length > 0 ? op.path.map(segment => String(segment)) : []
        if (!mutablePath(namespace, path)) throw new Error(`unsupported ${namespace} settings field: ${path.join('.')}`)
        if (op.op === 'unset') return { op: 'unset' as const, path }
        if (op.op !== 'set') throw new Error(`unsupported settings operation: ${String(op.op)}`)
        if (path[0] === 'memoryTopology' && typeof op.value !== 'boolean') throw new Error('memory layer enabled must be boolean')
        // The schema checks these too, but a range refusal names the field
        // rather than failing the whole document later.
        if (path[0] === 'autoSync' && path[1] === 'enabled' && typeof op.value !== 'boolean') throw new Error('autoSync.enabled must be boolean')
        if (path[0] === 'autoSync' && path[1] === 'intervalMs'
          && (typeof op.value !== 'number' || !Number.isInteger(op.value) || op.value < 60_000 || op.value > 86_400_000)) {
          throw new Error('autoSync.intervalMs must be an integer within 60000..86400000')
        }
        return { op: 'set' as const, path, value: namespace === MNEMON_SETTINGS_NAMESPACE && path[0] === 'displayMode' ? normalizeDisplayMode(op.value) : op.value }
      })
      const revision = payload.expectedRevision === undefined ? undefined : Number(payload.expectedRevision)
      const prepared = await prepareEmbeddingSettings(settings, namespace, ops, revision, credentials)
      try {
        await settings.mutate(namespace, prepared.operations, prepared.revision)
      } catch (error) {
        await prepared.rollback?.().catch(() => {})
        throw error
      }
      if (namespace === MNEMON_SETTINGS_NAMESPACE) await migrateLegacyDisplayMode(settings)
      return success(descriptor(settings, namespace))
    } catch (error) {
      return failure(error, namespace)
    }
  }
}

export function registerSettingsRpc(connection: HostConnectionHandle, settings: HostSettingsService, credentials?: EmbeddingCredentialStore): HostRpcHandler {
  const handler = createSettingsHandler(settings, credentials)
  connection.rpc.handle(MNEMON_SETTINGS_CHANNEL, handler)
  return handler
}
