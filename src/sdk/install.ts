import type { Context } from '@deepseek-ai/cordis'
import type { InstallMemoryOptions, MemoryInstallContribution } from './service.ts'

interface LoaderLike {
  locate(fiber?: unknown): string | undefined
}

function locatedEntryId(ctx: Context): string | undefined {
  const loader = ctx.get('loader', false) as LoaderLike | undefined
  const located = loader?.locate(ctx.fiber)?.trim()
  return located === '' ? undefined : located
}

function stableEntryId(ctx: Context, explicit: string | undefined): string {
  const configured = explicit?.trim()
  if (configured !== undefined && configured !== '') return configured
  const located = locatedEntryId(ctx)
  if (located !== undefined) return located
  throw new Error('installMemory requires a stable Loader Entry id; pass options.instanceId for direct ctx.plugin() mounts')
}

/**
 * dshmarket mounts `mkt-client-<package>` for a profile dependency that
 * declares `dsh.client` without `dsh.bundle`, meant to run no host code. A
 * Source installed on its own in a profile matches that rule although the
 * Starter composes it, and dshmarket 1.66 imports the real module there, so
 * the Source would register a second instance (#359). Nothing installs under
 * such a mount, whatever identity the plugin passes. The Loader prefixes an
 * Entry id with its parents' ids, as in `include:dsh-market:mkt-client-<package>`,
 * so the last segment names it.
 */
const MARKET_CLIENT_SHIM = /(?:^|:)mkt-client-[^:]*$/u

/**
 * Register a plugin's Source and/or Strategy definitions as one Fiber-owned batch.
 * Contribution roles do not dictate package or repository boundaries.
 */
export function installMemory(ctx: Context, contribution: MemoryInstallContribution, options: InstallMemoryOptions = {}): void {
  if (MARKET_CLIENT_SHIM.test(locatedEntryId(ctx) ?? '')) return
  const entryId = stableEntryId(ctx, options.instanceId)
  ctx.effect(() => ctx.mnemonMemory.installContributions(contribution, {
    ...options, instanceId: entryId,
  }), `dsh-mnemo-weave: install ${entryId}`)
}
