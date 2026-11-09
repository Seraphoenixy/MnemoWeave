import type { UiGrantView, UiIntents, UiMemoryDetail, UiMemoryList, UiReplicaView, UiStatus } from '../shared/contract.ts';
import { translate, type Language, type MessageKey } from './i18n.ts';

export type Tone = 'ok' | 'warn' | 'bad' | 'muted';

export interface Chip { key: string; label: string; value: string; tone: Tone }

export function availabilityText(status: string, language: Language): string {
  switch (status) {
    case 'ok': return language === 'zh' ? '正常' : 'OK';
    case 'unauthorized': return language === 'zh' ? '未授权' : 'Unauthorized';
    case 'unavailable': return language === 'zh' ? '不可用' : 'Unavailable';
    case 'corrupted': return language === 'zh' ? '已损坏' : 'Corrupted';
    default: return translate(language, 'reason.default');
  }
}

const REASONS: Record<string, MessageKey> = {
  unpaired: 'reason.unpaired',
  revoked: 'reason.revoked',
  license_expired: 'reason.licenseExpired',
  no_replica: 'reason.noReplica',
  'integrity check failed': 'reason.corrupted',
  'content integrity check failed': 'reason.corrupted',
  out_of_grant: 'reason.outOfGrant',
  not_found: 'reason.notFound',
};

export function reasonText(reason: string | undefined, language: Language): string {
  if (reason === undefined || reason === '') return translate(language, 'reason.default');
  const key = REASONS[reason];
  return key === undefined ? translate(language, 'reason.default') : translate(language, key);
}

export function formatDateTime(iso: string, timeZone?: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '—';
  try {
    return new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short', ...(timeZone === undefined ? {} : { timeZone }) }).format(new Date(time));
  } catch { return new Date(time).toISOString().slice(0, 16).replace('T', ' '); }
}

export function relativeTime(iso: string, now: number, language: Language): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '—';
  const delta = Math.max(0, now - time);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return translate(language, 'time.now');
  if (minutes < 60) return translate(language, 'time.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return translate(language, 'time.hours', { count: hours });
  return translate(language, 'time.days', { count: Math.floor(hours / 24) });
}

/** `*` is the operator's all-projects grant; it is shown as written, never expanded. */
export function scopeText(projects: readonly string[], globalIncluded: boolean, language: Language): string {
  const projectsText = projects.includes('*') ? (language === 'zh' ? '全部项目' : 'all projects') : projects.join(', ');
  const globalText = globalIncluded ? (language === 'zh' ? '含全局' : 'with global') : (language === 'zh' ? '仅项目' : 'projects only');
  return `${projectsText} · ${globalText}`;
}

export function grantChips(grant: UiGrantView | null, language: Language, now: number): Chip[] {
  if (grant === null) return [{ key: 'paired', label: translate(language, 'status.title'), value: translate(language, 'status.unpaired'), tone: 'bad' }];
  const expired = grant.expired || Date.parse(grant.expiresAt) <= now;
  const state: Chip = grant.revoked
    ? { key: 'revoked', label: translate(language, 'status.revoked'), value: '', tone: 'bad' }
    : expired
      ? { key: 'expired', label: translate(language, 'status.expired'), value: '', tone: 'bad' }
      : { key: 'paired', label: translate(language, 'status.paired'), value: '', tone: 'ok' };
  return [
    state,
    { key: 'scope', label: translate(language, 'status.scope'), value: scopeText(grant.projects, grant.globalIncluded, language), tone: 'muted' },
    { key: 'expires', label: translate(language, 'status.expires'), value: formatDateTime(grant.expiresAt), tone: expired ? 'bad' : 'muted' },
    { key: 'generation', label: translate(language, 'status.generation'), value: String(grant.generation), tone: 'muted' },
  ];
}

export function replicaChips(replica: UiReplicaView | null, language: Language, now: number): Chip[] {
  if (replica === null) return [{ key: 'replica', label: translate(language, 'status.replica'), value: translate(language, 'status.replicaMissing'), tone: 'warn' }];
  if (replica.corrupted) return [{ key: 'replica', label: translate(language, 'status.replica'), value: translate(language, 'reason.corrupted'), tone: 'bad' }];
  const stale = replica.stale || now - Date.parse(replica.dataTime) > 10 * 60_000;
  return [
    { key: 'replica', label: translate(language, 'status.replica'), value: translate(language, 'status.replicaAvailable'), tone: replica.available ? 'ok' : 'bad' },
    { key: 'freshness', label: translate(language, 'status.replica'), value: stale ? translate(language, 'status.stale') : translate(language, 'status.fresh'), tone: stale ? 'warn' : 'ok' },
    { key: 'seq', label: translate(language, 'status.seq'), value: String(replica.appliedSeq), tone: 'muted' },
    { key: 'memories', label: translate(language, 'status.memories'), value: String(replica.memories), tone: 'muted' },
    { key: 'revisions', label: translate(language, 'status.revisions'), value: String(replica.revisions), tone: 'muted' },
    { key: 'pending', label: translate(language, 'status.pending'), value: String(replica.pendingContent), tone: replica.pendingContent > 0 ? 'warn' : 'muted' },
  ];
}

export function statusChips(status: UiStatus | null, language: Language, now: number): Chip[] {
  if (status === null) return [];
  return [...grantChips(status.grant, language, now), ...replicaChips(status.replica, language, now)];
}

export function listSummary(list: UiMemoryList | null, language: Language): string {
  if (list === null) return '';
  if (list.status !== 'ok') return `${availabilityText(list.status, language)} · ${reasonText(list.reason, language)}`;
  const base = translate(language, 'list.count', { count: list.returned });
  return list.complete ? base : `${base} · ${translate(language, 'list.incomplete')}`;
}

export function detailMeta(detail: UiMemoryDetail, language: Language): Array<{ key: string; label: string; value: string }> {
  return [
    { key: 'state', label: translate(language, 'detail.revision'), value: detail.state },
    { key: 'scope', label: translate(language, 'detail.project'), value: detail.scope === 'global' ? translate(language, 'detail.global') : detail.projectId ?? '—' },
    { key: 'applicability', label: translate(language, 'detail.applicability'), value: detail.applicability },
  ];
}

export function intentsSummary(intents: UiIntents | null, language: Language): string {
  if (intents === null) return '';
  return `${translate(language, 'intents.queued')} ${intents.queued} · ${translate(language, 'intents.isolated')} ${intents.isolated}`;
}
