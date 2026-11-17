import type { ComposableMemoryView, MemoryStrategyManifest, MemoryStrategyWorkflow } from '../../core/contracts/index.ts'

/** What the Host reads from a Strategy to decide which background work it drives. */
export type StrategyDeclaration = Pick<MemoryStrategyManifest, 'typeId' | 'workflows'>

const LAYERED_STRATEGY = 'default-three-tier'

/**
 * Whether the Host runs a background workflow for a Strategy: the ones it
 * declares. The Layered strategy declares both from 0.5.10 on; an earlier
 * copy of it, which a Profile can still keep, declares none, so its type id
 * stands for the declaration.
 */
export function strategyDrives(strategy: StrategyDeclaration, workflow: MemoryStrategyWorkflow): boolean {
  return strategy.workflows === undefined ? strategy.typeId === LAYERED_STRATEGY : strategy.workflows.includes(workflow)
}

/** A write that runtime-capacity maintenance takes over: the Runtime Source's own mutate Action. */
export function runtimeCapacityWrite(strategy: StrategyDeclaration, sourceTypeId: string, actionId: string): boolean {
  return sourceTypeId === 'runtime' && actionId === 'mutate' && strategyDrives(strategy, 'runtime-capacity')
}

/** The Strategy that composed a View, as the generation that holds its definition declares it. */
export function viewStrategy(
  generation: { strategy?: { instanceKey: string; definition: { manifest: MemoryStrategyManifest } } } | undefined,
  view: Pick<ComposableMemoryView, 'strategyInstanceKey' | 'strategyTypeId'>,
): StrategyDeclaration {
  const strategy = generation?.strategy
  return strategy?.instanceKey === view.strategyInstanceKey ? strategy.definition.manifest : { typeId: view.strategyTypeId }
}
