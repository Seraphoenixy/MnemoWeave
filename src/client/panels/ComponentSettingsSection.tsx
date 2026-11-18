import { useCallback, useMemo, useSyncExternalStore, type JSX, type ReactNode } from 'react'
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MemoryPluginEntryView, MemoryViewDashboard } from '../../host/contracts/view-protocol.ts'
import { componentCopy } from '../hosting/component-copy.ts'
import css from '../MnemonSettingsCard.module.css'
import type { MnemonTranslate } from '../i18n/locales.ts'

/**
 * The settings components contribute, keyed by component id: the settings page
 * draws them beside the board, and the board reads which components have any.
 */
export interface ComponentSettingsRenderer {
  has(componentId: string): boolean
  render(entry: MemoryPluginEntryView, writable: boolean): ReactNode
}

export interface ComponentSettingsSectionProps {
  dashboard: MemoryViewDashboard | null
  /** The settings each component contributed, keyed by component id. */
  settings: ComponentSettingsRenderer | undefined
  readOnly: boolean
  language: string
  t: MnemonTranslate
}

/**
 * The settings the components contributed, gathered on the settings page itself,
 * one group per component that contributed any.
 *
 * A component's page keeps what describes the component — its state, its switch,
 * what it needs and what needs it, and the options it declares. These settings
 * are the configuration the component reads while it runs, so they belong where
 * the rest of the configuration is, and they are written here and nowhere else:
 * one control per setting, and no second copy to fall out of step.
 */
export function ComponentSettingsSection(props: ComponentSettingsSectionProps): JSX.Element | null {
  const { dashboard, settings, readOnly, language, t } = props
  const entries = useMemo(() => (dashboard?.entries ?? [])
    .filter(entry => settings?.has(entry.componentId) === true)
    // Running components first, then by name, so the groups a person is most
    // likely to change sit above the ones that are switched off.
    .sort((left, right) => Number(right.enabled) - Number(left.enabled) || componentCopy(left, language).label.localeCompare(componentCopy(right, language).label)),
  [dashboard, settings, language])
  if (settings === undefined || entries.length === 0) return null
  return <section className={css.section} aria-labelledby="mnemon-component-settings-heading">
    <div className={css.sectionHeading}>
      <h2 id="mnemon-component-settings-heading">{t('config.componentSettingsTitle')}</h2>
      <p>{t('config.componentSettingsDescription')}</p>
    </div>
    {entries.map(entry => <ComponentSettingsGroup key={entry.entryId} entry={entry} settings={settings} readOnly={readOnly} language={language} t={t} />)}
  </section>
}

/**
 * One component's settings under its own name. A component that is switched off
 * still shows them, disabled: the configuration stays visible and says why it
 * cannot be written, rather than disappearing with the switch.
 */
function ComponentSettingsGroup(props: { entry: MemoryPluginEntryView; settings: ComponentSettingsRenderer; readOnly: boolean; language: string; t: MnemonTranslate }): JSX.Element {
  const { entry, settings, readOnly, language, t } = props
  const copy = componentCopy(entry, language)
  // Opens by default: a folded group would hide the very settings this section
  // exists to put in reach. The state is kept while the page is open.
  const [open, setOpen] = useComponentSection(entry.entryId)
  return <div className={css.componentSettingsGroup}>
    <button type="button" className={css.componentSettingsHead} aria-expanded={open} onClick={() => setOpen(!open)}>
      <IconChevronDownOutlineRegular size={12} aria-hidden="true" />
      <span className={css.componentSettingsName}>{copy.label}</span>
      <span className={css.componentSettingsState} data-tone={entry.enabled ? 'done' : 'idle'}>
        {t(entry.enabled ? 'board.running' : 'board.off')}
      </span>
    </button>
    {open && <div className={css.componentSettingsBody}>
      {copy.hint !== '' && <p className={css.panelNote}>{copy.hint}</p>}
      {settings.render(entry, !readOnly)}
    </div>}
  </div>
}

/** Whether one component's group is open, kept for as long as the client runs. */
const closedSections = new Set<string>()
const sectionListeners = new Set<() => void>()

function subscribeSection(listener: () => void): () => void {
  sectionListeners.add(listener)
  return () => { sectionListeners.delete(listener) }
}

function useComponentSection(id: string): [boolean, (open: boolean) => void] {
  const subscribe = useCallback((listener: () => void) => subscribeSection(listener), [])
  const getSnapshot = useCallback(() => !closedSections.has(id), [id])
  const open = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const setOpen = useCallback((next: boolean) => {
    if (next) closedSections.delete(id)
    else closedSections.add(id)
    for (const listener of [...sectionListeners]) listener()
  }, [id])
  return [open, setOpen]
}
