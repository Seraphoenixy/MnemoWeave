import { STARTER_COMPONENT_ROWS } from '../../host/contracts/protocol.ts'
import type { MemoryPluginEntryView } from '../../host/contracts/view-protocol.ts'
import type { MnemonTranslate } from '../i18n/locales.ts'

/** Components the dsh-mnemo-weave Starter installs; any other component came from an installed extension. */
const SHIPPED_COMPONENTS: ReadonlySet<string> = new Set(STARTER_COMPONENT_ROWS.map(row => row.componentId))

/** Shipped components still taking shape: their row and page say so, and they may change more than the rest. */
const EXPERIMENTAL_COMPONENTS: ReadonlySet<string> = new Set(['source-skills'])

/** Whether a component is marked experimental. */
export function isExperimental(entry: Pick<MemoryPluginEntryView, 'componentId'>): boolean {
  return EXPERIMENTAL_COMPONENTS.has(entry.componentId)
}

/** Whether a component ships with dsh-mnemo-weave rather than an installed extension. */
export function isShipped(entry: Pick<MemoryPluginEntryView, 'componentId'>): boolean {
  return SHIPPED_COMPONENTS.has(entry.componentId)
}

/**
 * A component's name and description in the page's language, from its own
 * declaration: shipped and installed components are named the same way.
 */
export function componentCopy(entry: MemoryPluginEntryView, language: string): { label: string; hint: string } {
  const zh = language.toLowerCase().startsWith('zh')
  return { label: zh ? entry.label['zh-CN'] : entry.label.en, hint: zh ? entry.description['zh-CN'] : entry.description.en }
}

/** Quoted names joined in the page's language. */
export function nameList(names: readonly string[], t: MnemonTranslate): string {
  return names.map(name => t('config.quoted', { name })).join(t('config.listSeparator'))
}
