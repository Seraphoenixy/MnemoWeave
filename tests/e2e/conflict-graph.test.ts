import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { RememberInput } from '../../packages/core/contracts/src/index.ts';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { MnemonCliProvider } from '../../packages/providers/mnemon/src/index.ts';
import { createHttpServer } from '../../packages/protocols/http/src/index.ts';
import { configure } from '../../apps/server/src/config.ts';
import { mnemonBinary } from '../e2e/mnemon-binary.ts';
import { tempDir } from '../support/temp.ts';

/**
 * A conflict resolved as "coexist" leaves two live memories that disagree, and the graph draws it.
 *
 * A conflict case is recorded between a *candidate* and a target memory, so it only becomes a
 * relation between two memories once that candidate is published — which is exactly what a coexist
 * resolution does. Until then there is no second endpoint to draw, so it is deliberately absent.
 */

const TOKEN = 'conflict-graph-token-0123456789';
const OPERATOR = 'conflict-graph-operator-0123';
const HOST = 'conflict-graph-probe';

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 40_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(done => setTimeout(done, 250));
  }
}

function request(key: string, content: string) {
  return RememberInput.parse({
    idempotencyKey: key, content, tags: [],
    provenance: {
      source: 'local-user', sourceReference: `conflict:${key}`,
    },
  });
}

test('a coexist resolution draws a conflict edge between two live memories', { timeout: 120_000 }, async () => {
  const root = await tempDir('conflict-graph', 'conflict-graph');
  mkdirSync(join(root, 'provider'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });

  const seed = new SqliteCandidates(resolve(join(root, 'state', 'governance.db')));
  const seedProvider = new MnemonCliProvider({ binary: mnemonBinary(), dataDir: resolve(join(root, 'provider')), store: 'conflictgraph' });
  const base = request(`base-${randomUUID()}`, '并行总线在 x86 上使用 32 位地址。');
  const seededCandidate = seed.submit(base);
  const seededWrite = await seedProvider.persistReviewed(base.content, `candidate:${randomUUID()}`);
  const seeded = seed.catalog.publishInitial(seededCandidate.id, base, seededWrite.id, createHash('sha256').update(base.content).digest('hex'), '2026-11-10T00:00:00.000Z');
  seed.close();

  const app = configure({
    MNEMON_BINARY: mnemonBinary(), MNEMON_DATA_DIR: join(root, 'provider'), MNEMON_STORE: 'conflictgraph',
    MNEMOWEAVE_STATE_DIR: join(root, 'state'), MNEMOWEAVE_PORT: '0',
    MNEMOWEAVE_TOKEN: TOKEN, MNEMOWEAVE_OPERATOR_TOKEN: OPERATOR, MNEMOWEAVE_WORKER: 'on',
  } as NodeJS.ProcessEnv);
  const server: Server = createHttpServer(app.app, TOKEN, OPERATOR, app.client, app.storage);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const service = { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': HOST, 'content-type': 'application/json' };
  const operator = { authorization: `Bearer ${OPERATOR}`, 'x-mnemoweave-host': HOST, 'content-type': 'application/json' };
  const json = async <T>(response: Response): Promise<T> => await response.json() as T;

  try {
    const detail = await json<{ currentRevisionId: string }>(await fetch(`${origin}/v1/memories/${seeded.memoryId}`, { headers: service }));

    // A second memory that contradicts the first under the same conditions.
    const submitted = await fetch(`${origin}/v1/remember`, {
      method: 'POST', headers: service,
      body: JSON.stringify({
        ...request(`conflict-${randomUUID()}`, '并行总线在 x86 上使用 64 位地址。'),
        change: {
          kind: 'conflict', targetMemoryId: seeded.memoryId, expectedRevisionId: detail.currentRevisionId,
          effectiveAt: new Date(Date.now() - 60_000).toISOString(),
          reason: '相同条件下结论相反', evidence: ['同一平台的两份测量'],
        },
      }),
    });
    assert.equal(submitted.status, 202);
    const candidate = await json<{ id: string; conflictCaseId?: string }>(submitted);
    // The case id is assigned at submission, but the candidate only becomes reviewable once the
    // assessment has run; resolving before that is refused as INVALID_STATE.
    const reviewable = await waitFor('the conflict case to be reviewable', async () => {
      const state = await json<{ status: string; conflictCaseId?: string }>(
        await fetch(`${origin}/v1/candidates/${candidate.id}`, { headers: operator }));
      return state.status === 'needs_review' && state.conflictCaseId !== undefined ? state : undefined;
    });
    const caseId = reviewable.conflictCaseId!;

    // Approving directly must be refused: a conflict is not an independent fact.
    const bypass = await fetch(`${origin}/v1/review`, {
      method: 'POST', headers: operator,
      body: JSON.stringify({ candidateId: candidate.id, decision: 'approve', reason: '试图绕过冲突' }),
    });
    assert.equal(bypass.status, 409, 'an unresolved conflict cannot be approved as an independent fact');

    // Resolve as coexist with a scope-qualified replacement, then approve the follow-up.
    const qualified = request(`coexist-${randomUUID()}`, '并行总线在 PowerPC 上使用 64 位地址。');
    
    const resolved = await fetch(`${origin}/v1/conflicts/resolve`, {
      method: 'POST', headers: operator,
      body: JSON.stringify({
        caseId, decision: 'coexist', reason: '两个结论在各自平台上都成立',
        evidence: ['按平台分别测量'],
        replacement: {
          ...qualified,
          change: {
            kind: 'coexist', targetMemoryId: seeded.memoryId, expectedRevisionId: detail.currentRevisionId,
            effectiveAt: new Date(Date.now() - 30_000).toISOString(),
            reason: '两个结论在各自平台上都成立', evidence: ['按平台分别测量'],
          },
        },
      }),
    });
    assert.equal(resolved.status, 200);
    const followUp = await json<{ id: string }>(resolved);
    await waitFor('the follow-up candidate', async () => {
      const state = await json<{ status: string }>(await fetch(`${origin}/v1/candidates/${followUp.id}`, { headers: operator }));
      return state.status === 'needs_review' ? true : undefined;
    });
    const approved = await fetch(`${origin}/v1/review`, {
      method: 'POST', headers: operator,
      body: JSON.stringify({ candidateId: followUp.id, decision: 'approve', reason: '两个范围已明确' }),
    });
    assert.equal(approved.status, 200, await approved.clone().text());
    const persisted = await waitFor('the follow-up publication', async () => {
      const state = await json<{ status: string; publication?: { memoryId: string } }>(await fetch(`${origin}/v1/candidates/${followUp.id}`, { headers: operator }));
      return state.status === 'persisted' ? state : undefined;
    });

    // Both memories are live, and the graph connects them.
    const graph = await waitFor('the conflict edge', async () => {
      const body = await json<{ edges: Array<{ kind: string; sourceMemoryId: string; targetMemoryId: string }>; nodes: Array<{ memoryId: string; state: string }> }>(
        await fetch(`${origin}/v1/memories/graph?limit=50`, { headers: service }));
      return body.edges.some(edge => edge.kind === 'Conflicts') ? body : undefined;
    });
    const conflict = graph.edges.find(edge => edge.kind === 'Conflicts')!;
    const pair = new Set([conflict.sourceMemoryId, conflict.targetMemoryId]);
    assert.ok(pair.has(seeded.memoryId), 'one side is the original memory');
    assert.ok(pair.has(persisted.publication!.memoryId), 'the other side is the coexisting memory');
    // A conflict edge links two live memories, unlike a supersede edge.
    for (const memoryId of pair) {
      assert.equal(graph.nodes.find(node => node.memoryId === memoryId)?.state, 'active', `${memoryId} is still active`);
    }
  } finally {
    await new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); });
    await app.close();
  }
});
