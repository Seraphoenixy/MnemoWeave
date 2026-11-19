import { useEffect, useId, useState, type JSX } from 'react'
import { IconCheckCircleOutlineRegular, IconClockOutlineRegular, IconGlobeOutlineRegular, IconLoadingOutlineRegular, IconWarningTriangleOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SyncProgressView } from '../../host/contracts/protocol.ts'
import type { MnemonClient } from '../connection/api.ts'
import type { MnemonTranslate } from '../i18n/locales.ts'
import css from '../MnemonView.module.css'

/** How often the header reads the sync state; a run in flight reports faster. */
const IDLE_MS = 15_000
const RUNNING_MS = 1_000

/** What the header says about the server sync, as Ygdria's sidebar does. */
type SyncState = 'unconfigured' | 'synced' | 'pending' | 'syncing' | 'failed'

function stateOf(progress: SyncProgressView | null, configured: boolean, running: boolean): SyncState {
  if (running || progress?.running === true) return 'syncing'
  if (!configured) return 'unconfigured'
  const last = progress?.last
  if (last?.state === 'failed') return 'failed'
  return last === undefined ? 'pending' : 'synced'
}

/**
 * The server sync, stated in the header rather than only on the settings page:
 * the state at a glance, the last run's counts on hover, and one press to run
 * it now. A run started anywhere — this header, the settings page, or the
 * Host's own timer — shows here, because the Host owns the record.
 */
export function SyncStatusIndicator(props: {
  client: MnemonClient | undefined
  /** Whether a server is configured; without one the indicator says so and offers nothing. */
  configured: boolean | undefined
  /** Opens the settings page where the server is configured. */
  onOpenSettings: (() => void) | undefined
  /** A run that ended, so the pages showing memory read it again. */
  onSynced: () => void
  t: MnemonTranslate
}): JSX.Element | null {
  const { client, t } = props
  const [progress, setProgress] = useState<SyncProgressView | null>(null)
  const [busy, setBusy] = useState(false)
  const [runFailed, setRunFailed] = useState(false)
  const summaryId = useId()

  useEffect(() => {
    if (client === undefined) { setProgress(null); return }
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = (): void => {
      timer = undefined
      client.syncProgress().then(value => {
        if (!active) return
        setProgress(value)
        timer = setTimeout(read, value.running || busy ? RUNNING_MS : IDLE_MS)
      }, () => {
        if (active) timer = setTimeout(read, IDLE_MS)
      })
    }
    read()
    return () => { active = false; if (timer !== undefined) clearTimeout(timer) }
  }, [client, busy])

  if (client === undefined || props.configured === undefined) return null
  const state = stateOf(progress, props.configured, busy)
  const last = progress?.last
  const target = (name: string): string => name === 'working-rules' ? t('serverSync.rulesTarget')
    : name === 'global-memory' ? t('serverSync.globalTarget') : name

  const summary = ((): string => {
    if (state === 'syncing') {
      const phase = progress?.phase === 'activity' ? t('serverSync.phaseActivity')
        : progress?.phase === 'snapshot' ? t('serverSync.phaseSnapshot') : t('serverSync.phasePrepare')
      return progress?.target === undefined ? phase : `${phase} · ${target(progress.target)}`
    }
    if (state === 'unconfigured') return t('syncStatus.unconfigured')
    if (state === 'failed') {
      return last?.conflictTarget === undefined
        ? t('syncStatus.failed', { error: last?.error ?? '' })
        : t('syncStatus.conflict', { target: target(last.conflictTarget) })
    }
    if (last === undefined) return t('syncStatus.pending')
    const time = new Date(last.finishedAt).toLocaleTimeString()
    const pulled = last.pulled + last.activityPulled
    const pushed = last.pushed + last.activityPushed
    return pulled + pushed === 0 ? t('syncStatus.syncedIdle', { time }) : t('syncStatus.synced', { time, pulled, pushed })
  })()

  // Each state has its own glyph: a run in flight is the loading arc, a failure
  // is a warning, a completed run is a check, a configured server that has not
  // run yet is a clock, and no server at all is the globe that opens its setup.
  // None of them repeats the header's refresh button.
  const glyph = state === 'syncing' ? <IconLoadingOutlineRegular size={16} className={css.syncSpinning} />
    : state === 'failed' ? <IconWarningTriangleOutlineRegular size={16} />
      : state === 'synced' ? <IconCheckCircleOutlineRegular size={16} />
        : state === 'pending' ? <IconClockOutlineRegular size={16} />
          : <IconGlobeOutlineRegular size={16} />

  // A configured server runs on press; an unconfigured one opens the page that
  // sets it up, because pressing it could not succeed.
  const action = (): void => {
    if (state === 'unconfigured') { props.onOpenSettings?.(); return }
    if (state === 'syncing' || busy) return
    setBusy(true)
    setRunFailed(false)
    client.syncWithServer()
      .then(() => { props.onSynced() })
      .catch(() => { setRunFailed(true); props.onSynced() })
      .finally(() => { setBusy(false) })
  }

  const tone = state === 'failed' ? 'error' : state === 'syncing' ? 'ongoing' : state === 'synced' ? 'done' : 'idle'
  return <span className={css.syncStatusWrap}>
    <button type="button" className={css.syncStatus} data-state={state} disabled={state === 'syncing'}
      aria-describedby={summaryId} onClick={action}
      aria-label={t('syncStatus.aria', { state: summary })}>
      <StateDot state={tone} />
      {glyph}
    </button>
    <span id={summaryId} className={css.syncSummary} role="tooltip">
      <strong>{t('syncStatus.title')}</strong>
      <span data-state={state}>{summary}</span>
      {state === 'unconfigured'
        ? <span className={css.compositionHint}>{t('syncStatus.configureHint')}</span>
        : state !== 'syncing' && <span className={css.compositionHint}>{runFailed ? t('syncStatus.retryHint') : t('syncStatus.runHint')}</span>}
    </span>
  </span>
}