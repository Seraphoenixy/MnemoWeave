import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRunner, MnemonCliProvider } from '../../packages/providers/mnemon/src/index.ts';
import { MnemoWeaveError } from '../../packages/core/contracts/src/index.ts';
import { mnemonBinary } from './mnemon-binary.ts';
import { tempDir } from '../support/temp.ts';

test('Official CLI: special text, Link, Forget, store isolation and process persistence', { timeout: 60000 }, async t => {
  const oldCapacity = process.env.MNEMON_MAX_INSIGHTS;
  const oldGrace = process.env.MNEMON_AUTO_PRUNE_MIN_AGE;
  process.env.MNEMON_MAX_INSIGHTS = '1'; process.env.MNEMON_AUTO_PRUNE_MIN_AGE = '0';
  t.after(() => {
    if (oldCapacity === undefined) delete process.env.MNEMON_MAX_INSIGHTS; else process.env.MNEMON_MAX_INSIGHTS = oldCapacity;
    if (oldGrace === undefined) delete process.env.MNEMON_AUTO_PRUNE_MIN_AGE; else process.env.MNEMON_AUTO_PRUNE_MIN_AGE = oldGrace;
  });
  await mkdir('work/e2e', { recursive: true });
  const dataDir = await tempDir('cli-behavior', 'cli');
  const binary = mnemonBinary();
  const run = createRunner(binary);
  const args = ['--data-dir', dataDir, '--store', 'behavior'];
  const content = '--特殊字符 引号 \\路径\n第二行 & | ; $(echo unsafe) % _ MnemoWeave';
  const provider = new MnemonCliProvider({ binary, dataDir, store: 'behavior' });
  const first = await provider.acceptanceRemember(content);
  assert.equal(first.action, 'added');
  assert.equal(await provider.verifyContent(first.id, content), true);
  assert.equal(await provider.verifyContent(first.id, 'different'), false);
  const reopened = new MnemonCliProvider({ binary, dataDir, store: 'behavior' });
  assert.equal(await reopened.verifyContent(first.id, content), true);
  assert.equal((await reopened.inspectExact(content)).matches[0]?.id, first.id);
  const isolated = new MnemonCliProvider({ binary, dataDir, store: 'other' });
  assert.deepEqual((await isolated.recall({ query: 'MnemoWeave', limit: 5 })).memories, []);
  const second = await provider.acceptanceRemember('Another independently reviewed test fact for graph linking.');
  const link = JSON.parse(await run([...args, 'link', first.id, second.id, '--type', 'semantic', '--weight', '0.8']));
  assert.equal(link.status, 'linked');
  const related = JSON.parse(await run([...args, 'related', first.id]));
  assert.ok(related.some((row: { id: string }) => row.id === second.id));
  const deleted = JSON.parse(await run([...args, 'forget', first.id]));
  assert.equal(deleted.status, 'deleted');
  assert.deepEqual((await provider.inspectExact(content)).matches, []);
  await assert.rejects(run([...args, 'remember', '--imp', '99', '--', 'must fail']));
  await assert.rejects(run([...args, 'link', second.id, second.id, '--type', 'unsupported']));
  await assert.rejects(run(['--data-dir', dataDir, '--store', '../bad', 'status']));
});

test('Lost CLI response after a committed write is reconciled without another write', { timeout: 30000 }, async () => {
  await mkdir('work/e2e', { recursive: true });
  const dataDir = await tempDir('cli-behavior', 'uncertain');
  const binary = mnemonBinary();
  const native = createRunner(binary);
  let writes = 0;
  const provider = new MnemonCliProvider({ binary, dataDir, store: 'uncertain', runner: async args => {
    const output = await native(args);
    if (args.includes('remember')) { writes++; throw new MnemoWeaveError('PROVIDER_TIMEOUT'); }
    return output;
  } });
  const content = 'MnemoWeave lost-response test: committed content must be reconciled.';
  await assert.rejects(provider.acceptanceRemember(content), MnemoWeaveError);
  const result = await provider.inspectExact(content);
  assert.equal(result.complete, true);
  assert.equal(result.matches.length, 1);
  assert.equal(await provider.verifyContent(result.matches[0]!.id, content), true);
  assert.equal(writes, 1);
});
