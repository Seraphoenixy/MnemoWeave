import { testHostHeaders, pairTestHost, TEST_OPERATOR } from '../support/server.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RememberInput, SemanticAssessment } from '../../packages/core/contracts/src/index.ts';
import type { CandidateRecord } from '../../packages/core/contracts/src/index.ts';
import { MnemonCliProvider, createRunner } from '../../packages/providers/mnemon/src/index.ts';
import { startServer, stopProcess, until } from '../support/server.ts';

async function fixture() {
  await mkdir('work/e2e', { recursive: true });
  const root = await mkdtemp(resolve('work/e2e/reliable-'));
  let modelCalls = 0;
  const model = createServer(async (req, res) => {
    assert.equal(req.url, '/chat/completions');
    let body = ''; for await (const chunk of req) body += String(chunk);
    const payload = JSON.parse(body) as { model: string; messages: { role: string; content: string }[]; response_format: { type: string } };
    assert.equal(payload.model, 'fixture-semantic-reviewer'); assert.equal(payload.response_format.type, 'json_object');
    assert.ok(payload.messages[0]!.content.includes('UNTRUSTED DATA'));
    const candidate = JSON.parse(payload.messages[1]!.content).candidate as { content: string };
    const checks = Object.fromEntries(['source', 'accuracy', 'reuse', 'scope', 'duplication', 'consistency'].map(key => [key, { result: 'pass', reason: 'Local protocol fixture, not technical proof.' }]));
    const result = SemanticAssessment.parse({ checks, requiresHuman: false, conflict: 'none', summary: 'Deterministic test response; no real LLM quality claim.' });
    if (candidate.content.includes('[uncertain]')) result.checks.accuracy.result = 'uncertain';
    if (candidate.content.includes('[worthless]')) result.checks.reuse.result = 'fail';
    if (candidate.content.includes('[conflict]')) result.conflict = 'factual';
    modelCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: candidate.content.includes('[malformed]') ? 'invalid-json' : JSON.stringify(result) } }] }));
  });
  await new Promise<void>(done => model.listen(0, '127.0.0.1', done));
  const address = model.address(); assert.ok(address && typeof address === 'object');
  const env = {
    MNEMON_BINARY: process.env.MNEMON_BINARY ?? resolve('work/tools/mnemon/mnemon.exe'), MNEMON_DATA_DIR: join(root, 'provider'), MNEMON_STORE: 'milestone',
    MNEMOWEAVE_STATE_DIR: join(root, 'state'), MNEMOWEAVE_PORT: '0', MNEMOWEAVE_TOKEN: 'host-milestone-token-0123456789',
    MNEMOWEAVE_OPERATOR_TOKEN: 'operator-milestone-token-987654321',
    MNEMOWEAVE_MODEL_URL: `http://127.0.0.1:${address.port}/chat/completions`, MNEMOWEAVE_MODEL: 'fixture-semantic-reviewer', MNEMOWEAVE_WORKER: 'on',
  };
  const input = (name: string) => RememberInput.parse({
    idempotencyKey: `milestone-${name}`, content: `MnemoWeave milestone ${name}: test-only scoped engineering knowledge.`, knowledgeType: 'Practice',
    provenance: { source: 'local-fixture', sourceReference: `test:${name}`, evidence: ['automated fixture evidence'], verificationStatus: 'verified', confidence: 0.5, applicability: 'test fixture on Node24 Windows only', limitations: 'No real technical conclusion', lastVerified: '2026-11-08T00:00:00Z' },
  });
  return { root, env, input, calls: () => modelCalls, close: () => new Promise<void>((done, fail) => model.close(error => error ? fail(error) : done())) };
}

test('Milestone: HTTP/MCP submit, automatic and human review, real Mnemon writes, restart and receipts', { timeout: 60000 }, async () => {
  const f = await fixture(); let server = await startServer(f.env); let client: Client | undefined;
  const headers = testHostHeaders(f.env.MNEMOWEAVE_TOKEN);
  const operator = { ...headers, authorization: `Bearer ${f.env.MNEMOWEAVE_OPERATOR_TOKEN}` };
  const get = async (id: string) => await (await fetch(`${server.url}/v1/candidates/${id}`, { headers })).json() as CandidateRecord;
  const submit = async (input: unknown) => {
    const response = await fetch(`${server.url}/v1/remember`, { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal(response.status, 202); return await response.json() as CandidateRecord;
  };
  const review = (id: string, decision: string, extras = {}, h = operator) => fetch(`${server.url}/v1/review`, { method: 'POST', headers: h, body: JSON.stringify({ candidateId: id, decision, reason: 'Human operator fixture assessment', ...extras }) });
  try {
    const submitted = await submit(f.input('http-auto'));
    const first = await until(() => get(submitted.id), value => value.status === 'persisted');
    assert.ok(first.reviews.length); assert.equal(first.executionReceipts.length, 1);
    assert.equal((first.executionReceipts[0] as { status: string }).status, 'persisted');
    assert.ok(first.publication);
    const published = await fetch(`${server.url}/v1/memories/${first.publication.memoryId}`, { headers });
    assert.equal(published.status, 200);
    const publishedBody = await published.json() as { content: string; selectedRevisionId: string };
    assert.equal(publishedBody.content, first.request.content);
    assert.equal(publishedBody.selectedRevisionId, first.publication.revisionId);
    const { MNEMOWEAVE_OPERATOR_TOKEN: _operatorSecret, ...hostEnv } = f.env;
    const transport = new StdioClientTransport({ command: process.execPath, args: ['apps/server/src/mcp-main.ts'], cwd: resolve('.'), env: { MNEMOWEAVE_MCP_MODE: 'standalone', ...hostEnv, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } });
    client = new Client({ name: 'milestone', version: '0.1.0' }); await client.connect(transport);
    const tools = await client.listTools(); assert.ok(!tools.tools.some(tool => /review|approve|retry/.test(tool.name)));
    const readMemory = await client.callTool({ name: 'read_memory', arguments: first.publication });
    assert.notEqual(readMemory.isError, true);
    assert.equal(JSON.parse((readMemory.content as { text: string }[])[0]!.text).content, first.request.content);
    const submittedMcp = await client.callTool({ name: 'remember', arguments: f.input('mcp-auto') });
    assert.notEqual(submittedMcp.isError, true);
    const second = JSON.parse((submittedMcp.content as { text: string }[])[0]!.text) as CandidateRecord;
    await until(() => get(second.id), value => value.status === 'persisted');
    const mcpRecall = await client.callTool({ name: 'recall', arguments: { query: 'MnemoWeave milestone', limit: 20 } });
    assert.notEqual(mcpRecall.isError, true); assert.ok((mcpRecall.content as { text: string }[])[0]!.text.includes('http-auto'));
    const architecture = await submit({ ...f.input('human-architecture'), knowledgeType: 'Architecture' });
    await until(() => get(architecture.id), value => value.status === 'needs_review');
    assert.equal((await review(architecture.id, 'approve', {}, headers)).status, 401);
    assert.equal((await review(architecture.id, 'approve')).status, 200);
    await until(() => get(architecture.id), value => value.status === 'persisted');
    const uncertain = await submit({ ...f.input('uncertain'), content: 'MnemoWeave [uncertain] original evidence unclear.' });
    await until(() => get(uncertain.id), value => value.status === 'needs_review');
    assert.equal((await review(uncertain.id, 'reject')).status, 200);
    assert.equal((await get(uncertain.id)).status, 'rejected');
    const amended = await submit({ ...f.input('amend-original'), knowledgeType: 'Architecture' });
    await until(() => get(amended.id), value => value.status === 'needs_review');
    const amendedResponse = await review(amended.id, 'amend', { replacement: f.input('amend-corrected') });
    assert.equal(amendedResponse.status, 200);
    const replacement = await amendedResponse.json() as CandidateRecord;
    await until(() => get(replacement.id), value => value.status === 'persisted');
    assert.equal((await get(amended.id)).status, 'rejected');
    for (const name of ['conflict', 'malformed']) {
      const candidate = await submit({ ...f.input(name), content: `MnemoWeave [${name}] unresolved fixture` });
      await until(() => get(candidate.id), value => value.status === 'needs_review');
      if (name === 'conflict') assert.equal((await review(candidate.id, 'approve')).status, 409);
    }
    const worthless = await submit({ ...f.input('worthless'), content: 'MnemoWeave [worthless] ephemeral fixture' });
    await until(() => get(worthless.id), value => value.status === 'rejected');
    const duplicate = await submit({ ...f.input('http-auto'), idempotencyKey: 'milestone-duplicate-key' });
    await until(() => get(duplicate.id), value => value.status === 'rejected');
    assert.ok(f.calls() >= 6);
    await client.close(); client = undefined;
    await stopProcess(server.child); server = await startServer(f.env);
    assert.deepEqual(await get(first.id), first);
    const recall = await fetch(`${server.url}/v1/recall`, { method: 'POST', headers, body: JSON.stringify({ query: 'MnemoWeave milestone', limit: 20 }) });
    const memories = await recall.json() as { memories: { content: string }[] };
    assert.ok(memories.memories.some(memory => memory.content.includes('mcp-auto')));
    assert.ok(!memories.memories.some(memory => /\[conflict\]|\[uncertain\]|\[malformed\]/.test(memory.content)));
  } finally { await client?.close(); await stopProcess(server.child); await f.close(); }
});

test('Real process crash after Provider commit recovers the outbox without duplicate memory', { timeout: 40000 }, async () => {
  const f = await fixture(); let server = await startServer({ ...f.env, MNEMOWEAVE_WORKER: 'off' });
  let crashed: ReturnType<typeof spawn> | undefined;
  const headers = testHostHeaders(f.env.MNEMOWEAVE_TOKEN);
  try {
    const response = await fetch(`${server.url}/v1/remember`, { method: 'POST', headers, body: JSON.stringify(f.input('crash')) });
    assert.equal(response.status, 202); const candidate = await response.json() as CandidateRecord;
    await stopProcess(server.child);
    crashed = spawn(process.execPath, ['tests/support/crash-worker.ts'], { cwd: resolve('.'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...f.env } });
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error('Fault injection did not reach Provider commit')), 10000);
      crashed!.once('exit', code => { clearTimeout(timer); fail(new Error(`Worker exited ${code}`)); });
      crashed!.stdout!.on('data', chunk => { if (String(chunk).includes('PROVIDER_COMMITTED')) { clearTimeout(timer); done(); } });
    });
    await stopProcess(crashed); crashed = undefined;
    // The killed test worker has a 1s lease; wait for real expiry rather than editing production state.
    await new Promise(done => setTimeout(done, 1200));
    server = await startServer(f.env);
    const persisted = await until(async () => await (await fetch(`${server.url}/v1/candidates/${candidate.id}`, { headers })).json() as CandidateRecord, value => value.status === 'persisted');
    assert.equal((persisted.executionReceipts[0] as { reconciled: boolean }).reconciled, true);
    const run = createRunner(f.env.MNEMON_BINARY);
    const status = JSON.parse(await run(['--data-dir', f.env.MNEMON_DATA_DIR, '--store', f.env.MNEMON_STORE, 'status']));
    assert.equal(status.total_insights, 1);
    const provider = new MnemonCliProvider({ binary: f.env.MNEMON_BINARY, dataDir: f.env.MNEMON_DATA_DIR, store: f.env.MNEMON_STORE });
    assert.equal((await provider.inspectExact(candidate.request.content)).matches.length, 1);
    const inspect = new DatabaseSync(join(f.env.MNEMOWEAVE_STATE_DIR, 'governance.db'), { readOnly: true });
    try {
      assert.equal(inspect.prepare('SELECT count(*) n FROM governance_runs').get()!['n'], 2);
      assert.equal(inspect.prepare("SELECT count(*) n FROM governance_runs WHERE state='interrupted'").get()!['n'], 1);
    } finally { inspect.close(); }
  } finally { if (crashed) await stopProcess(crashed); await stopProcess(server.child); await f.close(); }
});

test('Operator-only HTTP retry resumes a failed real Provider task and preserves failed receipts', { timeout: 30000 }, async () => {
  const f = await fixture();
  const delayedBinary = join(f.root, process.platform === 'win32' ? 'delayed-mnemon.exe' : 'delayed-mnemon');
  const server = await startServer({ ...f.env, MNEMON_BINARY: delayedBinary });
  const headers = testHostHeaders(f.env.MNEMOWEAVE_TOKEN);
  const operator = { ...headers, authorization: `Bearer ${f.env.MNEMOWEAVE_OPERATOR_TOKEN}` };
  try {
    const response = await fetch(`${server.url}/v1/remember`, { method: 'POST', headers, body: JSON.stringify(f.input('retry')) });
    assert.equal(response.status, 202); const candidate = await response.json() as CandidateRecord;
    const get = async () => await (await fetch(`${server.url}/v1/candidates/${candidate.id}`, { headers })).json() as CandidateRecord;
    await until(get, value => value.status === 'needs_review');
    const approved = await fetch(`${server.url}/v1/review`, { method: 'POST', headers: operator, body: JSON.stringify({ candidateId: candidate.id, decision: 'approve', reason: 'Operator verified fixture; Provider availability is a separate concern.' }) });
    assert.equal(approved.status, 200);
    const failed = await until(get, value => value.status === 'failed');
    assert.equal(failed.executionReceipts[0]!.status, 'failed');
    const body = JSON.stringify({ candidateId: candidate.id, reason: 'Original invocation exited before a write; executable restored.', confirmNoActiveWrite: true });
    assert.equal((await fetch(`${server.url}/v1/retry`, { method: 'POST', headers, body })).status, 401);
    await copyFile(f.env.MNEMON_BINARY, delayedBinary);
    assert.equal((await fetch(`${server.url}/v1/retry`, { method: 'POST', headers: operator, body })).status, 202);
    const persisted = await until(get, value => value.status === 'persisted');
    assert.equal(persisted.task!.id, failed.task!.id);
    assert.ok(persisted.executionReceipts.some(receipt => receipt.status === 'failed'));
    assert.ok(persisted.executionReceipts.some(receipt => receipt.status === 'persisted'));
    assert.ok(persisted.executionReceipts.every(receipt => receipt.writeKey === failed.task!.write_key));
  } finally { await stopProcess(server.child); await f.close(); }
});
