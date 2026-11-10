import type { AvailabilityStatus, UiConfigView, UiInjection, UiMemoryDetail, UiMemoryList, UiStatus } from '../shared/contract.ts';
import { translate, type Language, type MessageKey } from './i18n.ts';

export type Tone = 'ok' | 'warn' | 'bad' | 'muted';

export interface Chip { key: string; label: string; value: string; tone: Tone }

const AVAILABILITY: Record<AvailabilityStatus, MessageKey> = {
  ok: 'status.available',
  unauthorized: 'status.unauthorized',
  unavailable: 'status.unavailable',
};

const CODES: Record<string, MessageKey> = {
  UNAUTHORIZED: 'error.unauthorized',
  NOT_FOUND: 'error.notFound',
  INVALID_INPUT: 'error.invalidInput',
  PROVIDER_UNAVAILABLE: 'error.providerUnavailable',
  PROVIDER_TIMEOUT: 'error.providerTimeout',
  REVIEW_REQUIRED: 'error.reviewRequired',
  INTERNAL: 'error.internal',
  RPC_FAILED: 'error.rpcFailed',
};

const STATES = {
  active: 'state.active',
  superseded: 'state.superseded',
  unverified: 'state.unverified',
} as const satisfies Record<UiMemoryDetail['state'], MessageKey>;

export function availabilityText(status: AvailabilityStatus, language: Language): string {
  return translate(language, AVAILABILITY[status]);
}

/** Server and RPC error codes stay visible; only the wording is localized. */
export function codeText(code: string | undefined, language: Language): string {
  if (code === undefined || code === '') return translate(language, 'error.unknown');
  const key = CODES[code];
  return translate(language, key ?? 'error.unknown');
}

export function stateText(state: UiMemoryDetail['state'], language: Language): string {
  return translate(language, STATES[state]);
}

/** Absolute timestamps are shown to the second: two revisions can land in the same minute. */
export function formatDateTime(iso: string, timeZone?: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '—';
  try {
    return new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'medium', ...(timeZone === undefined ? {} : { timeZone }) }).format(new Date(time));
  } catch { return new Date(time).toISOString().slice(0, 19).replace('T', ' '); }
}

export function relativeTime(iso: string, now: number, language: Language): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '—';
  const delta = Math.max(0, now - time);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 5) return translate(language, 'time.now');
  if (seconds < 60) return translate(language, 'time.seconds', { count: seconds });
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return translate(language, 'time.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return translate(language, 'time.hours', { count: hours });
  return translate(language, 'time.days', { count: Math.floor(hours / 24) });
}

/**
 * One chip row for the page header: availability first, then the endpoint and Host identity the
 * Host half is using. The token appears only as configured or not configured.
 */
export function statusChips(status: UiStatus | null, config: UiConfigView | null, language: Language, now: number): Chip[] {
  if (status === null) return [];
  const chips: Chip[] = [
    {
      key: 'availability',
      label: translate(language, 'status.title'),
      value: availabilityText(status.status, language),
      tone: status.status === 'ok' ? 'ok' : status.status === 'unauthorized' ? 'warn' : 'bad',
    },
    { key: 'server', label: translate(language, 'status.server'), value: status.serverUrl, tone: 'muted' },
    { key: 'host', label: translate(language, 'status.host'), value: status.hostId, tone: 'muted' },
  ];
  if (config !== null) {
    chips.push({
      key: 'token',
      label: translate(language, 'status.token'),
      value: config.hasToken ? translate(language, 'status.tokenSet') : translate(language, 'status.tokenMissing'),
      tone: config.hasToken ? 'ok' : 'bad',
    });
  }
  if (status.version !== undefined) {
    chips.push({ key: 'version', label: translate(language, 'status.version'), value: status.version, tone: 'muted' });
  }
  chips.push({ key: 'checked', label: translate(language, 'status.checked'), value: relativeTime(status.checkedAt, now, language), tone: 'muted' });
  return chips;
}

/** The last View this host assembled, as the Server reported it. */
export function injectionChip(injection: UiInjection | null, language: Language): Chip {
  const label = translate(language, 'injection.label');
  if (injection === null) return { key: 'injection', label, value: translate(language, 'injection.none'), tone: 'muted' };
  const summary = translate(language, 'injection.summary', {
    rules: injection.rulesInjected,
    memories: injection.memoriesInjected,
    tokens: injection.usedTokens,
  });
  return {
    key: 'injection',
    label,
    value: injection.rulesOmitted === null ? summary : `${summary} · ${translate(language, 'injection.omitted')}`,
    tone: injection.rulesOmitted === null ? 'ok' : 'warn',
  };
}

export function listSummary(list: UiMemoryList | null, language: Language): string {
  if (list === null) return '';
  return translate(language, 'list.count', { count: list.returned });
}

export function detailMeta(detail: UiMemoryDetail, language: Language): Array<{ key: string; label: string; value: string }> {
  const current = detail.revisions.find(revision => revision.current);
  return [
    { key: 'state', label: translate(language, 'detail.state'), value: stateText(detail.state, language) },
    { key: 'revision', label: translate(language, 'detail.revision'), value: current === undefined ? '—' : `#${current.number}` },
    { key: 'scope', label: translate(language, 'detail.project'), value: detail.scope === 'global' ? translate(language, 'detail.global') : detail.projectId ?? '—' },
    { key: 'applicability', label: translate(language, 'detail.applicability'), value: detail.applicability },
    { key: 'published', label: translate(language, 'detail.published'), value: formatDateTime(detail.publishedAt) },
  ];
}
