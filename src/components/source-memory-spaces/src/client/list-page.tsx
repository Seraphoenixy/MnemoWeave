import { css, useT } from './presentation.ts'
import type { JSX } from 'react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { CATEGORIES, type Category, type Insight, type MemoryListView, type RememberRequest } from '../contracts.ts'
import type { MemorySpacesPageClient } from './api.ts'
import { message, PageHeader, SectionSpinner, ProgressiveFooter, EmptyState, SearchField, SelectField } from 'dsh-mnemo-weave/client'
import { InsightCard, ReadSourcePanel, categoryLabel, insightKey } from './widgets.tsx'

export function ListPage(props: { client: MemorySpacesPageClient; revision: number; writeEnabled: boolean; onForget: (insight: Insight) => Promise<void>; onEdit?: (insight: Insight, request: RememberRequest) => Promise<Insight>; onSuggestEntities?: (content: string, existingEntities: string[]) => Promise<string[]>; onClone: (insight: Insight) => void; onExplore: (query: string) => void }): JSX.Element {
  const t = useT()
  const pageSize = 12
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<Category | ''>('')
  const [view, setView] = useState<MemoryListView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [visibleLimit, setVisibleLimit] = useState(pageSize)
  const [selectedBodyId, setSelectedBodyId] = useState<string | undefined>()

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { setView(await props.client.list({ ...(query.trim() === '' ? {} : { query }), ...(category === '' ? {} : { category }), limit: 1000 })) } catch (reason) { setError(message(reason)) } finally { setLoading(false) }
  }, [category, props.client, query])
  useEffect(() => { setVisibleLimit(pageSize); void load() }, [pageSize, props.revision])
  const submit = (event: FormEvent) => { event.preventDefault(); setVisibleLimit(pageSize); void load() }
  const forget = async (insight: Insight) => { await props.onForget(insight); setView(current => current === null ? current : { ...current, total: Math.max(0, current.total - 1), items: current.items.filter(item => insightKey(item) !== insightKey(insight)) }) }
  const edit = props.onEdit === undefined ? undefined : async (insight: Insight, request: RememberRequest) => {
    const updated = await props.onEdit!(insight, request)
    const key = insightKey(insight)
    setView(current => current === null ? current : { ...current, items: current.items.map(item => insightKey(item) === key ? { ...item, ...updated } : item) })
  }
  const filteredItems = view?.items.filter(item => selectedBodyId === undefined || item.memoryBodyId === selectedBodyId) ?? []
  const visibleItems = filteredItems.slice(0, visibleLimit)
  const sources = view?.sources ?? []
  const waitingForQuery = query.trim() === '' && sources.some(source => source.status === 'query-required' && (selectedBodyId === undefined || source.memoryBodyId === selectedBodyId))
  const selectBody = (memoryBodyId: string | undefined) => { setSelectedBodyId(memoryBodyId); setVisibleLimit(pageSize) }

  return (
    <div className={css.page}>
      <PageHeader title={t('content.title')} description={t('content.description')} meta={t('content.count', { count: view === null ? '—' : selectedBodyId === undefined ? view.total : filteredItems.length })} />
      <form className={css.listToolbar} onSubmit={submit}><SearchField label={t('content.filterAria')} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('content.filterPlaceholder')} /><SelectField hideLabel label={t('content.categoryAria')} value={category} options={[{ value: '' as Category | '', label: t('common.allCategories') }, ...CATEGORIES.map(value => ({ value, label: categoryLabel(t, value) }))]} onChange={setCategory} /><button type="submit" className={css.secondaryButton} disabled={loading}>{loading ? t('common.loading') : t('content.apply')}</button></form>
      <div className={css.listNotice}>{t('content.notice')}</div>
      <ReadSourcePanel title={t('content.sourcesTitle')} sources={sources} selectedBodyId={selectedBodyId} onSelect={selectBody} />
      {error !== null && <div className={css.inlineError} role="alert">{error}</div>}
      <div className={css.asyncResults}>
        {loading && <SectionSpinner label={t('common.loading')} />}
        {!loading && filteredItems.length === 0 && <EmptyState glyph="≡" title={t(waitingForQuery ? 'content.queryRequiredTitle' : 'content.emptyTitle')}>{t(waitingForQuery ? 'content.queryRequiredText' : 'content.emptyText')}</EmptyState>}
        <div className={css.memoryList}>{visibleItems.map(insight => <InsightCard key={insightKey(insight)} insight={insight} writeEnabled={props.writeEnabled} onForget={forget} {...(edit === undefined ? {} : { onEdit: edit })} {...(props.onSuggestEntities === undefined ? {} : { onSuggestEntities: props.onSuggestEntities })} onClone={props.onClone} onRelated={() => props.onExplore(insight.content)} />)}</div>
        {view !== null && !loading && <ProgressiveFooter visible={visibleItems.length} total={filteredItems.length} pageSize={pageSize} onMore={() => setVisibleLimit(value => value + pageSize)} />}
      </div>
    </div>
  )
}
