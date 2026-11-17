import { Context } from '@deepseek-ai/cordis'
import { Config as PlainConfig, InteractionConfig, resolveConfig, resolveInteractionConfig, SkillsConfig, type Config as MnemonConfig } from '../configuration/config.ts'
import { registerCommands } from './commands.ts'
import type { HostContextShape, HostCredentialsService, HostWorkspaceRegistry } from '../support/dsh.ts'
import { registerGuidance } from './guidance.ts'
import { createRuntimeGraph, LiveMnemonRuntime } from '../engine/runtime.ts'
import { MnemonLifecycle, taskRoute } from './lifecycle.ts'
import { SkillEvolution } from '../skills/skill-evolution.ts'
import { DEFAULT_SKILLS_CONFIG, type ResolvedSkillsConfig } from '../contracts/protocol.ts'
import { skillsSourceFor } from '../skills/skill-source.ts'
import { registerRpc, runServerSync } from '../surface/rpc.ts'
import { hasNativeDirectoryPicker } from '../surface/directory-picker.ts'
import { migrateLegacyDisplayMode, registerSettingsRpc } from '../configuration/settings.ts'
import { MnemonSubagentCoordinator } from '../delegation/subagent.ts'
import { registerTools } from '../surface/tools.ts'
import { registerMnemonSubagentTokenUsageProjection } from '../delegation/subagent-token-usage.ts'
import { provideMemoryRuntime } from '../../core/runtime.ts'
import { MemoryPluginManagement } from '../surface/plugin-management.ts'
import { registerViewRpc } from '../surface/view-rpc.ts'
import { MemoryPluginInstallation } from '../surface/plugin-installation.ts'
import { MnemonRemoteService } from '../surface/remote-rpc.ts'
import { plainHostConfig, type LiveHostConfig } from '../configuration/live-config.ts'
import { ProfileMnemonSettings } from '../configuration/settings-service.ts'
import { installDevelopmentReload } from './development-reload.ts'
import { AutoSyncScheduler } from '../engine/auto-sync.ts'
import { syncProgress } from '../engine/sync-progress.ts'
import { hasSyncConnection } from '../configuration/sync-settings.ts'
import { dshPluginCommand, VersionUpdateManager, type DshBundleInstaller } from '../surface/version-updates.ts'

export const name = 'dsh-mnemo-weave'
export const provide = ['mnemonMemory']
export const inject = ['tools', 'settings', 'commands', 'agents', 'subagents']
export { LiveConfig as Config } from '../configuration/live-config.ts'
export type { MnemonConfig }

/** Resolve the optional Web workspace service at call time, not plugin-mount time. */
function optionalWorkspaceRegistry(ctx: HostContextShape): HostWorkspaceRegistry {
  const current = (): HostWorkspaceRegistry | undefined => ctx.get('workspaceRegistry') as HostWorkspaceRegistry | undefined
  return {
    get: id => current()?.get(id),
    list: () => current()?.list() ?? [],
  }
}

/** DSH owns assembly; this Host only wires scope, phases and user preferences. */
export function apply(rawContext: unknown, rawConfig: MnemonConfig | LiveHostConfig = {}): void {
  const ctx = rawContext as unknown as HostContextShape
  installDevelopmentReload(ctx)
  const config = plainHostConfig(rawConfig)
  const hostSettings = new ProfileMnemonSettings(ctx, rawConfig)
  registerMnemonSubagentTokenUsageProjection(ctx)
  const extensions = provideMemoryRuntime(ctx)
  const memoryPlugins = new MemoryPluginManagement(ctx, extensions, hostSettings)
  const pluginInstallation = new MemoryPluginInstallation(ctx)
  const effectiveConfig = (value: MnemonConfig) => memoryPlugins.resolveConfig(resolveConfig(value))
  // 技能管理's settings: read at every turn and review, so a change applies at once.
  const skillSettings = hostSettings.register<ResolvedSkillsConfig>('mnemon-skills', SkillsConfig, {
    base: { ...DEFAULT_SKILLS_CONFIG },
    applies: 'live',
  })
  const settings = hostSettings.register<MnemonConfig>('mnemon', PlainConfig, {
    base: config,
    applies: 'live',
    // Profile writes commit asynchronously. Check that the candidate composes
    // now, then build from the committed live references on volatile-update.
    validate: value => createRuntimeGraph(effectiveConfig(value), undefined, extensions, skillSettings.get().allowLinkedUpdates).dispose(),
  })
  const runtime = new LiveMnemonRuntime(createRuntimeGraph(effectiveConfig(settings.get()), undefined, extensions, skillSettings.get().allowLinkedUpdates), optionalWorkspaceRegistry(ctx), ctx.agents, extensions)
  const resolved = runtime.config
  ctx.effect(() => hostSettings.onUpdated((namespace, value) => {
    if (namespace === 'mnemon-skills') {
      if (runtime.snapshot().allowLinkedSkillUpdates !== skillSettings.get().allowLinkedUpdates) {
        runtime.swap(createRuntimeGraph(effectiveConfig(settings.get()), undefined, extensions, skillSettings.get().allowLinkedUpdates))
      }
      return
    }
    if (namespace === memoryPlugins.settingsNamespace) {
      runtime.swap(createRuntimeGraph(effectiveConfig(settings.get()), undefined, extensions, skillSettings.get().allowLinkedUpdates))
      return
    }
    if (namespace !== 'mnemon') return
    runtime.swap(createRuntimeGraph(effectiveConfig(value as MnemonConfig), undefined, extensions, skillSettings.get().allowLinkedUpdates))
  }), 'dsh-mnemo-weave: live runtime settings')
  ctx.effect(() => memoryPlugins.start(), 'dsh-mnemo-weave: plugin graph settings')
  hostSettings.register('mnemon-ui', InteractionConfig, {
    base: resolveInteractionConfig(resolved.conversationInteraction),
    applies: 'live',
  })
  ctx.effect(() => {
    let disposed = false
    const migrate = (): void => {
      if (disposed) return
      void migrateLegacyDisplayMode(hostSettings).catch(error => {
        console.warn('dsh-mnemo-weave: could not persist the builtin displayMode migration', error)
      })
    }
    const unsubscribe = ctx.on('settings/document-updated', ((namespace: string) => {
      if (namespace === 'mnemon') migrate()
    }) as never)
    migrate()
    return () => { disposed = true; unsubscribe() }
  }, 'dsh-mnemo-weave: canonical displayMode migration')
  const coordinator: MnemonSubagentCoordinator = new MnemonSubagentCoordinator(ctx.subagents, runtime, ctx, () => {
    const taskAgentModel = runtime.config.taskAgentModel
    if (taskAgentModel.mode !== 'fixed') return undefined
    const provider = taskAgentModel.provider?.trim()
    const model = taskAgentModel.model?.trim()
    if (provider === undefined || provider === '' || model === undefined || model === '') return undefined
    return { provider, model }
  }, () => runtime.config.runtimeMemory.maintenanceMaxTokens,
  (scope, signal, operation) => lifecycle.runRuntimeMaintenanceTask(scope, signal, operation))
  const lifecycle = new MnemonLifecycle(ctx, coordinator, runtime.config, runtime)
  const skills = new SkillEvolution({
    settings: () => skillSettings.get(),
    source: agent => skillsSourceFor(runtime, agent),
    taskRoute: workspace => lifecycle.skillTaskRoute(workspace),
    skillEvidence: (parent, topic, signal) => coordinator.skillEvidence(parent, topic, signal),
    runTask: (workspaceRoot, signal, operation, route) => lifecycle.runSkillTask(workspaceRoot, signal, operation, route),
    skillTask: (parent, label, prompt, schema, persona, signal, _route, maxTokens) => coordinator.skillTask(parent, label, prompt, schema, persona, signal, taskRoute(parent), maxTokens),
  })
  ctx.effect(() => hostSettings.onUpdated(() => skills.settingsChanged()), 'dsh-mnemo-weave: automatic skill adoption settings')
  lifecycle.useSkillEvolution(skills)
  ctx.effect(() => {
    const stop = lifecycle.start()
    return async () => {
      stop()
      skills.dispose()
      await coordinator.dispose()
      runtime.dispose()
    }
  }, 'dsh-mnemo-weave.lifecycle-root()')
  ctx.effect(() => {
    const loader = ctx.get('loader') as { await?(): Promise<unknown> } | undefined
    return registerTools(ctx, runtime, coordinator, extensions, loader?.await?.())
  }, 'dsh-mnemo-weave: Source tool lifecycle')
  // A server sync on a timer, when the profile switches it on. It runs the same
  // work the page's button does, through the same guard and progress record.
  const syncCredentials = () => ctx.get('credentials') as HostCredentialsService | undefined
  const autoSync = new AutoSyncScheduler(
    () => runtime.config.autoSync,
    syncProgress,
    async () => { await runServerSync(runtime, syncCredentials, { signal: AbortSignal.timeout(600_000) }) },
    // Only a Host that can name a server reaches one; an unconfigured profile
    // leaves the timer idle instead of reporting a failure every interval.
    () => hasSyncConnection(syncCredentials),
  )
  ctx.effect(() => {
    autoSync.start()
    return () => autoSync.dispose()
  }, 'dsh-mnemo-weave: automatic server sync')
  ctx.effect(() => hostSettings.onUpdated((namespace) => { if (namespace === 'mnemon') autoSync.settingsChanged() }), 'dsh-mnemo-weave: automatic server sync settings')
  registerCommands(ctx.commands, runtime, coordinator)
  registerGuidance(ctx, resolved, runtime)
  ctx.inject(['connection', 'webServer'], (webContext) => {
    // `inject` guarantees the service at runtime; retain the defensive guard
    // because HostContextShape also models profiles where it is absent.
    // Connection's RPC getter keeps its provider's injection scope. Carry
    // the explicitly injected server on our own Context so late registration
    // works without changing or restarting the shared Connection plugin.
    const connection = Context.is(webContext)
      ? webContext.extend({ webServer: webContext.get('webServer') }).connection
      : webContext.connection
    if (connection === undefined) return
    // The Starter updates through DSH's own plugin manager and profile, so a packaged
    // app's bundled pnpm serves it where no pnpm is on PATH.
    const versions = new VersionUpdateManager({
      mnemonCliPath: () => runtime.config.cliPath,
      bundleInstaller: () => ctx.get('pluginManager') as DshBundleInstaller | undefined,
      runningProfile: () => {
        const profile = ctx.get('profileContext') as { dir?: unknown; packageManager?: unknown } | undefined
        return typeof profile?.dir === 'string' ? { dir: profile.dir, packageManager: profile.packageManager !== undefined } : undefined
      },
      pluginCommand: () => dshPluginCommand(ctx.get('profileContext')),
    })
    const credentials = () => (webContext.get('credentials') ?? ctx.get('credentials')) as HostCredentialsService | undefined
    const rpc = registerRpc(connection, runtime, lifecycle, versions, () => hasNativeDirectoryPicker(ctx), credentials)
    const settings = registerSettingsRpc(connection, hostSettings, credentials)
    const view = registerViewRpc(connection, runtime, extensions, memoryPlugins, lifecycle, pluginInstallation)
    if (Context.is(webContext)) {
      new MnemonRemoteService(webContext, {
        ...rpc,
        settings,
        view: view.read,
        viewWrite: view.write,
        management: resolved.remoteAccess === 'trusted-host',
      })
    }
  })
}
