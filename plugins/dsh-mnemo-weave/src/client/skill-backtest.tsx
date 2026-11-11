import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { SkillBacktestInput, SkillBacktestResult, SkillReviewResult } from '../shared/contract.ts';
import { translate, type Language, type MessageKey } from './i18n.ts';

/**
 * The skills page: session review on the left, text backtest on the right.
 *
 * It uses the same chrome as every other page — a `mwui-body` of two `mwui-pane` sections with
 * `mwui-detail` inside — so its frame, controls and actions read like the rest of the page. The
 * form spans both panes because the review action drafts the fields the backtest side runs.
 */
export function SkillBacktestPanel({ language, run, conversations, review }: {
  language: Language;
  conversations(): Promise<{ id: string; workspace: string }[]>;
  review(input: { sessionId: string; baseline: string }, signal: AbortSignal): Promise<SkillReviewResult>;
  run(input: SkillBacktestInput, signal: AbortSignal): Promise<SkillBacktestResult>;
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
    </section>
  </form>;
}
