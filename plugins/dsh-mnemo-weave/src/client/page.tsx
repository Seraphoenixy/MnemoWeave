import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UiArchive, UiConfigView, UiInjection, UiMemoryDetail, UiMemoryList, UiMemorySummary, UiRule, UiStatus, UiSyncPass, UiSyncStatus } from '../shared/contract.ts';
import { createApi, RpcFailure } from './api.ts';
import type { ClientConnection, LocaleService } from './dsh-types.ts';
import { normalizeLanguage, translate, type Language } from './i18n.ts';
import { ensureStyles } from './styles.ts';
import { ArchivesPanel, OverviewPanel, RuntimePanel, SyncPanel, TAB_KEYS, TAB_ORDER, type Tab } from './panels.tsx';
import {
  availabilityText, codeText, detailMeta, formatDateTime, injectionChip, listSummary, relativeTime,
  statusChips, type Chip, type Tone,
} from './view-model.ts';

export interface MemoryPageProps {
  connection: ClientConnection;
  locale?: LocaleService;
}

const LIST_LIMIT = 50;

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

/** The Server code is shown as written; only the wording around it is localized. */
function failureText(error: unknown, language: Language): string {
  if (error instanceof RpcFailure) return `${codeText(error.code, language)} (${error.code})`;
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
  const firstLine = item.content.split('\n')[0] ?? item.memoryId;
  return (
    <li>
      <button type="button" className="mwui-item" data-active={active ? 'true' : 'false'} onClick={() => onSelect(item.memoryId)}>
        <span className="mwui-item-title">{firstLine === '' ? item.memoryId : firstLine}</span>
        <span className="mwui-item-excerpt">{item.content}</span>
        <span className="mwui-item-meta">
          <span>{scope}</span>
          <span>·</span>
          <span>{translate(language, 'detail.published')} {relativeTime(item.publishedAt, now, language)}</span>
        </span>
      </button>
    </li>
  );
}

interface DetailProps {
  detail: UiMemoryDetail;
  language: Language;
  editing: boolean;
  draft: string;
  reason: string;
  saving: boolean;
  copied: boolean;
  onChangeDraft(value: string): void;
  onChangeReason(value: string): void;
  onBeginEdit(): void;
  onCancel(): void;
  onSave(): void;
  onCopyId(): void;
}

function DetailView(props: DetailProps): JSX.Element {
  const { detail, language, editing, draft, reason, saving, copied } = props;
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
        <h4 className="mwui-section-title">{translate(language, editing ? 'detail.editTitle' : 'detail.content')}</h4>
        {editing
          ? (
            <div className="mwui-edit">
              <textarea
                className="mwui-input mwui-textarea"
                rows={10}
                value={draft}
                aria-label={translate(language, 'detail.content')}
                onChange={event => props.onChangeDraft(event.target.value)}
              />
              <input
                className="mwui-input"
                type="text"
                value={reason}
                placeholder={translate(language, 'detail.reasonPlaceholder')}
                aria-label={translate(language, 'detail.reason')}
                onChange={event => props.onChangeReason(event.target.value)}
              />
              <div className="mwui-edit-hint" data-tone={draft.trim() === '' ? 'warn' : 'muted'}>
                {draft.trim() === '' ? translate(language, 'detail.emptyContent') : translate(language, 'detail.editHint')}
              </div>
              <div className="mwui-edit-actions">
                <button type="button" className="mwui-button" data-variant="primary" onClick={props.onSave} disabled={saving || draft.trim() === ''}>
                  {saving ? translate(language, 'detail.saving') : translate(language, 'detail.save')}
                </button>
                <button type="button" className="mwui-button" onClick={props.onCancel} disabled={saving}>
                  {translate(language, 'detail.cancel')}
                </button>
              </div>
            </div>
          )
          : (
            <div className="mwui-edit">
              <div className="mwui-content">{detail.content === '' ? '—' : detail.content}</div>
              <div className="mwui-edit-actions">
                <button type="button" className="mwui-button" data-variant="primary" onClick={props.onBeginEdit}>
                  {translate(language, 'detail.edit')}
                </button>
              </div>
            </div>
          )}
      </div>

      <div>
        <h4 className="mwui-section-title">{translate(language, 'detail.revisions')}</h4>
        <ul className="mwui-sublist">
          {detail.revisions.map(item => (
            <li key={item.revisionId} className="mwui-subrow">
              <span className="mwui-subrow-main">#{item.number}{item.current ? ` · ${translate(language, 'detail.current')}` : ''}</span>
              <span>{formatDateTime(item.publishedAt)}</span>
              <span className="mwui-subrow-tail mwui-mono">{item.revisionId.slice(0, 8)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** The MnemoWeave page: availability, searchable memories, one memory's detail and its edit entry. */
export function MemoryPage(props: MemoryPageProps): JSX.Element {
  const { connection, locale } = props;
  const api = useMemo(() => createApi(connection), [connection]);
  const language = useLanguage(locale);
  const [status, setStatus] = useState<UiStatus | null>(null);
  const [config, setConfig] = useState<UiConfigView | null>(null);
  const [injection, setInjection] = useState<UiInjection | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [rules, setRules] = useState<UiRule[] | null | undefined>(undefined);
  const [archives, setArchives] = useState<UiArchive[] | null | undefined>(undefined);
  const [sync, setSync] = useState<UiSyncStatus | null | undefined>(undefined);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [archivesError, setArchivesError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncPass, setSyncPass] = useState<UiSyncPass | null>(null);
  const [ruleId, setRuleId] = useState<string | null>(null);
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const [list, setList] = useState<UiMemoryList | null>(null);
  const [detail, setDetail] = useState<UiMemoryDetail | null>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const listRequest = useRef<AbortController | null>(null);

  useEffect(() => { ensureStyles(); }, []);

  const loadStatus = useCallback(async (signal?: AbortSignal): Promise<void> => {
    // The injection report is informational: a host that never injected, or a Server that
    // cannot answer, must not turn the whole status row into an error.
    const settle = async <T,>(promise: Promise<T>): Promise<{ value?: T; error?: string }> => {
      try { return { value: await promise }; } catch (error) { return { error: error instanceof RpcFailure ? error.code : 'RPC_FAILED' }; }
    };
    const [nextStatus, nextConfig, nextInjection, nextRules, nextArchives, nextSync] = await Promise.all([
      api.status(signal),
      api.config(signal),
      api.injection(signal).catch(() => null),
      settle(api.rules(signal)),
      settle(api.archives(signal)),
      settle(api.sync(signal)),
    ]);
    setStatus(nextStatus);
    setConfig(nextConfig);
    setInjection(nextInjection);
    setRules(nextRules.value ?? null);
    setRulesError(nextRules.error ?? null);
    setArchives(nextArchives.value ?? null);
    setArchivesError(nextArchives.error ?? null);
    setSync(nextSync.value ?? null);
    setSyncError(nextSync.error ?? null);
  }, [api]);

  const loadList = useCallback(async (text: string, signal?: AbortSignal): Promise<void> => {
    setList(await api.memories({
      ...(text.trim() === '' ? {} : { query: text.trim() }),
      limit: LIST_LIMIT,
    }, signal));
  }, [api]);

  const loadDetail = useCallback(async (memoryId: string, signal?: AbortSignal): Promise<void> => {
    setDetail(await api.memory(memoryId, signal));
  }, [api]);

  // Initial read: availability and the newest memories; the page loads only when opened.
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await Promise.all([loadStatus(controller.signal), loadList('', controller.signal)]);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failureText(failure, language));
      } finally {
        if (!controller.signal.aborted) { setBusy(false); setNow(Date.now()); }
      }
    })();
    return () => controller.abort();
  }, [loadStatus, loadList]);

  // Debounced search; an in-flight search is cancelled so results cannot arrive out of order.
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
          await loadList(query, controller.signal);
        } catch (failure) {
          if (!controller.signal.aborted) setError(failureText(failure, language));
        }
      })();
    }, 280);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, loadList, language]);

  useEffect(() => {
    if (selectedId === null) return;
    const controller = new AbortController();
    setEditing(false);
    setDraft('');
    setReason('');
    setNotice(null);
    void (async () => {
      try {
        setError(null);
        await loadDetail(selectedId, controller.signal);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failureText(failure, language));
      }
    })();
    return () => controller.abort();
  }, [selectedId, loadDetail, language]);

  const refresh = useCallback((): void => {
    const controller = new AbortController();
    setBusy(true);
    setError(null);
    setNotice(null);
    void (async () => {
      try {
        await Promise.all([
          loadStatus(controller.signal),
          loadList(query, controller.signal),
          ...(selectedId === null ? [] : [loadDetail(selectedId, controller.signal)]),
        ]);
        setNow(Date.now());
      } catch (failure) {
        setError(failureText(failure, language));
      } finally { setBusy(false); }
    })();
  }, [loadStatus, loadList, loadDetail, query, selectedId, language]);

  const beginEdit = useCallback((): void => {
    if (detail === null) return;
    setEditing(true);
    setDraft(detail.content);
    setReason('');
    setError(null);
    setNotice(null);
  }, [detail]);

  const cancelEdit = useCallback((): void => {
    setEditing(false);
    setDraft('');
    setReason('');
  }, []);

  // Save writes through the Host RPC; on success both the edited detail and the list are re-read.
  const save = useCallback(async (): Promise<void> => {
    if (detail === null || saving) return;
    if (draft.trim() === '') {
      setError(translate(language, 'detail.emptyContent'));
      return;
    }
    const controller = new AbortController();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.edit({
        memoryId: detail.memoryId,
        content: draft,
        entryVersion: detail.entryVersion,
        ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
      }, controller.signal);
      setEditing(false);
      setDraft('');
      setReason('');
      await Promise.all([loadDetail(detail.memoryId, controller.signal), loadList(query, controller.signal)]);
      setNotice(translate(language, 'detail.saved'));
      setNow(Date.now());
    } catch (failure) {
      if (!controller.signal.aborted) setError(failureText(failure, language));
    } finally {
      setSaving(false);
    }
  }, [api, detail, draft, reason, saving, language, loadDetail, loadList, query]);

  const retry = useCallback((): void => {
    if (detail !== null && editing) void save();
    else refresh();
  }, [detail, editing, save, refresh]);

  const copyId = useCallback((): void => {
    if (detail === null || typeof navigator === 'undefined' || navigator.clipboard === undefined) return;
    void navigator.clipboard.writeText(detail.memoryId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => undefined);
  }, [detail]);

  const chips = useMemo(() => [...statusChips(status, config, language, now), ...(status === null ? [] : [injectionChip(injection, language)])], [status, config, injection, language, now]);

  const sizeOf = (value: unknown): number | null => Array.isArray(value) ? value.length : null;
  const counts: Record<Tab, number | null> = {
    overview: null,
    memories: list === null ? null : list.items.length,
    runtime: sizeOf(rules),
    archives: sizeOf(archives),
    sync: sync === null || sync === undefined ? null : sizeOf(sync.scopes),
  };

  const refreshSync = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      setSyncPass(await api.syncRefresh());
      setSync(await api.sync().catch(() => null));
      setSyncError(null);
      setNotice(translate(language, 'sync.pass'));
    } catch (failure) {
      setError(failureText(failure, language));
    } finally {
      setBusy(false);
    }
  }, [api, language]);

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
          <button type="button" className="mwui-button" onClick={refresh} disabled={busy || saving}>
            {busy ? <span className="mwui-loading" /> : null}
            {busy ? translate(language, 'toolbar.loading') : translate(language, 'toolbar.refresh')}
          </button>
        </div>
      </header>

      {error === null ? null : (
        <div className="mwui-banner" data-tone="bad" role="alert">
          <span className="mwui-banner-text">{translate(language, 'state.error')}: {error}</span>
          <button type="button" className="mwui-button" onClick={retry}>{translate(language, 'toolbar.retry')}</button>
        </div>
      )}

      {notice === null ? null : (
        <div className="mwui-banner" data-tone="ok" role="status">
          <span className="mwui-banner-text">{notice}</span>
        </div>
      )}

      {status === null || status.status === 'ok' ? null : (
        <div className="mwui-banner" data-tone={status.status === 'unauthorized' ? 'warn' : 'bad'} role="status">
          <span className="mwui-banner-text">
            {availabilityText(status.status, language)}
            {status.reason === undefined ? '' : ` · ${codeText(status.reason, language)} (${status.reason})`}
          </span>
        </div>
      )}

      <ChipRow chips={chips} ariaLabel={translate(language, 'status.title')} />

      <nav className="mwui-tabs" aria-label={translate(language, 'tabs.label')}>
        {TAB_ORDER.map(id => (
          <button key={id} type="button" className="mwui-tab" data-active={tab === id ? 'true' : 'false'} onClick={() => setTab(id)}>
            {translate(language, TAB_KEYS[id])}
            {counts[id] === null ? '' : ` ${counts[id]}`}
          </button>
        ))}
      </nav>

      {tab === 'memories' ? (
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
            {query === '' ? null : (
              <button type="button" className="mwui-button" onClick={() => setQuery('')}>{translate(language, 'search.clear')}</button>
            )}
          </div>
          <ul className="mwui-list">
            {list === null
              ? <li className="mwui-empty">{translate(language, 'list.loading')}</li>
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
                editing={editing}
                draft={draft}
                reason={reason}
                saving={saving}
                copied={copied}
                onChangeDraft={setDraft}
                onChangeReason={setReason}
                onBeginEdit={beginEdit}
                onCancel={cancelEdit}
                onSave={() => { void save(); }}
                onCopyId={copyId}
              />
            )}
        </section>
      </div>
      ) : tab === 'overview' ? (
        <OverviewPanel status={status} config={config} injection={injection} memories={list} rules={rules} archives={archives} sync={sync} language={language} now={now} onOpen={setTab} />
      ) : tab === 'runtime' ? (
        <RuntimePanel rules={rules} error={rulesError} selected={ruleId} language={language} onSelect={setRuleId} />
      ) : tab === 'archives' ? (
        <ArchivesPanel archives={archives} error={archivesError} selected={archiveId} language={language} onSelect={setArchiveId} />
      ) : (
        <SyncPanel sync={sync} error={syncError} pass={syncPass} language={language} busy={busy} onRefresh={() => { void refreshSync(); }} />
      )}

      <footer className="mwui-footer">
        <span>{translate(language, 'footer.note')}</span>
        <span className="mwui-spacer" />
        {config === null ? null : <span className="mwui-mono">{config.serverUrl}</span>}
      </footer>
    </div>
  );
}
