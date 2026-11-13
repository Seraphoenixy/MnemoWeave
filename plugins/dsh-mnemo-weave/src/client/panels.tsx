import type { UiArchive, UiArchiveCapacity, UiArchiveHistory, UiConfigView, UiConnectionTest, UiEmbeddingDiagnostics, UiExplore, UiGraph, UiGraphNode, UiInjection, UiMemoryList, UiMemorySummary, UiRegisterTest, UiRule, UiRuleUsage, UiSettings, UiStatus, UiSyncPass, UiSyncStatus, UiWakeTest, UiWorkspace } from '../shared/contract.ts';
import { translate, type Language, type MessageKey } from './i18n.ts';
import { Modal } from './modal.tsx';
import { capacityPercent, filterEntities, formatBytes, formatDateTime, relativeTime, utf8Bytes } from './view-model.ts';
import { GRAPH_HEIGHT, GRAPH_WIDTH, clampGraphPosition, linkLabel, naturalGraphPositions, nodeKey, uniformGraphPositions, type GraphLayoutMode, type GraphPositions } from './graph-layout.ts';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

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
 * A capacity meter: how much of the limit is in use.
 *
 * Both capped collections — runtime rules and each workspace's active archive bytes — fill up
 * gradually and reject a write once full, so the number alone does not answer the question a reader
 * has ("how much room is left"). The bar is a reading of the same two values, and the label keeps
 * the exact figure beside it; a bare bar cannot be compared with the limit that produced it.
 *
 * Excess is shown rather than hidden: the fill is clamped at 100% because a bar cannot overflow,
 * but the label keeps the real numbers so an over-limit state reads as over, not as "full".
 */
export function CapacityMeter({ label, used, limit, exceeded, language }: {
  label?: string;
  used: number;
  limit: number;
  exceeded?: boolean;
  language: Language;
}): ReactNode {
  const percent = capacityPercent(used, limit);
  const over = exceeded === true || (limit > 0 && used > limit);
  return (
    <div className="mwui-meter" data-tone={over ? 'warn' : undefined}>
      {(label === undefined ? null : <span className="mwui-meter-label">{label}</span>)}
      <span
        className="mwui-meter-track"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label === undefined ? translate(language, 'capacity.label') : `${label} ${translate(language, 'capacity.label')}`}
        title={`${formatBytes(used)} / ${formatBytes(limit)}`}
      >
        <span className="mwui-meter-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="mwui-meter-value" data-tone={over ? 'warn' : undefined}>
        {formatBytes(used)} / {formatBytes(limit)}
        {over ? ` · ${translate(language, 'capacity.over')}` : ''}
      </span>
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
  onSave(ruleId: string, input: { body: string; enabled: boolean; baseVersion: number }): Promise<void>;
}

/**
 * Runtime rules: read, publish and edit.
 *
 * A rule is injected whole. The storage set is maintained under its UTF-8 byte capacity:
 * over-limit writes are rejected and the existing rules are retained.
 */
export function RuntimePanel(props: RuntimeProps): ReactNode {
  const { rules, usage, error, selected, language } = props;
  const current = (rules ?? []).find(rule => rule.entryId === selected) ?? null;
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<RuleDraft>({ body: '', enabled: true });
  const [createError, setCreateError] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ ruleId: string; body: string; enabled: boolean; version: number } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editing = edit !== null && (rules ?? []).some(rule => rule.entryId === edit.ruleId);
  const edited = edit === null ? null : (rules ?? []).find(rule => rule.entryId === edit.ruleId) ?? null;
  const dirty = edit !== null && edited !== null && (edit.body !== edited.body || edit.enabled !== edited.enabled);

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
    setDraft({ body: '', enabled: true });
  };

  /** Begin editing one rule; the id is enough, so the row's own edit button works without selecting. */
  const beginEditFor = (ruleId: string): void => {
    const rule = (rules ?? []).find(item => item.entryId === ruleId);
    if (rule === undefined) return;
    if (ruleId !== selected) props.onSelect(ruleId);
    setEdit({ ruleId: rule.entryId, body: rule.body, enabled: rule.enabled, version: rule.version });
    setEditError(null);
  };

  const submitCreate = async (): Promise<void> => {
    if (draft.body.trim() === '') { setCreateError(translate(language, 'runtime.bodyRequired')); return; }
    setBusy(true);
    setCreateError(null);
    try {
      await props.onCreate(draft);
      setCreating(false);
      setDraft({ body: '', enabled: true });
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
        body: edit.body, enabled: edit.enabled, baseVersion: edit.version,
      });
      setEdit(null);
    } catch (failure) {
      setEditError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mwui-single">
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
            : <CapacityMeter used={usage.usedBytes} limit={usage.limitBytes} exceeded={usage.exceeded} language={language} />}
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
                  {/*
                    * The detail pane repeated what the row already said — body, state, version —
                    * and the only thing it added was the byte count and an edit button. Both fit
                    * on the row, so the rule text can use the full width instead of half of it.
                    */}
                  <div className="mwui-item mwui-item-static" data-active={rule.entryId === selected ? 'true' : 'false'}>
                    {/* The body is already the first line, so a separate title would print it twice. */}
                    <span className="mwui-item-excerpt mwui-rule-body">{rule.body}</span>
                    <span className="mwui-item-meta">
                      <span>{rule.enabled ? translate(language, 'common.enabled') : translate(language, 'common.disabled')}</span>
                      <span>·</span>
                      <span>{translate(language, 'common.version')} {rule.version}</span>
                      <span>·</span>
                      <span>{rule.bodyBytes} B</span>
                      <span className="mwui-spacer" />
                      <button type="button" className="mwui-button mwui-mini" onClick={() => beginEditFor(rule.entryId)}>{translate(language, 'detail.edit')}</button>
                    </span>
                  </div>
                </li>
              ))}
        </ul>
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
  onRevise(content: string, category: string): void;
  onOpenMemory(memoryId: string): void;
  confirmed: boolean;
  complete: boolean;
  /** When the user chose 「提炼后归档」, archive the source after a published or duplicate result. */
  thenArchive: boolean;
  onToggleThenArchive(enabled: boolean): void;
}
function DistillationDraftPreview({ state, language }: { state: DistillationState; language: Language }): ReactNode {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(state.draft?.content ?? '');
  const [category, setCategory] = useState(state.draft?.category ?? 'general');
  if (!editing) return (
    <>
      <div className="mwui-content">{state.draft?.content}</div>
      {!state.confirmed && <button type="button" className="mwui-button" disabled={state.busy} onClick={() => setEditing(true)}>{translate(language, 'archives.distillEdit')}</button>}
    </>
  );
  return (
    <div>
      <textarea aria-label={translate(language, 'archives.distillBody')} value={content} onChange={event => setContent(event.target.value)} />
      <select aria-label={translate(language, 'detail.category')} value={category} onChange={event => setCategory(event.target.value)}>
        {CATEGORY_VALUES.map(value => <option key={value} value={value}>{value}</option>)}
      </select>
      <button type="button" className="mwui-button" disabled={state.busy || state.confirmed || !content.trim()} onClick={() => state.onRevise(content, category)}>
        {translate(language, 'archives.distillSave')}
      </button>
    </div>
  );
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
        {/* Two rows: what this pane is, then the controls that narrow it. Mixing them put a
            select, a progress bar and a button on the title line, which reads as one crowded run. */}
        <div className="mwui-pane-header">
          <span className="mwui-pane-title">{translate(language, 'archives.title')}</span>
          <span className="mwui-pane-count">{archives === null ? null : countOf(archives)}</span>
          {onSave && workspace !== null && <button type="button" className="mwui-button mwui-mini" onClick={() => open(null)}>{translate(language, 'archives.create')}</button>}
        </div>
        <div className="mwui-archive-controls">
          {onWorkspace === undefined ? null : (
            <label className="mwui-archive-picker">
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
          {capacities === null || capacities === undefined || capacities.length === 0
            ? null
            : <CapacityMeter used={capacity.activeBytes} limit={capacity.limitBytes} exceeded={capacity.exceeded} language={language} />}
        </div>
        {releaseCandidates === null || releaseCandidates === undefined || !releaseCandidates.capacity.exceeded
          ? null
          : (
            <div className="mwui-form" role="group" aria-label={translate(language, 'archives.capacityMaintenance')}>
              <div className="mwui-section-title">{translate(language, 'archives.capacityMaintenance')}</div>
              {/* The workspace whose capacity actually overflowed: the header meter aggregates every
                  workspace, so it can sit below the limit while this one is over it. */}
              <CapacityMeter used={releaseCandidates.capacity.activeBytes} limit={releaseCandidates.capacity.limitBytes} exceeded={releaseCandidates.capacity.exceeded} language={language} />
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
        {/* Nothing to search before a workspace is chosen: the field would be a control that
            answers with the same empty list. */}
        {(workspaces ?? []).length === 0 ? null : (
          <div className="mwui-archive-toolbar">
            <input
              className="mwui-input"
              type="search"
              aria-label={translate(language, 'archives.search')}
              placeholder={translate(language, 'archives.search')}
              value={query}
              onChange={event => setQuery(event.currentTarget.value)}
            />
          </div>
        )}
        {error === null ? null : <div className="mwui-inline-error" role="alert">{translate(language, 'panel.unavailable')} · {error}</div>}
        <ul className="mwui-list">
          {archives === undefined
            ? <li className="mwui-empty">{translate(language, 'list.loading')}</li>
            : archives === null
              /**
               * Three different states answered the same message before: no workspace exists, a
               * workspace is not selected, and the read actually failed. Only the last one is a
               * failure, and calling the other two "read failed" sends the reader looking for a
               * broken Server that is working.
               */
              ? <li className="mwui-empty">{translate(language, (workspaces ?? []).length === 0 ? 'archives.noWorkspaceYet' : 'archives.pickWorkspace')}</li>
            : visible.length === 0
              ? <li className="mwui-empty">{translate(language, workspace === null ? 'archives.pickWorkspace' : 'archives.empty')}</li>
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
                        <DistillationDraftPreview key={distillation.draft.draftId} state={distillation} language={language} />
                        <div className="mwui-item-meta">
                          <span>{distillation.draft.category ?? 'general'}</span>
                          {distillation.draft.category && <span>{distillation.draft.category}</span>}
                          <span>v{distillation.draft.source.entryVersion}</span>
                          <span>·</span>
                          <span>{translate(language, 'archives.distillRange')} {distillation.draft.usedRange.start}–{distillation.draft.usedRange.end}</span>
                          {distillation.draft.usedRange.truncated ? <span>（已截取）</span> : null}
                        </div>
                        <div className="mwui-muted">{translate(language, 'archives.distillShare')}</div>
                        <label className="mwui-filter">
                          <input
                            type="checkbox"
                            checked={distillation.thenArchive}
                            disabled={distillation.busy || distillation.confirmed}
                            onChange={event => distillation.onToggleThenArchive(event.currentTarget.checked)}
                          />
                          <span>{translate(language, 'archives.distillThenArchive')}</span>
                        </label>
                        {distillation.result === null ? null : (
                          <div className="mwui-item-meta" data-tone={distillation.result.status === 'published' ? 'ok' : 'warn'}>
                            {translate(language, distillation.result.status === 'published' ? 'archives.distillDone'
                              : distillation.result.status === 'duplicate' ? 'archives.distillDuplicate'
                                : distillation.result.status === 'needs_review' ? 'archives.distillReview'
                                  : distillation.result.status === 'queued' ? 'archives.distillQueued'
                                    : distillation.result.status === 'unknown' ? 'archives.distillUnknown' : 'archives.distillFailed')}
                          </div>
                        )}
                        <div className="mwui-edit-actions">
                          {distillation.result?.memoryId && <button type="button" className="mwui-button" onClick={() => distillation.onOpenMemory(distillation.result!.memoryId!)}>{translate(language, 'archives.distillOpen')}</button>}
                          <button type="button" className="mwui-button" disabled={distillation.busy || distillation.complete} onClick={() => distillation.onConfirm()}>
                            {translate(language, distillation.confirmed ? 'archives.distillCheck' : 'archives.distillPublish')}
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
            : sync.unavailableReason !== undefined
              ? <span className="mwui-muted">{translate(language, sync.unavailableReason === 'not-configured' ? 'sync.off' : sync.unavailableReason === 'unauthorized' ? 'sync.unauthorized' : 'sync.unreachable')}</span>
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
  /**
   * The memories that carry the selected entity, rendered with the same card as the list and the
   * search results. The index alone answers "which names exist"; the reason to pick one is to see
   * what it appears in.
   */
  memories?: UiMemoryList | null;
  memoriesError?: string | null;
  memoriesLoading?: boolean;
  onOpen?: (memoryId: string) => void;
  onCopyId?: (memoryId: string) => Promise<boolean>;
  onClone?: (content: string) => void;
}

/**
 * Entity index.
 *
 * A memory can be reached by what it is about, not only by text it happens to contain: this lists
 * the entities its current revision names, with counts. Selecting one applies it to the memory
 * list rather than duplicating a second results view.
 */
/**
 * The Entities page.
 *
 * The reference implementation puts the index in a rail beside the results rather than above them:
 * picking a name is how a reader changes what the right-hand side shows, so the two belong side by
 * side. The rail is paged — a store can hold thousands of entity names — and states how much of the
 * index is on screen.
 */
export function EntitiesPanel(props: EntitiesProps): ReactNode {
  const { entities, query, error, loading, language, active } = props;
  const [limit, setLimit] = useState(ENTITY_RAIL_PAGE);
  const visible = filterEntities(entities, query);
  const shown = visible.slice(0, limit);
  const remaining = Math.max(0, visible.length - shown.length);
  return (
    /* data-fill keeps the page from scrolling as a whole, so both columns can reach the bottom
       and scroll independently. */
    <div className="mwui-page" data-fill="true">
      <div className="mwui-entity-layout">
        <aside className="mwui-entity-rail" aria-busy={loading || undefined}>
          <div className="mwui-entity-search">
            <input
              className="mwui-input"
              type="search"
              value={query}
              placeholder={translate(language, 'entities.filter')}
              aria-label={translate(language, 'entities.filter')}
              onChange={event => { props.onChangeQuery(event.target.value); setLimit(ENTITY_RAIL_PAGE); }}
            />
            <button
              type="button"
              className="mwui-button"
              disabled={query.trim() === ''}
              onClick={() => props.onSelect(query.trim())}
            >
              {translate(language, 'entities.action')}
            </button>
          </div>
          <div className="mwui-entity-heading">
            <span>{translate(language, 'entities.top')}</span>
            <small>{query === '' ? translate(language, 'entities.frequency') : translate(language, 'entities.filterHint')}</small>
          </div>
          {error === null ? null : <div className="mwui-inline-error" role="alert">{error}</div>}
          {visible.length === 0
            ? <div className="mwui-empty">{translate(language, entities.length === 0 ? 'entities.empty' : 'entities.noMatch')}</div>
            : (
              <div className="mwui-entity-list">
                {shown.map(item => (
                  <button
                    key={item.value}
                    type="button"
                    aria-pressed={active !== '' && active.toLowerCase() === item.value.toLowerCase()}
                    onClick={() => props.onSelect(item.value)}
                  >
                    <span>{item.value}</span>
                    <strong>{item.count}</strong>
                  </button>
                ))}
              </div>
            )}
          {visible.length === 0 ? null : (
            <div className="mwui-entity-progress">
              <span>{translate(language, 'common.showing', { visible: String(shown.length), total: String(visible.length) })}</span>
              {remaining === 0 ? null : (
                <button type="button" className="mwui-button mwui-mini" onClick={() => setLimit(current => current + ENTITY_RAIL_PAGE)}>
                  {translate(language, 'common.showMore', { count: String(Math.min(ENTITY_RAIL_PAGE, remaining)) })}
                </button>
              )}
            </div>
          )}
        </aside>
        <section className="mwui-entity-results">
          {props.active === '' || props.memories === undefined || props.memories === null || props.onOpen === undefined || props.onCopyId === undefined
            ? <div className="mwui-empty">{translate(language, 'entities.pickHint')}</div>
            : (
              <div className="mwui-entity-memories">
                <div className="mwui-pane-header">
                  <span className="mwui-pane-title">{props.active}</span>
                  <span className="mwui-filter-count">{String(props.memories.items.length)}</span>
                </div>
                {props.memoriesLoading === true
                  ? <div className="mwui-empty">{translate(language, 'toolbar.loading')}</div>
                  : props.memoriesError != null && props.memoriesError !== ''
                  ? <div className="mwui-inline-error" role="alert">{props.memoriesError}</div>
                  : props.memories.items.length === 0
                  ? <div className="mwui-empty">{translate(language, 'entities.noMemories')}</div>
                  : (
                    <ul className="mwui-list">
                      {props.memories.items.map(item => (
                        <MemoryCard
                          key={item.memoryId}
                          item={item}
                          active={false}
                          language={language}
                          now={Date.now()}
                          onSelect={props.onOpen!}
                          onCopyId={props.onCopyId!}
                          {...(props.onClone === undefined ? {} : { onClone: props.onClone })}
                        />
                      ))}
                    </ul>
                  )}
              </div>
            )}
        </section>
      </div>
    </div>
  );
}

/**
 * How many entity names the rail shows at a time.
 *
 * A page of ten: the rail is narrow, and a long scrolling list makes the counts at the top the
 * only ones a reader ever looks at.
 */
const ENTITY_RAIL_PAGE = 10;

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
  /**
   * Body text by memory id, from the list the page already holds.
   *
   * A node has no body of its own: reading one per node would cost a Provider process each, which
   * is why the graph is a structure-only answer. The list has already paid that cost for the rows
   * it shows, so the drawing borrows those labels instead of asking again.
   */
  labels?: Map<string, string> | undefined;
  /**
   * Open the entity page filtered to one name.
   *
   * An entity node has no memory to open, and its name is a filter the entity page already
   * understands — sending it there is the only action that leads somewhere.
   */
  onExploreEntity?(entity: string): void;
  /**
   * Search the collection around one memory's own text.
   *
   * This is what the graph is for: a node is a starting point, not a destination. Opening the body
   * answers "what does this say", which the memory page already answers; searching its text answers
   * "what else is like this", which only this drawing can lead to.
   */
  onExploreMemory?(content: string): void;
  language: Language;
  /** The memory whose detail is open, drawn as the focus when it is in the graph. */
  focusId: string | null;
  onReload(): void;
}

/**
 * The graph as a section of a page. dsh-mnemon draws the merged graph below the memory overview's
 * own cards; the overview owns the section, so it has no page wrapper of its own.
 */
/**
 * The graph as a section of a page.
 *
 * The reference implementation draws one SVG with three things rings cannot express: entity nodes
 * beside memories, a force arrangement so linked memories sit together, and nodes that can be
 * dragged. The layout work lives in `graph-layout.ts`; this component owns the interaction.
 */
export function GraphSection(props: GraphProps): ReactNode {
  const { graph, loading, error, language, focusId, labels } = props;
  /**
   * How many nodes to draw.
   *
   * A graph with hundreds of memories is unreadable at this size, so the drawing keeps the
   * best-connected part of it: the focused memory first, then entity nodes (they are what join
   * memories), then the rest. The page states the total so a reader knows the drawing is a subset.
   */
  const visible = useMemo(() => {
    if (graph === null) return [];
    const entities = graph.nodes.filter(item => item.kind === 'entity');
    const memories = graph.nodes.filter(item => item.kind !== 'entity');
    const ordered = [
      ...(focusId === null ? [] : memories.filter(item => item.memoryId === focusId)),
      ...memories.filter(item => item.memoryId !== focusId),
    ];
    return [...entities.slice(0, 24), ...ordered].slice(0, 60);
  }, [graph, focusId]);
  const visibleIds = useMemo(() => new Set(visible.map(nodeKey)), [visible]);
  const edges = useMemo(() => {
    if (graph === null) return [];
    // Entity links first: they carry the structure, and the cap must not cut them first.
    const priority: Record<string, number> = { Entity: 0, Conflicts: 1, Supersedes: 2, RelatedTo: 3 };
    return graph.edges
      .filter(edge => visibleIds.has(edge.sourceMemoryId) && visibleIds.has(edge.targetMemoryId))
      .map((edge, index) => ({ edge, index }))
      .sort((left, right) => (priority[left.edge.kind] ?? 9) - (priority[right.edge.kind] ?? 9) || left.index - right.index)
      .slice(0, 180)
      .map(({ edge }) => edge);
  }, [graph, visibleIds]);
  /**
   * Side-by-side edges are bowed apart.
   *
   * Two memories can share several entities, which draws several lines between the same two points;
   * without an offset they overlap into one and the reader sees a single relation.
   */
  const curved = useMemo(() => {
    const groups = new Map<string, number[]>();
    edges.forEach((edge, index) => {
      const key = [edge.sourceMemoryId, edge.targetMemoryId].sort().join('::');
      groups.set(key, [...(groups.get(key) ?? []), index]);
    });
    return edges.map((edge, index) => {
      const key = [edge.sourceMemoryId, edge.targetMemoryId].sort().join('::');
      const group = groups.get(key) ?? [index];
      const position = group.indexOf(index);
      return { edge, offset: (position - (group.length - 1) / 2) * 12 };
    });
  }, [edges]);
  const layoutKey = `${visible.map(item => `${nodeKey(item)}:${item.kind ?? 'memory'}:${item.category ?? 'general'}`).join('|')}::${edges.map(edge => `${edge.sourceMemoryId}>${edge.targetMemoryId}:${edge.kind}`).join('|')}`;
  const natural = useMemo(() => naturalGraphPositions(visible, edges), [layoutKey]);
  const [positions, setPositions] = useState<GraphPositions>(() => natural);
  const [layoutMode, setLayoutMode] = useState<GraphLayoutMode>('natural');
  const positionsRef = useRef(positions);
  const animationRef = useRef<number | null>(null);
  const dragRef = useRef<{ nodeId: string; pointerId: number; startX: number; startY: number; moved: boolean } | null>(null);

  const commit = useCallback((next: GraphPositions) => {
    positionsRef.current = next;
    setPositions(next);
  }, []);
  const cancelAnimation = useCallback(() => {
    if (animationRef.current !== null && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
  }, []);
  /**
   * Move to a new arrangement by animating rather than snapping.
   *
   * A snap loses the reader's place: every node jumps at once and the eye cannot follow which one
   * went where. Environments without animation frames get the target directly.
   */
  const animateTo = useCallback((target: GraphPositions, mode: Exclude<GraphLayoutMode, 'custom'>) => {
    cancelAnimation();
    setLayoutMode(mode);
    if (typeof window.requestAnimationFrame !== 'function') { commit(target); return; }
    const start = new Map(positionsRef.current);
    const startedAt = performance.now();
    const tick = (time: number): void => {
      const progress = Math.min(1, (time - startedAt) / 620);
      const eased = 1 - Math.pow(1 - progress, 3);
      const next: GraphPositions = new Map();
      for (const [id, destination] of target) {
        const origin = start.get(id) ?? { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 };
        next.set(id, { x: origin.x + (destination.x - origin.x) * eased, y: origin.y + (destination.y - origin.y) * eased });
      }
      commit(next);
      if (progress < 1) animationRef.current = window.requestAnimationFrame(tick);
      else animationRef.current = null;
    };
    animationRef.current = window.requestAnimationFrame(tick);
  }, [cancelAnimation, commit]);

  useEffect(() => { animateTo(natural, 'natural'); }, [layoutKey]);
  useEffect(() => () => cancelAnimation(), [cancelAnimation]);

  const beginDrag = (event: ReactPointerEvent<SVGGElement>, nodeId: string): void => {
    cancelAnimation();
    dragRef.current = { nodeId, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  /** Map a pointer position into the drawing's coordinate space, so a drag follows the cursor. */
  const graphPoint = (svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } => {
    const matrix = svg.getScreenCTM?.();
    if (matrix !== null && matrix !== undefined && typeof svg.createSVGPoint === 'function') {
      const point = svg.createSVGPoint();
      point.x = clientX; point.y = clientY;
      return clampGraphPosition(point.matrixTransform(matrix.inverse()));
    }
    const bounds = svg.getBoundingClientRect();
    const width = bounds.width || GRAPH_WIDTH;
    const height = bounds.height || GRAPH_HEIGHT;
    return clampGraphPosition({ x: (clientX - bounds.left) * GRAPH_WIDTH / width, y: (clientY - bounds.top) * GRAPH_HEIGHT / height });
  };
  const moveDrag = (event: ReactPointerEvent<SVGGElement>): void => {
    const drag = dragRef.current;
    const svg = event.currentTarget.ownerSVGElement;
    if (drag === null || svg === null || drag.pointerId !== event.pointerId) return;
    // A few pixels of movement is a click, not a drag: without this, selecting a node would also
    // nudge it off the arrangement the reader was looking at.
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
    drag.moved = true;
    const next = new Map(positionsRef.current);
    next.set(drag.nodeId, graphPoint(svg, event.clientX, event.clientY));
    commit(next);
    setLayoutMode('custom');
  };
  const endDrag = (event: ReactPointerEvent<SVGGElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const svg = event.currentTarget.ownerSVGElement;
    if (drag.moved && svg !== null) {
      const next = new Map(positionsRef.current);
      next.set(drag.nodeId, graphPoint(svg, event.clientX, event.clientY));
      commit(next);
    }
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    // A tap selects; it never opens. Opening is the inspector's own action, because a node is also
    // how the drawing is rearranged — leaving the graph on the first click would make dragging
    // start on a page the reader did not ask for.
  };
  const cancelDrag = (event: ReactPointerEvent<SVGGElement>): void => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };
  /** Arrow keys move a node, so the arrangement is reachable without a pointer. */
  const nudge = (nodeId: string, dx: number, dy: number): void => {
    cancelAnimation();
    const current = positionsRef.current.get(nodeId);
    if (current === undefined) return;
    const next = new Map(positionsRef.current);
    next.set(nodeId, clampGraphPosition({ x: current.x + dx, y: current.y + dy }));
    commit(next);
    setLayoutMode('custom');
  };
  const layoutLabel = translate(language, layoutMode === 'natural' ? 'graph.layoutNatural' : layoutMode === 'uniform' ? 'graph.layoutUniform' : 'graph.layoutCustom');
  /**
   * The node the inspector describes.
   *
   * The inspector is a separate column rather than a popover: reading a node and changing the
   * drawing are the same task, so the two sit side by side and neither covers the other.
   */
  /**
   * The node the inspector describes.
   *
   * The selection is resolved from `visible` on every render rather than held as a copy: a reload
   * can replace the node objects, and a copy would leave the inspector describing a node the
   * drawing no longer has. Resolving by key means a node that disappeared simply closes the
   * inspector, the same way the reference implementation re-finds its selection after a refresh.
   */
  const [selectedKey, setSelectedKey] = useState<string | null>(focusId);
  const selected = selectedKey === null ? null : visible.find(item => nodeKey(item) === selectedKey) ?? null;
  const selectedIsEntity = selected?.kind === 'entity';
  /** The node's readable text: an entity's name, or the memory body held by the page. */
  const selectedText = selected === null
    ? ''
    : selected.kind === 'entity'
      ? selected.label ?? selected.memoryId
      : labels?.get(selected.memoryId) ?? selected.label ?? selected.memoryId;
  const [preview, setPreview] = useState<UiGraphNode | null>(null);
  /**
   * Direct neighbours of the selection.
   *
   * Reading a node and seeing what it connects to are the same question, so the rest of the
   * drawing recedes rather than staying equally loud. One hop only: a second hop would make
   * almost everything relevant and the emphasis would stop meaning anything.
   */
  const neighbours = useMemo(() => {
    if (selectedKey === null) return null;
    const found = new Set<string>();
    for (const edge of edges) {
      if (edge.sourceMemoryId === selectedKey) found.add(edge.targetMemoryId);
      else if (edge.targetMemoryId === selectedKey) found.add(edge.sourceMemoryId);
    }
    return found;
  }, [edges, selectedKey]);
  // How many of each kind are drawn: the footer states the composition, so a reader knows the
  // drawing is a subset before counting dots.
  const memoryCount = visible.filter(item => item.kind !== 'entity').length;
  const entityCount = visible.length - memoryCount;

  return (
      <section className="mwui-pane">
        <div className="mwui-pane-header">
          <span className="mwui-pane-title">{translate(language, 'graphs.title')}</span>
          <button type="button" className="mwui-button mwui-mini" onClick={props.onReload} disabled={loading}>
            {translate(language, loading ? 'graph.loading' : 'graph.reload')}
          </button>
        </div>
        <div className="mwui-detail">
          {error === null ? null : <div className="mwui-inline-error" role="alert">{error}</div>}
          {graph === null ? (loading ? <div className="mwui-empty">{translate(language, 'graph.loading')}</div> : null) : (
            graph.nodes.length === 0
              ? <div className="mwui-empty">{translate(language, 'graphs.empty')}</div>
              : (
                <div className="mwui-graph-layout">
                  <section className="mwui-graph-panel">
                    {/* The toolbar states what the drawing is and what its colours mean; the footer
                        says how much of the graph is on screen. Both read the same counts as the
                        drawing, so the three never disagree. */}
                    <div className="mwui-graph-toolbar">
                      <div>
                        <span className="mwui-live-dot" />
                        {translate(language, 'graph.snapshot')}
                        <small>{translate(language, 'graph.snapshotHint')}</small>
                      </div>
                      <div className="mwui-graph-legend">
                        <span data-edge="Entity">{translate(language, 'graph.edgeEntity')}</span>
                        <span data-edge="Supersedes">{translate(language, 'graph.edgeSupersedes')}</span>
                        <span data-edge="Conflicts">{translate(language, 'graph.edgeConflicts')}</span>
                        <span data-edge="RelatedTo">{translate(language, 'graph.edgeRelated')}</span>
                      </div>
                    </div>
                    <div className="mwui-graph-viewport">
                      <div className="mwui-graph-controls" role="toolbar" aria-label={translate(language, 'graph.layoutAria')}>
                        <span role="status" aria-label={translate(language, 'graph.layoutStatus', { layout: layoutLabel })}><i />{translate(language, 'graph.draggable', { layout: layoutLabel })}</span>
                        <button type="button" data-active={layoutMode === 'natural' || undefined} onClick={() => animateTo(naturalGraphPositions(visible, edges), 'natural')}>{translate(language, 'graph.naturalAction')}</button>
                        <button type="button" data-active={layoutMode === 'uniform' || undefined} onClick={() => animateTo(uniformGraphPositions(visible), 'uniform')}>{translate(language, 'graph.uniformAction')}</button>
                      </div>
                      <div className="mwui-graph-wrap">
                        <svg
                          className="mwui-graph"
                          viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
                          role="img"
                          data-layout={layoutMode}
                          data-density={visible.length <= 12 ? 'sparse' : 'dense'}
                          aria-label={translate(language, 'graphs.aria', { nodes: String(graph.nodes.length), links: String(graph.edges.length) })}
                        >
                          <defs>
                            <pattern id="mwui-grid" width="26" height="26" patternUnits="userSpaceOnUse">
                              <path d="M 26 0 L 0 0 0 26" className="mwui-graph-grid-line" fill="none" />
                            </pattern>
                            {/* A selected node carries a soft glow so it stays findable in a dense drawing. */}
                            <filter id="mwui-glow" x="-100%" y="-100%" width="300%" height="300%">
                              <feGaussianBlur stdDeviation="4" result="blur" />
                              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                            </filter>
                          </defs>
                          <rect width={GRAPH_WIDTH} height={GRAPH_HEIGHT} className="mwui-graph-backdrop" />
                          <rect width={GRAPH_WIDTH} height={GRAPH_HEIGHT} fill="url(#mwui-grid)" />
                          {curved.map(({ edge, offset }, index) => {
                            const source = positions.get(edge.sourceMemoryId) ?? natural.get(edge.sourceMemoryId) ?? { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 };
                            const target = positions.get(edge.targetMemoryId) ?? natural.get(edge.targetMemoryId) ?? { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 };
                            const dx = target.x - source.x;
                            const dy = target.y - source.y;
                            const distance = Math.max(1, Math.hypot(dx, dy));
                            const direction = edge.sourceMemoryId.localeCompare(edge.targetMemoryId) <= 0 ? 1 : -1;
                            const controlX = (source.x + target.x) / 2 - (dy / distance) * offset * direction;
                            const controlY = (source.y + target.y) / 2 + (dx / distance) * offset * direction;
                            // An edge stays loud only when it touches the selection; the rest of
                            // the web dims with its nodes so the two never disagree.
                            const touchesSelection = selectedKey !== null
                              && (edge.sourceMemoryId === selectedKey || edge.targetMemoryId === selectedKey);
                            const mutedEdge = selectedKey !== null && !touchesSelection;
                            return (
                              <path
                                key={`${edge.relationId}-${index}`}
                                d={`M ${source.x} ${source.y} Q ${controlX} ${controlY} ${target.x} ${target.y}`}
                                className="mwui-graph-edge"
                                data-edge={edge.kind}
                                data-muted={mutedEdge || undefined}
                              />
                            );
                          })}
                          {visible.map((item, index) => {
                            const key = nodeKey(item);
                            const position = positions.get(key) ?? natural.get(key) ?? { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 };
                            const isSelected = selectedKey === key || focusId === key;
                            const isEntity = item.kind === 'entity';
                            // With a node selected, everything not connected to it recedes: the
                            // emphasis is what makes the selection readable, not the highlight alone.
                            const muted = neighbours !== null && !isSelected && !neighbours.has(key);
                            // Labels crowd a dense drawing, so only every third node keeps one
                            // unless the graph is small enough for all of them.
                            const showLabel = isSelected || visible.length < 22 || index % 3 === 0;
                            const text = (isEntity ? item.label ?? item.memoryId : labels?.get(item.memoryId) ?? item.label ?? item.memoryId.slice(0, 8)).replace(/\s+/gu, ' ');
                            // A dense drawing needs short labels: a 19-character label at this scale is wider than the
                            // gap between neighbouring nodes and overlaps the next one.
                            const limit = isSelected ? 30 : visible.length <= 12 ? 22 : 16;
                            return (
                              <g
                                key={key}
                                className="mwui-graph-node"
                                data-node-id={key}
                                data-category={item.category ?? 'general'}
                                data-kind={isEntity ? 'entity' : 'memory'}
                                data-selected={isSelected || undefined}
                                data-muted={muted || undefined}
                                transform={`translate(${position.x} ${position.y})`}
                                role="button"
                                tabIndex={0}
                                aria-label={`${isEntity ? translate(language, 'graph.kindEntity') : translate(language, 'graph.kindMemory')}: ${text}`}
                                data-dragging={dragRef.current?.nodeId === key || undefined}
                                onPointerDown={event => beginDrag(event, key)}
                                onPointerMove={moveDrag}
                                onPointerUp={endDrag}
                                onPointerCancel={cancelDrag}
                                onLostPointerCapture={cancelDrag}
                                onClick={() => setSelectedKey(key)}
                                onKeyDown={event => {
                                  if (event.key === 'Enter' || event.key === ' ') setSelectedKey(key);
                                  else if (event.key === 'ArrowLeft') { event.preventDefault(); nudge(key, -12, 0); }
                                  else if (event.key === 'ArrowRight') { event.preventDefault(); nudge(key, 12, 0); }
                                  else if (event.key === 'ArrowUp') { event.preventDefault(); nudge(key, 0, -12); }
                                  else if (event.key === 'ArrowDown') { event.preventDefault(); nudge(key, 0, 12); }
                                }}
                              >
                                {isEntity
                                  ? <><path d={isSelected ? 'M 0 -18 L 18 0 L 0 18 L -18 0 Z' : 'M 0 -14 L 14 0 L 0 14 L -14 0 Z'} className="mwui-graph-halo" filter={isSelected ? 'url(#mwui-glow)' : undefined} /><circle r={isSelected ? 5 : 4} className="mwui-graph-core" /></>
                                  : <><circle r={isSelected ? 17 : visible.length <= 12 ? 14 : 11} className="mwui-graph-halo" filter={isSelected ? 'url(#mwui-glow)' : undefined} /><circle r={isSelected ? 7 : visible.length <= 12 ? 6 : 4.5} className="mwui-graph-core" /></>}
                                {showLabel && (
                                  <text x={visible.length <= 12 ? 19 : 15} y="4" className="mwui-graph-label">
                                    {text.length > limit ? `${text.slice(0, limit)}…` : text}
                                  </text>
                                )}
                              </g>
                            );
                          })}
                        </svg>
                      </div>
                    </div>
                    {graph.edges.length === 0 ? (
                      <div className="mwui-edit-hint" data-tone="muted">{translate(language, 'graphs.noRelations')}</div>
                    ) : null}
                    <div className="mwui-graph-footer">
                      <span>
                        {translate(language, 'graph.composition', { memories: String(memoryCount), entities: String(entityCount) })}
                      </span>
                      <span>
                        {translate(language, 'graph.counts', { visible: String(memoryCount + entityCount), total: String(graph.nodes.length) })} · {translate(language, 'graph.edges', { count: String(graph.edges.length) })}
                        {graph.truncated ? ` · ${translate(language, 'graph.truncated')}` : ''}
                      </span>
                    </div>
                  </section>
                  <aside className="mwui-graph-inspector" data-empty={selected === null || undefined}>
                    {selected === null ? (
                      <div className="mwui-inspector-empty">
                        <span className="mwui-inspector-logo" aria-hidden="true">◇</span>
                        <h3>{translate(language, 'graph.selectNode')}</h3>
                        <p>{translate(language, 'graph.selectNodeHint')}</p>
                      </div>
                    ) : (
                      <>
                        <div className="mwui-inspector-heading">
                          <span>{translate(language, selectedIsEntity ? 'graph.inspectorEntity' : 'graph.inspectorMemory')}</span>
                          <button type="button" onClick={() => setSelectedKey(null)} aria-label={translate(language, 'graph.closeInspector')}>×</button>
                        </div>
                        <div className="mwui-inspector-chips">
                          <span className="mwui-category-chip">
                            {translate(language, selectedIsEntity ? 'graph.kindEntity' : 'graph.kindMemory')}
                          </span>
                          {selected.category === undefined ? null : <span className="mwui-category-chip">{selected.category}</span>}
                        </div>
                        <div className="mwui-inspector-title-row">
                          <h3 className="mwui-inspector-title">{selectedText}</h3>
                          {/*
                            * The title is clamped, so a long body appears cut off with no way to read
                            * the rest. The eye opens the whole text rather than making the inspector
                            * scroll: the column is narrow and the page behind it stays put.
                            */}
                          {selectedText.length > 140 ? (
                            <button
                              type="button"
                              className="mwui-inspector-eye"
                              aria-label={translate(language, 'graph.previewAria')}
                              title={translate(language, 'graph.previewAria')}
                              onClick={() => setPreview(selected)}
                            >
                              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                                <path d="M1 8s2.6-4.4 7-4.4S15 8 15 8s-2.6 4.4-7 4.4S1 8 1 8z" fill="none" stroke="currentColor" strokeWidth="1.5" />
                                <circle cx="8" cy="8" r="2.1" fill="currentColor" />
                              </svg>
                            </button>
                          ) : null}
                        </div>
                        <dl className="mwui-inspector-meta">
                          {selectedIsEntity ? (
                            <>
                              <div><dt>{translate(language, 'graph.entityMentions')}</dt><dd>{String(selected.occurrenceCount ?? 0)}</dd></div>
                              <div><dt>{translate(language, 'graph.entityKey')}</dt><dd><code>{selected.memoryId}</code></dd></div>
                            </>
                          ) : (
                            <>
                              <div><dt>{translate(language, 'graph.memoryId')}</dt><dd><code>{selected.memoryId}</code></dd></div>
                              <div><dt>{translate(language, 'graph.state')}</dt><dd>{selected.state}</dd></div>
                              {selected.category === undefined ? null : <div><dt>{translate(language, 'graph.category')}</dt><dd>{selected.category}</dd></div>}
                            </>
                          )}
                        </dl>
                        <div className="mwui-inspector-actions">
                          {selectedIsEntity
                            ? <button type="button" className="mwui-button" data-variant="primary" onClick={() => props.onExploreEntity?.(selectedText)}>{translate(language, 'graph.findEntity')}</button>
                            : <button type="button" className="mwui-button" data-variant="primary" onClick={() => props.onExploreMemory?.(selectedText)}>{translate(language, 'graph.exploreMemory')}</button>}
                          <button type="button" className="mwui-button" onClick={() => { void navigator.clipboard?.writeText(selected.memoryId); }}>{translate(language, 'graph.copyId')}</button>
                        </div>
                      </>
                    )}
                  </aside>
                </div>
              )
          )}
        </div>
        {preview === null ? null : (
          <Modal
            title={translate(language, 'graph.previewTitle')}
            subtitle={preview.category ?? translate(language, 'graph.inspectorMemory')}
            onClose={() => setPreview(null)}
            language={language}
          >
            <p className="mwui-preview-body">{labels?.get(preview.memoryId) ?? preview.label ?? preview.memoryId}</p>
          </Modal>
        )}
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
  /** See `GraphProps.onExploreEntity`: an entity node leads to the entity page, not to a memory. */
  onExploreEntity?(entity: string): void;
  /** See `GraphProps.onExploreMemory`: a memory node leads to a search around its text. */
  onExploreMemory?(content: string): void;
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
  // Labels come from the list the page already loaded; a memory the list has not read keeps its id.
  const labels = new Map((memories?.items ?? []).map(item => [item.memoryId, item.content] as const));
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
        labels={labels}
        onReload={props.onReloadGraph}
        {...(props.onExploreEntity === undefined ? {} : { onExploreEntity: props.onExploreEntity })}
        {...(props.onExploreMemory === undefined ? {} : { onExploreMemory: props.onExploreMemory })}
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
 * knowledge. The form asks for the classification a new memory cannot inherit from a previous
 * revision, and it shows the byte budget the Server enforces.
 */
export interface CreateDraft {
  content: string;
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
/**
 * A card summarizing one memory.
 *
 * The layout follows the upstream card: a badge row of the facts that identify the entry, the
 * body as the primary text, then tags and entities as their own rows, then the actions. The body
 * is shown whole rather than clamped: a memory is one statement, and an excerpt that hides the
 * end of it is the part a reader most often needs. The card is a button because selecting is the
 * primary action; the action row sits outside it so a click cannot do both.
 */
export function MemoryCard({ item, active, language, now, onSelect, onCopyId, onRelated, onWithdraw, extraBadges, onClone }: {
  /**
   * The fields a card draws. The list supplies an `entryVersion`; a search hit has no version and
   * passes none, so the type states which fields are required rather than forcing a placeholder.
   */
  item: Omit<UiMemorySummary, 'entryVersion'> & { entryVersion?: number };
  active: boolean;
  language: Language;
  now: number;
  onSelect(id: string): void;
  onCopyId(memoryId: string): Promise<boolean>;
  /** Absent when this view cannot explore; the button is then not rendered at all. */
  onRelated?: (content: string) => void;
  /** Absent when the caller cannot withdraw; forgetting is never offered as a dead control. */
  onWithdraw?: (memoryId: string) => void;
  /** Facts only this view knows, such as a search score; shown after the identifying badges. */
  extraBadges?: string[];
  /** Start a new memory from this body. Absent when the caller cannot create. */
  onClone?: (content: string) => void;
}): JSX.Element {
  // Copying is confirmed on the row that copied, so the button label never claims a different
  // memory was copied.
  const [copiedId, setCopiedId] = useState(false);
  // Classification is shown only when the revision recorded it: an absent category is not
  // "general", and labelling it as such would be inventing data.
  const label = item.category === undefined
    ? undefined
    : translate(language, `category.${item.category}` as MessageKey);
  // Every badge names a fact about this entry. Absent values are omitted, not filled with a dash.
  const badges: string[] = [
    label ?? '',
    item.importance === undefined ? '' : translate(language, 'card.importance', { value: String(item.importance) }),
  ].filter(entry => entry !== '');
  return (
    <li className="mwui-memcard-item">
      <button type="button" className="mwui-memcard" data-active={active ? 'true' : 'false'} onClick={() => onSelect(item.memoryId)}>
        <span className="mwui-memcard-badges">
          {badges.map(badge => <span key={badge} className="mwui-chip-slim">{badge}</span>)}
          {/* A search hit carries no entry version; only the list knows it. */}
          {item.entryVersion === undefined
            ? null
            : <span className="mwui-chip-slim">{translate(language, 'detail.revision')} v{item.entryVersion}</span>}
          {(extraBadges ?? []).map(badge => <span key={badge} className="mwui-chip-slim">{badge}</span>)}
        </span>
        <span className="mwui-memcard-content">{item.content}</span>
        {item.tags === undefined || item.tags.length === 0 ? null : (
          <span className="mwui-memcard-tags">{item.tags.map(tag => <span key={tag}>#{tag}</span>)}</span>
        )}
        {item.entities === undefined || item.entities.length === 0 ? null : (
          <span className="mwui-memcard-tags" data-tone="entity">{item.entities.map(entity => <span key={entity}>{entity}</span>)}</span>
        )}
        <span className="mwui-memcard-meta">{relativeTime(item.publishedAt, now, language)}</span>
      </button>
      <div className="mwui-memcard-actions">
        {onRelated === undefined ? null : (
          <button type="button" className="mwui-button mwui-mini" onClick={() => onRelated(item.content)}>
            {translate(language, 'card.related')}
          </button>
        )}
        {onClone === undefined ? null : (
          <button type="button" className="mwui-button mwui-mini" onClick={() => onClone(item.content)}>
            {translate(language, 'card.clone')}
          </button>
        )}
        <button
          type="button"
          className="mwui-button mwui-mini"
          onClick={() => {
            void onCopyId(item.memoryId).then(ok => {
              if (!ok) return;
              setCopiedId(true);
              setTimeout(() => setCopiedId(false), 1200);
            });
          }}
        >
          {copiedId ? translate(language, 'detail.copied') : translate(language, 'detail.copyId')}
        </button>
        {onWithdraw === undefined ? null : (
          <button type="button" className="mwui-button mwui-mini mwui-danger" onClick={() => onWithdraw(item.memoryId)}>
            {translate(language, 'card.withdraw')}
          </button>
        )}
      </div>
    </li>
  );
}

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
  /** Copy a result's id from the result itself. */
  onCopyId(memoryId: string): Promise<boolean>;
  onClone?(content: string): void;
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
          {/* Before the first search the page is one input; saying what a search does is what
              turns the blank area below it into an answer rather than an empty page. */}
          {result === null ? (
            <div className="mwui-empty">{translate(language, 'explore.prompt')}</div>
          ) : (
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
                      <MemoryCard
                        key={hit.memoryId}
                        item={{
                          memoryId: hit.memoryId, revisionId: hit.revisionId, providerMemoryId: hit.providerMemoryId,
                          publishedAt: hit.publishedAt, content: hit.content,
                          ...(hit.category === undefined ? {} : { category: hit.category }),
                          ...(hit.tags === undefined ? {} : { tags: hit.tags }),
                        }}
                        active={false}
                        language={language}
                        now={Date.now()}
                        onSelect={props.onOpen}
                        onCopyId={props.onCopyId}
                        {...(props.onClone === undefined ? {} : { onClone: props.onClone })}
                        extraBadges={[`${translate(language, 'explore.score')} ${hit.score.toFixed(2)}`]}
                      />
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
