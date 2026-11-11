import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpServer } from '../../packages/protocols/http/src/index.ts';

/**
 * Every provider read must say who is asking.
 *
 * `/v1/recall` used to reach the application directly: the service token alone was enough, and no
 * grant was built, so the visibility rule the View enforces was bypassed. Recall now goes through
 * the same host-scoped client as injection.
 */

const TOKEN = 't'.repeat(32);
const OPERATOR = 'o'.repeat(32);

async function harness(): Promise<{ recalls: string[]; base: string; close: () => Promise<void> }> {
  const recalls: string[] = [];
  const app = {
    readMemory: async () => ({ id: 'x' }),
    health: async () => ({ ready: true as const, version: '0' }),
    recall: async () => ({ memories: [] }),
  } as unknown as Parameters<typeof createHttpServer>[0];
  const client = {
    recall: async (hostId: string) => { recalls.push(hostId); return { memories: [] }; },
  } as unknown as Parameters<typeof createHttpServer>[3];
  const server: Server = createHttpServer(app, TOKEN, OPERATOR, client);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { recalls, base, close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }) };
}

test('recall without a Host header is refused and never reaches the Provider', async () => {
  const { recalls, base, close } = await harness();
  try {
    const response = await fetch(`${base}/v1/recall`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ query: 'anything', limit: 5 }),
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { code: string }).code, 'UNAUTHORIZED');
    assert.equal(recalls.length, 0, 'an unattributed read must not touch the Provider');
  } finally { await close(); }
});

test('recall carries the calling Host through to the scoped path', async () => {
  const { recalls, base, close } = await harness();
  try {
    const response = await fetch(`${base}/v1/recall`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': 'dsh', 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ query: 'anything', limit: 5 }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(recalls, ['dsh'], 'the grant is built for the identity that asked');
  } finally { await close(); }
});

test('every provider or sync read requires a Host identity', async () => {
  const calls: string[] = [];
  const app = { readMemory: async () => ({ id: 'x' }), health: async () => ({ ready: true as const, version: '0' }) } as unknown as Parameters<typeof createHttpServer>[0];
  const client = {
    syncStatus: async () => { calls.push('status'); return { enabled: false, scopes: [], updatedAt: '2026-11-11T00:00:00.000Z' }; },
    syncRefresh: async () => { calls.push('refresh'); return { scopes: [], pulled: 0, applied: 0, errors: [], skipped: true }; },
  } as unknown as Parameters<typeof createHttpServer>[3];
  const server: Server = createHttpServer(app, TOKEN, OPERATOR, client);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const request of [
      { method: 'GET' as const, path: '/v1/sync/status' },
      { method: 'POST' as const, path: '/v1/sync/refresh' },
    ]) {
      const anonymous = await fetch(`${base}${request.path}`, {
        method: request.method,
        headers: { authorization: `Bearer ${TOKEN}`, connection: 'close' },
      });
      assert.equal(anonymous.status, 401, `${request.path} must not answer an unidentified caller`);
      assert.equal((await anonymous.json() as { code: string }).code, 'UNAUTHORIZED');
    }
    assert.deepEqual(calls, [], 'an unidentified caller never reaches the sync state');

    // The payload carries counters and timestamps, never credentials, so a named host may read it.
    const identified = await fetch(`${base}/v1/sync/status`, {
      headers: { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': 'dsh', connection: 'close' },
    });
    assert.equal(identified.status, 200);
    assert.deepEqual(calls, ['status']);
    const body = await identified.json() as Record<string, unknown>;
    for (const forbidden of ['token', 'deviceId', 'url', 'secret']) {
      assert.equal(forbidden in body, false, `the sync view must not expose ${forbidden}`);
    }
  } finally {
    await new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); });
  }
});

test('explore is a host-scoped read too, and validates its query', async () => {
  const base = await (async () => {
    const explored: Array<{ hostId: string }> = [];
    const app = { readMemory: async () => ({ id: 'x' }), health: async () => ({ ready: true as const, version: '0' }) } as unknown as Parameters<typeof createHttpServer>[0];
    const client = { explore: async (hostId: string) => { explored.push({ hostId }); return { query: 'q', hits: [], unregistered: 0 }; } } as unknown as Parameters<typeof createHttpServer>[3];
    const server: Server = createHttpServer(app, TOKEN, OPERATOR, client);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { origin, explored, close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }) };
  })();
  try {
    const withoutHost = await fetch(`${base.origin}/v1/memories/explore`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ query: 'q' }),
    });
    assert.equal(withoutHost.status, 401);

    const blank = await fetch(`${base.origin}/v1/memories/explore`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': 'dsh', 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ query: '  ' }),
    });
    assert.equal(blank.status, 400);
    assert.equal(base.explored.length, 0, 'an empty query never reaches the Provider');

    const accepted = await fetch(`${base.origin}/v1/memories/explore`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': 'dsh', 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ query: 'q' }),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(base.explored, [{ hostId: 'dsh' }]);
  } finally { await base.close(); }
});
