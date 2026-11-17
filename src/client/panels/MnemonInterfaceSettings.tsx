import { type JSX } from 'react'
import {
  normalizeDisplayMode,
  type ClientConnectionHandle,
  type ClientSettingsScope,
  type Config,
  type InteractionConfig,
} from '../../host/contracts/protocol.ts'
import { isRemoteConnection } from '../connection/remote-rpc.ts'
import { SelectRow, ToggleRow } from '../kit/settings-controls.tsx'
import { useLive, useScope, WriteFailure } from '../kit/settings-panel.tsx'
import css from '../MnemonSettingsCard.module.css'
import { translateZh, type MnemonTranslate } from '../i18n/locales.ts'

export interface MnemonInterfaceSettingsProps {
  scope: ClientSettingsScope<Config>
  /** Separate live namespace of the in-conversation surfaces; without it they use `scope`. */
  interactionScope?: ClientSettingsScope<InteractionConfig>
  connection?: ClientConnectionHandle
  t?: MnemonTranslate
}

/**
 * Where the memory system appears and which in-conversation surfaces run. This is
 * the whole dsh-mnemo-weave page under DSH Plugins: memory composition and storage
 * live on the Memory System's own settings page, which this page does not carry.
 *
 * Every control applies when it changes; the display choice re-mounts the memory
 * view where DSH reads the setting.
 */
export function MnemonInterfaceSettings({ scope, interactionScope: suppliedInteractionScope, connection, t = translateZh }: MnemonInterfaceSettingsProps): JSX.Element | null {
  const interactionScope = suppliedInteractionScope ?? scope as unknown as ClientSettingsScope<InteractionConfig>
  const coreSnapshot = useScope(scope)
  const interactionSnapshot = useScope(interactionScope)
  const loading = coreSnapshot.status === 'loading' || interactionSnapshot.status === 'loading'
  // A successful writable settings snapshot is the Host's authoritative
  // capability grant. DSH authenticates the complete Host API, so transport
  // locality is not a capability signal.
  const writable = coreSnapshot.writable && interactionSnapshot.writable
  const coreDisabled = loading || !coreSnapshot.writable
  const interactionDisabled = loading || !interactionSnapshot.writable
  const readOnlyNotice = connection !== undefined && isRemoteConnection(connection) ? t('config.remoteReadOnly') : t('config.readOnly')
  const display = useLive(normalizeDisplayMode(coreSnapshot.value?.displayMode), async value => { await scope.mutate([{ op: 'set', path: ['displayMode'], value }]) })
  const turnBar = useLive(interactionSnapshot.value?.turnBar !== false, async value => { await interactionScope.mutate([{ op: 'set', path: ['turnBar'], value }]) })
  const saveAction = useLive(interactionSnapshot.value?.saveAction !== false, async value => { await interactionScope.mutate([{ op: 'set', path: ['saveAction'], value }]) })

  if (coreSnapshot.status === 'unavailable' && interactionSnapshot.status === 'unavailable') {
    return <section className={css.page} aria-label={t('config.aria')}><p className={css.error} role="alert">{t('config.unavailable')}</p></section>
  }

  return (
    <section className={css.page} aria-label={t('config.aria')} aria-busy={loading}>
      {loading ? <p className={css.loading} role="status">{t('common.loading')}</p> : <>
        {/* Like DSH's own settings forms, a read-only document says so above its controls. */}
        {!writable && <p className={css.readOnlyNotice}>{readOnlyNotice}</p>}
        <section className={css.section} aria-labelledby="mnemon-interface-heading">
          <div className={css.sectionHeading}><h2 id="mnemon-interface-heading">{t('config.interfaceTitle')}</h2></div>
          <div className={css.rows}>
            <SelectRow id="mnemon-display" label={t('config.displayTitle')} value={display.value} disabled={coreDisabled} onChange={display.set} options={[
              { value: 'sidebar', label: t('config.displaySidebar'), detail: t('config.displaySidebarHint') },
              { value: 'builtin', label: t('config.displayBuiltin'), detail: t('config.displayBuiltinHint') },
            ]} />
            <ToggleRow id="mnemon-interaction-turn-bar" label={t('config.interactionTurnBar')} hint={t('config.interactionTurnBarHint')} checked={turnBar.value} disabled={interactionDisabled} onChange={turnBar.set} />
            <ToggleRow id="mnemon-interaction-save-action" label={t('config.interactionSaveAction')} hint={t('config.interactionSaveActionHint')} checked={saveAction.value} disabled={interactionDisabled} onChange={saveAction.set} />
          </div>
          <WriteFailure error={display.failed ?? turnBar.failed ?? saveAction.failed} t={t} />
        </section>
      </>}
    </section>
  )
}
