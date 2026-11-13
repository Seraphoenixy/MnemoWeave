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
 * A reviewed replacement must become a visible relation.
 *
 * Catalogued relations are only created by the review path — an edit and a sync write link the
 * Provider without writing one — so this is the only way the graph and the detail view can ever
 * show an edge. Driving the whole path here (candidate → approval → worker publish) proves the
 * edge is real rather than hand-inserted into a fixture.
 */

const TOKEN = 'review-token-0123456789abcdef';
const OPERATOR = 'review-operator-0123456789a';
const HOST = 'review-probe';

type App = ReturnType<typeof configure>;

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(done => setTimeout(done, 250));
  }
}

test('an approved supersede publishes a new memory and draws an edge', async () => {
  const root = await tempDir('review-publish-graph', 'review-graph');
  mkdirSync(join(root, 'provider'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });

  // Seed one published memory directly, so the candidate below has something to replace.
  const seed = new SqliteCandidates(resolve(join(root, 'state', 'governance.db')));
  const seedProvider = new MnemonCliProvider({ binary: mnemonBinary(), dataDir: resolve(join(root, 'provider')), store: 'review' });
  const base = RememberInput.parse({
    idempotencyKey: `review-${randomUUID()}`, content: '被替代的旧正文。', tags: [],
    provenance: {
      source: 'local-user', sourceReference: 'review:old',
    },
  });
  const candidate = seed.submit(base);
  const written = await seedProvider.persistReviewed(base.content, `candidate:${randomUUID()}`);
  const published = seed.catalog.publishInitial(candidate.id, base, written.id, createHash('sha256').update(base.content).digest('hex'), '2026-11-10T00:00:00.000Z');
  seed.close();

  const app: App = configure({
    MNEMON_BINARY: mnemonBinary(), MNEMON_DATA_DIR: join(root, 'provider'), MNEMON_STORE: 'review',
    MNEMOWEAVE_STATE_DIR: join(root, 'state'), MNEMOWEAVE_PORT: '0',
    MNEMOWEAVE_TOKEN: TOKEN, MNEMOWEAVE_OPERATOR_TOKEN: OPERATOR,
    // The worker is what turns an approved candidate into a publication.
    MNEMOWEAVE_WORKER: 'on',
  } as NodeJS.ProcessEnv);
  const server: Server = createHttpServer(app.app, TOKEN, OPERATOR, app.client, app.storage);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const service = { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': HOST, 'content-type': 'application/json' };
  const operator = { authorization: `Bearer ${OPERATOR}`, 'x-mnemoweave-host': HOST, 'content-type': 'application/json' };

  try {
    const detail = await (await fetch(`${origin}/v1/memories/${published.memoryId}`, { headers: service })).json() as { currentRevisionId: string };

    // Declare the replacement: a reviewed candidate that supersedes the seeded memory.
    const submitted = await fetch(`${origin}/v1/remember`, {
      method: 'POST',
      headers: service,
      body: JSON.stringify({
        idempotencyKey: `review-supersede-${randomUUID()}`,
        content: '替代旧正文的新正文。',
        tags: [],
        change: {
          kind: 'supersede',
          targetMemoryId: published.memoryId,
          expectedRevisionId: detail.currentRevisionId,
          // A change cannot take effect in the future; the catalog refuses it. Use the recent past.
          effectiveAt: new Date(Date.now() - 60_000).toISOString(),
          reason: '验收：审核替换',
          evidence: ['验收固定值'],
        },
        provenance: {
          source: 'local-user', sourceReference: 'review:new',
        },
      }),
    });
    assert.equal(submitted.status, 202, 'a candidate is accepted asynchronously');
    // /v1/remember answers with the whole Candidate; its id is the review handle.
    const { id: candidateId } = await submitted.json() as { id: string };

    // A candidate is not reviewable the moment it is accepted: the deterministic assessment has to
    // move it to `needs_review` first, and that runs in the background.
    await waitFor('the candidate to become reviewable', async () => {
      const response = await fetch(`${origin}/v1/candidates/${candidateId}`, { headers: operator });
      if (!response.ok) return undefined;
      const body = await response.json() as { status: string };
      return body.status === 'needs_review' ? true : undefined;
    });

    const fresh = await (await fetch(`${origin}/v1/candidates/${candidateId}`, { headers: operator })).json() as { id: string; status: string };
    const approved = await fetch(`${origin}/v1/review`, {
      method: 'POST', headers: operator,
      body: JSON.stringify({ candidateId, decision: 'approve', reason: '验收批准' }),
    });
    assert.equal(approved.status, 200, `candidate ${fresh.id} status=${fresh.status} -> ${approved.url} -> ${await approved.clone().text()}`);

    // The worker publishes in the background; wait for the graph to show the replacement.
    let lastStatus = '';
    const graph = await waitFor('the published relation', async () => {
      const candidateNow = await (await fetch(`${origin}/v1/candidates/${candidateId}`, { headers: operator })).json() as { status: string };
      lastStatus = candidateNow.status;
      const response = await fetch(`${origin}/v1/memories/graph?limit=50`, { headers: service });
      const body = await response.json() as { nodes: Array<{ memoryId: string }>; edges: Array<{ kind: string; sourceMemoryId: string; targetMemoryId: string }> };
      if (body.edges.length > 0) return body;
      if (lastStatus === 'failed') throw new Error('the worker failed to publish the approved change');
      return undefined;
    }).catch(error => { throw new Error(`${String(error)} (candidate status: ${lastStatus})`); });

    assert.equal(graph.nodes.length, 2, 'the replacement is a new memory, not a new revision of the old one');
    const edge = graph.edges[0]!;
    assert.equal(edge.kind, 'Supersedes');
    assert.notEqual(edge.sourceMemoryId, edge.targetMemoryId, 'a replacement links two different memories');
    assert.ok(graph.nodes.some(node => node.memoryId === edge.targetMemoryId), 'the replaced memory is still a node');

    // And the old memory is retired, which is what "supersede" means for recall.
    const retired = await (await fetch(`${origin}/v1/memories/${published.memoryId}`, { headers: service })).json() as { state: string };
    assert.equal(retired.state, 'superseded');
  } finally {
    await new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); });
    await app.close();
  }
});
