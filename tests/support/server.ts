import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';

export async function startServer(env: Record<string, string>): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(process.execPath, ['apps/server/src/main.ts'], { cwd: resolve('.'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, MNEMOWEAVE_OPERATOR_TOKEN: TEST_OPERATOR, ...env } });
  return new Promise((done, fail) => {
    const timer = setTimeout(() => { child.kill(); fail(new Error('Server startup timed out')); }, 10000);
    child.once('error', error => { clearTimeout(timer); fail(error); });
    child.once('exit', code => { clearTimeout(timer); fail(new Error(`Server exited: ${code}`)); });
    let buffer = '';
    child.stderr!.on('data', data => {
      buffer += String(data); const lines = buffer.split('\n'); buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.startsWith('{')) continue;
        const event = JSON.parse(line) as { event: string; address?: { port: number } };
        if (event.event === 'listening') {
          clearTimeout(timer);
          done({ child, url: `http://127.0.0.1:${event.address!.port}` });
        }
      }
    });
  });
}
export async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit'); child.kill(); await ended;
}
export async function until<T>(operation: () => Promise<T>, predicate: (value: T) => boolean, timeout = 20000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await operation(); if (predicate(value)) return value;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error('Expected workflow state not reached');
}

export const TEST_OPERATOR = 'isolated-acceptance-operator-0123456789';
export const TEST_HOST = 'isolated-e2e-host';
/** Hosts authenticate with the service token and name themselves through the header. */
export function testHostHeaders(token: string) { return { authorization: `Bearer ${token}`, 'x-mnemoweave-host': TEST_HOST, 'content-type': 'application/json' }; }
/** Hosts no longer pair; the caller only needs the listener to be reachable. */
export async function awaitServerReady(url: string, _env: Record<string, string>): Promise<void> {
  const response = await fetch(`${url}/health/live`, { headers: { authorization: `Bearer ${_env.MNEMOWEAVE_TOKEN ?? ''}` } });
  if (!response.ok) throw new Error(`Server not ready: HTTP ${response.status}`);
}
