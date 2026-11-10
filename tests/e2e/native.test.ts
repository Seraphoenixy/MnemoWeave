import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MnemonCliProvider } from '../../packages/providers/mnemon/src/index.ts';
import { MemoryApplication } from '../../packages/core/application/src/index.ts';
import { createHttpServer } from '../../packages/protocols/http/src/index.ts';
import { mnemonBinary } from './mnemon-binary.ts';

test('Real Mnemon: Remember, deduplicate, HTTP + stdio MCP Recall', { timeout: 60000 }, async () => {
  const binary = mnemonBinary();
  await mkdir(resolve('work/e2e'), { recursive: true });
  const dataDir = await mkdtemp(resolve('work/e2e/run-'));
  const provider = new MnemonCliProvider({ binary, dataDir, store: 'acceptance' });
  assert.equal((await provider.health()).ready, true);
  const content = 'MnemoWeave acceptance fixture: 原生 TypeScript memory orchestration test.';
  const first = await provider.acceptanceRemember(content);
  const duplicate = await provider.acceptanceRemember(content);
  assert.equal(first.action, 'added');
  assert.equal(duplicate.action, 'skipped');
  assert.equal(duplicate.id, first.id);
  const token = 'local-acceptance-token-0123456789';
  const server = createHttpServer(new MemoryApplication(provider), token);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    assert.equal((await fetch(`${base}/health/live`)).status, 401);
    assert.equal((await fetch(`${base}/health/ready`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/v1/recall`, { method: 'POST', headers, body: '{"query":""}' })).status, 400);
    assert.equal((await fetch(`${base}/v1/remember`, { method: 'POST', headers, body: '{"content":"bypass"}' })).status, 409);
    const response = await fetch(`${base}/v1/recall`, { method: 'POST', headers, body: JSON.stringify({ query: 'MnemoWeave acceptance fixture', limit: 5 }) });
    assert.equal(response.status, 200);
    const http = await response.json() as { memories: { id: string; content: string }[] };
    assert.ok(http.memories.some(memory => memory.id === first.id && memory.content === content));
    const transport = new StdioClientTransport({ command: process.execPath, args: ['apps/server/src/mcp-main.ts'], cwd: resolve('.'), env: { MNEMOWEAVE_MCP_MODE: 'standalone',
      MNEMON_BINARY: binary, MNEMON_DATA_DIR: dataDir, MNEMON_STORE: 'acceptance',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    } });
    const client = new Client({ name: 'mnemoweave-acceptance', version: '0.1.0' });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.ok(tools.tools.some(tool => tool.name === 'recall'));
      assert.ok(!tools.tools.some(tool => tool.name === 'remember'));
      const result = await client.callTool({ name: 'recall', arguments: { query: 'MnemoWeave acceptance fixture', limit: 5 } });
      assert.notEqual(result.isError, true);
      const parts = result.content as { type: string; text?: string }[];
      const mcp = JSON.parse(parts[0]!.text!) as typeof http;
      assert.ok(mcp.memories.some(memory => memory.id === first.id));
      await writeFile(join(dataDir, 'acceptance-result.json'), JSON.stringify({ first, duplicate, http, mcp }, null, 2));
    } finally { await client.close(); }
  } finally { await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())); }
});
