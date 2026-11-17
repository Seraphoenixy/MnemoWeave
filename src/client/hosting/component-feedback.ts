import type { MemoryPluginEntryView, MemoryViewDashboard } from '../../host/contracts/view-protocol.ts'
import { componentModel, layerOf } from './component-model.ts'
import type { MnemonKey, MnemonTranslate } from '../i18n/locales.ts'
import { reconfiguredEntries, switchedEntries, type MnemonViewChange } from '../connection/view-store.ts'

/** What a change did, in one sentence, and where it shows on the page. */
export interface ChangeSummary {
  text: string
  tone: 'success' | 'warning' | 'info'
  /** Values of the page's target attribute for everything the change touched. */
  targets: string[]
}

/** Where a component shows on the configuration page. */
export function targetsOf(entry: MemoryPluginEntryView): string[] {
  if (entry.roles.includes('strategy')) return ['strategy']
  if (entry.roles.includes('strategy-extension')) return ['enhancement:' + entry.entryId]
  const layer = layerOf(entry)
  if (layer === undefined) return []
  return layer === 'memory-spaces' ? ['layer:' + layer, 'providers'] : ['layer:' + layer]
}

/** The component a write was made for, from the key of the control that made it. */
export function primaryOf(change: MnemonViewChange): string | undefined {
  const key = change.key ?? ''
  for (const prefix of ['component:', 'strategy:', 'options:']) if (key.startsWith(prefix)) return key.slice(prefix.length)
  return undefined
}

/**
 * Whether a change needs saying beyond what its own control shows: a change
 * made elsewhere, an undo, a switch that took other components along, a new
 * main Strategy, or memory composed differently. A plain switch already
 * shows its result in its own row.
 */
export function announces(change: MnemonViewChange): boolean {
  if (change.origin === 'external' || change.key?.startsWith('revert:') === true) return true
  // Options are edited in a panel that closes once they apply.
  if (reconfiguredEntries(change.before, change.after).length > 0) return true
  if (change.before.strategyTypeId !== change.after.strategyTypeId || switchedEntries(change.before, change.after).length !== 1) return true
  return componentModel(change.before).composing?.entryId !== componentModel(change.after).composing?.entryId
}

/**
 * Say what moved between two dashboards, leading with what it does to memory
 * as a whole: whether a main Strategy still composes it, and which one.
 * @param origin `own` for a write from this page, `external` for one made elsewhere.
 * @param name a component's display name.
 * @param primary the component the write was made for, when it took others along.
 */
export function describeChange(before: MemoryViewDashboard, after: MemoryViewDashboard, origin: 'own' | 'external', name: (entry: MemoryPluginEntryView) => string, t: MnemonTranslate, primary?: string): ChangeSummary | undefined {
  const switched = switchedEntries(before, after)
  const reconfigured = reconfiguredEntries(before, after)
  if (switched.length === 0 && reconfigured.length === 0 && before.strategyTypeId === after.strategyTypeId) return undefined
  const was = componentModel(before)
  const now = componentModel(after)
  const targets = [...new Set(['overview', ...switched.flatMap(targetsOf), ...reconfigured.flatMap(targetsOf), ...(before.strategyTypeId === after.strategyTypeId ? [] : ['strategy'])])]
  const own = origin === 'own'
  const list = (entries: readonly MemoryPluginEntryView[]): string => entries.map(entry => t('config.quoted', { name: name(entry) })).join(t('config.listSeparator'))
  if (switched.length === 0 && before.strategyTypeId === after.strategyTypeId) {
    // Only options changed.
    const component = reconfigured.length === 1 ? name(reconfigured[0]!) : undefined
    const text = component === undefined ? t(own ? 'feedback.several' : 'feedback.externalSeveral', { count: reconfigured.length })
      : t(own ? 'feedback.optionsSaved' : 'feedback.externalOptions', { component })
    return { text, tone: own ? 'success' : 'info', targets }
  }
  if (was.composing !== undefined && now.composing === undefined) return { text: t('feedback.memoryOff'), tone: 'warning', targets }
  if (was.composing === undefined && now.composing !== undefined) return { text: t('feedback.memoryRestored', { strategy: name(now.composing) }), tone: 'success', targets }
  if (was.composing?.entryId !== now.composing?.entryId && now.composing !== undefined) {
    const strategy = name(now.composing)
    if (!own) return { text: t('feedback.externalMain', { strategy }), tone: 'info', targets }
    const others = switched.filter(entry => entry !== now.composing)
    const on = others.filter(entry => entry.enabled)
    const off = others.filter(entry => !entry.enabled)
    const text = on.length === 0 && off.length === 0 ? t('feedback.switchedMain', { strategy })
      : on.length === 0 ? t('feedback.switchedMainOff', { strategy, others: list(off) })
        : off.length === 0 ? t('feedback.switchedMainWith', { strategy, others: list(on) })
          : t('feedback.switchedMainMixed', { strategy, on: list(on), off: list(off) })
    return { text, tone: 'success', targets }
  }
  if (switched.length !== 1) {
    // One switch that brought what it needs, or took along what could not stay.
    const lead = switched.find(entry => entry.entryId === primary)
    if (own && lead !== undefined) {
      const on = switched.filter(entry => entry !== lead && entry.enabled)
      const off = switched.filter(entry => entry !== lead && !entry.enabled)
      const component = name(lead)
      const text = !lead.enabled ? on.length === 0 ? t('feedback.disabledWith', { component, others: list(off) }) : undefined
        : off.length === 0 ? t('feedback.enabledWith', { component, others: list(on) })
          : on.length === 0 ? t('feedback.enabledReplacing', { component, others: list(off) })
            : t('feedback.enabledMixed', { component, on: list(on), off: list(off) })
      if (text !== undefined) return { text, tone: 'success', targets }
    }
    return { text: t(own ? 'feedback.several' : 'feedback.externalSeveral', { count: switched.length }), tone: own ? 'success' : 'info', targets }
  }
  const entry = switched[0]!
  const component = name(entry)
  const source = layerOf(entry) !== undefined
  const key: MnemonKey = own
    ? source ? entry.enabled ? 'feedback.sourceOn' : 'feedback.sourceOff' : entry.enabled ? 'feedback.componentOn' : 'feedback.componentOff'
    : source ? entry.enabled ? 'feedback.externalSourceOn' : 'feedback.externalSourceOff' : entry.enabled ? 'feedback.externalComponentOn' : 'feedback.externalComponentOff'
  return { text: t(key, { component }), tone: own ? 'success' : 'info', targets }
}
