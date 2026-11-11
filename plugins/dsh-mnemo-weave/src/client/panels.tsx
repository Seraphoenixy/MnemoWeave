import type { UiArchive, UiConfigView, UiConnectionTest, UiExplore, UiGraph, UiInjection, UiMemoryList, UiRule, UiSettings, UiStatus, UiSyncPass, UiSyncStatus, UiWakeTest } from '../shared/contract.ts';
import { translate, type Language, type MessageKey } from './i18n.ts';
import { filterEntities, formatDateTime, relativeTime, utf8Bytes } from './view-model.ts';
import { layoutGraph } from './graph-layout.ts';
import { useEffect, useState, type ReactNode } from 'react';

export type Tab = 'overview' | 'runtime' | 'archives' | 'memories' | 'entities' | 'explore' | 'graph' | 'sync' | 'settings';

export const TAB_KEYS: Record<Tab, MessageKey> = {
  overview: 'tabs.overview',
  runtime: 'tabs.runtime',
  archives: 'tabs.archives',
  memories: 'tabs.memories',
  entities: 'tabs.entities',
  explore: 'tabs.explore',
  graph: 'tabs.graph',
  sync: 'tabs.sync',
  settings: 'tabs.settings',
};

// Class order mirrors dsh-mnemon: runtime (100) → documents/archives (200) → memories (300);
// the cross-class overview stays first as this page's landing view, sync sits with the settings-like tail.
export const TAB_ORDER: readonly Tab[] = ['overview', 'runtime', 'archives', 'memories', 'entities', 'explore', 'graph', 'sync', 'settings'];

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
  onSaveInterface(patch: { defaultTab?: string; defaultScope?: string; pageSize?: number }): void;
  onSaveConnection(input: { serverUrl: string; hostId: string }): void;
  onSaveInjection(input: { projectId: string | null; injectTimeoutMs: number }): void;
  onSaveAutoStart(enabled: boolean): void;
  onTestConnection(serverUrl: string): void;
  onTestWake(): void;
}

function sourceText(source: string, language: Language): string {
  const key = `settings.source.${source}` as MessageKey;
  return translate(language, key);
}

export function SettingsPanel(props: SettingsProps): ReactNode {
  const { settings, language, busy, notice, connectionTest, wakeTest } = props;
  const [serverUrl, setServerUrl] = useState(settings.connection.serverUrl);
  const [hostId, setHostId] = useState(settings.connection.hostId);
  const [projectId, setProjectId] = useState(settings.injection.projectId ?? '');
  const [timeoutMs, setTimeoutMs] = useState(String(settings.injection.injectTimeoutMs));
  // Follow the saved values when a group is applied elsewhere; the drafts are what the user typed.
  useEffect(() => { setServerUrl(settings.connection.serverUrl); }, [settings.connection.serverUrl]);
  useEffect(() => { setHostId(settings.connection.hostId); }, [settings.connection.hostId]);
  useEffect(() => { setProjectId(settings.injection.projectId ?? ''); }, [settings.injection.projectId]);
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
              <label htmlFor="mwui-default-scope">{translate(language, 'settings.defaultScope')}</label>
              <input
                id="mwui-default-scope"
                className="mwui-input"
                value={settings.interface.defaultScope}
                onChange={event => props.onSaveInterface({ defaultScope: event.target.value })}
              />
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
            <div className="mwui-edit-actions">
              <button type="button" className="mwui-button" onClick={props.onTestWake} disabled={busy}>
                {translate(language, 'settings.testWake')}
              </button>
            </div>
          </div>

          {/* Injection: project and budget apply together, as one group. */}
          <div className="mwui-settings-group">
            <h4 className="mwui-section-title">{translate(language, 'settings.injection')}</h4>
            <div className="mwui-settings-row">
              <label htmlFor="mwui-inject-project">{translate(language, 'settings.injectProject')}</label>
              <input
                id="mwui-inject-project"
                className="mwui-input"
                value={projectId}
                placeholder={translate(language, 'settings.injectProjectNone')}
                onChange={event => setProjectId(event.target.value)}
              />
              <span className="mwui-source">{sourceText(settings.injection.source, language)}</span>
            </div>
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
                onClick={() => props.onSaveInjection({ projectId: projectId.trim() === '' ? null : projectId.trim(), injectTimeoutMs: parsedTimeout })}
                disabled={busy || !timeoutValid}
              >
                {translate(language, 'settings.applyInjection')}
              </button>
            </div>
          </div>

          {/* Diagnostics: read-only; the sync tab owns the actions. */}
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

export function GraphPanel(props: GraphProps): ReactNode {
  const { graph, loading, error, language, focusId } = props;
  const layout = graph === null ? null : layoutGraph(graph, focusId === null ? {} : { focusId });
  return (
    <div className="mwui-page">
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
    </div>
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
  scope: 'global' | 'project';
  projectId: string;
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
}

const KNOWLEDGE_TYPES = ['Concept', 'Practice', 'Architecture', 'Troubleshooting', 'Constraint', 'Procedure', 'Reference'] as const;
const CATEGORY_VALUES = ['preference', 'decision', 'fact', 'insight', 'context', 'general'] as const;

export function CreateMemoryForm(props: CreateMemoryFormProps): ReactNode {
  const { draft, busy, error, language } = props;
  const bytes = utf8Bytes(draft.content);
  return (
    <section className="mwui-create" aria-label={translate(language, 'create.title')}>
      <div className="mwui-pane-header">
        <span className="mwui-pane-title">{translate(language, 'create.title')}</span>
        <span className="mwui-pane-count" data-tone={bytes > 8000 ? 'bad' : 'muted'}>
          {bytes}/8000 B
        </span>
      </div>
      <div className="mwui-detail">
        <div className="mwui-edit-hint" data-tone="muted">{translate(language, 'create.hint')}</div>
        <textarea
          className="mwui-textarea"
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
        <div className="mwui-classify">
          <label className="mwui-classify-field">
            <span>{translate(language, 'create.scope')}</span>
            <select
              className="mwui-input mwui-select"
              value={draft.scope}
              onChange={event => props.onChange({ scope: event.target.value === 'project' ? 'project' : 'global' })}
            >
              <option value="global">{translate(language, 'detail.global')}</option>
              <option value="project">{translate(language, 'detail.project')}</option>
            </select>
          </label>
          {draft.scope === 'project' ? (
            <label className="mwui-classify-field">
              <span>{translate(language, 'create.projectId')}</span>
              <input
                className="mwui-input"
                type="text"
                value={draft.projectId}
                placeholder="alpha"
                onChange={event => props.onChange({ projectId: event.target.value })}
              />
            </label>
          ) : null}
        </div>
        <input
          className="mwui-input"
          type="text"
          value={draft.reason}
          placeholder={translate(language, 'create.reasonPlaceholder')}
          aria-label={translate(language, 'detail.reason')}
          onChange={event => props.onChange({ reason: event.target.value })}
        />
        {error === null ? null : <div className="mwui-inline-error" role="alert">{error}</div>}
        <div className="mwui-actions">
          <button type="button" className="mwui-button" data-variant="primary" onClick={props.onSubmit} disabled={busy || draft.content.trim() === ''}>
            {translate(language, busy ? 'create.saving' : 'create.submit')}
          </button>
          <button type="button" className="mwui-button" onClick={props.onCancel} disabled={busy}>
            {translate(language, 'detail.cancel')}
          </button>
        </div>
      </div>
    </section>
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
                          <span className="mwui-chip-slim">{translate(language, hit.scope === 'global' ? 'detail.global' : 'detail.project')}</span>
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
