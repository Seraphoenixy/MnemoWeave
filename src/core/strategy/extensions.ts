import { memoryViewExtensionValues, validateMemoryViewExtension } from '../../sdk/view-extensions.ts'
import type { MemoryJsonValue, MemoryStrategyContribution, MemoryViewExtensionSlot, MemoryViewExtensionValues, MemoryViewRequest } from '../contracts/index.ts'

/** The layered Strategy uses Core's standard View extension slots. */
export type ThreeTierExtensionValues = MemoryViewExtensionValues
export type ThreeTierExtensionSlot = MemoryViewExtensionSlot

export function validateThreeTierExtension<K extends ThreeTierExtensionSlot>(slot: K, value: MemoryJsonValue): ThreeTierExtensionValues[K] {
  return validateMemoryViewExtension(slot, value)
}

export function threeTierContributions(values: readonly MemoryStrategyContribution[]): Partial<ThreeTierExtensionValues> {
  return memoryViewExtensionValues(values)
}
