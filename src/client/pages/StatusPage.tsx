import { useEffect, useState, type ReactNode } from 'react'
import type { StatusView, StorageScopeInventory, StorageScopeKind } from '../../host/contracts/protocol.ts'
import type { MnemonClient } from '../connection/api.ts'
import { VersionDialog } from './VersionDialog.tsx'
import { clearStarterUpdate, pendingStarterUpdate } from './starter-update.ts'
import type { MnemonTranslate } from '../i18n/locales.ts'
import css from '../MnemonView.module.css'
import { useT, humanBytes, PageHeader } from '../kit/page-kit.tsx'
import { DiagnosticsView } from './DiagnosticsView.tsx'
import { MemoryActivityView } from './MemoryActivityView.tsx'

/** Which way a memory layer is not serving now, or that it is. */
export type LayerState = 'on' | 'off' | 'stopped' | 'memory-off'

/** A Source component's card on the Status page. */
export interface ComponentCard {
  key: string
  /** Identifies the component; several may ship in one package. */
  componentId: string
  packageName: string
  label: string
  enabled: boolean
  state: LayerState
}

export function StatusPage(props: {
  client: MnemonClient
  status: StatusView | null
  loading: boolean
  writeEnabled: boolean
  attention: boolean
  /** One card per Source component, in the order the configuration lists its layers. */
  components: readonly ComponentCard[]
  /** What a running component's card says: what it contributed, or that it runs. */
  renderCard: (card: ComponentCard) => ReactNode
  onRefresh: () => void
  /** Whether the page is visible; a hidden page stops reading the log. */
  active?: boolean
}): JSX.Element {
  const t = useT()
  // DSH swapped this client in during a Starter update started here: show how it ended.
  const [resumedUpdate, setResumedUpdate] = useState(() => pendingStarterUpdate())
  const [versionsOpen, setVersionsOpen] = useState(false)
  const status = props.status
  const answered = status !== null || !props.loading
  useEffect(() => {
    if (resumedUpdate === undefined || !answered) return
    // A DSH that already restarted onto the update has nothing left to report.
    if (status !== null && status.restartPending === undefined && resumedUpdate.to !== undefined && status.dshMnemonVersion === resumedUpdate.to) {
      clearStarterUpdate()
      setResumedUpdate(undefined)
      return
    }
    setVersionsOpen(true)
  }, [answered])
  const reviewError = status?.lifecycle?.current?.lastError
  const storage = status?.storage
  const selectedScopeKind = storage?.activeKind ?? 'global'
  const selectedScope = storage?.scopes.find(scope => scope.kind === selectedScopeKind)
  // A component that is off, or whose Source is not running, has no reading to wait for.
  const idle = (state: LayerState): { title: string; detail: string } | undefined => state === 'on' ? undefined
    : state === 'off' ? { title: t('layers.disabledBadge'), detail: t('status.layerOffDetail') }
      : state === 'memory-off' ? { title: t('layers.memoryOffBadge'), detail: t('status.layerMemoryOffDetail') }
        : { title: t('layers.stoppedBadge'), detail: t('status.layerStoppedDetail') }
  return (
    <div className={css.page}>
      <PageHeader title={t('status.title')} description={t('status.description')} meta={status === null && props.loading ? t('common.loading') : status === null || reviewError !== undefined || props.attention ? t('status.checkRequired') : t('status.nominal')} {...(props.loading ? { loadingLabel: t('status.rechecking') } : {})} action={<div className={css.statusHeaderActions}><button type="button" className={css.secondaryButton} onClick={() => setVersionsOpen(true)}>{t('versions.checkAction')}</button></div>} />

      <section className={css.healthStrip} aria-label={t('status.aria')}>
        <article><span className={`${css.healthIndicator} ${status === null ? css.healthMuted : css.healthGood}`} /><div><small>{t('status.engine')}</small><strong>{status?.dshMnemonVersion === undefined ? 'dsh-mnemo-weave' : `dsh-mnemo-weave ${status.dshMnemonVersion}`}</strong><p>{status === null ? t('status.pluginChecking') : t('status.pluginReady')}</p></div></article>
        {props.components.map(card => {
          const note = idle(card.state)
          return <article key={card.key} data-component={card.componentId}>
            <span className={`${css.healthIndicator} ${note === undefined && status !== null ? css.healthGood : css.healthMuted}`} />
            <div><small>{card.label}</small>{note === undefined ? props.renderCard(card) : <><strong>{note.title}</strong><p>{note.detail}</p></>}</div>
          </article>
        })}
        {/* Where memory lives reads as one more row of the same strip: a separate
            section for a root, a byte count and three counters spent a whole
            screen on what fits in one line. */}
        <StorageStrip catalog={storage} selected={selectedScope} selectedKind={selectedScopeKind} />
      </section>

      {/* What memory did recently, before the Host's own run log. */}
      <MemoryActivityView client={props.client} active={props.active !== false} t={t} writeEnabled={props.writeEnabled} onCleared={props.onRefresh} />
      {/* What the Host did recently, including why anything failed. */}
      <DiagnosticsView client={props.client} active={props.active !== false} t={t} />
      {versionsOpen && <VersionDialog client={props.client} writeEnabled={props.writeEnabled} resumedUpdate={resumedUpdate} onClose={() => { setResumedUpdate(undefined); setVersionsOpen(false) }} onRefreshStatus={props.onRefresh} />}
    </div>
  )
}

/** Where memory lives, as one more row of the status strip. */
function StorageStrip(props: {
  catalog: StatusView['storage']
  selected: StorageScopeInventory | undefined
  selectedKind: StorageScopeKind
}): JSX.Element {
  const t = useT()
  const scope = storageScopeLabel(t, props.selectedKind)
  // A scope with no root, or a catalog still loading, says so instead of showing
  // zeroes that read like an empty store.
  if (props.catalog === undefined || props.selected?.root === undefined) {
    const detail = props.catalog === undefined ? t('status.storageWaiting')
      : props.selectedKind === 'custom' ? t('status.storageCustomUnset') : t('status.storageWorkspaceUnavailable')
    return <article data-storage={props.selectedKind} data-state="unavailable">
      <span className={`${css.healthIndicator} ${css.healthMuted}`} />
      <div><small>{t('status.storageDomains')} · {scope}</small><strong>{t('status.storageNotCreated')}</strong><p title={detail}>{detail}</p></div>
    </article>
  }
  const problem = props.selected.areas.find(area => area.status === 'invalid')
  return <article data-storage={props.selectedKind} data-state={props.selected.available ? 'ready' : 'missing'}>
    <span className={`${css.healthIndicator} ${problem === undefined && props.selected.available ? css.healthGood : css.healthMuted}`} />
    <div>
      <small>{t('status.storageDomains')} · {scope}</small>
      {/* The size and the root a person comes here for; the path is long, so the
          title carries it whole while the row stays one line tall. */}
      <strong>{humanBytes(props.selected.totalBytes)}</strong>
      <p title={props.selected.root}>{props.selected.available ? props.selected.root : t('status.storageNotCreated')}</p>
    </div>
  </article>
}

export function storageScopeLabel(t: MnemonTranslate, kind: StorageScopeKind): string {
  return t(kind === 'global' ? 'status.storageGlobal' : kind === 'workspace' ? 'status.storageWorkspace' : kind === 'workspaces' ? 'status.storageWorkspaces' : 'status.storageCustom')
}

