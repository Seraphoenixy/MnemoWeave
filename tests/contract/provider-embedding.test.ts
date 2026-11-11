import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MnemonCliProvider } from '../../packages/providers/mnemon/src/index.ts';
import { MnemoWeaveError } from '../../packages/core/contracts/src/index.ts';
import { mnemonBinary } from '../e2e/mnemon-binary.ts';

/** `embed --status` is the official coverage report; the adapter must not invent metrics. */

function provider(rows: Record<string, unknown>): MnemonCliProvider {
  return new MnemonCliProvider({
    binary: 'mnemon', dataDir: resolve('work', 'provider-embedding'), store: 'diag',
    runner: async (args) => {
      if (args.includes('--version')) return 'mnemon version 0.2.13';
      if (!args.includes('embed') || !args.includes('--status')) throw new Error(`unexpected command: ${args.join(' ')}`);
      return JSON.stringify(rows);
    },
  });
}

test('embedding status comes from the official coverage report', async () => {
  const adapter = provider({
    coverage: '50%', embedded: 2, embedding_available: true, model: 'nomic-embed-text',
    ollama_available: true, protocol: 'ollama', total_insights: 4,
  });
  assert.deepEqual(await adapter.embeddingStatus(), {
    serviceAvailable: true, modelAvailable: true, protocol: 'ollama', model: 'nomic-embed-text', embedded: 2, total: 4,
  });
});

test('an unreachable embedding service is reported, not turned into a probe failure', async () => {
  const adapter = provider({
    coverage: '0%', embedded: 0, embedding_available: false, model: 'nomic-embed-text',
    ollama_available: false, protocol: 'ollama', total_insights: 0,
  });
  const status = await adapter.embeddingStatus();
  assert.equal(status.serviceAvailable, false);
  assert.equal(status.modelAvailable, false);
  assert.equal(status.total, 0);
});

test('an unexpected payload is a protocol error instead of guessed values', async () => {
  const adapter = provider({ coverage: '50%' });
  await assert.rejects(adapter.embeddingStatus(), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'PROVIDER_PROTOCOL');
});

test('a failed backfill reports a code instead of pretending success', async () => {
  const adapter = new MnemonCliProvider({
    binary: 'mnemon', dataDir: resolve('work', 'provider-embedding'), store: 'diag',
    runner: async (args) => {
      if (args.includes('--version')) return 'mnemon version 0.2.13';
      throw new Error('Ollama embedding provider not available at http://localhost:11434');
    },
  });
  assert.deepEqual(await adapter.embedAll(), { error: 'PROVIDER_UNAVAILABLE' });
});

test('a completed backfill reports no error; the caller re-reads coverage for the outcome', async () => {
  const adapter = new MnemonCliProvider({
    binary: 'mnemon', dataDir: resolve('work', 'provider-embedding'), store: 'diag',
    runner: async (args) => {
      if (args.includes('--version')) return 'mnemon version 0.2.13';
      if (args.includes('embed') && args.includes('--all')) return '{"embedded":2}';
      throw new Error(`unexpected command: ${args.join(' ')}`);
    },
  });
  assert.deepEqual(await adapter.embedAll(), { error: null });
});

test('the real CLI answers the coverage report without an embedding service', async () => {  await mkdtemp(resolve('work')).catch(() => undefined);
  const dataDir = await mkdtemp(resolve('work', 'embed-real-'));
  const adapter = new MnemonCliProvider({ binary: mnemonBinary(), dataDir, store: 'diagnostics' });
  const status = await adapter.embeddingStatus();
  assert.equal(status.protocol.length > 0, true);
  assert.equal(status.model.length > 0, true);
  assert.equal(typeof status.serviceAvailable, 'boolean');
  assert.equal(typeof status.modelAvailable, 'boolean');
  assert.equal(status.embedded, 0);
  assert.equal(status.total, 0);
  // Whether Ollama happens to run here is environment-dependent; the shape is what this checks.
  if (status.serviceAvailable) assert.equal(typeof status.modelAvailable, 'boolean');
});
