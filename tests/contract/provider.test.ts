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
  // `--limit` is the widened candidate pool, and `--verbose` is what carries signal similarity;
  // the user's text is still one positional argument after `--`.
  assert.deepEqual(calls[1], ['--data-dir', resolve('work/test-contract'), '--store', 'acceptance', 'recall', '--limit', '20', '--verbose', '--', '--data-dir evil & echo bad']);
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

test('listAll reads the whole store rather than one page', async () => {
  // A page-sized read would let a caller mistake "not on this page" for "not in the store", so
  // the whole-library read asks for everything and refuses a wrapped payload shape instead of
  // returning the wrapper as if it were a row.
  const rows = Array.from({ length: 3 }, (_, index) => ({ id: `p${index}`, content: `正文 ${index}`, category: 'insight' }));
  const calls: string[][] = [];
  const provider = new MnemonCliProvider({
    binary: process.execPath, dataDir: resolve('work/test-contract'), store: 'acceptance',
    runner: async args => {
      calls.push(args);
      if (args[0] === '--version') return 'mnemon version 0.2.13';
      if (args.includes('100000')) return JSON.stringify(rows);
      throw new Error(`unexpected command: ${args.join(' ')}`);
    },
  });
  const all = await provider.listAll();
  assert.equal(all.length, 3);
  assert.equal(all[0]?.category, 'insight', 'classification travels with the row');
  const recall = calls.find(args => args.includes('recall'));
  assert.ok(recall?.includes('100000'), 'the whole store is requested, not a page');
});

test('stats reports the accounting the Provider maintains', async () => {
  const provider = new MnemonCliProvider({
    binary: process.execPath, dataDir: resolve('work/test-contract'), store: 'acceptance',
    runner: async args => {
      if (args[0] === '--version') return 'mnemon version 0.2.13';
      return JSON.stringify({
        total_insights: 13, deleted_insights: 2, edge_count: 206,
        by_category: { insight: 11, fact: 2 },
        top_entities: [{ entity: 'NSIS', count: 6 }, { entity: 'Windows', count: 4 }],
      });
    },
  });
  const stats = await provider.stats();
  assert.equal(stats.totalInsights, 13);
  assert.equal(stats.edgeCount, 206);
  assert.deepEqual(stats.byCategory, { insight: 11, fact: 2 });
  assert.deepEqual(stats.topEntities, [{ entity: 'NSIS', count: 6 }, { entity: 'Windows', count: 4 }]);
});

test('graph parses the official DOT export into typed edges', async () => {
  const dot = [
    'digraph mnemon {',
    '  rankdir=LR;',
    '  "a" [label="a: [insight] 甲", fillcolor="#9b59b6"];',
    '  "b" [label="b: [insight] 乙", fillcolor="#9b59b6"];',
    '  "a" -> "b" [label="entity", color="#2ecc71"];',
    '  "b" -> "a" [label="causal", color="#e67e22"];',
    '}',
  ].join('\n');
  const provider = new MnemonCliProvider({
    binary: process.execPath, dataDir: resolve('work/test-contract'), store: 'acceptance',
    runner: async args => {
      if (args[0] === '--version') return 'mnemon version 0.2.13';
      if (args.includes('viz')) return dot;
      throw new Error(`unexpected command: ${args.join(' ')}`);
    },
  });
  const graph = await provider.graph();
  assert.deepEqual(graph.nodes.map(node => node.id).sort(), ['a', 'b']);
  assert.equal(graph.nodes.find(node => node.id === 'a')?.label, 'a: [insight] 甲');
  // The edge type is kept: the drawing and any later filtering depend on it.
  assert.deepEqual(graph.edges, [
    { sourceId: 'a', targetId: 'b', label: 'entity' },
    { sourceId: 'b', targetId: 'a', label: 'causal' },
  ]);
  assert.equal(graph.truncated, false);
});

test('a graph within the edge cap is returned whole', async () => {
  const lines = ['digraph mnemon {'];
  for (let index = 0; index < 30; index += 1) lines.push(`  "n${index}" [label="n${index}"];`);
  for (let index = 0; index < 30; index += 1) lines.push(`  "n${index}" -> "n${(index + 1) % 30}" [label="entity"];`);
  lines.push('}');
  const provider = new MnemonCliProvider({
    binary: process.execPath, dataDir: resolve('work/test-contract'), store: 'acceptance',
    runner: async args => {
      if (args[0] === '--version') return 'mnemon version 0.2.13';
      return lines.join('\n');
    },
  });
  const graph = await provider.graph();
  assert.equal(graph.truncated, false, 'within the cap the whole picture is returned');
  assert.equal(graph.edges.length, 30);
  // 30 entities is the whole set: the nodes are not dropped when only the edges are many.
  assert.equal(graph.nodes.length, 30);
});

test('a graph past the edge cap says it is truncated', async () => {
  // The export has no cursor, so an over-large graph must announce that edges were left out
  // rather than look complete.
  const lines = ['digraph mnemon {'];
  for (let index = 0; index < 2100; index += 1) lines.push(`  "n${index}" -> "n${index + 1}" [label="entity"];`);
  lines.push('}');
  const provider = new MnemonCliProvider({
    binary: process.execPath, dataDir: resolve('work/test-contract'), store: 'acceptance',
    runner: async args => {
      if (args[0] === '--version') return 'mnemon version 0.2.13';
      return lines.join('\n');
    },
  });
  const graph = await provider.graph();
  assert.equal(graph.truncated, true, 'a cut picture is reported as cut');
  assert.ok(graph.edges.length <= 2000, 'the cap bounds what is returned');
});

test('recall accepts both official output shapes and keeps every reported field', async () => {
  // `recall` wraps rows in {results}; `search` returns a bare array. Both are official, and a
  // decoder that knows only one of them fails the other mode at runtime.
  const row = { id: 'm1', content: '正文', score: 0.5, category: 'insight', importance: 4, tags: ['t'], entities: ['E'], confidence: 'medium' };
  const wrapped = new MnemonCliProvider({
    binary: process.execPath, dataDir: resolve('work/test-contract'), store: 'acceptance',
    runner: async args => args[0] === '--version' ? 'mnemon version 0.2.13' : JSON.stringify({ results: [row] }),
  });
  const smart = await wrapped.recall({ query: 'q', limit: 5, mode: 'smart' });
  assert.equal(smart.memories[0]?.category, 'insight', 'classification survives');
  assert.equal(smart.memories[0]?.confidence, 'medium', 'the Provider relevance band survives');
  assert.deepEqual(smart.memories[0]?.tags, ['t']);
  assert.deepEqual(smart.memories[0]?.entities, ['E']);

  const bare = new MnemonCliProvider({
    binary: process.execPath, dataDir: resolve('work/test-contract'), store: 'acceptance',
    runner: async args => args[0] === '--version' ? 'mnemon version 0.2.13' : JSON.stringify([row]),
  });
  const keyword = await bare.recall({ query: 'q', limit: 5, mode: 'keyword' });
  assert.equal(keyword.memories.length, 1, 'the bare-array shape is read too');
  assert.equal(keyword.memories[0]?.id, 'm1');
});

test('a recall mode reaches the command it names, and filters are passed through', async () => {
  const calls: string[][] = [];
  const provider = new MnemonCliProvider({
    binary: process.execPath, dataDir: resolve('work/test-contract'), store: 'acceptance',
    runner: async args => {
      calls.push(args);
      if (args[0] === '--version') return 'mnemon version 0.2.13';
      return JSON.stringify({ results: [] });
    },
  });
  await provider.recall({ query: 'q', limit: 5, mode: 'keyword' });
  await provider.recall({ query: 'q', limit: 5, mode: 'basic' });
  await provider.recall({ query: 'q', limit: 5, mode: 'smart', category: 'insight', source: 'local-user' });
  const issued = calls.filter(args => !args.includes('--version'));
  assert.ok(issued[0]?.includes('search'), 'keyword mode uses the token scorer');
  assert.ok(issued[1]?.includes('--basic'), 'basic mode uses the LIKE path');
  assert.ok(!issued[2]?.includes('search') && !issued[2]?.includes('--basic'), 'smart mode is the default ranking');
  // Provider-side filtering, so the caller does not have to discard a page it already paid for.
  assert.ok(issued[2]?.includes('--cat') && issued[2]?.includes('--source'), 'filters reach the Provider');
  // The semantic ranking is asked for the wider candidate pool it truncates by score, and for the
  // verbose payload that carries the vector similarity the quality policy reads.
  assert.ok(issued[0]?.includes('--limit') && issued.slice(0, 1).length === 1);
  const smartLimit = Number(issued[2]?.[issued[2]!.indexOf('--limit') + 1]);
  assert.equal(smartLimit, 20, 'a page of 5 asks for a pool of 5 × 3, floored at 20');
  assert.ok(issued[2]?.includes('--verbose'), 'similarity is only reported by --verbose');
  assert.ok(!issued[1]?.includes('--verbose'), 'the LIKE path has no similarity to report');
});

test('a verbose semantic row is decoded and its similarity becomes the score', async () => {
  // `--verbose` wraps the row: `{insight, score, via, signals}`. A decoder that knows only the flat
  // shape fails every smart recall on a store that has embeddings.
  const provider = new MnemonCliProvider({
    binary: process.execPath, dataDir: resolve('work/test-contract'), store: 'acceptance',
    runner: async args => args[0] === '--version' ? 'mnemon version 0.2.13' : JSON.stringify({
      results: [
        { insight: { id: 'a', content: '旧正文', category: 'insight' }, score: 0.3, via: 'entity', confidence: 'low', signals: { similarity: 0.82, keyword: 0 } },
        { insight: { id: 'b', content: '更近的正文' }, score: 0.4, via: 'entity', confidence: 'low', signals: { similarity: 0.93 } },
      ],
    }),
  });
  const result = await provider.recall({ query: 'q', limit: 5 });
  assert.deepEqual(result.memories.map(memory => memory.id), ['b', 'a'], 'rows are re-ordered by similarity');
  assert.equal(result.memories[0]?.score, 0.93, 'the vector similarity is the score');
  assert.equal(result.memories[0]?.confidence, undefined, 'the fused-score label is dropped with the fused score');
});

test('with no embeddings the Provider order and fused scores stand', async () => {
  // An all-zero similarity is what a store without vectors reports. Re-scoring it would replace a
  // ranking that has meaning with one that does not, so the rows are returned exactly as ranked.
  const rows = [
    { insight: { id: 'a', content: '第一' }, score: 0.52, signals: { similarity: 0 } },
    { insight: { id: 'b', content: '第二' }, score: 0.3, signals: { similarity: 0 } },
    { insight: { id: 'c', content: '第三' }, score: 0.3, signals: {} },
  ];
  const provider = new MnemonCliProvider({
    binary: process.execPath, dataDir: resolve('work/test-contract'), store: 'acceptance',
    runner: async args => args[0] === '--version' ? 'mnemon version 0.2.13' : JSON.stringify({ results: rows }),
  });
  const result = await provider.recall({ query: 'q', limit: 5 });
  assert.deepEqual(result.memories.map(memory => memory.id), ['a', 'b', 'c'], 'the Provider order survives');
  assert.deepEqual(result.memories.map(memory => memory.score), [0.52, 0.3, 0.3], 'the fused scores survive');
});
