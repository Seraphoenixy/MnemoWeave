import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createNetServer } from 'node:net';
import { ensureServer, probeServer, LOCAL_SERVER_TASK_NAME } from '../../packages/client/src/ensure-server.ts';

/**
 * The scheduled task may only be woken when nothing is listening. Everything else — a busy
 * port owned by another program, a rejected token, a Server that is still initialising, an
 * unresponsive address — must stop the attempt and say which one it was.
 */

const TOKEN = 'k'.repeat(32);

/** A loopback server that answers every request with a fixed status and body. */
async function stub(status: number, body: unknown, headers: Record<string, string> = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}

/** Routes live/ready separately, the way the real Server answers them. */
async function dual(live: { status: number; body: unknown }, ready: { status: number; body: unknown }): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const chosen = req.url === '/health/live' ? live : ready;
    res.writeHead(chosen.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(chosen.body));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}

/** Routes live/ready on a specific port, so a wake can bring up the address under test. */
async function listenOn(port: number, live: unknown, ready: unknown): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const chosen = req.url === '/health/live' ? live : ready;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(chosen));
  });
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', () => done()));
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}

const LIVE_OK = { live: true, service: 'mnemoweave', protocol: 1 };
const READY_OK = { ready: true, version: '0.2.13', capabilities: ['health'] };

/** A port nothing listens on: bound, then released, so connections are refused. */
async function closedPort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', () => done()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

test('a running Server is used as-is and the task is never triggered', async () => {
  const server = await dual({ status: 200, body: LIVE_OK }, { status: 200, body: READY_OK });
  const triggered: string[] = [];
  try {
    const probe = await probeServer({ baseUrl: server.url, token: TOKEN, hostId: 'probe', probeTimeoutMs: 1_000 });
    assert.deepEqual(probe, { state: 'ready' });
    const result = await ensureServer({
      baseUrl: server.url, token: TOKEN, hostId: 'probe', probeTimeoutMs: 1_000, waitMs: 2_000,
      runTask: async (name) => { triggered.push(name); return { ok: true, detail: '' }; },
    });
    assert.deepEqual(result, { state: 'ready' });
    assert.deepEqual(triggered, [], 'a healthy Server must not be woken again');
  } finally { await server.close(); }
});

test('a refused connection wakes the task and then waits for the Server', async () => {
  const port = await closedPort();
  const triggered: string[] = [];
  // Stand in for the task: on the wake, the stub starts answering on the very port that was
  // refused, so the wait loop must observe ready and stop.
  let server: { url: string; close: () => Promise<void> } | undefined;
  try {
    const result = await ensureServer({
      baseUrl: `http://127.0.0.1:${port}`, token: TOKEN, hostId: 'probe', probeTimeoutMs: 500, waitMs: 5_000, pollMs: 10,
      taskExists: async () => true,
      runTask: async (name) => {
        triggered.push(name);
        server = await listenOn(port, LIVE_OK, READY_OK);
        return { ok: true, detail: 'SUCCESS' };
      },
    });
    assert.deepEqual(triggered, [LOCAL_SERVER_TASK_NAME], 'a refused connection wakes exactly the named task');
    assert.deepEqual(result, { state: 'ready' }, 'the wait must end as soon as the Server answers');
  } finally { await server?.close(); }
});

test('a Server that identifies itself but is not ready reports starting, and no task runs', async () => {
  const server = await dual({ status: 200, body: LIVE_OK }, { status: 503, body: { code: 'PROVIDER_UNAVAILABLE' } });
  const triggered: string[] = [];
  try {
    const probe = await probeServer({ baseUrl: server.url, token: TOKEN, hostId: 'probe', probeTimeoutMs: 1_000 });
    assert.equal(probe.state, 'starting');
    const result = await ensureServer({
      baseUrl: server.url, token: TOKEN, hostId: 'probe', probeTimeoutMs: 500, waitMs: 0,
      runTask: async (name) => { triggered.push(name); return { ok: true, detail: '' }; },
    });
    assert.equal(result.state, 'failed');
    assert.equal(result.state === 'failed' ? result.taskRun : true, false);
    assert.deepEqual(triggered, [], 'a starting Server must never be double-started');
  } finally { await server.close(); }
});

test('another program on the port is reported as a conflict, not woken as a missing Server', async () => {
  const foreign = await stub(200, { status: 'ok', app: 'something-else' });
  const triggered: string[] = [];
  try {
    const probe = await probeServer({ baseUrl: foreign.url, token: TOKEN, hostId: 'probe', probeTimeoutMs: 1_000 });
    assert.deepEqual(probe, { state: 'failed', reason: 'address_conflict', detail: 'a different service answered on this port', taskRun: false });
    const result = await ensureServer({
      baseUrl: foreign.url, token: TOKEN, hostId: 'probe', probeTimeoutMs: 500, waitMs: 1_000,
      runTask: async (name) => { triggered.push(name); return { ok: true, detail: '' }; },
    });
    assert.equal(result.state, 'failed');
    assert.equal(result.state === 'failed' ? result.reason : '', 'address_conflict');
    assert.deepEqual(triggered, [], 'launching a Server into an occupied port would fail anyway');
  } finally { await foreign.close(); }
});

test('a rejected token stops with unauthorized and leaves the running Server alone', async () => {
  // The real Server identifies itself in the 401 body too, which is what lets a host tell a
  // token mismatch from a stranger that answers 401 on the same port.
  const server = await dual({ status: 401, body: { code: 'UNAUTHORIZED', service: 'mnemoweave', protocol: 1, traceId: 'probe' } }, { status: 200, body: READY_OK });
  const triggered: string[] = [];
  try {
    const result = await ensureServer({
      baseUrl: server.url, token: TOKEN, hostId: 'probe', probeTimeoutMs: 500, waitMs: 2_000,
      runTask: async (name) => { triggered.push(name); return { ok: true, detail: '' }; },
    });
    assert.equal(result.state, 'failed');
    assert.equal(result.state === 'failed' ? result.reason : '', 'unauthorized');
    assert.deepEqual(triggered, [], 'a token mismatch must not restart a healthy Server');
  } finally { await server.close(); }
});

test('a non-JSON answer from a stranger is a conflict rather than a crash', async () => {
  const foreign = await stub(200, '<html>not us</html>');
  try {
    const probe = await probeServer({ baseUrl: foreign.url, token: TOKEN, hostId: 'probe', probeTimeoutMs: 1_000 });
    assert.equal(probe.state, 'failed');
    assert.equal(probe.state === 'failed' ? probe.reason : '', 'address_conflict');
  } finally { await foreign.close(); }
});

test('an unresponsive address times out without waking the task', async () => {
  // Accept connections but never answer: the probe must call that a timeout, not a refusal.
  const sockets: import('node:net').Socket[] = [];
  const blackhole = createNetServer((socket) => { sockets.push(socket); });
  await new Promise<void>((done) => blackhole.listen(0, '127.0.0.1', () => done()));
  const port = (blackhole.address() as AddressInfo).port;
  const triggered: string[] = [];
  try {
    const result = await ensureServer({
      baseUrl: `http://127.0.0.1:${port}`, token: TOKEN, hostId: 'probe', probeTimeoutMs: 300, waitMs: 2_000,
      runTask: async (name) => { triggered.push(name); return { ok: true, detail: '' }; },
    });
    assert.equal(result.state, 'failed');
    assert.equal(result.state === 'failed' ? result.reason : '', 'timeout');
    assert.deepEqual(triggered, [], 'only a refused connection may trigger the task');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => blackhole.close(() => done()));
  }
});

test('a missing task is reported as task_missing with the install step, and nothing is woken', async () => {
  const port = await closedPort();
  const triggered: string[] = [];
  const result = await ensureServer({
    baseUrl: `http://127.0.0.1:${port}`, token: TOKEN, hostId: 'probe', probeTimeoutMs: 300, waitMs: 1_000,
    taskExists: async () => false,
    runTask: async () => { triggered.push('run'); return { ok: true, detail: '' }; },
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.state === 'failed' ? result.reason : '', 'task_missing');
  assert.equal(result.state === 'failed' ? result.taskRun : true, false);
  assert.match(result.state === 'failed' ? result.detail : '', /publish-server\.mjs --register/, 'the detail names the one-time install step');
  assert.deepEqual(triggered, [], 'nothing to run when there is no task');
});

test('an existing task is woken, and a refused wake is reported as task_failed', async () => {
  const port = await closedPort();
  const result = await ensureServer({
    baseUrl: `http://127.0.0.1:${port}`, token: TOKEN, hostId: 'probe', probeTimeoutMs: 300, waitMs: 500,
    taskExists: async () => true,
    runTask: async () => ({ ok: false, detail: 'ERROR: The system cannot find the file specified.' }),
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.state === 'failed' ? result.reason : '', 'task_failed');
  assert.equal(result.state === 'failed' ? result.taskRun : true, false);
});
