import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MnemonCliProvider } from '../../packages/providers/mnemon/src/index.ts';
import { MnemoWeaveError } from '../../packages/core/contracts/src/index.ts';
import { tempDir } from '../support/temp.ts';

/** `embed --status` is the official coverage report; the adapter must not invent metrics. */

async function provider(rows: Record<string, unknown>): Promise<MnemonCliProvider> {
  return new MnemonCliProvider({
    binary: 'mnemon', dataDir: await tempDir('provider-embedding', 'embedding'), store: 'diag',
    runner: async (args) => {
      if (args.includes('--version')) return 'mnemon version 0.2.13';
      if (!args.includes('embed') || !args.includes('--status')) throw new Error(`unexpected command: ${args.join(' ')}`);
      return JSON.stringify(rows);
    },
  });
}

test('embedding status comes from the official coverage report', async () => {
  const adapter = await provider({
    coverage: '50%', embedded: 2, embedding_available: true, model: 'nomic-embed-text',
    ollama_available: true, protocol: 'ollama', total_insights: 4,
  });
  assert.deepEqual(await adapter.embeddingStatus(), {
    serviceAvailable: true, modelAvailable: true, protocol: 'ollama', model: 'nomic-embed-text', embedded: 2, total: 4,
  });
});

test('an unreachable embedding service is reported, not turned into a probe failure', async () => {
  const adapter = await provider({
    coverage: '0%', embedded: 0, embedding_available: false, model: 'nomic-embed-text',
    ollama_available: false, protocol: 'ollama', total_insights: 0,
  });
  const status = await adapter.embeddingStatus();
  assert.equal(status.serviceAvailable, false);
  assert.equal(status.modelAvailable, false);
  assert.equal(status.total, 0);
});

test('an unexpected payload is a protocol error instead of guessed values', async () => {
  const adapter = await provider({ coverage: '50%' });
  await assert.rejects(adapter.embeddingStatus(), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'PROVIDER_PROTOCOL');
});

test('a failed backfill reports a code instead of pretending success', async () => {
  const adapter = new MnemonCliProvider({
    binary: 'mnemon', dataDir: await tempDir('provider-embedding', 'provider-embedding'), store: 'diag',
    runner: async (args) => {
      if (args.includes('--version')) return 'mnemon version 0.2.13';
      throw new Error('Ollama embedding provider not available at http://localhost:11434');
    },
  });
  assert.deepEqual(await adapter.embedAll(), { error: 'PROVIDER_UNAVAILABLE' });
});

test('a completed backfill reports no error; the caller re-reads coverage for the outcome', async () => {
  const adapter = new MnemonCliProvider({
    binary: 'mnemon', dataDir: await tempDir('provider-embedding', 'provider-embedding'), store: 'diag',
    runner: async (args) => {
      if (args.includes('--version')) return 'mnemon version 0.2.13';
      if (args.includes('embed') && args.includes('--all')) return '{"embedded":2}';
      throw new Error(`unexpected command: ${args.join(' ')}`);
    },
  });
  assert.deepEqual(await adapter.embedAll(), { error: null });
});
