import { COMPOSABLE_MEMORY_API_VERSION, type MemoryStrategyDefinition, type MemoryStrategyManifest } from '../contracts/index.ts'
import { DEFAULT_THREE_TIER_VIEW_STRATEGY } from './strategy.ts'

/**
 * The one Strategy the Host composes every View with. It is Core's own
 * definition, not a plugin contribution: the profile cannot select another one,
 * and an installed package cannot replace it.
 */
export const BUILTIN_STRATEGY_TYPE_ID = 'default-three-tier'
export const BUILTIN_STRATEGY_PACKAGE_NAME = 'dsh-mnemo-weave'
export const BUILTIN_STRATEGY_INSTANCE_KEY = 'strategy:builtin'

/** The built-in definition, with its manifest naming Core as the owning package. */
export const BUILTIN_VIEW_STRATEGY: MemoryStrategyDefinition = Object.freeze({
  ...DEFAULT_THREE_TIER_VIEW_STRATEGY,
  manifest: Object.freeze({
    ...DEFAULT_THREE_TIER_VIEW_STRATEGY.manifest,
    apiVersion: COMPOSABLE_MEMORY_API_VERSION,
    typeId: BUILTIN_STRATEGY_TYPE_ID,
    packageName: BUILTIN_STRATEGY_PACKAGE_NAME,
  }) as MemoryStrategyManifest,
})

export { DEFAULT_THREE_TIER_VIEW_STRATEGY }
