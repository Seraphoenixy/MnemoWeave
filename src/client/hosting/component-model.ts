import type { MemoryPluginEntryView, MemoryViewDashboard } from '../../host/contracts/view-protocol.ts'

/** Shipped Source components are named after the memory layer they serve. */
const SHIPPED_SOURCE_PREFIX = 'source-'
/** An enhancement that fits whichever main Strategy offers its slot. */
const ANY_STRATEGY = '*'

/** How the memory components on the configuration page depend on each other right now. */
export interface MemoryComponentModel {
  /** The built-in Strategy row, when the Host reports one. */
  mains: MemoryPluginEntryView[]
  /** Optional behaviors added to the main Strategy. */
  enhancements: MemoryPluginEntryView[]
  /** The main Strategy the configuration names. */
  selected: MemoryPluginEntryView | undefined
  /**
   * The main Strategy composing memory now: the selected one while it runs,
   * otherwise the only main Strategy running. None while no main Strategy
   * runs, or while several run and the selected one does not.
   */
  composing: MemoryPluginEntryView | undefined
  /**
   * The type id of the Strategy composing memory now. Core's own composes when
   * the View lists no Strategy row, so an enhancement still knows its target.
   */
  composingTypeId: string | undefined
}

const running = (entry: MemoryPluginEntryView): boolean => entry.enabled && entry.active

export function componentModel(dashboard: MemoryViewDashboard): MemoryComponentModel {
  const mains = dashboard.entries.filter(entry => entry.roles.includes('strategy') && entry.typeId !== undefined)
  const enhancements = dashboard.entries.filter(entry => entry.roles.includes('strategy-extension'))
  // Core composes with its own Strategy, so the dashboard row only reports it. A
  // View that lists no Strategy row still composes with Core's, whose type id the
  // dashboard names: an enhancement targets that Strategy rather than nothing.
  const selected = mains.find(entry => entry.typeId === dashboard.strategyTypeId) ?? mains[0]
  const composing = selected !== undefined && running(selected) ? selected : undefined
  const composingTypeId = composing !== undefined ? composing.typeId : mains.length === 0 ? dashboard.strategyTypeId : undefined
  return { mains, enhancements, selected, composing, composingTypeId }
}

/** The memory layer a Source component serves: its registered type, or while it is off, the shipped component's name. */
export function layerOf(entry: MemoryPluginEntryView): string | undefined {
  if (!entry.roles.includes('source')) return undefined
  if (entry.typeId !== undefined) return entry.typeId
  return entry.componentId.startsWith(SHIPPED_SOURCE_PREFIX) ? entry.componentId.slice(SHIPPED_SOURCE_PREFIX.length) : undefined
}

/** The Source component serving a memory layer, including one that is switched off and so has no registered type. */
export function sourceOf(dashboard: MemoryViewDashboard, layerId: string): MemoryPluginEntryView | undefined {
  const sources = dashboard.entries.filter(entry => entry.roles.includes('source'))
  return sources.find(entry => entry.typeId === layerId) ?? sources.find(entry => layerOf(entry) === layerId)
}

function provides(entry: MemoryPluginEntryView, capability: string): boolean {
  return entry.provides.some(value => value.id === capability)
}

/**
 * Capabilities the Host provides without a listed component switching them: Core
 * owns the Strategy whatever rows show, and a running Source the plugin manager
 * does not manage still provides its role, as the Host counts both.
 */
function implicitCapabilities(dashboard: MemoryViewDashboard): Set<string> {
  const managed = new Set(dashboard.entries.map(entry => entry.componentId))
  return new Set(['strategy', ...dashboard.sources.filter(source => !managed.has(source.componentId ?? source.packageName)).flatMap(source => ['source', 'source.' + source.role])])
}

/** The switches a change brings with it, or why it cannot be made. */
export type SwitchPlan =
  | { changes: SwitchChange[]; blocked?: undefined }
  | { changes?: undefined; blocked: 'last-source' }

/** One switch in a plan, and why it moves when the user did not ask for it. */
export interface SwitchChange {
  entry: MemoryPluginEntryView
  enabled: boolean
  /** `needed`: what a component turned on requires; `conflict`: what cannot run beside it; `dependent`: what loses what it requires. */
  reason?: 'needed' | 'conflict' | 'dependent'
}

/**
 * Whether two components cannot run together, as the Host judges it: they
 * provide the same capability and either claims it alone, or they are
 * enhancements filling the same slot for the same main Strategy.
 */
export function conflicts(left: MemoryPluginEntryView, right: MemoryPluginEntryView): boolean {
  if (left === right) return false
  const claimed = left.provides.some(capability => right.provides.some(other => other.id === capability.id && (capability.exclusive || other.exclusive)))
  if (claimed) return true
  if (left.slot === undefined || left.slot !== right.slot || !left.roles.includes('strategy-extension') || !right.roles.includes('strategy-extension')) return false
  const [one, two] = [left.strategyTypeId ?? ANY_STRATEGY, right.strategyTypeId ?? ANY_STRATEGY]
  return one === two || one === ANY_STRATEGY || two === ANY_STRATEGY
}

/**
 * Keep the components consistent around the switches the user asked for.
 * Whatever is turned on brings what it requires and nothing provides, and
 * turns off what cannot run beside it; whatever loses a capability it
 * requires goes off too. A main Strategy never goes off that way: taking away
 * the last Source it needs is refused instead.
 */
export function planSwitches(dashboard: MemoryViewDashboard, asked: ReadonlyArray<{ entry: MemoryPluginEntryView; enabled: boolean }>): SwitchPlan {
  const state = new Map(dashboard.entries.map(entry => [entry.entryId, entry.enabled]))
  const implicit = implicitCapabilities(dashboard)
  const reasons = new Map<string, SwitchChange['reason']>()
  const wanted = new Map(asked.map(({ entry, enabled }) => [entry.entryId, enabled]))
  const on = (entry: MemoryPluginEntryView): boolean => state.get(entry.entryId) === true
  const set = (entry: MemoryPluginEntryView, enabled: boolean, reason?: SwitchChange['reason']): void => {
    state.set(entry.entryId, enabled)
    if (reason !== undefined && !wanted.has(entry.entryId)) reasons.set(entry.entryId, reason)
  }
  const turnedOn: MemoryPluginEntryView[] = []
  for (const { entry, enabled } of asked) {
    set(entry, enabled)
    if (enabled) turnedOn.push(entry)
  }
  // What is turned on displaces what cannot run beside it, and brings what it needs.
  for (let index = 0; index < turnedOn.length; index += 1) {
    const entry = turnedOn[index]!
    for (const other of dashboard.entries) {
      if (on(other) && wanted.get(other.entryId) !== true && conflicts(entry, other)) set(other, false, 'conflict')
    }
    for (const requirement of entry.requires) {
      if (implicit.has(requirement) || dashboard.entries.some(candidate => on(candidate) && provides(candidate, requirement))) continue
      const provider = dashboard.entries.find(candidate => !on(candidate) && candidate.writable && wanted.get(candidate.entryId) !== false
        && provides(candidate, requirement) && !dashboard.entries.some(other => on(other) && conflicts(candidate, other)))
      if (provider === undefined) continue
      set(provider, true, 'needed')
      turnedOn.push(provider)
    }
  }
  // Whatever this change takes a required capability from goes off too, until
  // nothing more moves. A requirement nothing met before is not this change's
  // doing, and one the user just turned on is theirs to ask for.
  const metBefore = (requirement: string): boolean => implicit.has(requirement) || dashboard.entries.some(candidate => candidate.enabled && provides(candidate, requirement))
  const metNow = (requirement: string): boolean => implicit.has(requirement) || dashboard.entries.some(candidate => on(candidate) && provides(candidate, requirement))
  for (let moved = true; moved;) {
    moved = false
    for (const entry of dashboard.entries) {
      if (!on(entry) || !entry.enabled || !entry.requires.some(requirement => metBefore(requirement) && !metNow(requirement))) continue
      // A main Strategy the user keeps cannot lose its last Source.
      if (entry.roles.includes('strategy')) return { blocked: 'last-source' }
      set(entry, false, 'dependent')
      moved = true
    }
  }
  const changes = dashboard.entries.flatMap((entry): SwitchChange[] => {
    const enabled = state.get(entry.entryId)!
    if (enabled === entry.enabled && !wanted.has(entry.entryId)) return []
    const reason = reasons.get(entry.entryId)
    return [{ entry, enabled, ...(reason === undefined ? {} : { reason }) }]
  })
  return { changes }
}

/** What turning one component on or off takes along; see {@link planSwitches}. */
export function switchPlan(dashboard: MemoryViewDashboard, entry: MemoryPluginEntryView, enabled: boolean): SwitchPlan {
  return planSwitches(dashboard, [{ entry, enabled }])
}

/** One main Strategy composes memory: choosing one turns it on and every other main Strategy off. */
export function mainPlan(dashboard: MemoryViewDashboard, entry: MemoryPluginEntryView): SwitchPlan {
  const others = dashboard.entries.filter(other => other !== entry && other.enabled && other.roles.includes('strategy') && other.typeId !== undefined)
  return planSwitches(dashboard, [{ entry, enabled: true }, ...others.map(other => ({ entry: other, enabled: false }))])
}

/** How one component relates to the others installed, from their declarations. */
export interface ComponentRelations {
  /** Each capability it requires, the installed components that provide it, and whether one runs. */
  needs: Array<{ requirement: string; providers: MemoryPluginEntryView[]; met: boolean }>
  /** Switched-on components that require a capability only it provides now. */
  neededBy: MemoryPluginEntryView[]
  /** Installed components that cannot run beside it. */
  conflictsWith: MemoryPluginEntryView[]
}

export function relationsOf(dashboard: MemoryViewDashboard, entry: MemoryPluginEntryView): ComponentRelations {
  const implicit = implicitCapabilities(dashboard)
  return {
    needs: entry.requires.map(requirement => {
      const providers = dashboard.entries.filter(candidate => candidate !== entry && provides(candidate, requirement))
      return { requirement, providers, met: implicit.has(requirement) || providers.some(candidate => candidate.enabled) }
    }),
    neededBy: !entry.enabled ? [] : dashboard.entries.filter(candidate => candidate !== entry && candidate.enabled && candidate.requires.some(requirement => provides(entry, requirement)
      && !implicit.has(requirement) && !dashboard.entries.some(other => other !== entry && other.enabled && provides(other, requirement)))),
    conflictsWith: dashboard.entries.filter(candidate => conflicts(entry, candidate)),
  }
}

export interface UnmetRequirement {
  requirement: string
  /** Installed components that would provide it once switched on. */
  providers: MemoryPluginEntryView[]
}

/** What a switched-on component requires that no switched-on component provides. */
export function unmetRequirements(dashboard: MemoryViewDashboard, entry: MemoryPluginEntryView): UnmetRequirement[] {
  const implicit = implicitCapabilities(dashboard)
  return entry.requires.flatMap(requirement => implicit.has(requirement) || dashboard.entries.some(candidate => candidate.enabled && provides(candidate, requirement))
    ? []
    : [{ requirement, providers: dashboard.entries.filter(candidate => !candidate.enabled && provides(candidate, requirement)) }])
}

/**
 * Whether the composing main Strategy takes this enhancement. `composingTypeId`
 * names the Strategy composing memory, which is Core's own when the View lists
 * no Strategy row.
 */
export function enhancementApplies(entry: MemoryPluginEntryView, composingTypeId: string | undefined): boolean {
  return composingTypeId !== undefined && (entry.strategyTypeId === undefined || entry.strategyTypeId === ANY_STRATEGY || entry.strategyTypeId === composingTypeId)
}
