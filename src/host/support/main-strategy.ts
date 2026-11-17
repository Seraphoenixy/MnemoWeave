import type { ResolvedConfig } from '../configuration/config.ts'
import { BUILTIN_STRATEGY_TYPE_ID } from '../../core/strategy/builtin.ts'

// The Host composes every View with Core's built-in layered Strategy. There is
// no profile choice to apply: `memoryTopology.strategyId` and
// `memoryView.strategyTypeId` are still read from stored profiles so that older
// data loads, but neither selects a Strategy any more.

/** The type id of the Strategy the Host composes the View with. */
export function mainStrategyTypeId(_config?: Pick<ResolvedConfig, 'memoryTopology'>): string {
  return BUILTIN_STRATEGY_TYPE_ID
}
