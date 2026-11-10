import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArchiveList, parseRuleList, parseSyncPass, parseSyncStatus,
} from '../../plugins/dsh-mnemo-weave/src/ui/memory-source.ts';

/** The Host half checks every field: a wrong shape is a protocol error, never rendered as data. */

const rule = {
  entryId: '11111111-1111-4111-8111-111111111111', scope: 'project', projectId: 'alpha',
  body: '提交前必须运行类型检查。', enabled: true, version: 2, withdrawnAt: null,
};

test('a rule list is parsed field by field, including the project scope', () => {
  const rules = parseRuleList({ items: [rule, { ...rule, entryId: '22222222-2222-4222-8222-222222222222', scope: 'global', projectId: null }] });
  assert.equal(rules.length, 2);
  assert.equal(rules[0]?.projectId, 'alpha');
  assert.equal(rules[0]?.enabled, true);
  assert.equal(rules[1]?.projectId, null);
  assert.throws(() => parseRuleList({ items: [{ ...rule, enabled: 'yes' }] }), (error: unknown) => (error as { code?: string }).code === 'PROVIDER_PROTOCOL');
  assert.throws(() => parseRuleList({ items: [{ ...rule, scope: 'host' }] }), (error: unknown) => (error as { code?: string }).code === 'PROVIDER_PROTOCOL');
});

const archive = {
  entryId: '33333333-3333-4333-8333-333333333333', projectId: 'alpha', title: '标题', body: '正文',
  source: 'tool', verification: 'open', evidence: '证据', version: 1, withdrawnAt: null,
};

test('an archive list keeps verification and refuses unknown enumerations', () => {
  const archives = parseArchiveList({ items: [archive] });
  assert.equal(archives[0]?.verification, 'open');
  assert.equal(archives[0]?.source, 'tool');
  assert.throws(() => parseArchiveList({ items: [{ ...archive, verification: 'maybe' }] }), (error: unknown) => (error as { code?: string }).code === 'PROVIDER_PROTOCOL');
  assert.throws(() => parseArchiveList({ items: [{ ...archive, source: 'model' }] }), (error: unknown) => (error as { code?: string }).code === 'PROVIDER_PROTOCOL');
});

test('the sync status keeps one row per scope with the exact counters', () => {
  const status = parseSyncStatus({
    enabled: true,
    scopes: [{ scope: 'project:alpha', cursor: 12, lastPullAt: '2026-11-10T08:00:00.000Z', lastError: null, pending: 1, unknown: 0, unapplied: 2 }],
    updatedAt: '2026-11-10T08:00:01.000Z',
  });
  assert.equal(status.enabled, true);
  assert.deepEqual(status.scopes[0], { scope: 'project:alpha', cursor: 12, lastPullAt: '2026-11-10T08:00:00.000Z', lastError: null, pending: 1, unknown: 0, unapplied: 2 });
  assert.throws(() => parseSyncStatus({ enabled: true, scopes: [{ ...status.scopes[0], pending: -1 }], updatedAt: '2026-11-10T08:00:01.000Z' }), (error: unknown) => (error as { code?: string }).code === 'PROVIDER_PROTOCOL');
  assert.throws(() => parseSyncStatus({ enabled: true, scopes: [{ ...status.scopes[0], unapplied: 1.5 }], updatedAt: '2026-11-10T08:00:01.000Z' }), (error: unknown) => (error as { code?: string }).code === 'PROVIDER_PROTOCOL');
});

test('a sync pass reports counts and per-scope errors', () => {
  const pass = parseSyncPass({ scopes: ['global'], pulled: 2, applied: 1, errors: ['project:alpha:SYNC_UNAVAILABLE'], skipped: false });
  assert.equal(pass.applied, 1);
  assert.deepEqual(pass.errors, ['project:alpha:SYNC_UNAVAILABLE']);
  assert.throws(() => parseSyncPass({ scopes: [], pulled: 0, applied: 0, errors: [], skipped: 'no' }), (error: unknown) => (error as { code?: string }).code === 'PROVIDER_PROTOCOL');
});
