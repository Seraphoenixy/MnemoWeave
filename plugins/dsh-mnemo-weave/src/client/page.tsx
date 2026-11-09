import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UiConfigView, UiIntents, UiMemoryDetail, UiMemoryList, UiMemorySummary, UiRevision, UiStatus } from '../shared/contract.ts';
import { createApi, RpcFailure } from './api.ts';
import type { ClientConnection, LocaleService } from './dsh-types.ts';
import { normalizeLanguage, translate, type Language } from './i18n.ts';
import { ensureStyles } from './styles.ts';
import {
  availabilityText, detailMeta, formatDateTime, intentsSummary, listSummary, reasonText,
  relativeTime, statusChips, type Chip, type Tone,
} from './view-model.ts';

export interface MemoryPageProps {
  connection: ClientConnection;
  locale?: LocaleService;
}

type ScopeFilter = 'all' | 'project' | 'global';

function useLanguage(locale: LocaleService | undefined): Language {
  const read = (): Language => {
    const active = locale?.getSnapshot?.().active;
    if (typeof active === 'string' && active !== '') return normalizeLanguage(active);
    const documentLanguage = typeof document === 'undefined' ? undefined : document.documentElement.lang;
    return normalizeLanguage(documentLanguage);
  };
  const [language, setLanguage] = useState<Language>(read);
  useEffect(() => {
    if (locale?.subscribe === undefined) return;
    return locale.subscribe(() => setLanguage(read()));
  }, [locale]);
  return language;
}

function messageOf(error: unknown): string {
  if (error instanceof RpcFailure) return `${error.message} (${error.code})`;
  return error instanceof Error ? error.message : String(error);
}

function ChipRow({ chips, ariaLabel }: { chips: Chip[]; ariaLabel: string }): JSX.Element {
  return (
    <div className="mwui-chips" role="list" aria-label={ariaLabel}>
      {chips.map(chip => (
        <span key={chip.key} role="listitem" className="mwui-chip" data-tone={chip.tone satisfies Tone}>
          <span className="mwui-chip-label">{chip.label}</span>
          {chip.value !== '' ? <span className="mwui-chip-value" title={chip.value}>{chip.value}</span> : null}
        </span>
      ))}
    </div>
  );
}

function MemoryRow({ item, active, language, now, onSelect }: { item: UiMemorySummary; active: boolean; language: Language; now: number; onSelect(id: string): void }): JSX.Element {
  const scope = item.scope === 'global' ? translate(language, 'detail.global') : item.projectId ?? '—';
  return (
    <li>
      <button type="button" className="mwui-item" data-active={active ? 'true' : 'false'} onClick={() => onSelect(item.memoryId)}>
        <span className="mwui-item-title">{item.excerpt.split('\n')[0] ?? item.memoryId}</span>
        <span className="mwui-item-excerpt">{item.excerpt}</span>
        <span className="mwui-item-meta">
          <span>{scope}</span>
          <span>·</span>
          <span>{translate(language, 'detail.revision')} {item.revisionNumber}</span>
          <span>·</span>
          <span>{relativeTime(item.publishedAt, now, language)}</span>
        </span>
      </button>
    </li>
  );
}

interface DetailProps {
  detail: UiMemoryDetail;
  language: Language;
  revision: UiRevision | null;
  revisionBusy: boolean;
  copied: boolean;
  onSelectRevision(revisionId: string): void;
  onCopyId(): void;
}

function DetailView(props: DetailProps): JSX.Element {
  const { detail, language, revision, revisionBusy, copied } = props;
  if (detail.status !== 'ok') {
    return (
      <div className="mwui-empty">
        <div>{availabilityText(detail.status, language)}</div>
        <div>{reasonText(detail.reason, language)}</div>
      </div>
    );
  }
  return (
    <div className="mwui-detail">
      <div className="mwui-detail-head">
        <div className="mwui-detail-idrow">
          <span className="mwui-mono">{detail.memoryId}</span>
          <button type="button" className="mwui-button mwui-mini" onClick={props.onCopyId}>
            {copied ? translate(language, 'detail.copied') : translate(language, 'detail.copyId')}
          </button>
        </div>
        <div className="mwui-chips">
          {detailMeta(detail, language).map(meta => (
            <span key={meta.key} className="mwui-chip">
              <span className="mwui-chip-label">{meta.label}</span>
              <span className="mwui-chip-value">{meta.value}</span>
            </span>
          ))}
        </div>
      </div>
      <div>
        <h4 className="mwui-section-title">{translate(language, 'detail.content')}</h4>
        <div className="mwui-content">{detail.content ?? '—'}</div>
      </div>
      <div>
        <h4 className="mwui-section-title">{translate(language, 'detail.revisions')}</h4>
        <ul className="mwui-sublist">
          {detail.revisions.map(item => (
            <li key={item.revisionId}>
              <button
                type="button"
                className="mwui-subrow-btn"
                data-active={revision?.revisionId === item.revisionId ? 'true' : 'false'}
                onClick={() => props.onSelectRevision(item.revisionId)}
              >
                <span className="mwui-subrow-main">#{item.number}{item.current ? ` · ${translate(language, 'detail.current')}` : ''}</span>
                <span>{formatDateTime(item.publishedAt)}</span>
                <span className="mwui-subrow-tail mwui-mono">{item.revisionId.slice(0, 8)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h4 className="mwui-section-title">{translate(language, 'detail.history')}</h4>
        {revisionBusy
          ? <div className="mwui-empty">{translate(language, 'detail.historyLoading')}</div>
          : revision === null
            ? <div className="mwui-empty">{translate(language, 'detail.historyHint')}</div>
            : revision.status !== 'ok'
              ? <div className="mwui-empty">{availabilityText(revision.status, language)} · {reasonText(revision.reason, language)}</div>
              : (
                <div className="mwui-revision">
                  <div className="mwui-subrow">
                    <span className="mwui-subrow-main">#{revision.number}{revision.current ? ` · ${translate(language, 'detail.current')}` : ''}</span>
                    <span>{formatDateTime(revision.publishedAt)}</span>
                    <span className="mwui-subrow-tail mwui-mono">{revision.revisionId.slice(0, 8)}</span>
                  </div>
                  <div className="mwui-content">{revision.content ?? '—'}</div>
                </div>
              )}
      </div>
      <div>
        <h4 className="mwui-section-title">{translate(language, 'detail.relations')}</h4>
        {detail.relations.length === 0
          ? <div className="mwui-empty">{translate(language, 'detail.noRelations')}</div>
          : (
            <ul className="mwui-sublist">
              {detail.relations.map(relation => (
                <li key={relation.id} className="mwui-subrow">
                  <span className="mwui-subrow-main">{relation.kind}</span>
                  <span>{relation.reason}</span>
                  <span className="mwui-subrow-tail mwui-mono">{relation.targetMemoryId.slice(0, 8)}</span>
                </li>
              ))}
            </ul>
          )}
      </div>
    </div>
  );
}

/** The MnemoWeave page: status, searchable memories, their detail and revision history, all read-only. */
export function MemoryPage(props: MemoryPageProps): JSX.Element {
  const { connection, locale } = props;
  const api = useMemo(() => createApi(connection), [connection]);
  const language = useLanguage(locale);
  const [status, setStatus] = useState<UiStatus | null>(null);
  const [list, setList] = useState<UiMemoryList | null>(null);
  const [detail, setDetail] = useState<UiMemoryDetail | null>(null);
  const [revision, setRevision] = useState<UiRevision | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [revisionBusy, setRevisionBusy] = useState(false);
  const [intents, setIntents] = useState<UiIntents | null>(null);
  const [config, setConfig] = useState<UiConfigView | null>(null);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<ScopeFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const listRequest = useRef<AbortController | null>(null);

  useEffect(() => { ensureStyles(); }, []);

  const loadStatus = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const [nextStatus, nextIntents, nextConfig] = await Promise.all([api.status(signal), api.intents(signal), api.config(signal)]);
    setStatus(nextStatus);
    setIntents(nextIntents);
    setConfig(nextConfig);
  }, [api]);

  const loadList = useCallback(async (text: string, scopeFilter: ScopeFilter, signal?: AbortSignal): Promise<void> => {
    setList(await api.memories({
      ...(text.trim() === '' ? {} : { query: text.trim() }),
      ...(scopeFilter === 'all' ? {} : { scope: scopeFilter }),
      limit: 100,
    }, signal));
  }, [api]);

  const loadDetail = useCallback(async (memoryId: string, signal?: AbortSignal): Promise<void> => {
    setDetail(await api.memory(memoryId, signal));
  }, [api]);

  // Initial read: status, queue and the newest memories; the page loads only when opened.
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await Promise.all([loadStatus(controller.signal), loadList('', 'all', controller.signal)]);
      } catch (failure) {
        if (!controller.signal.aborted) setError(messageOf(failure));
      } finally {
        if (!controller.signal.aborted) { setBusy(false); setNow(Date.now()); }
      }
    })();
    return () => controller.abort();
  }, [loadStatus, loadList]);

  // Debounced search and scope switch; an in-flight search is cancelled so results cannot arrive out of order.
  const firstSearch = useRef(true);
  useEffect(() => {
    if (firstSearch.current) { firstSearch.current = false; return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      listRequest.current?.abort();
      listRequest.current = controller;
      void (async () => {
        try {
          setError(null);
          await loadList(query, scope, controller.signal);
        } catch (failure) {
          if (!controller.signal.aborted) setError(messageOf(failure));
        }
      })();
    }, 280);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, scope, loadList]);

  useEffect(() => {
    if (selectedId === null) return;
    const controller = new AbortController();
    setRevision(null);
    setRevisionId(null);
    void (async () => {
      try {
        setError(null);
        await loadDetail(selectedId, controller.signal);
      } catch (failure) {
        if (!controller.signal.aborted) setError(messageOf(failure));
      }
    })();
    return () => controller.abort();
  }, [selectedId, loadDetail]);

  useEffect(() => {
    if (detail === null || revisionId === null) return;
    const controller = new AbortController();
    setRevisionBusy(true);
    void (async () => {
      try {
        setError(null);
        setRevision(await api.revision(detail.memoryId, revisionId, controller.signal));
      } catch (failure) {
        if (!controller.signal.aborted) setError(messageOf(failure));
      } finally {
        if (!controller.signal.aborted) setRevisionBusy(false);
      }
    })();
    return () => controller.abort();
  }, [api, detail, revisionId]);

  const refresh = useCallback((): void => {
    const controller = new AbortController();
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await Promise.all([
          loadStatus(controller.signal),
          loadList(query, scope, controller.signal),
          ...(selectedId === null ? [] : [loadDetail(selectedId, controller.signal)]),
        ]);
        setNow(Date.now());
      } catch (failure) {
        setError(messageOf(failure));
      } finally { setBusy(false); }
    })();
  }, [loadStatus, loadList, loadDetail, query, scope, selectedId]);

  const copyId = useCallback((): void => {
    if (detail === null || typeof navigator === 'undefined' || navigator.clipboard === undefined) return;
    void navigator.clipboard.writeText(detail.memoryId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => undefined);
  }, [detail]);

  const chips = useMemo(() => statusChips(status, language, now), [status, language, now]);
  const availability = status === null ? null : status.grant === null ? 'unpaired' : status.grant.revoked ? 'revoked' : status.grant.expired ? 'expired' : null;

  return (
    <div className="mwui-root">
      <header className="mwui-header">
        <div>
          <h1 className="mwui-title">{translate(language, 'page.title')}</h1>
          <p className="mwui-subtitle">
            {translate(language, 'page.subtitle')}
            {status === null ? '' : ` · ${translate(language, 'toolbar.host')}: ${status.hostId}`}
          </p>
        </div>
        <div className="mwui-actions">
          <button type="button" className="mwui-button" onClick={refresh} disabled={busy}>
            {busy ? <span className="mwui-loading" /> : null}
            {busy ? translate(language, 'toolbar.loading') : translate(language, 'toolbar.refresh')}
          </button>
        </div>
      </header>

      {error === null ? null : (
        <div className="mwui-banner" data-tone="bad" role="alert">
          <span className="mwui-banner-text">{translate(language, 'state.error')}: {error}</span>
          <button type="button" className="mwui-button" onClick={refresh}>{translate(language, 'toolbar.retry')}</button>
        </div>
      )}

      {availability === null || status === null ? null : (
        <div className="mwui-banner" data-tone="warn" role="status">
          <span className="mwui-banner-text">
            {availability === 'unpaired' ? reasonText('unpaired', language) : availability === 'revoked' ? reasonText('revoked', language) : reasonText('license_expired', language)}
          </span>
        </div>
      )}

      <ChipRow chips={chips} ariaLabel={translate(language, 'status.title')} />

      <div className="mwui-body">
        <section className="mwui-pane" aria-label={translate(language, 'list.title')}>
          <div className="mwui-pane-header">
            <span className="mwui-pane-title">{translate(language, 'list.title')}</span>
            <span className="mwui-pane-count">{listSummary(list, language)}</span>
          </div>
          <div className="mwui-search">
            <input
              className="mwui-input"
              type="search"
              value={query}
              placeholder={translate(language, 'search.placeholder')}
              aria-label={translate(language, 'search.placeholder')}
              onChange={event => setQuery(event.target.value)}
            />
            <select
              className="mwui-input mwui-select"
              value={scope}
              aria-label={translate(language, 'filter.scope')}
              onChange={event => setScope(event.target.value as ScopeFilter)}
            >
              <option value="all">{translate(language, 'filter.all')}</option>
              <option value="project">{translate(language, 'filter.project')}</option>
              <option value="global">{translate(language, 'filter.global')}</option>
            </select>
            {query === '' ? null : (
              <button type="button" className="mwui-button" onClick={() => setQuery('')}>{translate(language, 'search.clear')}</button>
            )}
          </div>
          <ul className="mwui-list">
            {list === null || list.status !== 'ok'
              ? <li className="mwui-empty">{list === null ? translate(language, 'list.loading') : `${availabilityText(list.status, language)} · ${reasonText(list.reason, language)}`}</li>
              : list.items.length === 0
                ? <li className="mwui-empty">{translate(language, 'list.empty')}</li>
                : list.items.map(item => (
                  <MemoryRow
                    key={item.memoryId}
                    item={item}
                    active={item.memoryId === selectedId}
                    language={language}
                    now={now}
                    onSelect={setSelectedId}
                  />
                ))}
          </ul>
        </section>

        <section className="mwui-pane" aria-label={translate(language, 'detail.title')}>
          <div className="mwui-pane-header">
            <span className="mwui-pane-title">{translate(language, 'detail.title')}</span>
          </div>
          {detail === null || detail.memoryId !== selectedId
            ? <div className="mwui-empty">{translate(language, 'detail.placeholder')}</div>
            : (
              <DetailView
                detail={detail}
                language={language}
                revision={revision}
                revisionBusy={revisionBusy}
                copied={copied}
                onSelectRevision={setRevisionId}
                onCopyId={copyId}
              />
            )}
        </section>
      </div>

      <section className="mwui-intents" aria-label={translate(language, 'intents.title')}>
        <div className="mwui-pane-header" style={{ border: 'none', background: 'transparent', padding: 0 }}>
          <span className="mwui-pane-title">{translate(language, 'intents.title')}</span>
          <span className="mwui-pane-count">{intentsSummary(intents, language)}</span>
        </div>
        {intents === null || intents.items.length === 0
          ? <div className="mwui-intent">{translate(language, 'intents.empty')}</div>
          : intents.items.slice(-6).map(intent => (
            <div key={intent.intentId} className="mwui-intent">
              <span className="mwui-intent-kind">{intent.kind}</span>
              <span>{intent.state}</span>
              {intent.sessionId === undefined ? null : <span>{translate(language, 'intents.session')} {intent.sessionId}</span>}
              <span className="mwui-mono">{formatDateTime(intent.createdAt)}</span>
            </div>
          ))}
      </section>

      <footer className="mwui-footer">
        <span>{translate(language, 'footer.note')}</span>
        <span className="mwui-spacer" />
        {config === null ? null : (
          <span className="mwui-mono" title={config.bridgeUrl}>
            {translate(language, 'footer.bridge')}: {config.bridgeUrl}
            {config.hostId === null ? '' : ` · ${config.hostId}`}
          </span>
        )}
        <span>{status === null ? '' : relativeTime(status.generatedAt, now, language)}</span>
      </footer>
    </div>
  );
}
