import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { MnemonCliProvider } from '../../packages/providers/mnemon/src/index.ts';
import { MnemoWeaveError } from '../../packages/core/contracts/src/index.ts';

/**
 * The page's startup cost was dominated by CLI process starts, not by data volume. These tests
 * pin the three things that removed most of it: one version check instead of one per command, a
 * body cache that a deletion invalidates, and a batched read for the list.
 */

const dataDir = resolve('work/test-provider-cache');

function fakeProvider(body: string, onCall?: (args: string[]) => void) {
  const calls: string[][] = [];
  const provider = new MnemonCliProvider({
    binary: process.execPath, dataDir, store: 'acceptance',
    runner: async args => {
      calls.push(args);
      onCall?.(args);
      if (args[0] === '--version') return 'mnemon version 0.2.13';
      // A show answer must echo the id it was asked for, or the Provider rejects it as malformed.
      const asked = args[args.length - 1]!;
      return args.includes('show') ? JSON.stringify({ id: asked, content: body }) : body;
    },
  });
  return { provider, calls };
}

test('the version is checked once, not before every command', async () => {
  const { provider, calls } = fakeProvider('{"results":[]}');
  await provider.recall({ query: 'a', limit: 1 });
  await provider.recall({ query: 'b', limit: 1 });
  await provider.recall({ query: 'c', limit: 1 });
  const versionCalls = calls.filter(args => args[0] === '--version');
  assert.equal(versionCalls.length, 1, 'three commands must not spawn three version checks');
  assert.equal(calls.length, 4, 'one version check plus three commands');
});

test('an unsupported version is still refused, and the refusal is not cached', async () => {
  let version = 'mnemon version 0.2.14';
  const provider = new MnemonCliProvider({
    binary: process.execPath, dataDir, store: 'acceptance',
    runner: async args => args[0] === '--version' ? version : '{"results":[]}',
  });
  await assert.rejects(provider.recall({ query: 'a', limit: 1 }), (error: unknown) => (error as { code?: string }).code === 'UNSUPPORTED_VERSION');
  // After an upgrade the next command succeeds: a failed check left nothing cached.
  version = 'mnemon version 0.2.13';
  assert.deepEqual(await provider.recall({ query: 'a', limit: 1 }), { memories: [] });
});

test('reads open an immutable snapshot once the store is known to exist', async () => {
  const { provider, calls } = fakeProvider('正文');
  // The first call of the process opens normally: a store that does not exist yet cannot be
  // opened read-only, and that open is what creates it.
  await provider.readMemory('native-1');
  const first = calls.find(args => args.includes('show'));
  assert.equal(first?.includes('--readonly'), false, 'the first open creates the store');

  await provider.readMemory('native-2');
  const second = calls.filter(args => args.includes('show'))[1];
  assert.ok(second?.includes('--readonly'), 'later reads must not open the database read-write');
  assert.ok(second!.indexOf('--readonly') < second!.indexOf('show'), 'the global flag precedes the subcommand');
});

test('a genuine Provider failure is surfaced, never retried behind the caller', async () => {
  let attempts = 0;
  const provider = new MnemonCliProvider({
    binary: process.execPath, dataDir, store: 'acceptance',
    runner: async args => {
      if (args[0] === '--version') return 'mnemon version 0.2.13';
      attempts += 1;
      throw new MnemoWeaveError('PROVIDER_UNAVAILABLE');
    },
  });
  await assert.rejects(provider.readMemory('native-1'), (error: unknown) => (error as { code?: string }).code === 'PROVIDER_UNAVAILABLE');
  // One attempt for the command, plus the one-time version check. A retry would double this and
  // hide the outage from the caller.
  assert.equal(attempts, 1, 'the failure must not be retried');
});

test('a body read twice is served from memory the second time', async () => {
  const { provider, calls } = fakeProvider('正文');
  const first = await provider.readMemory('native-1');
  const second = await provider.readMemory('native-1');
  assert.deepEqual(first, second);
  const shows = calls.filter(args => args.includes('show'));
  assert.equal(shows.length, 1, 'the second read must not spawn another process');
});

test('forgetting a memory drops its cached body', async () => {
  let body = '{"id":"native-1","content":"正文"}';
  const provider = new MnemonCliProvider({
    binary: process.execPath, dataDir, store: 'acceptance',
    runner: async args => {
      if (args[0] === '--version') return 'mnemon version 0.2.13';
      if (args.includes('forget')) { body = '{"id":"native-1","status":"deleted"}'; return body; }
      return body;
    },
  });
  await provider.readMemory('native-1');
  await provider.forget('native-1');
  // A deleted id must never be answered from the cache; the provider re-reads and fails.
  body = '{"id":"native-1","content":"正文"}';
  const afterForget = await provider.readMemory('native-1');
  assert.equal(afterForget.content, '正文', 'the read went back to the Provider');
});

test('reading many bodies returns each one and keeps a failed id out of the way', async () => {
  const bodies: Record<string, string> = { a: '甲', b: '乙', c: '丙' };
  const reads: string[] = [];
  const provider = new MnemonCliProvider({
    binary: process.execPath, dataDir, store: 'acceptance',
    runner: async args => {
      if (args[0] === '--version') return 'mnemon version 0.2.13';
      const id = args[args.length - 1]!;
      reads.push(id);
      if (id === 'missing') throw new Error('not found');
      return JSON.stringify({ id, content: bodies[id] });
    },
  });
  const rows = await provider.readMany(['a', 'b', 'missing', 'c']);
  assert.deepEqual(rows, [{ id: 'a', content: '甲' }, { id: 'b', content: '乙' }, { id: 'c', content: '丙' }]);
  // The order the caller asked for is preserved, and the unreadable id left no placeholder.
  assert.deepEqual(reads.sort(), ['a', 'b', 'c', 'missing']);
});

test('a batched read of cached bodies starts no process at all', async () => {
  const { provider, calls } = fakeProvider('甲');
  await provider.readMemory('a');
  const before = calls.length;
  assert.deepEqual(await provider.readMany(['a']), [{ id: 'a', content: '甲' }]);
  assert.equal(calls.length, before, 'the batch was answered from cache');
});
