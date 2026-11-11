import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { translate, type Language } from './i18n.ts';

/**
 * A modal window over the page.
 *
 * Memory forms open here instead of rewriting the page around them: the list, the detail panel and
 * their scroll positions stay as they were, and the form is the only interactive surface until it
 * closes. Escape and the close button ask before discarding unsubmitted content, and focus starts
 * in the dialog rather than on a page control hidden behind the overlay.
 */
export interface ModalProps {
  title: string;
  language: Language;
  /** A secondary line beside the title, such as the base version being edited. */
  subtitle?: string;
  /** A request is in flight: the window cannot be closed until it settles. */
  busy?: boolean;
  /** The form holds content the user has not submitted. */
  dirty?: boolean;
  onClose(): void;
  children: ReactNode;
}

export function Modal({ title, subtitle, busy = false, dirty = false, onClose, children, language }: ModalProps): ReactNode {
  const dialog = useRef<HTMLDivElement>(null);
  const [confirming, setConfirming] = useState(false);

  const requestClose = useCallback((): void => {
    if (busy) return;
    if (dirty) { setConfirming(true); return; }
    onClose();
  }, [busy, dirty, onClose]);

  // Focus the first control in the body so typing lands in the form, not on the close button or
  // on a page control hidden behind the overlay. Focus returns to the opener on close.
  useEffect(() => {
    const previous = typeof document === 'undefined' ? null : document.activeElement;
    const node = dialog.current;
    const first = node?.querySelector<HTMLElement>('.mwui-modal-body textarea, .mwui-modal-body select, .mwui-modal-body input, .mwui-modal-body button');
    (first ?? node)?.focus();
    return () => {
      if (previous !== null && typeof (previous as HTMLElement).focus === 'function') (previous as HTMLElement).focus();
    };
  }, []);

  // Escape is the keyboard's close button; Tab cycles inside the window instead of leaving it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const node = dialog.current;
      if (node === null) return;
      const focusable = [...node.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter(item => item.getClientRects().length > 0 || item === node);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [requestClose]);

  return (
    <div
      className="mwui-modal"
      role="presentation"
      onMouseDown={event => { if (event.target === event.currentTarget) requestClose(); }}
    >
      <div className="mwui-modal-dialog" role="dialog" aria-modal="true" aria-label={title} ref={dialog} tabIndex={-1}>
        <div className="mwui-modal-head">
          <span className="mwui-modal-title">{title}</span>
          {subtitle === undefined ? null : <span className="mwui-modal-subtitle">{subtitle}</span>}
          <button
            type="button"
            className="mwui-button mwui-mini mwui-modal-close"
            onClick={requestClose}
            disabled={busy}
            aria-label={translate(language, 'modal.close')}
          >
            ×
          </button>
        </div>
        <div className="mwui-modal-body">
          {confirming ? (
            <div className="mwui-banner" data-tone="warn" role="alertdialog" aria-label={translate(language, 'modal.discardPrompt')}>
              <span className="mwui-banner-text">{translate(language, 'modal.discardPrompt')}</span>
              <button type="button" className="mwui-button mwui-mini" onClick={() => setConfirming(false)}>
                {translate(language, 'detail.keepEditing')}
              </button>
              <button type="button" className="mwui-button mwui-mini" data-variant="danger" onClick={onClose}>
                {translate(language, 'detail.discardDraft')}
              </button>
            </div>
          ) : null}
          {children}
        </div>
      </div>
    </div>
  );
}
