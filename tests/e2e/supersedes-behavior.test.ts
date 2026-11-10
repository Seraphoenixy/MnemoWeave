import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createRunner, MnemonCliProvider } from '../../packages/providers/mnemon/src/index.ts';
import { mnemonBinary } from './mnemon-binary.ts';

test('Official supersedes: replay preserves edge count/history; related is not directional; recall flag survives adapter', { timeout: 30000 }, async () => {
  await mkdir('work/e2e', { recursive: true });
  const dataDir = await mkdtemp(resolve('work/e2e/supersedes-'));
  const binary = mnemonBinary();
  const provider = new MnemonCliProvider({ binary, dataDir, store: 'relations' });
  const run = createRunner(binary);
  const prefix = ['--data-dir', dataDir, '--store', 'relations'];
  const oldText = 'MnemoWeave supersedes fixture: project transport uses design A.';
  const newText = 'MnemoWeave supersedes fixture: reviewed project transport now uses design B.';
  const oldMemory = await provider.acceptanceRemember(oldText);
  const newMemory = await provider.acceptanceRemember(newText);
  const metadata = { operationId: randomUUID(), reason: '评审决定替代，保留历史 & $(literal)', effectiveAt: '2026-11-08T00:00:00Z' };
  assert.deepEqual(await provider.linkSupersedes(newMemory.id, oldMemory.id, metadata), { sourceId: newMemory.id, targetId: oldMemory.id, edgeType: 'supersedes' });
  const status = () => run([...prefix, 'status']).then(output => JSON.parse(output) as { edge_count: number });
  const afterFirst = await status();
  await provider.linkSupersedes(newMemory.id, oldMemory.id, metadata);
  assert.equal((await status()).edge_count, afterFirst.edge_count);
  assert.equal(await provider.verifyContent(oldMemory.id, oldText), true);
  assert.equal(await provider.verifyContent(newMemory.id, newText), true);
  const related = (id: string) => run([...prefix, 'related', id, '--edge', 'supersedes', '--depth', '1']).then(output => JSON.parse(output) as { id: string; depth: number; via_edge_type: string }[]);
  assert.ok((await related(newMemory.id)).some(row => row.id === oldMemory.id && row.depth === 1));
  // Native traversal follows incident edges: this does NOT imply an old->new supersedes edge exists.
  assert.ok((await related(oldMemory.id)).some(row => row.id === newMemory.id && row.depth === 1));
  const recalled = await provider.recall({ query: 'MnemoWeave supersedes fixture', limit: 10 });
  assert.equal(recalled.memories.find(memory => memory.id === oldMemory.id)?.superseded, true);
  assert.notEqual(recalled.memories.find(memory => memory.id === newMemory.id)?.superseded, true);
  await assert.rejects(provider.linkSupersedes(newMemory.id, newMemory.id, metadata));
  await assert.rejects(provider.linkSupersedes(newMemory.id, randomUUID(), metadata));
});
