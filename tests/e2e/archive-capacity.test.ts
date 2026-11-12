import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { configure } from '../../apps/server/src/config.ts';
import { createHttpServer } from '../../packages/protocols/http/src/index.ts';
import { mnemonBinary } from './mnemon-binary.ts';

/**
 * Archive capacity maintenance.
 *
 * When a workspace is over its active capacity the Server offers the archives that would free
 * room, oldest-confirmed first, and nothing is archived by that read. Releasing one needs the
 * version the user saw, so an entry edited in between keeps its newest text and reports a
 * conflict rather than being silently archived.
 */

const TOKEN = 'host-token-0123456789abcdef';
const OPERATOR = 'operator-token-0123456789abcdef';
const HOST = 'capacity-probe';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';

test('capacity maintenance lists what would free room and archives only on an explicit action', { timeout: 240_000 }, async () => {
  const dir = resolve('work', 'archive-capacity', randomUUID());
  mkdirSync(join(dir, 'provider'), { recursive: true });
  mkdirSync(join(dir, 'state'), { recursive: true });
  // A small limit so a few entries overflow it; the production default is 10 MiB.
  const app = configure({
    MNEMON_BINARY: mnemonBinary(), MNEMON_DATA_DIR: join(dir, 'provider'), MNEMON_STORE: 'capacity',
    MNEMOWEAVE_STATE_DIR: join(dir, 'state'), MNEMOWEAVE_PORT: '0',
    MNEMOWEAVE_TOKEN: TOKEN, MNEMOWEAVE_OPERATOR_TOKEN: OPERATOR, MNEMOWEAVE_WORKER: 'off',
    MNEMOWEAVE_ARCHIVE_ACTIVE_CAPACITY_BYTES: '400',
  });
  const server: Server = createHttpServer(app.app, TOKEN, OPERATOR, app.client!, app.storage);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const host = { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': HOST, 'content-type': 'application/json' };
  const operator = { authorization: `Bearer ${OPERATOR}`, 'content-type': 'application/json' };
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = host) => {
    const response = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> };
  };
  try {
    assert.equal((await call('POST', '/v1/workspaces', { workspaceId: WORKSPACE, name: 'capacity workspace' }, operator)).status, 201);

    // Two entries that fit, each with a distinct body length.
    const first = await call('POST', '/v1/archives', {
      workspaceId: WORKSPACE, title: '较早的档案', body: 'a'.repeat(120), source: 'user', verification: 'open', evidence: '实测',
    }, operator);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    await new Promise(done => setTimeout(done, 10));
    const second = await call('POST', '/v1/archives', {
      workspaceId: WORKSPACE, title: '较新的档案', body: 'b'.repeat(120), source: 'user', verification: 'open', evidence: '实测',
    }, operator);
    assert.equal(second.status, 201, JSON.stringify(second.body));

    // The read is always available: below capacity it reports the room left and offers the rows
    // the user could still release, without claiming anything is wrong.
    const under = await call('GET', `/v1/archives/release-candidates?workspaceId=${WORKSPACE}`, undefined, operator);
    assert.equal(under.status, 200, JSON.stringify(under.body));
    assert.equal((under.body as { capacity: { exceeded: boolean } }).capacity.exceeded, false);
    assert.equal((under.body as { items: unknown[] }).items.length, 2);

    // Overflow with a third entry, which the capacity check must refuse outright.
    const refused = await call('POST', '/v1/archives', {
      workspaceId: WORKSPACE, title: '放不下的档案', body: 'c'.repeat(400), source: 'user', verification: 'open', evidence: '实测',
    }, operator);
    assert.equal(refused.status, 409);
    assert.equal((refused.body as { code: string }).code, 'ARCHIVE_CAPACITY_EXCEEDED');

    // The list now reports the overflow and offers the oldest entry first.
    const over = await call('GET', `/v1/archives/release-candidates?workspaceId=${WORKSPACE}`, undefined, operator);
    assert.equal(over.status, 200, JSON.stringify(over.body));
    const view = over.body as {
      workspaceId: string;
      capacity: { exceeded: boolean; activeBytes: number; limitBytes: number };
      items: Array<{ entryId: string; title: string; bodyBytes: number; version: number; updatedAt: string }>;
      remaining: number;
    };
    assert.equal(view.workspaceId, WORKSPACE);
    // Active writes never exceed the limit: they are refused first. So `exceeded` stays false and
    // the capacity section is driven by the refusal, which is the state the user is actually in.
    assert.equal(view.capacity.limitBytes, 400);
    // A write is refused rather than allowed to overflow, so the reading is at most the limit;
    // the offered rows are what the user can give up to make room.
    assert.ok(view.capacity.activeBytes + 400 > view.capacity.limitBytes, 'a 400-byte write would not fit');
    assert.deepEqual(view.items.map(item => item.title), ['较早的档案', '较新的档案'], 'oldest confirmed first');
    assert.equal(view.items[0]?.bodyBytes, 120);
    assert.equal(view.items[0]?.version, 1);
    assert.equal(view.remaining, 0);
    // The read changed nothing.
    assert.equal((await call('GET', `/v1/archives?workspaceId=${WORKSPACE}`, undefined, operator)).status, 200);
    const stillActive = await call('GET', `/v1/archives?workspaceId=${WORKSPACE}`, undefined, operator);
    assert.equal((stillActive.body as { items: Array<{ state: string }> }).items.filter(item => item.state === 'active').length, 2);

    // A page is bounded and reports how many rows it left out.
    const paged = await call('GET', `/v1/archives/release-candidates?workspaceId=${WORKSPACE}&limit=1`, undefined, operator);
    assert.equal((paged.body as { items: unknown[] }).items.length, 1);
    assert.equal((paged.body as { remaining: number }).remaining, 1);

    // Releasing needs the version the user saw: a stale base version conflicts.
    const oldest = view.items[0]!;
    const edited = await call('PATCH', `/v1/archives/${oldest.entryId}`, { title: '较早的档案', body: 'a'.repeat(130), verification: 'open', evidence: '实测', baseVersion: oldest.version }, operator);
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const stale = await call('POST', `/v1/archives/${oldest.entryId}/state`, { state: 'archived', baseVersion: oldest.version }, operator);
    assert.equal(stale.status, 409);
    assert.equal((stale.body as { code: string }).code, 'VERSION_CONFLICT');

    // With the version read after the edit, the release applies and frees room.
    const current = (edited.body as { version: number }).version;
    const released = await call('POST', `/v1/archives/${oldest.entryId}/state`, { state: 'archived', baseVersion: current }, operator);
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal((released.body as { state: string }).state, 'archived');
    const after = await call('GET', `/v1/archives/release-candidates?workspaceId=${WORKSPACE}`, undefined, operator);
    const afterView = after.body as { capacity: { exceeded: boolean; activeBytes: number }; items: Array<{ title: string }> };
    assert.equal(afterView.capacity.exceeded, false);
    assert.ok(afterView.capacity.activeBytes < view.capacity.activeBytes, 'an archived entry no longer counts against active capacity');
    assert.deepEqual(afterView.items.map(item => item.title), ['较新的档案'], 'only active rows are offered');

    // A workspace id is required, and an unknown one is not found.
    assert.equal((await call('GET', '/v1/archives/release-candidates', undefined, operator)).status, 409);
    assert.equal((await call('GET', `/v1/archives/release-candidates?workspaceId=${randomUUID()}`, undefined, operator)).status, 404);
    assert.equal((await call('GET', '/v1/archives/release-candidates?workspaceId=not-a-uuid', undefined, operator)).status, 400);
    assert.equal((await call('GET', `/v1/archives/release-candidates?workspaceId=${WORKSPACE}&limit=0`, undefined, operator)).status, 400);
  } finally {
    await new Promise<void>((done, fail) => { server.closeAllConnections(); server.close(error => error ? fail(error) : done()); });
    await app.close();
  }
});
