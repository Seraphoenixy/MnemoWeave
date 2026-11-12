import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { configure } from '../../apps/server/src/config.ts';
import { createHttpServer } from '../../packages/protocols/http/src/index.ts';
import { MnemoWeaveError } from '../../packages/core/contracts/src/index.ts';
import { mnemonBinary } from './mnemon-binary.ts';

/**
 * 档案提炼：a draft fixes the source version, the confirmation publishes that fixed text, and a
 * source edited between preview and confirmation is refused instead of publishing stale content.
 */

const TOKEN = 'host-token-0123456789abcdef';
const OPERATOR = 'operator-token-0123456789abcdef';
const HOST = 'distill-probe';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';

test('a distilled draft publishes its fixed text and refuses a stale source', { timeout: 120_000 }, async () => {
  const dir = resolve('work', 'archive-distill', randomUUID());
  mkdirSync(join(dir, 'provider'), { recursive: true });
  mkdirSync(join(dir, 'state'), { recursive: true });
  const app = configure({
    MNEMON_BINARY: mnemonBinary(), MNEMON_DATA_DIR: join(dir, 'provider'), MNEMON_STORE: 'distill',
    MNEMOWEAVE_STATE_DIR: join(dir, 'state'), MNEMOWEAVE_PORT: '0',
    MNEMOWEAVE_TOKEN: TOKEN, MNEMOWEAVE_OPERATOR_TOKEN: OPERATOR,
  });
  const server: Server = createHttpServer(app.app, TOKEN, OPERATOR, app.client!, app.storage);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hostHeaders = { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': HOST, 'content-type': 'application/json' };
  const operatorHeaders = { authorization: `Bearer ${OPERATOR}`, 'content-type': 'application/json' };
  const call = async (method: string, path: string, body: unknown, headers: Record<string, string> = hostHeaders) => {
    const response = await fetch(`${base}${path}`, {
      method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> };
  };
  try {
    // A registered workspace, then one published archive.
    assert.equal((await call('POST', '/v1/workspaces', { workspaceId: WORKSPACE, name: 'distill workspace' }, operatorHeaders)).status, 201);
    const created = await call('POST', '/v1/archives', {
      workspaceId: WORKSPACE, title: '串口排查记录', body: '原始正文：9600 波特率在长线缆上丢包，改为 115200 后稳定。本地路径 C:/work/port。',
      source: 'user', verification: 'open', evidence: '实测',
    });
    assert.equal(created.status, 201);
    const archive = created.body as { entryId: string; version: number };
    const sourceText = '原始正文：9600 波特率在长线缆上丢包，改为 115200 后稳定。本地路径 C:/work/port。';
    const sourceHash = createHash('sha256').update(sourceText, 'utf8').digest('hex');

    // A draft fixes the source version and hash.
    const draftResponse = await call('POST', '/v1/archive-distillations', {
      source: { workspaceId: WORKSPACE, entryId: archive.entryId, entryVersion: archive.version, contentHash: sourceHash },
      content: '长线缆串口在 9600 波特率下会丢包，提到 115200 后稳定。',
      knowledgeType: 'Troubleshooting', category: 'decision', importance: 4,
      reason: '可跨项目复用的排查结论', assessment: 'supported',
    });
    assert.equal(draftResponse.status, 201);
    const draft = draftResponse.body as { draftId: string; contentHash: string };
    assert.equal((await call('GET', `/v1/archive-distillations/${draft.draftId}`, undefined)).status, 200);

    // Confirming publishes the draft text once. The draft id is the task id.
    const taskId = draft.draftId;
    const confirm = await call('POST', `/v1/memory-write-tasks/${taskId}/actions/0`, {
      kind: 'formal-memory', trigger: 'archive-distill', action: 'create', draftId: draft.draftId,
      reason: '用户确认共享提炼结果', evidenceRefs: [`confirm:${draft.draftId}`], assessment: 'supported',
    });
    assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
    const receipt = confirm.body as { status: string; memoryId: string; entryVersion: number };
    assert.equal(receipt.status, 'published');
    const memory = await call('GET', `/v1/memories/${receipt.memoryId}`, undefined);
    assert.equal(memory.status, 200);
    assert.match(JSON.stringify(memory.body), /长线缆串口在 9600 波特率下会丢包/);
    // The source archive keeps its own version and text.
    const archives = await call('GET', `/v1/archives?workspaceId=${WORKSPACE}`, undefined, operatorHeaders);
    const listed = (archives.body as { items: Array<{ entryId: string; version: number; body: string }> }).items
      .find(item => item.entryId === archive.entryId)!;
    assert.equal(listed.version, archive.version);
    assert.equal(listed.body, sourceText);

    // A retry of the same action returns the original receipt instead of publishing again.
    const replay = await call('POST', `/v1/memory-write-tasks/${taskId}/actions/0`, {
      kind: 'formal-memory', trigger: 'archive-distill', action: 'create', draftId: draft.draftId,
      reason: '用户确认共享提炼结果', evidenceRefs: [`confirm:${draft.draftId}`], assessment: 'supported',
    });
    assert.equal(replay.status, 200);
    assert.equal((replay.body as { memoryId: string }).memoryId, receipt.memoryId);

    // A source edited after the preview no longer matches the fixed version.
    const second = await call('POST', '/v1/archives', {
      workspaceId: WORKSPACE, title: '第二篇记录', body: '第二版正文。', source: 'user', verification: 'open', evidence: 'x',
    });
    assert.equal(second.status, 201);
    const secondArchive = second.body as { entryId: string; version: number };
    const staleDraft = await call('POST', '/v1/archive-distillations', {
      source: { workspaceId: WORKSPACE, entryId: secondArchive.entryId, entryVersion: secondArchive.version, contentHash: createHash('sha256').update('第二版正文。', 'utf8').digest('hex') },
      content: '可复用的第二条结论。', knowledgeType: 'Practice', reason: '可复用', assessment: 'supported',
    });
    assert.equal(staleDraft.status, 201);
    const staleId = (staleDraft.body as { draftId: string }).draftId;
    const edited = await call('PATCH', `/v1/archives/${secondArchive.entryId}`, {
      title: '第二篇记录', body: '编辑后的正文。', verification: 'open', evidence: 'x', baseVersion: secondArchive.version,
    }, operatorHeaders);
    assert.equal(edited.status, 200);
    const refused = await call('POST', `/v1/memory-write-tasks/${staleId}/actions/0`, {
      kind: 'formal-memory', trigger: 'archive-distill', action: 'create', draftId: staleId,
      reason: '用户确认', evidenceRefs: [`confirm:${staleId}`], assessment: 'supported',
    });
    assert.equal(refused.status, 409);
    assert.equal((refused.body as { code: string }).code, 'VERSION_CONFLICT');
    // A draft from another Host is not readable.
    const foreign = await fetch(`${base}/v1/archive-distillations/${draft.draftId}`, {
      headers: { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': 'another-host' },
    });
    assert.equal(foreign.status, 404);
  } finally {
    await new Promise<void>((done, fail) => { server.closeAllConnections(); server.close(error => error ? fail(error) : done()); });
    await app.close();
  }
});

void MnemoWeaveError;
