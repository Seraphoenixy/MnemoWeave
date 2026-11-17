import { useCallback, useEffect, useState, type JSX } from 'react'
import type { ActivityRecordView } from '../../host/contracts/protocol.ts'
import type { MnemonClient } from '../connection/api.ts'
import type { MnemonKey, MnemonTranslate } from '../i18n/locales.ts'
import { message, useLocale } from '../kit/page-kit.tsx'
import { MnemonDialog } from '../kit/MnemonDialog.tsx'
import css from '../MnemonView.module.css'

/** How many events the page asks for; the Host caps it at the same number. */
const READ_LIMIT = 50
/** A watched page re-reads at this interval, as the run log does. */
const POLL_MS = 5_000

/**
 * What memory did recently, as the immutable events the activity sync carries:
 * the reads, writes and delegated runs this Host recorded, newest first. A line
 * reports the structured outcome — returned, empty, skipped, committed, failed
 * — rather than a rendered result, because whether a model used a recall is not
 * something the record claims.
 *
 * The list can be cleared. A clear deletes every event the two streams hold when
 * it is pressed and records one boundary event, which the sync carries to the
 * server and to any other client so all three end up holding the same short
 * stream instead of an ever-growing history.
 */
export function MemoryActivityView(props: {
  client: MnemonClient
  active: boolean
  t: MnemonTranslate
  /** Whether mutations are allowed; a read-only Host keeps the clear action closed. */
  writeEnabled?: boolean
  /** Called after a clear, so the page that draws this one can refresh what it read. */
  onCleared?: () => void
}): JSX.Element {
  const { client, t, onCleared } = props
  const locale = useLocale()
  const [records, setRecords] = useState<ActivityRecordView[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [cleared, setCleared] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const value = await client.memoryActivity(READ_LIMIT)
      setRecords(value.records)
      setFailed(null)
    } catch (error) {
      setFailed(message(error))
    }
  }, [client])

  useEffect(() => {
    if (!props.active) return
    let live = true
    void load()
    const timer = setInterval(() => { if (live) void load() }, POLL_MS)
    return () => { live = false; clearInterval(timer) }
  }, [load, props.active])

  const clear = useCallback(async (): Promise<void> => {
    setClearing(true)
    try {
      const result = await client.clearMemoryActivity()
      const total = result.workspace + result.rules
      setCleared(total === 0 ? t('activity.clearedNothing')
        : t('activity.cleared', { count: total, workspace: result.workspace, rules: result.rules }))
      setAsking(false)
      await load()
      onCleared?.()
    } catch (error) {
      setCleared(null)
      setFailed(message(error))
    } finally {
      setClearing(false)
    }
  }, [client, load, onCleared, t])

  const clearable = props.writeEnabled === true && (records?.length ?? 0) > 0

  return <section className={css.memoryActivity} aria-labelledby="mnemon-memory-activity-heading">
    <header>
      <div>
        <h2 id="mnemon-memory-activity-heading">{t('activity.title')}</h2>
        <p>{t('activity.description')}</p>
      </div>
      <div className={css.diagnosticsActions}>
        <button type="button" className={css.dangerButton} disabled={!clearable || clearing}
          onClick={() => { setCleared(null); setAsking(true) }}>{t('activity.clear')}</button>
        <button type="button" className={css.secondaryButton} onClick={() => { void load() }}>{t('common.refresh')}</button>
      </div>
    </header>
    {failed !== null && <p className={css.diagnosticsFailure} role="alert">{t('activity.unavailable', { error: failed })}</p>}
    {cleared !== null && <p className={css.diagnosticsFootnote} role="status">{cleared}</p>}
    {records === null ? <p className={css.diagnosticsEmpty}>{t('common.loading')}</p>
      : records.length === 0 ? <p className={css.diagnosticsEmpty}>{t('activity.empty')}</p>
        : <ol className={css.activityList}>
          {records.map((record, index) => <li key={`${record.at}-${index}`} data-kind={record.kind} data-outcome={record.outcome}>
            <time dateTime={new Date(record.at).toISOString()}>{new Date(record.at).toLocaleTimeString(locale)}</time>
            <span className={css.activityStream}>{t(record.stream === 'workspace' ? 'activity.streamWorkspace' : 'activity.streamRules')}</span>
            <div>
              <span>{recordTitle(t, record)}</span>
              <em>{t(`activity.outcome.${record.outcome}` as MnemonKey)}</em>
              {record.trigger !== undefined && <code>{t(`activity.trigger.${record.trigger}` as MnemonKey)}</code>}
              {record.skipReason !== undefined && <code>{t(`activity.skip.${record.skipReason}` as MnemonKey)}</code>}
              {record.results !== undefined && <code>{t('activity.results', { count: record.results })}</code>}
              {record.durationMs !== undefined && <code>{t('activity.duration', { ms: record.durationMs })}</code>}
              {record.committedWrites !== undefined && <code>{t('activity.committedWrites', { count: record.committedWrites })}</code>}
            </div>
          </li>)}
        </ol>}
    <p className={css.diagnosticsFootnote}>{t('activity.footnote')}</p>
    {asking && <MnemonDialog title={t('activity.clearTitle')} description={t('activity.clearDescription')} closeLabel={t('common.close')}
      busy={clearing} onClose={() => setAsking(false)} footer={<div className={css.modalFooterActions}>
        <button type="button" data-dialog-close data-autofocus className={css.secondaryButton} disabled={clearing} onClick={() => setAsking(false)}>{t('common.cancel')}</button>
        <button type="button" className={css.dangerSolidButton} disabled={clearing} onClick={() => { void clear() }}>{clearing ? t('activity.clearing') : t('activity.clearConfirm')}</button>
      </div>}>
      <div className={css.activityClearSummary}>
        <p>{t('activity.clearEffects')}</p>
        <p>{t('activity.clearSync')}</p>
      </div>
    </MnemonDialog>}
  </section>
}

/** A memory event by its source and operation; a delegated run by its task type. */
function recordTitle(t: MnemonTranslate, record: ActivityRecordView): string {
  if (record.kind === 'subagent') return t(`activity.task.${record.operation}` as MnemonKey)
  const source = record.source === undefined ? undefined : t(`activity.source.${record.source}` as MnemonKey)
  const operation = t(`activity.operation.${record.operation}` as MnemonKey)
  return source === undefined ? operation : `${source} · ${operation}`
}
