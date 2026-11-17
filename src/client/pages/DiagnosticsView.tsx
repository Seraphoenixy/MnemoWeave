import { useCallback, useEffect, useState, type JSX } from 'react'
import type { DiagnosticEntry } from '../../host/contracts/protocol.ts'
import type { MnemonClient } from '../connection/api.ts'
import type { MnemonTranslate } from '../i18n/locales.ts'
import { message, useLocale } from '../kit/page-kit.tsx'
import css from '../MnemonView.module.css'

/** How many lines the page reads; the Host keeps the same number. */
const READ_LIMIT = 200
/** A page that is being watched for a failure reads again on this interval. */
const POLL_MS = 5_000

/**
 * What the Host did recently, newest first, with the cause chain of anything
 * that failed. A failure is reported here instead of as an alert over the
 * workspace: the workspace is where memory is read, and a red band there
 * describes neither what failed nor what to do about it.
 */
export function DiagnosticsView(props: { client: MnemonClient; active: boolean; t: MnemonTranslate }): JSX.Element {
  const { client, t } = props
  const locale = useLocale()
  const [entries, setEntries] = useState<DiagnosticEntry[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [level, setLevel] = useState<'all' | 'error'>('all')

  const load = useCallback(async (): Promise<void> => {
    try {
      const value = await client.diagnostics(READ_LIMIT)
      setEntries(value.entries)
      setFailed(null)
    } catch (error) {
      setFailed(message(error))
    }
  }, [client])

  useEffect(() => {
    if (!props.active) return
    let live = true
    void load()
    // A failure the user is waiting on appears without pressing Refresh.
    const timer = setInterval(() => { if (live) void load() }, POLL_MS)
    return () => { live = false; clearInterval(timer) }
  }, [load, props.active])

  const shown = entries === null ? [] : level === 'error' ? entries.filter(entry => entry.level === 'error') : entries
  const counts = { error: 0, warning: 0, info: 0 }
  for (const entry of entries ?? []) counts[entry.level] += 1

  return <section className={css.diagnostics} aria-labelledby="mnemon-diagnostics-heading">
    <header>
      <div>
        <h2 id="mnemon-diagnostics-heading">{t('diagnostics.title')}</h2>
        <p>{t('diagnostics.description')}</p>
      </div>
      <div className={css.diagnosticsActions}>
        {/* The one summary the page keeps: a count, not a band over the workspace. */}
        {counts.error > 0 && <span className={css.diagnosticsCount} data-level="error">{t('diagnostics.errorCount', { count: counts.error })}</span>}
        {counts.warning > 0 && <span className={css.diagnosticsCount} data-level="warning">{t('diagnostics.warningCount', { count: counts.warning })}</span>}
        <button type="button" className={css.secondaryButton} aria-pressed={level === 'error'} onClick={() => setLevel(level === 'error' ? 'all' : 'error')}>
          {level === 'error' ? t('diagnostics.showAll') : t('diagnostics.showErrors')}
        </button>
        <button type="button" className={css.secondaryButton} onClick={() => { void load() }}>{t('common.refresh')}</button>
      </div>
    </header>
    {failed !== null && <p className={css.diagnosticsFailure} role="alert">{t('diagnostics.unavailable', { error: failed })}</p>}
    {entries === null ? <p className={css.diagnosticsEmpty}>{t('common.loading')}</p>
      : shown.length === 0 ? <p className={css.diagnosticsEmpty}>{level === 'error' ? t('diagnostics.noErrors') : t('diagnostics.empty')}</p>
        : <ol className={css.diagnosticsList}>
          {shown.map((entry, index) => <li key={`${entry.at}-${index}`} data-level={entry.level}>
            <time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleTimeString(locale)}</time>
            <span className={css.diagnosticsArea}>{entry.area}</span>
            <div>
              <span>{entry.message}</span>
              {entry.detail !== undefined && <code>{entry.detail}</code>}
            </div>
          </li>)}
        </ol>}
    <p className={css.diagnosticsFootnote}>{t('diagnostics.footnote')}</p>
  </section>
}