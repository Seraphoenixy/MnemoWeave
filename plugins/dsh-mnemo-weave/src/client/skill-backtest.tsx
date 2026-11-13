import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { SkillBacktestInput, SkillBacktestResult, SkillReviewResult, UiSkillDraft, UiSkillEntry, UiSkillReport, UiSkillVersion, UiTrashEntry } from '../shared/contract.ts';
import { diffSummary, type DiffLine } from '../shared/skills-diff.ts';
import { translate, type Language, type MessageKey } from './i18n.ts';

/**
 * The skills page: session review on the left, text backtest on the right.
 *
 * It uses the same chrome as every other page — a `mwui-body` of two `mwui-pane` sections with
 * `mwui-detail` inside — so its frame, controls and actions read like the rest of the page. The
 * form spans both panes because the review action drafts the fields the backtest side runs.
 */
export function SkillBacktestPanel({ language, run, conversations, review, selectedSkill, onAdopt, onReviewed, loadedDraft }: {
  language: Language;
  conversations(): Promise<{ id: string; workspace: string }[]>;
  review(input: { sessionId: string; baseline: string }, signal: AbortSignal): Promise<SkillReviewResult>;
  run(input: SkillBacktestInput, signal: AbortSignal): Promise<SkillBacktestResult>;
  selectedSkill?: { name: string; path: string; hash: string } | null;
  onAdopt?(candidate: string): void;
  onReviewed?(draft: Extract<SkillReviewResult, { kind: 'draft' }>, workspace: string): void;
  /** Fills the form from a stored draft so it can be re-run or edited. */
  loadedDraft?: UiSkillDraft | null;
}): ReactNode {
  const [result, setResult] = useState<{ checks: string[]; report: SkillBacktestResult }>();
  const [reviewResult, setReviewResult] = useState<SkillReviewResult>();
  const [sessions, setSessions] = useState<{ id: string; workspace: string }[]>([]);
  const [reviewError, setReviewError] = useState<string>();
  const [runError, setRunError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const editor = useRef<HTMLFormElement>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const form = editor.current;
    if (form === null || loadedDraft === undefined || loadedDraft === null) return;
    const values = {
      baseline: loadedDraft.baseline, candidate: loadedDraft.candidate,
      scenario: loadedDraft.scenario, checks: loadedDraft.checks.join('\n'),
    };
    for (const [name, value] of Object.entries(values)) {
      const field = form.elements.namedItem(name);
      if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) field.value = value;
    }
    setReviewError(undefined);
  }, [loadedDraft]);
  const t = (key: MessageKey, params?: Record<string, string | number>): string => translate(language, key, params);

  const loadConversations = (): void => {
    setReviewError(undefined);
    void conversations().then(setSessions, failure => setReviewError(String(failure)));
  };

  /**
   * Review the selected conversation and draft a backtest. The drafted fields are written into the
   * form rather than kept in state, so what runs is what the user sees and can still edit.
   */
  const runReview = async (): Promise<void> => {
    const form = editor.current;
    if (form === null || controller.current !== null) return;
    const data = new FormData(form);
    const sessionId = String(data.get('sessionId') ?? '');
    if (sessionId === '') { setReviewError(t('skills.selectRequired')); return; }
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setReviewError(undefined);
    setRunError(undefined);
    setResult(undefined);
    setReviewResult(undefined);
    try {
      const draft = await review({ sessionId, baseline: String(data.get('baseline') ?? '') }, abort.signal);
      if (abort.signal.aborted) return;
      setReviewResult(draft);
      if (draft.kind === 'draft') {
        onReviewed?.(draft, sessions.find(item => item.id === sessionId)?.workspace ?? '');
        for (const [name, value] of Object.entries({
          candidate: draft.input.candidate, scenario: draft.input.scenario, checks: draft.input.checks.join('\n'),
        })) {
          const field = form.elements.namedItem(name);
          if (field instanceof HTMLTextAreaElement) field.value = value;
        }
        if (draft.report) setResult({ checks: draft.input.checks, report: draft.report });
        if (draft.backtestError) setRunError(draft.backtestError);
      }
    } catch (failure) {
      if (!abort.signal.aborted) setReviewError(String(failure));
    } finally {
      controller.current = null;
      setBusy(false);
    }
  };

  const runBacktest = async (form: HTMLFormElement): Promise<void> => {
    if (controller.current !== null) return;
    const data = new FormData(form);
    const checks = String(data.get('checks') ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setRunError(undefined);
    setResult(undefined);
    try {
      const report = await run({
        baseline: String(data.get('baseline') ?? ''),
        candidate: String(data.get('candidate') ?? ''),
        scenario: String(data.get('scenario') ?? ''),
        checks,
      }, abort.signal);
      if (!abort.signal.aborted) setResult({ checks, report });
    } catch (failure) {
      if (!abort.signal.aborted) setRunError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      controller.current = null;
      setBusy(false);
    }
  };

  return <form ref={editor} className="mwui-body" onSubmit={event => {
    event.preventDefault();
    void runBacktest(event.currentTarget);
  }}>
    <section className="mwui-pane" aria-label={t('skills.review')}>
      <div className="mwui-pane-header">
        <span className="mwui-pane-title">{t('skills.review')}</span>
        <span className="mwui-pane-count">{sessions.length === 0 ? '' : t('skills.sessionCount', { count: sessions.length })}</span>
      </div>
      <div className="mwui-detail">
        <div className="mwui-edit-hint" data-tone="muted">{t('skills.reviewHint')}</div>
        <label className="mwui-field">
          <span>{t('skills.session')}</span>
          <select className="mwui-input mwui-select" name="sessionId" defaultValue="" disabled={busy}>
            <option value="">{t('skills.selectSession')}</option>
            {sessions.map(session => <option key={session.id} value={session.id}>{session.workspace} · {session.id}</option>)}
          </select>
        </label>
        <div className="mwui-edit-actions">
          <button type="button" className="mwui-button" onClick={loadConversations} disabled={busy}>
            {t('skills.load')}
          </button>
          <button type="button" className="mwui-button" data-variant="primary" onClick={() => { void runReview(); }} disabled={busy}>
            {t('skills.reviewRun')}
          </button>
        </div>
        {reviewResult?.kind === 'none' ? <div className="mwui-empty">{t('skills.noImprovement')}</div> : null}
        {reviewResult?.kind === 'draft' ? (
          <div className="mwui-detail-section">
            <h4 className="mwui-section-title">{t('skills.evidence')}</h4>
            <div className="mwui-edit-hint" data-tone="muted">{reviewResult.reason}</div>
            <ul className="mwui-sublist">
              {reviewResult.evidence.map(item => (
                <li key={item.step} className="mwui-subrow mwui-relation">
                  <span className="mwui-subrow-main">{item.step} · {item.role}</span>
                  <span className="mwui-relation-evidence">{item.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {reviewError === undefined ? null : <div className="mwui-inline-error" role="alert"><span>{reviewError}</span></div>}
      </div>
    </section>

    <section className="mwui-pane" aria-label={t('skills.backtest')}>
      <div className="mwui-pane-header">
        <span className="mwui-pane-title">{t('skills.backtest')}</span>
        <span className="mwui-pane-count">{busy ? t('toolbar.loading') : ''}</span>
      </div>
      <div className="mwui-detail">
        <div className="mwui-edit-hint" data-tone="muted">{t('skills.backtestHint')}</div>
        <label className="mwui-field">
          <span>{t('skills.baseline')}</span>
          <textarea className="mwui-input mwui-textarea" name="baseline" rows={4} maxLength={24000} disabled={busy} />
        </label>
        <label className="mwui-field">
          <span>{t('skills.candidate')}</span>
          <textarea className="mwui-input mwui-textarea" name="candidate" rows={4} maxLength={24000} required disabled={busy} />
        </label>
        <label className="mwui-field">
          <span>{t('skills.scenario')}</span>
          <textarea className="mwui-input mwui-textarea" name="scenario" rows={3} maxLength={4000} required disabled={busy} />
        </label>
        <label className="mwui-field">
          <span>{t('skills.checks')}</span>
          <textarea className="mwui-input mwui-textarea" name="checks" rows={3} maxLength={10000} required disabled={busy} />
        </label>
        <div className="mwui-edit-actions">
          <button type="submit" className="mwui-button" data-variant="primary" disabled={busy}>
            {t('skills.run')}
          </button>
          {busy ? (
            <button type="button" className="mwui-button" onClick={() => controller.current?.abort()}>
              {t('skills.cancel')}
            </button>
          ) : null}
        </div>
        {runError === undefined ? null : <div className="mwui-inline-error" role="alert"><span>{runError}</span></div>}
        {result === undefined
          ? (busy ? null : <div className="mwui-empty">{t('skills.noResult')}</div>)
          : (
            <div className="mwui-detail-section">
              <h4 className="mwui-section-title">{t('skills.regressions')} · {result.report.regressions.length}</h4>
              <div className="mwui-compare">
                {(['baseline', 'candidate'] as const).map(side => (
                  <div key={side} className="mwui-compare-col">
                    <div className="mwui-compare-head">{t(side === 'baseline' ? 'skills.currentVersion' : 'skills.draftVersion')}</div>
                    <ul className="mwui-sublist">
                      {result.report[side].checks.map((check, index) => (
                        <li key={index} className="mwui-subrow mwui-relation">
                          <span className="mwui-subrow-main">{result.checks[index]}</span>
                          <span className="mwui-chip-slim" data-tone={check.passed ? 'ok' : 'bad'}>
                            {t(check.passed ? 'skills.pass' : 'skills.fail')}
                          </span>
                          <span className="mwui-relation-evidence">{check.reason}</span>
                        </li>
                      ))}
                    </ul>
                    <div className="mwui-edit-hint" data-tone="muted">{t('skills.steps')}</div>
                    <div className="mwui-content mwui-scroll">{result.report[side].steps === '' ? '—' : result.report[side].steps}</div>
                    <div className="mwui-edit-hint" data-tone="muted">{t('skills.answer')}</div>
                    <div className="mwui-content mwui-scroll">{result.report[side].answer === '' ? '—' : result.report[side].answer}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
      </div>
      {selectedSkill !== undefined && selectedSkill !== null && onAdopt !== undefined ? (
        <div className="mwui-actions">
          <button
            type="button"
            className="mwui-button"
            data-variant="primary"
            disabled={busy}
            onClick={() => {
              const form = editor.current;
              if (form === null) return;
              const candidate = String(new FormData(form).get('candidate') ?? '').trim();
              if (candidate === '') { setRunError(t('skills.candidateRequired')); return; }
              onAdopt(candidate);
            }}
          >
            {t('skills.adopt', { name: selectedSkill.name })}
          </button>
        </div>
      ) : null}
    </section>
  </form>;
}

/** What DSH can load from the four skill roots, before any write operation. */
export function SkillListPanel({ language, report, error, onRefresh, selected, onSelect, versions, roots, onRestore, onCreate, busy = false, notice = null, trash, onTrash, onRestoreTrash, diff, onDiff, drafts, onDismissDraft, onAdoptDraft, onLoadDraft }: {
  language: Language; report: UiSkillReport | null; error: string | null; onRefresh(): void;
  selected?: string | null; onSelect?(entry: UiSkillEntry): void;
  versions?: UiSkillVersion[]; roots?: string[];
  onRestore?(versionId: string): void;
  onCreate?(input: { root: string; name: string; description: string }): void;
  busy?: boolean; notice?: string | null;
  trash?: UiTrashEntry[];
  onTrash?(path: string): void;
  onRestoreTrash?(id: string): void;
  diff?: { versionId: string; lines: DiffLine[] } | null;
  onDiff?(versionId: string): void;
  drafts?: UiSkillDraft[];
  onDismissDraft?(id: string): void;
  onAdoptDraft?(draft: UiSkillDraft): void;
  onLoadDraft?(draft: UiSkillDraft): void;
  /** Fills the form from a stored draft so it can be re-run or edited. */
  loadedDraft?: UiSkillDraft | null;
}): ReactNode {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [root, setRoot] = useState(roots?.[0] ?? '');
  const t = (key: MessageKey, params?: Record<string, string | number>): string => translate(language, key, params);
  return (
    /**
     * Two columns: the index on the left, everything about the selected skill on the right.
     * The reference implementation splits the same way — a narrow list beside a wide pane — so a
     * long list never pushes the detail off the page.
     */
    <div className="mwui-skills-split">
      <section className="mwui-skills-rail" aria-label={t('skills.list')}>
        <div className="mwui-pane-header">
          <span className="mwui-pane-title">{t('skills.list')}</span>
          <button type="button" className="mwui-button mwui-mini" onClick={onRefresh}>{t('skills.refresh')}</button>
        </div>
        <div className="mwui-skills-rail-body">
        {error === null ? null : <div className="mwui-banner" data-tone="bad">{error}</div>}
        {report === null ? <div className="mwui-muted">{t('list.loading')}</div> : (
          <>
            {report.items.length === 0
              ? <div className="mwui-empty">{t('skills.empty')}</div>
              : (
                <ul className="mwui-list">
                  {report.items.map(item => (
                    <li key={item.path} className="mwui-list-row" data-active={selected === item.path ? 'true' : undefined}>
                      <button type="button" className="mwui-link" onClick={() => onSelect?.(item)}>{item.name}</button>
                      <span className="mwui-source">{t(item.scope === 'project' ? 'skills.scope.project' : 'skills.scope.user')}</span>
                      <span>{item.description}</span>
                      <span className="mwui-muted">{item.path}</span>
                    </li>
                  ))}
                </ul>
              )}
            {report.invalid.length === 0 ? null : (
              <div className="mwui-edit-hint" data-tone="muted">{t('skills.unloadable', { count: report.invalid.length })}</div>
            )}
          </>
        )}
        {selected === null || selected === undefined || onTrash === undefined ? null : (
          <div className="mwui-actions">
            <button type="button" className="mwui-button" disabled={busy} onClick={() => onTrash(selected)}>{t('skills.remove')}</button>
          </div>
        )}
        </div>
      </section>
      <section className="mwui-skills-main" aria-label={t('skills.detail')}>
        {notice === null ? null : <div className="mwui-banner" data-tone="ok">{notice}</div>}
        {drafts === undefined ? null : (
          <div className="mwui-settings-group">
            <h4 className="mwui-section-title">{t('skills.drafts')}</h4>
            {drafts.length === 0
              ? <div className="mwui-muted">{t('skills.noDrafts')}</div>
              : (
                <ul className="mwui-list">
                  {drafts.map(draft => (
                    <li key={draft.id} className="mwui-list-row">
                      <span className="mwui-muted">{draft.createdAt}</span>
                      <span>{draft.reason}</span>
                      <span className="mwui-mono">{draft.skillPath ?? '—'}</span>
                      <span className="mwui-source">
                        {t(draft.adoptedAt !== null ? 'skills.draftAdopted' : draft.dismissedAt !== null ? 'skills.draftDismissed' : 'skills.draftPending')}
                      </span>
                      {draft.dismissedAt === null && draft.adoptedAt === null
                        ? <button type="button" className="mwui-button" disabled={busy} onClick={() => onLoadDraft?.(draft)}>{t('skills.loadDraft')}</button>
                        : null}
                      {draft.dismissedAt === null && draft.adoptedAt === null && draft.skillPath !== null
                        ? <button type="button" className="mwui-button" disabled={busy} onClick={() => onAdoptDraft?.(draft)}>{t('skills.adoptDraft')}</button>
                        : null}
                      {draft.dismissedAt === null && draft.adoptedAt === null
                        ? <button type="button" className="mwui-button" disabled={busy} onClick={() => onDismissDraft?.(draft.id)}>{t('skills.dismiss')}</button>
                        : null}
                    </li>
                  ))}
                </ul>
              )}
          </div>
        )}
        {trash === undefined ? null : (          <div className="mwui-settings-group">
            <h4 className="mwui-section-title">{t('skills.trash')}</h4>
            {trash.length === 0
              ? <div className="mwui-muted">{t('skills.trashEmpty')}</div>
              : (
                <ul className="mwui-list">
                  {trash.map(entry => (
                    <li key={entry.id} className="mwui-list-row">
                      <span className="mwui-mono">{entry.name}</span>
                      <span className="mwui-muted">{entry.originalPath}</span>
                      <button type="button" className="mwui-button" disabled={busy} onClick={() => onRestoreTrash?.(entry.id)}>{t('skills.restoreTrash')}</button>
                    </li>
                  ))}
                </ul>
              )}
          </div>
        )}
        {versions === undefined || selected === null || selected === undefined ? null : (
          <div className="mwui-settings-group">
            <h4 className="mwui-section-title">{t('skills.versions')}</h4>
            {versions.length === 0
              ? <div className="mwui-muted">{t('skills.noVersions')}</div>
              : (
                <ul className="mwui-list">
                  {versions.map(version => (
                    <li key={version.id} className="mwui-list-row">
                      <span className="mwui-mono">{version.hash.slice(0, 8)}</span>
                      <span>{version.savedAt}</span>
                      <span className="mwui-source">{t(version.source === 'adopt' ? 'skills.source.adopt' : 'skills.source.restore')}</span>
                      <button type="button" className="mwui-button" disabled={busy} onClick={() => onRestore?.(version.id)}>{t('skills.restore')}</button>
                      <button type="button" className="mwui-button" disabled={busy} onClick={() => onDiff?.(version.id)}>{t('skills.compare')}</button>
                    </li>
                  ))}
                </ul>
              )}
            {diff === undefined || diff === null ? null : (
              <div className="mwui-diff">
                <div className="mwui-edit-hint" data-tone="muted">
                  {t('skills.diffSummary', { added: diffSummary(diff.lines).added, removed: diffSummary(diff.lines).removed })}
                </div>
                {diff.lines.map((line, index) => (
                  <div key={index} className="mwui-diff-line" data-kind={line.kind}>
                    <span className="mwui-mono">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}</span>
                    <span className="mwui-mono">{line.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {onCreate === undefined || roots === undefined || roots.length === 0 ? null : (
          <div className="mwui-settings-group">
            <h4 className="mwui-section-title">{t('skills.create')}</h4>
            <label className="mwui-field">
              <span>{t('skills.name')}</span>
              <input className="mwui-input" value={name} onChange={event => setName(event.target.value)} />
            </label>
            <label className="mwui-field">
              <span>{t('skills.description')}</span>
              <input className="mwui-input" value={description} onChange={event => setDescription(event.target.value)} />
            </label>
            <label className="mwui-field">
              <span>{t('skills.root')}</span>
              <select className="mwui-input mwui-select" value={root} onChange={event => setRoot(event.target.value)}>
                {roots.map(path => <option key={path} value={path}>{path}</option>)}
              </select>
            </label>
            <div className="mwui-actions">
              <button
                type="button"
                className="mwui-button"
                data-variant="primary"
                disabled={busy || name.trim() === '' || description.trim() === ''}
                onClick={() => onCreate({ root, name: name.trim(), description: description.trim() })}
              >
                {t('skills.createRun')}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
