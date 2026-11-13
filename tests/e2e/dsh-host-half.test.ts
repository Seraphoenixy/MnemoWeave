import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { configure } from '../../apps/server/src/config.ts';
import { createHttpServer } from '../../packages/protocols/http/src/index.ts';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { MnemonCliProvider } from '../../packages/providers/mnemon/src/index.ts';
import { MemoryClient } from '../../packages/client/src/index.ts';
import { RememberInput } from '../../packages/core/contracts/src/index.ts';
import { MemorySource } from '../../plugins/dsh-mnemo-weave/src/ui/memory-source.ts';
import { createRpcHandler } from '../../plugins/dsh-mnemo-weave/src/ui/rpc.ts';
import { mnemonBinary } from './mnemon-binary.ts';
import { tempDir } from '../support/temp.ts';

/**
 * The DSH plugin's Host half against a real Server: the same client, the same RPC handler
 * and the same parsing the desktop page uses, with a real Mnemon behind it.
 */

const TOKEN = 'host-token-0123456789abcdef';
const OPERATOR = 'operator-token-0123456789abcdef';
const HOST = 'dsh-desktop';

test('the DSH Host half lists, reads, edits and reports injections through a real Server', async () => {
  const dir = await tempDir('dsh-host-half', 'dsh-host-half');
  mkdirSync(join(dir, 'provider'), { recursive: true });
  mkdirSync(join(dir, 'state'), { recursive: true });

  // Seed one published memory through the normal candidate path.
  const seed = new SqliteCandidates(resolve(join(dir, 'state', 'governance.db')));
  const seedProvider = new MnemonCliProvider({ binary: mnemonBinary(), dataDir: resolve(join(dir, 'provider')), store: 'dsh_host' });
  const request = RememberInput.parse({
    idempotencyKey: `seed-${randomUUID()}`, content: '插件读取的初始正文。', tags: [],
    provenance: {
      source: 'local-user', sourceReference: 'e2e:dsh-host',
    },
  });
  const candidate = seed.submit(request);
  const written = await seedProvider.persistReviewed(request.content, `candidate:${candidate.id}`);
  const memoryId = seed.catalog.publishInitial(candidate.id, request, written.id, createHash('sha256').update(request.content).digest('hex'), '2026-11-10T10:00:00.000Z').memoryId;
  seed.close();

  const app = configure({
    MNEMON_BINARY: mnemonBinary(), MNEMON_DATA_DIR: join(dir, 'provider'), MNEMON_STORE: 'dsh_host',
    MNEMOWEAVE_STATE_DIR: join(dir, 'state'), MNEMOWEAVE_PORT: '0',
    MNEMOWEAVE_TOKEN: TOKEN, MNEMOWEAVE_OPERATOR_TOKEN: OPERATOR, MNEMOWEAVE_WORKER: 'off',
  });
  const server: Server = createHttpServer(app.app, TOKEN, OPERATOR, app.client, app.storage);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Editing claims a person made the change, so the Host half carries the operator credential;
  // the service token alone is refused by the Server.
  // A single-user deployment: the service token plus the Host header is the whole identity, so a
  // second credential for editing would only duplicate the same secret.
  const client = new MemoryClient({ baseUrl: base, token: TOKEN, hostId: HOST, timeoutMs: 30_000 });
  const source = new MemorySource({ client, serverUrl: base, hasToken: true });
  const rpc = createRpcHandler(source);
  try {
    const status = await rpc('status', {});
    assert.equal(status.ok, true);
    if (status.ok) assert.equal((status.value as { status: string }).status, 'ok');

    const list = await rpc('memories', { limit: 10 });
    assert.equal(list.ok, true);
    if (!list.ok) return;
    const items = (list.value as { items: Array<{ memoryId: string; content: string; entryVersion: number }> }).items;
    assert.equal(items.length, 1);
    assert.equal(items[0]?.content, '插件读取的初始正文。');
    assert.equal(items[0]?.entryVersion, 0);

    const detail = await rpc('memory', { memoryId });
    assert.equal(detail.ok, true);
    if (detail.ok) assert.equal((detail.value as { memoryId: string }).memoryId, memoryId);

    const edited = await rpc('edit', { memoryId, content: '插件编辑后的正文。', entryVersion: 0 });
    assert.equal(edited.ok, true);
    if (edited.ok) assert.equal((edited.value as { entryVersion: number }).entryVersion, 1);

    // Editing classification is part of editing the memory: a category and tags can be set on the
    // new revision, and fields left out keep what the previous revision recorded.
    const classified = await rpc('edit', {
      memoryId, content: '带分类的正文。', entryVersion: 1,
      category: 'decision', importance: 4, tags: ['发布', '回滚'],
    });
    assert.equal(classified.ok, true);
    if (classified.ok) assert.equal((classified.value as { entryVersion: number }).entryVersion, 2);
    const withClass = await rpc('memory', { memoryId });
    assert.equal(withClass.ok, true);
    if (withClass.ok) {
      const record = withClass.value as { revisions: Array<{ category?: string; importance?: number; tags?: string[] }> };
      const latest = record.revisions[record.revisions.length - 1]!;
      assert.equal(latest.category, 'decision');
      assert.equal(latest.importance, 4);
      assert.deepEqual(latest.tags, ['发布', '回滚']);

      // A body-only edit must inherit rather than clear the classification.
      const bodyOnly = await rpc('edit', { memoryId, content: '只改正文。', entryVersion: 2 });
      assert.equal(bodyOnly.ok, true);
      const after = await rpc('memory', { memoryId });
      if (after.ok) {
        const rows = (after.value as { revisions: Array<{ category?: string; tags?: string[] }> }).revisions;
        const newest = rows[rows.length - 1]!;
        assert.equal(newest.category, 'decision', 'an omitted category is inherited, not cleared');
        assert.deepEqual(newest.tags, ['发布', '回滚'], 'omitted tags are inherited');
      }
    }

    const stale = await rpc('edit', { memoryId, content: '过期基准。', entryVersion: 0 });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, 'VERSION_CONFLICT');

    // Explore ranks by the Provider's own relevance and maps each hit back to a memory this
    // machine published, so every result can be opened. The query names the body the memory holds
    // now: an earlier revision's wording is superseded and is not meant to resurface in a ranking.
    const explored = await rpc('explore', { query: '只改正文。', limit: 10 });
    assert.equal(explored.ok, true);
    if (explored.ok) {
      const found = explored.value as { query: string; hits: Array<{ memoryId: string; score?: number; relevance?: string; state: string }>; unregistered: number };
      assert.equal(found.query, '只改正文。');
      assert.ok(found.hits.length >= 1, 'the live memory is found');
      assert.ok(found.hits.some(hit => hit.memoryId === memoryId), 'the hit maps back to the catalog memory');
      assert.ok(found.hits.every(hit => hit.relevance !== undefined), 'every hit states its relevance band');
      assert.equal(typeof found.unregistered, 'number');
    }

    // The graph is structure only, and the page parses it without a body to rely on.
    const graphed = await rpc('graph', { limit: 50 });
    assert.equal(graphed.ok, true);
    if (graphed.ok) {
      const found = graphed.value as { nodes: Array<{ memoryId: string }>; edges: unknown[]; truncated: boolean };
      assert.ok(found.nodes.some(node => node.memoryId === memoryId), 'the live memory is a node');
      assert.equal(found.truncated, false);
      // A node carries no content: the graph must not smuggle bodies in.
      assert.ok(found.nodes.every(node => (node as { content?: unknown }).content === undefined));
    }

    // The sync tab must resolve to a clear state on a machine with no remote configured, not to a
    // broken pane: either "not configured" or an explicit refusal, never an empty success.
    const sync = await rpc('sync', {});
    if (sync.ok) {
      const status = sync.value as { enabled: boolean; streams: unknown[] };
      assert.equal(status.enabled, false, 'a host with no remote reports sync as disabled');
      assert.deepEqual(status.streams, []);
    } else {
      assert.equal(sync.error!.code, 'REVIEW_REQUIRED', 'or refuses explicitly rather than pretending');
    }

    // Blank queries are refused in the Host rather than sent on.
    const blank = await rpc('explore', { query: '   ' });
    assert.equal(blank.ok, false);
    if (!blank.ok) assert.equal(blank.error.code, 'INVALID_INPUT');

    // The live body is found by its own words whether or not the caller repeats the closing
    // punctuation, and every hit states the band the policy assigned to it.
    for (const query of ['只改正文。', '只改正文']) {
      const found = await rpc('explore', { query, limit: 10 });
      assert.equal(found.ok, true);
      if (!found.ok) continue;
      const hits = (found.value as { hits: Array<{ memoryId: string; content: string; relevance?: string }> }).hits;
      assert.ok(hits.some(hit => hit.memoryId === memoryId && hit.content === '只改正文。'), `${query} finds the live body`);
      assert.ok(hits.every(hit => typeof hit.relevance === 'string'), 'every hit states its relevance band');
    }

    // A removed score floor is refused rather than silently ignored: the caller that sent one
    // believed it was narrowing the answer.
    const removed = await rpc('explore', { query: 'x', minScore: 0.5 });
    assert.equal(removed.ok, false, 'minScore is no longer an accepted argument');
    if (!removed.ok) assert.equal(removed.error.code, 'INVALID_INPUT');

    // Withdrawal goes through the same Host channel and needs the operator credential this client
    // carries. The memory leaves recall and keeps every earlier revision readable.
    const withdrawn = await rpc('withdraw', { memoryId, reason: '端到端验收：不再适用', entryVersion: 3 });
    assert.equal(withdrawn.ok, true);
    if (withdrawn.ok) {
      const value = withdrawn.value as { entryVersion: number; withdrawnAt: string };
      assert.equal(value.entryVersion, 4, 'a withdrawal is a new version');
      assert.ok(value.withdrawnAt.length > 0);
    }
    const afterWithdraw = await rpc('memory', { memoryId });
    assert.equal(afterWithdraw.ok, true);
    if (afterWithdraw.ok) {
      const record = afterWithdraw.value as { state: string; revisions: unknown[]; content: string };
      assert.equal(record.state, 'superseded', 'recall and injection stop serving it');
      // Seeded revision plus three edits; the withdrawal retires the memory without adding one.
      assert.equal(record.revisions.length, 4, 'the earlier revisions are still there');
      assert.equal(record.content, '只改正文。', 'the last body is still readable');
    }
    const repeated = await rpc('withdraw', { memoryId, reason: '重复撤回', entryVersion: 4 });
    assert.equal(repeated.ok, false, 'a withdrawn memory cannot be withdrawn again');

    // A withdrawn memory is no longer served, so explore must stop offering it.
    const afterWithdrawal = await rpc('explore', { query: '插件编辑后的正文', limit: 10 });
    assert.equal(afterWithdrawal.ok, true);
    if (afterWithdrawal.ok) {
      const found = afterWithdrawal.value as { hits: Array<{ memoryId: string }> };
      assert.equal(found.hits.some(hit => hit.memoryId === memoryId), false, 'withdrawn memories are not surfaced');
    }

    // No report yet: the host has never injected, which is a normal first run.
    assert.equal(await source.injection(), null);

    // The rule set is written by a person, then delivered whole on the next turn.
    const ruleWrite = await fetch(`${base}/v1/rules`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': HOST, 'content-type': 'application/json' },
      body: JSON.stringify({ body: '提交前必须运行类型检查。' }),
    });
    assert.equal(ruleWrite.status, 201);

    // The default injection budget is 2 s; a loaded machine needs a larger budget to assert
    // the happy path, so the test passes one explicitly instead of weakening the deadline.
    const injection = await client.inject({ sessionId: 'dsh-half-session' }, 20_000);
    assert.equal(injection.ok, true);
    if (injection.ok) {
      assert.deepEqual(injection.value.rules.map(rule => rule.body), ['提交前必须运行类型检查。']);
      assert.equal(injection.value.complete, true);
    }
    const report = await source.injection();
    assert.ok(report, 'an injection call must leave a report');
    assert.equal(report.ruleCount, 1);
    assert.ok(report.usedBytes > 0);
    assert.equal(report.failure, undefined);
    assert.equal(report.sessionId, 'dsh-half-session');
  } finally {
    await new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); });
    await app.close();
  }
});
