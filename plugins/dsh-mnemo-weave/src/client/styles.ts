export const STYLE_ID = 'dsh-mnemo-weave-styles';

/**
 * The page's own styles. Colors lean on DSH theme variables where the shell defines them
 * and fall back to neutral values, so the page reads correctly in light and dark shells.
 */
export const CSS = `
.mwui-root{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;
  font:13px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  color:var(--dsh-color-text,rgb(31,35,40));background:var(--dsh-color-bg,transparent);padding:20px 24px 16px;gap:14px;
  --mwui-border:var(--dsh-color-border,rgba(127,127,127,.28));
  --mwui-muted:var(--dsh-color-text-muted,rgba(110,118,129,.95));
  --mwui-surface:var(--dsh-color-surface,rgba(127,127,127,.06));
  --mwui-accent:var(--dsh-color-accent,rgb(56,139,253));}
.mwui-header{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap}
.mwui-title{margin:0;font-size:17px;font-weight:650;letter-spacing:.2px}
.mwui-subtitle{margin:2px 0 0;color:var(--mwui-muted);font-size:12px}
.mwui-actions{margin-left:auto;display:flex;gap:8px;align-items:center}
.mwui-button{appearance:none;border:1px solid var(--mwui-border);background:var(--mwui-surface);color:inherit;
  border-radius:8px;padding:5px 12px;font:inherit;font-size:12px;cursor:pointer}
.mwui-button:hover{border-color:var(--mwui-accent)}
.mwui-button:disabled{opacity:.55;cursor:default}
.mwui-button[data-variant="primary"]{border-color:var(--mwui-accent);color:var(--mwui-accent)}
.mwui-banner{display:flex;gap:10px;align-items:center;border:1px solid var(--mwui-border);border-radius:10px;
  padding:9px 12px;font-size:12px;background:var(--mwui-surface)}
.mwui-banner[data-tone="bad"]{border-color:rgba(248,81,73,.55);background:rgba(248,81,73,.08)}
.mwui-banner[data-tone="warn"]{border-color:rgba(210,153,34,.55);background:rgba(210,153,34,.08)}
.mwui-banner[data-tone="ok"]{border-color:rgba(63,185,80,.45);background:rgba(63,185,80,.07)}
.mwui-banner .mwui-banner-text{flex:1;min-width:0}
.mwui-chips{display:flex;flex-wrap:wrap;gap:6px}
.mwui-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--mwui-border);border-radius:999px;
  padding:3px 10px;font-size:11.5px;background:var(--mwui-surface);max-width:100%}
.mwui-chip .mwui-chip-label{color:var(--mwui-muted)}
.mwui-chip .mwui-chip-value{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mwui-chip[data-tone="ok"] .mwui-chip-value{color:rgb(63,185,80)}
.mwui-chip[data-tone="warn"] .mwui-chip-value{color:rgb(210,153,34)}
.mwui-chip[data-tone="bad"] .mwui-chip-value{color:rgb(248,81,73)}
.mwui-section-title{margin:0 0 8px;font-size:12px;font-weight:650;letter-spacing:.3px;color:var(--mwui-muted);text-transform:uppercase}
.mwui-body{display:grid;grid-template-columns:minmax(260px,38%) minmax(0,1fr);gap:14px;flex:1;min-height:0}
@media (max-width:900px){.mwui-body{grid-template-columns:1fr}}
.mwui-pane{display:flex;flex-direction:column;min-height:0;border:1px solid var(--mwui-border);border-radius:12px;overflow:hidden}
.mwui-pane-header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--mwui-border);background:var(--mwui-surface)}
.mwui-pane-title{font-weight:650;font-size:12.5px}
.mwui-pane-count{margin-left:auto;color:var(--mwui-muted);font-size:11.5px}
.mwui-search{display:flex;gap:8px;padding:10px 12px;border-bottom:1px solid var(--mwui-border)}
.mwui-input{flex:1;min-width:0;appearance:none;border:1px solid var(--mwui-border);border-radius:8px;background:transparent;
  color:inherit;font:inherit;padding:6px 10px}
.mwui-input:focus{outline:none;border-color:var(--mwui-accent)}
.mwui-list{list-style:none;margin:0;padding:6px;overflow:auto;min-height:0;flex:1}
.mwui-item{width:100%;text-align:left;appearance:none;border:1px solid transparent;background:transparent;color:inherit;
  border-radius:9px;padding:8px 10px;cursor:pointer;display:flex;flex-direction:column;gap:3px;font:inherit}
.mwui-item:hover{background:var(--mwui-surface)}
.mwui-item[data-active="true"]{border-color:var(--mwui-accent);background:var(--mwui-surface)}
.mwui-item-title{font-weight:600;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mwui-item-excerpt{color:var(--mwui-muted);font-size:11.5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.mwui-item-meta{display:flex;gap:8px;color:var(--mwui-muted);font-size:11px;flex-wrap:wrap}
.mwui-empty{padding:22px 16px;color:var(--mwui-muted);font-size:12px;text-align:center}
.mwui-detail{display:flex;flex-direction:column;gap:12px;padding:14px;overflow:auto;min-height:0}
.mwui-detail-head{display:flex;flex-direction:column;gap:6px}
.mwui-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--mwui-muted);word-break:break-all}
.mwui-content{white-space:pre-wrap;word-break:break-word;background:var(--mwui-surface);border:1px solid var(--mwui-border);
  border-radius:10px;padding:12px;font-size:12.5px;line-height:1.65}
.mwui-sublist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.mwui-subrow{display:flex;gap:8px;align-items:baseline;font-size:11.5px;color:var(--mwui-muted);border-bottom:1px dashed var(--mwui-border);padding:4px 0}
.mwui-subrow .mwui-subrow-main{color:inherit;font-weight:600}
.mwui-subrow .mwui-subrow-tail{margin-left:auto}
.mwui-select{flex:0 0 auto;width:auto;padding:6px 8px;cursor:pointer}
.mwui-mini{padding:2px 8px;font-size:11px}
.mwui-detail-idrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mwui-subrow-btn{appearance:none;border:0;background:transparent;color:inherit;font:inherit;width:100%;
  display:flex;gap:8px;align-items:baseline;padding:4px 6px;border-radius:6px;cursor:pointer;text-align:left}
.mwui-subrow-btn:hover{background:var(--mwui-surface)}
.mwui-subrow-btn[data-active="true"]{background:var(--mwui-surface);box-shadow:inset 0 0 0 1px var(--mwui-accent)}
.mwui-subrow-btn .mwui-subrow-main{font-weight:600}
.mwui-subrow-btn .mwui-subrow-tail{margin-left:auto}
.mwui-revision{display:flex;flex-direction:column;gap:8px}
.mwui-footer{display:flex;align-items:center;gap:10px;color:var(--mwui-muted);font-size:11px}
.mwui-footer .mwui-spacer{flex:1}
.mwui-intents{border:1px solid var(--mwui-border);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.mwui-intent{display:flex;gap:8px;font-size:11.5px;color:var(--mwui-muted)}
.mwui-intent .mwui-intent-kind{font-weight:600;color:inherit}
.mwui-loading{display:inline-block;width:10px;height:10px;border-radius:50%;border:2px solid var(--mwui-border);
  border-top-color:var(--mwui-accent);animation:mwui-spin .8s linear infinite;vertical-align:-1px;margin-right:6px}
@keyframes mwui-spin{to{transform:rotate(360deg)}}
.mwui-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);border:0}
`;

/** Inject the stylesheet once per document; a second client instance reuses the same tag. */
export function ensureStyles(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): void {
  if (doc === undefined) return;
  const existing = doc.querySelector<HTMLStyleElement>(`style[data-mnemoweave-ui="${STYLE_ID}"]`);
  if (existing !== null) {
    if (existing.textContent !== CSS) existing.textContent = CSS;
    return;
  }
  const style = doc.createElement('style');
  style.dataset['mnemoweaveUi'] = STYLE_ID;
  style.textContent = CSS;
  doc.head.append(style);
}
