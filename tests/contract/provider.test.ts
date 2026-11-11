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
  // The user's text stays one positional argument after `--`; `--readonly` marks this as an
  // immutable snapshot read, and still precedes the subcommand.
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
test('Sync Remember passes the change identity as source and bypasses duplicate detection', async () => {
  const calls: string[][] = [];
  const changeId = '11111111-1111-4111-8111-111111111111';
  const provider = new MnemonCliProvider({ binary: process.execPath, dataDir: resolve('work/test-contract'), store: 'acceptance', runner: async args => {
    calls.push(args);
    return args[0] === '--version' ? 'mnemon version 0.2.13' : '{"id":"native-1","action":"added"}';
  } });
  assert.deepEqual(await provider.syncRemember('跨机写入', changeId, 2), { id: 'native-1', action: 'added', replacedId: null });
  assert.deepEqual(calls[1], ['--data-dir', resolve('work/test-contract'), '--store', 'acceptance', 'remember', '--source', `mnemoweave:${changeId}:2`, '--no-diff', '--', '跨机写入']);
  await assert.rejects(provider.syncRemember('x', 'not-a-uuid', 2), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'INVALID_INPUT');
  await assert.rejects(provider.syncRemember('x'.repeat(8001), changeId, 1), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'INVALID_INPUT');
});
test('Forget and related read back native state without inventing edges', async () => {
  const calls: string[][] = [];
  const provider = new MnemonCliProvider({ binary: process.execPath, dataDir: resolve('work/test-contract'), store: 'acceptance', runner: async args => {
    calls.push(args);
    if (args[0] === '--version') return 'mnemon version 0.2.13';
    return args.includes('forget') ? '{"id":"native-1","status":"deleted"}' : JSON.stringify([{ id: 'native-old', content: '旧版本', depth: 1, via_edge_type: 'supersedes' }]);
  } });
  assert.deepEqual(await provider.forget('native-1'), { id: 'native-1', status: 'deleted' });
  // Located by content, not by index: the version check is cached after the first command, so the
  // call numbering is no longer one-version-check-per-command.
  const forgetCall = calls.find(args => args.includes('forget'));
  assert.deepEqual(forgetCall, ['--data-dir', resolve('work/test-contract'), '--store', 'acceptance', 'forget', 'native-1']);
  assert.deepEqual(await provider.related('native-1', 'supersedes', 1), [{ id: 'native-old', content: '旧版本', depth: 1, viaEdgeType: 'supersedes' }]);
  const relatedCall = calls.find(args => args.includes('related'));
  // Reads open an immutable snapshot: no WAL files, and writes are rejected by the CLI itself.
  assert.deepEqual(relatedCall, ['--data-dir', resolve('work/test-contract'), '--store', 'acceptance', '--readonly', 'related', 'native-1', '--edge', 'supersedes', '--depth', '1']);
  await assert.rejects(provider.related('native-1', 'unknown' as never), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'INVALID_INPUT');
  await assert.rejects(provider.related('native-1', 'semantic', 6), (error: unknown) => error instanceof MnemoWeaveError && error.code === 'INVALID_INPUT');
});
