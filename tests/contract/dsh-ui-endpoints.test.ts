import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArchiveList, parseEmbeddingDiagnostics, parseRuleList, parseSyncPass, parseSyncStatus,
} from '../../plugins/dsh-mnemo-weave/src/ui/memory-source.ts';

/** The Host half checks every field: a wrong shape is a protocol error, never rendered as data. */

test('embedding diagnosis is validated field by field', () => {
  const report = {
    provider: 'mnemon', model: 'nomic-embed-text', protocol: 'ollama',
    serviceAvailable: false, modelAvailable: false, embedded: 2, total: 4, coverage: 0.5,
    recallMode: 'keyword', degraded: true, lastError: 'embedding service unreachable',
    checkedAt: '2026-11-11T00:00:00.000Z',
    backfill: { state: 'succeeded', startedAt: '2026-11-11T00:00:00.000Z', finishedAt: '2026-11-11T00:01:00.000Z', detail: { embeddedAfter: 4 } },
  };
  const parsed = parseEmbeddingDiagnostics(report);
  assert.equal(parsed.recallMode, 'keyword');
  assert.equal(parsed.coverage, 0.5);
  assert.equal(parsed.lastError, 'embedding service unreachable');
  assert.equal(parsed.backfill?.state, 'succeeded');
  assert.equal(parsed.backfill?.detail?.['embeddedAfter'], 4);
  for (const broken of [
    { ...report, recallMode: 'magic' },
    { ...report, coverage: 2 },
    { ...report, embedded: -1 },
    { ...report, degraded: 'yes' },
  ]) {
    assert.throws(() => parseEmbeddingDiagnostics(broken), (error: unknown) => (error as { code?: string }).code === 'PROVIDER_PROTOCOL');
  }
});

const rule = {
  entryId: '11111111-1111-4111-8111-111111111111',
  body: '提交前必须运行类型检查。', enabled: true, version: 2, withdrawnAt: null,
  importance: 'critical', pinned: true, bodyBytes: 33,
};

test('a rule list is parsed field by field', () => {
  const rules = parseRuleList({ items: [rule, { ...rule, entryId: '22222222-2222-4222-8222-222222222222', enabled: false }] });
  assert.equal(rules.length, 2);
  assert.equal(rules[0]?.enabled, true);
  assert.equal(rules[1]?.enabled, false);
  assert.equal(rules[0]?.importance, 'critical');
  assert.equal(rules[0]?.pinned, true);
  assert.equal(rules[0]?.bodyBytes, 33);
  assert.throws(() => parseRuleList({ items: [{ ...rule, enabled: 'yes' }] }), (error: unknown) => (error as { code?: string }).code === 'PROVIDER_PROTOCOL');
  assert.throws(() => parseRuleList({ items: [{ ...rule, version: 'two' }] }), (error: unknown) => (error as { code?: string }).code === 'PROVIDER_PROTOCOL');
});

const archive = {
  entryId: '33333333-3333-4333-8333-333333333333',
  workspaceId: '11111111-1111-4111-8111-111111111111', title: '标题', body: '正文',
  source: 'tool', verification: 'open', evidence: '证据', version: 1, withdrawnAt: null,
  state: 'archived', archivedAt: '2026-11-10T08:00:00.000Z', bodyBytes: 6,
};

test('an archive list keeps verification and refuses unknown enumerations', () => {
  const archives = parseArchiveList({ items: [archive] });
  assert.equal(archives[0]?.verification, 'open');
  assert.equal(archives[0]?.source, 'tool');
  assert.equal(archives[0]?.state, 'archived');
  assert.equal(archives[0]?.bodyBytes, 6);
  assert.throws(() => parseArchiveList({ items: [{ ...archive, verification: 'maybe' }] }), (error: unknown) => (error as { code?: string }).code === 'PROVIDER_PROTOCOL');
  assert.throws(() => parseArchiveList({ items: [{ ...archive, source: 'model' }] }), (error: unknown) => (error as { code?: string }).code === 'PROVIDER_PROTOCOL');
});

test('the sync status keeps one row per stream with the exact counters', () => {
  const status = parseSyncStatus({
    enabled: true,
    protocol: 2,
    streams: [{ stream: 'formal-memories', cursor: 12, lastPullAt: '2026-11-10T08:00:00.000Z', lastError: null, pending: 1, unknown: 0, unapplied: 2 }],
    updatedAt: '2026-11-10T08:00:01.000Z',
  });
  assert.equal(status.enabled, true);
  assert.equal(status.protocol, 2);
  assert.deepEqual(status.streams[0], { stream: 'formal-memories', cursor: 12, lastPullAt: '2026-11-10T08:00:00.000Z', lastError: null, pending: 1, unknown: 0, unapplied: 2 });
  assert.throws(() => parseSyncStatus({ enabled: true, protocol: 2, streams: [{ ...status.streams[0], pending: -1 }], updatedAt: '2026-11-10T08:00:01.000Z' }), (error: unknown) => (error as { code?: string }).code === 'PROVIDER_PROTOCOL');
  assert.throws(() => parseSyncStatus({ enabled: true, protocol: 2, streams: [{ ...status.streams[0], unapplied: 1.5 }], updatedAt: '2026-11-10T08:00:01.000Z' }), (error: unknown) => (error as { code?: string }).code === 'PROVIDER_PROTOCOL');
});

test('a sync pass reports counts and per-stream errors', () => {
  const pass = parseSyncPass({ streams: ['rules'], pulled: 2, applied: 1, errors: ['formal-memories:SYNC_UNAVAILABLE'], skipped: false });
  assert.equal(pass.applied, 1);
  assert.deepEqual(pass.errors, ['formal-memories:SYNC_UNAVAILABLE']);
  assert.throws(() => parseSyncPass({ streams: [], pulled: 0, applied: 0, errors: [], skipped: 'no' }), (error: unknown) => (error as { code?: string }).code === 'PROVIDER_PROTOCOL');
});
