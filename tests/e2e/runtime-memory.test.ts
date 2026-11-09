import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer, stopProcess, testHostHeaders, TEST_HOST, until } from '../support/server.ts';
import type { CandidateRecord, ViewRecord } from '../../packages/core/contracts/src/index.ts';

test('Real Mnemon + Server + ZCode hook process + MCP proxy deliver resident and ongoing task memory', { timeout: 60000 }, async () => {
  await mkdir('work/e2e', { recursive: true });
  const root = await mkdtemp(resolve('work/e2e/runtime-flow-'));
  const env = {
    MNEMON_BINARY: process.env.MNEMON_BINARY ?? resolve('work/tools/mnemon/mnemon.exe'), MNEMON_DATA_DIR: join(root, 'provider'), MNEMON_STORE: 'acceptance',
    MNEMOWEAVE_STATE_DIR: join(root, 'state'), MNEMOWEAVE_PORT: '0', MNEMOWEAVE_TOKEN: 'runtime-flow-master-0123456789', MNEMOWEAVE_OPERATOR_TOKEN: 'runtime-flow-operator-0123456789',
  };
  const server = await startServer(env);
  const headers = testHostHeaders(env.MNEMOWEAVE_TOKEN);
  const operator = { authorization: `Bearer ${env.MNEMOWEAVE_OPERATOR_TOKEN}`, 'content-type': 'application/json' };
  const post = (path: string, body: unknown, auth: Record<string, string> = headers) => fetch(`${server.url}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  let client: Client | undefined;
  let bridge: ChildProcess | undefined;
  try {
    assert.equal((await post('/v1/runtime/projects', { projectId: 'registered-runtime-project' }, operator)).status, 200);
    const submission = await post('/v1/remember', { idempotencyKey: 'runtime-resident-001', content: 'Runtime acceptance: always use the isolated acceptance store.', knowledgeType: 'Constraint', scope: 'project', projectId: 'registered-runtime-project', provenance: { source: 'e2e', sourceReference: 'isolated runtime scenario', evidence: ['fixture only'], verificationStatus: 'unverified', confidence: 0.5, applicability: 'runtime acceptance only', limitations: 'test data', lastVerified: null } });
    assert.equal(submission.status, 202);
    const candidate = await submission.json() as CandidateRecord;
    const readCandidate = async () => await (await fetch(`${server.url}/v1/candidates/${candidate.id}`, { headers })).json() as CandidateRecord;
    await until(readCandidate, item => item.status === 'needs_review');
    assert.equal((await post('/v1/review', { candidateId: candidate.id, decision: 'approve', reason: 'isolated test operator' }, operator)).status, 200);
    const published = await until(readCandidate, item => item.status === 'persisted');
    assert.equal((await post('/v1/runtime/pins', { memoryId: published.publication!.memoryId, scope: 'project', projectId: 'registered-runtime-project', tier: 'critical' }, operator)).status, 200);
    const hook = async (event: string, prompt?: string, adapter = 'zcode') => new Promise<string>((done, fail) => {
      const child = execFile(process.execPath, [`packages/adapters/${adapter}/src/hook-main.ts`], { cwd: resolve('.'), windowsHide: true, timeout: 6000, env: { ...process.env, MNEMOWEAVE_SERVER: server.url, MNEMOWEAVE_TOKEN: headers.authorization.slice(7), MNEMOWEAVE_BRIDGE_HOST_ID: TEST_HOST, MNEMOWEAVE_PROJECT_ID: 'registered-runtime-project', MNEMOWEAVE_CHATGPT_MODE: 'local-only' } }, (error, stdout, stderr) => error ? fail(error) : !stdout && event === 'SessionStart' ? fail(new Error(stderr || 'No SessionStart context')) : done(stdout));
      child.stdin!.end(JSON.stringify({ session_id: adapter === 'chatgpt' ? 'chatgpt-hook-session' : 'real-hook-session', hook_event_name: event, ...(prompt ? { prompt } : {}) }));
    });
    const start = JSON.parse(await hook('SessionStart')) as { additionalContext: string };
    assert.match(start.additionalContext, /always use the isolated acceptance store/);
    assert.match(start.additionalContext, /candidate/);
    const chatgptStart = JSON.parse(await hook('SessionStart', undefined, 'chatgpt')) as { hookSpecificOutput: { additionalContext: string } };
    assert.match(chatgptStart.hookSpecificOutput.additionalContext, /always use the isolated acceptance store/);
    await hook('SessionEnd', undefined, 'chatgpt');
    assert.equal((await post('/v1/view', { sessionId: 'chatgpt-hook-session' })).status, 409);
    await hook('UserPromptSubmit', 'Build the isolated revision migration');
    await hook('UserPromptSubmit', '继续');
    client = new Client({ name: 'runtime-proxy-acceptance', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['apps/server/src/mcp-main.ts'], cwd: resolve('.'), env: { MNEMOWEAVE_SERVER: server.url, MNEMOWEAVE_TOKEN: headers.authorization.slice(7), MNEMOWEAVE_BRIDGE_HOST_ID: TEST_HOST, MNEMOWEAVE_SESSION_ID: 'real-hook-session', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } }));
    const result = await client.callTool({ name: 'memory_view', arguments: { sessionId: 'real-hook-session', query: '继续' } });
    assert.notEqual(result.isError, true);
    const view = JSON.parse((result.content as { text: string }[])[0]!.text) as ViewRecord;
    const foreignSession = await client.callTool({ name: 'runtime_context', arguments: { sessionId: 'another-session' } });
    assert.equal(foreignSession.isError, true);
    assert.match(view.runtime!.task!, /revision migration/);
    assert.ok(view.memories.some(memory => memory.memoryId === published.publication!.memoryId));
    const secondGrant = await (await post('/v1/sync/grant', { hostId: 'second-runtime-host', projects: ['other-project'], globalIncluded: false }, operator)).json() as { credential: string };
    const portProbe = createServer();
    await new Promise<void>(done => portProbe.listen(0, '127.0.0.1', done));
    const bridgePort = (portProbe.address() as { port: number }).port;
    await new Promise<void>((done, fail) => portProbe.close(error => error ? fail(error) : done()));
    bridge = spawn(process.execPath, ['apps/bridge/src/main.ts'], { cwd: resolve('.'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, MNEMOWEAVE_SERVER: server.url, MNEMOWEAVE_BRIDGE_DIR: join(root, 'bridge'), MNEMOWEAVE_BRIDGE_PORT: String(bridgePort), MNEMOWEAVE_BRIDGE_HOSTS: JSON.stringify([{ hostId: TEST_HOST, token: headers.authorization.slice(7) }, { hostId: 'second-runtime-host', token: secondGrant.credential }]) } });
    const inject = async (hostId: string, token: string, projectId: string) => {
      try { return await fetch(`http://127.0.0.1:${bridgePort}/v1/inject`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-mnemoweave-host': hostId, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'same-id-across-hosts', turnId: '1', trigger: 'session_started', projectId }) }); }
      catch { return undefined; }
    };
    const local = await until(async () => {
      const response = await inject(TEST_HOST, headers.authorization.slice(7), 'registered-runtime-project');
      return response?.ok ? await response.json() as { usedLocalReplica: boolean; text?: string } : undefined;
    }, value => value?.usedLocalReplica === true);
    assert.match(local!.text!, /always use the isolated acceptance store/);
    const other = await until(async () => {
      const response = await inject('second-runtime-host', secondGrant.credential, 'other-project');
      return response?.ok ? await response.json() as { status: string; text?: string } : undefined;
    }, value => value?.status === 'injected');
    assert.equal(other!.text?.includes('always use the isolated acceptance store'), false);
    assert.equal((await inject('second-runtime-host', headers.authorization.slice(7), 'other-project'))!.status, 401);
    // Changing only the Host header cannot borrow another Host's identity.
    assert.equal((await fetch(`${server.url}/v1/recall`, { method: 'POST', headers: { ...headers, 'x-mnemoweave-host': 'another-host' }, body: JSON.stringify({ query: 'runtime' }) })).status, 401);
    await stopProcess(server.child);
    const offlineEvent = await fetch(`http://127.0.0.1:${bridgePort}/v1/events`, { method: 'POST', headers, body: JSON.stringify({ protocolVersion: '1', adapterVersion: 'test', eventId: 'offline-user-event-001', sessionId: 'same-id-across-hosts', projectId: 'registered-runtime-project', kind: 'message.user', occurredAt: new Date().toISOString(), receivedAt: new Date().toISOString(), sourceRef: 'isolated offline fixture', payload: { text: 'Continue the migration while offline.' } }) });
    assert.equal(offlineEvent.status, 202);
    const offline = await (await inject(TEST_HOST, headers.authorization.slice(7), 'registered-runtime-project'))!.json() as { status: string; usedLocalReplica: boolean; text: string };
    assert.equal(offline.status, 'injected');
    assert.equal(offline.usedLocalReplica, true);
    assert.match(offline.text, /Continue the migration while offline/);
    assert.match(offline.text, /always use the isolated acceptance store/);
  } finally { await client?.close(); if (bridge) await stopProcess(bridge); await stopProcess(server.child); }
});
