import { hostCredential } from '../../packages/protocols/http/src/index.ts';
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
          const url = `http://127.0.0.1:${event.address!.port}`;
          void pairTestHost(url, env).then(() => { clearTimeout(timer); done({ child, url }); }).catch(error => { clearTimeout(timer); child.kill(); fail(error); });
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
export function testHostHeaders(token: string) { return { authorization: `Bearer ${hostCredential(token, TEST_HOST)}`, 'x-mnemoweave-host': TEST_HOST, 'content-type': 'application/json' }; }
export async function pairTestHost(url: string, env: Record<string, string>) {
  if (!env.MNEMOWEAVE_STATE_DIR) return;
  const response = await fetch(`${url}/v1/sync/grant`, { method: 'POST', headers: { authorization: `Bearer ${env.MNEMOWEAVE_OPERATOR_TOKEN ?? TEST_OPERATOR}`, 'content-type': 'application/json' }, body: JSON.stringify({ hostId: TEST_HOST, projects: ['*'], globalIncluded: true }) });
  if (response.status !== 200) throw new Error('Isolated test Host pairing failed');
}
