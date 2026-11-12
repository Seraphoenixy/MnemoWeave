import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { MemoryClient } from '../../packages/client/src/index.ts';
import { createHttpServer } from '../../packages/protocols/http/src/index.ts';
import { configure } from '../../apps/server/src/config.ts';
import { mnemonBinary } from '../e2e/mnemon-binary.ts';

/**
 * Creating a memory publishes it directly.
 *
 * This is the one write path that skips candidate review: the user's own text is treated as
 * already-confirmed knowledge. It still has to behave like every other publication — Provider is
 * authoritative, the catalog records the revision and its classification, and the memory shows up
 * in the list and can be edited afterwards.
 */

const TOKEN = 'create-token-0123456789abcdef';
const OPERATOR = 'create-operator-0123456789';
const HOST = 'create-probe';

async function harness(): Promise<{ client: MemoryClient; close: () => Promise<void> }> {
  const root = resolve('work', 'create-memory', randomUUID());
  mkdirSync(join(root, 'provider'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  const app = configure({
    MNEMON_BINARY: mnemonBinary(), MNEMON_DATA_DIR: join(root, 'provider'), MNEMON_STORE: 'createmem',
    MNEMOWEAVE_STATE_DIR: join(root, 'state'), MNEMOWEAVE_PORT: '0',
    MNEMOWEAVE_TOKEN: TOKEN, MNEMOWEAVE_OPERATOR_TOKEN: OPERATOR,
    // Creation goes through the publisher, so it has to be running.
    MNEMOWEAVE_WORKER: 'on',
  } as NodeJS.ProcessEnv);
  const server: Server = createHttpServer(app.app, TOKEN, OPERATOR, app.client, app.storage);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    client: new MemoryClient({ baseUrl: base, token: TOKEN, hostId: HOST, timeoutMs: 30_000 }),
    close: async () => {
      await new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); });
      await app.close();
    },
  };
}

test('a created memory is published with its classification and can be edited', async () => {
  const { client, close } = await harness();
  try {
    const created = await client.createMemory({
      content: '用户直接新增的正文：MnemoWeave 的记忆页可以新建记忆。',
      category: 'decision',
      importance: 4,
      tags: ['新增', '界面'],
      entities: ['MnemoWeave'],
    });
    assert.equal(created.ok, true, created.ok ? '' : created.error.code);
    if (!created.ok) return;
    // A publication starts at base 0: the counter tracks confirmed edits, not publications.
    assert.equal(created.value.entryVersion, 0, 'a new memory sits at base 0');
    assert.match(created.value.contentHash, /^[a-f0-9]{64}$/);
    // The Provider id must be the real one: an empty string would satisfy no caller and reveals
    // that the mapping row does not exist yet for a fresh publication.
    assert.ok(created.value.providerMemoryId.length > 0, 'the Provider id is returned');
    assert.equal(created.value.revisionId.length, 36);

    // It is a formal memory from the first moment: listed, readable, with its classification.
    const list = await client.listMemories({ limit: 50 });
    assert.equal(list.ok, true);
    if (list.ok) {
      const row = list.value.items.find(item => item.memoryId === created.value.memoryId);
      assert.ok(row, 'the new memory is listed');
      assert.equal(row!.category, 'decision');
      assert.equal(row!.importance, 4);
      assert.deepEqual(row!.tags, ['新增', '界面']);
      assert.deepEqual(row!.entities, ['MnemoWeave']);
      assert.equal(row!.entryVersion, 0);
    }

    const detail = await client.readMemory(created.value.memoryId);
    assert.equal(detail.ok, true);
    if (detail.ok) {
      assert.equal(detail.value.content, '用户直接新增的正文：MnemoWeave 的记忆页可以新建记忆。', 'the Provider serves exactly what was written');
      assert.equal((detail.value.revisions as unknown[]).length, 1);
      assert.equal(detail.value.state, 'active');
    }

    // And it behaves like any other memory: it can be edited from where it started.
    const edited = await client.editMemory(created.value.memoryId, { content: '新增后又被编辑的正文。', entryVersion: created.value.entryVersion });
    assert.equal(edited.ok, true);
    if (!edited.ok) return;
    assert.equal(edited.value.entryVersion, created.value.entryVersion + 1);

    const metadataEdit = await client.editMemory(created.value.memoryId, {
      content: '新增后又被编辑的正文。', entryVersion: edited.value.entryVersion, tags: ['排障'],
    });
    assert.equal(metadataEdit.ok, true);
    if (!metadataEdit.ok) return;
    assert.equal(metadataEdit.value.entryVersion, edited.value.entryVersion + 1);
    assert.equal(metadataEdit.value.providerMemoryId, edited.value.providerMemoryId);
    const updated = await client.listMemories({ limit: 50 });
    assert.equal(updated.ok, true);
    if (!updated.ok) return;
    assert.deepEqual(updated.value.items[0]?.tags, ['排障']);
    assert.deepEqual(updated.value.items[0]?.entities, ['MnemoWeave']);
  } finally { await close(); }
});

test('a created memory is reachable from the one memory list', async () => {
  const { client, close } = await harness();
  try {
    const created = await client.createMemory({ content: '正文。', category: 'fact' });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    // There is no project dimension to filter by: the created memory is simply in the list.
    const listed = await client.listMemories({ limit: 50 });
    assert.equal(listed.ok, true);
    if (listed.ok) assert.ok(listed.value.items.some(item => item.memoryId === created.value.memoryId));
  } finally { await close(); }
});

test('creation refuses invalid input before publishing anything', async () => {
  const { client, close } = await harness();
  try {
    for (const input of [
      { content: '   ', category: 'fact' },
      { content: 'x', scope: 'project' as const },
      { content: 'x', importance: 9 },
      { content: 'x', category: 'nonsense' },
      // The removed dimension is refused as an unknown field, not silently ignored.
      { content: 'x', knowledgeType: 'Practice' },
    ]) {
      const result = await client.createMemory(input as never);
      assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(input)}`);
      if (!result.ok) assert.equal(result.error.code, 'INVALID_INPUT');
    }
    const list = await client.listMemories({ limit: 50 });
    if (list.ok) assert.equal(list.value.items.length, 0, 'nothing was published by a rejected request');
  } finally { await close(); }
});
