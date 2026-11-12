import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpServer } from '../../packages/protocols/http/src/index.ts';

/**
 * Every model-facing read must say who is asking and which turn it belongs to.
 *
 * `/v1/recall` used to reach the application directly: the service token alone was enough, so any
 * caller could spend the model budget and no turn was identified. A read now carries the Host and
 * the turn identity the Host read from its own tool-execution context.
 */

const TOKEN = 't'.repeat(32);
const OPERATOR = 'o'.repeat(32);
/** The turn identity a Host supplies; model parameters never carry these. */
const TURN = { 'x-mnemoweave-session-id': 's-1', 'x-mnemoweave-turn-id': 'turn-1' };

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

test('recall carries the calling Host and turn through to the scoped path', async () => {
  const { recalls, base, close } = await harness();
  try {
    const response = await fetch(`${base}/v1/recall`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': 'dsh', ...TURN, 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ query: 'anything', limit: 5 }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(recalls, ['dsh'], 'the grant is built for the identity that asked');
  } finally { await close(); }
});

test('a partial turn identity is refused instead of being treated as an administrative read', async () => {
  const { recalls, base, close } = await harness();
  try {
    // A call that names half a turn claims a per-turn budget it cannot identify; it must not be
    // downgraded to the administrative recall.
    for (const headers of [
      { 'x-mnemoweave-turn-id': 'turn-1' },
      { 'x-mnemoweave-session-id': 's-1' },
    ]) {
      const response = await fetch(`${base}/v1/recall`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': 'dsh', ...headers, 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ query: 'anything', limit: 5 }),
      });
      assert.equal(response.status, 401, JSON.stringify(headers));
    }
    assert.equal(recalls.length, 0, 'an unattributable read never reaches the Provider');
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
      headers: { authorization: `Bearer ${TOKEN}`, ...TURN, 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ query: 'q' }),
    });
    assert.equal(withoutHost.status, 401);

    // A management search has no turn: it is bounded by the administrative limit instead.
    const management = await fetch(`${base.origin}/v1/memories/explore`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': 'dsh', 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ query: 'q' }),
    });
    assert.equal(management.status, 200);
    // Half an identity is not a management read either: it claims a turn it cannot name.
    const halfTurn = await fetch(`${base.origin}/v1/memories/explore`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': 'dsh', 'x-mnemoweave-session-id': 's-1', 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ query: 'q' }),
    });
    assert.equal(halfTurn.status, 401);

    const beforeBlank = base.explored.length;
    const blank = await fetch(`${base.origin}/v1/memories/explore`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': 'dsh', ...TURN, 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ query: '  ' }),
    });
    assert.equal(blank.status, 400);
    assert.equal(base.explored.length, beforeBlank, 'an empty query never reaches the Provider');

    const accepted = await fetch(`${base.origin}/v1/memories/explore`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': 'dsh', ...TURN, 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ query: 'q' }),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(base.explored, [{ hostId: 'dsh' }, { hostId: 'dsh' }]);
  } finally { await base.close(); }
});
