import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpServer } from '../../packages/protocols/http/src/index.ts';
import type { ClientHttpEndpoints } from '../../packages/protocols/http/src/index.ts';
import type { MemoryApplication } from '../../packages/core/application/src/index.ts';

/**
 * Query parameters must reach the layer that acts on them.
 *
 * The same class of mistake as a dropped field in the Host half: the route parses `sort` and then
 * never passes it on, so the request succeeds and the caller silently gets the default order.
 * These tests send a distinctive value for each documented parameter and check the handler saw it.
 */

const TOKEN = 't'.repeat(32);
const OPERATOR = 'o'.repeat(32);
const MEMORY = '11111111-1111-4111-8111-111111111111';

async function harness(client: Partial<ClientHttpEndpoints>): Promise<{ base: string; close: () => Promise<void> }> {
  const app = {
    readMemory: async () => ({ id: MEMORY }),
    health: async () => ({ ready: true as const, version: '0' }),
  } as unknown as MemoryApplication;
  const server: Server = createHttpServer(app, TOKEN, OPERATOR, client as ClientHttpEndpoints);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}

const auth = { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': 'probe', connection: 'close' };

test('the list route forwards every query parameter it documents', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const { base, close } = await harness({
    memories: async (query) => { seen.push(query as unknown as Record<string, unknown>); return { items: [] } as never; },
  });
  try {
    const response = await fetch(
      `${base}/v1/memories?limit=7&category=decision&knowledgeType=Practice&entity=MnemoWeave&sort=importance&cursor=abc&query=${encodeURIComponent('关键词')}`,
      { headers: auth },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(seen[0], {
      limit: 7,
      category: 'decision', knowledgeType: 'Practice', entity: 'MnemoWeave',
      sort: 'importance', cursor: 'abc', query: '关键词',
    }, 'no documented parameter is parsed and then dropped');
  } finally { await close(); }
});

test('the list route leaves absent parameters absent instead of inventing defaults', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const { base, close } = await harness({
    memories: async (query) => { seen.push(query as unknown as Record<string, unknown>); return { items: [] } as never; },
  });
  try {
    assert.equal((await fetch(`${base}/v1/memories`, { headers: auth })).status, 200);
    // Only the page size has a documented default; everything else stays absent.
    assert.deepEqual(seen[0], { limit: 50 }, 'only documented defaults are supplied');
  } finally { await close(); }
});

test('the graph route forwards its cap', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const { base, close } = await harness({
    graph: async (_hostId, query) => { seen.push(query as unknown as Record<string, unknown>); return { nodes: [], edges: [], truncated: false } as never; },
  });
  try {
    assert.equal((await fetch(`${base}/v1/memories/graph?limit=42`, { headers: auth })).status, 200);
    assert.deepEqual(seen[0], { limit: 42 });
  } finally { await close(); }
});

test('the explore route forwards the query, the cap and the score floor', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const { base, close } = await harness({
    explore: async (_hostId, input) => { seen.push(input as unknown as Record<string, unknown>); return { query: 'x', hits: [], unregistered: 0, truncated: false } as never; },
  });
  try {
    const response = await fetch(`${base}/v1/memories/explore`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ query: '语义', limit: 12, minScore: 0.35 }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(seen[0], { query: '语义', limit: 12, minScore: 0.35 });
  } finally { await close(); }
});

test('an invalid value of a documented parameter is refused rather than ignored', async () => {
  const { base, close } = await harness({ memories: async () => ({ items: [] }) as never });
  try {
    for (const query of ['category=nonsense', 'knowledgeType=Nope', 'sort=sideways', 'limit=0']) {
      const response = await fetch(`${base}/v1/memories?${query}`, { headers: auth });
      assert.equal(response.status, 400, `${query} must be refused`);
    }
  } finally { await close(); }
});
