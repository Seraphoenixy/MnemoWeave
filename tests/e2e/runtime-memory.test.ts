import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer, stopProcess, testHostHeaders, TEST_HOST, until } from '../support/server.ts';
import type { CandidateRecord, InjectionRecord } from '../../packages/core/contracts/src/index.ts';
import { mnemonBinary } from './mnemon-binary.ts';
import { tempDir } from '../support/temp.ts';

/**
 * Real Mnemon + Server + ZCode hook process + MCP proxy. What the model receives per turn is the
 * resident rule set; formal memory is reached through the recall tool, not through the injection.
 */
test('Real Mnemon + Server + ZCode hook process + MCP proxy deliver resident rules and reachable memory', { timeout: 60000 }, async () => {
  await mkdir('work/e2e', { recursive: true });
  const root = await tempDir('runtime-memory', 'runtime-flow');
  const env = {
    MNEMON_BINARY: mnemonBinary(), MNEMON_DATA_DIR: join(root, 'provider'), MNEMON_STORE: 'acceptance',
    MNEMOWEAVE_STATE_DIR: join(root, 'state'), MNEMOWEAVE_PORT: '0',
    MNEMOWEAVE_TOKEN: 'runtime-flow-master-0123456789', MNEMOWEAVE_OPERATOR_TOKEN: 'runtime-flow-operator-0123456789',
  };
  const server = await startServer(env);
  const headers = testHostHeaders(env.MNEMOWEAVE_TOKEN);
  const operator = { authorization: `Bearer ${env.MNEMOWEAVE_OPERATOR_TOKEN}`, 'content-type': 'application/json' };
  const post = (path: string, body: unknown, auth: Record<string, string> = headers) => fetch(`${server.url}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  let client: Client | undefined;
  try {
    // A rule is the only text injected. It is stored once and delivered whole to every session.
    const ruleWrite = await post('/v1/rules', { body: '验收环境一律使用隔离的 acceptance 存储。' });
    assert.equal(ruleWrite.status, 201);

    const submission = await post('/v1/remember', {
      idempotencyKey: 'runtime-resident-001',
      content: 'Runtime acceptance: always use the isolated acceptance store.',
      provenance: {
        source: 'e2e', sourceReference: 'isolated runtime scenario', evidence: ['fixture only'],
        verificationStatus: 'unverified', confidence: 0.5, applicability: 'runtime acceptance only',
        limitations: 'test data', lastVerified: null,
      },
    });
    assert.equal(submission.status, 202);
    const candidate = await submission.json() as CandidateRecord;
    const readCandidate = async () => await (await fetch(`${server.url}/v1/candidates/${candidate.id}`, { headers })).json() as CandidateRecord;
    await until(readCandidate, item => item.status === 'needs_review');
    assert.equal((await post('/v1/review', { candidateId: candidate.id, decision: 'approve', reason: 'isolated test operator' }, operator)).status, 200);
    const published = await until(readCandidate, item => item.status === 'persisted');
    const memoryId = published.publication!.memoryId;

    const hook = async (event: string, prompt?: string, adapter = 'zcode') => new Promise<string>((done, fail) => {
      const child = execFile(process.execPath, [`packages/adapters/${adapter}/src/hook-main.ts`], {
        cwd: resolve('.'), windowsHide: true, timeout: 6000,
        env: {
          ...process.env, MNEMOWEAVE_SERVER: server.url, MNEMOWEAVE_TOKEN: headers.authorization.slice(7),
          MNEMOWEAVE_HOST_ID: TEST_HOST, MNEMOWEAVE_CHATGPT_MODE: 'local-only',
        },
      }, (error, stdout, stderr) => error ? fail(error) : done(stdout || stderr));
      child.stdin!.end(JSON.stringify({ session_id: adapter === 'chatgpt' ? 'chatgpt-hook-session' : 'real-hook-session', hook_event_name: event, ...(prompt ? { prompt } : {}) }));
    });

    const start = JSON.parse(await hook('SessionStart')) as { additionalContext: string };
    assert.match(start.additionalContext, /验收环境一律使用隔离的 acceptance 存储/);
    // The injection names the rule set only; it does not carry formal memory.
    assert.doesNotMatch(start.additionalContext, /isolated acceptance store\./);
    const chatgptStart = JSON.parse(await hook('SessionStart', undefined, 'chatgpt')) as { hookSpecificOutput: { additionalContext: string } };
    assert.match(chatgptStart.hookSpecificOutput.additionalContext, /验收环境一律使用隔离的 acceptance 存储/);
    await hook('SessionEnd', undefined, 'chatgpt');
    await hook('UserPromptSubmit', 'Build the isolated revision migration');

    // A closed session keeps its last report readable but refuses a new injection.
    assert.equal((await post('/v1/inject', { sessionId: 'real-hook-session' })).status, 200);
    assert.equal((await post('/v1/session/close', { sessionId: 'real-hook-session' })).status, 200);
    const closed = await post('/v1/inject', { sessionId: 'real-hook-session' });
    assert.equal(closed.status, 409);
    assert.equal((await closed.json() as { code: string }).code, 'INVALID_STATE');

    // The MCP surface exposes the recall that replaces the aggregate View.
    client = new Client({ name: 'runtime-proxy-acceptance', version: '1' });
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: ['apps/server/src/mcp-main.ts'], cwd: resolve('.'),
      env: {
        MNEMOWEAVE_SERVER: server.url, MNEMOWEAVE_TOKEN: headers.authorization.slice(7),
        MNEMOWEAVE_HOST_ID: TEST_HOST, MNEMOWEAVE_SESSION_ID: 'real-hook-session',
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
    }));
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map(tool => tool.name).sort(),
      ['candidate_status', 'provider_health', 'read_conflict', 'read_memory', 'recall', 'remember'],
    );
    const result = await client.callTool({ name: 'recall', arguments: { query: 'isolated acceptance store' } });
    assert.notEqual(result.isError, true);
    const recalled = JSON.parse((result.content as { text: string }[])[0]!.text) as { memories: { memoryId: string; content: string }[] };
    assert.ok(recalled.memories.some(memory => memory.memoryId === memoryId), 'the published memory is reachable by recall');
    // A tool that no longer exists must not answer.
    assert.equal((await client.callTool({ name: 'memory_view', arguments: { sessionId: 'real-hook-session' } })).isError, true);
    assert.equal((await client.callTool({ name: 'runtime_context', arguments: { sessionId: 'another-session' } })).isError, true);

    // One service token for every host: the header names the caller, it grants nothing extra.
    const foreign = await fetch(`${server.url}/v1/recall`, {
      method: 'POST', headers: { ...headers, 'x-mnemoweave-host': 'another-host' }, body: JSON.stringify({ query: 'runtime' }),
    });
    assert.equal(foreign.status, 200, 'the service token is the only credential; the host header only names the caller');

    // A separate session sees the same rules, byte for byte.
    const otherSession = await post('/v1/inject', { sessionId: 'other-session' });
    assert.equal(otherSession.status, 200);
    const other = await otherSession.json() as InjectionRecord;
    const first = await (await post('/v1/inject', { sessionId: 'fresh-session' })).json() as InjectionRecord;
    assert.deepEqual(other.rules.map(rule => rule.body), first.rules.map(rule => rule.body));
    assert.equal(first.complete, true);
    assert.ok(first.usedBytes > 0 && first.usedBytes <= first.limitBytes);
  } finally { await client?.close(); await stopProcess(server.child); }
});
