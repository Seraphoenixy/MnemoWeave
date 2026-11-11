import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLanguage, translate } from '../../plugins/dsh-mnemo-weave/src/client/i18n.ts';
import {
  availabilityText, codeText, detailMeta, editBlocker, filterEntities, formatDateTime, injectionChip, listSummary,
  neighbourhood, relativeTime, stateText, statusChips, utf8Bytes, type Chip,
} from '../../plugins/dsh-mnemo-weave/src/client/view-model.ts';
import type { UiConfigView, UiInjection, UiMemoryDetail, UiMemoryList, UiMemoryRevision, UiStatus } from '../../plugins/dsh-mnemo-weave/src/shared/contract.ts';

const NOW = Date.parse('2026-11-09T03:00:00.000Z');

const status = (overrides: Partial<UiStatus> = {}): UiStatus => ({
  status: 'ok', serverUrl: 'http://127.0.0.1:4317', hostId: 'dsh',
  checkedAt: '2026-11-09T02:59:30.000Z', version: '0.2.13',
  server: { phase: 'connected', taskRun: false }, ...overrides,
});

const config: UiConfigView = { serverUrl: 'http://127.0.0.1:4317', hostId: 'dsh', hasToken: true };

/** One revision row with the metadata the detail view renders. */
const rev = (revisionId: string, number: number, publishedAt: string, flags: Partial<UiMemoryRevision> = {}): UiMemoryRevision => ({
  revisionId, number, parentId: null, contentHash: 'a'.repeat(64), candidateId: '44444444-4444-4444-8444-444444444444',
  publishedAt, effectiveAt: publishedAt, current: false, selected: false, ...flags,
});

const detail = (overrides: Partial<UiMemoryDetail> = {}): UiMemoryDetail => ({
  memoryId: '11111111-1111-4111-8111-111111111111',
  revisionId: '22222222-2222-4222-8222-222222222222',
  currentRevisionId: '22222222-2222-4222-8222-222222222222',
  isCurrent: true,
  providerMemoryId: 'provider-1',
  applicability: 'release',
  projectId: null,
  state: 'active',
  content: 'x',
  publishedAt: '2026-11-09T02:00:00.000Z',
  entryVersion: 0,
  relations: [],
  conflicts: [],
  revisions: [
    rev('22222222-2222-4222-8222-222222222222', 2, '2026-11-09T02:00:00.000Z', { current: true, selected: true, parentId: '33333333-3333-4333-8333-333333333333' }),
    rev('33333333-3333-4333-8333-333333333333', 1, '2026-11-08T02:00:00.000Z'),
  ],
  ...overrides,
});

test('localized text falls back to language and interpolates counts', () => {
  assert.equal(normalizeLanguage('zh-CN'), 'zh');
  assert.equal(normalizeLanguage('en-US'), 'en');
  assert.equal(normalizeLanguage(undefined), 'en');
  assert.equal(translate('zh', 'list.count', { count: 3 }), '3 条');
  assert.equal(translate('en', 'list.count', { count: 3 }), '3 items');
  assert.equal(translate('en', 'time.minutes', { count: 5 }), '5 min ago');
});

test('relative time and timestamps degrade to a dash for invalid input', () => {
  assert.equal(relativeTime('2026-11-09T02:59:59.000Z', NOW, 'en'), 'just now');
  assert.equal(relativeTime('2026-11-09T02:59:30.000Z', NOW, 'en'), '30 s ago');
  assert.equal(relativeTime('2026-11-09T02:30:00.000Z', NOW, 'en'), '30 min ago');
  assert.equal(relativeTime('2026-11-09T00:00:00.000Z', NOW, 'zh'), '3 小时前');
  assert.equal(relativeTime('2026-11-07T00:00:00.000Z', NOW, 'en'), '2 d ago');
  assert.equal(relativeTime('not-a-date', NOW, 'en'), '—');
  assert.equal(formatDateTime('not-a-date'), '—');
  assert.match(formatDateTime('2026-11-09T03:04:00.000Z'), /^2026-11-0[89] \d{2}:04:00$/);
  assert.equal(relativeTime('2026-11-09T02:59:30.000Z', NOW, 'zh'), '30 秒前');
  assert.equal(relativeTime('2026-11-09T02:59:30.000Z', NOW, 'en'), '30 s ago');
});

test('status chips name availability, endpoint, host and token state without the token value', () => {
  const chips: Chip[] = statusChips(status(), config, 'en', NOW);
  assert.deepEqual(chips.map(chip => chip.key), ['availability', 'server', 'host', 'token', 'version', 'checked']);
  assert.equal(chips[0]?.value, 'Available');
  assert.equal(chips[0]?.tone, 'ok');
  assert.equal(chips.find(chip => chip.key === 'server')?.value, 'http://127.0.0.1:4317');
  assert.equal(chips.find(chip => chip.key === 'host')?.value, 'dsh');
  assert.equal(chips.find(chip => chip.key === 'token')?.value, 'Configured');
  assert.equal(chips.find(chip => chip.key === 'checked')?.value, '30 s ago');

  const unauthorized = statusChips(status({ status: 'unauthorized', reason: 'UNAUTHORIZED' }), config, 'zh', NOW);
  assert.equal(unauthorized[0]?.value, '未授权');
  assert.equal(unauthorized[0]?.tone, 'warn');

  const withoutVersion: UiStatus = {
    status: 'unavailable', reason: 'PROVIDER_UNAVAILABLE', serverUrl: 'http://127.0.0.1:4317',
    hostId: 'dsh', checkedAt: '2026-11-09T02:59:30.000Z',
    server: { phase: 'starting', detail: 'the Server is up and its memory provider is still starting', taskRun: false },
  };
  const unavailable = statusChips(withoutVersion, { ...config, hasToken: false }, 'zh', NOW);
  assert.deepEqual(unavailable.map(chip => chip.key), ['availability', 'server', 'host', 'token', 'checked']);
  assert.equal(unavailable[0]?.tone, 'bad');
  assert.equal(unavailable.find(chip => chip.key === 'token')?.value, '未配置');
  assert.equal(statusChips(null, config, 'en', NOW).length, 0);
});

test('error codes stay visible while their wording is localized', () => {
  assert.equal(codeText('NOT_FOUND', 'zh'), '未找到该记忆');
  assert.equal(codeText('UNAUTHORIZED', 'en'), 'The service token was rejected');
  assert.equal(codeText('PROVIDER_TIMEOUT', 'en'), 'The request timed out');
  assert.equal(codeText('SOMETHING_NEW', 'en'), 'Unknown error');
  assert.equal(codeText(undefined, 'zh'), '未知错误');
  assert.equal(availabilityText('unavailable', 'zh'), '不可用');
  assert.equal(stateText('superseded', 'en'), 'Superseded');
  assert.equal(stateText('unverified', 'zh'), '未验证');
});

test('the list summary counts what the Server returned', () => {
  const ok: UiMemoryList = { query: null, limit: 50, returned: 2, items: [] };
  assert.equal(listSummary(ok, 'en'), '2 items');
  assert.equal(listSummary({ ...ok, returned: 0 }, 'zh'), '0 条');
  assert.equal(listSummary(null, 'en'), '');
});

test('detail metadata names the viewed revision, not the live one', () => {
  const meta = detailMeta(detail(), 'en');
  assert.deepEqual(meta.map(item => item.key), ['state', 'revision', 'currentness', 'owner', 'applicability', 'published']);
  assert.deepEqual(meta.slice(0, 3).map(item => item.value), ['Active', '#2', 'Current revision']);
  assert.equal(meta[5]?.value, formatDateTime('2026-11-09T02:00:00.000Z'));
  // A general memory still shows its owner as "General", never an empty value.
  assert.equal(meta[3]?.value, 'General');
  assert.equal(detailMeta(detail({ projectId: 'alpha' }), 'en')[3]?.value, 'alpha');

  assert.equal(detailMeta(detail({ state: 'superseded' }), 'zh')[0]?.value, '已被取代');
  assert.equal(detailMeta(detail({ revisions: [] }), 'en')[1]?.value, '—');

  // Viewing history reports the historical number and names the current one separately; using
  // the current number here used to misreport which version the user was reading.
  const historical = detail({
    revisionId: '33333333-3333-4333-8333-333333333333',
    isCurrent: false,
    publishedAt: '2026-11-08T02:00:00.000Z',
    revisions: [
      rev('22222222-2222-4222-8222-222222222222', 2, '2026-11-09T02:00:00.000Z', { current: true }),
      rev('33333333-3333-4333-8333-333333333333', 1, '2026-11-08T02:00:00.000Z', { selected: true }),
    ],
  });
  const history = detailMeta(historical, 'en');
  assert.equal(history[1]?.value, '#1', 'the viewed revision is #1');
  assert.equal(history[2]?.value, 'Historical revision (current is #2)');
});

test('the edit form blocks empty, oversized and unchanged bodies before any request', () => {
  assert.equal(editBlocker('', 'a'), 'empty');
  assert.equal(editBlocker('   ', 'a'), 'empty');
  assert.equal(editBlocker('a'.repeat(8_001), 'a'), 'tooLong');
  // Chinese text: the limit is bytes, not characters, so 3000 characters is already over.
  assert.equal(editBlocker('中'.repeat(3_000), 'a'), 'tooLong');
  assert.equal(editBlocker('a', 'a'), 'unchanged');
  assert.equal(editBlocker('b', 'a'), null);
  assert.equal(utf8Bytes('中'), 3);
});

test('the injection chip names the last View and flags a budget omission', () => {
  const injection: UiInjection = {
    id: '33333333-3333-4333-8333-333333333333', sessionId: 's-1',
    rulesInjected: 2, rulesOmitted: null, memoriesInjected: 3, usedTokens: 700,
    createdAt: '2026-11-09T02:50:00.000Z',
  };
  const ok = injectionChip(injection, 'zh');
  assert.equal(ok.key, 'injection');
  assert.equal(ok.tone, 'ok');
  assert.match(ok.value, /准则 2 条/);
  assert.match(ok.value, /记忆 3 条/);

  const omitted = injectionChip({ ...injection, rulesOmitted: 'budget_exceeded' }, 'en');
  assert.equal(omitted.tone, 'warn');
  assert.match(omitted.value, /budget exceeded/);

  const none = injectionChip(null, 'zh');
  assert.equal(none.tone, 'muted');
  assert.equal(none.value, '尚无注入记录');
});

/**
 * The entity index is filtered in the page, but the rule has to match the Server's: a substring
 * match that ignores case. If the two disagreed, the page could offer an entity the list then
 * refuses to return.
 */
test('the entity filter ignores case and keeps everything when empty', () => {
  const index = [
    { value: 'MnemoWeave', count: 3 },
    { value: 'DSH', count: 2 },
    { value: 'ChatGPT 桌面', count: 1 },
  ];
  assert.deepEqual(filterEntities(index, ''), index, 'an empty query keeps the whole index');
  assert.deepEqual(filterEntities(index, '   '), index, 'whitespace is not a filter');
  assert.deepEqual(filterEntities(index, 'dsh'), [{ value: 'DSH', count: 2 }], 'matching ignores case');
  assert.deepEqual(filterEntities(index, 'weave'), [{ value: 'MnemoWeave', count: 3 }], 'matching is a substring');
  assert.deepEqual(filterEntities(index, 'gpt'), [{ value: 'ChatGPT 桌面', count: 1 }], 'non-ASCII values match too');
  assert.deepEqual(filterEntities(index, 'nobody'), []);
});

/**
 * The neighbourhood walk answers "what is near this memory".
 *
 * Each memory is reported once at the shortest hop that reached it: listing it twice would
 * suggest two relationships where the data has one.
 */
test('the neighbourhood walk stops at the requested depth and reports each memory once', () => {
  const edge = (id: string, source: string, target: string, kind: 'Supersedes' | 'RelatedTo' = 'RelatedTo') => ({
    relationId: id, kind, sourceMemoryId: source, targetMemoryId: target, reason: `why ${id}`, effectiveAt: '2026-11-10T00:00:00.000Z',
  });
  const graph = {
    nodes: ['a', 'b', 'c', 'd', 'far'].map(memoryId => ({ memoryId })),
    edges: [edge('ab', 'a', 'b'), edge('bc', 'b', 'c'), edge('cd', 'c', 'd'), edge('dfar', 'd', 'far')],
  };

  const one = neighbourhood(graph, 'a', 1);
  assert.deepEqual(one.map(item => item.memoryId), ['b'], 'one hop stops at the direct neighbour');
  assert.equal(one[0]?.hop, 1);
  assert.equal(one[0]?.direction, 'out');

  const two = neighbourhood(graph, 'a', 2);
  assert.deepEqual(two.map(item => item.memoryId), ['b', 'c'], 'two hops reaches the next ring');
  assert.deepEqual(two.map(item => item.hop), [1, 2]);

  // A cycle back to the origin does not make the origin its own neighbour, and an incoming edge
  // still counts as a neighbour: `c → a` puts `c` one hop away from `a`.
  const cycle = { nodes: ['a', 'b', 'c'].map(memoryId => ({ memoryId })), edges: [edge('ab', 'a', 'b'), edge('bc', 'b', 'c'), edge('ca', 'c', 'a')] };
  const reached = neighbourhood(cycle, 'a', 3);
  assert.deepEqual(reached.map(item => item.memoryId), ['b', 'c'], 'the origin is never its own neighbour');
  assert.deepEqual(reached.map(item => item.hop), [1, 1], 'both are direct neighbours of the origin');

  // An incoming edge is walked too, but keeps its direction for display.
  const inbound = { nodes: ['a', 'b'].map(memoryId => ({ memoryId })), edges: [edge('ba', 'b', 'a', 'Supersedes')] };
  const fromOutside = neighbourhood(inbound, 'a', 1);
  assert.deepEqual(fromOutside, [{ memoryId: 'b', hop: 1, kind: 'Supersedes', direction: 'in', reason: 'why ba' }]);

  // A memory that is not in the graph has no neighbourhood rather than a confusing one.
  assert.deepEqual(neighbourhood(graph, 'missing', 2), []);
});
