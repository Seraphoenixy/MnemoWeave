import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLanguage, translate } from '../../plugins/dsh-mnemo-weave/src/client/i18n.ts';
import {
  availabilityText, detailMeta, formatDateTime, grantChips, intentsSummary, listSummary,
  reasonText, relativeTime, scopeText, statusChips, type Chip,
} from '../../plugins/dsh-mnemo-weave/src/client/view-model.ts';
import type { UiGrantView, UiIntents, UiMemoryDetail, UiMemoryList, UiReplicaView, UiStatus } from '../../plugins/dsh-mnemo-weave/src/shared/contract.ts';

const NOW = Date.parse('2026-11-09T03:00:00.000Z');

const grant = (overrides: Partial<UiGrantView> = {}): UiGrantView => ({
  grantId: '11111111-1111-4111-8111-111111111111', projects: ['proj-a'], globalIncluded: false,
  issuedAt: '2026-11-09T02:00:00.000Z', expiresAt: '2026-11-09T04:00:00.000Z', generation: 3,
  expired: false, revoked: false, ...overrides,
});

const replica = (overrides: Partial<UiReplicaView> = {}): UiReplicaView => ({
  available: true, corrupted: false, appliedSeq: 42, generation: 1, dataTime: '2026-11-09T02:59:00.000Z',
  verifiedAt: null, stale: false, pendingContent: 0, memories: 7, revisions: 9, ...overrides,
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
  assert.equal(relativeTime('2026-11-09T02:59:30.000Z', NOW, 'en'), 'just now');
  assert.equal(relativeTime('2026-11-09T02:30:00.000Z', NOW, 'en'), '30 min ago');
  assert.equal(relativeTime('2026-11-09T00:00:00.000Z', NOW, 'zh'), '3 小时前');
  assert.equal(relativeTime('2026-11-07T00:00:00.000Z', NOW, 'en'), '2 d ago');
  assert.equal(relativeTime('not-a-date', NOW, 'en'), '—');
  assert.equal(formatDateTime('not-a-date'), '—');
  assert.match(formatDateTime('2026-11-09T03:04:00.000Z'), /^2026-11-0[89] \d{2}:04$/);
});

test('grant and replica chips state the availability rather than hiding it', () => {
  const healthy: Chip[] = statusChips({ paired: true, grant: grant(), replica: replica() } as UiStatus, 'en', NOW);
  assert.deepEqual(healthy.map(chip => chip.key), ['paired', 'scope', 'expires', 'generation', 'replica', 'freshness', 'seq', 'memories', 'revisions', 'pending']);
  assert.equal(healthy[0]?.tone, 'ok');
  assert.equal(healthy.find(chip => chip.key === 'freshness')?.tone, 'ok');

  const revoked = grantChips(grant({ revoked: true }), 'zh', NOW);
  assert.equal(revoked[0]?.label, '已撤权');
  assert.equal(revoked[0]?.tone, 'bad');

  const expired = grantChips(grant({ expiresAt: '2026-11-09T01:00:00.000Z' }), 'en', NOW);
  assert.equal(expired[0]?.label, 'Grant expired');
  assert.equal(expired[0]?.tone, 'bad');

  assert.equal(grantChips(null, 'en', NOW)[0]?.tone, 'bad');
  const staleReplica = grantChips(null, 'en', NOW).concat([]).length;
  assert.equal(staleReplica, 1);

  const chips = statusChips({ paired: true, grant: grant(), replica: replica({ stale: true, pendingContent: 2 }) } as UiStatus, 'en', NOW);
  assert.equal(chips.find(chip => chip.key === 'freshness')?.tone, 'warn');
  assert.equal(chips.find(chip => chip.key === 'pending')?.tone, 'warn');
  const corrupted = statusChips({ paired: true, grant: grant(), replica: replica({ corrupted: true, available: false }) } as UiStatus, 'en', NOW);
  assert.equal(corrupted.find(chip => chip.key === 'replica')?.tone, 'bad');
});

test('scope, availability and list summaries name the reason', () => {
  assert.equal(scopeText(['*'], true, 'zh'), '全部项目 · 含全局');
  assert.equal(scopeText(['a', 'b'], false, 'en'), 'a, b · projects only');
  assert.equal(availabilityText('corrupted', 'en'), 'Corrupted');
  assert.equal(reasonText('out_of_grant', 'zh'), '超出当前授权范围');
  assert.equal(reasonText('something-new', 'en'), 'Unavailable');

  const ok: UiMemoryList = { status: 'ok', query: null, scope: null, projectId: null, total: 2, returned: 2, complete: true, dataTime: null, items: [] };
  assert.equal(listSummary(ok, 'en'), '2 items');
  assert.equal(listSummary({ ...ok, complete: false }, 'en'), '2 items · Some text has not synced yet');
  assert.equal(listSummary({ ...ok, status: 'unauthorized', reason: 'revoked' }, 'zh'), '未授权 · 授权已被撤销');
  assert.equal(listSummary(null, 'en'), '');
});

test('intent and detail metadata stay bounded and readable', () => {
  const intents: UiIntents = { status: 'ok', queued: 2, isolated: 1, items: [] };
  assert.equal(intentsSummary(intents, 'en'), 'Queued 2 · Isolated 1');
  assert.equal(intentsSummary(null, 'zh'), '');
  const detail = {
    status: 'ok', memoryId: 'm', revisionId: 'r', state: 'active', scope: 'project', projectId: 'proj-a',
    applicability: 'release', content: 'x', revisions: [], relations: [],
  } as UiMemoryDetail;
  assert.deepEqual(detailMeta(detail, 'en').map(meta => meta.value), ['active', 'proj-a', 'release']);
  const { projectId: _project, ...globalFields } = detail;
  const global: UiMemoryDetail = { ...globalFields, scope: 'global' };
  assert.equal(detailMeta(global, 'zh')[1]?.value, '全局');
});
