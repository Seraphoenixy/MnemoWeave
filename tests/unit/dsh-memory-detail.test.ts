import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMemoryDetail } from '../../plugins/dsh-mnemo-weave/src/ui/memory-source.ts';
import { classificationLists, classificationMeta, diffLines, openConflicts, relationRows, revisionTimeline } from '../../plugins/dsh-mnemo-weave/src/client/view-model.ts';

/**
 * The detail view renders what the Server returns. These tests pin the parsing of the fields the
 * page actually shows — the revision chain, relation evidence and conflict decisions — because a
 * parser that quietly drops them makes the view look complete while showing half the data.
 */

const MEMORY = '11111111-1111-4111-8111-111111111111';
const REV2 = '22222222-2222-4222-8222-222222222222';
const REV1 = '33333333-3333-4333-8333-333333333333';
const REV0 = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MEMORY,
    currentRevisionId: REV2,
    selectedRevisionId: REV2,
    state: 'active',
    scope: 'project',
    projectId: 'alpha',
    applicability: 'alpha',
    entryVersion: 2,
    content: '当前正文',
    selectedRevision: { providerMemoryId: 'provider-2', publishedAt: '2026-11-10T02:00:00.000Z' },
    revisions: [
      { id: REV2, number: 2, parentId: REV1, contentHash: 'b'.repeat(64), candidateId: 'c2', publishedAt: '2026-11-10T02:00:00.000Z', effectiveAt: '2026-11-10T02:00:00.000Z' },
      { id: REV1, number: 1, parentId: null, contentHash: 'a'.repeat(64), candidateId: 'c1', publishedAt: '2026-11-09T02:00:00.000Z', effectiveAt: '2026-11-09T02:00:00.000Z' },
    ],
    relations: [{
      id: '66666666-6666-4666-8666-666666666666', kind: 'Supersedes',
      sourceMemoryId: MEMORY, sourceRevisionId: REV2, targetMemoryId: OTHER, targetRevisionId: REV0,
      effectiveAt: '2026-11-10T02:00:00.000Z', reason: '合并了旧条目', evidence: ['人工核对'], nativeProjected: true,
    }],
    conflicts: [{
      id: '77777777-7777-4777-8777-777777777777', candidateId: 'c9', targetMemoryId: MEMORY, baseRevisionId: REV1,
      state: 'open', followUpCandidateId: null,
      decisions: [{ actor: 'operator', decision: 'keep_existing', reason: '旧版本仍准确', evidence: ['对比'], createdAt: '2026-11-10T03:00:00.000Z' }],
    }],
    ...overrides,
  };
}

test('the detail keeps the revision chain, hashes and effective times', () => {
  const detail = parseMemoryDetail(payload());
  assert.equal(detail.memoryId, MEMORY);
  assert.equal(detail.revisionId, REV2);
  assert.equal(detail.isCurrent, true);
  const later = detail.revisions.find(revision => revision.revisionId === REV2)!;
  assert.equal(later.parentId, REV1, 'the chain is what makes the history a history');
  assert.equal(later.contentHash, 'b'.repeat(64));
  assert.equal(later.candidateId, 'c2');
  assert.equal(later.current, true);
  assert.equal(detail.revisions.find(revision => revision.revisionId === REV1)!.parentId, null);
});

test('a historical read is not reported as the current revision', () => {
  const detail = parseMemoryDetail(payload({ selectedRevisionId: REV1, content: '旧正文' }));
  assert.equal(detail.isCurrent, false);
  assert.equal(detail.currentRevisionId, REV2);
  assert.equal(detail.revisions.find(revision => revision.revisionId === REV1)!.selected, true);
  assert.equal(detail.revisions.find(revision => revision.revisionId === REV1)!.current, false);
});

test('relations keep their direction, evidence and native projection state', () => {
  const rows = relationRows(parseMemoryDetail(payload()));
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.kind, 'Supersedes');
  assert.equal(row.direction, 'out', 'this memory is the source of the edge');
  assert.equal(row.otherMemoryId, OTHER);
  assert.deepEqual(row.evidence, ['人工核对']);
  assert.equal(row.nativeProjected, true);

  // The same edge seen from the other side points back at this memory.
  const incoming = relationRows(parseMemoryDetail(payload({
    relations: [{
      id: '66666666-6666-4666-8666-666666666666', kind: 'Supersedes',
      sourceMemoryId: OTHER, sourceRevisionId: REV0, targetMemoryId: MEMORY, targetRevisionId: REV2,
      effectiveAt: '2026-11-10T02:00:00.000Z', reason: '被取代', evidence: [], nativeProjected: false,
    }],
  })));
  assert.equal(incoming[0]?.direction, 'in');
  assert.equal(incoming[0]?.otherMemoryId, OTHER);
  assert.equal(incoming[0]?.nativeProjected, false);
});

test('conflicts and their decisions survive parsing; resolved ones stay out of the way', () => {
  const detail = parseMemoryDetail(payload());
  assert.equal(detail.conflicts.length, 1);
  assert.equal(detail.conflicts[0]?.state, 'open');
  assert.deepEqual(detail.conflicts[0]?.decisions.map(decision => decision.decision), ['keep_existing']);
  assert.equal(openConflicts(detail).length, 1);

  const resolved = parseMemoryDetail(payload({
    conflicts: [{ ...(payload()['conflicts'] as Record<string, unknown>[])[0]!, state: 'resolved' }],
  }));
  assert.equal(openConflicts(resolved).length, 0, 'a resolved case is history, not an alert');
});

test('a revision whose parent is missing is marked, not smoothed over', () => {
  const detail = parseMemoryDetail(payload({
    revisions: [
      { id: REV2, number: 2, parentId: '99999999-9999-4999-8999-999999999999', contentHash: 'b'.repeat(64), candidateId: 'c2', publishedAt: '2026-11-10T02:00:00.000Z', effectiveAt: '2026-11-10T02:00:00.000Z' },
      { id: REV1, number: 1, parentId: null, contentHash: 'a'.repeat(64), candidateId: 'c1', publishedAt: '2026-11-09T02:00:00.000Z', effectiveAt: '2026-11-09T02:00:00.000Z' },
    ],
  }));
  const timeline = revisionTimeline(detail);
  assert.deepEqual(timeline.map(row => row.number), [1, 2], 'oldest first');
  assert.equal(timeline[0]?.chained, true);
  assert.equal(timeline[1]?.chained, false, 'the dangling parent is visible');
});

test('a malformed detail is rejected instead of rendered half-empty', () => {
  assert.throws(() => parseMemoryDetail(payload({ revisions: [{ id: REV2, number: 2, parentId: null }] })));
  assert.throws(() => parseMemoryDetail(payload({ relations: [{ id: 'r', kind: 'Unknown', sourceMemoryId: MEMORY, sourceRevisionId: REV2, targetMemoryId: OTHER, targetRevisionId: REV0, effectiveAt: 'now', reason: 'x', evidence: [], nativeProjected: true }] })));
  assert.throws(() => parseMemoryDetail(payload({ conflicts: [{ id: 'c', state: 'weird', baseRevisionId: REV1, decisions: [] }] })));
});

test('classification is kept per revision and absence stays distinguishable', () => {
  const detail = parseMemoryDetail(payload({
    revisions: [
      { id: REV2, number: 2, parentId: REV1, contentHash: 'b'.repeat(64), candidateId: 'c2', publishedAt: '2026-11-10T02:00:00.000Z', effectiveAt: '2026-11-10T02:00:00.000Z', category: 'decision', importance: 4, tags: ['发布', '回滚'], entities: ['MnemoWeave'] },
      { id: REV1, number: 1, parentId: null, contentHash: 'a'.repeat(64), candidateId: 'c1', publishedAt: '2026-11-09T02:00:00.000Z', effectiveAt: '2026-11-09T02:00:00.000Z', knowledgeType: 'Practice', tags: [] },
    ],
  }));
  const newer = detail.revisions.find(revision => revision.revisionId === REV2)!;
  assert.equal(newer.category, 'decision');
  assert.equal(newer.importance, 4);
  assert.deepEqual(newer.tags, ['发布', '回滚']);
  assert.deepEqual(newer.entities, ['MnemoWeave']);
  assert.equal(newer.knowledgeType, undefined, 'a synced revision records no local knowledge type');

  const older = detail.revisions.find(revision => revision.revisionId === REV1)!;
  assert.equal(older.knowledgeType, 'Practice');
  assert.deepEqual(older.tags, [], 'an explicitly empty tag list is not the same as absent');
  assert.equal(older.category, undefined);

  const chips = classificationMeta(detail, 'en');
  assert.deepEqual(chips.map(chip => chip.key), ['category', 'importance']);
  assert.deepEqual(classificationLists(detail), { tags: ['发布', '回滚'], entities: ['MnemoWeave'] });

  // Viewing the older revision switches the classification with it.
  const asHistory = classificationMeta({ ...detail, revisionId: REV1, isCurrent: false }, 'en');
  assert.deepEqual(asHistory.map(chip => chip.key), ['knowledgeType']);
});

test('the diff marks added and removed lines in order', () => {
  assert.deepEqual(diffLines('a\nb', 'a\nc'), [
    { kind: 'same', text: 'a' },
    { kind: 'removed', text: 'b' },
    { kind: 'added', text: 'c' },
  ]);
  assert.deepEqual(diffLines('a', 'a'), [{ kind: 'same', text: 'a' }]);
  // Appending keeps the existing line and adds one.
  assert.deepEqual(diffLines('a', 'a\nb'), [{ kind: 'same', text: 'a' }, { kind: 'added', text: 'b' }]);
});
