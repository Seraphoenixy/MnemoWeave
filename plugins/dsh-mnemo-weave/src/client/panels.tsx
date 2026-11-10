import type { UiArchive, UiConfigView, UiInjection, UiMemoryList, UiRule, UiStatus, UiSyncPass, UiSyncStatus } from '../shared/contract.ts';
import { translate, type Language, type MessageKey } from './i18n.ts';
import { formatDateTime, relativeTime } from './view-model.ts';
import type { ReactNode } from 'react';

export type Tab = 'overview' | 'runtime' | 'archives' | 'memories' | 'sync';

export const TAB_KEYS: Record<Tab, MessageKey> = {
  overview: 'tabs.overview',
  runtime: 'tabs.runtime',
  archives: 'tabs.archives',
  memories: 'tabs.memories',
  sync: 'tabs.sync',
};

// Class order mirrors dsh-mnemon: runtime (100) → documents/archives (200) → memories (300);
// the cross-class overview stays first as this page's landing view, sync sits with the settings-like tail.
export const TAB_ORDER: readonly Tab[] = ['overview', 'runtime', 'archives', 'memories', 'sync'];

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

function scopeLabel(value: string, language: Language): string {
  return value === 'global' ? translate(language, 'common.global') : value;
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
  const projects = new Set<string>();
  for (const item of memories?.items ?? []) if (item.projectId !== undefined) projects.add(item.projectId);
  for (const rule of rules ?? []) if (rule.projectId !== null) projects.add(rule.projectId);
  for (const archive of archives ?? []) projects.add(archive.projectId);
  const scopes = new Set<string>();
  for (const item of memories?.items ?? []) scopes.add(item.scope === 'global' ? 'global' : `project:${item.projectId ?? '—'}`);
  for (const rule of rules ?? []) scopes.add(rule.scope === 'global' ? 'global' : `project:${rule.projectId ?? '—'}`);

  return (
    <div className="mwui-page">
      <div className="mwui-grid">
        <Card label={translate(language, 'overview.memories')} value={memories === null || memories === undefined ? '—' : String(memories.items.length)} hint={translate(language, 'overview.openMemories')} />
        <Card label={translate(language, 'overview.runtime')} value={countOf(rules)} hint={translate(language, 'overview.openRules')} />
        <Card label={translate(language, 'overview.archives')} value={countOf(archives)} hint={translate(language, 'overview.openArchives')} />
        <Card label={translate(language, 'overview.projects')} value={String(projects.size)} hint={translate(language, 'overview.scopes', { count: scopes.size })} />
      </div>

      <section className="mwui-pane">
        <div className="mwui-pane-header"><span className="mwui-pane-title">{translate(language, 'overview.injection')}</span></div>
        <div className="mwui-pane-body">
          {injection === null
            ? <span className="mwui-muted">{translate(language, 'injection.none')}</span>
            : (
              <>
                <div className="mwui-kv"><span>{translate(language, 'injection.rules')}</span><span>{injection.rulesInjected}</span></div>
                <div className="mwui-kv"><span>{translate(language, 'injection.memories')}</span><span>{injection.memoriesInjected}</span></div>
                <div className="mwui-kv"><span>{translate(language, 'injection.tokens')}</span><span>{injection.usedTokens}</span></div>
                <div className="mwui-kv"><span>{translate(language, 'injection.session')}</span><span className="mwui-mono">{injection.sessionId}</span></div>
                <div className="mwui-kv"><span>{translate(language, 'injection.at')}</span><span>{formatDateTime(injection.createdAt)} · {relativeTime(injection.createdAt, now, language)}</span></div>
                {injection.rulesOmitted === null ? null : <div className="mwui-kv" data-tone="warn"><span>{translate(language, 'injection.omitted')}</span><span>{injection.rulesOmitted}</span></div>}
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
                  <div className="mwui-kv"><span>{translate(language, 'sync.scopes')}</span><span>{sync.scopes.length}</span></div>
                  <div className="mwui-kv"><span>{translate(language, 'sync.pending')}</span><span>{sync.scopes.reduce((sum, item) => sum + item.pending, 0)}</span></div>
                  <div className="mwui-kv"><span>{translate(language, 'sync.unapplied')}</span><span>{sync.scopes.reduce((sum, item) => sum + item.unapplied, 0)}</span></div>
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

export interface RuntimeProps { rules: UiRule[] | null | undefined; error: string | null; selected: string | null; language: Language; onSelect(id: string): void }

/** Rules are read-only here: writing them belongs to the operator credential. */
export function RuntimePanel({ rules, error, selected, language, onSelect }: RuntimeProps): ReactNode {
  const current = (rules ?? []).find(rule => rule.entryId === selected) ?? null;
  return (
    <div className="mwui-body">
      <section className="mwui-pane" aria-label={translate(language, 'runtime.title')}>
        <div className="mwui-pane-header">
          <span className="mwui-pane-title">{translate(language, 'runtime.title')}</span>
          <span className="mwui-pane-count">{countOf(rules)}</span>
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
                  <button type="button" className="mwui-item" data-active={rule.entryId === selected ? 'true' : 'false'} onClick={() => onSelect(rule.entryId)}>
                    <span className="mwui-item-title">{rule.body.split('\n')[0] ?? rule.entryId}</span>
                    <span className="mwui-item-excerpt">{rule.body}</span>
                    <span className="mwui-item-meta">
                      <span>{rule.scope === 'global' ? translate(language, 'common.global') : rule.projectId ?? '—'}</span>
                      <span>·</span>
                      <span>{rule.enabled ? translate(language, 'common.enabled') : translate(language, 'common.disabled')}</span>
                      <span>·</span>
                      <span>{translate(language, 'common.version')} {rule.version}</span>
                    </span>
                  </button>
                </li>
              ))}
        </ul>
      </section>

      <section className="mwui-pane" aria-label={translate(language, 'runtime.detail')}>
        <div className="mwui-pane-header"><span className="mwui-pane-title">{translate(language, 'runtime.detail')}</span></div>
        {current === null
          ? <div className="mwui-empty">{translate(language, 'runtime.placeholder')}</div>
          : (
            <div className="mwui-detail">
              <div className="mwui-chips">
                <span className="mwui-chip"><span className="mwui-chip-label">{translate(language, 'runtime.scope')}</span><span className="mwui-chip-value">{current.scope === 'global' ? translate(language, 'common.global') : current.projectId ?? '—'}</span></span>
                <span className="mwui-chip"><span className="mwui-chip-label">{translate(language, 'common.version')}</span><span className="mwui-chip-value">{current.version}</span></span>
                <span className="mwui-chip" data-tone={current.enabled ? 'ok' : 'warn'}><span className="mwui-chip-label">{translate(language, 'runtime.state')}</span><span className="mwui-chip-value">{current.enabled ? translate(language, 'common.enabled') : translate(language, 'common.disabled')}</span></span>
              </div>
              <div>
                <h4 className="mwui-section-title">{translate(language, 'runtime.body')}</h4>
                <div className="mwui-content">{current.body}</div>
              </div>
              <div className="mwui-edit-hint" data-tone="muted">{translate(language, 'runtime.hint')}</div>
            </div>
          )}
      </section>
    </div>
  );
}

export interface ArchivesProps { archives: UiArchive[] | null | undefined; error: string | null; selected: string | null; language: Language; onSelect(id: string): void }

/** Archives are read-only here: writing them belongs to the operator credential. */
export function ArchivesPanel({ archives, error, selected, language, onSelect }: ArchivesProps): ReactNode {
  const current = (archives ?? []).find(archive => archive.entryId === selected) ?? null;
  return (
    <div className="mwui-body">
      <section className="mwui-pane" aria-label={translate(language, 'archives.title')}>
        <div className="mwui-pane-header">
          <span className="mwui-pane-title">{translate(language, 'archives.title')}</span>
          <span className="mwui-pane-count">{countOf(archives)}</span>
        </div>
        <ul className="mwui-list">
          {archives === undefined
            ? <li className="mwui-empty">{translate(language, 'list.loading')}</li>
            : archives === null
              ? <li className="mwui-empty">{translate(language, 'panel.unavailable')}{error === null ? '' : ` · ${error}`}</li>
            : archives.length === 0
              ? <li className="mwui-empty">{translate(language, 'archives.empty')}</li>
              : archives.map(archive => (
                <li key={archive.entryId}>
                  <button type="button" className="mwui-item" data-active={archive.entryId === selected ? 'true' : 'false'} onClick={() => onSelect(archive.entryId)}>
                    <span className="mwui-item-title">{archive.title}</span>
                    <span className="mwui-item-excerpt">{archive.body}</span>
                    <span className="mwui-item-meta">
                      <span>{archive.projectId}</span>
                      <span>·</span>
                      <span>{verificationText(archive.verification, language)}</span>
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
              <div className="mwui-chips">
                <span className="mwui-chip"><span className="mwui-chip-label">{translate(language, 'common.project')}</span><span className="mwui-chip-value">{current.projectId}</span></span>
                <span className="mwui-chip"><span className="mwui-chip-label">{translate(language, 'archives.source')}</span><span className="mwui-chip-value">{current.source}</span></span>
                <span className="mwui-chip" data-tone={current.verification === 'verified' ? 'ok' : 'warn'}><span className="mwui-chip-label">{translate(language, 'archives.verification')}</span><span className="mwui-chip-value">{verificationText(current.verification, language)}</span></span>
                <span className="mwui-chip"><span className="mwui-chip-label">{translate(language, 'common.version')}</span><span className="mwui-chip-value">{current.version}</span></span>
              </div>
              <div>
                <h4 className="mwui-section-title">{translate(language, 'archives.body')}</h4>
                <div className="mwui-content">{current.body}</div>
              </div>
              <div>
                <h4 className="mwui-section-title">{translate(language, 'archives.evidence')}</h4>
                <div className="mwui-content mwui-muted">{current.evidence}</div>
              </div>
            </div>
          )}
      </section>
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

/** This local Server against the remote sync Server, one row per scope. */
export function SyncPanel({ sync, error, pass, language, busy, onRefresh }: SyncProps): ReactNode {
  const enabled = sync !== null && sync !== undefined && sync.enabled;
  return (
    <div className="mwui-page">
      <section className="mwui-pane">
        <div className="mwui-pane-header">
          <span className="mwui-pane-title">{translate(language, 'sync.title')}</span>
          <span className="mwui-pane-count">{sync === null || sync === undefined ? '' : relativeTime(sync.updatedAt, Date.now(), language)}</span>
          <button type="button" className="mwui-button mwui-mini" onClick={onRefresh} disabled={busy || !enabled}>
            {busy ? translate(language, 'sync.refreshing') : translate(language, 'sync.refresh')}
          </button>
        </div>
        <div className="mwui-pane-body">
          {sync === undefined
            ? <span className="mwui-muted">{translate(language, 'list.loading')}</span>
            : sync === null
              ? <span className="mwui-muted">{error === 'REVIEW_REQUIRED' ? translate(language, 'sync.off') : `${translate(language, 'panel.unavailable')}${error === null ? '' : ` · ${error}`}`}</span>
            : (
              <>
                {pass === null ? null : (
                  <div className="mwui-kv" data-tone={pass.errors.length === 0 ? 'ok' : 'warn'}>
                    <span>{translate(language, 'sync.pass')}</span>
                    <span>{translate(language, 'sync.passResult', { scopes: pass.scopes.length, pulled: pass.pulled, applied: pass.applied })}{pass.errors.length === 0 ? '' : ` · ${pass.errors.join(', ')}`}</span>
                  </div>
                )}
                {enabled ? (
                  <table className="mwui-table">
                    <thead>
                      <tr>
                        <th>{translate(language, 'sync.scope')}</th>
                        <th>{translate(language, 'sync.cursor')}</th>
                        <th>{translate(language, 'sync.pending')}</th>
                        <th>{translate(language, 'sync.unknown')}</th>
                        <th>{translate(language, 'sync.unapplied')}</th>
                        <th>{translate(language, 'sync.lastPull')}</th>
                        <th>{translate(language, 'sync.lastError')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sync.scopes.length === 0
                        ? <tr><td colSpan={7}>{translate(language, 'sync.empty')}</td></tr>
                        : sync.scopes.map(scope => (
                          <tr key={scope.scope}>
                            <td className="mwui-mono">{scopeLabel(scope.scope, language)}</td>
                            <td>{scope.cursor}</td>
                            <td data-tone={scope.pending > 0 ? 'warn' : undefined}>{scope.pending}</td>
                            <td data-tone={scope.unknown > 0 ? 'warn' : undefined}>{scope.unknown}</td>
                            <td data-tone={scope.unapplied > 0 ? 'warn' : undefined}>{scope.unapplied}</td>
                            <td>{scope.lastPullAt === null ? '—' : formatDateTime(scope.lastPullAt)}</td>
                            <td>{scope.lastError === null ? '—' : scope.lastError}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                ) : <span className="mwui-muted">{translate(language, 'sync.off')}</span>}
              </>
            )}
        </div>
      </section>
    </div>
  );
}
