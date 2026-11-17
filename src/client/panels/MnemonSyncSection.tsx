import { useEffect, useId, useMemo, useState } from 'react'
import { Button, StateDot, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientConnectionHandle, ClientSettingsScope, Config, SyncPhase, SyncProgressView } from '../../host/contracts/protocol.ts'
import { DEFAULT_AUTO_SYNC } from '../../host/contracts/protocol.ts'
import { MnemonClient } from '../connection/api.ts'
import type { MnemonKey, MnemonTranslate } from '../i18n/locales.ts'
import { message, useLocale } from '../kit/page-kit.tsx'
import { SettingRow, SettingSelect, ToggleRow } from '../kit/settings-controls.tsx'
import { useLive, useScope, WriteFailure } from '../kit/settings-panel.tsx'
import css from '../MnemonSettingsCard.module.css'
import { useElapsedSeconds, useSyncProgressView } from './use-sync-progress.ts'

interface MnemonSyncSectionProps {
  connection?: ClientConnectionHandle
  onMerged?: () => void
  /** The Host settings the automatic run reads; without it the section runs only on demand. */
  scope?: ClientSettingsScope<Config>
  t: MnemonTranslate
}

const PHASE_KEY: Record<SyncPhase, MnemonKey> = {
  prepare: 'serverSync.phasePrepare',
  snapshot: 'serverSync.phaseSnapshot',
  activity: 'serverSync.phaseActivity',
}

/** Stands in for the settings scope when the page carries none: nothing to read, nothing writable. */
const NO_SCOPE = {
  getSnapshot: () => ({ status: 'unavailable' as const, writable: false }),
  subscribe: () => () => {},
} as unknown as ClientSettingsScope<Config>

/** The intervals the selector offers, in the order the menu lists them. */
const AUTO_SYNC_INTERVALS = [300_000, 900_000, 1_800_000, 3_600_000] as const

function stamp(locale: string, value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(locale)
}

export function MnemonSyncSection({ connection, onMerged, scope, t }: MnemonSyncSectionProps) {
  const client = useMemo(() => connection === undefined ? undefined : new MnemonClient(connection), [connection])
  const locale = useLocale()
  const urlId = useId()
  const passwordId = useId()
  const [saved, setSaved] = useState<Awaited<ReturnType<MnemonClient['syncConnection']>>>()
  const [draftUrl, setDraftUrl] = useState<string>()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  // Only a sync-all run is a run; saving a connection is one request of its own.
  const [syncing, setSyncing] = useState(false)
  const [status, setStatus] = useState('')
  const [conflict, setConflict] = useState<string>()
  // A run in another window is in flight here too, so the inputs stay closed
  // and the line below says what it is doing.
  const progress = useSyncProgressView(client, syncing)
  const running = syncing || progress?.running === true
  const elapsed = useElapsedSeconds(progress?.startedAt, running)
  const unavailable = running || client === undefined
  const url = draftUrl ?? saved?.url ?? ''
  const dirty = url.trim() !== (saved?.url ?? '') || password !== ''

  // The automatic run reads the Host settings this page saves into; each switch
  // applies as it is made, like the composition's. Without a scope the section
  // offers only the run on demand.
  const settings = useScope(scope ?? NO_SCOPE)
  const autoSettings = settings.value?.autoSync
  const writableScope = scope
  const autoEnabled = useLive(autoSettings?.enabled === true, async value => {
    if (writableScope !== undefined) await writableScope.mutate([{ op: 'set', path: ['autoSync', 'enabled'], value }])
  })
  const autoInterval = useLive(autoSettings?.intervalMs ?? DEFAULT_AUTO_SYNC.intervalMs, async value => {
    if (writableScope !== undefined) await writableScope.mutate([{ op: 'set', path: ['autoSync', 'intervalMs'], value }])
  })
  const autoDisabled = scope === undefined || settings.status !== 'ready' || !settings.writable
  const autoSync = scope === undefined ? undefined : {
    enabled: { value: autoEnabled.value, set: autoEnabled.set, disabled: autoDisabled },
    interval: { value: autoInterval.value, set: autoInterval.set, disabled: autoDisabled },
    failed: autoEnabled.failed ?? autoInterval.failed,
  }

  useEffect(() => {
    let active = true
    setSaved(undefined)
    setDraftUrl(undefined)
    setPassword('')
    setStatus('')
    setConflict(undefined)
    void client?.syncConnection().then(value => {
      if (!active) return
      setSaved(value)
    }, error => { if (active) setStatus(message(error)) })
    return () => { active = false }
  }, [client])

  async function save() {
    if (client === undefined || unavailable) return
    setBusy(true)
    setStatus('')
    setConflict(undefined)
    try {
      const value = await client.saveSyncConnection(url, password)
      setSaved(value)
      setDraftUrl(undefined)
      setPassword('')
      setStatus(t('serverSync.saved'))
    } catch (error) {
      setStatus(message(error))
    } finally {
      setBusy(false)
    }
  }

  async function run(resolve?: 'local' | 'server') {
    if (client === undefined || unavailable) return
    setSyncing(true)
    setStatus('')
    setConflict(undefined)
    try {
      const result = await client.syncWithServer(resolve === undefined || conflict === undefined ? undefined : { resolve, conflictToken: conflict })
      const pulled = result.pulled + result.activityPulled
      const pushed = result.pushed + result.activityPushed
      setStatus(pulled + pushed === 0 ? t('serverSync.unchanged') : t('serverSync.done', { pulled, pushed }))
    } catch (error) {
      const details = error as { reason?: unknown; conflictToken?: unknown; target?: unknown } | null
      if (details?.reason === 'snapshot-conflict' && typeof details.conflictToken === 'string') {
        setConflict(details.conflictToken)
        setStatus(t('serverSync.conflict', { target: targetName(t, details.target) }))
      } else setStatus(message(error))
    } finally {
      setSyncing(false)
      onMerged?.()
    }
  }

  return <section>
    <SettingRow title={t('serverSync.title')}>
      <Button disabled={unavailable || busy || dirty || saved?.configured !== true} aria-busy={running || undefined}
        onClick={() => { void run() }}>
        {running ? <TextShimmer active>{t('serverSync.runningAction')}</TextShimmer> : t('serverSync.run')}
      </Button>
    </SettingRow>
    <SettingRow title={t('serverSync.url')} htmlFor={urlId}>
      <input id={urlId} className={css.workspacePaths} type="url" spellCheck={false} autoCapitalize="none"
        value={url} disabled={unavailable} onChange={event => { setDraftUrl(event.target.value); setConflict(undefined) }} />
    </SettingRow>
    <SettingRow title={t('serverSync.password')} htmlFor={passwordId}>
      <input id={passwordId} className={css.workspacePaths} type="password" autoComplete="new-password"
        placeholder={saved?.configured ? t('serverSync.configured') : undefined}
        value={password} disabled={unavailable} onChange={event => { setPassword(event.target.value); setConflict(undefined) }} />
      <Button disabled={unavailable || busy || !url.trim() || !password} aria-busy={busy || undefined}
        onClick={() => { void save() }}>{busy ? <TextShimmer active>{t('serverSync.verifying')}</TextShimmer> : t('serverSync.save')}</Button>
    </SettingRow>
    {running && <SyncRunning t={t} progress={progress} elapsed={elapsed} />}
    {status !== '' && <p className={css.syncProgress} role="status" data-tone={conflict === undefined ? undefined : 'error'}>{status}</p>}
    {/* Nothing was run from this page: the Host still knows how the last run ended. */}
    {!running && status === '' && progress?.last !== undefined && <SyncOutcome t={t} locale={locale} last={progress.last} />}
    {conflict !== undefined && <div>
      <Button disabled={unavailable} onClick={() => { void run('server') }}>{t('serverSync.useServer')}</Button>
      <Button disabled={unavailable} onClick={() => { void run('local') }}>{t('serverSync.useLocal')}</Button>
    </div>}
    {autoSync !== undefined && <>
      <ToggleRow id="mnemon-auto-sync" label={t('serverSync.autoTitle')} hint={t('serverSync.autoHint')}
        checked={autoSync.enabled.value} disabled={autoSync.enabled.disabled} onChange={autoSync.enabled.set} />
      {autoSync.enabled.value && <SettingRow title={t('serverSync.autoInterval')} hint={t('serverSync.autoIntervalHint')}>
        <SettingSelect labelledBy="mnemon-auto-sync-interval" value={String(autoSync.interval.value)}
          disabled={autoSync.interval.disabled} onChange={value => autoSync.interval.set(Number(value))}
          options={AUTO_SYNC_INTERVALS.map(intervalMs => ({
            value: String(intervalMs), label: t('serverSync.autoEvery', { minutes: Math.round(intervalMs / 60_000) }),
          }))} />
      </SettingRow>}
      {/* A conflict pauses the timer, so the page says why nothing runs. */}
      {autoSync.enabled.value && progress?.last?.state === 'failed' && progress.last.conflictTarget !== undefined &&
        <p className={css.syncProgress} role="status" data-tone="error"><span>{t('serverSync.autoPaused')}</span></p>}
      <WriteFailure error={autoSync.failed} t={t} />
    </>}
  </section>
}

/** The memory scope a conflict names, in the page's own words. */
function targetName(t: MnemonTranslate, target: unknown): string {
  return target === 'working-rules' ? t('serverSync.rulesTarget')
    : target === 'global-memory' ? t('serverSync.globalTarget') : String(target ?? '')
}

/** The step a run walks, how much of it has moved, and how long it has taken. */
function SyncRunning({ t, progress, elapsed }: { t: MnemonTranslate; progress: SyncProgressView | null; elapsed: number | undefined }) {
  const phase = progress?.phase
  const steps = progress?.steps ?? 0
  const step = progress?.step ?? 0
  const total = progress?.total ?? 0
  return <p className={css.syncProgress} role="status" aria-live="polite">
    <StateDot state="ongoing" />
    <span>{t(PHASE_KEY[phase ?? 'prepare'])}</span>
    {steps > 0 && <span data-quiet>{t('serverSync.step', { step: Math.max(1, step), steps })}</span>}
    {progress?.target !== undefined && <span data-quiet>{t('serverSync.onTarget', { target: targetName(t, progress.target) })}</span>}
    {total > 0 && <span data-quiet>{t('serverSync.transfer', { done: progress?.done ?? 0, total })}</span>}
    {elapsed !== undefined && <span data-quiet>{t('serverSync.elapsed', { seconds: elapsed })}</span>}
  </p>
}

/** How the previous run ended, when this page did not run it. */
function SyncOutcome({ t, locale, last }: { t: MnemonTranslate; locale: string; last: NonNullable<SyncProgressView['last']> }) {
  const time = stamp(locale, last.finishedAt)
  if (last.state === 'failed') {
    return <p className={css.syncProgress} role="status" data-tone="error">
      <span>{last.conflictTarget === undefined
        ? t('serverSync.lastFailed', { time, error: last.error ?? '' })
        : t('serverSync.lastConflict', { time, target: targetName(t, last.conflictTarget) })}</span>
    </p>
  }
  return <p className={css.syncProgress} role="status">
    <span>{t('serverSync.lastDone', { time, pulled: last.pulled + last.activityPulled, pushed: last.pushed + last.activityPushed })}</span>
  </p>
}