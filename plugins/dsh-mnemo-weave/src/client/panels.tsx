import type { UiArchive, UiArchiveCapacity, UiArchiveHistory, UiConfigView, UiConnectionTest, UiEmbeddingDiagnostics, UiExplore, UiGraph, UiInjection, UiMemoryList, UiRegisterTest, UiRule, UiRuleUsage, UiSettings, UiStatus, UiSyncPass, UiSyncStatus, UiWakeTest, UiWorkspace } from '../shared/contract.ts';
import { translate, type Language, type MessageKey } from './i18n.ts';
import { Modal } from './modal.tsx';
import { filterEntities, formatDateTime, relativeTime, utf8Bytes } from './view-model.ts';
import { layoutGraph } from './graph-layout.ts';
import { useEffect, useState, type ReactNode } from 'react';

/**
 * The page-level classes. dsh-mnemon gives every Source one page and shows only those pages in
 * its top navigation; a memory Source's own views are tabs of that page, not pages beside it.
 */
export type Tab = 'overview' | 'runtime' | 'archives' | 'memories' | 'skills' | 'settings';

export const TAB_KEYS: Record<Tab, MessageKey> = {
  overview: 'tabs.overview',
  runtime: 'tabs.runtime',
  archives: 'tabs.archives',
  memories: 'tabs.memories',
  skills: 'tabs.skills',
  settings: 'tabs.settings',
};

// Class order mirrors dsh-mnemon: runtime (100) → documents/archives (200) → memories (300);
// the cross-class overview stays first as this page's landing view. Sync is a setting of this
// machine's Server, so it lives on the settings page rather than beside the memory classes.
export const TAB_ORDER: readonly Tab[] = ['overview', 'runtime', 'archives', 'memories', 'skills', 'settings'];

export function isTab(value: string): value is Tab {
  return (TAB_ORDER as readonly string[]).includes(value);
}

/**
 * Views of the formal-memory page, in dsh-mnemon's Memory Spaces order: Overview, Recall,
 * Content, Entities. The graph is part of the overview there, so it is part of the overview here
 * rather than a view of its own. A stored default tab can only name a page, so these values never
 * reach the preference file.
 */
export type MemoryView = 'overview' | 'recall' | 'content' | 'entities';

export const MEMORY_VIEW_KEYS: Record<MemoryView, MessageKey> = {
  overview: 'memory.tabs.overview',
  recall: 'memory.tabs.recall',
  content: 'memory.tabs.content',
  entities: 'memory.tabs.entities',
};

export const MEMORY_VIEW_ORDER: readonly MemoryView[] = ['overview', 'recall', 'content', 'entities'];

function countOf(value: readonly unknown[] | null | undefined): string {
  if (value === undefined) return '—';
  if (value === null) return '!';
  return String(value.length);
}

function Card({ label, value, hint }: { label: string; value: string; hint?: string }): ReactNode {
  return (
    <div className="mwui-card">
      <span className="mwui-card-label">{label}</span>
      <span className="mwui-card-value">{value}</span>
      {hint === undefined ? null : <span className="mwui-card-hint">{hint}</span>}
    </div>
  );
}

/**
 * A stream is `rules`, `formal-memories` or `workspace-archives:<workspaceId>`. The two fixed
 * streams get a readable name; a workspace stream keeps its id, because the name is a local
 * choice and two devices may spell it differently.
 */
function streamLabel(value: string, language: Language): string {
  if (value === 'rules') return translate(language, 'sync.stream.rules');
  if (value === 'formal-memories') return translate(language, 'sync.stream.formal');
  if (value.startsWith('workspace-archives:')) return `${translate(language, 'sync.stream.workspace')} ${value.slice('workspace-archives:'.length)}`;
  return value;
}

export interface OverviewProps {
  status: UiStatus | null;
  config: UiConfigView | null;
  injection: UiInjection | null;
  memories: UiMemoryList | null;
  rules: UiRule[] | null | undefined;
  archives: UiArchive[] | null | undefined;
  sync: UiSyncStatus | null | undefined;
  language: Language;
  now: number;
  onOpen(tab: Tab): void;
}

/** One screen: how much of each class exists, what the last injection carried, whether sync runs. */
export function OverviewPanel(props: OverviewProps): ReactNode {
  const { status, config, injection, memories, rules, archives, sync, language, now } = props;

  return (
    <div className="mwui-page">
      <div className="mwui-grid">
        <Card label={translate(language, 'overview.memories')} value={memories === null || memories === undefined ? '—' : String(memories.items.length)} hint={translate(language, 'overview.openMemories')} />
        <Card label={translate(language, 'overview.runtime')} value={countOf(rules)} hint={translate(language, 'overview.openRules')} />
        <Card label={translate(language, 'overview.archives')} value={countOf(archives)} hint={translate(language, 'overview.openArchives')} />
        <Card label={translate(language, 'overview.workspaces')} value={String(new Set((archives ?? []).map(archive => archive.workspaceId)).size)} hint={translate(language, 'overview.workspacesHint')} />
      </div>

      <section className="mwui-pane">
        <div className="mwui-pane-header"><span className="mwui-pane-title">{translate(language, 'overview.injection')}</span></div>
        <div className="mwui-pane-body">
          {injection === null
            ? <span className="mwui-muted">{translate(language, 'injection.none')}</span>
            : (
              <>
                <div className="mwui-kv"><span>{translate(language, 'injection.rules')}</span><span>{injection.ruleCount}</span></div>
                <div className="mwui-kv"><span>{translate(language, 'injection.bytes')}</span><span>{injection.usedBytes}</span></div>
                <div className="mwui-kv"><span>{translate(language, 'injection.session')}</span><span className="mwui-mono">{injection.sessionId}</span></div>
                <div className="mwui-kv"><span>{translate(language, 'injection.at')}</span><span>{formatDateTime(injection.createdAt)} · {relativeTime(injection.createdAt, now, language)}</span></div>
                {injection.failure === undefined ? null : <div className="mwui-kv" data-tone="warn"><span>{translate(language, 'injection.failure')}</span><span>{translate(language, `injection.failure.${injection.failure}` as MessageKey)}</span></div>}
              </>
            )}
        </div>
      </section>

      <section className="mwui-pane">
        <div className="mwui-pane-header"><span className="mwui-pane-title">{translate(language, 'overview.sync')}</span></div>
        <div className="mwui-pane-body">
          {sync === undefined
            ? <span className="mwui-muted">{translate(language, 'list.loading')}</span>
            : sync === null || sync.enabled === false
              ? <span className="mwui-muted">{translate(language, 'sync.off')}</span>
              : (
                <>
                  <div className="mwui-kv"><span>{translate(language, 'sync.streams')}</span><span>{sync.streams.length}</span></div>
                  <div className="mwui-kv"><span>{translate(language, 'sync.pending')}</span><span>{sync.streams.reduce((sum, item) => sum + item.pending, 0)}</span></div>
                  <div className="mwui-kv"><span>{translate(language, 'sync.unapplied')}</span><span>{sync.streams.reduce((sum, item) => sum + item.unapplied, 0)}</span></div>
                  <div className="mwui-kv"><span>{translate(language, 'sync.updated')}</span><span>{formatDateTime(sync.updatedAt)}</span></div>
                </>
              )}
        </div>
      </section>

      <section className="mwui-pane">
        <div className="mwui-pane-header"><span className="mwui-pane-title">{translate(language, 'overview.server')}</span></div>
        <div className="mwui-pane-body">
          <div className="mwui-kv"><span>{translate(language, 'status.server')}</span><span className="mwui-mono">{config?.serverUrl ?? '—'}</span></div>
          <div className="mwui-kv"><span>{translate(language, 'status.version')}</span><span>{status?.version ?? '—'}</span></div>
          <div className="mwui-kv"><span>{translate(language, 'status.host')}</span><span>{status?.hostId ?? '—'}</span></div>
          <div className="mwui-kv"><span>{translate(language, 'status.checked')}</span><span>{status === null ? '—' : relativeTime(status.checkedAt, now, language)}</span></div>
        </div>
      </section>
    </div>
  );
}

export interface RuleDraft {
  body: string;
  enabled: boolean;
  importance?: 'critical' | 'normal' | 'low';
  pinned?: boolean;
}

export interface RuntimeProps {
  rules: UiRule[] | null | undefined;
  usage?: UiRuleUsage | null | undefined;
  error: string | null;
  selected: string | null;
  language: Language;
  onSelect(id: string): void;
  /** Publishes a new rule; the page refreshes the list and selects it before resolving. */
  onCreate(draft: RuleDraft): Promise<void>;
  /** Saves body and enabled state; `baseVersion` is the version the form opened at. */
  onSave(ruleId: string, input: { body: string; enabled: boolean; importance: 'critical' | 'normal' | 'low'; pinned: boolean; baseVersion: number }): Promise<void>;
}

/**
 * Runtime rules: read, publish and edit.
 *
 * A rule is injected whole. The storage set is maintained under its UTF-8 byte capacity:
 * over-limit writes archive lower-priority rules locally, and an entry that cannot fit is
 * refused rather than trimmed; the refusal is shown as an error, not as a saved version.
 */
export function RuntimePanel(props: RuntimeProps): ReactNode {
  const { rules, usage, error, selected, language } = props;
  const current = (rules ?? []).find(rule => rule.entryId === selected) ?? null;
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<RuleDraft>({ body: '', enabled: true, importance: 'normal', pinned: false });
  const [createError, setCreateError] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ ruleId: string; body: string; enabled: boolean; importance: 'critical' | 'normal' | 'low'; pinned: boolean; version: number } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editing = edit !== null && current !== null && edit.ruleId === current.entryId;
  const dirty = editing && (edit.body !== current.body || edit.enabled !== current.enabled
    || edit.importance !== current.importance || edit.pinned !== current.pinned);

  /** A window is open over the list, so selecting a rule simply clears the draft behind it. */
  const select = (id: string): void => {
    setEdit(null);
    setEditError(null);
    props.onSelect(id);
  };

  const closeEdit = (): void => {
    setEdit(null);
    setEditError(null);
  };

  const closeCreate = (): void => {
    setCreating(false);
    setCreateError(null);
    // Closing discards the draft, so reopening starts from an empty rule.
    setDraft({ body: '', enabled: true, importance: 'normal', pinned: false });
  };

  const beginEdit = (): void => {
    if (current === null) return;
    setEdit({ ruleId: current.entryId, body: current.body, enabled: current.enabled, importance: current.importance, pinned: current.pinned, version: current.version });
    setEditError(null);
  };

  const submitCreate = async (): Promise<void> => {
    if (draft.body.trim() === '') { setCreateError(translate(language, 'runtime.bodyRequired')); return; }
    setBusy(true);
    setCreateError(null);
    try {
      await props.onCreate(draft);
      setCreating(false);
      setDraft({ body: '', enabled: true, importance: 'normal', pinned: false });
    } catch (failure) {
      setCreateError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const submitEdit = async (): Promise<void> => {
    if (edit === null) return;
    if (edit.body.trim() === '') { setEditError(translate(language, 'runtime.bodyRequired')); return; }
    setBusy(true);
    setEditError(null);
    try {
      await props.onSave(edit.ruleId, {
        body: edit.body, enabled: edit.enabled, importance: edit.importance, pinned: edit.pinned, baseVersion: edit.version,
      });
      setEdit(null);
    } catch (failure) {
      setEditError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mwui-body" data-view={current === null ? 'list' : 'detail'}>
      {creating ? (
        <Modal
          title={translate(language, 'runtime.createTitle')}
          language={language}
          busy={busy}
          dirty={draft.body !== '' || !draft.enabled}
          onClose={closeCreate}
        >
          <div className="mwui-edit">
            <div className="mwui-edit-hint" data-tone="muted">{translate(language, 'runtime.createHint')}</div>
            <textarea
              className="mwui-input mwui-textarea"
              rows={4}
              value={draft.body}
              placeholder={translate(language, 'runtime.bodyPlaceholder')}
              aria-label={translate(language, 'runtime.bodyPlaceholder')}
              onChange={event => setDraft(currentDraft => ({ ...currentDraft, body: event.target.value }))}
            />
            <div className="mwui-classify">
              <label className="mwui-classify-field">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={event => setDraft(currentDraft => ({ ...currentDraft, enabled: event.target.checked }))}
                />
                <span>{translate(language, 'runtime.enabledLabel')}</span>
              </label>
              <label className="mwui-classify-field">
                <span>{translate(language, 'runtime.importance')}</span>
                <select
                  value={draft.importance ?? 'normal'}
                  onChange={event => setDraft(currentDraft => ({ ...currentDraft, importance: event.target.value as 'critical' | 'normal' | 'low' }))}
                >
                  <option value="critical">critical</option>
                  <option value="normal">normal</option>
                  <option value="low">low</option>
                </select>
              </label>
              <label className="mwui-classify-field">
                <input
                  type="checkbox"
                  checked={draft.pinned === true}
                  onChange={event => setDraft(currentDraft => ({ ...currentDraft, pinned: event.target.checked }))}
                />
                <span>{translate(language, 'runtime.pinned')}</span>
              </label>
            </div>
            {createError === null ? null : <div className="mwui-inline-error" role="alert">{createError}</div>}
            <div className="mwui-edit-actions">
              <button type="button" className="mwui-button" data-variant="primary" onClick={() => { void submitCreate(); }} disabled={busy || draft.body.trim() === ''}>
                {translate(language, busy ? 'runtime.creating' : 'runtime.createSubmit')}
              </button>
              <button type="button" className="mwui-button" onClick={closeCreate} disabled={busy}>
                {translate(language, 'detail.cancel')}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      <section className="mwui-pane" aria-label={translate(language, 'runtime.title')}>
        <div className="mwui-pane-header">
          <span className="mwui-pane-title">{translate(language, 'runtime.title')}</span>
          <span className="mwui-pane-count">{countOf(rules)}</span>
          {usage === null || usage === undefined
            ? null
            : <span className="mwui-item-meta" data-tone={usage.exceeded ? 'warn' : undefined}>{usage.usedBytes}/{usage.limitBytes} B</span>}
          <button type="button" className="mwui-button mwui-mini" onClick={() => { setCreating(value => !value); setCreateError(null); }} disabled={rules === null}>
            {translate(language, 'runtime.new')}
          </button>
        </div>
        <ul className="mwui-list">
          {rules === undefined
            ? <li className="mwui-empty">{translate(language, 'list.loading')}</li>
            : rules === null
              ? <li className="mwui-empty">{translate(language, 'panel.unavailable')}{error === null ? '' : ` · ${error}`}</li>
            : rules.length === 0
              ? <li className="mwui-empty">{translate(language, 'runtime.empty')}</li>
              : rules.map(rule => (
                <li key={rule.entryId}>
                  <button type="button" className="mwui-item" data-active={rule.entryId === selected ? 'true' : 'false'} onClick={() => select(rule.entryId)}>
                    <span className="mwui-item-title">{rule.body.split('\n')[0] ?? rule.entryId}</span>
                    <span className="mwui-item-excerpt">{rule.body}</span>
                    <span className="mwui-item-meta">
                      <span>{rule.enabled ? translate(language, 'common.enabled') : translate(language, 'common.disabled')}</span>
                      <span>·</span>
                      <span>{rule.importance}</span>
                      {rule.pinned ? <><span>·</span><span>{translate(language, 'runtime.pinned')}</span></> : null}
                      <span>·</span>
                      <span>{translate(language, 'common.version')} {rule.version}</span>
                    </span>
                  </button>
                </li>
              ))}
        </ul>
      </section>

      <section className="mwui-pane" aria-label={translate(language, 'runtime.detail')}>
        <div className="mwui-pane-header">
          <span className="mwui-pane-title">{translate(language, 'runtime.detail')}</span>
          {current === null ? null : (
            <button type="button" className="mwui-button mwui-mini" onClick={beginEdit}>{translate(language, 'detail.edit')}</button>
          )}
        </div>
        {current === null
          ? <div className="mwui-empty">{translate(language, 'runtime.placeholder')}</div>
          : (
            <div className="mwui-detail">
              <div className="mwui-chips">
                <span className="mwui-chip"><span className="mwui-chip-label">{translate(language, 'common.version')}</span><span className="mwui-chip-value">{current.version}</span></span>
                <span className="mwui-chip" data-tone={current.enabled ? 'ok' : 'warn'}><span className="mwui-chip-label">{translate(language, 'runtime.state')}</span><span className="mwui-chip-value">{current.enabled ? translate(language, 'common.enabled') : translate(language, 'common.disabled')}</span></span>
                <span className="mwui-chip"><span className="mwui-chip-label">{translate(language, 'runtime.importance')}</span><span className="mwui-chip-value">{current.importance}</span></span>
                {current.pinned ? <span className="mwui-chip"><span className="mwui-chip-label">{translate(language, 'runtime.pinned')}</span><span className="mwui-chip-value">✓</span></span> : null}
                <span className="mwui-chip"><span className="mwui-chip-label">{translate(language, 'runtime.bytes')}</span><span className="mwui-chip-value">{current.bodyBytes}</span></span>
              </div>
              <div>
                <h4 className="mwui-section-title">{translate(language, 'runtime.body')}</h4>
                <div className="mwui-content">{current.body}</div>
              </div>
              <div className="mwui-edit-hint" data-tone="muted">{translate(language, 'runtime.hint')}</div>
            </div>
          )}
      </section>

      {edit !== null && editing ? (
        <Modal
          title={translate(language, 'runtime.editTitle')}
          subtitle={`${translate(language, 'common.version')} v${edit.version}`}
          language={language}
          busy={busy}
          dirty={dirty}
          onClose={closeEdit}
        >
          <div className="mwui-edit">
            <textarea
              className="mwui-input mwui-textarea"
              rows={6}
              value={edit.body}
              aria-label={translate(language, 'runtime.body')}
              onChange={event => setEdit(currentEdit => currentEdit === null ? currentEdit : { ...currentEdit, body: event.target.value })}
            />
            <div className="mwui-classify">
              <label className="mwui-classify-field">
                <input
                  type="checkbox"
                  checked={edit.enabled}
                  onChange={event => setEdit(currentEdit => currentEdit === null ? currentEdit : { ...currentEdit, enabled: event.target.checked })}
                />
                <span>{translate(language, 'runtime.enabledLabel')}</span>
              </label>
              <label className="mwui-classify-field">
                <span>{translate(language, 'runtime.importance')}</span>
                <select
                  value={edit.importance}
                  onChange={event => setEdit(currentEdit => currentEdit === null ? currentEdit : { ...currentEdit, importance: event.target.value as 'critical' | 'normal' | 'low' })}
                >
                  <option value="critical">critical</option>
                  <option value="normal">normal</option>
                  <option value="low">low</option>
                </select>
              </label>
              <label className="mwui-classify-field">
                <input
                  type="checkbox"
                  checked={edit.pinned}
                  onChange={event => setEdit(currentEdit => currentEdit === null ? currentEdit : { ...currentEdit, pinned: event.target.checked })}
                />
                <span>{translate(language, 'runtime.pinned')}</span>
              </label>
            </div>
            <div className="mwui-edit-hint" data-tone="muted">{translate(language, 'runtime.editHint')}</div>
            {dirty ? null : <div className="mwui-edit-hint" data-tone="muted">{translate(language, 'runtime.unchanged')}</div>}
            {editError === null ? null : <div className="mwui-inline-error" role="alert">{editError}</div>}
            <div className="mwui-edit-actions">
              <button type="button" className="mwui-button" data-variant="primary" onClick={() => { void submitEdit(); }} disabled={busy || edit.body.trim() === '' || !dirty}>
                {translate(language, busy ? 'runtime.saving' : 'runtime.save')}
              </button>
              <button type="button" className="mwui-button" onClick={closeEdit} disabled={busy}>
                {translate(language, 'detail.cancel')}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

export interface ArchivesProps {
  archives: UiArchive[] | null | undefined;
  capacities?: UiArchiveCapacity[] | null | undefined;
  history?: UiArchiveHistory[] | null | undefined;
  error: string | null;
  selected: string | null;
  language: Language;
  /** Workspaces the user may reach; the pane reads one of them at a time. */
  workspaces?: UiWorkspace[] | undefined;
  /** The selected workspace; null until one is chosen or when none is accessible. */
  workspace: string | null;
  onWorkspace?(workspaceId: string): void;
  onSelect(id: string): void;
  onSave?(draft: import("../shared/contract.ts").UiArchiveDraft, target: UiArchive | null): Promise<void>;
  onSetState?(entryId: string, state: 'active' | 'archived', baseVersion: number): Promise<void>;
  /** 「提炼为正式记忆」: preview state, its result and the three user actions. */
  distillation?: DistillationState | null | undefined;
  /**
   * Capacity maintenance: the rows that would free room, oldest-confirmed first.
   *
   * Offered only after a write was refused for capacity (or while the workspace measures over
   * it): a suggestion shown at all times would be noise for a workspace with room.
   */
  releaseCandidates?: import("../shared/contract.ts").UiArchiveReleaseCandidates | null | undefined;
  showReleaseCandidates?: boolean | undefined;
}
export interface DistillationState {
  draft: import("../shared/contract.ts").UiDistillationDraft | null;
  skip: import("../shared/contract.ts").UiDistillationSkip | null;
  busy: boolean;
  result: import("../shared/contract.ts").UiDistillationResult | null;
  error: string | null;
  onStart(entryId: string): void;
  onConfirm(): void;
  onDiscard(): void;
  /** When the user chose 「提炼后归档」, archive the source after a published or duplicate result. */
  thenArchive: boolean;
  onToggleThenArchive(enabled: boolean): void;
}
export function ArchivesPanel({ archives, capacities, history, error, selected, language, workspaces, workspace, onWorkspace, onSelect, onSave, onSetState, distillation, releaseCandidates, showReleaseCandidates }: ArchivesProps): ReactNode {
  const [draft, setDraft] = useState<UiArchive | null | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [stateBusy, setStateBusy] = useState(false);
  const [stateError, setStateError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  /** The archive form is uncontrolled, so any input in it marks the window as dirty. */
  const [dirty, setDirty] = useState(false);
  const open = (value: UiArchive | null): void => {
    setSaveError(undefined);
    setDirty(false);
    setDraft(value);
  };
  const close = (): void => {
    setDraft(undefined);
    setDirty(false);
  };
  const visible = (archives ?? []).filter(item =>
    [item.title, item.workspaceId, item.body].some(value => value.toLowerCase().includes(query.trim().toLowerCase())));
  const current = (archives ?? []).find(archive => archive.entryId === selected) ?? null;
  const capacity = (capacities ?? []).reduce((sum, item) => ({ activeBytes: sum.activeBytes + item.activeBytes, limitBytes: sum.limitBytes + item.limitBytes, exceeded: sum.exceeded || item.exceeded }), { activeBytes: 0, limitBytes: 0, exceeded: false });
  return (
    <div className="mwui-body">
      <section className="mwui-pane" aria-label={translate(language, 'archives.title')}>
        <div className="mwui-pane-header">
          <span className="mwui-pane-title">{translate(language, 'archives.title')}</span>
          <span className="mwui-pane-count">{countOf(archives)}</span>
          {capacities === null || capacities === undefined || capacities.length === 0
            ? null
            : <span className="mwui-item-meta" data-tone={capacity.exceeded ? 'warn' : undefined}>{capacity.activeBytes}/{capacity.limitBytes} B</span>}
          {onWorkspace === undefined ? null : (
            <label className="mwui-filter">
              <span>{translate(language, 'archives.workspacePicker')}</span>
              <select
                className="mwui-input mwui-select"
                aria-label={translate(language, 'archives.workspacePicker')}
                value={workspace ?? ''}
                onChange={event => onWorkspace(event.currentTarget.value)}
              >
                {(workspaces ?? []).length === 0
                  ? <option value="">{translate(language, 'archives.noWorkspace')}</option>
                  : (workspaces ?? []).map(entry => (
                    <option key={entry.workspaceId} value={entry.workspaceId}>{entry.name}</option>
                  ))}
              </select>
            </label>
          )}
          {onSave && workspace !== null && <button type="button" className="mwui-button mwui-mini" onClick={() => open(null)}>{translate(language, 'archives.create')}</button>}
        </div>
        {releaseCandidates === null || releaseCandidates === undefined || !releaseCandidates.capacity.exceeded
          ? null
          : (
            <div className="mwui-form" role="group" aria-label={translate(language, 'archives.capacityMaintenance')}>
              <div className="mwui-section-title">{translate(language, 'archives.capacityMaintenance')}</div>
              <ol className="mwui-list">
                {releaseCandidates.items.map(item => (
                  <li key={item.entryId}>
                    <button type="button" className="mwui-item" onClick={() => onSelect(item.entryId)}>
                      <span className="mwui-item-title">{item.title}</span>
                      <span className="mwui-item-meta">
                        <span>{item.bodyBytes} B</span>
                        <span>·</span>
                        <span>{translate(language, 'common.version')} {item.version}</span>
                        <span>·</span>
                        <span>{formatDateTime(item.updatedAt)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
              {releaseCandidates.remaining === 0
                ? null
                : <div className="mwui-muted">{translate(language, 'archives.capacityRemaining').replace('{count}', String(releaseCandidates.remaining))}</div>}
            </div>
          )}
        <input type="search" aria-label={translate(language, 'archives.search')} placeholder={translate(language, 'archives.search')} value={query} onChange={event => setQuery(event.currentTarget.value)} />
        <ul className="mwui-list">
          {archives === undefined
            ? <li className="mwui-empty">{translate(language, 'list.loading')}</li>
            : archives === null
              ? <li className="mwui-empty">{translate(language, 'panel.unavailable')}{error === null ? '' : ` · ${error}`}</li>
            : visible.length === 0
              ? <li className="mwui-empty">{translate(language, workspace === null ? 'archives.noWorkspace' : 'archives.empty')}</li>
              : visible.map(archive => (
                <li key={archive.entryId}>
                  <button type="button" className="mwui-item" data-active={archive.entryId === selected ? 'true' : 'false'} disabled={draft !== undefined} onClick={() => onSelect(archive.entryId)}>
                    <span className="mwui-item-title">{archive.title}</span>
                    <span className="mwui-item-excerpt">{archive.body}</span>
                    <span className="mwui-item-meta">
                      <span>{translate(language, 'archives.workspace')}</span>
                      <span>·</span>
                      <span>{verificationText(archive.verification, language)}</span>
                      <span>·</span>
                      <span>{archive.state}</span>
                      <span>·</span>
                      <span>{archive.bodyBytes} B</span>
                    </span>
                  </button>
                </li>
              ))}
        </ul>
      </section>

      <section className="mwui-pane" aria-label={translate(language, 'archives.detail')}>
        <div className="mwui-pane-header"><span className="mwui-pane-title">{translate(language, 'archives.detail')}</span></div>
        {current === null
          ? <div className="mwui-empty">{translate(language, 'archives.placeholder')}</div>
          : (
            <div className="mwui-detail">
              {onSave || onSetState ? (
                <div className="mwui-edit-actions">
                  {onSave && current.state === 'active'
                    ? <button type="button" className="mwui-button" onClick={() => open(current)}>{translate(language, 'archives.edit')}</button>
                    : null}
                  {distillation !== null && distillation !== undefined && current.state !== undefined
                    ? <button
                        type="button"
                        className="mwui-button"
                        disabled={distillation.busy}
                        onClick={() => distillation.onStart(current.entryId)}
                      >
                        {translate(language, distillation.busy ? 'archives.distillBusy' : 'archives.distill')}
                      </button>
                    : null}
                  {onSetState
                    ? <button
                        type="button"
                        className="mwui-button"
                        disabled={stateBusy}
                        onClick={() => {
                          const next = current.state === 'archived' ? 'active' : 'archived';
                          setStateBusy(true);
                          setStateError(undefined);
                          void onSetState(current.entryId, next, current.version)
                            .catch((failure: unknown) => { setStateError(failure instanceof Error ? failure.message : String(failure)); })
                            .finally(() => { setStateBusy(false); });
                        }}
                      >
                        {translate(language, current.state === 'archived' ? 'archives.restore' : 'archives.archive')}
                      </button>
                    : null}
                </div>
              ) : null}
              {stateError === undefined ? null : <div className="mwui-inline-error" role="alert">{stateError}</div>}
              <div className="mwui-chips">
                <span className="mwui-chip"><span className="mwui-chip-label">{translate(language, 'archives.workspace')}</span><span className="mwui-chip-value">{current.workspaceId}</span></span>
                <span className="mwui-chip"><span className="mwui-chip-label">{translate(language, 'archives.source')}</span><span className="mwui-chip-value">{current.source}</span></span>
                <span className="mwui-chip" data-tone={current.verification === 'verified' ? 'ok' : 'warn'}><span className="mwui-chip-label">{translate(language, 'archives.verification')}</span><span className="mwui-chip-value">{verificationText(current.verification, language)}</span></span>
                <span className="mwui-chip" data-tone={current.state === 'archived' ? 'warn' : 'ok'}><span className="mwui-chip-label">{translate(language, 'archives.state')}</span><span className="mwui-chip-value">{translate(language, current.state === 'archived' ? 'archives.archived' : 'archives.active')}</span></span>
                <span className="mwui-chip"><span className="mwui-chip-label">{translate(language, 'common.version')}</span><span className="mwui-chip-value">{current.version}</span></span>
                <span className="mwui-chip"><span className="mwui-chip-label">{translate(language, 'archives.bytes')}</span><span className="mwui-chip-value">{current.bodyBytes}</span></span>
              </div>
              <div>
                <h4 className="mwui-section-title">{translate(language, 'archives.body')}</h4>
                <div className="mwui-content">{current.body}</div>
              </div>
              <div>
                <h4 className="mwui-section-title">{translate(language, 'archives.evidence')}</h4>
                <div className="mwui-content mwui-muted">{current.evidence}</div>
              </div>
              {distillation === null || distillation === undefined || (distillation.draft === null && distillation.skip === null)
                ? null
                : (
                  <div className="mwui-form" role="group" aria-label={translate(language, 'archives.distillTitle')}>
                    <h4 className="mwui-section-title">{translate(language, 'archives.distillTitle')}</h4>
                    {distillation.error === null ? null : <div className="mwui-inline-error" role="alert">{distillation.error}</div>}
                    {distillation.skip === null ? null : (
                      <div className="mwui-muted">{translate(language, 'archives.distillSkipped')} · {distillation.skip.reason}</div>
                    )}
                    {distillation.draft === null ? null : (
                      <>
                        <div className="mwui-content">{distillation.draft.content}</div>
                        <div className="mwui-item-meta">
                          <span>{distillation.draft.knowledgeType}</span>
                          <span>·</span>
                          <span>{translate(language, 'archives.distillRange')} {distillation.draft.usedRange.start}–{distillation.draft.usedRange.end}</span>
                          {distillation.draft.usedRange.truncated ? <span>（已截取）</span> : null}
                        </div>
                        <div className="mwui-muted">{translate(language, 'archives.distillShare')}</div>
                        <label className="mwui-filter">
                          <input
                            type="checkbox"
                            checked={distillation.thenArchive}
                            disabled={distillation.busy || distillation.result !== null}
                            onChange={event => distillation.onToggleThenArchive(event.currentTarget.checked)}
                          />
                          <span>{translate(language, 'archives.distillThenArchive')}</span>
                        </label>
                        {distillation.result === null ? null : (
                          <div className="mwui-item-meta" data-tone={distillation.result.status === 'published' ? 'ok' : 'warn'}>
                            {translate(language, distillation.result.status === 'published' ? 'archives.distillDone'
                              : distillation.result.status === 'duplicate' ? 'archives.distillDuplicate'
                                : distillation.result.status === 'needs_review' ? 'archives.distillReview'
                                  : 'archives.distillFailed')}
                          </div>
                        )}
                        <div className="mwui-edit-actions">
                          <button type="button" className="mwui-button" disabled={distillation.busy || distillation.result !== null} onClick={() => distillation.onConfirm()}>
                            {translate(language, 'archives.distillPublish')}
                          </button>
                          <button type="button" className="mwui-button" disabled={distillation.busy} onClick={() => distillation.onDiscard()}>
                            {translate(language, 'archives.distillDiscard')}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              <div>
                <h4 className="mwui-section-title">{translate(language, 'archives.history')}</h4>
                {(history ?? []).length === 0
                  ? <div className="mwui-muted">{translate(language, 'archives.historyEmpty')}</div>
                  : (
                    <ol className="mwui-history">
                      {(history ?? []).map(item => (
                        <li key={item.revisionId}>
                          <span className="mwui-item-meta">
                            <span>{translate(language, 'common.version')} {item.version}</span>
                            <span>·</span>
                            <span>{translate(language, item.state === 'archived' ? 'archives.archived' : 'archives.active')}</span>
                            <span>·</span>
                            <span>{formatDateTime(item.recordedAt)}</span>
                          </span>
                          <div className="mwui-content mwui-muted">{item.body}</div>
                        </li>
                      ))}
                    </ol>
                  )}
              </div>
            </div>
          )}
      </section>

      {draft !== undefined && onSave ? (
        <Modal
          title={translate(language, draft === null ? 'archives.create' : 'archives.edit')}
          language={language}
          busy={saving}
          dirty={dirty}
          onClose={close}
        >
          <form className="mwui-edit" onInput={() => setDirty(true)} onChange={() => setDirty(true)} onSubmit={async event => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            setSaving(true);
            setSaveError(undefined);
            try {
              await onSave({
                workspaceId: draft?.workspaceId ?? String(data.get('workspaceId') ?? ''),
                title: String(data.get('title') ?? ''),
                body: String(data.get('body') ?? ''),
                evidence: String(data.get('evidence') ?? ''),
                verification: data.get('verification') as UiArchive['verification'],
              }, draft);
              close();
            } catch (cause) {
              setSaveError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setSaving(false);
            }
          }}>
            <label className="mwui-field">
              <span>{translate(language, 'archives.workspace')}</span>
              <input className="mwui-input mwui-mono" name="workspaceId" required readOnly defaultValue={draft?.workspaceId ?? ''} disabled={saving} />
            </label>
            <label className="mwui-field">
              <span>{translate(language, 'archives.title')}</span>
              <input className="mwui-input" name="title" required maxLength={200} defaultValue={draft?.title} disabled={saving} />
            </label>
            <label className="mwui-field">
              <span>{translate(language, 'archives.body')}</span>
              <textarea className="mwui-input mwui-textarea" name="body" required defaultValue={draft?.body} disabled={saving} />
            </label>
            <label className="mwui-field">
              <span>{translate(language, 'archives.evidence')}</span>
              <textarea className="mwui-input mwui-textarea" name="evidence" required maxLength={2000} defaultValue={draft?.evidence} disabled={saving} />
            </label>
            <label className="mwui-field">
              <span>{translate(language, 'archives.verification')}</span>
              <select className="mwui-input mwui-select" name="verification" defaultValue={draft?.verification ?? 'open'} disabled={saving}>
                {(['open', 'verified', 'refuted'] as const).map(value => <option key={value} value={value}>{verificationText(value, language)}</option>)}
              </select>
            </label>
            <div className="mwui-edit-actions">
              <button type="submit" className="mwui-button" data-variant="primary" disabled={saving}>{translate(language, 'archives.save')}</button>
              <button type="button" className="mwui-button" onClick={close} disabled={saving}>{translate(language, 'archives.cancel')}</button>
            </div>
            {saveError === undefined ? null : <div className="mwui-inline-error" role="alert">{saveError}</div>}
          </form>
        </Modal>
      ) : null}
    </div>
  );
}

function verificationText(value: UiArchive['verification'], language: Language): string {
  return value === 'verified'
    ? translate(language, 'verification.verified')
    : value === 'refuted' ? translate(language, 'verification.refuted') : translate(language, 'verification.open');
}

export interface SyncProps {
  sync: UiSyncStatus | null | undefined;
  error: string | null;
  pass: UiSyncPass | null;
  language: Language;
  busy: boolean;
  onRefresh(): void;
}

/**
 * This local Server against the remote sync Server, one row per scope.
 *
 * Sync is a setting of this machine's Server, so the group sits inside the settings card rather
 * than in a pane of its own. A second pane beside the settings pane would compete with it for the
 * page height: panes may shrink but never scroll, so the loser is clipped instead of shown.
 */
export function SyncGroup({ sync, error, pass, language, busy, onRefresh }: SyncProps): ReactNode {
  const enabled = sync !== null && sync !== undefined && sync.enabled;
  return (
      <div className="mwui-settings-group">
        <h4 className="mwui-section-title">{translate(language, 'sync.title')}</h4>
          {sync === undefined
            ? <span className="mwui-muted">{translate(language, 'list.loading')}</span>
            : sync === null
              ? <span className="mwui-muted">{error === 'REVIEW_REQUIRED' ? translate(language, 'sync.off') : `${translate(language, 'panel.unavailable')}${error === null ? '' : ` · ${error}`}`}</span>
            : (
              <>
                {pass === null ? null : (
                  <div className="mwui-kv" data-tone={pass.errors.length === 0 ? 'ok' : 'warn'}>
                    <span>{translate(language, 'sync.pass')}</span>
                    <span>{translate(language, 'sync.passResult', { streams: pass.streams.length, pulled: pass.pulled, applied: pass.applied })}{pass.errors.length === 0 ? '' : ` · ${pass.errors.join(', ')}`}</span>
                  </div>
                )}
                {enabled ? (
                  <table className="mwui-table">
                    <thead>
                      <tr>
                        <th>{translate(language, 'sync.stream')}</th>
                        <th>{translate(language, 'sync.cursor')}</th>
                        <th>{translate(language, 'sync.pending')}</th>
                        <th>{translate(language, 'sync.unknown')}</th>
                        <th>{translate(language, 'sync.unapplied')}</th>
                        <th>{translate(language, 'sync.lastPull')}</th>
                        <th>{translate(language, 'sync.lastError')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sync.streams.length === 0
                        ? <tr><td colSpan={7}>{translate(language, 'sync.empty')}</td></tr>
                        : sync.streams.map(stream => (
                          <tr key={stream.stream}>
                            <td className="mwui-mono">{streamLabel(stream.stream, language)}</td>
                            <td>{stream.cursor}</td>
                            <td data-tone={stream.pending > 0 ? 'warn' : undefined}>{stream.pending}</td>
                            <td data-tone={stream.unknown > 0 ? 'warn' : undefined}>{stream.unknown}</td>
                            <td data-tone={stream.unapplied > 0 ? 'warn' : undefined}>{stream.unapplied}</td>
                            <td>{stream.lastPullAt === null ? '—' : formatDateTime(stream.lastPullAt)}</td>
                            <td>{stream.lastError === null ? '—' : stream.lastError}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                ) : <span className="mwui-muted">{translate(language, 'sync.off')}</span>}
              </>
            )}
        <div className="mwui-edit-actions">
          <button type="button" className="mwui-button" onClick={onRefresh} disabled={busy || !enabled}>
            {busy ? translate(language, 'sync.refreshing') : translate(language, 'sync.refresh')}
          </button>
          {sync === null || sync === undefined ? null : (
            <span className="mwui-edit-hint" data-tone="muted">
              {translate(language, 'sync.updated')} · {formatDateTime(sync.updatedAt)} · {relativeTime(sync.updatedAt, Date.now(), language)}
            </span>
          )}
        </div>
      </div>
  );
}

/**
 * The settings page.
 *
 * Two save styles, borrowed from the reference project: a preference that only changes how the
 * page behaves saves the moment it is chosen, while anything that moves data or changes a
 * connection waits for its group's Apply. Every field shows who manages it, so "saved" and "in
 * use" can never be confused.
 */
export interface SettingsProps {
  settings: UiSettings;
  language: Language;
  busy: boolean;
  notice: string | null;
  connectionTest: UiConnectionTest | null;
  wakeTest: UiWakeTest | null;
  registerTest: UiRegisterTest | null;
  /** The local Server against the remote sync Server; the settings page owns this status. */
  sync: UiSyncStatus | null | undefined;
  syncError: string | null;
  syncPass: UiSyncPass | null;
  /** Provider embedding coverage; null means the read failed, undefined means it is loading. */
  diagnostics?: UiEmbeddingDiagnostics | null | undefined;
  onSaveInterface(patch: { defaultTab?: string; pageSize?: number }): void;
  onSaveConnection(input: { serverUrl: string; hostId: string }): void;
  onSaveInjection(input: { injectTimeoutMs: number }): void;
  onSaveAutoStart(enabled: boolean): void;
  onRegisterTask(): void;
  onTestConnection(serverUrl: string): void;
  onTestWake(): void;
  onRefreshSync(): void;
}

function sourceText(source: string, language: Language): string {
  const key = `settings.source.${source}` as MessageKey;
  return translate(language, key);
}

export function SettingsPanel(props: SettingsProps): ReactNode {
  const { settings, language, busy, notice, connectionTest, wakeTest, registerTest } = props;
  const [serverUrl, setServerUrl] = useState(settings.connection.serverUrl);
  const [hostId, setHostId] = useState(settings.connection.hostId);
  const [timeoutMs, setTimeoutMs] = useState(String(settings.injection.injectTimeoutMs));
  // Follow the saved values when a group is applied elsewhere; the drafts are what the user typed.
  useEffect(() => { setServerUrl(settings.connection.serverUrl); }, [settings.connection.serverUrl]);
  useEffect(() => { setHostId(settings.connection.hostId); }, [settings.connection.hostId]);
  useEffect(() => { setTimeoutMs(String(settings.injection.injectTimeoutMs)); }, [settings.injection.injectTimeoutMs]);

  const parsedTimeout = Number(timeoutMs);
  const timeoutValid = Number.isInteger(parsedTimeout) && parsedTimeout >= 250 && parsedTimeout <= 1900;
  return (
    <div className="mwui-page">
      {notice === null ? null : <div className="mwui-banner" data-tone="ok">{notice}</div>}
      <section className="mwui-pane">
        <div className="mwui-pane-header"><span className="mwui-pane-title">{translate(language, 'settings.title')}</span></div>
        <div className="mwui-detail">
          {/* Interface: applies as soon as it is chosen. */}
          <div className="mwui-settings-group">
            <h4 className="mwui-section-title">{translate(language, 'settings.interface')}</h4>
            <div className="mwui-settings-row">
              <label htmlFor="mwui-default-tab">{translate(language, 'settings.defaultTab')}</label>
              <select
                id="mwui-default-tab"
                className="mwui-input mwui-select"
                value={settings.interface.defaultTab}
                onChange={event => props.onSaveInterface({ defaultTab: event.target.value })}
              >
                {TAB_ORDER.map(id => <option key={id} value={id}>{translate(language, TAB_KEYS[id])}</option>)}
              </select>
              <span className="mwui-source">{sourceText(settings.interface.source, language)}</span>
            </div>
            <div className="mwui-settings-row">
              <label htmlFor="mwui-page-size">{translate(language, 'settings.pageSize')}</label>
              <input
                id="mwui-page-size"
                className="mwui-input"
                type="number"
                min={5}
                max={200}
                value={settings.interface.pageSize}
                onChange={event => props.onSaveInterface({ pageSize: Number(event.target.value) })}
              />
              <span className="mwui-source">{sourceText(settings.interface.source, language)}</span>
            </div>
            <div className="mwui-edit-hint" data-tone="muted">{translate(language, 'settings.interfaceHint')}</div>
          </div>

          {/* Recall diagnosis: what the Provider reports about embeddings, not a Server probe. */}
          <div className="mwui-settings-group">
            <h4 className="mwui-section-title">{translate(language, 'settings.recallDiagnosis')}</h4>
            {props.diagnostics === undefined
              ? <div className="mwui-muted">{translate(language, 'list.loading')}</div>
              : props.diagnostics === null
                ? <div className="mwui-muted">{translate(language, 'panel.unavailable')}</div>
                : (
                  <>
                    <div className="mwui-settings-row">
                      <span>{translate(language, 'settings.recallMode')}</span>
                      <span className="mwui-mono">{translate(language, `settings.recallMode.${props.diagnostics.recallMode}` as MessageKey)}</span>
                      <span className="mwui-source" data-tone={props.diagnostics.degraded ? 'warn' : undefined}>
                        {translate(language, props.diagnostics.degraded ? 'settings.degraded' : 'settings.healthy')}
                      </span>
                    </div>
                    <div className="mwui-settings-row">
                      <span>{translate(language, 'settings.coverage')}</span>
                      <span className="mwui-mono">{props.diagnostics.embedded}/{props.diagnostics.total} · {(props.diagnostics.coverage * 100).toFixed(0)}%</span>
                    </div>
                    <div className="mwui-settings-row">
                      <span>{translate(language, 'settings.embeddingService')}</span>
                      <span className="mwui-mono">{props.diagnostics.protocol} · {props.diagnostics.model}{props.diagnostics.modelAvailable ? '' : ` (${translate(language, 'settings.modelUnavailable')})`}</span>
                    </div>
                    {props.diagnostics.backfill == null ? null : (
                      <div className="mwui-settings-row">
                        <span>{translate(language, 'settings.backfill')}</span>
                        <span className="mwui-mono">
                          {translate(language, `settings.backfill.${props.diagnostics.backfill.state}` as MessageKey)}
                          {typeof props.diagnostics.backfill.detail?.['error'] === 'string' ? ` · ${props.diagnostics.backfill.detail['error']}` : ''}
                        </span>
                      </div>
                    )}
                    {props.diagnostics.lastError === null ? null : <div className="mwui-edit-hint" data-tone="warn">{props.diagnostics.lastError}</div>}
                  </>
                )}
          </div>

          {/* Connection: validated and tested before it replaces the live one. */}
          <div className="mwui-settings-group">
            <h4 className="mwui-section-title">{translate(language, 'settings.connection')}</h4>
            <div className="mwui-settings-row">
              <label htmlFor="mwui-server-url">{translate(language, 'settings.serverUrl')}</label>
              <input id="mwui-server-url" className="mwui-input" value={serverUrl} onChange={event => setServerUrl(event.target.value)} />
              <span className="mwui-source">{sourceText(settings.connection.source, language)}</span>
            </div>
            <div className="mwui-settings-row">
              <label htmlFor="mwui-host-id">{translate(language, 'settings.hostId')}</label>
              <input id="mwui-host-id" className="mwui-input" value={hostId} onChange={event => setHostId(event.target.value)} />
              <span className="mwui-source">{sourceText(settings.connection.hostSource, language)}</span>
            </div>
            <div className="mwui-settings-row">
              <span>{translate(language, 'settings.tokenStatus')}</span>
              <span className="mwui-chip-slim" data-tone={settings.credential.configured ? 'ok' : 'bad'}>
                {translate(language, settings.credential.configured ? 'settings.tokenConfigured' : 'settings.tokenMissing')}
              </span>
              <span className="mwui-source">{sourceText(settings.credential.source, language)}</span>
            </div>
            <div className="mwui-settings-row">
              <span>{translate(language, 'settings.lastAuth')}</span>
              <span className="mwui-source">{translate(language, `settings.auth.${settings.credential.lastAuth}` as MessageKey)}</span>
            </div>
            {connectionTest === null ? null : (
              <div className="mwui-inline-notice" role="status">
                {translate(language, `settings.test.${connectionTest.reason}` as MessageKey)}
                {connectionTest.detail === undefined ? '' : ` · ${connectionTest.detail}`}
              </div>
            )}
            <div className="mwui-edit-actions">
              <button type="button" className="mwui-button" onClick={() => props.onTestConnection(serverUrl)} disabled={busy}>
                {translate(language, 'settings.testConnection')}
              </button>
              <button
                type="button"
                className="mwui-button"
                data-variant="primary"
                onClick={() => props.onSaveConnection({ serverUrl, hostId })}
                disabled={busy || serverUrl.trim() === '' || hostId.trim() === ''}
              >
                {translate(language, 'settings.applyConnection')}
              </button>
            </div>
            <div className="mwui-edit-hint" data-tone="muted">{translate(language, 'settings.tokenHint')}</div>
          </div>

          {/* Sync status belongs to this machine's Server settings, so it is one group of this card. */}
          <SyncGroup
            sync={props.sync}
            error={props.syncError}
            pass={props.syncPass}
            language={language}
            busy={busy}
            onRefresh={props.onRefreshSync}
          />

          {/* Auto-start: the task name is fixed and read-only. */}
          <div className="mwui-settings-group">
            <h4 className="mwui-section-title">{translate(language, 'settings.autoStart')}</h4>
            <div className="mwui-settings-row">
              <label htmlFor="mwui-auto-start">{translate(language, 'settings.autoStartEnabled')}</label>
              <input
                id="mwui-auto-start"
                type="checkbox"
                checked={settings.autoStart.enabled}
                onChange={event => props.onSaveAutoStart(event.target.checked)}
              />
              <span className="mwui-source">{sourceText(settings.autoStart.source, language)}</span>
            </div>
            <div className="mwui-settings-row">
              <span>{translate(language, 'settings.taskName')}</span>
              <span className="mwui-mono">{settings.autoStart.taskName}</span>
            </div>
            {wakeTest === null ? null : (
              <div className="mwui-inline-notice" role="status">{translate(language, `settings.wake.${wakeTest.result}` as MessageKey)}</div>
            )}
            {registerTest === null ? null : (
              <div className="mwui-inline-notice" role="status">
                {translate(language, `settings.register.${registerTest.result}` as MessageKey)}
                {registerTest.detail === undefined ? '' : ` · ${registerTest.detail}`}
              </div>
            )}
            <div className="mwui-edit-actions">
              <button type="button" className="mwui-button" onClick={props.onTestWake} disabled={busy}>
                {translate(language, 'settings.testWake')}
              </button>
              <button type="button" className="mwui-button" data-variant="primary" onClick={props.onRegisterTask} disabled={busy}>
                {translate(language, 'settings.registerTask')}
              </button>
            </div>
            <div className="mwui-edit-hint" data-tone="muted">{translate(language, 'settings.registerHint')}</div>
          </div>

          {/* Injection: the wait budget is the only injection setting left. */}
          <div className="mwui-settings-group">
            <h4 className="mwui-section-title">{translate(language, 'settings.injection')}</h4>
            <div className="mwui-settings-row">
              <label htmlFor="mwui-inject-timeout">{translate(language, 'settings.injectTimeout')}</label>
              <input
                id="mwui-inject-timeout"
                className="mwui-input"
                type="number"
                min={250}
                max={1900}
                step={50}
                value={timeoutMs}
                onChange={event => setTimeoutMs(event.target.value)}
              />
              <span className="mwui-source">{sourceText(settings.injection.timeoutSource, language)}</span>
            </div>
            <div className="mwui-edit-hint" data-tone={timeoutValid ? 'muted' : 'warn'}>
              {timeoutValid ? translate(language, 'settings.injectHint') : translate(language, 'settings.injectInvalid')}
            </div>
            <div className="mwui-edit-actions">
              <button
                type="button"
                className="mwui-button"
                data-variant="primary"
                onClick={() => props.onSaveInjection({ injectTimeoutMs: parsedTimeout })}
                disabled={busy || !timeoutValid}
              >
                {translate(language, 'settings.applyInjection')}
              </button>
            </div>
          </div>

          {/* Diagnostics: read-only; the sync section owns the actions. */}
          <div className="mwui-settings-group">
            <h4 className="mwui-section-title">{translate(language, 'settings.diagnostics')}</h4>
            <div className="mwui-settings-row">
              <span>{translate(language, 'settings.settingsPath')}</span>
              <span className="mwui-mono">{settings.diagnostics.settingsPath}</span>
            </div>
            <div className="mwui-edit-hint" data-tone="muted">{translate(language, 'settings.diagnosticsHint')}</div>
          </div>
        </div>
      </section>
    </div>
  );
}

export interface EntitiesProps {
  /** Entity names with the number of memories that name them, in their recorded spelling. */
  entities: Array<{ value: string; count: number }>;
  query: string;
  error: string | null;
  loading: boolean;
  language: Language;
  /** The entity currently applied to the memory list, if any. */
  active: string;
  onChangeQuery(value: string): void;
  onSelect(entity: string): void;
}

/**
 * Entity index.
 *
 * A memory can be reached by what it is about, not only by text it happens to contain: this lists
 * the entities its current revision names, with counts. Selecting one applies it to the memory
 * list rather than duplicating a second results view.
 */
export function EntitiesPanel(props: EntitiesProps): ReactNode {
  const { entities, query, error, loading, language, active } = props;
  const visible = filterEntities(entities, query);
  return (
    <div className="mwui-page">
      <section className="mwui-pane">
        <div className="mwui-pane-header">
          <span className="mwui-pane-title">{translate(language, 'entities.title')}</span>
          <span className="mwui-filter-count">{loading ? translate(language, 'toolbar.loading') : `${entities.length}`}</span>
        </div>
        <div className="mwui-detail">
          <div className="mwui-edit-hint" data-tone="muted">{translate(language, 'entities.hint')}</div>
          <input
            className="mwui-input"
            type="search"
            value={query}
            placeholder={translate(language, 'entities.filter')}
            aria-label={translate(language, 'entities.filter')}
            onChange={event => props.onChangeQuery(event.target.value)}
          />
          {error === null ? null : <div className="mwui-inline-error" role="alert">{error}</div>}
          {visible.length === 0
            ? <div className="mwui-empty">{translate(language, entities.length === 0 ? 'entities.empty' : 'entities.noMatch')}</div>
            : (
              <ul className="mwui-list mwui-entity-list">
                {visible.map(item => (
                  <li key={item.value}>
                    <button
                      type="button"
                      className="mwui-subrow-button"
                      data-active={active !== '' && active.toLowerCase() === item.value.toLowerCase() ? 'true' : 'false'}
                      onClick={() => props.onSelect(item.value)}
                    >
                      <span className="mwui-subrow-main">{item.value}</span>
                      <span className="mwui-subrow-tail">{item.count}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </div>
      </section>
    </div>
  );
}

/**
 * The relation graph as a picture.
 *
 * Hand-drawn SVG rather than a graph library: the layout is deterministic (see `graph-layout.ts`),
 * so the drawing is a pure function of the data and needs no bundler support for a force engine.
 * Clicking a node opens it, which is the only action the picture needs to support.
 */
export interface GraphProps {
  graph: UiGraph | null;
  loading: boolean;
  error: string | null;
  language: Language;
  /** The memory whose detail is open, drawn as the focus when it is in the graph. */
  focusId: string | null;
  onReload(): void;
  onOpen(memoryId: string): void;
}

/**
 * The graph as a section of a page. dsh-mnemon draws the merged graph below the memory overview's
 * own cards; the overview owns the section, so it has no page wrapper of its own.
 */
export function GraphSection(props: GraphProps): ReactNode {
  const { graph, loading, error, language, focusId } = props;
  const layout = graph === null ? null : layoutGraph(graph, focusId === null ? {} : { focusId });
  return (
      <section className="mwui-pane">
        <div className="mwui-pane-header">
          <span className="mwui-pane-title">{translate(language, 'graphs.title')}</span>
          <button type="button" className="mwui-button mwui-mini" onClick={props.onReload} disabled={loading}>
            {translate(language, loading ? 'graph.loading' : 'graph.reload')}
          </button>
        </div>
        <div className="mwui-detail">
          <div className="mwui-edit-hint" data-tone="muted">{translate(language, 'graphs.hint')}</div>
          {error === null ? null : <div className="mwui-inline-error" role="alert">{error}</div>}
          {graph === null ? (loading ? <div className="mwui-empty">{translate(language, 'graph.loading')}</div> : null) : (
            <>
              {graph.truncated ? <div className="mwui-edit-hint" data-tone="warn">{translate(language, 'graph.truncated')}</div> : null}
              {/* Dots with no lines look broken rather than empty: say why there is nothing drawn
                  between them, because catalogued relations come only from the review path. */}
              {graph.nodes.length > 0 && layout !== null && layout.links.length === 0 ? (
                <div className="mwui-edit-hint" data-tone="muted">{translate(language, 'graphs.noRelations')}</div>
              ) : null}
              {graph.nodes.length === 0
                ? <div className="mwui-empty">{translate(language, 'graphs.empty')}</div>
                : layout === null ? null : (
                  <div className="mwui-graph-scroll">
                    <svg
                      className="mwui-graph"
                      viewBox={`0 0 ${layout.width} ${layout.height}`}
                      role="img"
                      aria-label={translate(language, 'graphs.aria', { nodes: String(layout.nodes.length), links: String(layout.links.length) })}
                    >
                      {layout.links.map(link => (
                        <line
                          key={link.relationId}
                          className="mwui-graph-link"
                          data-kind={link.kind}
                          x1={link.x1} y1={link.y1} x2={link.x2} y2={link.y2}
                        />
                      ))}
                      {layout.nodes.map(item => (
                        <g
                          key={item.memoryId}
                          className="mwui-graph-node"
                          data-focus={item.memoryId === focusId ? 'true' : 'false'}
                          data-isolated={item.hop > 0 && layout.isolated.includes(item.memoryId) ? 'true' : 'false'}
                          data-retired={item.retired ? 'true' : 'false'}
                          role="button"
                          tabIndex={0}
                          aria-label={`${translate(language, 'explore.open')} ${item.memoryId.slice(0, 8)}`}
                          onClick={() => props.onOpen(item.memoryId)}
                          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') props.onOpen(item.memoryId); }}
                        >
                          <circle cx={item.x} cy={item.y} r={item.radius} />
                          <text x={item.x} y={item.y + item.radius + 11} textAnchor="middle">
                            {item.category ?? item.knowledgeType ?? item.memoryId.slice(0, 6)}
                          </text>
                        </g>
                      ))}
                    </svg>
                  </div>
                )}
            </>
          )}
        </div>
      </section>
  );
}

/** The graph on its own page, for a page that is only the graph. */

export interface MemoryOverviewProps {
  memories: UiMemoryList | null;
  entities: Array<{ value: string; count: number }>;
  graph: UiGraph | null;
  graphLoading: boolean;
  graphError: string | null;
  focusId: string | null;
  language: Language;
  onReloadGraph(): void;
  onOpen(memoryId: string): void;
}

/**
 * The formal-memory page's Overview: what the set holds, then the relation graph.
 *
 * dsh-mnemon's Memory Spaces overview lists its spaces and draws one merged graph below them; this
 * store has no space directory, so the overview counts what the memory set contains and keeps the
 * graph in the same view. The graph draws the memories themselves, which is why it belongs here
 * rather than beside the memory page.
 */
export function MemoryOverviewPanel(props: MemoryOverviewProps): ReactNode {
  const { memories, entities, graph, graphLoading, graphError, focusId, language } = props;
  const projects = new Set<string>();
  const categories = new Set<string>();
  for (const item of memories?.items ?? []) if (item.category !== undefined) categories.add(item.category);
  const nodes = graph === null ? null : graph.nodes.length;
  return (
    <div className="mwui-page">
      <div className="mwui-grid">
        <Card
          label={translate(language, 'memory.overview.memories')}
          value={memories === null ? '—' : String(memories.items.length)}
          hint={translate(language, 'memory.overview.memoriesHint')}
        />
        <Card
          label={translate(language, 'memory.overview.entities')}
          value={String(entities.length)}
          hint={translate(language, 'memory.overview.entitiesHint')}
        />
        <Card
          label={translate(language, 'memory.overview.categories')}
          value={String(categories.size)}
          hint={translate(language, 'memory.overview.categoriesHint')}
        />
        <Card
          label={translate(language, 'memory.overview.categories')}
          value={String(categories.size)}
          hint={translate(language, 'memory.overview.categoriesHint')}
        />
        <Card
          label={translate(language, 'memory.overview.nodes')}
          value={nodes === null ? (graphLoading ? translate(language, 'toolbar.loading') : '—') : String(nodes)}
          hint={translate(language, 'memory.overview.nodesHint')}
        />
      </div>
      <GraphSection
        graph={graph}
        loading={graphLoading}
        error={graphError}
        language={language}
        focusId={focusId}
        onReload={props.onReloadGraph}
        onOpen={props.onOpen}
      />
    </div>
  );
}

export interface MemoryPageHeaderProps {
  /** The loaded-count line, already formatted, so the header does not re-read the list. */
  count: string;
  language: Language;
  active: MemoryView;
  creating: boolean;
  saving: boolean;
  onSelect(view: MemoryView): void;
  onCreate(): void;
  /** Opens the user-requested organize task; hidden when the Host cannot run tasks. */
  onOrganize?(): void;
}

/**
 * The formal-memory page's compound header: title, description, count, the page-level action, and
 * the page's own view tabs. dsh-mnemon frames a memory Source the same way, and its secondary
 * tabs are the underline strip a settings page uses rather than the page-level pill bar.
 */
export function MemoryPageHeader(props: MemoryPageHeaderProps): ReactNode {
  const { count, language, active, creating, saving } = props;
  return (
    <section className="mwui-memory-workspace" aria-label={translate(language, 'memory.workspace')}>
      <div className="mwui-memory-head">
        <div className="mwui-memory-heading">
          <h2 className="mwui-memory-title">{translate(language, 'tabs.memories')}</h2>
          <p className="mwui-memory-description">{translate(language, 'memory.description')}</p>
        </div>
        <div className="mwui-memory-actions">
          <span className="mwui-memory-meta">{count}</span>
          {props.onOrganize === undefined ? null : (
            <button type="button" className="mwui-button" onClick={props.onOrganize} disabled={creating || saving}>
              {translate(language, 'organize.title')}
            </button>
          )}
          <button
            type="button"
            className="mwui-button"
            data-variant="primary"
            onClick={props.onCreate}
            disabled={creating || saving}
          >
            {translate(language, 'create.title')}
          </button>
        </div>
      </div>
      <nav className="mwui-memory-tabs" role="tablist" aria-label={translate(language, 'memory.tabs.label')}>
        {MEMORY_VIEW_ORDER.map(id => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active === id}
            data-active={active === id ? 'true' : 'false'}
            onClick={() => props.onSelect(id)}
          >
            {translate(language, MEMORY_VIEW_KEYS[id])}
          </button>
        ))}
      </nav>
    </section>
  );
}

/**
 * Create a formal memory.
 *
 * Published directly, without a review round: the user's own text is treated as already-confirmed
 * knowledge. The form still asks for a knowledge type, because a new memory has no previous
 * revision to inherit one from, and it shows the byte budget the Server enforces.
 */
export interface CreateDraft {
  content: string;
  knowledgeType: string;
  category: string;
  importance: string;
  tags: string;
  entities: string;
  reason: string;
}

export interface CreateMemoryFormProps {
  draft: CreateDraft;
  busy: boolean;
  error: string | null;
  language: Language;
  onChange(patch: Partial<CreateDraft>): void;
  onCancel(): void;
  onSubmit(): void;
  onOrganize?(): void;
}

const KNOWLEDGE_TYPES = ['Concept', 'Practice', 'Architecture', 'Troubleshooting', 'Constraint', 'Procedure', 'Reference'] as const;
const CATEGORY_VALUES = ['preference', 'decision', 'fact', 'insight', 'context', 'general'] as const;

export function CreateMemoryForm(props: CreateMemoryFormProps): ReactNode {
  const { draft, busy, error, language } = props;
  const bytes = utf8Bytes(draft.content);
  return (
    <div className="mwui-edit">
      <div className="mwui-edit-hint" data-tone="muted">{translate(language, 'create.hint')}</div>
      <textarea
        className="mwui-input mwui-textarea"
          rows={6}
          value={draft.content}
          placeholder={translate(language, 'create.contentPlaceholder')}
          aria-label={translate(language, 'create.contentPlaceholder')}
          onChange={event => props.onChange({ content: event.target.value })}
        />
        <div className="mwui-classify">
          <label className="mwui-classify-field">
            <span>{translate(language, 'detail.knowledgeType')}</span>
            <select
              className="mwui-input mwui-select"
              value={draft.knowledgeType}
              onChange={event => props.onChange({ knowledgeType: event.target.value })}
            >
              {KNOWLEDGE_TYPES.map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="mwui-classify-field">
            <span>{translate(language, 'detail.category')}</span>
            <select
              className="mwui-input mwui-select"
              value={draft.category}
              onChange={event => props.onChange({ category: event.target.value })}
            >
              <option value="">{translate(language, 'create.unset')}</option>
              {CATEGORY_VALUES.map(value => (
                <option key={value} value={value}>{translate(language, `category.${value}` as MessageKey)}</option>
              ))}
            </select>
          </label>
          <label className="mwui-classify-field">
            <span>{translate(language, 'detail.importance')}</span>
            <select
              className="mwui-input mwui-select"
              value={draft.importance}
              onChange={event => props.onChange({ importance: event.target.value })}
            >
              <option value="">{translate(language, 'create.unset')}</option>
              {[1, 2, 3, 4, 5].map(value => <option key={value} value={String(value)}>{value}/5</option>)}
            </select>
          </label>
        </div>
        <input
          className="mwui-input"
          type="text"
          value={draft.tags}
          placeholder={translate(language, 'detail.tagsPlaceholder')}
          aria-label={translate(language, 'detail.tags')}
          onChange={event => props.onChange({ tags: event.target.value })}
        />
        <input
          className="mwui-input"
          type="text"
          value={draft.entities}
          placeholder={translate(language, 'create.entitiesPlaceholder')}
          aria-label={translate(language, 'create.entities')}
          onChange={event => props.onChange({ entities: event.target.value })}
        />
        <input
          className="mwui-input"
          type="text"
          value={draft.reason}
          placeholder={translate(language, 'create.reasonPlaceholder')}
          aria-label={translate(language, 'detail.reason')}
          onChange={event => props.onChange({ reason: event.target.value })}
        />
        <div className="mwui-edit-hint" data-tone={bytes > 8000 ? 'warn' : 'muted'}>{bytes}/8000 B</div>
        {error === null ? null : <div className="mwui-inline-error" role="alert">{error}</div>}
        <div className="mwui-edit-actions">
          <button type="button" className="mwui-button" data-variant="primary" onClick={props.onSubmit} disabled={busy || draft.content.trim() === ''}>
            {translate(language, busy ? 'create.saving' : 'create.submit')}
          </button>
          {props.onOrganize && <button type="button" className="mwui-button" onClick={props.onOrganize} disabled={busy || draft.content.trim() === ''}>
            {translate(language, 'create.organize')}
          </button>}
          <button type="button" className="mwui-button" onClick={props.onCancel} disabled={busy}>
            {translate(language, 'detail.cancel')}
          </button>
        </div>
    </div>
  );
}

/**
 * Semantic explore.
 *
 * Deliberately separate from the memory list: the list is a stable, paginated scan matched on
 * body text, while this ranks by the Provider's own similarity. Every hit is a memory this
 * machine published, so each one can be opened; Provider-only hits are counted, not listed.
 */
export interface ExploreProps {
  query: string;
  result: UiExplore | null;
  error: string | null;
  busy: boolean;
  language: Language;
  /** Score floor, as the select's value; `0` means every match. */
  minScore: number;
  /** Current page size; "show more" raises it, because explore has no cursor. */
  limit: number;
  onChangeQuery(value: string): void;
  onChangeMinScore(value: number): void;
  onSearch(): void;
  onShowMore(): void;
  onOpen(memoryId: string): void;
}

export function ExplorePanel(props: ExploreProps): ReactNode {
  const { query, result, error, busy, language, minScore, limit } = props;
  return (
    <div className="mwui-page">
      <section className="mwui-pane">
        <div className="mwui-pane-header"><span className="mwui-pane-title">{translate(language, 'explore.title')}</span></div>
        <div className="mwui-detail">
          <div className="mwui-edit-hint" data-tone="muted">{translate(language, 'explore.hint')}</div>
          <div className="mwui-search">
            <input
              className="mwui-input"
              type="search"
              value={query}
              placeholder={translate(language, 'explore.query')}
              aria-label={translate(language, 'explore.query')}
              onChange={event => props.onChangeQuery(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') props.onSearch(); }}
            />
            <button type="button" className="mwui-button" data-variant="primary" onClick={props.onSearch} disabled={busy || query.trim() === ''}>
              {busy ? translate(language, 'toolbar.loading') : translate(language, 'explore.search')}
            </button>
          </div>
          {/* The Provider scores even unrelated text above zero, so the floor is what separates an
              answer from a ranked list of everything. */}
          <div className="mwui-filter">
            <label className="mwui-filter-label" htmlFor="mwui-minscore">{translate(language, 'explore.threshold')}</label>
            <select
              id="mwui-minscore"
              className="mwui-input mwui-select"
              value={String(minScore)}
              onChange={event => props.onChangeMinScore(Number(event.target.value))}
            >
              <option value="0">{translate(language, 'explore.thresholdAll')}</option>
              <option value="0.3">{translate(language, 'explore.thresholdLoose')}</option>
              <option value="0.5">{translate(language, 'explore.thresholdMedium')}</option>
              <option value="0.8">{translate(language, 'explore.thresholdStrict')}</option>
            </select>
          </div>
          {error === null ? null : <div className="mwui-inline-error" role="alert">{error}</div>}
          {result === null ? null : (
            <>
              {result.unregistered === 0 ? null : (
                <div className="mwui-edit-hint" data-tone="warn">
                  {translate(language, 'explore.unregistered', { count: result.unregistered })}
                </div>
              )}
              {result.hits.length === 0
                ? (
                  <div className="mwui-empty">
                    {translate(language, minScore > 0 ? 'explore.emptyThreshold' : 'explore.empty', { score: String(minScore) })}
                  </div>
                )
                : (
                  <ul className="mwui-list mwui-explore-list">
                    {result.hits.map(hit => (
                      <li key={hit.memoryId} className="mwui-subrow">
                        <button type="button" className="mwui-subrow-button" onClick={() => props.onOpen(hit.memoryId)}>
                          <span className="mwui-subrow-main">{hit.content.split('\n')[0] || hit.memoryId}</span>
                          <span className="mwui-chip-slim">{translate(language, `state.${hit.state}` as MessageKey)}</span>
                          <span className="mwui-subrow-tail mwui-mono">{translate(language, 'explore.score')} {hit.score.toFixed(2)}</span>
                        </button>
                        <div className="mwui-relation-meta">
                          <span className="mwui-relation-evidence">{hit.content}</span>
                          <button type="button" className="mwui-button mwui-mini" onClick={() => props.onOpen(hit.memoryId)}>
                            {translate(language, 'explore.open')}
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              {result.truncated && limit < 50 ? (
                <button type="button" className="mwui-button" onClick={props.onShowMore} disabled={busy}>
                  {translate(language, 'explore.showMore', { count: String(limit) })}
                </button>
              ) : null}
              {result.truncated && limit >= 50 ? (
                <div className="mwui-edit-hint" data-tone="muted">{translate(language, 'explore.limitReached')}</div>
              ) : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
