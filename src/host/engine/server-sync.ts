import { resolve } from 'node:path'
import { activityKey } from '../../memory/activity.ts'
import { openWorkingRules } from '../../memory/working-rules.ts'
import { WORKING_RULES_ACTIVITY_SCOPE } from '../../sync/activity-protocol.ts'
import { activityScope, connectActivitySync } from '../../sync/client/activity.ts'
import { localSnapshotSync, type SyncEndpoint } from '../../sync/client/filesystem.ts'
import { SnapshotConflict, type SnapshotSync } from '../../sync/client/snapshot.ts'
import { isWorkspaceStorageScope } from '../contracts/protocol.ts'
import { workspaceActivityStore } from '../review/activity-history.ts'
import { diagnostics } from '../support/diagnostics.ts'
import type { SyncRun } from './sync-progress.ts'
import type { LiveMnemonRuntime } from './runtime.ts'

export class GlobalSyncConflict extends SnapshotConflict {
  constructor(token: string, readonly target: string) { super(token) }
}

export async function syncAllMemory(
  runtime: LiveMnemonRuntime,
  endpoint: SyncEndpoint,
  options: NonNullable<Parameters<SnapshotSync['sync']>[0]>,
  run?: SyncRun,
) {
  const remote = { ...endpoint, session: {} }
  const root = runtime.snapshot()
  const workspaceStorage = isWorkspaceStorageScope(root.config.storageScope)
  const projects = new Map<string, { path: string; graph: typeof root; title: string }>()
  for (const workspace of runtime.syncWorkspaces()) {
    const title = workspace.title.trim().normalize('NFC')
    const name = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,117}$/u.test(title) ? title : '_' + activityKey(title)
    const graph = runtime.forWorkspaceId(workspace.id)
    const existing = projects.get(name)
    if (existing !== undefined && resolve(existing.path) !== resolve(workspace.path)) {
      throw new Error('Workspace names must be unique for server sync: ' + title)
    }
    projects.set(name, { path: workspace.path, graph, title })
  }

  const rules = openWorkingRules(root.directory)
  const snapshots = new Map<string, { target: string; replica: Pick<SnapshotSync, 'sync'>; afterPull?: () => Promise<void> }>()
  snapshots.set('working-rules', { target: 'working-rules', replica: rules.connectSync({ ...remote, scope: 'working-rules' }) })
  const syncedRoots = new Set<string>()
  const addPack = (scope: string, target: string, graph: typeof root) => {
    const directory = resolve(graph.directory)
    if (syncedRoots.has(directory)) return
    syncedRoots.add(directory)
    snapshots.set(scope, {
      target,
      replica: localSnapshotSync({ ...remote, scope }, directory, {
        capture: () => graph.packs.captureWorkspaceSync(),
        apply: (bytes, matches) => graph.packs.replaceWorkspaceSync(bytes, matches),
        assemble: entries => graph.packs.assembleWorkspaceSync(entries),
      }),
      afterPull: async () => {
        if (graph.memoryComposition.current()?.sourceInstances().some(source => source.sourceTypeId === 'memory-spaces')) {
          await graph.source('memory-spaces').mutate('reload', {})
        }
      },
    })
  }
  if (!workspaceStorage) addPack('global-memory', 'global-memory', root)
  else for (const [name, project] of projects) addPack('workspace-' + name, project.title, project.graph)

  // Bind the confirmation to this server and stream before submitting the existing
  // per-snapshot token, which fences both local and remote edits.
  const prefixes = new Map([...snapshots.keys()].map(scope => [scope, activityKey(new URL(remote.url).href, scope) + ':']))
  const confirmed = options.resolve === undefined ? undefined
    : [...prefixes].find(([, prefix]) => options.conflictToken?.startsWith(prefix))
  if (options.resolve !== undefined && confirmed === undefined) throw new Error('The sync target changed; synchronize again before resolving the conflict')

  // Every scope and every activity stream is one step, so the page can say how
  // far the run is before each copy begins.
  const activities = [[WORKING_RULES_ACTIVITY_SCOPE, rules.activity] as const, ...[...projects].map(([name, project]) =>
    [activityScope(name), workspaceActivityStore(project.graph.directory, project.path)] as const)]
  run?.plan(snapshots.size + activities.length)

  let pulled = 0
  let pushed = 0
  const ordered = [...snapshots].sort(([a], [b]) => Number(b === confirmed?.[0]) - Number(a === confirmed?.[0]))
  for (const [scope, entry] of ordered) {
    const prefix = prefixes.get(scope)!
    const resolution = scope === confirmed?.[0] && options.resolve !== undefined && options.conflictToken !== undefined
      ? { resolve: options.resolve, conflictToken: options.conflictToken.slice(prefix.length) } : {}
    run?.step('snapshot', entry.target)
    const started = Date.now()
    try {
      const result = await entry.replica.sync({
        ...resolution,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(run === undefined ? {} : { transfer: progress => run.transfer(progress.done, progress.total) }),
      })
      if (result.action === 'pulled') {
        pulled++
        await entry.afterPull?.()
      }
      if (result.action === 'pushed') pushed++
      diagnostics.info('sync', `${entry.target}: ${result.action}`, `${Date.now() - started} ms`)
    } catch (error) {
      // Name the scope that failed; the run's own failure line says why.
      diagnostics.failure('sync', `${entry.target}: failed`, error)
      if (error instanceof SnapshotConflict) throw new GlobalSyncConflict(prefix + error.conflictToken, entry.target)
      throw error
    }
  }
  let activityPulled = 0
  let activityPushed = 0
  for (const [scope, store] of activities) {
    run?.step('activity')
    const started = Date.now()
    try {
      const result = await connectActivitySync({ ...remote, scope }, store)(options.signal)
      activityPulled += result.pulled
      activityPushed += result.pushed
      diagnostics.info('sync', `${scope}: pulled ${result.pulled}, pushed ${result.pushed}`, `${Date.now() - started} ms`)
    } catch (error) {
      diagnostics.failure('sync', `${scope}: failed`, error)
      throw error
    }
  }
  return { pulled, pushed, activityPulled, activityPushed }
}
