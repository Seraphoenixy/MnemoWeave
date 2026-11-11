import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, cp, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { RememberInput } from '../../packages/core/contracts/src/index.ts';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { MnemonCliProvider } from '../../packages/providers/mnemon/src/index.ts';
import { mnemonBinary } from './mnemon-binary.ts';

/**
 * Isolated restore drill: build one state directory, copy it as a backup would, then open the
 * copy as a second instance and read every class back through its authority.
 *
 * The manifest is deliberately explicit about what is and is not in the backup. Skill files,
 * drafts and backtests have no storage yet, so they are listed as absent rather than implied.
 */
test('an isolated copy restores rules, an archive with history, and a formal memory', async () => {
  await mkdir(resolve('work', 'restore-drill'), { recursive: true });
  const rootA = await mkdtemp(resolve('work', 'restore-drill', 'source-'));
  const stateA = join(rootA, 'state');
  const providerA = join(rootA, 'provider');
  await mkdir(stateA, { recursive: true });
  await mkdir(providerA, { recursive: true });

  const content = '隔离恢复演练：串口默认 115200，校验位为无。';
  const logicalId = randomUUID();
  const provider = new MnemonCliProvider({ binary: mnemonBinary(), dataDir: providerA, store: 'restore-drill' });
  const repo = new SqliteCandidates(join(stateA, 'governance.db'));
  let providerId = '';
  try {
    repo.memory.upsertRule({ entryId: 'rule-restore', body: '提交前必须运行类型检查。', enabled: true, version: 1, withdrawnAt: null }, '2026-11-10T00:00:00.000Z');
    repo.memory.upsertArchive({ entryId: 'archive-restore', projectId: 'alpha', title: '串口约定', body: '原始正文：9600。', source: 'user', verification: 'open', evidence: '实测', version: 1, withdrawnAt: null }, '2026-11-10T00:00:00.000Z');
    repo.memory.upsertArchive({ entryId: 'archive-restore', projectId: 'alpha', title: '串口约定', body: '现行正文：115200。', source: 'user', verification: 'open', evidence: '复测', version: 2, withdrawnAt: null, state: 'active' }, '2026-11-10T01:00:00.000Z');
    const written = await provider.persistReviewed(content, `candidate:${randomUUID()}`);
    providerId = written.id;
    const request = RememberInput.parse({
      idempotencyKey: `restore-${logicalId}`, content, knowledgeType: 'Practice', tags: ['restore'],
      projectId: 'alpha',
      provenance: {
        source: 'local-user', sourceReference: 'restore-drill', evidence: ['drill'], verificationStatus: 'verified',
        confidence: 1, applicability: 'project', limitations: '无', lastVerified: '2026-11-10T00:00:00.000Z',
      },
    });
    repo.catalog.publishSynced(logicalId, request, written.id, createHash('sha256').update(content).digest('hex'), '2026-11-10T02:00:00.000Z', 'sync', 'drill', {});
  } finally { repo.close(); }

  // The backup copies both authorities; nothing is exported or rewritten.
  const rootB = await mkdtemp(resolve('work', 'restore-drill', 'restored-'));
  await cp(stateA, join(rootB, 'state'), { recursive: true });
  await cp(providerA, join(rootB, 'provider'), { recursive: true });
  const restoredProvider = join(rootB, 'provider');
  const restored = new SqliteCandidates(join(rootB, 'state', 'governance.db'));
  try {
    assert.equal(restored.memory.everyRule().find(row => row.entryId === 'rule-restore')?.body, '提交前必须运行类型检查。');
    const archive = restored.memory.archive('archive-restore');
    assert.equal(archive?.title, '串口约定');
    assert.equal(archive?.body, '现行正文：115200。');
    assert.deepEqual(restored.memory.archiveHistory('archive-restore').map(row => row.version), [2, 1]);
    assert.equal(restored.memory.archiveUsage('alpha').activeBytes > 0, true);
    const publication = restored.catalog.get(logicalId);
    assert.equal(publication.projectId, 'alpha');
    const recalled = await new MnemonCliProvider({ binary: mnemonBinary(), dataDir: restoredProvider, store: 'restore-drill' }).recall({ query: '隔离恢复演练', limit: 5 });
    const hit = recalled.memories.find(memory => memory.id === providerId);
    assert.ok(hit, 'the formal memory is recalled from the restored Provider store');
    assert.equal(hit!.content, content);

    const manifest = {
      copied: ['state/governance.db', 'provider/'],
      verified: ['rule', 'archive', 'archiveHistory', 'archiveCapacity', 'formalMemory', 'formalOwnership'],
      separatelyRequired: ['skill files (no storage yet)', 'skill drafts', 'backtest records'],
      credentialsExcluded: true,
    };
    const drill = join(rootB, 'restore-report.json');
    await writeFile(drill, JSON.stringify(manifest, null, 2));
    assert.ok((await readdir(rootB)).includes('restore-report.json'));
    assert.ok((await stat(join(rootB, 'state', 'governance.db'))).size > 0);
  } finally { restored.close(); }
});
