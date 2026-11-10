import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLanguage, translate } from '../../plugins/dsh-mnemo-weave/src/client/i18n.ts';
import {
  availabilityText, codeText, detailMeta, formatDateTime, injectionChip, listSummary, relativeTime,
  stateText, statusChips, type Chip,
} from '../../plugins/dsh-mnemo-weave/src/client/view-model.ts';
import type { UiConfigView, UiInjection, UiMemoryDetail, UiMemoryList, UiStatus } from '../../plugins/dsh-mnemo-weave/src/shared/contract.ts';

const NOW = Date.parse('2026-11-09T03:00:00.000Z');

const status = (overrides: Partial<UiStatus> = {}): UiStatus => ({
  status: 'ok', serverUrl: 'http://127.0.0.1:4317', hostId: 'dsh',
  checkedAt: '2026-11-09T02:59:30.000Z', version: '0.2.13', ...overrides,
});

const config: UiConfigView = { serverUrl: 'http://127.0.0.1:4317', hostId: 'dsh', hasToken: true };

const detail = (overrides: Partial<UiMemoryDetail> = {}): UiMemoryDetail => ({
  memoryId: '11111111-1111-4111-8111-111111111111',
  revisionId: '22222222-2222-4222-8222-222222222222',
  providerMemoryId: 'provider-1',
  scope: 'project',
  projectId: 'proj-a',
  applicability: 'release',
  state: 'active',
  content: 'x',
  publishedAt: '2026-11-09T02:00:00.000Z',
  entryVersion: 0,
  revisions: [
    {
      revisionId: '22222222-2222-4222-8222-222222222222', number: 2,
      publishedAt: '2026-11-09T02:00:00.000Z', effectiveAt: '2026-11-09T02:00:00.000Z', current: true,
    },
    {
      revisionId: '33333333-3333-4333-8333-333333333333', number: 1,
      publishedAt: '2026-11-08T02:00:00.000Z', effectiveAt: '2026-11-08T02:00:00.000Z', current: false,
    },
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

test('detail metadata names state, current revision, scope, applicability and publication time', () => {
  const meta = detailMeta(detail(), 'en');
  assert.deepEqual(meta.map(item => item.key), ['state', 'revision', 'scope', 'applicability', 'published']);
  assert.deepEqual(meta.slice(0, 4).map(item => item.value), ['Active', '#2', 'proj-a', 'release']);
  assert.equal(meta[4]?.value, formatDateTime('2026-11-09T02:00:00.000Z'));

  const { projectId: _project, ...globalFields } = detail({ scope: 'global' });
  assert.equal(detailMeta(globalFields as UiMemoryDetail, 'zh')[2]?.value, '全局');
  assert.equal(detailMeta(detail({ state: 'superseded' }), 'zh')[0]?.value, '已被取代');
  assert.equal(detailMeta(detail({ revisions: [] }), 'en')[1]?.value, '—');
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
