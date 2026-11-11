import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpServer } from '../../packages/protocols/http/src/index.ts';

/**
 * Who may edit a formal memory.
 *
 * This is a single-user deployment: the service token plus the Host header are the whole identity
 * model, and a second "operator" secret would only be another copy of the same secret held by the
 * same person. Editing therefore requires the service token and a declared Host — not an extra
 * credential. The audit trail still records a `local-user` decision, so it is attributable to the
 * host that made the change; it is not, and never was, proof that a human was at the keyboard.
 */

const TOKEN = 't'.repeat(32);
const OPERATOR = 'o'.repeat(32);
const HOST = 'host-edit-probe';
const MEMORY_ID = '11111111-2222-3333-4444-555555555555';

async function harness(): Promise<{ calls: { memoryId: string; input: unknown }[]; base: string; close: () => Promise<void> }> {
  const calls: { memoryId: string; input: unknown }[] = [];
  const app = {
    readMemory: async () => ({ id: MEMORY_ID }),
    health: async () => ({ ready: true as const, version: '0' }),
  } as unknown as Parameters<typeof createHttpServer>[0];
  const client = {
    editMemory: async (memoryId: string, input: unknown) => { calls.push({ memoryId, input }); return { memoryId, revisionId: 'r', providerMemoryId: 'p', contentHash: 'a'.repeat(64), entryVersion: 1 }; },
    withdrawMemory: async (memoryId: string, input: unknown) => { calls.push({ memoryId, input }); return { memoryId, revisionId: 'r', entryVersion: 1, withdrawnAt: '2026-11-11T00:00:00.000Z' }; },
  } as unknown as Parameters<typeof createHttpServer>[3];
  const server: Server = createHttpServer(app, TOKEN, OPERATOR, client);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { calls, base, close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }) };
}

const body = JSON.stringify({ content: '编辑后的正文', entryVersion: 0 });

test('the service token plus a Host header authorizes an edit and a withdrawal', async () => {
  const { calls, base, close } = await harness();
  try {
    const edited = await fetch(`${base}/v1/memories/${MEMORY_ID}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': HOST, 'content-type': 'application/json', connection: 'close' },
      body,
    });
    assert.equal(edited.status, 200, 'no second credential is required on a single-user deployment');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.memoryId, MEMORY_ID);
    assert.deepEqual(calls[0]?.input, { content: '编辑后的正文', entryVersion: 0 }, 'no confirmation field travels on');

    const withdrawn = await fetch(`${base}/v1/memories/${MEMORY_ID}/withdraw`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': HOST, 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ reason: '不再适用', entryVersion: 1 }),
    });
    assert.equal(withdrawn.status, 200);
    assert.equal(calls.length, 2, 'withdrawal is authorized the same way');
  } finally { await close(); }
});

test('an edit without a Host header is refused: the change must be attributable', async () => {
  const { calls, base, close } = await harness();
  try {
    for (const request of [
      { method: 'PATCH' as const, path: '', body },
      { method: 'POST' as const, path: '/withdraw', body: JSON.stringify({ reason: '不再适用', entryVersion: 1 }) },
    ]) {
      const response = await fetch(`${base}/v1/memories/${MEMORY_ID}${request.path}`, {
        method: request.method,
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', connection: 'close' },
        body: request.body,
      });
      assert.equal(response.status, 401, `${request.method} must not be applied without an identity`);
      assert.equal((await response.json() as { code: string }).code, 'UNAUTHORIZED');
    }
    assert.equal(calls.length, 0, 'an unattributed write must never reach the memory store');
  } finally { await close(); }
});

test('the confirmation endpoint is gone: it cannot be used to bootstrap a write', async () => {
  const { base, close } = await harness();
  try {
    const response = await fetch(`${base}/v1/memories/${MEMORY_ID}/confirm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': HOST, 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ action: 'edit' }),
    });
    // No route: the request falls through to the catch-all and is refused, never issued a value.
    assert.notEqual(response.status, 200);
  } finally { await close(); }
});

test('an unknown token cannot edit, whatever Host it claims', async () => {
  const { calls, base, close } = await harness();
  try {
    for (const claimed of [HOST, 'chatgpt-desktop', '']) {
      const response = await fetch(`${base}/v1/memories/${MEMORY_ID}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${'x'.repeat(32)}`, 'x-mnemoweave-host': claimed, 'content-type': 'application/json', connection: 'close' },
        body,
      });
      assert.equal(response.status, 401, `Host "${claimed}" must not change the outcome`);
    }
    assert.equal(calls.length, 0);
  } finally { await close(); }
});
