import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';

const NOW = '2026-11-10T10:00:00.000Z';

async function open() {
  await mkdir('work/tests', { recursive: true });
  const path = join(await mkdtemp(resolve('work/tests/memory-store-')), 'governance.db');
  return new SqliteCandidates(path);
}

test('rules apply to every session and disappear when withdrawn', async () => {
  const repo = await open();
  try {
    repo.memory.upsertRule({ entryId: 'r1', body: '提交前必须运行类型检查。', enabled: true, version: 1, withdrawnAt: null }, NOW);
    repo.memory.upsertRule({ entryId: 'r2', body: '不得改写架构决策。', enabled: true, version: 1, withdrawnAt: null }, NOW);
    repo.memory.upsertRule({ entryId: 'r3', body: '已停用准则。', enabled: false, version: 2, withdrawnAt: null }, NOW);
    // A disabled rule is still listed for the operator, but it is never injected.
    assert.deepEqual(repo.memory.rulesFor().map((row) => row.entryId), ['r1', 'r2']);
    assert.deepEqual(repo.memory.everyRule().map((row) => row.entryId), ['r1', 'r2', 'r3']);
    repo.memory.withdrawRule('r1', NOW);
    assert.deepEqual(repo.memory.rulesFor().map((row) => row.entryId), ['r2']);
  } finally {
    repo.close();
  }
});

test('project archives keep verification state and can be read with withdrawn rows', async () => {
  const repo = await open();
  try {
    repo.memory.upsertArchive({ entryId: 'a1', projectId: 'alpha', title: '游标按范围', body: '正文', source: 'session', verification: 'open', evidence: '三次实验', version: 1, withdrawnAt: null }, NOW);
    repo.memory.upsertArchive({ entryId: 'a2', projectId: 'alpha', title: '旧结论', body: '正文', source: 'tool', verification: 'refuted', evidence: '反例', version: 1, withdrawnAt: null }, NOW);
    repo.memory.withdrawArchive('a2', NOW);
    assert.deepEqual(repo.memory.archivesFor('alpha').map((row) => row.entryId), ['a1']);
    assert.equal(repo.memory.archivesFor('alpha', true).length, 2);
    assert.equal(repo.memory.archivesFor('alpha')[0]?.verification, 'open');
    assert.deepEqual(repo.memory.archivesFor('beta'), []);
  } finally {
    repo.close();
  }
});

test('archive state changes are readable and history keeps every version body', async () => {
  const repo = await open();
  try {
    repo.memory.upsertArchive({ entryId: 'a1', projectId: 'alpha', title: '原标题', body: '原始正文', source: 'user', verification: 'open', evidence: '证据', version: 1, withdrawnAt: null }, NOW);
    assert.equal(repo.memory.archiveHistory('a1').at(0)?.state, 'active');
    repo.memory.upsertArchive({ entryId: 'a1', projectId: 'alpha', title: '原标题', body: '原始正文', source: 'user', verification: 'open', evidence: '证据', version: 2, withdrawnAt: null, state: 'archived', archivedAt: NOW }, NOW);
    assert.equal(repo.memory.archive('a1')?.state, 'archived');
    const history = repo.memory.archiveHistory('a1');
    assert.deepEqual(history.map(row => row.version), [2, 1]);
    assert.equal(history[0]?.state, 'archived');
    assert.equal(history[1]?.body, '原始正文');
    assert.equal(history[1]?.state, 'active');
    assert.equal(repo.memory.archiveUsage('alpha').activeBytes, 0);
    assert.equal(repo.memory.archiveUsage('alpha').archivedCount, 1);
  } finally {
    repo.close();
  }
});

test('sync archive capacity archives the oldest active entries but keeps their text', async () => {
  const repo = await open();
  try {
    const base = { projectId: 'alpha', title: 't', body: 'x'.repeat(60), source: 'user' as const, verification: 'open' as const, evidence: 'e', version: 1, withdrawnAt: null };
    repo.memory.upsertArchive({ ...base, entryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, NOW);
    repo.memory.upsertArchive({ ...base, entryId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, '2026-11-10T10:00:01.000Z');
    repo.memory.applyArchiveWithCapacity({ ...base, entryId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', body: 'y'.repeat(60) }, '2026-11-10T10:00:02.000Z', 150);
    const rows = repo.memory.archivesFor('alpha', true);
    assert.equal(rows.filter(row => row.state === 'archived').length, 1);
    assert.equal(rows.find(row => row.entryId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')?.body, 'x'.repeat(60));
    assert.equal(repo.memory.archiveHistory('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').at(0)?.state, 'archived');
  } finally {
    repo.close();
  }
});

test('sync rule capacity archives lower-priority text and excludes it from the active list', async () => {
  const repo = await open();
  try {
    repo.memory.upsertRule({ entryId: 'critical', body: 'c'.repeat(8000), enabled: true, version: 1, withdrawnAt: null, importance: 'critical' }, NOW);
    repo.memory.upsertRule({ entryId: 'normal', body: 'n'.repeat(8000), enabled: true, version: 1, withdrawnAt: null, importance: 'normal' }, NOW);
    const archived = repo.memory.applyRuleWithCapacity({ entryId: 'pending', body: 'pending', enabled: true, version: 1, withdrawnAt: null }, NOW, { capacityBytes: 14336, itemMaxBytes: 8192 });
    assert.deepEqual(archived.map(row => row.ruleId), ['normal']);
    assert.deepEqual(repo.memory.allRules().map(row => row.entryId).sort(), ['critical', 'pending']);
    assert.equal(repo.memory.rule('normal'), null);
    assert.equal(repo.memory.ruleArchive()[0]?.body, 'n'.repeat(8000));
    assert.equal(repo.memory.ruleArchive()[0]?.reason, 'capacity');
  } finally {
    repo.close();
  }
});

test('the formal map records one provider id per revision', async () => {  const repo = await open();
  try {
    assert.equal(repo.memory.formalProviderId('f1', 1), null);
    repo.memory.upsertFormalMap({ entryId: 'f1', version: 1, providerId: 'p-1', contentHash: 'a'.repeat(64), state: 'applied', appliedAt: NOW }, NOW);
    repo.memory.upsertFormalMap({ entryId: 'f1', version: 2, providerId: 'p-2', contentHash: 'b'.repeat(64), state: 'applied', appliedAt: NOW }, NOW);
    assert.equal(repo.memory.formalProviderId('f1', 1), 'p-1');
    assert.equal(repo.memory.formalProviderId('f1', 2), 'p-2');
    assert.deepEqual(repo.memory.formalMap('f1').map((row) => row.version), [1, 2]);
    repo.memory.upsertFormalMap({ entryId: 'f1', version: 2, providerId: 'p-2', contentHash: 'b'.repeat(64), state: 'needs_review', appliedAt: NOW }, NOW);
    assert.equal(repo.memory.formalMap('f1')[1]?.state, 'needs_review');
  } finally {
    repo.close();
  }
});

test('the latest injection report is readable and empty before the first one', async () => {  const repo = await open();
  try {
    assert.equal(repo.memory.lastInjection(), null);
    repo.memory.recordInjection({ id: '11111111-1111-4111-8111-111111111111', hostId: 'host-a', sessionId: 's-1', rulesInjected: 2, rulesOmitted: null, memoriesInjected: 3, usedTokens: 700, createdAt: NOW });
    assert.equal(repo.memory.lastInjection()?.rulesInjected, 2);
    repo.memory.recordInjection({ id: '22222222-2222-4222-8222-222222222222', hostId: 'host-b', sessionId: 's-2', rulesInjected: 0, rulesOmitted: 'budget_exceeded', memoriesInjected: 0, usedTokens: 96, createdAt: '2026-11-10T10:05:00.000Z' });
    const latest = repo.memory.lastInjection();
    assert.equal(latest?.hostId, 'host-b');
    assert.equal(latest?.rulesOmitted, 'budget_exceeded');
    // A host narrows the report to its own rows, and the session filter narrows it further.
    assert.equal(repo.memory.lastInjection('host-a')?.rulesInjected, 2);
    assert.equal(repo.memory.lastInjection('host-a', 's-other'), null);
    assert.equal(repo.memory.lastInjection(undefined, 's-2')?.hostId, 'host-b');
    assert.equal(repo.memory.lastInjection('host-missing'), null);
  } finally {
    repo.close();
  }
});

test('a rule and an archive can be read back by id, and disabled rules are listed', async () => {
  const repo = await open();
  try {
    repo.memory.upsertRule({ entryId: 'r1', body: '启用中的准则', enabled: true, version: 1, withdrawnAt: null }, NOW);
    repo.memory.upsertRule({ entryId: 'r2', body: '停用的准则', enabled: false, version: 2, withdrawnAt: null }, NOW);
    assert.equal(repo.memory.rule('r1')?.body, '启用中的准则');
    assert.equal(repo.memory.rule('missing'), null);
    assert.deepEqual(repo.memory.allRules().map((row) => row.entryId).sort(), ['r1', 'r2']);
    assert.deepEqual(repo.memory.rulesFor().map((row) => row.entryId), ['r1']);
    repo.memory.upsertArchive({ entryId: 'a1', projectId: 'alpha', title: '标题', body: '正文', source: 'user', verification: 'verified', evidence: '证据', version: 1, withdrawnAt: null }, NOW);
    assert.equal(repo.memory.archive('a1')?.verification, 'verified');
    assert.equal(repo.memory.archive('missing'), null);
  } finally {
    repo.close();
  }
});

test('the edit base version is the highest confirmed entry version', async () => {
  const repo = await open();
  try {
    assert.equal(repo.entryVersion('f1'), 0);
    assert.equal(repo.memory.entryVersion('f1'), 0);
    // A local Provider mapping alone must not move the confirmed version.
    repo.memory.upsertFormalMap({ entryId: 'f1', version: 7, providerId: 'p-7', contentHash: 'b'.repeat(64), state: 'applied', appliedAt: NOW }, NOW);
    assert.equal(repo.entryVersion('f1'), 0);
    repo.memory.setEntryVersion('f1', 1, NOW);
    repo.memory.setEntryVersion('f1', 7, NOW);
    assert.equal(repo.entryVersion('f1'), 7);
    assert.equal(repo.memory.entryVersion('other'), 0);
  } finally {
    repo.close();
  }
});
