/**
 * 「保存回复」: one confirmed save of one finished assistant reply.
 *
 * DSH publishes `conversation.chat.assistant-actions` for every finalised assistant message and
 * passes its durable `messageId`. The Host resolves the text and turn from the session log.
 *
 * Three properties matter more than the button:
 *
 * 1. A reply that is still streaming has no finalised message, so no button exists for it.
 * 2. The task id is derived from `(session, messageId)`, so a second click, a reopened page or a
 *    retry all address the same Server receipt instead of writing again.
 * 3. Closing the preview writes nothing.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { WriteTaskOutcome } from '../shared/contract.ts';
import { translate, type Language } from './i18n.ts';
import { Modal } from './modal.tsx';
import { replyTaskId } from './reply-save-model.ts';

/** The six shared classification values a formal memory may carry. */
type Category = 'fact' | 'insight' | 'decision' | 'preference' | 'context' | 'general';

const CATEGORIES: Category[] = ['fact', 'insight', 'decision', 'preference', 'context', 'general'];

export interface ReplySaveProps {
  /** The finalised assistant message this row belongs to. */
  messageId: string;
  preview: (input: { sessionId: string; replyId: string }, signal: AbortSignal) => Promise<{ text: string; turnId: string } | null>;
  sessionId?: string;
  language: Language;
  save: (input: { taskId: string; sessionId: string; replyId: string; turnId: string; content: string; category?: string }) => Promise<WriteTaskOutcome>;
}

export function ReplySaveButton(props: ReplySaveProps): ReactNode {
  const { messageId, sessionId, language, save, preview } = props;
  const [reply, setReply] = useState<{ text: string; turnId: string } | null>(null);
  useEffect(() => {
    if (!sessionId || !messageId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const load = (): void => {
      void preview({ sessionId, replyId: messageId }, controller.signal).then(value => {
        if (controller.signal.aborted) return;
        setReply(value);
        if (value === null && ++attempts < 15) timer = setTimeout(load, 2000);
      }, () => undefined);
    };
    load();
    return () => { controller.abort(); if (timer !== undefined) clearTimeout(timer); };
  }, [sessionId, messageId, preview]);
  const text = reply?.text ?? null;
  const turnId = reply?.turnId;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [category, setCategory] = useState<Category>('general');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<WriteTaskOutcome | null>(null);

  const begin = useCallback((): void => {
    setDraft(text ?? '');
    setError(null);
    setOutcome(null);
    setOpen(true);
  }, [text]);

  const confirm = useCallback(async (): Promise<void> => {
    if (sessionId === undefined || turnId === undefined || busy) return;
    const content = draft.trim();
    if (content === '') { setError(translate(language, 'reply.empty')); return; }
    setBusy(true);
    setError(null);
    try {
      const result = await save({
        taskId: replyTaskId(sessionId, messageId), sessionId, replyId: messageId, turnId,
        content, category,
      });
      setOutcome(result);
    } catch (failure) {
      setError(failureTextOf(failure, language));
    } finally {
      setBusy(false);
    }
  }, [sessionId, turnId, busy, draft, language, save, messageId, category]);

  // No finalised text means no offer: a streaming reply has nothing confirmed to save yet.
  if (text === null || sessionId === undefined || turnId === undefined) return null;

  return (
    <>
      <button
        type="button"
        className="mwui-button mwui-mini"
        title={translate(language, 'reply.saveTitle')}
        onClick={begin}
      >
        {translate(language, 'reply.save')}
      </button>
      {open ? (
        <Modal
          title={translate(language, 'reply.previewTitle')}
          language={language}
          busy={busy}
          dirty={draft.trim() !== (text ?? '')}
          onClose={() => { if (!busy) setOpen(false); }}
        >
          <div className="mwui-edit">
            <p className="mwui-edit-hint" data-tone="muted">{translate(language, 'reply.previewHint')}</p>
            <h4 className="mwui-section-title">{translate(language, 'reply.source')}</h4>
            <pre className="mwui-pre">{text}</pre>
            <h4 className="mwui-section-title">{translate(language, 'reply.body')}</h4>
            <textarea
              className="mwui-input mwui-textarea"
              rows={6}
              value={draft}
              maxLength={8000}
              onChange={event => setDraft(event.target.value)}
              aria-label={translate(language, 'reply.body')}
            />
            <label className="mwui-field">
              <span>{translate(language, 'reply.category')}</span>
              <select
                className="mwui-input mwui-select"
                value={category}
                onChange={event => setCategory(event.target.value as Category)}
              >
                {CATEGORIES.map(value => (
                  <option key={value} value={value}>{translate(language, `category.${value}` as never)}</option>
                ))}
              </select>
            </label>
            {error === null ? null : <div className="mwui-inline-error" role="alert">{error}</div>}
            {outcome === null ? null : (
              <div className="mwui-edit-hint" data-tone={outcome.status === 'failed' ? 'warn' : 'muted'}>
                {translate(language, `write.status.${outcome.status}` as never)}
                {/* A repeated or queued result is still the same single write, not a second one. */}
                {outcome.memoryId === null ? '' : ` · ${outcome.memoryId}`}
              </div>
            )}
            <div className="mwui-edit-actions">
              <button
                type="button"
                className="mwui-button"
                data-variant="primary"
                disabled={busy || draft.trim() === '' || outcome !== null}
                onClick={() => { void confirm(); }}
              >
                {translate(language, busy ? 'reply.saving' : 'reply.confirm')}
              </button>
              <button type="button" className="mwui-button" disabled={busy} onClick={() => setOpen(false)}>
                {translate(language, 'detail.cancel')}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function failureTextOf(error: unknown, language: Language): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return `${translate(language, 'reply.failed')} · ${code}`;
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return translate(language, 'reply.failed');
}
