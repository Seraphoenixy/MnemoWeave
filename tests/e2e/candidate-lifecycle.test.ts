import { testHostHeaders, pairTestHost, TEST_OPERATOR } from '../support/server.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MnemonCliProvider } from '../../packages/providers/mnemon/src/index.ts';
import type { CandidateRecord } from '../../packages/core/contracts/src/index.ts';

async function start(env: Record<string, string>): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(process.execPath, ['apps/server/src/main.ts'], { cwd: resolve('.'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, MNEMOWEAVE_OPERATOR_TOKEN: TEST_OPERATOR, ...env } });
  return new Promise((done, fail) => {
    const timer = setTimeout(() => { child.kill(); fail(new Error('Server startup timed out')); }, 10000);
    child.once('error', error => { clearTimeout(timer); fail(error); });
    child.once('exit', code => { clearTimeout(timer); fail(new Error(`Server exited: ${code}`)); });
    let output = '';
    child.stderr!.on('data', data => {
      output += String(data);
      const lines = output.split('\n'); output = lines.pop()!;
      for (const line of lines) {
        if (!line.startsWith('{')) continue;
        const event = JSON.parse(line) as { event: string; address?: { port: number } };
        if (event.event === 'listening') { const url = `http://127.0.0.1:${event.address!.port}`; void pairTestHost(url, env).then(() => { clearTimeout(timer); done({ child, url }); }).catch(fail); }
      }
    });
  });
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill(); await exited;
}

test('HTTP/MCP candidate submission survives actual Server restart and never writes formal memory', { timeout: 60000 }, async () => {
  await mkdir('work/e2e', { recursive: true });
  const root = await mkdtemp(resolve('work/e2e/candidates-'));
  const binary = process.env.MNEMON_BINARY ?? resolve('work/tools/mnemon/mnemon.exe');
  const env = {
    MNEMON_BINARY: binary, MNEMON_DATA_DIR: join(root, 'provider'), MNEMON_STORE: 'candidate_test',
    MNEMOWEAVE_STATE_DIR: join(root, 'state'), MNEMOWEAVE_PORT: '0', MNEMOWEAVE_TOKEN: 'candidate-lifecycle-test-token-001',
    MNEMOWEAVE_WORKER: 'off',
  };
  const input = {
    idempotencyKey: 'http-candidate-001', content: '候选内容必须经过原审核方案才能进入正式记忆。', knowledgeType: 'Constraint', tags: ['test'],
    provenance: { source: 'test', sourceReference: 'test:lifecycle', evidence: ['actual protocol test'], verificationStatus: 'unverified', confidence: 0.5, applicability: 'test only', limitations: 'not approved', lastVerified: null },
  };
  const headers = testHostHeaders(env.MNEMOWEAVE_TOKEN);
  let server = await start(env);
  let client: Client | undefined;
  try {
    const submit = (body: unknown) => fetch(`${server.url}/v1/remember`, { method: 'POST', headers, body: JSON.stringify(body) });
    const response = await submit(input);
    assert.equal(response.status, 202);
    const candidate = await response.json() as CandidateRecord;
    assert.equal(candidate.status, 'pending_review');
    assert.equal(candidate.receipt.status, 'candidate');
    assert.deepEqual(await (await submit(input)).json(), candidate);
    assert.equal((await submit({ ...input, content: 'same key different content' })).status, 409);
    assert.equal((await submit({ ...input, approved: true })).status, 400);
    assert.equal((await fetch(`${server.url}/v1/candidates/${candidate.id}`)).status, 401);
    const transport = new StdioClientTransport({ command: process.execPath, args: ['apps/server/src/mcp-main.ts'], cwd: resolve('.'), env: { MNEMOWEAVE_MCP_MODE: 'standalone', ...env, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } });
    client = new Client({ name: 'candidate-lifecycle', version: '0.1.0' });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'remember'));
    assert.ok(!tools.tools.some(tool => /approve|review/.test(tool.name)));
    const result = await client.callTool({ name: 'candidate_status', arguments: { candidateId: candidate.id } });
    assert.notEqual(result.isError, true);
    assert.deepEqual(JSON.parse((result.content as { text: string }[])[0]!.text), candidate);
    const duplicates = await Promise.all([
      submit({ ...input, idempotencyKey: 'shared-key-0001' }).then(value => value.json()),
      client.callTool({ name: 'remember', arguments: { ...input, idempotencyKey: 'shared-key-0001' } }),
    ]);
    const httpCandidate = duplicates[0] as CandidateRecord;
    const mcpResult = duplicates[1] as { isError?: boolean; content: { text: string }[] };
    assert.notEqual(mcpResult.isError, true);
    assert.deepEqual(JSON.parse(mcpResult.content[0]!.text), httpCandidate);
    await client.close(); client = undefined;
    await stop(server.child);
    server = await start(env);
    const recovered = await fetch(`${server.url}/v1/candidates/${candidate.id}`, { headers });
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), candidate);
    assert.deepEqual(await (await submit(input)).json(), candidate);
    const native = new MnemonCliProvider({ binary, dataDir: env.MNEMON_DATA_DIR, store: env.MNEMON_STORE });
    assert.deepEqual((await native.recall({ query: '候选内容', limit: 10 })).memories, []);
    const spec = await (await fetch(`${server.url}/openapi.json`, { headers })).json() as { paths: Record<string, unknown> };
    assert.ok(spec.paths['/v1/remember']);
  } finally { await client?.close(); await stop(server.child); }
});
