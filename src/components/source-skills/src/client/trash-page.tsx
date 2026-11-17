import { useEffect, useState, type JSX } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { SelectField, SidebarModal } from 'dsh-mnemo-weave/client'
import type { SkillRootKind, TrashEntry, TrashRestoreInput, TrashRestorePreview } from '../contracts.ts'
import { css, errorText, stamp, useT } from './presentation.ts'
import { Busy, Confirm, Empty, Field, SkillIcon } from './shared.tsx'
import type { SkillsLocation, SkillsPageContext } from './ui.tsx'

/** A size the eye can compare: bytes under a kilobyte, else whole KiB or MiB. */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/**
 * Skills taken out of DSH's reach: every removal still sits on disk under the
 * Source's `trash` directory, so it can be put back, and only here can it be
 * deleted for good.
 */
export function TrashPage(props: { context: SkillsPageContext; location: SkillsLocation }): JSX.Element {
  const t = useT()
  const { context } = props
  const [entries, setEntries] = useState<TrashEntry[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [purging, setPurging] = useState<TrashEntry | null>(null)
  const [restoring, setRestoring] = useState<{ entry: TrashEntry; preview: TrashRestorePreview | null } | null>(null)
  const [emptying, setEmptying] = useState(false)
  useEffect(() => {
    let active = true
    void context.client.trash().then(value => { if (active) setEntries(value) }).catch(error => { if (active) context.fail(error) })
    return () => { active = false }
  }, [context.client, context.revision])
  if (entries === null) return <Busy label={t('common.loading')} />
  const run = async (operation: () => Promise<unknown>, done: () => void) => {
    setBusy(true)
    try {
      await operation()
      done()
      setEntries(await context.client.trash())
      context.refresh()
    } catch (error) { context.fail(error) } finally { setBusy(false) }
  }
  const restore = async (entry: TrashEntry) => {
    setBusy(true)
    try {
      const preview = await context.client.previewTrashRestore({ id: entry.id })
      if (preview.needsRoot || preview.conflict !== undefined) setRestoring({ entry, preview })
      else await run(() => context.client.restoreTrash({ id: entry.id }), () => context.notice(t('trash.restored', { name: entry.name })))
    } catch { setRestoring({ entry, preview: null }) } finally { setBusy(false) }
  }
  return <article className={css.skDetail}>
    <header className={css.skDetailHead}>
      <div>
        <h3>{t('trash.title')}</h3>
        <p>{t('trash.body')}</p>
        {entries.length > 0 && <span className={css.skMeta}>{t('tabs.trash', { count: entries.length })}</span>}
      </div>
      {entries.length > 0 && <div className={css.skDetailActions}>
        <Button variant="outline" size="sm" disabled={!context.writable || busy} onClick={() => setEmptying(true)}>{t('trash.empty')}</Button>
      </div>}
    </header>
    {entries.length === 0 ? <Empty glyph="×" title={t('trash.emptyTitle')}>{t('trash.emptyBody')}</Empty> : <ul className={`${css.skVersions} ${css.skTrashList}`}>
      {entries.map(entry => <li key={entry.id}>
        <SkillIcon name={entry.name} />
        <span className={css.skRowText}>
          <strong>{entry.name}</strong>
          <small>{t('trash.meta', { time: stamp(entry.trashedAt), size: size(entry.bytes) })}</small>
          {entry.originalPath !== undefined && <small title={entry.originalPath}><code>{entry.originalPath}</code></small>}
          <span className={css.skTrashTags}>
            {entry.root !== undefined && <Tag tone="quiet">{t(`root.${entry.root}`)}</Tag>}
            <Tag tone="quiet">{t(entry.kind === 'file' ? 'trash.file' : 'trash.bundle')}</Tag>
          </span>
        </span>
        <span className={css.skTrashActions}>
          <Button variant="outline" size="sm" disabled={!context.writable || busy} title={t('trash.restoreHint')}
            onClick={() => void restore(entry)}>{t('trash.restore')}</Button>
          <Button variant="ghost" size="sm" disabled={!context.writable || busy} onClick={() => setPurging(entry)}>{t('trash.purge')}</Button>
        </span>
      </li>)}
    </ul>}
    {restoring !== null && <RestoreDialog context={context} entry={restoring.entry} initial={restoring.preview} onClose={() => setRestoring(null)}
      onRestored={() => { setRestoring(null); void context.client.trash().then(setEntries).catch(context.fail); context.refresh() }} />}
    {purging !== null && <PurgeDialog entry={purging} busy={busy} writable={context.writable}
      onClose={() => setPurging(null)} onConfirm={() => void run(() => context.client.purgeTrash(purging.id), () => { context.notice(t('trash.purged', { name: purging.name })); setPurging(null) })} />}
    {emptying && <Confirm danger title={t('trash.clearTitle', { count: entries.length })} body={t('trash.clearBody')} confirmLabel={t('trash.empty')} busy={busy}
      onClose={() => setEmptying(false)} onConfirm={() => void run(() => context.client.emptyTrash(), () => { context.notice(t('trash.emptied', { count: entries.length })); setEmptying(false) })} />}
  </article>
}

function RestoreDialog(props: { context: SkillsPageContext; entry: TrashEntry; initial: TrashRestorePreview | null; onClose: () => void; onRestored: () => void }): JSX.Element {
  const t = useT()
  const [name, setName] = useState(props.entry.name)
  const [root, setRoot] = useState(props.initial?.needsRoot === true ? '' : 'original')
  const [preview, setPreview] = useState<TrashRestorePreview | null>(props.initial)
  const [roots, setRoots] = useState<SkillRootKind[]>(props.initial?.roots ?? [])
  const [replace, setReplace] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const validName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) && name.length <= 64
  useEffect(() => {
    let active = true
    void props.context.client.catalog().then(catalog => { if (active) setRoots(catalog.roots.map(item => item.kind)) }).catch(props.context.fail)
    return () => { active = false }
  }, [props.context.client])
  useEffect(() => {
    let active = true
    setPreview(null)
    setReplace(false)
    setError(null)
    if (!validName || root === '') return () => { active = false }
    const input = { id: props.entry.id, name, ...(root === 'original' ? {} : { root: root as SkillRootKind }) }
    void props.context.client.previewTrashRestore(input).then(value => { if (active) setPreview(value) }).catch(reason => { if (active) setError(errorText(reason)) })
    return () => { active = false }
  }, [props.context.client, props.entry.id, root, name, validName])
  const submit = async () => {
    if (preview === null || preview.needsRoot || !props.context.writable) return
    setBusy(true)
    setError(null)
    const input: TrashRestoreInput = {
      id: props.entry.id, name, ...(root === 'original' ? {} : { root: root as SkillRootKind }),
      ...(preview.conflict === undefined ? {} : { replace, expectedHash: preview.conflict.hash }),
    }
    try {
      await props.context.client.restoreTrash(input)
      props.context.notice(t('trash.restored', { name }))
      props.onRestored()
    } catch (reason) { setError(errorText(reason)) } finally { setBusy(false) }
  }
  return <SidebarModal title={t('trash.restoreTitle', { name: props.entry.name })} busy={busy} onClose={props.onClose} footer={<>
    <Button variant="ghost" disabled={busy} onClick={props.onClose}>{t('common.cancel')}</Button>
    <Button variant="primary" disabled={busy || !props.context.writable || !validName || preview === null || preview.needsRoot || (preview.conflict !== undefined && !replace)} onClick={() => void submit()}>{t('trash.restore')}</Button>
  </>}>
    <div className={css.skForm}>
      <p>{t('trash.chooseHint')}</p>
      <SelectField label={t('create.root')} value={root} onChange={setRoot} options={[
        { value: '', label: t('trash.chooseRoot') },
        ...(props.initial?.needsRoot === true ? [] : [{ value: 'original', label: t('trash.original') }]),
        ...roots.map(kind => ({ value: kind, label: t(`root.${kind}`) })),
      ]} />
      <Field label={t('create.name')} hint={t('create.nameHint')}>{control => <input {...control} value={name} disabled={busy} onChange={event => setName(event.target.value.trim().toLowerCase())} />}</Field>
      {preview?.path !== undefined && <code>{preview.path}</code>}
      {preview?.conflict !== undefined && <label><input type="checkbox" checked={replace} disabled={busy} onChange={event => setReplace(event.target.checked)} /> {t('trash.replace')}</label>}
      {error !== null && <p role="alert" className={css.skFormError}>{error}</p>}
    </div>
  </SidebarModal>
}

function PurgeDialog(props: { entry: TrashEntry; busy: boolean; writable: boolean; onClose: () => void; onConfirm: () => void }): JSX.Element {
  const t = useT()
  const [name, setName] = useState('')
  return <SidebarModal title={t('trash.purgeTitle', { name: props.entry.name })} description={t('trash.purgeBody')} busy={props.busy} onClose={props.onClose} footer={<>
    <Button variant="ghost" disabled={props.busy} onClick={props.onClose}>{t('common.cancel')}</Button>
    <Button variant="primary" className={css.skDangerButton} disabled={props.busy || !props.writable || name !== props.entry.name} onClick={props.onConfirm}>{t('trash.purge')}</Button>
  </>}>
    <Field label={t('trash.confirmName', { name: props.entry.name })}>{control => <input {...control} value={name} onChange={event => setName(event.target.value)} />}</Field>
  </SidebarModal>
}
