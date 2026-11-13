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
  --mwui-accent:var(--dsh-color-accent,rgb(56,139,253));
  /* The graph needs a solid backdrop and a faint label tone; both come from the shell when it
     defines them, so the drawing reads correctly in light and dark. */
  --mwui-canvas:var(--dsh-color-surface,rgba(127,127,127,.06));
  --mwui-faint:var(--dsh-color-text-faint,rgba(110,118,129,.62));
  --mwui-sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}
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
/* Memories read as cards in two columns, as the reference implementation lays them out; the
   detail they used to occupy a column with is a floating window now. */
/* Skills: the index on the left, the selected skill on the right, each scrolling inside its own
   column so a long list never pushes the detail out of view. */
/* One page, three modules: the tabs pick which one the two columns below are showing. */
.mwui-skills-tabs{display:flex;gap:4px;padding:4px;border:1px solid var(--mwui-border);
  border-radius:10px;background:var(--mwui-surface);flex:0 0 auto}
.mwui-skills-tab{border:0;background:transparent;color:var(--mwui-muted);font:inherit;font-size:12px;
  padding:7px 14px;border-radius:7px;cursor:pointer}
.mwui-skills-tab[data-active="true"]{background:var(--mwui-panel);color:var(--mwui-text);
  box-shadow:0 1px 2px rgba(0,0,0,.12)}
.mwui-skills-tab:focus-visible{outline:2px solid var(--mwui-accent);outline-offset:1px}
.mwui-skills-split{display:grid;grid-template-columns:minmax(268px,340px) minmax(0,1fr);gap:12px;
  flex:1;min-height:0}
.mwui-skills-rail,.mwui-skills-main{border:1px solid var(--mwui-border);border-radius:12px;
  min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.mwui-skills-rail-body,.mwui-skills-main{padding:12px;overflow-y:auto}
.mwui-skills-rail-body{padding:0;overflow-y:auto;display:flex;flex-direction:column;gap:10px}
.mwui-skills-main{gap:10px}
.mwui-skills-rail .mwui-pane-header{border-bottom:1px solid var(--mwui-border);background:var(--mwui-surface)}
.mwui-skills-rail-body > .mwui-list{padding:6px}
.mwui-skills-rail-body > .mwui-banner,.mwui-skills-rail-body > .mwui-empty{margin:8px}
@media (max-width:900px){.mwui-skills-split{grid-template-columns:1fr}}
.mwui-content{display:flex;flex-direction:column;flex:1;min-height:0}
.mwui-memory-grid{list-style:none;margin:0;padding:6px;overflow:auto;min-height:0;flex:1;
  display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;align-items:start}
.mwui-memory-grid > li{min-width:0}
.mwui-memory-grid > .mwui-empty{grid-column:1 / -1;padding:24px;text-align:center}
@media (max-width:900px){.mwui-memory-grid{grid-template-columns:1fr}}
.mwui-detail{display:flex;flex-direction:column;gap:12px;padding:14px;overflow:auto;min-height:0}
.mwui-detail-head{display:flex;flex-direction:column;gap:6px}
.mwui-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--mwui-muted);word-break:break-all}
.mwui-content{white-space:pre-wrap;word-break:break-word;background:var(--mwui-surface);border:1px solid var(--mwui-border);
  border-radius:10px;padding:12px;font-size:12.5px;line-height:1.65}
.mwui-sublist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.mwui-history{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.mwui-subrow{display:flex;gap:8px;align-items:baseline;font-size:11.5px;color:var(--mwui-muted);border-bottom:1px dashed var(--mwui-border);padding:4px 0}
.mwui-subrow .mwui-subrow-main{color:inherit;font-weight:600}
.mwui-subrow .mwui-subrow-tail{margin-left:auto}
.mwui-select{flex:0 0 auto;width:auto;padding:6px 8px;cursor:pointer}
.mwui-mini{padding:2px 8px;font-size:11px}
.mwui-filter{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--mwui-border)}
.mwui-filter-label{color:var(--mwui-muted);font-size:11.5px}
.mwui-filter-count{margin-left:auto;color:var(--mwui-muted);font-size:11.5px}
.mwui-memcard{width:100%;text-align:left;appearance:none;border:1px solid var(--mwui-border);background:transparent;color:inherit;
  border-radius:10px;padding:9px 11px;cursor:pointer;display:flex;flex-direction:column;gap:4px;font:inherit}
.mwui-memcard:hover{background:var(--mwui-surface)}
.mwui-memcard[data-active="true"]{border-color:var(--mwui-accent);background:var(--mwui-surface)}
.mwui-memcard-item{display:flex;flex-direction:column;gap:4px}
.mwui-memcard-badges{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.mwui-memcard-content{font-size:12.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.mwui-memcard-tags{display:flex;gap:6px;flex-wrap:wrap}
.mwui-memcard-meta{display:flex;gap:8px;align-items:center;color:var(--mwui-muted);font-size:11px;flex-wrap:wrap}
.mwui-memcard-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:0 2px}
.mwui-meter{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 180px;max-width:320px}
.mwui-meter-label{font-size:12px;color:var(--mwui-muted);white-space:nowrap}
.mwui-meter-track{position:relative;display:block;height:6px;flex:1;min-width:48px;border-radius:999px;background:var(--mwui-border);overflow:hidden}
.mwui-meter-fill{display:block;height:100%;border-radius:999px;background:var(--mwui-accent);transition:width .2s ease}
.mwui-meter[data-tone="warn"] .mwui-meter-fill{background:#d29922}
.mwui-meter-value{font-size:12px;color:var(--mwui-muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.mwui-meter-value[data-tone="warn"]{color:#d29922}
/* A page whose detail fitted on its own rows: one column, full width. */
/* Panels stacked on one page keep the same gap the rest of the page uses. */
.mwui-stack{overflow:auto;padding-right:2px}
/* In a stack a pane keeps its natural height, and a grid panel keeps the full row width —
   otherwise its two columns collapse to the narrowest that fits their content. */
.mwui-stack > .mwui-pane{flex:0 0 auto}
.mwui-stack > .mwui-body{flex:0 0 auto;width:100%;align-items:start}
.mwui-single{display:flex;flex-direction:column;gap:14px;flex:1;min-height:0}
/* A rule reads as its text, not as a title plus a repeat of that text. */
.mwui-rule-body{display:block;color:inherit;font-size:12.5px;line-height:1.5;
  -webkit-line-clamp:3;white-space:pre-wrap;overflow-wrap:anywhere}
.mwui-item-static{display:flex;flex-direction:column;gap:3px;width:100%;box-sizing:border-box;
  border:1px solid var(--mwui-border);border-radius:8px;padding:9px 11px;background:transparent;text-align:left}
.mwui-item-static[data-active="true"]{border-color:rgba(56,139,253,.45)}
/* The workspace picker sits in a control row, not in the list's filter strip: reusing
   .mwui-filter there brought its bottom border and 12px padding along with it. */
.mwui-archive-picker{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--mwui-muted)}
.mwui-archive-picker .mwui-select{min-width:160px}
.mwui-archive-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 12px}
.mwui-archive-controls .mwui-meter{flex:1 1 220px;max-width:none}
.mwui-archive-toolbar{display:flex;gap:8px;padding:0 12px 10px}
.mwui-archive-toolbar .mwui-input{flex:1;min-width:0}
.mwui-entity-memories{display:flex;flex-direction:column;gap:6px;padding-top:8px;border-top:1px solid var(--mwui-border);margin-top:8px}
/* Both columns fill the page height: a rail that ends where its content does leaves the page
   looking half empty, and the list then scrolls the whole page instead of itself. */
.mwui-entity-layout{display:grid;grid-template-columns:minmax(220px,300px) minmax(0,1fr);gap:16px;
  align-items:stretch;flex:1;min-height:0}
.mwui-entity-rail{display:flex;flex-direction:column;gap:8px;border:1px solid var(--mwui-border);
  border-radius:10px;padding:12px;background:var(--mwui-panel);min-height:0;overflow:hidden}
/* The index scrolls inside the rail, so the progress footer stays visible at its bottom. */
.mwui-entity-rail .mwui-entity-list{flex:1;min-height:0;overflow-y:auto}
.mwui-entity-search{display:flex;gap:6px;align-items:center}
.mwui-entity-search .mwui-input{flex:1;min-width:0}
.mwui-entity-heading{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:13px;color:var(--mwui-text)}
.mwui-entity-heading small{font-size:11px;color:var(--mwui-muted);font-weight:400}
.mwui-entity-list{display:flex;flex-direction:column}
.mwui-entity-list button{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 6px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.mwui-entity-list button:hover{background:var(--mwui-hover, rgba(127,127,127,.12))}
.mwui-entity-list button[aria-pressed="true"]{background:var(--mwui-hover, rgba(127,127,127,.12));color:var(--mwui-accent)}
.mwui-entity-list strong{font-weight:500;color:var(--mwui-muted);font-variant-numeric:tabular-nums}
.mwui-entity-progress{display:flex;flex-direction:column;align-items:center;gap:6px;padding-top:8px;border-top:1px solid var(--mwui-border);font-size:12px;color:var(--mwui-muted)}
/* The result pane keeps its frame before anything is selected: two panels that appear only after
   a click make the page look like it has one column. */
.mwui-entity-results{min-width:0;display:flex;flex-direction:column;border:1px solid rgba(127,127,127,.28);border-radius:10px;padding:12px;min-height:240px;overflow-y:auto}
.mwui-entity-results>.mwui-empty{display:flex;flex:1;align-items:center;justify-content:center}
@media (max-width: 720px){.mwui-entity-layout{grid-template-columns:1fr}}
.mwui-button.mwui-danger{border-color:rgb(248,81,73);color:rgb(248,81,73)}
.mwui-chip-slim{border:1px solid var(--mwui-border);border-radius:999px;padding:0 6px;font-size:10.5px}
.mwui-load-more{width:calc(100% - 12px);margin:6px;justify-content:center}
.mwui-inline-error{display:flex;align-items:center;gap:8px;margin:6px;padding:6px 10px;border-radius:8px;
  border:1px solid rgb(248,81,73);color:rgb(248,81,73);font-size:11.5px}
.mwui-inline-notice{margin-top:6px;padding:6px 10px;border-radius:8px;border:1px solid var(--mwui-border);
  background:var(--mwui-surface);font-size:11.5px;color:var(--mwui-muted);white-space:pre-wrap}
.mwui-section-head{display:flex;align-items:center;gap:8px}
.mwui-section-actions{margin-left:auto;display:flex;gap:6px}
.mwui-compare{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.mwui-compare-3{grid-template-columns:1fr 1fr}
.mwui-compare-col{display:flex;flex-direction:column;gap:6px;min-width:0}
.mwui-compare-head{color:var(--mwui-muted);font-size:11px}
.mwui-scroll{max-height:360px;overflow:auto}
.mwui-subrow-button{width:100%;display:flex;gap:8px;align-items:baseline;appearance:none;border:0;background:transparent;
  color:inherit;font:inherit;padding:0;cursor:pointer;text-align:left}
.mwui-subrow[data-selected="true"] .mwui-subrow-main{color:var(--mwui-accent)}
.mwui-settings-group{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--mwui-border);border-radius:10px;margin-bottom:10px}
.mwui-settings-group:last-child{margin-bottom:0}
.mwui-settings-group:last-child{border-bottom:0}
.mwui-settings-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}
.mwui-settings-row label{min-width:150px;color:var(--mwui-muted)}
.mwui-settings-row .mwui-input{flex:1 1 220px}
/* A labelled control inside a pane: the label reads like a settings row's, the control takes the
   full width of its column. */
.mwui-field{display:flex;flex-direction:column;gap:4px;min-width:0}
/* A checkbox with its label belongs on one line; stacked, the box floats above the text. */
.mwui-field[data-direction="row"]{flex-direction:row;align-items:center;gap:8px;flex-wrap:wrap}
.mwui-field>span{font-size:11.5px;color:var(--mwui-muted)}
.mwui-field .mwui-textarea{min-height:88px}
.mwui-field .mwui-select{width:100%}
.mwui-source{margin-left:auto;color:var(--mwui-muted);font-size:10.5px;border:1px solid var(--mwui-border);
  border-radius:999px;padding:0 7px}
.mwui-chip-slim[data-tone="ok"]{color:rgb(63,185,80);border-color:rgb(63,185,80)}
.mwui-chip-slim[data-tone="bad"]{color:rgb(248,81,73);border-color:rgb(248,81,73)}
.mwui-chip-slim[data-tone="warn"]{color:rgb(210,153,34);border-color:rgb(210,153,34)}
.mwui-chip-slim[data-tone="tag"]{border-style:dashed}
.mwui-chip-slim[data-tone="entity"]{border-style:solid;font-weight:600}
.mwui-chip-slim[data-tone="category"]{color:var(--mwui-accent);border-color:var(--mwui-accent)}
.mwui-memcard-tags{color:var(--mwui-muted);font-size:10.5px}
.mwui-memcard-tags[data-tone="entity"]{color:var(--mwui-accent)}
.mwui-rev-hash{font-size:10.5px}
.mwui-relation{flex-wrap:wrap}
.mwui-relation-meta{display:flex;gap:6px;align-items:center;width:100%;font-size:10.5px;color:var(--mwui-muted)}
.mwui-relation-evidence{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mwui-relation-preview{width:100%;display:flex;flex-direction:column;gap:4px;margin-top:4px}
.mwui-classify{display:flex;gap:8px;flex-wrap:wrap}
/* Relation graph. Rules follow the DSH memory graph's own stylesheet so the two drawings read
   the same: a hover toolbar over the canvas, category colours mixed against the backdrop, and
   edges that fade by kind instead of all carrying the same weight. */
/* Relation graph. Layout follows the DSH memory graph: a two-column panel pairing the drawing
   with an inspector, a toolbar that carries the legend, and a footer that states what is drawn.
   Colours are mixed against the backdrop so the categories read in light and dark alike. */
.mwui-graph-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(240px,280px);gap:12px}
.mwui-graph-panel,.mwui-graph-inspector{border:1px solid rgba(127,127,127,.28);border-radius:12px}
.mwui-graph-panel{position:relative;min-width:0;overflow:hidden}
.mwui-graph-toolbar,.mwui-graph-footer{display:flex;min-height:44px;align-items:center;justify-content:space-between;gap:16px;padding:0 14px;color:rgba(110,118,129,.62);font-size:12px;line-height:18px;flex-wrap:wrap}
.mwui-graph-toolbar{border-bottom:1px solid rgba(127,127,127,.28)}
.mwui-graph-toolbar>div:first-child{display:flex;align-items:center;gap:8px}
.mwui-graph-toolbar small{color:rgba(110,118,129,.62)}
.mwui-live-dot{width:6px;height:6px;border-radius:50%;background:rgb(56,139,253)}
.mwui-graph-legend{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px 12px}
.mwui-graph-legend span{display:flex;align-items:center;gap:6px}
.mwui-graph-legend span::before{width:14px;height:2px;border-radius:2px;content:"";background:var(--edge-color)}
.mwui-graph-legend [data-edge="RelatedTo"]{--edge-color:#87909f}
.mwui-graph-legend [data-edge="Supersedes"]{--edge-color:#4d7cfe}
.mwui-graph-legend [data-edge="Conflicts"]{--edge-color:#ef6b5b}
.mwui-graph-legend [data-edge="Entity"]{--edge-color:#22a879}
.mwui-graph-viewport{position:relative;min-height:clamp(420px,46vw,640px);overflow:hidden}
.mwui-graph-footer{min-height:40px;border-top:1px solid rgba(127,127,127,.28);color:rgba(110,118,129,.62)}
.mwui-graph-inspector{min-width:0;min-height:calc(clamp(420px,46vw,640px) + 84px);overflow:hidden;padding:16px}
.mwui-inspector-empty{display:flex;height:100%;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.mwui-inspector-logo{display:grid;width:48px;height:48px;margin-bottom:12px;place-items:center;border-radius:12px;background:rgba(127,127,127,.06);opacity:.72;font-size:20px}
.mwui-inspector-empty h3{margin:6px 0 2px;font-size:14px;font-weight:500;line-height:22px}
.mwui-inspector-empty p{margin:0;color:rgba(110,118,129,.62);font-size:12px;line-height:18px}
.mwui-inspector-heading{display:flex;align-items:center;justify-content:space-between;color:rgba(110,118,129,.62);font-size:12px}
.mwui-inspector-heading button{display:grid;width:28px;height:28px;place-items:center;border:0;border-radius:6px;color:rgba(110,118,129,.95);background:transparent;cursor:pointer;font-size:16px;line-height:1}
.mwui-inspector-heading button:hover{background:rgba(127,127,127,.06)}
.mwui-inspector-chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:20px}
.mwui-category-chip{display:inline-flex;padding:1px 8px;border-radius:999px;color:rgba(110,118,129,.95);background:rgba(127,127,127,.06);font-size:11px;font-weight:500;line-height:17px}
.mwui-inspector-title-row{display:flex;min-width:0;align-items:flex-start;gap:8px;margin:12px 0 20px}
.mwui-inspector-title{display:-webkit-box;min-width:0;flex:1;margin:0;overflow:hidden;font-size:14px;font-weight:400;line-height:22px;overflow-wrap:anywhere;white-space:pre-wrap;-webkit-box-orient:vertical;-webkit-line-clamp:6}
.mwui-inspector-meta{margin:0}
.mwui-inspector-meta>div{display:grid;gap:2px;padding:10px 0;border-top:1px solid rgba(127,127,127,.28)}
.mwui-inspector-meta dt{color:rgba(110,118,129,.62);font-size:12px;line-height:18px}
.mwui-inspector-meta dd{margin:0;overflow-wrap:anywhere;color:rgba(110,118,129,.95);font-size:13px;line-height:20px}
.mwui-inspector-actions{display:grid;gap:8px;margin-top:20px}
.mwui-graph-wrap{position:relative}
.mwui-graph{display:block;width:100%;height:clamp(420px,46vw,640px);touch-action:pan-y pinch-zoom;user-select:none}
.mwui-graph-backdrop{fill:rgba(127,127,127,.06)}
.mwui-graph-grid-line{stroke:rgba(127,127,127,.28);stroke-width:.6;opacity:.5}
.mwui-graph-edge{fill:none;stroke:#87909f;stroke-width:1;opacity:.32;vector-effect:non-scaling-stroke}
.mwui-graph-edge[data-edge="Entity"]{stroke:#22a879;stroke-width:1.45;opacity:.78}
.mwui-graph-edge[data-edge="Supersedes"]{stroke:#4d7cfe;opacity:.48}
.mwui-graph-edge[data-edge="Conflicts"]{stroke:#ef6b5b;opacity:.52}
.mwui-graph-node{--node:#8290a8;outline:none;cursor:grab;touch-action:none}
.mwui-graph-node[data-dragging]{cursor:grabbing}
.mwui-graph-node[data-category="decision"]{--node:#ef8354}
.mwui-graph-node[data-category="preference"]{--node:#a879e1}
.mwui-graph-node[data-category="fact"]{--node:#4d7cfe}
.mwui-graph-node[data-category="insight"]{--node:#19a77d}
.mwui-graph-node[data-category="context"]{--node:#d8a624}
.mwui-graph-node[data-kind="entity"]{--node:#2b9db9}
.mwui-graph-halo{fill:color-mix(in srgb,var(--node) 18%,rgba(127,127,127,.06));stroke:color-mix(in srgb,var(--node) 60%,rgba(127,127,127,.06));stroke-width:1.5;transition:r .16s}
.mwui-graph-core{fill:var(--node)}
.mwui-graph-label{fill:rgba(110,118,129,.95);font:11px ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;pointer-events:auto}
.mwui-graph[data-density="sparse"] .mwui-graph-label{font-size:12px}
.mwui-graph-node:hover .mwui-graph-halo,
.mwui-graph-node:focus .mwui-graph-halo,
.mwui-graph-node[data-selected] .mwui-graph-halo{fill:color-mix(in srgb,var(--node) 28%,rgba(127,127,127,.06));stroke:var(--node)}
.mwui-graph-node[data-selected] .mwui-graph-label{fill:currentColor;font-weight:500}
/* A selection dims what it does not touch, so the node and its edges read as one group. */
.mwui-graph-node[data-muted]{opacity:.22;transition:opacity .18s}
.mwui-graph-edge[data-muted]{opacity:.06;transition:opacity .18s}
.mwui-inspector-eye{display:grid;width:28px;height:28px;flex:0 0 auto;place-items:center;border:1px solid rgba(127,127,127,.28);border-radius:6px;color:rgba(110,118,129,.95);background:transparent;cursor:pointer}
.mwui-inspector-eye:hover{color:inherit;background:rgba(127,127,127,.06)}
.mwui-preview-body{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:22px}
.mwui-graph-controls{position:absolute;z-index:2;top:10px;right:10px;display:flex;align-items:center;gap:4px;padding:4px;border-radius:8px;background:rgba(127,127,127,.06);box-shadow:0 2px 10px rgba(0,0,0,.12);backdrop-filter:blur(8px)}
.mwui-graph-controls span{display:flex;align-items:center;gap:6px;padding:0 6px;color:rgba(110,118,129,.62);font-size:12px}
.mwui-graph-controls span i{width:6px;height:6px;border-radius:50%;background:rgb(56,139,253)}
.mwui-graph-controls button{min-height:28px;border:0;border-radius:6px;padding:0 10px;color:rgba(110,118,129,.95);background:transparent;font-size:12px;cursor:pointer}
.mwui-graph-controls button:hover{color:inherit;background:rgba(127,127,127,.06)}
.mwui-graph-controls button[data-active]{color:inherit;background:rgba(127,127,127,.06)}
@media (max-width:900px){.mwui-graph-layout{grid-template-columns:1fr}.mwui-graph-inspector{min-height:0}}
@media (max-width:760px){.mwui-graph{height:390px}.mwui-graph-controls{right:8px;top:8px}.mwui-graph-controls span{display:none}}
.mwui-detail-section{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.mwui-detail-section .mwui-section-title{display:flex;align-items:center;gap:8px;justify-content:space-between}
.mwui-entity-list .mwui-subrow-button[data-active="true"]{border-color:var(--mwui-accent);color:var(--mwui-accent)}
.mwui-classify-field{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--mwui-muted);flex:1 1 160px}
.mwui-classify-field select{flex:1;min-width:0}
.mwui-relation-preview .mwui-scroll{max-height:200px}
.mwui-conflict{border:1px solid rgb(210,153,34);border-radius:10px;padding:8px 10px;margin-top:6px;display:flex;flex-direction:column;gap:6px}
.mwui-conflict-head{display:flex;gap:8px;align-items:center;font-size:11.5px}
.mwui-button[data-variant="danger"]{border-color:rgb(248,81,73);color:rgb(248,81,73)}
.mwui-button[data-variant="danger"]:disabled{opacity:.55}
@media (max-width:900px){
  /* Narrow screens show one pane at a time. Both stay mounted, so returning to the list keeps
     the filter, the selected row and each pane's scroll position. */
  .mwui-body[data-view="list"] .mwui-pane-detail{display:none}
  .mwui-body[data-view="detail"] .mwui-pane-list{display:none}
  .mwui-back{display:inline-flex}
  .mwui-compare{grid-template-columns:1fr}
}
@media (min-width:901px){.mwui-back{display:none}}
.mwui-detail-idrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mwui-subrow-btn{appearance:none;border:0;background:transparent;color:inherit;font:inherit;width:100%;
  display:flex;gap:8px;align-items:baseline;padding:4px 6px;border-radius:6px;cursor:pointer;text-align:left}
.mwui-subrow-btn:hover{background:var(--mwui-surface)}
.mwui-subrow-btn[data-active="true"]{background:var(--mwui-surface);box-shadow:inset 0 0 0 1px var(--mwui-accent)}
.mwui-subrow-btn .mwui-subrow-main{font-weight:600}
.mwui-subrow-btn .mwui-subrow-tail{margin-left:auto}
.mwui-edit{display:flex;flex-direction:column;gap:8px}
.mwui-textarea{min-height:140px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
  font-size:12px;line-height:1.6}
.mwui-edit-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.mwui-edit-hint{color:var(--mwui-muted);font-size:11.5px}
.mwui-edit-hint[data-tone="warn"]{color:rgb(210,153,34)}
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
.mwui-tabs{display:flex;gap:4px;flex-wrap:wrap;padding:2px;border:1px solid var(--mwui-border);border-radius:10px;background:var(--mwui-surface)}
.mwui-tab{appearance:none;border:1px solid transparent;background:transparent;color:inherit;font:inherit;font-size:12px;
  padding:5px 12px;border-radius:8px;cursor:pointer;white-space:nowrap}
.mwui-tab:hover{background:var(--mwui-hover, rgba(127,127,127,.12))}
.mwui-tab[data-active="true"]{border-color:var(--mwui-accent);font-weight:650}
/* A Source page's compound header, as dsh-mnemon frames a memory page: title, count and the
   page-level action, then its own secondary tabs as an underline strip. */
.mwui-memory{display:flex;flex-direction:column;flex:1;min-height:0}
.mwui-memory-workspace{display:flex;flex-direction:column;flex:0 0 auto;border-bottom:1px solid var(--mwui-border);margin-bottom:12px}
.mwui-memory-head{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;padding:2px 2px 8px}
.mwui-memory-heading{display:flex;flex-direction:column;gap:2px;min-width:0}
.mwui-memory-title{margin:0;font-size:15px;font-weight:650;letter-spacing:.2px}
.mwui-memory-description{margin:0;color:var(--mwui-muted);font-size:12px;max-width:720px}
.mwui-memory-actions{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.mwui-filter{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--mwui-muted)}
.mwui-filter .mwui-select{max-width:200px}
.mwui-memory-meta{color:var(--mwui-muted);font-size:11.5px}
.mwui-memory-tabs{display:flex;gap:22px;min-width:0;overflow-x:auto;scrollbar-width:none}
.mwui-memory-tabs::-webkit-scrollbar{display:none}
.mwui-memory-tabs button{position:relative;appearance:none;border:0;border-bottom:2px solid transparent;background:transparent;
  color:var(--mwui-muted);font:inherit;font-size:13px;line-height:20px;padding:6px 1px 9px;margin-bottom:-1px;white-space:nowrap;cursor:pointer}
.mwui-memory-tabs button:hover{color:inherit}
.mwui-memory-tabs button[data-active="true"]{border-bottom-color:var(--mwui-accent);color:inherit;font-weight:600}
@media (max-width:900px){
  .mwui-memory-actions{width:100%}
  .mwui-memory-actions .mwui-button{flex:1}
  .mwui-memory-tabs{gap:18px}
}
.mwui-page{display:flex;flex-direction:column;gap:12px;flex:1;min-height:0;overflow:auto}
/* The entity page fills the viewport instead of scrolling as a whole: each column scrolls
   inside itself, so the index reaches the bottom of the screen. */
.mwui-page[data-fill="true"]{overflow:hidden}
/* A page's own cards keep their content height and let the page scroll. Left shrinkable, a pane
   competes with its siblings for the viewport and the clipped one simply loses rows. */
.mwui-page>*{flex:0 0 auto}
.mwui-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.mwui-card{display:flex;flex-direction:column;gap:2px;border:1px solid var(--mwui-border);border-radius:12px;padding:10px 12px;background:var(--mwui-surface)}
.mwui-card-label{font-size:11.5px;color:var(--mwui-muted)}
.mwui-card-value{font-size:22px;font-weight:650;line-height:1.15}
.mwui-card-hint{font-size:11px;color:var(--mwui-muted)}
.mwui-pane-body{display:flex;flex-direction:column;gap:6px;padding:10px 12px}
.mwui-kv{display:flex;gap:10px;align-items:baseline;justify-content:space-between;font-size:12px}
.mwui-kv>span:first-child{color:var(--mwui-muted)}
.mwui-kv[data-tone="ok"]>span:last-child{color:rgb(63,185,80)}
.mwui-kv[data-tone="warn"]>span:last-child{color:rgb(210,153,34)}
.mwui-muted{color:var(--mwui-muted)}
.mwui-table{width:100%;border-collapse:collapse;font-size:11.5px}
.mwui-table th{text-align:left;font-weight:600;color:var(--mwui-muted);padding:4px 8px;border-bottom:1px solid var(--mwui-border);white-space:nowrap}
.mwui-table td{padding:4px 8px;border-bottom:1px dashed var(--mwui-border);vertical-align:top}
.mwui-table td[data-tone="warn"]{color:rgb(210,153,34);font-weight:600}
/* A modal form. The page behind it keeps its layout, selection and scroll position: the window is
   the only interactive surface and the underlying panes are never rewritten to host a form. */
.mwui-modal{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;
  padding:24px;background:rgba(15,17,20,.45)}
.mwui-modal-dialog{width:min(800px,100%);max-height:min(88vh,960px);display:flex;flex-direction:column;
  min-height:0;border:1px solid var(--mwui-border);border-radius:14px;background:var(--dsh-color-bg,#fff);
  box-shadow:0 18px 48px rgba(0,0,0,.35)}
.mwui-modal-dialog:focus{outline:none}
.mwui-modal-head{display:flex;align-items:center;gap:10px;padding:12px 14px;
  border-bottom:1px solid var(--mwui-border);background:var(--mwui-surface)}
.mwui-modal-title{font-weight:650;font-size:14px}
.mwui-modal-subtitle{color:var(--mwui-muted);font-size:11.5px}
.mwui-modal-close{margin-left:auto}
.mwui-modal-body{display:flex;flex-direction:column;gap:12px;padding:14px;overflow:auto;min-height:0}
@media (max-width:640px){.mwui-modal{padding:10px}.mwui-modal-dialog{max-height:94vh}}
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
