import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX, type ReactNode } from 'react'
import {
  type ClientConnectionHandle,
  type ClientSettingsScope,
  type Config,
  type MemoryCompositionStatus,
} from "../../host/contracts/protocol.ts"
import type { MemoryPluginEntryView } from '../../host/contracts/view-protocol.ts'
import { MnemonClient } from '../connection/api.ts'
import { isRemoteConnection } from '../connection/remote-rpc.ts'
import { CompositionBoard, usePageTrail, type ComponentSettingsRenderer, type LayerSettings } from './CompositionBoard.tsx'
import { subscribeComponentPage, takeComponentPage } from '../hosting/component-page-request.ts'
import { componentCopy } from '../hosting/component-copy.ts'
import { useViewFeedback } from '../kit/view-feedback.tsx'
import { useScope } from '../kit/settings-panel.tsx'
import { useViewStore } from '../connection/view-store.ts'
import css from '../MnemonSettingsCard.module.css'
import { isRecord } from '../kit/is-record.ts'
import { translateZh, type MnemonTranslate } from '../i18n/locales.ts'
import { usePackTarget } from './MnemonPackSection.tsx'
import { MnemonStorageSection } from './MnemonStorageSection.tsx'
import type { MnemonDirectoryPicker } from '../kit/picker.ts'
import type { MnemonChangeSignal } from '../kit/change-signal.ts'

/** How the page reaches the settings components contribute to their own pages. */
export interface ComponentSettingsSource {
  /** Whether a component registered settings, by package name. */
  has(packageName: string): boolean
  /** Render them for one component's page. */
  render(entry: MemoryPluginEntryView, page: { enabled: boolean; label: string; writable: boolean; language: string; sessionId?: string; workspace?: { id: string; label?: string } }): ReactNode
}

export interface MnemonSettingsCardProps {
  scope: ClientSettingsScope<Config>
  /** Loopback RPC used for whole-directory ZIP backup and restore. */
  connection?: ClientConnectionHandle
  directoryPicker?: MnemonDirectoryPicker
  sessionId?: string
  workspaceId?: string
  workspaceLabel?: string
  t?: MnemonTranslate
  /** Active DSH locale id for installed Strategies that bring their own text. */
  language?: string
  /**
   * Moves when a component is switched through DSH's plugin manager.
   * This page moves it too after a sync, a merge, an import or an applied plan, so the memory views read memory again.
   */
  componentChanges?: Pick<MnemonChangeSignal, 'subscribe' | 'getSnapshot' | 'bump'>
  /** The settings components contribute to their pages; without it a page shows what their declarations give. */
  componentSettings?: ComponentSettingsSource
}

const NO_CHANGE_SIGNAL: Pick<MnemonChangeSignal, 'subscribe' | 'getSnapshot' | 'bump'> = { subscribe: () => () => {}, getSnapshot: () => 0, bump: () => {} }

/**
 * The memory configuration: how the components compose memory, then what belongs
 * to no component — where memory lives. The Memory System shows it on its own
 * settings page. Interface settings live on the bundle page under DSH Plugins,
 * which draws it outside this component (see MnemonInterfaceSettings).
 *
 * Switches and selectors apply when they change, as the composition's do.
 * Typed values wait for their group's Apply; the storage location waits too,
 * because it moves where every component reads and writes.
 */
export function MnemonSettingsCard({ scope, connection, directoryPicker, sessionId, workspaceId, workspaceLabel, t = translateZh, language = 'zh', componentChanges = NO_CHANGE_SIGNAL, componentSettings }: MnemonSettingsCardProps): JSX.Element | null {
  const coreSnapshot = useScope(scope)
  const [targetRevision, setTargetRevision] = useState(0)
  const componentRevision = useSyncExternalStore(componentChanges.subscribe, componentChanges.getSnapshot, componentChanges.getSnapshot)
  // Every term only grows, so the sum changes whenever any one does. The
  // settings revision covers saves to the same Host entry from another page
  // or window, which the View revision includes.
  const dataRevision = targetRevision + componentRevision + (coreSnapshot.revision ?? 0)
  const viewClient = useMemo(() => connection === undefined ? undefined : new MnemonClient(connection, sessionId, workspaceId), [connection, sessionId, workspaceId])
  const view = useViewStore(viewClient, dataRevision)
  const pages = usePageTrail()
  // A page elsewhere asked for one component's settings, such as 技能管理's gear: open its page here.
  const entries = view.state.dashboard?.entries
  const openPage = pages.open
  useEffect(() => {
    if (entries === undefined) return
    const take = (): void => {
      const requested = takeComponentPage()
      const entry = requested === undefined ? undefined : entries.find(candidate => candidate.componentId === requested)
      if (entry !== undefined) openPage(entry.entryId, 'configuration')
    }
    take()
    return subscribeComponentPage(take)
  }, [entries, openPage])
  // A layer an earlier configuration turned off comes back on through its saved switch.
  const layerSettings = useMemo<LayerSettings>(() => ({
    set: async (layerId, enabled) => {
      await scope.mutate([{ op: 'set', path: ['memoryTopology', 'layers', layerId, 'enabled'], value: enabled }])
      setTargetRevision(revision => revision + 1)
    },
  }), [scope])
  // Every change says what it did where the user is looking, and points at the rows it touched.
  const root = useRef<HTMLElement | null>(null)
  const feedbackToast = useViewFeedback(view, root, t, language)
  const [memorySystem, setMemorySystem] = useState<MemoryCompositionStatus | null>(null)
  const [memorySystemState, setMemorySystemState] = useState<'unavailable' | 'loading' | 'ready' | 'error'>(connection === undefined ? 'unavailable' : 'loading')
  const topologyRequest = useRef(0)
  const { target } = usePackTarget(connection, sessionId, workspaceId, dataRevision)

  useEffect(() => {
    if (connection === undefined) {
      topologyRequest.current += 1
      setMemorySystem(null)
      setMemorySystemState('unavailable')
      return
    }
    const request = topologyRequest.current + 1
    topologyRequest.current = request
    setMemorySystemState('loading')
    void new MnemonClient(connection, sessionId, workspaceId).memorySystem().then(descriptor => {
      if (topologyRequest.current !== request) return
      setMemorySystem(descriptor)
      setMemorySystemState('ready')
    }, () => {
      if (topologyRequest.current !== request) return
      setMemorySystem(null)
      setMemorySystemState('error')
    })
    return () => { topologyRequest.current += 1 }
  }, [connection, sessionId, workspaceId, dataRevision])

  const coreUser = useMemo(() => isRecord(coreSnapshot.user) ? coreSnapshot.user : {}, [coreSnapshot.user])
  const loading = coreSnapshot.status === 'loading'
  // A successful writable settings snapshot is the Host's authoritative
  // capability grant. DSH authenticates the complete Host API, so transport
  // locality is not a capability signal.
  const writable = coreSnapshot.writable

  // The page's composition opens each component's page; what the component contributed renders there.
  const settingsRenderer = useMemo<ComponentSettingsRenderer | undefined>(() => componentSettings === undefined ? undefined : {
    has: packageName => componentSettings.has(packageName),
    render: (entry, writableNow) => componentSettings.render(entry, {
      enabled: entry.enabled, label: componentCopy(entry, language).label, writable: writableNow, language,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(workspaceId === undefined ? {} : { workspace: { id: workspaceId, ...(workspaceLabel === undefined ? {} : { label: workspaceLabel }) } }),
    }),
  }, [componentSettings, language, sessionId, workspaceId, workspaceLabel])

  if (coreSnapshot.status === 'unavailable') {
    return <section className={css.page} aria-label={t('config.aria')}><p className={css.error} role="alert">{t('config.unavailable')}</p></section>
  }

  const coreDisabled = loading || !coreSnapshot.writable
  const readOnlyNotice = connection !== undefined && isRemoteConnection(connection) ? t('config.remoteReadOnly') : t('config.readOnly')
  return (
    <section ref={root} className={css.page} aria-label={t('config.aria')} aria-busy={loading}>
      {loading ? <p className={css.loading} role="status">{t('common.loading')}</p> : <>
        {/* Like DSH's own settings forms, a read-only document says so above its controls. */}
        {!writable && <p className={css.readOnlyNotice}>{readOnlyNotice}</p>}
        <CompositionBoard view={view} system={memorySystem} systemPending={memorySystemState === 'loading'} layers={layerSettings} readOnly={!coreSnapshot.writable} language={language} t={t}
          pages={pages} {...(settingsRenderer === undefined ? {} : { componentSettings: settingsRenderer })} />

        <MnemonStorageSection scope={scope} value={coreSnapshot.value} user={coreUser} disabled={coreDisabled} dashboard={view.state.dashboard} target={target}
          {...(directoryPicker === undefined ? {} : { directoryPicker })}
          {...(connection === undefined ? {} : { connection })} {...(sessionId === undefined ? {} : { sessionId })} {...(workspaceId === undefined ? {} : { workspaceId })}
          language={language} t={t} onOpen={entry => pages.open(entry.entryId, 'configuration')} onSaved={() => setTargetRevision(revision => revision + 1)}
          onDataChanged={componentChanges.bump} />

        {feedbackToast}
      </>}
    </section>
  )
}
