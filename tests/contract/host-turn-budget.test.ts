import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureServerForTurn, prewarmBudgetMs, LOCAL_SERVER_TASK_NAME } from '../../packages/client/src/ensure-server.ts';

/**
 * A host turn must never be held open by a Server that will not come up. Session-start hooks
 * may wait; per-turn hooks pass their remaining deadline and give up when it is spent.
 */

const TOKEN = 'p'.repeat(32);

/** A fetch that refuses connections, recording how many probes happened. */
function refusing(): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  }) as unknown as typeof fetch;
  return { fetchImpl: impl, calls: () => calls };
}

test('the prewarm budget comes from the environment and defaults to a session-scale wait', () => {
  assert.equal(prewarmBudgetMs({}), 4_000);
  assert.equal(prewarmBudgetMs({ MNEMOWEAVE_STARTUP_WAIT_MS: '9000' }), 9_000);
  assert.equal(prewarmBudgetMs({ MNEMOWEAVE_STARTUP_WAIT_MS: '0' }), 0, 'zero disables waiting');
  assert.equal(prewarmBudgetMs({ MNEMOWEAVE_STARTUP_WAIT_MS: 'nonsense' }), 4_000);
});

test('an exhausted per-turn deadline probes once and does not wait or wake the task', async () => {
  const refused = refusing();
  const triggered: string[] = [];
  const result = await ensureServerForTurn({
    baseUrl: 'http://127.0.0.1:4317', token: TOKEN, hostId: 'zcode',
    // The turn has already spent its budget.
    deadline: 1_000, now: () => 5_000,
    probeTimeoutMs: 100,
    runTask: async (name: string) => { triggered.push(name); return { ok: true, detail: '' }; },
    fetchImpl: refused.fetchImpl,
  } as never);
  assert.equal(result.state, 'failed');
  assert.equal(result.state === 'failed' ? result.reason : '', 'connection_refused');
  assert.deepEqual(triggered, [], 'a spent budget must not start the Server mid-turn');
});

test('a session-start call may wait long enough to wake and connect', async () => {
  let probes = 0;
  const triggered: string[] = [];
  const impl = (async (url: string) => {
    probes += 1;
    // Refuse for the first probe, then serve once the wake has been recorded.
    if (probes === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const body = url.endsWith('/health/live') ? { live: true, service: 'mnemoweave', protocol: 1 } : { ready: true, version: '0.2.13' };
    return {
      status: 200, ok: true,
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  const result = await ensureServerForTurn({
    baseUrl: 'http://127.0.0.1:4317', token: TOKEN, hostId: 'dsh',
    waitMs: 2_000, pollMs: 1,
    runTask: async (name: string) => { triggered.push(name); return { ok: true, detail: 'SUCCESS' }; },
    fetchImpl: impl,
  } as never);
  assert.deepEqual(triggered, [LOCAL_SERVER_TASK_NAME]);
  assert.deepEqual(result, { state: 'ready' });
});

test('the wait budget is capped by the caller deadline, never extended by it', async () => {
  const refused = refusing();
  const started = Date.now();
  const result = await ensureServerForTurn({
    baseUrl: 'http://127.0.0.1:4317', token: TOKEN, hostId: 'chatgpt',
    waitMs: 60_000, pollMs: 20, probeTimeoutMs: 50,
    deadline: started + 120, now: () => Date.now(),
    runTask: async () => ({ ok: true, detail: '' }),
    fetchImpl: refused.fetchImpl,
  } as never);
  assert.equal(result.state, 'failed');
  // The turn's own deadline wins: a 60 s wait must not become a 60 s turn.
  assert.ok(Date.now() - started < 5_000, `waited ${Date.now() - started} ms`);
});
