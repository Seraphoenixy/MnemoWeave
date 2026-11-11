import { SkillBacktestPanel, SkillListPanel } from './skill-backtest.tsx';
import { diffLines, type DiffLine } from '../shared/skills-diff.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CreateDraft } from './panels.tsx';
import type { ListSort, UiArchive, UiArchiveCapacity, UiArchiveHistory, UiConfigView, UiConnectionTest, UiEmbeddingDiagnostics, UiExplore, UiGraph, UiInjection, UiMemoryDetail, UiMemoryList, UiMemorySummary, UiOrganizeItem, UiRegisterTest, UiRule, UiRuleUsage, UiSettings, UiSkillDraft, UiSkillEntry, UiSkillReport, UiSkillVersion, UiStatus, UiSyncPass, UiSyncStatus, UiTrashEntry, UiWakeTest } from '../shared/contract.ts';
import { createApi, RpcFailure } from './api.ts';
import type { ClientConnection, LocaleService } from './dsh-types.ts';
import { normalizeLanguage, translate, type Language, type MessageKey } from './i18n.ts';
import { ensureStyles } from './styles.ts';
import { ArchivesPanel, CreateMemoryForm, EntitiesPanel, ExplorePanel, MemoryOverviewPanel, MemoryPageHeader, OverviewPanel, RuntimePanel, SettingsPanel, TAB_KEYS, TAB_ORDER, isTab, type MemoryView, type RuleDraft, type Tab } from './panels.tsx';
import { Modal } from './modal.tsx';
import {
  availabilityText, classificationLists, classificationMeta, codeText, detailMeta, EDIT_LIMIT_BYTES, editBlocker, neighbourhood,
  formatDateTime, injectionChip,
  listSummary, openConflicts, relationRows, relativeTime, revisionTimeline,
  statusChips, utf8Bytes, type Chip, type Tone,
} from './view-model.ts';

export interface MemoryPageProps {
  connection: ClientConnection;
  locale?: LocaleService;
}

/** Split a comma-separated field into trimmed, non-empty values. */
function toList(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(item => item !== '');
}

/** Used until the stored preference arrives; the settings page can change it. */
const LIST_LIMIT = 25;
/** Categories the edit form offers; the Server accepts exactly these. */
const CATEGORY_VALUES = ['preference', 'decision', 'fact', 'insight', 'context', 'general'] as const;
/** The empty creation draft, restored whenever the create window closes without publishing. */
const EMPTY_CREATE_DRAFT: CreateDraft = {
  content: '', knowledgeType: 'Practice', category: '', importance: '', tags: '', entities: '',
  projectId: '',
  reason: '',
};

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

/** The budget refusal and a stale base version are the two rule errors with specific wording. */
function ruleFailure(error: unknown, language: Language): string {
  if (error instanceof RpcFailure) {
    if (error.code === 'RULE_BUDGET_EXCEEDED') return translate(language, 'runtime.budget');
    if (error.code === 'VERSION_CONFLICT') return translate(language, 'runtime.conflict');
  }
  return failureText(error, language);
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

/** A card summarizing one memory: text first, then classification, revision and age. */
function MemoryCard({ item, active, language, now, onSelect }: { item: UiMemorySummary; active: boolean; language: Language; now: number; onSelect(id: string): void }): JSX.Element {
  // No separate title exists, so the body's first line is the headline and the rest the excerpt.
  const [firstLine, ...rest] = item.content.split('\n');
  const headline = (firstLine ?? '').trim() === '' ? item.memoryId : firstLine!;
  const excerpt = rest.join(' ').trim();
  // Classification is shown only when the revision recorded it: an absent category is not
  // "general", and labelling it as such would be inventing data.
  const label = item.category !== undefined
    ? translate(language, `category.${item.category}` as MessageKey)
    : item.knowledgeType;
  return (
    <li>
      <button type="button" className="mwui-memcard" data-active={active ? 'true' : 'false'} onClick={() => onSelect(item.memoryId)}>
        <span className="mwui-memcard-title">{headline}</span>
        {excerpt === '' ? null : <span className="mwui-memcard-excerpt">{excerpt}</span>}
        <span className="mwui-memcard-meta">
          {label === undefined ? null : <span className="mwui-chip-slim" data-tone="category">{label}</span>}
          <span className="mwui-chip-slim" data-tone="category">{item.projectId ?? translate(language, 'memory.general')}</span>
          <span className="mwui-chip-slim">{translate(language, 'detail.revision')} v{item.entryVersion}</span>
          {item.tags === undefined || item.tags.length === 0 ? null : (
            <span className="mwui-memcard-tags">{item.tags.slice(0, 3).map(tag => `#${tag}`).join(' ')}</span>
          )}
          {item.entities === undefined || item.entities.length === 0 ? null : (
            <span className="mwui-memcard-tags" data-tone="entity">{item.entities.slice(0, 3).join(' · ')}</span>
          )}
          <span>{relativeTime(item.publishedAt, now, language)}</span>
        </span>
      </button>
    </li>
  );
}

interface DetailProps {
  detail: UiMemoryDetail;
  language: Language;
  copied: 'id' | 'content' | null;
  comparing: boolean;
  /** Content of the live revision, fetched only while comparing a historical one. */
  currentContent: string | null;
  onCopy(kind: 'id' | 'content'): void;
  onSelectRevision(revisionId: string): void;
  onBackToCurrent(): void;
  onToggleCompare(): void;
  onOpenRelated(memoryId: string): void;
  /** Inline preview of a relation's target, so following an edge does not have to lose this one. */
  relatedPreviews: Record<string, { status: 'loading' | 'ready' | 'error'; content?: string; state?: string; detail?: string }>;
  onPreviewRelated(memoryId: string): void;
  /** Two-hop neighbourhood, loaded on demand from the catalogue graph. */
  neighbours: Array<{ memoryId: string; hop: number; kind: 'Supersedes' | 'RelatedTo' | 'Conflicts'; direction: 'out' | 'in' }>;
  graphLoading: boolean;
  graphError: string | null;
  graphTruncated: boolean;
  onLoadGraph(): void;
  /** Opens the edit window; the detail panel itself stays read-only. */
  onBeginEdit(): void;
  /** Opens the withdrawal window, the counterpart of an edit. */
  onBeginWithdraw(): void;
}

function DetailView(props: DetailProps): JSX.Element {
  const { detail, language, copied, comparing, currentContent } = props;
  const live = detail.revisions.find(revision => revision.current);
  return (
    <div className="mwui-detail">
      <div className="mwui-detail-head">
        <div className="mwui-detail-idrow">
          <span className="mwui-mono">{detail.memoryId}</span>
          <button type="button" className="mwui-button mwui-mini" onClick={() => props.onCopy('id')}>
            {copied === 'id' ? translate(language, 'detail.copied') : translate(language, 'detail.copyId')}
          </button>
        </div>
        <div className="mwui-chips">
          {detailMeta(detail, language).map(meta => (
            <span key={meta.key} className="mwui-chip">
              <span className="mwui-chip-label">{meta.label}</span>
              <span className="mwui-chip-value">{meta.value}</span>
            </span>
          ))}
          {/* Classification is shown only when this revision recorded it. */}
          {classificationMeta(detail, language).map(meta => (
            <span key={meta.key} className="mwui-chip">
              <span className="mwui-chip-label">{meta.label}</span>
              <span className="mwui-chip-value">{meta.value}</span>
            </span>
          ))}
        </div>
        {classificationLists(detail).tags.length === 0 && classificationLists(detail).entities.length === 0
          ? null
          : (
            <div className="mwui-chips">
              {classificationLists(detail).tags.map(tag => (
                <span key={`tag:${tag}`} className="mwui-chip-slim" data-tone="tag">#{tag}</span>
              ))}
              {classificationLists(detail).entities.map(entity => (
                <span key={`entity:${entity}`} className="mwui-chip-slim" data-tone="entity">{entity}</span>
              ))}
            </div>
          )}
      </div>

      <div>
        <div className="mwui-section-head">
          <h4 className="mwui-section-title">{translate(language, 'detail.content')}</h4>
          <div className="mwui-section-actions">
            <button type="button" className="mwui-button mwui-mini" onClick={() => props.onCopy('content')}>
              {copied === 'content' ? translate(language, 'detail.copiedContent') : translate(language, 'detail.copy')}
            </button>
            {detail.isCurrent
              ? null
              : <button type="button" className="mwui-button mwui-mini" onClick={props.onBackToCurrent}>{translate(language, 'detail.backToCurrent')}</button>}
            {detail.isCurrent && live !== undefined && detail.revisions.length > 1
              ? <button type="button" className="mwui-button mwui-mini" onClick={props.onToggleCompare} disabled={currentContent === null && !comparing}>
                  {translate(language, comparing ? 'detail.stopCompare' : 'detail.compare')}
                </button>
              : null}
          </div>
        </div>
        <div className="mwui-edit">
              {comparing && currentContent !== null && !detail.isCurrent
                ? (
                  <div className="mwui-compare">
                    <div className="mwui-compare-col">
                      <div className="mwui-compare-head">{translate(language, 'detail.content')} · #{detail.revisions.find(item => item.revisionId === detail.revisionId)?.number}</div>
                      <div className="mwui-content mwui-scroll">{detail.content === '' ? '—' : detail.content}</div>
                    </div>
                    <div className="mwui-compare-col">
                      <div className="mwui-compare-head">{translate(language, 'detail.current')} · #{live?.number ?? '—'}</div>
                      <div className="mwui-content mwui-scroll">{currentContent === '' ? '—' : currentContent}</div>
                    </div>
                  </div>
                )
                : <div className="mwui-content">{detail.content === '' ? '—' : detail.content}</div>}
              {detail.isCurrent
                ? (
                  <div className="mwui-edit-actions">
                    <button type="button" className="mwui-button" data-variant="primary" onClick={props.onBeginEdit}>
                      {translate(language, 'detail.edit')}
                    </button>
                  </div>
                )
                : <div className="mwui-edit-hint" data-tone="muted">{translate(language, 'detail.readOnlyHistory')}</div>}
        </div>
      </div>

      <div>
        <h4 className="mwui-section-title">{translate(language, 'detail.revisions')}</h4>
        <ul className="mwui-sublist">
          {revisionTimeline(detail).map(item => (
            <li key={item.revisionId} className="mwui-subrow" data-selected={item.revisionId === detail.revisionId ? 'true' : 'false'}>
              <button type="button" className="mwui-subrow-button" onClick={() => props.onSelectRevision(item.revisionId)}>
                <span className="mwui-subrow-main">
                  #{item.number}
                  {item.current ? ` · ${translate(language, 'detail.current')}` : ''}
                  {/* A revision whose parent is missing is shown as broken rather than tidied away. */}
                  {item.chained ? '' : ` · ${translate(language, 'detail.brokenChain')}`}
                </span>
                <span>{formatDateTime(item.effectiveAt)}</span>
                <span className="mwui-mono mwui-rev-hash" title={item.contentHash}>{item.contentHash.slice(0, 8)}</span>
                <span className="mwui-subrow-tail mwui-mono">{item.revisionId.slice(0, 8)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h4 className="mwui-section-title">{translate(language, 'detail.relations')}</h4>
        {detail.relations.length === 0
          ? <div className="mwui-edit-hint" data-tone="muted">{translate(language, 'detail.noRelations')}</div>
          : (
            <ul className="mwui-sublist">
              {relationRows(detail).map(relation => {
                const outcome = props.relatedPreviews[relation.otherMemoryId];
                return (
                <li key={relation.relationId} className="mwui-subrow mwui-relation">
                  <button type="button" className="mwui-subrow-button" onClick={() => props.onOpenRelated(relation.otherMemoryId)}>
                    <span className="mwui-subrow-main">
                      {translate(language, `relation.${relation.kind}` as MessageKey)}
                      {relation.direction === 'out' ? ' →' : ' ←'}
                    </span>
                    <span className="mwui-mono">{relation.otherMemoryId.slice(0, 8)}</span>
                    <span className="mwui-subrow-tail">{relation.reason}</span>
                  </button>
                  <div className="mwui-relation-meta">
                    {/* Evidence is why the edge is believed; without it a supersede is an assertion. */}
                    {relation.evidence.length === 0 ? null : (
                      <span className="mwui-relation-evidence">{relation.evidence.join('; ')}</span>
                    )}
                    {relation.nativeProjected ? null : (
                      <span className="mwui-chip-slim" data-tone="warn">{translate(language, 'detail.notProjected')}</span>
                    )}
                    <button
                      type="button"
                      className="mwui-button mwui-mini"
                      onClick={() => props.onPreviewRelated(relation.otherMemoryId)}
                      disabled={props.relatedPreviews[relation.otherMemoryId]?.status === 'loading'}
                    >
                      {translate(language, outcome === undefined ? 'detail.preview' : 'detail.previewAgain')}
                    </button>
                  </div>
                  {outcome === undefined ? null : outcome.status === 'error'
                    ? <div className="mwui-edit-hint" data-tone="warn">{translate(language, 'detail.relationUnreadable')}: {outcome.detail ?? ''}</div>
                    : outcome.status === 'loading'
                      ? <div className="mwui-edit-hint" data-tone="muted">{translate(language, 'list.loading')}</div>
                      : (
                        <div className="mwui-relation-preview">
                          <div className="mwui-edit-hint" data-tone="muted">
                            {outcome.state === undefined ? '' : translate(language, `state.${outcome.state}` as MessageKey)}
                          </div>
                          <div className="mwui-content mwui-scroll">{outcome.content === '' ? '—' : outcome.content}</div>
                        </div>
                      )}
                </li>
                );
              })}
            </ul>
          )}
        {/* Relations answer "what touches this memory"; two hops answer "what is near it".
            Loaded on demand: the graph covers the whole catalog, and opening a memory should not
            pay for it. */}
        <div className="mwui-detail-section">
          <h4 className="mwui-section-title">
            {translate(language, 'graph.title')}
            <button
              type="button"
              className="mwui-button mwui-mini"
              onClick={props.onLoadGraph}
              disabled={props.graphLoading}
            >
              {translate(language, props.graphLoading ? 'graph.loading' : props.neighbours.length === 0 ? 'graph.load' : 'graph.reload')}
            </button>
          </h4>
          {props.graphError === null ? null : <div className="mwui-inline-error" role="alert">{props.graphError}</div>}
          {props.graphTruncated ? (
            <div className="mwui-edit-hint" data-tone="warn">{translate(language, 'graph.truncated')}</div>
          ) : null}
          {props.neighbours.length === 0
            ? <div className="mwui-empty">{translate(language, 'graph.empty')}</div>
            : (
              <ul className="mwui-list">
                {props.neighbours.map(item => (
                  <li key={item.memoryId} className="mwui-subrow">
                    <button type="button" className="mwui-subrow-button" onClick={() => props.onOpenRelated(item.memoryId)}>
                      <span className="mwui-subrow-main mwui-mono">{item.memoryId.slice(0, 8)}</span>
                      <span className="mwui-chip-slim">{translate(language, `relation.${item.kind}` as MessageKey)}</span>
                      <span className="mwui-chip-slim">{translate(language, item.direction === 'out' ? 'graph.outward' : 'graph.inward')}</span>
                      <span className="mwui-subrow-tail">{translate(language, 'graph.hop', { count: item.hop })}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </div>
      </div>

      {/* An open disagreement is part of the memory's state, so it is shown even when nobody is
          editing: silently hiding it would make the memory look settled. */}
      {openConflicts(detail).length === 0 ? null : (
        <div>
          <h4 className="mwui-section-title">{translate(language, 'detail.conflicts')}</h4>
          {openConflicts(detail).map(conflict => (
            <div key={conflict.caseId} className="mwui-conflict">
              <div className="mwui-conflict-head">
                <span className="mwui-chip-slim" data-tone="warn">{translate(language, `conflict.${conflict.state}` as MessageKey)}</span>
                <span className="mwui-mono">{conflict.caseId.slice(0, 8)}</span>
              </div>
              {conflict.decisions.length === 0
                ? <div className="mwui-edit-hint" data-tone="muted">{translate(language, 'detail.noDecision')}</div>
                : (
                  <ul className="mwui-sublist">
                    {conflict.decisions.map((decision, index) => (
                      <li key={`${conflict.caseId}:${index}`} className="mwui-subrow">
                        <span className="mwui-subrow-main">{decision.actor}</span>
                        <span>{decision.decision}</span>
                        <span className="mwui-subrow-tail">{formatDateTime(decision.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
            </div>
          ))}
        </div>
      )}

      {/* Withdrawal is the counterpart of an edit: it removes the memory from recall and keeps the
          history. It is offered only on the live revision and opens its own confirmation window. */}
      {detail.isCurrent
        ? (
          <div>
            <h4 className="mwui-section-title">{translate(language, 'detail.manage')}</h4>
            <div className="mwui-edit-actions">
              <button type="button" className="mwui-button" onClick={props.onBeginWithdraw}>
                {translate(language, 'detail.withdraw')}
              </button>
            </div>
          </div>
        )
        : null}
    </div>
  );
}

/**
 * The edit form, shown in a window over the detail panel.
 *
 * It is the same form the panel used to host inline; the panel itself now stays read-only, so the
 * memory under edit keeps its content, revisions and scroll position visible behind the window.
 */
interface EditFormProps {
  detail: UiMemoryDetail;
  language: Language;
  draft: string;
  reason: string;
  saving: boolean;
  action: string | null;
  /** Queued or unconfirmed: the save button stays disabled until the outcome is known. */
  pending: boolean;
  /** The draft's base is the text the editor opened with, not necessarily the latest. */
  baseContent: string | null;
  /** True when the latest revision differs from the draft's base, so a rebase is meaningful. */
  canRebase: boolean;
  /** Classification edits; empty string means inherit the previous revision. */
  categoryChoice: string;
  importanceChoice: string;
  tagsDraft: string;
  onChangeDraft(value: string): void;
  onChangeReason(value: string): void;
  onChangeCategory(value: string): void;
  onChangeImportance(value: string): void;
  onChangeTags(value: string): void;
  onSave(): void;
  onCancel(): void;
  onRebase(): void;
}

function MemoryEditForm(props: EditFormProps): JSX.Element {
  const { detail, language, draft, reason, saving, action, baseContent, canRebase } = props;
  return (
    <div className="mwui-edit">
      {action === null ? null : <div className="mwui-inline-notice">{action}</div>}
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
      {/* Classification is optional. "Inherit" leaves the field out, so the new revision keeps
          what the previous one recorded instead of clearing it. */}
      <div className="mwui-classify">
        <label className="mwui-classify-field">
          <span>{translate(language, 'detail.category')}</span>
          <select
            className="mwui-input mwui-select"
            value={props.categoryChoice}
            onChange={event => props.onChangeCategory(event.target.value)}
          >
            <option value="">{translate(language, 'detail.inherit')}</option>
            {CATEGORY_VALUES.map(value => (
              <option key={value} value={value}>{translate(language, `category.${value}` as MessageKey)}</option>
            ))}
          </select>
        </label>
        <label className="mwui-classify-field">
          <span>{translate(language, 'detail.importance')}</span>
          <select
            className="mwui-input mwui-select"
            value={props.importanceChoice}
            onChange={event => props.onChangeImportance(event.target.value)}
          >
            <option value="">{translate(language, 'detail.inherit')}</option>
            {[1, 2, 3, 4, 5].map(value => <option key={value} value={String(value)}>{value}/5</option>)}
          </select>
        </label>
      </div>
      <input
        className="mwui-input"
        type="text"
        value={props.tagsDraft}
        placeholder={translate(language, 'detail.tagsPlaceholder')}
        aria-label={translate(language, 'detail.tags')}
        onChange={event => props.onChangeTags(event.target.value)}
      />
      <div className="mwui-edit-hint" data-tone={draft.trim() === '' ? 'warn' : 'muted'}>
        {translate(language, 'detail.emptyContent')} · {utf8Bytes(draft)}/{EDIT_LIMIT_BYTES} B
      </div>
      {/* The draft is measured against the base it opened with, not against the live text. */}
      {canRebase
        ? (
          <div className="mwui-inline-notice" data-tone="warn">
            <div>{translate(language, 'detail.baseMoved')}</div>
            <button type="button" className="mwui-button mwui-mini" onClick={props.onRebase} disabled={saving}>
              {translate(language, 'detail.useLatestBase')}
            </button>
          </div>
        )
        : null}
      {/* What the draft was based on, and what the memory says now. The draft itself is the
          textarea above, so the user compares against both. */}
      {canRebase && baseContent !== null
        ? (
          <div className="mwui-compare mwui-compare-3">
            <div className="mwui-compare-col">
              <div className="mwui-compare-head">{translate(language, 'detail.openedVersion')}</div>
              <div className="mwui-content mwui-scroll">{baseContent === '' ? '—' : baseContent}</div>
            </div>
            <div className="mwui-compare-col">
              <div className="mwui-compare-head">{translate(language, 'detail.latestVersion')}</div>
              <div className="mwui-content mwui-scroll">{detail.content === '' ? '—' : detail.content}</div>
            </div>
          </div>
        )
        : null}
      <div className="mwui-edit-actions">
        <button
          type="button"
          className="mwui-button"
          data-variant="primary"
          onClick={props.onSave}
          disabled={saving || props.pending || editBlocker(draft, baseContent ?? detail.content) !== null}
        >
          {saving ? translate(language, 'detail.saving') : translate(language, props.pending ? 'detail.submitPaused' : 'detail.save')}
        </button>
        <button type="button" className="mwui-button" onClick={props.onCancel} disabled={saving}>
          {translate(language, 'detail.cancel')}
        </button>
      </div>
    </div>
  );
}

/** The withdrawal confirmation, also a window of its own. */
interface WithdrawFormProps {
  language: Language;
  reason: string;
  saving: boolean;
  action: string | null;
  onChangeReason(value: string): void;
  onConfirm(): void;
  onCancel(): void;
}

function MemoryWithdrawForm(props: WithdrawFormProps): JSX.Element {
  const { language, reason, saving, action } = props;
  return (
    <div className="mwui-edit">
      <input
        className="mwui-input"
        type="text"
        value={reason}
        placeholder={translate(language, 'detail.withdrawReasonPlaceholder')}
        aria-label={translate(language, 'detail.withdrawReason')}
        onChange={event => props.onChangeReason(event.target.value)}
      />
      <div className="mwui-edit-hint" data-tone="muted">{translate(language, 'detail.withdrawHint')}</div>
      {action === null ? null : <div className="mwui-inline-notice">{action}</div>}
      <div className="mwui-edit-actions">
        <button
          type="button"
          className="mwui-button"
          data-variant="danger"
          onClick={props.onConfirm}
          disabled={reason.trim() === '' || saving}
        >
          {translate(language, 'detail.withdrawConfirm')}
        </button>
        <button type="button" className="mwui-button" onClick={props.onCancel} disabled={saving}>
          {translate(language, 'detail.cancel')}
        </button>
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
  /**
   * The formal-memory page's own view. Content is the working view of this store: dsh-mnemon's
   * overview leads because it manages memory spaces, and this store has none to manage.
   */
  const [memoryView, setMemoryView] = useState<MemoryView>('content');
  const [rules, setRules] = useState<UiRule[] | null | undefined>(undefined);
  const [ruleUsage, setRuleUsage] = useState<UiRuleUsage | null | undefined>(undefined);
  const [archives, setArchives] = useState<UiArchive[] | null | undefined>(undefined);
  const [archiveCapacities, setArchiveCapacities] = useState<UiArchiveCapacity[] | null | undefined>(undefined);
  const [archiveHistory, setArchiveHistory] = useState<UiArchiveHistory[] | null | undefined>(undefined);
  const [sync, setSync] = useState<UiSyncStatus | null | undefined>(undefined);
  /** Provider embedding coverage; undefined while loading, null when the read failed. */
  const [diagnostics, setDiagnostics] = useState<UiEmbeddingDiagnostics | null | undefined>(undefined);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [archivesError, setArchivesError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncPass, setSyncPass] = useState<UiSyncPass | null>(null);
  const [ruleId, setRuleId] = useState<string | null>(null);
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const [list, setList] = useState<UiMemoryList | null>(null);
  /** Failure of the most recent page load; the rows already shown are kept. */
  const [listError, setListError] = useState<string | null>(null);
  const [detail, setDetail] = useState<UiMemoryDetail | null>(null);
  const [query, setQuery] = useState('');
  /** Classification filter; empty means every category. */
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  /** Entity filter; empty means every entity. */
  const [entityFilter, setEntityFilter] = useState<string>('');
  /** Scan order; changing it restarts the scan, because a cursor belongs to one order. */
  const [sort, setSort] = useState<ListSort>('newest');
  /**
   * The management page's project: undefined shows every project, null shows general memory,
   * a string shows that project. This is not the conversation's project; it only narrows this
   * page's queries and edits.
   */
  const [projectFilter, setProjectFilter] = useState<string | null | undefined>(undefined);
  /** Projects known to the Server, used for the selector and the create form. */
  const [projects, setProjects] = useState<Array<{ projectId: string | null; count: number }>>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Which revision the detail panel is showing; undefined means the current one. */
  const [viewedRevisionId, setViewedRevisionId] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState<'id' | 'content' | null>(null);
  const [comparing, setComparing] = useState(false);
  const [currentContent, setCurrentContent] = useState<string | null>(null);
  /** Progress and outcome text for a save that is queued, confirming, or awaiting local apply. */
  const [editAction, setEditAction] = useState<string | null>(null);
  /**
   * The version and text the open draft is based on. Frozen when the editor opens so a background
   * detail refresh cannot move it; only an explicit rebase replaces it.
   */
  const [editBase, setEditBase] = useState<{ entryVersion: number; content: string } | null>(null);
  /** Classification edits: empty means inherit the previous revision, not "clear". */
  const [categoryChoice, setCategoryChoice] = useState('');
  const [importanceChoice, setImportanceChoice] = useState('');
  /** Comma-separated tags; only sent when the user changed the text. */
  const [tagsDraft, setTagsDraft] = useState('');
  /** Set when a save is queued or unconfirmed: resubmitting would duplicate one intent. */
  const [editPending, setEditPending] = useState(false);
  /** Semantic explore keeps its own query and result: it is a different search from the list. */
  /**
   * The relation graph, read once for the whole catalog. The formal-memory overview draws it, and
   * a memory's detail derives its neighbourhood from the same nodes and edges, so a selection does
   * not discard the read.
   */
  const [graph, setGraph] = useState<UiGraph | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  /**
   * Whether an attempt has been made, independent of whether it succeeded.
   *
   * The auto-load below keys on this, not on `graph === null`: a failed load leaves the graph
   * empty, so keying on emptiness would retry forever and hammer the Server with a request that
   * is already known to fail.
   */
  const [graphAttempted, setGraphAttempted] = useState(false);

  const loadGraph = useCallback(async (): Promise<void> => {
    setGraphLoading(true);
    setGraphError(null);
    try {
      const project = projectRef.current;
      setGraph(await api.graph({
        limit: 500,
        ...(project === undefined ? {} : project === null ? { includeGlobal: false } : { projectId: project, includeGlobal: true }),
      }));
    } catch (failure) {
      setGraphError(failureText(failure, language));
    } finally {
      setGraphLoading(false);
      setGraphAttempted(true);
    }
  }, [api, language]);

  // The overview has nothing to draw until the graph is loaded, so opening it fetches once. It is
  // not refetched on every view switch: the graph changes when memories do, and the explicit
  // reload button covers that.
  useEffect(() => {
    if (tab === 'memories' && memoryView === 'overview' && !graphAttempted && !graphLoading) void loadGraph();
  }, [tab, memoryView, graphAttempted, graphLoading, loadGraph]);

  /**
   * Entity index. Loaded with a one-row page: the index describes the whole visible set, so a
   * larger page would cost body reads without changing the answer.
   */
  const [entities, setEntities] = useState<Array<{ value: string; count: number }>>([]);
  const [entitiesQuery, setEntitiesQuery] = useState('');
  const [entitiesError, setEntitiesError] = useState<string | null>(null);
  const [entitiesLoading, setEntitiesLoading] = useState(false);
  const [exploreQuery, setExploreQuery] = useState('');
  const [explore, setExplore] = useState<UiExplore | null>(null);
  const [exploreError, setExploreError] = useState<string | null>(null);
  /**
   * Score floor and page size. The Provider scores unrelated text above zero, so a floor is what
   * makes a result an answer; and explore is a ranking with no cursor, so "more" means a larger
   * limit rather than an offset.
   */
  const [exploreMinScore, setExploreMinScore] = useState(0.5);
  const [exploreLimit, setExploreLimit] = useState(20);
  /**
   * Inline previews of relation targets, keyed by memory id. Following an edge used to mean
   * leaving the current memory; a preview lets the user read the other side first.
   */
  const [relatedPreviews, setRelatedPreviews] = useState<Record<string, { status: 'loading' | 'ready' | 'error'; content?: string; state?: string; detail?: string }>>({});
  /** Withdrawal is a separate confirm step because it changes what recall serves. */
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState('');
  const [busy, setBusy] = useState(false);
  /** Settings surface: loaded lazily when the settings tab is opened. */
  const [settings, setSettings] = useState<UiSettings | null>(null);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [connectionTest, setConnectionTest] = useState<UiConnectionTest | null>(null);
  const [wakeTest, setWakeTest] = useState<UiWakeTest | null>(null);
  /** Result of the settings page's one-time task registration; null before the first press. */
  const [registerTest, setRegisterTest] = useState<UiRegisterTest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const listRequest = useRef<AbortController | null>(null);

  useEffect(() => { ensureStyles(); }, []);

  // The selected archive's history is read on selection and refreshed after a state change.
  useEffect(() => {
    if (archiveId === null) { setArchiveHistory(undefined); return; }
    const controller = new AbortController();
    api.archiveHistory(archiveId, controller.signal)
      .then(items => { if (!controller.signal.aborted) setArchiveHistory(items); })
      .catch(() => { if (!controller.signal.aborted) setArchiveHistory(null); });
    return () => controller.abort();
  }, [api, archiveId]);

  const loadStatus = useCallback(async (signal?: AbortSignal): Promise<void> => {
    // The injection report is informational: a host that never injected, or a Server that
    // cannot answer, must not turn the whole status row into an error.
    const settle = async <T,>(promise: Promise<T>): Promise<{ value?: T; error?: string }> => {
      try { return { value: await promise }; } catch (error) { return { error: error instanceof RpcFailure ? error.code : 'RPC_FAILED' }; }
    };
    const [nextStatus, nextConfig, nextInjection, nextRules, nextRuleUsage, nextArchives, nextCapacities, nextSync] = await Promise.all([
      api.status(signal),
      api.config(signal),
      api.injection(signal).catch(() => null),
      settle(api.rules(signal)),
      settle(api.ruleUsage(signal)),
      settle(api.archives(signal)),
      settle(api.archiveCapacities(signal)),
      settle(api.sync(signal)),
    ]);
    setStatus(nextStatus);
    setConfig(nextConfig);
    setInjection(nextInjection);
    setRules(nextRules.value ?? null);
    setRulesError(nextRules.error ?? null);
    setRuleUsage(nextRuleUsage.value ?? null);
    setArchives(nextArchives.value ?? null);
    setArchivesError(nextArchives.error ?? null);
    setArchiveCapacities(nextCapacities.value ?? null);
    setSync(nextSync.value ?? null);
    setSyncError(nextSync.error ?? null);
  }, [api]);

  /**
   * Load one page. `append` continues the current list with the returned cursor; otherwise the
   * list is replaced. Scope and query travel together so a late response for an old filter can
   * be discarded rather than mixed into the new list.
   *
   * The page size is read through a ref so that arriving settings do not change this callback's
   * identity — that would re-run the search effect and fetch the first page a second time.
   */
  const pageSizeRef = useRef<number>(LIST_LIMIT);
  /** Read by `loadList` so changing the project does not change the callback's identity. */
  const projectRef = useRef<string | null | undefined>(undefined);
  const loadList = useCallback(async (options: { query: string; category?: string; entity?: string; sort?: ListSort; cursor?: string; append: boolean }, signal?: AbortSignal): Promise<void> => {
    const project = projectRef.current;
    const page = await api.memories({
      ...(options.query.trim() === '' ? {} : { query: options.query.trim() }),
      limit: pageSizeRef.current,
      ...(options.category === undefined || options.category === '' ? {} : { category: options.category }),
      ...(options.entity === undefined || options.entity === '' ? {} : { entity: options.entity }),
      ...(options.sort === undefined ? {} : { sort: options.sort }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      // A project view keeps general knowledge; the general view is expressed as
      // includeGlobal=false with no project id.
      ...(project === undefined ? {} : project === null ? { includeGlobal: false } : { projectId: project, includeGlobal: true }),
    }, signal);
    setList(current => {
      if (!options.append || current === null) return page;
      return { ...page, items: [...current.items, ...page.items], returned: current.returned + page.returned };
    });
  }, [api]);

  const loadDetail = useCallback(async (memoryId: string, revisionId?: string, signal?: AbortSignal): Promise<void> => {
    setDetail(await api.memory(memoryId, revisionId, signal));
  }, [api]);

  const loadCurrentContent = useCallback(async (memoryId: string, signal?: AbortSignal): Promise<void> => {
    const current = await api.memory(memoryId, undefined, signal);
    setCurrentContent(current.content);
  }, [api]);

  // Initial read: availability and the newest memories; the page loads only when opened.
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await Promise.all([loadStatus(controller.signal), loadList({ query: '', category: categoryFilter, entity: entityFilter, sort, append: false }, controller.signal)]);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failureText(failure, language));
      } finally {
        if (!controller.signal.aborted) { setBusy(false); setNow(Date.now()); }
      }
    })();
    return () => controller.abort();
  }, [loadStatus, loadList, language]);

  // Debounced search and filter changes share one path: the previous request is aborted so a
  // late result for the old filter cannot land in the new list.
  const firstSearch = useRef(true);
  useEffect(() => {
    if (firstSearch.current) { firstSearch.current = false; return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      listRequest.current?.abort();
      listRequest.current = controller;
      setListError(null);
      void (async () => {
        try {
          setError(null);
          await loadList({ query, category: categoryFilter, entity: entityFilter, sort, append: false }, controller.signal);
        } catch (failure) {
          // Keep whatever was already loaded; the retry lives at the end of the list.
          if (!controller.signal.aborted) setListError(failureText(failure, language));
        }
      })();
    }, 280);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, categoryFilter, entityFilter, sort, projectFilter, loadList, language]);

  // The project index travels with every list read, so the selector keeps its counts current.
  useEffect(() => {
    if (list?.projects !== undefined) setProjects(list.projects);
  }, [list]);

  // Embedding coverage is a Provider fact, read once per page open; the settings card shows it.
  useEffect(() => {
    const controller = new AbortController();
    void api.embeddingDiagnostics(controller.signal).then(setDiagnostics, () => setDiagnostics(null));
    return () => controller.abort();
  }, [api]);

  useEffect(() => {
    if (selectedId === null) return;
    const controller = new AbortController();
    setEditing(false);
    setDraft('');
    setReason('');
    setNotice(null);
    setComparing(false);
    setCurrentContent(null);
    setViewedRevisionId(undefined);
    setEditBase(null);
    setEditPending(false);
    setEditAction(null);
    setRelatedPreviews({});
    void (async () => {
      try {
        setError(null);
        await loadDetail(selectedId, undefined, controller.signal);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failureText(failure, language));
      }
    })();
    return () => controller.abort();
  }, [selectedId, loadDetail, language]);

  /** Switch the detail to a specific revision, or back to the current one. */
  const selectRevision = useCallback((revisionId: string): void => {
    if (selectedId === null) return;
    const controller = new AbortController();
    setViewedRevisionId(revisionId);
    setEditing(false);
    setDraft('');
    setReason('');
    void (async () => {
      try {
        setError(null);
        await loadDetail(selectedId, revisionId, controller.signal);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failureText(failure, language));
      }
    })();
  }, [selectedId, loadDetail, language]);

  const backToCurrent = useCallback((): void => {
    if (selectedId === null) return;
    setViewedRevisionId(undefined);
    setComparing(false);
    setCurrentContent(null);
    setEditing(false);
    void (async () => {
      try {
        setError(null);
        await loadDetail(selectedId, undefined);
      } catch (failure) { setError(failureText(failure, language)); }
    })();
  }, [selectedId, loadDetail, language]);

  const toggleCompare = useCallback((): void => {
    if (detail === null) return;
    if (comparing) { setComparing(false); setCurrentContent(null); return; }
    setComparing(true);
    void loadCurrentContent(detail.memoryId).catch(failure => {
      setComparing(false);
      setError(failureText(failure, language));
    });
  }, [comparing, detail, loadCurrentContent, language]);

  /** Continue the current list from its cursor; failures keep the rows already shown. */
  const loadMore = useCallback((): void => {
    if (list?.nextCursor === undefined) return;
    const controller = new AbortController();
    listRequest.current?.abort();
    listRequest.current = controller;
    setListError(null);
    void loadList({ query, category: categoryFilter, entity: entityFilter, sort, cursor: list.nextCursor, append: true }, controller.signal)
      .catch(failure => { if (!controller.signal.aborted) setListError(failureText(failure, language)); });
  }, [list, query, categoryFilter, entityFilter, sort, loadList, language]);

  /**
   * Creation form. Opened explicitly, and closed on success; the draft is kept while open so a
   * failed publish does not cost the user their text.
   */
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createDraft, setCreateDraft] = useState<CreateDraft>(EMPTY_CREATE_DRAFT);

  /** 「整理记忆」: a natural-language instruction plus the scope it may act on. */
  const [organizing, setOrganizing] = useState(false);
  const [organizeInstruction, setOrganizeInstruction] = useState('');
  const [organizeScope, setOrganizeScope] = useState<string | null>(null);
  const [organizeBusy, setOrganizeBusy] = useState(false);
  const [organizeError, setOrganizeError] = useState<string | null>(null);
  const [organizeItems, setOrganizeItems] = useState<UiOrganizeItem[] | null>(null);
  /** Skills DSH can load; read when the skills tab opens. */
  const [skillsReport, setSkillsReport] = useState<UiSkillReport | null>(null);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<{ name: string; path: string; hash: string } | null>(null);
  const [skillVersionsState, setSkillVersionsState] = useState<UiSkillVersion[]>([]);
  const [skillBusy, setSkillBusy] = useState(false);
  const [skillNotice, setSkillNotice] = useState<string | null>(null);
  const [autoAdopt, setAutoAdopt] = useState(false);
  const [trashEntries, setTrashEntries] = useState<UiTrashEntry[]>([]);
  const [skillDiff, setSkillDiff] = useState<{ versionId: string; lines: DiffLine[] } | null>(null);
  const [skillDrafts, setSkillDrafts] = useState<UiSkillDraft[]>([]);
  const [loadedDraft, setLoadedDraft] = useState<UiSkillDraft | null>(null);

  /**
   * Publish a new memory. The Server treats this as already-confirmed user knowledge, so there is
   * no review step to wait for — only the publisher's write.
   */
  const submitCreate = useCallback(async (organize = false): Promise<void> => {
    if (createDraft.content.trim() === '' || saving) return;
    setSaving(true);
    setCreateError(null);
    try {
      const input: Parameters<typeof api.create>[0] = {
        content: createDraft.content,
        knowledgeType: createDraft.knowledgeType,
        ...(createDraft.category === '' ? {} : { category: createDraft.category }),
        ...(createDraft.importance === '' ? {} : { importance: Number(createDraft.importance) }),
        ...(toList(createDraft.tags).length === 0 ? {} : { tags: toList(createDraft.tags) }),
        ...(toList(createDraft.entities).length === 0 ? {} : { entities: toList(createDraft.entities) }),
        ...(createDraft.projectId === '' ? {} : { projectId: createDraft.projectId }),
        ...(createDraft.reason.trim() === '' ? {} : { reason: createDraft.reason.trim() }),
      };
      const result = organize
        ? await api.organizeMemory(input)
        : { kind: 'formal' as const, entryId: (await api.create(input)).memoryId };
      if (result.kind === 'review' || result.kind === 'duplicate') {
        setCreateError(result.kind === 'review' ? result.reason : translate(language, 'create.duplicate'));
        return;
      }
      setCreating(false);
      setCreateDraft(EMPTY_CREATE_DRAFT);
      setNotice(translate(language, 'create.created'));
      if (result.kind === 'formal') {
        await loadList({ query, category: categoryFilter, entity: entityFilter, sort, append: false });
        setMemoryView('content');
        setSelectedId(result.entryId);
      } else if (result.kind === 'runtime') {
        await Promise.all([api.rules(), api.ruleUsage()]).then(([items, usage]) => { setRules(items); setRuleUsage(usage); setRulesError(null); },
          failure => { setRules(null); setRulesError(failureText(failure, language)); });
      } else {
        await Promise.all([api.archives(), api.archiveCapacities()]).then(([items, capacities]) => { setArchives(items); setArchiveCapacities(capacities); setArchivesError(null); },
          failure => { setArchives(null); setArchivesError(failureText(failure, language)); });
        setArchiveId(result.entryId);
      }
    } catch (failure) {
      setCreateError(failureText(failure, language));
    } finally {
      setSaving(false);
    }
  }, [api, createDraft, saving, language, query, categoryFilter, entityFilter, sort, loadList]);

  const loadSkills = useCallback(async (): Promise<void> => {
    try {
      setSkillsReport(await api.skillsList({}));
      setSkillsError(null);
    } catch (failure) {
      setSkillsReport(null);
      setSkillsError(failureText(failure, language));
    }
  }, [api, language]);
  useEffect(() => {
    if (tab !== 'skills' || skillsReport !== null) return;
    void loadSkills();
    void api.skillPreferences().then(preferences => setAutoAdopt(preferences.autoAdopt), () => undefined);
    void api.skillTrashList().then(setTrashEntries, () => undefined);
    void api.skillDrafts({}).then(setSkillDrafts, () => undefined);
  }, [tab, skillsReport, loadSkills, api]);

  const adoptSkillDraft = useCallback(async (candidate: string): Promise<void> => {
    if (selectedSkill === null) return;
    try {
      await api.skillAdopt({ path: selectedSkill.path, candidate, baselineHash: selectedSkill.hash });
      setSkillsError(null);
      setNotice(translate(language, 'skills.adopted'));
      setSkillsReport(null);
      setSelectedSkill(null);
      await loadSkills();
    } catch (failure) {
      setSkillsError(failureText(failure, language));
    }
  }, [api, selectedSkill, language, loadSkills]);

  const selectSkill = useCallback(async (entry: UiSkillEntry): Promise<void> => {
    setSelectedSkill({ name: entry.name, path: entry.path, hash: entry.hash });
    setSkillNotice(null);
    setSkillDiff(null);
    try { setSkillVersionsState(await api.skillVersions({ path: entry.path })); }
    catch (failure) { setSkillsError(failureText(failure, language)); }
  }, [api, language]);

  const reloadSkills = useCallback(async (path: string): Promise<void> => {
    const report = await api.skillsList({});
    setSkillsReport(report);
    const fresh = report.items.find(item => item.path === path);
    if (fresh === undefined) { setSelectedSkill(null); setSkillVersionsState([]); return; }
    setSelectedSkill({ name: fresh.name, path: fresh.path, hash: fresh.hash });
    setSkillVersionsState(await api.skillVersions({ path: fresh.path }));
  }, [api]);

  const restoreSkillVersion = useCallback(async (versionId: string): Promise<void> => {
    if (selectedSkill === null) return;
    setSkillBusy(true);
    try {
      await api.skillRestore({ path: selectedSkill.path, versionId, baselineHash: selectedSkill.hash });
      setSkillNotice(translate(language, 'skills.restored'));
      await reloadSkills(selectedSkill.path);
    } catch (failure) {
      setSkillsError(failureText(failure, language));
    } finally { setSkillBusy(false); }
  }, [api, selectedSkill, language, reloadSkills]);

  const createSkillFile = useCallback(async (input: { root: string; name: string; description: string }): Promise<void> => {
    setSkillBusy(true);
    try {
      const created = await api.skillCreate(input);
      setSkillNotice(translate(language, 'skills.created'));
      await reloadSkills(created.path);
    } catch (failure) {
      setSkillsError(failureText(failure, language));
    } finally { setSkillBusy(false); }
  }, [api, language, reloadSkills]);

  const trashSkillFile = useCallback(async (path: string): Promise<void> => {
    setSkillBusy(true);
    try {
      await api.skillTrash({ path });
      setSkillNotice(translate(language, 'skills.trashed'));
      setSelectedSkill(null);
      await loadSkills();
      setTrashEntries(await api.skillTrashList());
    } catch (failure) {
      setSkillsError(failureText(failure, language));
    } finally { setSkillBusy(false); }
  }, [api, language, loadSkills]);

  const adoptStoredDraftEntry = useCallback(async (draft: UiSkillDraft): Promise<void> => {
    if (draft.skillPath === null) return;
    setSkillBusy(true);
    try {
      const current = await api.skillRead({ path: draft.skillPath });
      await api.skillAdoptDraft({ id: draft.id, baselineHash: current.hash });
      setSkillNotice(translate(language, 'skills.draftAdoptedNow'));
      setSkillDrafts(await api.skillDrafts({}));
      await reloadSkills(draft.skillPath);
    } catch (failure) {
      setSkillsError(failureText(failure, language));
    } finally { setSkillBusy(false); }
  }, [api, language, reloadSkills]);

  const dismissSkillDraftEntry = useCallback(async (id: string): Promise<void> => {    try { await api.skillDismissDraft({ id }); setSkillDrafts(await api.skillDrafts({})); }
    catch (failure) { setSkillsError(failureText(failure, language)); }
  }, [api, language]);

  const compareSkillVersion = useCallback(async (versionId: string): Promise<void> => {    if (selectedSkill === null) return;
    setSkillBusy(true);
    try {
      const [current, version] = await Promise.all([
        api.skillRead({ path: selectedSkill.path }),
        api.skillVersionText({ path: selectedSkill.path, versionId }),
      ]);
      setSkillDiff({ versionId, lines: diffLines(current.text, version.text) });
    } catch (failure) {
      setSkillsError(failureText(failure, language));
    } finally { setSkillBusy(false); }
  }, [api, selectedSkill, language]);

  const restoreTrashEntry = useCallback(async (id: string): Promise<void> => {
    setSkillBusy(true);
    try {
      await api.skillTrashRestore({ id });
      setSkillNotice(translate(language, 'skills.restoredTrash'));
      await loadSkills();
      setTrashEntries(await api.skillTrashList());
    } catch (failure) {
      setSkillsError(failureText(failure, language));
    } finally { setSkillBusy(false); }
  }, [api, language, loadSkills]);

  const beginOrganize = useCallback((): void => {    setOrganizeInstruction('');
    // The page's current project filter is the default scope; "all projects" is not a scope the
    // task can act in, so it falls back to general memory.
    setOrganizeScope(typeof projectFilter === 'string' ? projectFilter : null);
    setOrganizeItems(null);
    setOrganizeError(null);
    setOrganizing(true);
  }, [projectFilter]);

  const runOrganize = useCallback(async (): Promise<void> => {
    const instruction = organizeInstruction.trim();
    if (instruction === '' || organizeBusy) return;
    setOrganizeBusy(true);
    setOrganizeError(null);
    try {
      const result = await api.organizeMemories({ instruction, ...(organizeScope === null ? {} : { projectId: organizeScope }) });
      setOrganizeItems(result.items);
      await loadList({ query, category: categoryFilter, entity: entityFilter, sort, append: false });
    } catch (failure) {
      setOrganizeError(failureText(failure, language));
    } finally {
      setOrganizeBusy(false);
    }
  }, [api, organizeInstruction, organizeBusy, organizeScope, query, categoryFilter, entityFilter, sort, loadList, language]);

  /**
   * Rule writes use the same identity as memory writes: the service token plus this Host. The
   * list is reloaded before resolving so the panel never shows a stale body next to a new
   * version number.
   */
  const submitRule = useCallback(async (draft: RuleDraft): Promise<void> => {
    try {
      const created = await api.createRule({
        body: draft.body.trim(),
        enabled: draft.enabled,
        importance: draft.importance ?? 'normal',
        pinned: draft.pinned === true,
      });
      setNotice(translate(language, 'runtime.created'));
      await loadStatus();
      setRuleId(created.entryId);
    } catch (failure) {
      throw new Error(ruleFailure(failure, language));
    }
  }, [api, language, loadStatus]);

  const saveRule = useCallback(async (target: string, input: { body: string; enabled: boolean; importance: 'critical' | 'normal' | 'low'; pinned: boolean; baseVersion: number }): Promise<void> => {
    try {
      const updated = await api.editRule({
        ruleId: target, body: input.body.trim(), enabled: input.enabled,
        importance: input.importance, pinned: input.pinned, baseVersion: input.baseVersion,
      });
      setNotice(translate(language, 'runtime.saved'));
      await loadStatus();
      setRuleId(updated.entryId);
    } catch (failure) {
      // A stale base version means another writer moved the rule; reload so that reopening the
      // editor starts from the version that actually exists.
      if (failure instanceof RpcFailure && failure.code === 'VERSION_CONFLICT') await loadStatus();
      throw new Error(ruleFailure(failure, language));
    }
  }, [api, language, loadStatus]);

  const changeArchiveState = useCallback(async (entryId: string, state: 'active' | 'archived', baseVersion: number): Promise<void> => {
    const updated = await api.setArchiveState({ entryId, state, baseVersion });
    setArchives(previous => previous?.map(item => item.entryId === entryId ? updated : item));
    setNotice(translate(language, state === 'archived' ? 'archives.archive' : 'archives.restore'));
    const [capacities, history] = await Promise.all([
      api.archiveCapacities().catch(() => null),
      api.archiveHistory(entryId).catch(() => null),
    ]);
    if (capacities !== null) setArchiveCapacities(capacities);
    setArchiveHistory(history);
  }, [api, language]);

  /**
   * Load the entity index for the current filters. A one-row page is enough: the Server builds
   * the index from every visible memory, not from the page it is about to return.
   */
  const loadEntities = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setEntitiesLoading(true);
    setEntitiesError(null);
    try {
      const page = await api.memories({ limit: 1 }, signal);
      setEntities(page.entities ?? []);
    } catch (failure) {
      setEntitiesError(failureText(failure, language));
    } finally {
      setEntitiesLoading(false);
    }
  }, [api, language]);

  const refresh = useCallback((): void => {
    const controller = new AbortController();
    setBusy(true);
    setError(null);
    setNotice(null);
    void (async () => {
      try {
        await Promise.all([
          loadStatus(controller.signal),
          loadList({ query, category: categoryFilter, entity: entityFilter, sort, append: false }, controller.signal),
          loadEntities(controller.signal),
          ...(selectedId === null ? [] : [loadDetail(selectedId, viewedRevisionId, controller.signal)]),
        ]);
        setNow(Date.now());
      } catch (failure) {
        setError(failureText(failure, language));
      } finally { setBusy(false); }
    })();
  }, [loadStatus, loadList, loadDetail, loadEntities, query, categoryFilter, entityFilter, sort, selectedId, viewedRevisionId, language]);

  const beginEdit = useCallback((): void => {
    if (detail === null) return;
    setEditing(true);
    setDraft(detail.content);
    setReason('');
    setError(null);
    setNotice(null);
    setEditAction(null);
    // The base is frozen here. A background refresh of the detail must not silently move it:
    // submitting against a newer version would overwrite someone else's change without the
    // explicit merge the conflict path is supposed to force.
    setEditBase({ entryVersion: detail.entryVersion, content: detail.content });
    // Classification starts as "inherit": the form shows what the revision has, and only a
    // deliberate change is sent, so an untouched field cannot clear it.
    const revision = detail.revisions.find(item => item.revisionId === detail.revisionId);
    setCategoryChoice('');
    setImportanceChoice('');
    setTagsDraft((revision?.tags ?? []).join(', '));
  }, [detail]);

  const cancelEdit = useCallback((): void => {
    setEditing(false);
    setDraft('');
    setReason('');
    setEditBase(null);
    setEditPending(false);
    setEditAction(null);
    setRelatedPreviews({});
  }, []);

  /**
   * Take the latest revision as the new base. This is the only path that moves a draft onto a
   * newer version, and it is an explicit user action: the plan requires a merge decision rather
   * than a silent rebase on the next click.
   */
  const rebaseToLatest = useCallback((): void => {
    if (detail === null) return;
    setEditBase({ entryVersion: detail.entryVersion, content: detail.content });
    setEditPending(false);
    setEditAction(translate(language, 'detail.rebased'));
  }, [detail, language]);

  /**
   * Save the edit through the Host RPC.
   *
   * The base version is the one captured when the editor opened (`editBase`), not whatever the
   * detail currently shows. Re-reading the detail after a conflict therefore cannot move the
   * base: a second click re-submits against the same stale version and is refused again, until
   * the user explicitly takes the newer base through `rebaseToLatest`.
   *
   * A save that is queued or unconfirmed also pauses the button: repeating it would create a
   * second change for one intent.
   */
  const save = useCallback(async (): Promise<void> => {
    if (detail === null || saving || editBase === null) return;
    // Pending states pause resubmission until the page learns the outcome.
    if (editPending) return;
    const blocker = editBlocker(draft, editBase.content);
    if (blocker !== null) {
      setError(translate(language, blocker === 'empty' ? 'detail.emptyContent' : blocker === 'tooLong' ? 'detail.tooLong' : 'detail.unchanged'));
      return;
    }
    // Tags are only sent when the text changed, so an untouched field keeps the existing ones.
    const previousTags = (detail.revisions.find(item => item.revisionId === detail.revisionId)?.tags ?? []).join(', ');
    const tagsChanged = tagsDraft !== previousTags;
    const controller = new AbortController();
    setSaving(true);
    setError(null);
    setNotice(null);
    setEditAction(null);
    try {
      const result = await api.edit({
        memoryId: detail.memoryId,
        content: draft,
        entryVersion: editBase.entryVersion,
        ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
        // Only what the user actually set; omitted fields are inherited by the new revision.
        ...(categoryChoice === '' ? {} : { category: categoryChoice }),
        ...(importanceChoice === '' ? {} : { importance: Number(importanceChoice) }),
        ...(tagsChanged
          ? { tags: tagsDraft.split(',').map(tag => tag.trim()).filter(tag => tag !== '') }
          : {}),
      }, controller.signal);
      setEditing(false);
      setDraft('');
      setReason('');
      setEditBase(null);
      setViewedRevisionId(result.revisionId);
      // Read the revision the Server reported instead of assuming the newest one is ours.
      await loadDetail(detail.memoryId, result.revisionId, controller.signal);
      await loadList({ query, category: categoryFilter, entity: entityFilter, sort, append: false }, controller.signal);
      setNotice(translate(language, 'detail.saved'));
      setNow(Date.now());
    } catch (failure) {
      if (controller.signal.aborted) return;
      const code = failure instanceof RpcFailure ? failure.code : null;
      // The draft and the frozen base stay on screen either way; the message explains why.
      if (code === 'VERSION_CONFLICT') {
        setEditAction(translate(language, 'detail.conflict'));
        // Fetch the latest text for the comparison only. The base is deliberately untouched.
        void loadDetail(detail.memoryId, undefined, controller.signal)
          .then(() => loadCurrentContent(detail.memoryId, controller.signal))
          .catch(() => undefined);
      } else if (code === 'SYNC_QUEUED') {
        setEditPending(true);
        setEditAction(translate(language, 'detail.queued'));
      } else if (code === 'SYNC_OUTCOME_UNKNOWN') {
        setEditPending(true);
        setEditAction(translate(language, 'detail.awaitingConfirm'));
      } else if (code === 'NEEDS_REVIEW') {
        setEditPending(true);
        setEditAction(translate(language, 'detail.awaitingApply'));
      } else {
        setError(failureText(failure, language));
      }
    } finally {
      setSaving(false);
    }
  }, [api, detail, draft, reason, saving, language, loadDetail, loadList, loadCurrentContent, query, categoryFilter, categoryChoice, importanceChoice, tagsDraft]);

  const retry = useCallback((): void => {
    refresh();
  }, [refresh]);

  /**
   * Navigation is unobstructed: a create or edit form lives in a window over the page, and the
   * window asks before closing with unsubmitted content.
   */
  const selectMemory = useCallback((memoryId: string): void => {
    setSelectedId(memoryId);
  }, []);

  /**
   * Change the management page's project. The ref is updated before React renders so the next
   * list read already carries the new filter; the debounced search effect then reloads.
   */
  const changeProject = useCallback((next: string | null | undefined): void => {
    projectRef.current = next;
    setProjectFilter(next);
  }, []);

  const changeTab = useCallback((next: Tab): void => {
    setTab(next);
  }, []);

  /** Switch the formal-memory page's view. */
  const changeMemoryView = useCallback((next: MemoryView): void => {
    if (next === memoryView) return;
    setMemoryView(next);
  }, [memoryView]);

  /** Open a memory that another view found, in the content view where its detail lives. */
  const openMemoryFromView = useCallback((memoryId: string): void => {
    setSelectedId(memoryId);
    setMemoryView('content');
  }, []);

  const beginCreate = useCallback((): void => {
    setCreateError(null);
    setCreating(true);
  }, []);

  const closeCreate = useCallback((): void => {
    setCreating(false);
    setCreateError(null);
    // Closing discards the draft: reopening starts empty rather than restoring a "discarded" text.
    setCreateDraft(EMPTY_CREATE_DRAFT);
  }, []);

  const copy = useCallback((kind: 'id' | 'content'): void => {
    if (detail === null || typeof navigator === 'undefined' || navigator.clipboard === undefined) return;
    const text = kind === 'id' ? detail.memoryId : detail.content;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(kind);
      setTimeout(() => setCopied(null), 1200);
    }).catch(() => undefined);
  }, [detail]);

  /** Follow a relation; an unreadable target is reported instead of showing an empty panel. */
  const openRelated = useCallback((memoryId: string): void => {
    setSelectedId(memoryId);
    void loadDetail(memoryId).catch(failure => {
      setError(`${translate(language, 'detail.relationUnreadable')}: ${failureText(failure, language)}`);
    });
  }, [loadDetail, language]);

  /**
   * Read a relation's target without leaving the current memory. The preview is fetched once per
   * target and cached, and a failure is shown in place so the edge is not silently dead.
   */
  const previewRelated = useCallback((memoryId: string): void => {
    setRelatedPreviews(current => ({ ...current, [memoryId]: { status: 'loading' } }));
    void api.memory(memoryId)
      .then(detail => {
        setRelatedPreviews(current => ({
          ...current,
          [memoryId]: { status: 'ready', content: detail.content, state: detail.state },
        }));
      })
      .catch(error => {
        setRelatedPreviews(current => ({
          ...current,
          [memoryId]: { status: 'error', detail: failureText(error, language) },
        }));
      });
  }, [api, language]);

  const chips = useMemo(() => [...statusChips(status, config, language, now), ...(status === null ? [] : [injectionChip(injection, language)])], [status, config, injection, language, now]);

  const sizeOf = (value: unknown): number | null => Array.isArray(value) ? value.length : null;
  const counts: Record<Tab, number | null> = {
    overview: null,
    memories: list === null ? null : list.items.length,
    runtime: sizeOf(rules),
    archives: sizeOf(archives),
    skills: null,
    settings: null,
  };

  /**
   * Load the settings surface once at start, so preferences such as the default tab and page
   * size are in effect for the first render rather than after a visit to the settings tab.
   */
  useEffect(() => {
    void api.settings()
      .then(next => {
        setSettings(next);
        // Applied before the first fetch uses it, without making the fetch depend on settings.
        pageSizeRef.current = next.interface.pageSize;
        setTab(current => (current === 'overview' && isTab(next.interface.defaultTab) ? next.interface.defaultTab : current));
      })
      .catch(() => {
        // A settings read failure must not block browsing: the page keeps its defaults.
      });
  }, [api]);

  /**
   * Run one group's save. A failure leaves the previous settings on screen: the page never shows
   * a value as saved when the Host rejected it.
   */
  const saveSettings = useCallback(async (write: () => Promise<UiSettings>): Promise<void> => {
    setBusy(true);
    setSettingsNotice(null);
    try {
      setSettings(await write());
      setSettingsNotice(translate(language, 'settings.saved'));
    } catch (failure) {
      setError(failureText(failure, language));
    } finally { setBusy(false); }
  }, [language]);

  const testConnection = useCallback(async (serverUrl: string): Promise<void> => {
    setBusy(true);
    setConnectionTest(null);
    try {
      setConnectionTest(await api.testConnection(serverUrl.trim() === '' ? {} : { serverUrl }));
    } catch (failure) {
      setError(failureText(failure, language));
    } finally { setBusy(false); }
  }, [api, language]);

  const testWake = useCallback(async (): Promise<void> => {
    setBusy(true);
    setWakeTest(null);
    try {
      setWakeTest(await api.testWake({}));
    } catch (failure) {
      setError(failureText(failure, language));
    } finally { setBusy(false); }
  }, [api, language]);

  /**
   * Register the scheduled task. This is the page's only action that may raise an elevation
   * prompt; it is never called from a connection probe.
   */
  const registerTask = useCallback(async (): Promise<void> => {
    setBusy(true);
    setRegisterTest(null);
    try {
      setRegisterTest(await api.registerTask());
      await loadStatus();
    } catch (failure) {
      setError(failureText(failure, language));
    } finally { setBusy(false); }
  }, [api, language, loadStatus]);

  /**
   * Withdraw the memory. The Server appends a withdrawal version and keeps every earlier revision
   * readable, so this is reversible in the sense that the history survives — not in the sense that
   * the memory comes back.
   */
  const withdraw = useCallback(async (): Promise<void> => {
    if (detail === null || saving) return;
    if (withdrawReason.trim() === '') {
      setError(translate(language, 'detail.withdrawReason'));
      return;
    }
    const controller = new AbortController();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.withdraw({
        memoryId: detail.memoryId,
        reason: withdrawReason.trim(),
        entryVersion: detail.entryVersion,
      }, controller.signal);
      setWithdrawing(false);
      setWithdrawReason('');
      await loadDetail(detail.memoryId, undefined, controller.signal);
      await loadList({ query, category: categoryFilter, entity: entityFilter, sort, append: false }, controller.signal);
      setNotice(translate(language, 'detail.withdrawn'));
      setNow(Date.now());
    } catch (failure) {
      if (controller.signal.aborted) return;
      const code = failure instanceof RpcFailure ? failure.code : null;
      // A stale base is the common case here: someone else edited while the panel was open.
      setEditAction(code === 'VERSION_CONFLICT' ? translate(language, 'detail.conflict') : translate(language, 'detail.withdrawFailed'));
      if (code === 'VERSION_CONFLICT') void loadDetail(detail.memoryId, undefined, controller.signal).catch(() => undefined);
      else setError(failureText(failure, language));
    } finally {
      setSaving(false);
    }
  }, [api, detail, saving, withdrawReason, language, loadDetail, loadList, query, categoryFilter]);

  const beginWithdraw = useCallback((): void => {
    setWithdrawing(true);
    setWithdrawReason('');
    setEditAction(null);
    setNotice(null);
  }, []);

  const cancelWithdraw = useCallback((): void => {
    setWithdrawing(false);
    setWithdrawReason('');
  }, []);


  /**
   * Run a semantic search. A failure keeps the previous result visible and reports the reason:   * an explore answer is not a page to blank out on one bad request.
   */
  const searchExplore = useCallback(async (options: { limit?: number } = {}): Promise<void> => {
    const text = exploreQuery.trim();
    if (text === '') return;
    // A new search starts at the default page size; "show more" is the only path that grows it.
    const limit = options.limit ?? 20;
    setBusy(true);
    setExploreError(null);
    try {
      setExploreLimit(limit);
      const project = projectRef.current;
      setExplore(await api.explore({
        query: text, limit, minScore: exploreMinScore,
        ...(project === undefined || project === null ? {} : { projectId: project }),
      }));
    } catch (failure) {
      setExploreError(failureText(failure, language));
    } finally {
      setBusy(false);
    }
  }, [api, exploreQuery, exploreMinScore, language]);

  const refreshSync = useCallback(async (): Promise<void> => {    setBusy(true);
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

  // A window closes only after the user confirms that unsubmitted content can be dropped.
  const createDirty = createDraft.content !== '' || createDraft.tags !== '' || createDraft.entities !== ''
    || createDraft.reason !== '' || createDraft.category !== ''
    || createDraft.importance !== '' || createDraft.knowledgeType !== 'Practice';
  const editTags = detail === null ? '' : (detail.revisions.find(item => item.revisionId === detail.revisionId)?.tags ?? []).join(', ');
  const editDirty = editing && editBase !== null && (
    draft !== editBase.content || reason.trim() !== '' || categoryChoice !== '' || importanceChoice !== '' || tagsDraft !== editTags
  );

  return (
    <div className="mwui-root">
      <header className="mwui-header">
        <div>
          <h1 className="mwui-title">{translate(language, 'page.title')}</h1>
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
          <button key={id} type="button" className="mwui-tab" data-active={tab === id ? 'true' : 'false'} onClick={() => changeTab(id)}>
            {translate(language, TAB_KEYS[id])}
            {counts[id] === null ? '' : ` ${counts[id]}`}
          </button>
        ))}
      </nav>

      {tab === 'memories' ? (
      <div className="mwui-memory">
        <MemoryPageHeader
          count={listSummary(list, language)}
          language={language}
          active={memoryView}
          creating={creating}
          saving={saving}
          projects={projects}
          project={projectFilter}
          onProject={changeProject}
          onSelect={changeMemoryView}
          onCreate={beginCreate}
          onOrganize={beginOrganize}
        />
      {memoryView === 'overview' ? (
        <MemoryOverviewPanel
          memories={list}
          entities={entities}
          graph={graph}
          graphLoading={graphLoading}
          graphError={graphError}
          focusId={selectedId}
          language={language}
          onReloadGraph={() => { void loadGraph(); }}
          onOpen={openMemoryFromView}
        />
      ) : memoryView === 'recall' ? (
        <ExplorePanel
          query={exploreQuery}
          result={explore}
          error={exploreError}
          busy={busy}
          language={language}
          minScore={exploreMinScore}
          limit={exploreLimit}
          onChangeQuery={setExploreQuery}
          onChangeMinScore={value => { setExploreMinScore(value); setExplore(null); }}
          onSearch={() => { void searchExplore(); }}
          onShowMore={() => { void searchExplore({ limit: Math.min(50, exploreLimit * 2) }); }}
          onOpen={openMemoryFromView}
        />
      ) : memoryView === 'entities' ? (
        <EntitiesPanel
          entities={entities}
          query={entitiesQuery}
          error={entitiesError}
          loading={entitiesLoading}
          language={language}
          active={entityFilter}
          onChangeQuery={setEntitiesQuery}
          onSelect={value => {
            // Applying the entity to the content list is the point of this view; moving there
            // keeps one results view instead of a second one that could drift from it.
            setEntityFilter(value);
            setMemoryView('content');
          }}
        />
      ) : (
      <>
      <div className="mwui-body" data-view={selectedId === null ? 'list' : 'detail'}>
        <section className="mwui-pane mwui-pane-list" aria-label={translate(language, 'list.title')}>
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
          {/* Only categories that exist are offered, so the picker cannot lead to an empty page. */}
          {list?.categories === undefined || list.categories.length === 0 ? null : (
            <div className="mwui-filter">
              <label className="mwui-filter-label" htmlFor="mwui-category">{translate(language, 'list.category')}</label>
              <select
                id="mwui-category"
                className="mwui-input mwui-select"
                value={categoryFilter}
                onChange={event => setCategoryFilter(event.target.value)}
              >
                <option value="">{translate(language, 'list.categoryAll')}</option>
                {list.categories.map(entry => (
                  <option key={entry.value} value={entry.value}>
                    {translate(language, `category.${entry.value}` as MessageKey)} ({entry.count})
                  </option>
                ))}
              </select>
            </div>
          )}
          {/* Entities are listed in their recorded spelling; matching is case-insensitive. */}
          {list?.entities === undefined || list.entities.length === 0 ? null : (
            <div className="mwui-filter">
              <label className="mwui-filter-label" htmlFor="mwui-entity">{translate(language, 'list.entity')}</label>
              <select
                id="mwui-entity"
                className="mwui-input mwui-select"
                value={entityFilter}
                onChange={event => setEntityFilter(event.target.value)}
              >
                <option value="">{translate(language, 'list.entityAll')}</option>
                {list.entities.map(entry => (
                  <option key={entry.value} value={entry.value}>{entry.value} ({entry.count})</option>
                ))}
              </select>
            </div>
          )}
          <div className="mwui-filter">
            <label className="mwui-filter-label" htmlFor="mwui-sort">{translate(language, 'list.sort')}</label>
            <select
              id="mwui-sort"
              className="mwui-input mwui-select"
              value={sort}
              onChange={event => setSort(event.target.value as ListSort)}
            >
              <option value="newest">{translate(language, 'list.sortNewest')}</option>
              <option value="oldest">{translate(language, 'list.sortOldest')}</option>
              <option value="importance">{translate(language, 'list.sortImportance')}</option>
            </select>
          </div>
          {/* Creating publishes straight to a formal memory; the page-level action starts the
              form in the content view rather than repeating the button in every filter row. */}
          <ul className="mwui-list">
            {list === null
              ? <li className="mwui-empty">{translate(language, 'list.loading')}</li>
              : list.items.length === 0
                ? <li className="mwui-empty">{listError === null ? translate(language, 'list.empty') : listError}</li>
                : list.items.map(item => (
                  <MemoryCard
                    key={item.memoryId}
                    item={item}
                    active={item.memoryId === selectedId}
                    language={language}
                    now={now}
                    onSelect={selectMemory}
                  />
                ))}
          </ul>
          {/* A failed page keeps the rows already shown; retry lives at the end of the list. */}
          {listError === null ? null : (
            <div className="mwui-inline-error" role="alert">
              <span>{listError}</span>
              <button type="button" className="mwui-button mwui-mini" onClick={loadMore}>{translate(language, 'toolbar.retry')}</button>
            </div>
          )}
          {list !== null && list.nextCursor !== undefined && listError === null
            ? <button type="button" className="mwui-button mwui-load-more" onClick={loadMore} disabled={busy}>
                {translate(language, 'list.loadMore')}
              </button>
            : null}
        </section>

        <section className="mwui-pane mwui-pane-detail" aria-label={translate(language, 'detail.title')}>
          <div className="mwui-pane-header">
            <span className="mwui-pane-title">{translate(language, 'detail.title')}</span>
            {/* Narrow screens show one pane at a time; this returns to the list with filter and
                selection intact, because both panes stay mounted. */}
            <button type="button" className="mwui-button mwui-mini mwui-back" onClick={() => setSelectedId(null)}>
              {translate(language, 'list.title')}
            </button>
          </div>
          {detail === null || detail.memoryId !== selectedId
            ? <div className="mwui-empty">{translate(language, 'detail.placeholder')}</div>
            : (
              <DetailView
                detail={detail}
                language={language}
                copied={copied}
                comparing={comparing}
                currentContent={currentContent}
                onBeginEdit={beginEdit}
                onBeginWithdraw={beginWithdraw}
                onCopy={copy}
                onSelectRevision={selectRevision}
                onBackToCurrent={backToCurrent}
                onToggleCompare={toggleCompare}
                onOpenRelated={openRelated}
                relatedPreviews={relatedPreviews}
                onPreviewRelated={previewRelated}
                neighbours={graph === null || detail === null ? [] : neighbourhood(graph, detail.memoryId, 2)}
                graphLoading={graphLoading}
                graphError={graphError}
                graphTruncated={graph !== null && graph.truncated}
                onLoadGraph={() => { void loadGraph(); }}
              />
            )}
        </section>
      </div>
      </>
      )}
      {organizing ? (
        <Modal
          title={translate(language, 'organize.title')}
          language={language}
          busy={organizeBusy}
          onClose={() => setOrganizing(false)}
        >
          <div className="mwui-form">
            <p className="mwui-edit-hint" data-tone="muted">{translate(language, 'organize.hint')}</p>
            <label className="mwui-field">
              <span>{translate(language, 'organize.instruction')}</span>
              <textarea
                className="mwui-input"
                rows={4}
                maxLength={2000}
                value={organizeInstruction}
                onChange={event => setOrganizeInstruction(event.target.value)}
              />
            </label>
            <label className="mwui-field">
              <span>{translate(language, 'organize.scope')}</span>
              <select
                className="mwui-input mwui-select"
                value={organizeScope ?? ''}
                onChange={event => setOrganizeScope(event.target.value === '' ? null : event.target.value)}
              >
                <option value="">{translate(language, 'organize.general')}</option>
                {projects.filter(entry => entry.projectId !== null).map(entry => (
                  <option key={entry.projectId!} value={entry.projectId!}>{entry.projectId!}</option>
                ))}
              </select>
            </label>
            {organizeError === null ? null : <div className="mwui-banner" data-tone="bad">{organizeError}</div>}
            {organizeItems === null ? null : (
              <ul className="mwui-list">
                {organizeItems.map(item => (
                  <li key={item.index} className="mwui-list-row">
                    <span className="mwui-mono">{item.action}</span>
                    <span>{translate(language, `organize.state.${item.state}` as MessageKey)}</span>
                    {item.targetId === undefined ? null : <span className="mwui-mono">{item.targetId}</span>}
                    {typeof item.detail?.['reason'] === 'string' ? <span className="mwui-muted">{item.detail['reason']}</span> : null}
                    {typeof item.detail?.['before'] === 'string' ? <span className="mwui-muted">{item.detail['before']}</span> : null}
                  </li>
                ))}
              </ul>
            )}
            <div className="mwui-actions">
              <button type="button" className="mwui-button" onClick={() => setOrganizing(false)}>
                {translate(language, 'organize.close')}
              </button>
              <button
                type="button"
                className="mwui-button"
                data-variant="primary"
                disabled={organizeBusy || organizeInstruction.trim() === ''}
                onClick={() => { void runOrganize(); }}
              >
                {translate(language, organizeBusy ? 'organize.running' : 'organize.run')}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
      {creating ? (
        <Modal
          title={translate(language, 'create.title')}
          language={language}
          busy={saving}
          dirty={createDirty}
          onClose={closeCreate}
        >
          <CreateMemoryForm
            draft={createDraft}
            busy={saving}
            error={createError}
            language={language}
            projects={projects}
            onChange={patch => setCreateDraft(current => ({ ...current, ...patch }))}
            onCancel={closeCreate}
            onSubmit={() => { void submitCreate(); }}
            onOrganize={() => { void submitCreate(true); }}
          />
        </Modal>
      ) : null}
      {editing && detail !== null ? (
        <Modal
          title={translate(language, 'detail.editTitle')}
          {...(editBase === null ? {} : { subtitle: `${translate(language, 'common.version')} v${editBase.entryVersion}` })}
          language={language}
          busy={saving}
          dirty={editDirty}
          onClose={cancelEdit}
        >
          <MemoryEditForm
            detail={detail}
            language={language}
            draft={draft}
            reason={reason}
            saving={saving}
            action={editAction}
            pending={editPending}
            baseContent={editBase?.content ?? null}
            canRebase={editBase !== null && detail.entryVersion !== editBase.entryVersion}
            categoryChoice={categoryChoice}
            importanceChoice={importanceChoice}
            tagsDraft={tagsDraft}
            onChangeDraft={setDraft}
            onChangeReason={setReason}
            onChangeCategory={setCategoryChoice}
            onChangeImportance={setImportanceChoice}
            onChangeTags={setTagsDraft}
            onSave={() => { void save(); }}
            onCancel={cancelEdit}
            onRebase={rebaseToLatest}
          />
        </Modal>
      ) : null}
      {withdrawing && detail !== null ? (
        <Modal
          title={translate(language, 'detail.withdraw')}
          language={language}
          busy={saving}
          dirty={withdrawReason.trim() !== ''}
          onClose={cancelWithdraw}
        >
          <MemoryWithdrawForm
            language={language}
            reason={withdrawReason}
            saving={saving}
            action={editAction}
            onChangeReason={setWithdrawReason}
            onConfirm={() => { void withdraw(); }}
            onCancel={cancelWithdraw}
          />
        </Modal>
      ) : null}
      </div>
      ) : tab === 'overview' ? (
        <OverviewPanel status={status} config={config} injection={injection} memories={list} rules={rules} archives={archives} sync={sync} language={language} now={now} onOpen={changeTab} />
      ) : tab === 'runtime' ? (
        <RuntimePanel rules={rules} usage={ruleUsage} error={rulesError} selected={ruleId} language={language} onSelect={setRuleId} onCreate={submitRule} onSave={saveRule} />
      ) : tab === 'archives' ? (
        <ArchivesPanel archives={archives} capacities={archiveCapacities} history={archiveHistory} error={archivesError} selected={archiveId} language={language} onSelect={setArchiveId} onSetState={changeArchiveState} onSave={async (draft, target) => {
          const saved = await api.saveArchive({ ...draft, ...(target ? { entryId: target.entryId, baseVersion: target.version } : {}) });
          setArchives(previous => previous?.some(item => item.entryId === saved.entryId)
            ? previous.map(item => item.entryId === saved.entryId ? saved : item)
            : [saved, ...(previous ?? [])]);
          setArchiveId(saved.entryId);
        }} />
      ) : tab === 'skills' ? (
        <>
          <SkillListPanel
            language={language}
            report={skillsReport}
            error={skillsError}
            onRefresh={() => { void loadSkills(); }}
            selected={selectedSkill?.path ?? null}
            onSelect={entry => { void selectSkill(entry); }}
            versions={skillVersionsState}
            roots={skillsReport?.roots}
            onRestore={versionId => { void restoreSkillVersion(versionId); }}
            onCreate={input => { void createSkillFile(input); }}
            busy={skillBusy}
            notice={skillNotice}
            autoAdopt={autoAdopt}
            trash={trashEntries}
            onTrash={path => { void trashSkillFile(path); }}
            onRestoreTrash={id => { void restoreTrashEntry(id); }}
            diff={skillDiff}
            onDiff={versionId => { void compareSkillVersion(versionId); }}
            drafts={skillDrafts}
            onDismissDraft={id => { void dismissSkillDraftEntry(id); }}
            onAdoptDraft={draft => { void adoptStoredDraftEntry(draft); }}
            onLoadDraft={draft => setLoadedDraft(draft)}
            onAutoAdoptChange={enabled => {
              setAutoAdopt(enabled);
              void api.setSkillAutoAdopt({ autoAdopt: enabled }).catch(failure => setSkillsError(failureText(failure, language)));
            }}
          />
          <SkillBacktestPanel
            language={language}
            run={api.skillBacktest}
            conversations={api.skillConversations}
            review={api.skillReview}
            selectedSkill={selectedSkill}
            onAdopt={candidate => { void adoptSkillDraft(candidate); }}
            loadedDraft={loadedDraft}
            onReviewed={(draft, workspace) => {
              void api.skillSaveDraft({
                workspace: workspace === '' ? '/unknown-workspace' : workspace,
                skillPath: selectedSkill?.path ?? null,
                reason: draft.reason, evidence: draft.evidence,
                baseline: draft.input.baseline, candidate: draft.input.candidate,
                scenario: draft.input.scenario, checks: draft.input.checks,
                report: draft.report ?? null, backtestError: draft.backtestError ?? null,
              }).then(() => api.skillDrafts({})).then(setSkillDrafts, () => undefined);
              if (selectedSkill === null || draft.report === undefined) return;
              void api.skillAutoAdopt({
                path: selectedSkill.path, candidate: draft.input.candidate, baselineHash: selectedSkill.hash,
                review: { report: draft.report, checks: draft.input.checks, completedAt: new Date().toISOString() },
              }).then(result => {
                if (!result.adopted) return;
                setSkillNotice(translate(language, 'skills.autoAdopted'));
                void reloadSkills(selectedSkill.path);
              }).catch(failure => setSkillsError(failureText(failure, language)));
            }}
          />
        </>
      ) : (
        settings === null
          ? <div className="mwui-empty">{translate(language, 'list.loading')}</div>
          : (
            <SettingsPanel
              settings={settings}
              language={language}
              busy={busy}
              notice={settingsNotice}
              connectionTest={connectionTest}
              wakeTest={wakeTest}
              registerTest={registerTest}
              sync={sync}
              syncError={syncError}
              syncPass={syncPass}
              diagnostics={diagnostics}
              onSaveInterface={patch => { void saveSettings(() => api.saveInterface(patch)); }}
              onSaveConnection={input => { void saveSettings(() => api.saveConnection(input)); }}
              onSaveInjection={input => { void saveSettings(() => api.saveInjection(input)); }}
              onSaveAutoStart={enabled => { void saveSettings(() => api.saveAutoStart(enabled)); }}
              onRegisterTask={() => { void registerTask(); }}
              onTestConnection={serverUrl => { void testConnection(serverUrl); }}
              onTestWake={() => { void testWake(); }}
              onRefreshSync={() => { void refreshSync(); }}
            />
          )
      )}

      <footer className="mwui-footer">
        <span>{translate(language, 'footer.note')}</span>
        <span className="mwui-spacer" />
        {config === null ? null : <span className="mwui-mono">{config.serverUrl}</span>}
      </footer>
    </div>
  );
}
