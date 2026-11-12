import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MnemonCliProvider } from '../../packages/providers/mnemon/src/index.ts';
import { MemoryApplication } from '../../packages/core/application/src/index.ts';
import { createHttpServer } from '../../packages/protocols/http/src/index.ts';
import { mnemonBinary } from './mnemon-binary.ts';
import { tempDir } from '../support/temp.ts';

test('Real Mnemon: Remember, deduplicate, HTTP + stdio MCP Recall', { timeout: 60000 }, async () => {
  const binary = mnemonBinary();
  await mkdir(resolve('work/e2e'), { recursive: true });
  const dataDir = await tempDir('native', 'run');
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
    // Every host read is attributed: recall included, since it reads the Provider.
    const headers = { authorization: `Bearer ${token}`, 'x-mnemoweave-host': 'acceptance', 'content-type': 'application/json' };
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
      // Isolated acceptance mode owns its own state directory; it never opens the user's store.
      MNEMOWEAVE_STATE_DIR: resolve(dataDir, 'state'),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    } });
    const client = new Client({ name: 'mnemoweave-acceptance', version: '0.1.0' });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      // The general MCP surface: reads plus a candidate submission. A standalone acceptance app
      // has a candidate store, so both are registered; neither can publish.
      for (const name of ['recall', 'read_memory', 'remember', 'candidate_status', 'provider_health', 'read_conflict']) {
        assert.ok(tools.tools.some(tool => tool.name === name), name);
      }
      assert.equal(tools.tools.some(tool => tool.name === 'memory_view'), false, 'the aggregate View is gone');
      const submitted = await client.callTool({
        name: 'remember',
        arguments: {
          idempotencyKey: `native-mcp-${Date.now()}`,
          content: 'MCP candidate: the acceptance store is isolated.',
          provenance: {
            source: 'e2e', sourceReference: 'native mcp', evidence: ['fixture'],
            verificationStatus: 'unverified', confidence: 0.5, applicability: 'acceptance only',
            limitations: 'test data', lastVerified: null,
          },
        },
      });
      // A candidate receipt, never a publication.
      const candidateBody = JSON.parse((submitted.content as { text: string }[])[0]!.text) as { status: string };
      assert.notEqual(candidateBody.status, 'persisted');
      const result = await client.callTool({ name: 'recall', arguments: { query: 'MnemoWeave acceptance fixture', limit: 5 } });
      assert.notEqual(result.isError, true);
      const parts = result.content as { type: string; text?: string }[];
      const mcp = JSON.parse(parts[0]!.text!) as typeof http;
      // The standalone MCP owns its own state directory, so a record written straight to the
      // Provider is not in its catalog and is excluded rather than handed to the model.
      assert.equal(mcp.memories.some(memory => memory.id === first.id), false);
      await writeFile(join(dataDir, 'acceptance-result.json'), JSON.stringify({ first, duplicate, http, mcp }, null, 2));
    } finally { await client.close(); }
  } finally { await new Promise<void>((done, fail) => { server.closeAllConnections(); server.close(error => error ? fail(error) : done()); }); }
});
