import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createHttpServer } from '../../packages/protocols/http/src/index.ts';
import type { ClientHttpEndpoints } from '../../packages/protocols/http/src/index.ts';
import type { MemoryApplication } from '../../packages/core/application/src/index.ts';
import { MemoryClient } from '../../packages/client/src/index.ts';

/** A host may declare its project with a header; the Server must apply it exactly once. */

const TOKEN = 't'.repeat(32);
const OPERATOR = 'o'.repeat(32);
const HOST = 'host-probe';

async function harness() {
  const seen: Record<string, unknown>[] = [];
  const client = {
    view: async (_hostId: string, input: unknown) => { seen.push(input as Record<string, unknown>); return { viewId: 'probe' } as never; },
  } as unknown as ClientHttpEndpoints;
  const server = createHttpServer({} as unknown as MemoryApplication, TOKEN, OPERATOR, client, () => ({ usedBytes: 0, state: 'ok' }));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { seen, base, close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }) };
}

function headers(extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': HOST, 'content-type': 'application/json', connection: 'close', ...extra };
}

test('the project header supplies the project when the body omits it', async () => {
  const { seen, base, close } = await harness();
  try {
    const response = await fetch(`${base}/v1/view`, { method: 'POST', headers: headers({ 'x-mnemoweave-project': 'alpha' }), body: '{}' });
    assert.equal(response.status, 200);
    assert.equal(seen[0]?.['projectId'], 'alpha');
  } finally { await close(); }
});

test('a body that repeats the header is accepted and a contradiction is rejected', async () => {
  const { seen, base, close } = await harness();
  try {
    const same = await fetch(`${base}/v1/view`, { method: 'POST', headers: headers({ 'x-mnemoweave-project': 'alpha' }), body: JSON.stringify({ projectId: 'alpha' }) });
    assert.equal(same.status, 200);
    assert.equal(seen[0]?.['projectId'], 'alpha');

    const conflict = await fetch(`${base}/v1/view`, { method: 'POST', headers: headers({ 'x-mnemoweave-project': 'alpha' }), body: JSON.stringify({ projectId: 'beta' }) });
    assert.equal(conflict.status, 400);
    assert.equal((await conflict.json() as { code: string }).code, 'INVALID_INPUT');
    assert.equal(seen.length, 1, 'a contradictory request must not reach the application');
  } finally { await close(); }
});

test('without the header the project stays absent, and an overlong value is rejected', async () => {
  const { seen, base, close } = await harness();
  try {
    const plain = await fetch(`${base}/v1/view`, { method: 'POST', headers: headers(), body: '{}' });
    assert.equal(plain.status, 200);
    assert.equal(seen[0]?.['projectId'], undefined);

    const long = await fetch(`${base}/v1/view`, { method: 'POST', headers: headers({ 'x-mnemoweave-project': 'x'.repeat(201) }), body: '{}' });
    assert.equal(long.status, 400);
  } finally { await close(); }
});

test('the shared client sends the project header it was configured with', async () => {
  const { seen, base, close } = await harness();
  try {
    const client = new MemoryClient({ baseUrl: base, token: TOKEN, hostId: HOST, projectId: 'alpha' });
    assert.equal((await client.inject({ query: 'probe' })).ok, true);
    assert.equal(seen[0]?.['projectId'], 'alpha');

    assert.throws(() => new MemoryClient({ baseUrl: base, token: TOKEN, hostId: HOST, projectId: 'x'.repeat(201) }), /projectId/);
  } finally { await close(); }
});
