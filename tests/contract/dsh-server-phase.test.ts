import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemorySource } from '../../plugins/dsh-mnemo-weave/src/ui/memory-source.ts';
import { MemoryClient } from '../../packages/client/src/index.ts';
import type { ServerProbe } from '../../packages/client/src/ensure-server.ts';

/**
 * The memory page must be able to say "starting", "connected" or "failed and why" instead of
 * a generic unavailable. The Server is hosted by a scheduled task, so a first load with
 * nothing listening is normal, not an error.
 */

const TOKEN = 'm'.repeat(32);
const URL = 'http://127.0.0.1:4317';

/** A client whose /health/ready answer is injected; no socket is opened. */
function sourceWith(probe: ServerProbe | undefined, health: { ok: true; value: { ready: boolean; version: string; capabilities: string[] } } | { ok: false; error: { code: string } }): MemorySource {
  const client = {
    hostId: 'dsh',
    health: async () => health,
  } as unknown as MemoryClient;
  return new MemorySource({
    client,
    serverUrl: URL,
    hasToken: true,
    ...(probe === undefined ? {} : { ensureServer: async () => probe }),
  });
}

const okHealth = { ok: true as const, value: { ready: true, version: '0.2.13', capabilities: ['health'] } };

test('a connected Server reports the connected phase and its version', async () => {
  const status = await sourceWith({ state: 'ready' }, okHealth).status();
  assert.equal(status.status, 'ok');
  assert.equal(status.server.phase, 'connected');
  assert.equal(status.version, '0.2.13');
});

test('a Server that is still initialising reports starting, not a failure', async () => {
  const status = await sourceWith(
    { state: 'starting', detail: 'the Server is up and its memory provider is still starting' },
    okHealth,
  ).status();
  assert.equal(status.status, 'unavailable');
  assert.equal(status.reason, 'SERVER_STARTING');
  assert.equal(status.server.phase, 'starting');
});

test('a token mismatch is reported as unauthorized and keeps the running Server', async () => {
  const status = await sourceWith(
    { state: 'failed', reason: 'unauthorized', detail: 'the Server rejected the service token', taskRun: false },
    { ok: false, error: { code: 'UNAUTHORIZED' } },
  ).status();
  assert.equal(status.status, 'unauthorized');
  assert.equal(status.server.phase, 'failed');
  assert.equal(status.server.reason, 'unauthorized');
});

test('a port taken by another program is reported as a conflict, with the task not run', async () => {
  const status = await sourceWith(
    { state: 'failed', reason: 'address_conflict', detail: 'a different service answered on this port', taskRun: false },
    okHealth,
  ).status();
  assert.equal(status.status, 'unavailable');
  assert.equal(status.reason, 'ADDRESS_CONFLICT');
  assert.equal(status.server.phase, 'failed');
  assert.equal(status.server.reason, 'address_conflict');
  assert.equal(status.server.taskRun, false);
});

test('a wake that ran but timed out reports task_failed and says the task ran', async () => {
  const status = await sourceWith(
    { state: 'failed', reason: 'task_failed', detail: 'the Server did not become ready before the deadline', taskRun: true },
    okHealth,
  ).status();
  assert.equal(status.server.phase, 'failed');
  assert.equal(status.server.reason, 'task_failed');
  assert.equal(status.server.taskRun, true, 'the page can tell the user a retry is worth trying');
});

test('without a probe configured, an unauthorized health answer is still reported as such', async () => {
  const status = await sourceWith(undefined, { ok: false, error: { code: 'UNAUTHORIZED' } }).status();
  assert.equal(status.status, 'unauthorized');
  assert.equal(status.server.phase, 'failed');
  assert.equal(status.server.reason, 'unauthorized');
});

test('a transient provider failure without a probe is reported as starting, not failed', async () => {
  const status = await sourceWith(undefined, { ok: false, error: { code: 'PROVIDER_UNAVAILABLE' } }).status();
  assert.equal(status.status, 'unavailable');
  assert.equal(status.server.phase, 'starting');
});
