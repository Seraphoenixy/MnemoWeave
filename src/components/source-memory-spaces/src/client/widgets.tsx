import { css, sidebarCss, useT } from './presentation.ts'
import type { JSX, MouseEvent } from 'react'
import { useId, useState } from 'react'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { CATEGORIES, type Category, type Insight, type MemorySpaceProvider, type MemorySpaceView, type MemoryProviderConfigField, type MemoryProviderConnection, type MemoryProviderDescriptor, type MemoryProviderId, type MemoryReadSource, type RememberRequest } from '../contracts.ts'
import { ProviderIcon } from './ProviderIcon.tsx'
import { providerSummary } from './provider-presentation.ts'
import { ProviderField } from './provider-field.tsx'
import { type MnemonKey, type MnemonTranslate, appearanceClass, message, SelectField, SidebarModal } from 'dsh-mnemo-weave/client'

export type ProviderDrafts = Partial<Record<MemoryProviderId, MemoryProviderConnection>>

function memoryProviderFields(provider: MemoryProviderDescriptor): MemoryProviderConfigField[] {
  return provider.fields.filter(field => field.scope !== 'service')
}

function providerDefaults(provider: MemoryProviderDescriptor): MemoryProviderConnection {
  return Object.fromEntries(memoryProviderFields(provider).flatMap(field => field.defaultValue === undefined ? [] : [[field.key, field.defaultValue]]))
}

export function mergeProviderDefaults(providers: readonly MemoryProviderDescriptor[], current: ProviderDrafts): ProviderDrafts {
  return Object.fromEntries(providers.map(provider => [provider.id, { ...providerDefaults(provider), ...(current[provider.id] ?? {}) }]))
}

export function providerDraftComplete(provider: MemoryProviderDescriptor | undefined, connection: MemoryProviderConnection | undefined): boolean {
  if (provider === undefined || provider.serviceConfigured === false) return false
  return provider.origin === 'native' || memoryProviderFields(provider).every(field => !field.required || String(connection?.[field.key] ?? '').trim() !== '')
}

/** Keep a ready provider; otherwise Mnemon Native while its CLI is available, then the first other ready one. */
export function readyProviderId(providers: readonly MemoryProviderDescriptor[], current?: MemoryProviderId): MemoryProviderId | undefined {
  const ready = providers.filter(provider => provider.serviceConfigured !== false)
  return ready.find(provider => provider.id === current)?.id ?? (ready.find(provider => provider.origin === 'native') ?? ready[0])?.id
}

/** Ready Providers first, in catalog order, so the choices that work lead the list. */
export function readyFirst(providers: readonly MemoryProviderDescriptor[]): MemoryProviderDescriptor[] {
  return [...providers].sort((left, right) => Number(left.serviceConfigured === false) - Number(right.serviceConfigured === false))
}

/** Why a provider cannot be chosen: Mnemon Native needs its CLI, the others a service configured on the dsh-mnemo-weave page under Plugins. */
export function providerUnavailableKey(provider: MemoryProviderDescriptor): 'overview.nativeCliRequired' | 'overview.providerServiceRequired' {
  return provider.origin === 'native' ? 'overview.nativeCliRequired' : 'overview.providerServiceRequired'
}

export function nativeSpaceProvider(provider: MemorySpaceProvider): boolean {
  return provider.origin === 'native'
}

/** Shared memory-level Provider form used by manual creation, editing, and distillation policy. */
export function ProviderMemoryFields(props: {
  provider: MemoryProviderDescriptor
  connection: MemoryProviderConnection
  onChange: (key: string, value: string | number | boolean) => void
  body?: MemorySpaceView
  clearSecrets?: string[]
  onClearSecretsChange?: (keys: string[]) => void
}): JSX.Element {
  const t = useT()
  return <div className={css.providerFields} data-provider={props.provider.id}>
    <div className={css.providerFieldHeading}><div className={css.providerFieldIdentity}><ProviderIcon providerId={props.provider.id} icon={props.provider.icon} className={css.providerFieldIcon} /><div><strong>{props.provider.label}</strong><small>{providerSummary(t, props.provider)}</small></div></div><span>{props.provider.kind === 'local' ? t('overview.providerKindLocal') : t('overview.providerKindRemote')} · {t(`overview.workspaceBinding.${props.provider.workspaceBinding}`)}</span></div>
    <div className={css.providerAdvancedGrid}>{memoryProviderFields(props.provider).map(field => {
      const saved = props.body?.provider.configuredSecrets.includes(field.key) === true
      const clearSecrets = props.clearSecrets ?? []
      return <ProviderField key={field.key} field={field} value={props.connection[field.key]} layout="dialog" saved={saved} clearing={clearSecrets.includes(field.key)}
        onChange={value => props.onChange(field.key, value)}
        {...(props.body === undefined || props.onClearSecretsChange === undefined ? {} : {
          onClearChange: (clearing: boolean) => props.onClearSecretsChange!(clearing ? [...new Set([...clearSecrets, field.key])] : clearSecrets.filter(key => key !== field.key)),
        })} />
    })}</div>
    <small className={css.providerWriteHint}>{props.provider.capabilities.writeMode === 'exact' ? t('overview.providerWriteExact') : t('overview.providerWriteAsync')} · {props.provider.capabilities.graph ? t('overview.providerGraphReady') : t('overview.providerSearchReady')}</small>
  </div>
}

const CATEGORY_KEYS: Record<string, MnemonKey> = {
  decision: 'category.decision',
  preference: 'category.preference',
  fact: 'category.fact',
  insight: 'category.insight',
  context: 'category.context',
  general: 'category.general',
}

export function categoryLabel(t: MnemonTranslate, category: string): string { return CATEGORY_KEYS[category] === undefined ? category : t(CATEGORY_KEYS[category]!) }

export function insightKey(insight: Insight): string {
  return `${insight.memoryBodyId ?? 'memory'}:${insight.id}`
}

export function ReadSourcePanel(props: {
  title: string
  hint?: string
  sources: readonly MemoryReadSource[]
  selectedBodyId?: string | undefined
  onSelect?: (memoryBodyId: string | undefined) => void
}): JSX.Element | null {
  const t = useT()
  if (props.sources.length === 0) return null
  const content = (source: MemoryReadSource) => <>
    <span className={css.readSourceSignal} aria-hidden="true" />
    <span className={css.readSourceIdentity}><strong>{source.memoryBodyName}</strong></span>
    <span className={css.readSourceState}><em>{t(`readSources.mode.${source.mode}` as MnemonKey)}</em><small>{source.mode === 'entities' && source.status === 'ready'
      ? t(source.complete === false ? 'entities.sourcePartial' : 'entities.sourceReady', { count: source.itemCount })
      : t(`readSources.status.${source.status}` as MnemonKey, { count: source.itemCount })}{source.edgeCount === undefined || source.edgeCount === 0 ? '' : ` · ${t('readSources.edges', { count: source.edgeCount })}`}</small></span>
  </>
  return <section className={css.readSources} aria-label={props.title}>
    <header><div><strong>{props.title}</strong>{props.hint !== undefined && <p>{props.hint}</p>}</div>{props.onSelect !== undefined && <button type="button" aria-pressed={props.selectedBodyId === undefined} data-selected={props.selectedBodyId === undefined ? '' : undefined} onClick={() => props.onSelect?.(undefined)}>{t('readSources.all')}</button>}</header>
    <div>{props.sources.map(source => props.onSelect === undefined
      ? <article key={source.memoryBodyId} className={css.readSourceCard} data-provider={source.providerId} data-mode={source.mode} data-status={source.status} title={source.hint}>{content(source)}</article>
      : <button key={source.memoryBodyId} type="button" className={css.readSourceCard} data-provider={source.providerId} data-mode={source.mode} data-status={source.status} aria-pressed={props.selectedBodyId === source.memoryBodyId} data-selected={props.selectedBodyId === source.memoryBodyId || undefined} title={source.hint} onClick={() => props.onSelect?.(props.selectedBodyId === source.memoryBodyId ? undefined : source.memoryBodyId)}>{content(source)}</button>,
    )}</div>
  </section>
}

export function InsightCard(props: {
  insight: Insight
  writeEnabled: boolean
  onForget: (insight: Insight) => Promise<void>
  onEdit?: (insight: Insight, request: RememberRequest) => Promise<void>
  onSuggestEntities?: (content: string, existingEntities: string[]) => Promise<string[]>
  onRelated?: (insight: Insight) => void
  onClone?: (insight: Insight) => void
}): JSX.Element {
  const t = useT()
  const editFormId = useId()
  const [confirming, setConfirming] = useState(false)
  const [forgetting, setForgetting] = useState(false)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [suggestingEntities, setSuggestingEntities] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editCategory, setEditCategory] = useState<Category>('general')
  const [editImportance, setEditImportance] = useState(3)
  const [editEntities, setEditEntities] = useState('')
  const { insight } = props
  const neutralActionClass = appearanceClass(css.ghostButton, appearanceClass(sidebarCss.itemActionButton, sidebarCss.itemEditAction))
  const forgetActionClass = appearanceClass(css.dangerButton, appearanceClass(sidebarCss.itemActionButton, sidebarCss.itemDangerAction))
  const providerLabel = insight.memoryProviderLabel ?? insight.memoryProviderId
  const supportsRelated = insight.memoryCapabilities?.related === true
  const supportsForget = insight.memoryCapabilities?.forget === true
  const supportsEdit = props.writeEnabled && props.onEdit !== undefined
    && insight.memoryCapabilities?.writeMode === 'exact'
    && insight.memoryCapabilities?.remember === true
    && insight.memoryCapabilities?.forget === true
    && insight.memoryCapabilities?.deletionMode === 'soft'
  const meta = [
    insight.memoryBodyName,
    providerLabel,
    insight.category !== undefined ? categoryLabel(t, insight.category) : undefined,
    insight.importance !== undefined ? t('common.importance', { value: insight.importance }) : undefined,
    insight.score !== undefined ? t('common.score', { value: insight.score.toFixed(2) }) : undefined,
    insight.depth !== undefined ? t('common.hops', { count: insight.depth }) : undefined,
  ].filter((entry): entry is string => entry !== undefined)
  const spaceDescription = `${insight.memoryBodyName ?? insight.memoryBodyId ?? ''}${insight.memoryBodyName === undefined && insight.memoryBodyId === undefined ? '' : ' · '}${insight.id}`

  const forget = async () => {
    setForgetting(true)
    try {
      await props.onForget(insight)
    } finally {
      setForgetting(false)
      setConfirming(false)
    }
  }

  const beginEdit = () => {
    if (!supportsEdit) return
    setEditContent(insight.content)
    setEditCategory(CATEGORIES.includes(insight.category as Category) ? (insight.category as Category) : 'general')
    setEditImportance(typeof insight.importance === 'number' && insight.importance >= 1 && insight.importance <= 5 ? Math.round(insight.importance) : 3)
    setEditEntities((insight.entities ?? []).join(', '))
    setEditError(null)
    setEditing(true)
  }

  const handleCardClick = (event: MouseEvent<HTMLElement>) => {
    if (!supportsEdit) return
    const target = event.target as HTMLElement | null
    if (target?.closest('button, a, input, textarea, select, [data-card-actions]') !== null) return
    if (typeof window !== 'undefined' && (window.getSelection()?.toString().trim() ?? '') !== '') return
    beginEdit()
  }

  const trimmedContent = editContent.trim()
  const canSubmitEdit = trimmedContent !== '' && trimmedContent !== insight.content

  const suggestEntities = async () => {
    if (props.onSuggestEntities === undefined || trimmedContent === '' || saving || suggestingEntities) return
    setSuggestingEntities(true)
    setEditError(null)
    try {
      const current = editEntities.split(',').map(value => value.trim()).filter(Boolean)
      const suggested = await props.onSuggestEntities(trimmedContent, current)
      setEditEntities(suggested.join(', '))
    } catch (reason) {
      setEditError(message(reason))
    } finally {
      setSuggestingEntities(false)
    }
  }

  const saveEdit = async () => {
    if (!supportsEdit || !canSubmitEdit || saving || suggestingEntities || props.onEdit === undefined) return
    setSaving(true)
    setEditError(null)
    try {
      await props.onEdit(insight, {
        content: trimmedContent,
        category: editCategory,
        importance: editImportance,
        entities: editEntities.split(',').map(value => value.trim()).filter(Boolean),
        source: 'user',
        ...(insight.memoryBodyId === undefined ? {} : { memoryBodyId: insight.memoryBodyId }),
      })
      setEditing(false)
    } catch (reason) {
      setEditError(message(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
    <article className={css.insightCard} data-editable={supportsEdit ? '' : undefined} onClick={handleCardClick}>
      <div className={css.cardTop}>
        <div className={css.badges}>{meta.map(entry => <span key={entry} className={css.badge}>{entry}</span>)}</div>
      </div>
      <p className={css.content}>{insight.content}</p>
      {(insight.entities?.length ?? 0) > 0 && <div className={css.entities}>{insight.entities!.map(entity => <span key={entity}>{entity}</span>)}</div>}
      <div className={css.cardActions} data-card-actions="">
        {(
          <>
            {props.onRelated !== undefined && supportsRelated && <button type="button" className={neutralActionClass} onClick={() => props.onRelated?.(insight)}>{t('card.related')}</button>}
            {props.onClone !== undefined && <button type="button" className={neutralActionClass} onClick={() => props.onClone?.(insight)}>{t('card.clone')}</button>}
            {supportsEdit && <button type="button" className={neutralActionClass} onClick={beginEdit}>{t('card.edit')}</button>}
            <button type="button" className={neutralActionClass} onClick={() => void writeClipboard(insight.id)}>{t('common.copyId')}</button>
            {props.writeEnabled && supportsForget && <button type="button" className={forgetActionClass} onClick={() => setConfirming(true)}>{t('card.forget')}</button>}
          </>
        )}
      </div>
    </article>
    {editing && <SidebarModal title={t('card.editTitle')} description={spaceDescription} busy={saving || suggestingEntities} onClose={() => { if (!saving && !suggestingEntities) setEditing(false) }} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close className={css.secondaryButton} disabled={saving || suggestingEntities} onClick={() => setEditing(false)}>{t('common.cancel')}</button><button type="submit" form={editFormId} className={css.primaryButton} disabled={saving || suggestingEntities || !canSubmitEdit}>{saving ? t('card.saving') : t('card.saveEdit')}</button></div>}>
      <form id={editFormId} className={css.bodyEdit} onSubmit={event => { event.preventDefault(); void saveEdit() }}>
        {editError !== null && <div className={css.inlineError} role="alert">{editError}</div>}
        <label>{t('card.editContent')}<textarea aria-label={t('card.editContent')} value={editContent} onChange={event => setEditContent(event.target.value)} maxLength={8000} rows={7} /></label>
        <div className={css.formGrid}>
          <SelectField label={t('common.category')} value={editCategory} options={CATEGORIES.map(value => ({ value, label: categoryLabel(t, value) }))} onChange={setEditCategory} />
          <SelectField label={t('common.importanceLabel')} value={String(editImportance)} options={[1, 2, 3, 4, 5].map(value => ({ value: String(value), label: `${value} / 5` }))} onChange={value => setEditImportance(Number(value))} />
          <div className={css.fieldWide}>
            <div className={css.entityFieldHeader}>
              <span>{t('remember.entities')}</span>
              {props.onSuggestEntities !== undefined && <button type="button" className={neutralActionClass} disabled={saving || suggestingEntities || trimmedContent === ''} onClick={() => void suggestEntities()}>{suggestingEntities ? t('card.suggestingEntities') : t('card.suggestEntities')}</button>}
            </div>
            <input aria-label={t('remember.entities')} value={editEntities} onChange={event => setEditEntities(event.target.value)} placeholder="SQLite, DSH" />
          </div>
        </div>
      </form>
    </SidebarModal>}
    {confirming && <SidebarModal title={t('card.confirmText')} description={spaceDescription} busy={forgetting} onClose={() => setConfirming(false)} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close data-autofocus className={css.secondaryButton} disabled={forgetting} onClick={() => setConfirming(false)}>{t('common.cancel')}</button><button type="button" className={css.dangerSolidButton} disabled={forgetting} onClick={() => void forget()}>{forgetting ? t('card.processing') : t('card.confirmForget')}</button></div>}><div className={css.bodyDeleteConfirm}><div className={css.bodyDeleteSummary}><p className={css.bodyDeleteContent}>{insight.content}</p><span>{meta.join(' · ')}</span></div></div></SidebarModal>}
    </>
  )
}

/** @deprecated Use nativeSpaceProvider. */
export const nativeBodyProvider = nativeSpaceProvider
