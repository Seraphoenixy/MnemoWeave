import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { MnemoWeaveError } from '../../packages/core/contracts/src/index.ts';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { tempDir } from '../support/temp.ts';

const NOW = '2026-11-10T10:00:00.000Z';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';

async function open() {
  const path = join(await tempDir('memory-store', 'memory-store'), 'governance.db');
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

test('workspace archives keep verification state and can be read with withdrawn rows', async () => {
  const repo = await open();
  try {
    repo.memory.upsertArchive({ entryId: 'a1', workspaceId: WORKSPACE, title: '游标按同步流', body: '正文', source: 'session', verification: 'open', evidence: '三次实验', version: 1, withdrawnAt: null }, NOW);
    repo.memory.upsertArchive({ entryId: 'a2', workspaceId: WORKSPACE, title: '旧结论', body: '正文', source: 'tool', verification: 'refuted', evidence: '反例', version: 1, withdrawnAt: null }, NOW);
    repo.memory.withdrawArchive('a2', NOW);
    assert.deepEqual(repo.memory.archivesFor(WORKSPACE).map((row) => row.entryId), ['a1']);
    assert.equal(repo.memory.archivesFor(WORKSPACE, true).length, 2);
    assert.equal(repo.memory.archivesFor(WORKSPACE)[0]?.verification, 'open');
    // Another workspace sees nothing from this one.
    assert.deepEqual(repo.memory.archivesFor('22222222-2222-4222-8222-222222222222'), []);
  } finally {
    repo.close();
  }
});

test('archive state changes are readable and history keeps every version body', async () => {
  const repo = await open();
  try {
    repo.memory.upsertArchive({ entryId: 'a1', workspaceId: WORKSPACE, title: '原标题', body: '原始正文', source: 'user', verification: 'open', evidence: '证据', version: 1, withdrawnAt: null }, NOW);
    assert.equal(repo.memory.archiveHistory('a1').at(0)?.state, 'active');
    repo.memory.upsertArchive({ entryId: 'a1', workspaceId: WORKSPACE, title: '原标题', body: '原始正文', source: 'user', verification: 'open', evidence: '证据', version: 2, withdrawnAt: null, state: 'archived', archivedAt: NOW }, NOW);
    assert.equal(repo.memory.archive('a1')?.state, 'archived');
    const history = repo.memory.archiveHistory('a1');
    assert.deepEqual(history.map(row => row.version), [2, 1]);
    assert.equal(history[0]?.state, 'archived');
    assert.equal(history[1]?.body, '原始正文');
    assert.equal(history[1]?.state, 'active');
    assert.equal(repo.memory.archiveUsage(WORKSPACE).activeBytes, 0);
    assert.equal(repo.memory.archiveUsage(WORKSPACE).archivedCount, 1);
  } finally {
    repo.close();
  }
});

test('a synced rule set over capacity is refused instead of archived locally', async () => {
  const repo = await open();
  try {
    // Two 8 KiB rules are over the 10,000-byte capacity once the delimiter is counted.
    repo.memory.upsertRule({ entryId: 'critical', body: 'c'.repeat(8192), enabled: true, version: 1, withdrawnAt: null, importance: 'critical' }, NOW);
    assert.throws(
      () => repo.memory.applyRuleWithCapacity({ entryId: 'normal', body: 'n'.repeat(2000), enabled: true, version: 1, withdrawnAt: null }, NOW, { capacityBytes: 10_000, itemMaxBytes: 8192 }),
      (error: unknown) => error instanceof MnemoWeaveError && error.code === 'RULE_CAPACITY_EXCEEDED',
    );
    // Nothing was archived or dropped: the resident set is exactly what it was.
    assert.deepEqual(repo.memory.allRules().map(row => row.entryId), ['critical']);
    assert.deepEqual(repo.memory.ruleArchive(), []);
  } finally {
    repo.close();
  }
});

test('a within-capacity synced rule is applied without maintenance', async () => {
  const repo = await open();
  try {
    repo.memory.upsertRule({ entryId: 'critical', body: 'c'.repeat(4000), enabled: true, version: 1, withdrawnAt: null, importance: 'critical' }, NOW);
    repo.memory.applyRuleWithCapacity({ entryId: 'normal', body: 'n'.repeat(4000), enabled: true, version: 1, withdrawnAt: null }, '2026-11-10T10:00:01.000Z', { capacityBytes: 10_000, itemMaxBytes: 8192 });
    assert.deepEqual(repo.memory.allRules().map(row => row.entryId).sort(), ['critical', 'normal']);
    assert.equal(repo.memory.rule('critical')?.body, 'c'.repeat(4000));
  } finally {
    repo.close();
  }
});

test('the formal map records one provider id per revision', async () => {
  const repo = await open();
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

test('the latest injection report is readable and empty before the first one', async () => {
  const repo = await open();
  try {
    assert.equal(repo.memory.lastInjection(), null);
    repo.memory.recordInjection({ id: '11111111-1111-4111-8111-111111111111', hostId: 'host-a', sessionId: 's-1', ruleCount: 2, usedBytes: 700, createdAt: NOW });
    assert.equal(repo.memory.lastInjection()?.ruleCount, 2);
    repo.memory.recordInjection({ id: '22222222-2222-4222-8222-222222222222', hostId: 'host-b', sessionId: 's-2', ruleCount: 0, usedBytes: 0, failure: 'output_limit', createdAt: '2026-11-10T10:05:00.000Z' });
    const latest = repo.memory.lastInjection();
    assert.equal(latest?.hostId, 'host-b');
    assert.equal(latest?.failure, 'output_limit');
    // A host narrows the report to its own rows, and the session filter narrows it further.
    assert.equal(repo.memory.lastInjection('host-a')?.ruleCount, 2);
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
    repo.memory.upsertArchive({ entryId: 'a1', workspaceId: WORKSPACE, title: '标题', body: '正文', source: 'user', verification: 'verified', evidence: '证据', version: 1, withdrawnAt: null }, NOW);
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

test('an entry never records a project owner', async () => {
  const repo = await open();
  try {
    repo.memory.upsertRule({ entryId: 'r1', body: '准则', enabled: true, version: 1, withdrawnAt: null }, NOW);
    const db = (repo as unknown as { db: import('node:sqlite').DatabaseSync }).db;
    const columns = db.prepare("PRAGMA table_info('catalog_memories')").all().map(row => String(row['name']));
    assert.equal(columns.includes('project_id'), false, 'a store created by this code has no owner column');
    // Older data is preserved in a migration backup table, never read by the product.
    const backup = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='legacy_project_owners'").get();
    assert.ok(backup, 'the legacy attribution is kept as a migration backup');
  } finally {
    repo.close();
  }
});

test('workspace registration is idempotent and a rename is refused', async () => {
  const repo = await open();
  try {
    const first = repo.workspaces.register(WORKSPACE, '甲工作区');
    assert.equal(first.name, '甲工作区');
    assert.equal(repo.workspaces.register(WORKSPACE, '甲工作区').workspaceId, WORKSPACE);
    assert.throws(() => repo.workspaces.register(WORKSPACE, '乙工作区'), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'INVALID_STATE');
  } finally {
    repo.close();
  }
});

test('a session binding is recorded once and cannot be switched mid-session', async () => {
  const repo = await open();
  const other = '33333333-3333-4333-8333-333333333333';
  try {
    repo.workspaces.register(WORKSPACE, '甲工作区');
    repo.workspaces.register(other, '乙工作区');
    assert.equal(repo.workspaces.bindSession('host-a', 's-1', WORKSPACE).workspaceId, WORKSPACE);
    assert.equal(repo.workspaces.sessionWorkspace('host-a', 's-1'), WORKSPACE);
    // The same value is idempotent; a different one is a refused switch.
    assert.equal(repo.workspaces.bindSession('host-a', 's-1', WORKSPACE).workspaceId, WORKSPACE);
    assert.throws(() => repo.workspaces.bindSession('host-a', 's-1', other), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'INVALID_STATE');
    // A session that recorded no binding keeps that answer.
    assert.equal(repo.workspaces.bindSession('host-a', 's-2', null).workspaceId, null);
    assert.equal(repo.workspaces.sessionWorkspace('host-a', 's-2'), null);
  } finally {
    repo.close();
  }
});

test('a directory can bind only to one workspace', async () => {
  const repo = await open();
  const other = '33333333-3333-4333-8333-333333333333';
  const root = await tempDir('memory-store', 'workspace-root');
  try {
    repo.workspaces.register(WORKSPACE, '甲工作区');
    repo.workspaces.register(other, '乙工作区');
    repo.workspaces.bind(WORKSPACE, root);
    assert.equal(repo.workspaces.workspaceForRoot(root), WORKSPACE);
    assert.equal(repo.workspaces.bindingCount(WORKSPACE), 1);
    assert.throws(() => repo.workspaces.bind(other, root), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'INVALID_STATE');
    assert.throws(() => repo.workspaces.bind(WORKSPACE, join(root, 'missing')), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'INVALID_INPUT');
  } finally {
    repo.close();
  }
});

test('the turn store refuses to reuse an event id with a different payload', async () => {
  const repo = await open();
  try {
    const event = {
      protocolVersion: '1', adapterVersion: '0.1.0', eventId: 'event-0001', sessionId: 's-1', turnId: '1',
      kind: 'message.user' as const, occurredAt: NOW, receivedAt: NOW, sourceRef: 'test',
      payload: { text: '以后都用 pnpm' },
    };
    assert.equal(repo.turns.observe('host-a', event).status, 'stored');
    assert.equal(repo.turns.observe('host-a', event).status, 'replayed');
    assert.throws(
      () => repo.turns.observe('host-a', { ...event, payload: { text: '以后都用 npm' } }),
      (error: unknown) => error instanceof MnemoWeaveError && error.code === 'IDEMPOTENCY_CONFLICT',
    );
    assert.equal(repo.turns.isNoRetention('host-a', 's-1', '1'), false);
    assert.equal(repo.turns.observe('host-a', { ...event, eventId: 'event-0002', turnId: '2', payload: { text: '这次不要留存', noRetention: true } }).status, 'stored');
    assert.equal(repo.turns.isNoRetention('host-a', 's-1', '2'), true);
    // The marker covers the turn that carried it, not the session.
    assert.equal(repo.turns.isNoRetention('host-a', 's-1', '1'), false);
    assert.equal(repo.turns.isNoRetention('host-b', 's-1', '2'), false);
  } finally {
    repo.close();
  }
});
