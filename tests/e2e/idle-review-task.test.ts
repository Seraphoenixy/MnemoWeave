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
import { tempDir } from '../support/temp.ts';

/**
 * An idle review submits through the authorized write-task entry, never the resource routes.
 *
 * The Server is what enforces that: an action claiming `idle-review` must name the Host's own run,
 * that run must be open, one run may change at most one rule and add at most one archive, and a
 * review never writes a formal memory.
 */

const TOKEN = 'host-token-0123456789abcdef';
const OPERATOR = 'operator-token-0123456789abcdef';
const HOST = 'idle-probe';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';

test('an idle-review action is bounded by the run that authorized it', { timeout: 120_000 }, async () => {
  const dir = await tempDir('idle-review-task', 'idle-review-task');
  mkdirSync(join(dir, 'provider'), { recursive: true });
  mkdirSync(join(dir, 'state'), { recursive: true });
  const app = configure({
    MNEMON_BINARY: mnemonBinary(), MNEMON_DATA_DIR: join(dir, 'provider'), MNEMON_STORE: 'idle',
    MNEMOWEAVE_STATE_DIR: join(dir, 'state'), MNEMOWEAVE_PORT: '0',
    MNEMOWEAVE_TOKEN: TOKEN, MNEMOWEAVE_OPERATOR_TOKEN: OPERATOR, MNEMOWEAVE_WORKER: 'off',
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
    assert.equal((await call('POST', '/v1/workspaces', { workspaceId: WORKSPACE, name: 'idle workspace' }, operator)).status, 201);
    // The session must be bound before an archive action can resolve a workspace.
    assert.equal((await call('PUT', '/v1/sessions/s-1/workspace', { workspaceId: WORKSPACE })).status, 200);
    // One completed user turn carrying a durable instruction, then a scan.
    assert.equal((await call('POST', '/v1/events', {
      protocolVersion: '1', adapterVersion: 'probe', eventId: 'idle-event-1', sessionId: 's-1', turnId: '1',
      kind: 'message.user', occurredAt: '2026-11-10T00:00:00.000Z', receivedAt: '2026-11-10T00:00:00.000Z',
      sourceRef: 'probe', payload: { text: '以后都用 pnpm，不要用 npm' },
    })).status, 200);
    const scan = await call('POST', '/v1/idle-review/scan', { sessionId: 's-1', completedThroughTurn: 1 });
    assert.ok(scan.status >= 200 && scan.status < 300, JSON.stringify(scan.body));
    const signals = (scan.body as { signals: Array<{ id: string; eventId: string }> }).signals;
    assert.equal(signals.length, 1);

    const started = await call('POST', '/v1/idle-review/runs', { sessionId: 's-1', maxSignals: 10 });
    assert.ok(started.status >= 200 && started.status < 300, JSON.stringify(started.body));
    const run = (started.body as { run: { id: string } }).run;

    // A review may not write a formal memory, whatever it claims.
    const formal = await call('POST', `/v1/memory-write-tasks/${run.id}/actions/0`, {
      kind: 'formal-memory', trigger: 'idle-review', runId: run.id, sessionId: 's-1',
      action: 'create', content: '不应写入', reason: '空闲复盘',
      evidenceRefs: [signals[0]!.eventId], assessment: 'supported',
    });
    // The payload schema already excludes a formal-memory action from this trigger, and the Server
    // repeats the check for anything that got past it: either way the write is refused.
    assert.ok(formal.status === 400 || formal.status === 403, String(formal.status));
    assert.ok(['INVALID_INPUT', 'SCOPE_FORBIDDEN'].includes((formal.body as { code: string }).code));

    // A run that is not this Host's is not found, and a run id from another session is refused.
    assert.equal((await call('POST', `/v1/memory-write-tasks/${randomUUID()}/actions/0`, {
      kind: 'rule', trigger: 'idle-review', runId: randomUUID(), sessionId: 's-1',
      action: 'create', body: '准则', reason: '空闲复盘', evidenceRefs: [signals[0]!.eventId],
    })).status, 404);
    const wrongSession = await call('POST', `/v1/memory-write-tasks/${run.id}/actions/0`, {
      kind: 'rule', trigger: 'idle-review', runId: run.id, sessionId: 'other-session',
      action: 'create', body: '准则', reason: '空闲复盘', evidenceRefs: [signals[0]!.eventId],
    });
    assert.equal(wrongSession.status, 403);

    // The allowed rule create applies and returns the applied receipt.
    const ruleAction = await call('POST', `/v1/memory-write-tasks/${run.id}/actions/0`, {
      kind: 'rule', trigger: 'idle-review', runId: run.id, sessionId: 's-1',
      action: 'create', body: '本项目统一使用 pnpm', reason: '空闲复盘：常驻指令', evidenceRefs: [signals[0]!.eventId],
    });
    assert.equal(ruleAction.status, 200, JSON.stringify(ruleAction.body));
    assert.equal((ruleAction.body as { status: string }).status, 'applied');
    const applied = ruleAction.body as { entryId: string; entryVersion: number };
    assert.equal(applied.entryVersion, 1);
    // The rule is now resident.
    const rules = await call('GET', '/v1/rules');
    assert.ok((rules.body as { items: Array<{ body: string }> }).items.some(item => item.body === '本项目统一使用 pnpm'));

    // A review action that names no run is refused before it can claim the task key.
    const noRun = await call('POST', `/v1/memory-write-tasks/${randomUUID()}/actions/0`, {
      kind: 'rule', trigger: 'idle-review', sessionId: 's-1',
      action: 'create', body: '准则', reason: '空闲复盘', evidenceRefs: [signals[0]!.eventId],
    });
    assert.equal(noRun.status, 400);

    // A run has one action slot per kind, so a second rule change under the same key is a
    // different payload for that key: refused, never applied as a second write.
    const second = await call('POST', `/v1/memory-write-tasks/${run.id}/actions/0`, {
      kind: 'rule', trigger: 'idle-review', runId: run.id, sessionId: 's-1',
      action: 'create', body: '另一条准则', reason: '空闲复盘', evidenceRefs: [signals[0]!.eventId],
    });
    assert.equal(second.status, 409);
    assert.equal((second.body as { code: string }).code, 'IDEMPOTENCY_CONFLICT');
    // Replaying the identical action returns the original receipt instead of writing again.
    const replay = await call('POST', `/v1/memory-write-tasks/${run.id}/actions/0`, {
      kind: 'rule', trigger: 'idle-review', runId: run.id, sessionId: 's-1',
      action: 'create', body: '本项目统一使用 pnpm', reason: '空闲复盘：常驻指令', evidenceRefs: [signals[0]!.eventId],
    });
    assert.equal((replay.body as { entryId: string }).entryId, applied.entryId);

    // The archive create lands in the session's workspace and is reported applied.
    const archiveAction = await call('POST', `/v1/memory-write-tasks/${run.id}/actions/1`, {
      kind: 'workspace-archive', trigger: 'idle-review', runId: run.id, sessionId: 's-1',
      action: 'create', title: '构建约定', body: '构建使用 pnpm', evidence: '实测',
      reason: '空闲复盘：工作区成果', evidenceRefs: [signals[0]!.eventId],
    });
    assert.equal(archiveAction.status, 200, JSON.stringify(archiveAction.body));
    assert.equal((archiveAction.body as { status: string }).status, 'applied');
    const listed = await call('GET', `/v1/archives?workspaceId=${WORKSPACE}`, undefined, operator);
    assert.ok((listed.body as { items: Array<{ title: string }> }).items.some(item => item.title === '构建约定'));

    // Once the run finished, no further action is accepted.
    const finished = await call('POST', `/v1/idle-review/runs/${run.id}/finish`, { state: 'succeeded' });
    assert.ok(finished.status >= 200 && finished.status < 300, JSON.stringify(finished.body));
    const late = await call('POST', `/v1/memory-write-tasks/${run.id}/actions/2`, {
      kind: 'rule', trigger: 'idle-review', runId: run.id, sessionId: 's-1',
      action: 'create', body: '迟到准则', reason: '空闲复盘', evidenceRefs: [signals[0]!.eventId],
    });
    assert.equal(late.status, 409);
    assert.equal((late.body as { code: string }).code, 'INVALID_STATE');
  } finally {
    await new Promise<void>((done, fail) => { server.closeAllConnections(); server.close(error => error ? fail(error) : done()); });
    await app.close();
  }
});
