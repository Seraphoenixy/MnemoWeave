import type { AvailabilityStatus, UiConfigView, UiGraphEdge, UiInjection, UiMemoryConflict, UiMemoryDetail, UiMemoryList, UiMemoryRevision, UiStatus } from '../shared/contract.ts';
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

/**
 * Meta chips for the detail panel.
 *
 * "Revision" describes the version being viewed, not the live one: the page can show a
 * historical revision, and labelling it with the current number would misreport what the user
 * is reading. A separate chip states whether the viewed revision is still the current one.
 */
export function detailMeta(detail: UiMemoryDetail, language: Language): Array<{ key: string; label: string; value: string }> {
  const viewed = detail.revisions.find(revision => revision.revisionId === detail.revisionId);
  const current = detail.revisions.find(revision => revision.current);
  return [
    { key: 'state', label: translate(language, 'detail.state'), value: stateText(detail.state, language) },
    { key: 'revision', label: translate(language, 'detail.revision'), value: viewed === undefined ? '—' : `#${viewed.number}` },
    {
      key: 'currentness',
      label: translate(language, 'detail.viewing'),
      value: detail.isCurrent
        ? translate(language, 'detail.viewingCurrent')
        : translate(language, 'detail.viewingHistory', { number: current === undefined ? '—' : `#${current.number}` }),
    },
    { key: 'applicability', label: translate(language, 'detail.applicability'), value: detail.applicability },
    { key: 'published', label: translate(language, 'detail.published'), value: formatDateTime(detail.publishedAt) },
  ];
}

/** UTF-8 byte length, matching the Server's own limit rather than the string length. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export const EDIT_LIMIT_BYTES = 8_000;

/**
 * Whether the edit form may be submitted, and why not. Checked before the request so the user
 * learns about an empty, oversized or unchanged body without a round trip.
 */
export function editBlocker(draft: string, original: string): 'empty' | 'tooLong' | 'unchanged' | null {
  if (draft.trim() === '') return 'empty';
  if (utf8Bytes(draft) > EDIT_LIMIT_BYTES) return 'tooLong';
  if (draft === original) return 'unchanged';
  return null;
}

/**
 * Relations as the detail view shows them: which side this memory is on, which memory to open,
 * and whether the edge exists in the Provider too. A relation stored only in the catalog is not
 * yet projected natively, and saying so avoids implying the Provider agrees.
 */
export interface RelationRow {
  relationId: string;
  kind: 'Supersedes' | 'RelatedTo';
  /** `out` means this memory is the source and points at the other one. */
  direction: 'out' | 'in';
  otherMemoryId: string;
  otherRevisionId: string;
  reason: string;
  evidence: string[];
  nativeProjected: boolean;
  effectiveAt: string;
}

export function relationRows(detail: UiMemoryDetail): RelationRow[] {
  return detail.relations.map(relation => {
    const source = relation.sourceMemoryId === detail.memoryId;
    return {
      relationId: relation.relationId,
      kind: relation.kind,
      direction: source ? 'out' : 'in',
      otherMemoryId: source ? relation.targetMemoryId : relation.sourceMemoryId,
      otherRevisionId: source ? relation.targetRevisionId : relation.sourceRevisionId,
      reason: relation.reason,
      evidence: relation.evidence,
      nativeProjected: relation.nativeProjected,
      effectiveAt: relation.effectiveAt,
    };
  });
}

/**
 * Walk the relation graph outward from one memory.
 *
 * Breadth-first up to `depth` hops, and each discovered memory is reported once at the **shortest**
 * hop it was reached at: showing the same memory twice at different distances would suggest two
 * relationships where the data has one. A node reached by several paths keeps the first edge that
 * found it, which is why the walk records the edge rather than only the id.
 */
export function neighbourhood(
  graph: { nodes: Array<{ memoryId: string }>; edges: UiGraphEdge[] },
  memoryId: string,
  depth = 2,
): Array<{ memoryId: string; hop: number; kind: 'Supersedes' | 'RelatedTo' | 'Conflicts'; direction: 'out' | 'in'; reason: string }> {
  const found = new Map<string, { hop: number; kind: 'Supersedes' | 'RelatedTo' | 'Conflicts'; direction: 'out' | 'in'; reason: string }>();
  if (!graph.nodes.some(node => node.memoryId === memoryId)) return [];
  let frontier = [memoryId];
  for (let hop = 1; hop <= depth; hop += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const edge of graph.edges) {
        // An edge can be walked in either direction: the graph is undirected for reading, even
        // though a supersedes edge has a direction that matters when it is displayed.
        const outward = edge.sourceMemoryId === current ? edge.targetMemoryId : edge.targetMemoryId === current ? edge.sourceMemoryId : null;
        if (outward === null || outward === memoryId || found.has(outward)) continue;
        found.set(outward, {
          hop,
          kind: edge.kind,
          direction: edge.sourceMemoryId === current ? 'out' : 'in',
          reason: edge.reason,
        });
        next.push(outward);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return [...found].map(([id, value]) => ({ memoryId: id, ...value })).sort((left, right) => left.hop - right.hop || left.memoryId.localeCompare(right.memoryId));
}

/**
 * Filter the entity index by a typed name.
 *
 * Matching is a case-insensitive substring, the same rule the Server uses when applying an entity
 * filter, so what the page offers and what the list returns cannot disagree about "same entity".
 * An empty query keeps everything rather than nothing.
 */
export function filterEntities(
  entities: Array<{ value: string; count: number }>,
  query: string,
): Array<{ value: string; count: number }> {
  const needle = query.trim().toLowerCase();
  if (needle === '') return entities;
  return entities.filter(item => item.value.toLowerCase().includes(needle));
}

/**
 * Classification chips for the revision being viewed.
 *
 * A local Remember records a `knowledgeType`; a synced entry records `category`, `importance`,
 * tags and entities. The two dimensions are shown separately and only when present, so "never
 * recorded" never looks like "recorded as empty".
 */
export function classificationMeta(detail: UiMemoryDetail, language: Language): Array<{ key: string; label: string; value: string }> {
  const revision = detail.revisions.find(item => item.revisionId === detail.revisionId);
  if (revision === undefined) return [];
  const rows: Array<{ key: string; label: string; value: string }> = [];
  if (revision.knowledgeType !== undefined) {
    rows.push({ key: 'knowledgeType', label: translate(language, 'detail.knowledgeType'), value: revision.knowledgeType });
  }
  if (revision.category !== undefined) {
    rows.push({ key: 'category', label: translate(language, 'detail.category'), value: translate(language, `category.${revision.category}` as MessageKey) });
  }
  if (revision.importance !== undefined) {
    rows.push({ key: 'importance', label: translate(language, 'detail.importance'), value: `${revision.importance}/5` });
  }
  return rows;
}

/** Tags and entities are lists, so they get their own row rather than a comma-joined chip. */
export function classificationLists(detail: UiMemoryDetail): { tags: string[]; entities: string[] } {
  const revision = detail.revisions.find(item => item.revisionId === detail.revisionId);
  return { tags: revision?.tags ?? [], entities: revision?.entities ?? [] };
}

/**
 * The revision chain of a memory in publication order, oldest first. `parentId` comes from the
 * catalog, so a gap in the chain (a revision whose parent is missing) is visible rather than
 * silently smoothed over.
 */
export function revisionTimeline(detail: UiMemoryDetail): Array<UiMemoryRevision & { chained: boolean }> {
  const byId = new Map(detail.revisions.map(revision => [revision.revisionId, revision]));
  return [...detail.revisions]
    .sort((left, right) => left.number - right.number)
    .map(revision => ({
      ...revision,
      // The first revision has no parent; every later one must name a parent we can see.
      chained: revision.number === 1 || (revision.parentId !== null && byId.has(revision.parentId)),
    }));
}

/** Open conflicts only: a resolved case is history, not something needing attention. */
export function openConflicts(detail: UiMemoryDetail): UiMemoryConflict[] {
  return detail.conflicts.filter(conflict => conflict.state !== 'resolved');
}

/**
 * A line-level comparison of two bodies, for the conflict and history views.
 *
 * Deliberately simple: it marks whole lines as added or removed. The point is to show what the
 * draft changes, not to be a merge engine.
 */
export interface DiffLine { kind: 'same' | 'added' | 'removed'; text: string }

export function diffLines(before: string, after: string): DiffLine[] {
  const left = before.split('\n');
  const right = after.split('\n');
  const rows: DiffLine[] = [];
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const beforeLine = left[index];
    const afterLine = right[index];
    if (beforeLine === afterLine) {
      if (beforeLine !== undefined) rows.push({ kind: 'same', text: beforeLine });
      continue;
    }
    if (beforeLine !== undefined) rows.push({ kind: 'removed', text: beforeLine });
    if (afterLine !== undefined) rows.push({ kind: 'added', text: afterLine });
  }
  return rows;
}
