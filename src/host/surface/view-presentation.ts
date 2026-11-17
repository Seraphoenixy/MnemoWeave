import { createMemoryWake, type ComposableMemoryTurn, type MemoryWakeBindings } from '../../core/turns.ts'
import type { MemoryCompositionGeneration } from '../../core/composition.ts'
import type { ComposableMemoryView } from '../../core/contracts/index.ts'
import type { MemoryViewInspection } from '../contracts/view-protocol.ts'
import type { MnemonRuntimeGraph } from '../engine/runtime.ts'
import { memoryTools, namedToolInstance } from '../contracts/protocol.ts'

/**
 * The named tools bound to each Source type's Routes or Actions, from the tool table: these are
 * existing DSH product-tool bindings, not Core operation names. Tools that share one operation are
 * listed together, in table order, as the View's tool list names them.
 */
function namedBindings(kind: 'route' | 'action'): Record<string, Record<string, string>> {
  const bindings: Record<string, Record<string, string>> = {}
  for (const [name, tool] of memoryTools()) {
    if (tool.sourceTypeId === undefined || tool.operation === undefined || (tool.kind === 'write') !== (kind === 'action')) continue
    const operations = bindings[tool.sourceTypeId] ??= {}
    const listed = operations[tool.operation]
    operations[tool.operation] = listed === undefined ? name : `${listed} / ${name}`
  }
  return bindings
}
const ROUTE_TOOLS = namedBindings('route')
const ACTION_TOOLS = namedBindings('action')
const NAMED_SOURCE_TYPES = [...new Set([...Object.keys(ROUTE_TOOLS), ...Object.keys(ACTION_TOOLS)])]

function isWorkingRulesProjection(fragment: ComposableMemoryView['projection'][number], runtimeSources: ReadonlySet<string>): boolean {
  const value = fragment.provenance
  return runtimeSources.has(fragment.sourceInstanceKey)
    && typeof value === 'object' && value !== null && !Array.isArray(value) && value.workingRules === true
}

export function workingRulesSystemText(graph: MnemonRuntimeGraph, turn: ComposableMemoryTurn): string {
  const sources = graph.memoryComposition.generation(turn.view.runtimeGeneration)?.sourceInstances() ?? []
  const runtimeSources = new Set(sources.filter(source => source.sourceTypeId === 'runtime').map(source => source.sourceInstanceKey))
  return turn.view.projection.filter(fragment => isWorkingRulesProjection(fragment, runtimeSources)).map(fragment => fragment.text).join('\n\n')
}

/** Present only operations bound to a registered product tool. */
export function modelMemoryWake(graph: MnemonRuntimeGraph, turn: ComposableMemoryTurn, includeRuntime = true) {
  const generation = graph.memoryComposition.generation(turn.view.runtimeGeneration)
  if (generation === undefined) throw new Error('Cannot present an unpinned Memory generation')
  const runtimeSources = new Set(generation.sourceInstances().filter(source => source.sourceTypeId === 'runtime').map(source => source.sourceInstanceKey))
  const projection = turn.view.projection.filter(fragment => !runtimeSources.has(fragment.sourceInstanceKey)
    || (includeRuntime && !isWorkingRulesProjection(fragment, runtimeSources)))
  return createMemoryWake({ ...turn.view, projection }, memoryWakeBindings(generation, turn.view))
}

export function presentMemoryWake(generation: MemoryCompositionGeneration, view: ComposableMemoryView) {
  return createMemoryWake(view, memoryWakeBindings(generation, view))
}

function memoryWakeBindings(generation: MemoryCompositionGeneration, view: ComposableMemoryView): MemoryWakeBindings {
  const instances = generation.sourceInstances()
  const routes: Record<string, string> = {}, actions: Record<string, string> = {}
  for (const typeId of NAMED_SOURCE_TYPES) {
    const selected = namedToolInstance(instances.filter(source => source.sourceTypeId === typeId), typeId)
    if (selected === undefined) continue
    for (const route of view.routes.filter(route => route.sourceInstanceKey === selected.sourceInstanceKey)) {
      const grant = view.readGrants.find(grant => grant.id === route.readGrantId)
      if (grant?.schema !== `dsh-mnemon.${typeId}/v1`) continue
      const tool = ROUTE_TOOLS[typeId]?.[route.sourceRouteId]
      if (tool !== undefined) routes[route.id] = tool
    }
    for (const action of view.actionOffers.filter(action => action.sourceInstanceKey === selected.sourceInstanceKey)) {
      const tool = ACTION_TOOLS[typeId]?.[action.sourceActionId]
      if (tool !== undefined) actions[action.id] = tool
    }
  }
  return { routes, actions }
}

/** Explicitly pick display fields; never copy grants, authority, or opaque Source state. */
export function inspectMemoryView(generation: MemoryCompositionGeneration, view: ComposableMemoryView, state: MemoryViewInspection['state'], turn?: number, memoryText?: string): MemoryViewInspection {
  return structuredClone({
    id: view.id, digest: view.digest, generationId: view.runtimeGeneration, createdAt: view.createdAt,
    state, ...(turn === undefined ? {} : { turn }), strategyTypeId: view.strategyTypeId, strategyInstanceKey: view.strategyInstanceKey,
    extensions: view.strategyExtensions ?? [],
    projection: view.projection.map(({ id, sourceInstanceKey, mode, text, revision }) => ({ id, sourceInstanceKey, mode, text, revision })),
    sourcePresentations: view.sourcePresentations ?? [],
    routes: view.routes.map(({ id, sourceInstanceKey, sourceRouteId, description, maxCalls }) => ({ id, sourceInstanceKey, operationId: sourceRouteId, description, maxCalls })),
    actions: view.actionOffers.map(({ id, sourceInstanceKey, sourceActionId, description }) => ({ id, sourceInstanceKey, operationId: sourceActionId, description })),
    memoryText: memoryText ?? presentMemoryWake(generation, view).text,
    ...(view.guidance === undefined ? {} : { guidance: view.guidance }),
    diagnostics: (view.diagnostics ?? []).map(diagnostic => diagnostic.message),
  })
}
