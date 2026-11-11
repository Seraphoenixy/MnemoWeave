import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectPort } from '../../apps/server/src/instance-guard.ts';

/**
 * The guard decides whether this process may take the port. Getting it wrong in the `ours`
 * direction starts a duplicate Server; getting it wrong in the `foreign` direction takes a
 * port that another program is actively serving. Every case is injected, so no process is
 * spawned and no port is bound.
 */

const TOKEN = 't'.repeat(32);

/** A fetch that answers with the given status and body, or throws the given system error. */
function fetchAs(status: number, body: unknown, causeCode?: string): typeof fetch {
  return (async () => {
    if (causeCode !== undefined) {
      throw Object.assign(new TypeError('request failed'), { cause: { code: causeCode } });
    }
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

test('an existing MnemoWeave on the port is reported as ours, so no second Server starts', async () => {
  const occupant = await inspectPort({ port: 4317, token: TOKEN, fetchImpl: fetchAs(200, { live: true, service: 'mnemoweave', protocol: 1 }) });
  assert.equal(occupant, 'ours');
});

test('a rejected token still identifies our Server, so it is ours rather than a conflict', async () => {
  // A token mismatch must not be treated as an intruder: restarting would not help, and the
  // running Server is healthy.
  const occupant = await inspectPort({ port: 4317, token: TOKEN, fetchImpl: fetchAs(401, { code: 'UNAUTHORIZED', service: 'mnemoweave', protocol: 1 }) });
  assert.equal(occupant, 'ours');
});

test('another program on the port is reported as foreign', async () => {
  const occupant = await inspectPort({ port: 4317, token: TOKEN, fetchImpl: fetchAs(200, { hello: 'not-mnemoweave' }) });
  assert.equal(occupant, 'foreign');
});

test('an answer that is not JSON is foreign rather than a crash', async () => {
  const doFetch = (async () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } }) as unknown as Response) as unknown as typeof fetch;
  assert.equal(await inspectPort({ port: 4317, token: TOKEN, fetchImpl: doFetch }), 'foreign');
});

test('port 0 is never probed, because it asks the OS for a free port', async () => {
  // MNEMOWEAVE_PORT=0 is a supported configuration (tests and ephemeral servers use it). A
  // probe against 127.0.0.1:0 fails, and treating that failure as "someone else has the port"
  // stopped every such Server from starting.
  let probed = false;
  const doFetch = (async () => { probed = true; throw Object.assign(new TypeError('bad port'), { cause: { code: 'ECONNREFUSED' } }); }) as unknown as typeof fetch;
  assert.equal(await inspectPort({ port: 0, token: TOKEN, fetchImpl: doFetch }), 'free');
  assert.equal(probed, false, 'a fixed port is not probed when the OS assigns one');
});

test('a refused connection means the port is free to take', async () => {
  const occupant = await inspectPort({ port: 4317, token: TOKEN, fetchImpl: fetchAs(0, undefined, 'ECONNREFUSED') });
  assert.equal(occupant, 'free');
});

test('an address that accepts but never answers is foreign, because binding would race it', async () => {
  const occupant = await inspectPort({ port: 4317, token: TOKEN, fetchImpl: fetchAs(0, undefined, 'ETIMEDOUT') });
  assert.equal(occupant, 'foreign');
});

test('the guard asks the liveness route of the configured port only', async () => {
  const seen: string[] = [];
  const doFetch = (async (url: string) => {
    seen.push(url);
    return { status: 200, ok: true, json: async () => ({ live: true, service: 'mnemoweave', protocol: 1 }) } as unknown as Response;
  }) as unknown as typeof fetch;
  await inspectPort({ port: 4399, token: TOKEN, fetchImpl: doFetch });
  assert.deepEqual(seen, ['http://127.0.0.1:4399/health/live']);
});
