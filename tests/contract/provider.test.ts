import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { MnemonCliProvider, createRunner } from '../../packages/providers/mnemon/src/index.ts';
import { MnemoWeaveError } from '../../packages/core/contracts/src/index.ts';

test('CLI argument boundary protects flag-like content and passes explicit store', async () => {
  const calls: string[][] = [];
  const provider = new MnemonCliProvider({ binary: process.execPath, dataDir: resolve('work/test-contract'), store: 'acceptance', runner: async args => {
    calls.push(args);
    return args[0] === '--version' ? 'mnemon version 0.2.13\n' : '{"results":[]}';
  } });
  await provider.recall({ query: '--data-dir evil & echo bad', limit: 3 });
  assert.deepEqual(calls[1], ['--data-dir', resolve('work/test-contract'), '--store', 'acceptance', 'recall', '--limit', '3', '--', '--data-dir evil & echo bad']);
});
test('Unknown versions and malformed Provider payloads fail explicitly', async () => {
  for (const [version, body, code] of [
    ['0.2.14', '{}', 'UNSUPPORTED_VERSION'], ['0.2.13', 'bad json', 'PROVIDER_PROTOCOL'], ['0.2.13', '{"results":[{}]}', 'PROVIDER_PROTOCOL'],
  ]) {
    const provider = new MnemonCliProvider({ binary: process.execPath, dataDir: resolve('work/test-contract'), store: 'acceptance', runner: async args => args[0] === '--version' ? `mnemon version ${version}` : body! });
    await assert.rejects(provider.recall({ query: 'x', limit: 1 }), (error: unknown) => error instanceof MnemoWeaveError && error.code === code);
  }
});
test('Process timeout and output overflow are surfaced without stderr leakage', async () => {
  await assert.rejects(createRunner(process.execPath, 50)(['-e', 'setTimeout(()=>{},10000)']), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'PROVIDER_TIMEOUT');
  await assert.rejects(createRunner(process.execPath, 5000, 32)(['-e', 'process.stdout.write("x".repeat(1000))']), MnemoWeaveError);
});
test('Failed invocation does not poison serialized queue', async () => {
  let count = 0;
  const provider = new MnemonCliProvider({ binary: process.execPath, dataDir: resolve('work/test-contract'), store: 'acceptance', runner: async args => {
    if (args[0] === '--version') return 'mnemon version 0.2.13';
    if (++count === 1) throw new MnemoWeaveError('PROVIDER_UNAVAILABLE');
    return '{"results":[]}';
  } });
  await assert.rejects(provider.recall({ query: 'a', limit: 1 }));
  assert.deepEqual(await provider.recall({ query: 'b', limit: 1 }), { memories: [] });
});
test('Skipped Remember resolves replaced_id, and rejects missing replacement identity', async () => {
  for (const body of ['{"id":"attempt","action":"skipped","replaced_id":"existing"}', '{"id":"attempt","action":"skipped"}']) {
    const provider = new MnemonCliProvider({ binary: process.execPath, dataDir: resolve('work/test-contract'), store: 'acceptance', runner: async args => args[0] === '--version' ? 'mnemon version 0.2.13' : body });
    if (body.includes('replaced_id')) assert.deepEqual(await provider.acceptanceRemember('duplicate'), { id: 'existing', action: 'skipped' });
    else await assert.rejects(provider.acceptanceRemember('duplicate'), MnemoWeaveError);
  }
});
test('Bounded reconciliation never treats a truncated wildcard query as proof of absence', async () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({ id: String(index), content: 'other content' }));
  const provider = new MnemonCliProvider({ binary: process.execPath, dataDir: resolve('work/test-contract'), store: 'acceptance', runner: async args => args[0] === '--version' ? 'mnemon version 0.2.13' : JSON.stringify(rows) });
  assert.deepEqual(await provider.inspectExact('%'), { matches: [], complete: false });
});
