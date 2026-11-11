import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpServer } from '../../packages/protocols/http/src/index.ts';

/**
 * Who may write a runtime rule.
 *
 * A rule is a user write, like a formal memory: the service token plus a declared Host is the
 * whole identity model, and the audit trail attributes the change to that Host. The second
 * credential was removed for memory edits on 2026-11-11 (single-user deployment); rules now follow
 * the same boundary, while archives and management routes keep the operator token.
 *
 * The edit path carries `baseVersion`: the version the editor was opened at. The HTTP layer only
 * forwards it; the Server refuses a stale value with VERSION_CONFLICT, which the page surfaces.
 */

const TOKEN = 't'.repeat(32);
const OPERATOR = 'o'.repeat(32);
const HOST = 'host-rule-probe';
const RULE_ID = '11111111-2222-3333-4444-555555555555';

interface Calls { created: unknown[]; edited: { ruleId: string; input: unknown }[] }

async function harness(): Promise<{ calls: Calls; base: string; close: () => Promise<void> }> {
  const calls: Calls = { created: [], edited: [] };
  const app = {
    health: async () => ({ ready: true as const, version: '0' }),
  } as unknown as Parameters<typeof createHttpServer>[0];
  const client = {
    rules: async () => ({ items: [] }),
    createRule: async (input: unknown) => {
      calls.created.push(input);
      return { entryId: RULE_ID, body: 'rule body', enabled: true, version: 1, withdrawnAt: null };
    },
    editRule: async (ruleId: string, input: unknown) => {
      calls.edited.push({ ruleId, input });
      return { entryId: ruleId, body: 'rule body v2', enabled: false, version: 2, withdrawnAt: null };
    },
  } as unknown as Parameters<typeof createHttpServer>[3];
  const server: Server = createHttpServer(app, TOKEN, OPERATOR, client);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { calls, base, close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }) };
}

const json = { 'content-type': 'application/json', connection: 'close' } as const;

test('the service token plus a Host header may publish and edit a rule', async () => {
  const { calls, base, close } = await harness();
  try {
    const created = await fetch(`${base}/v1/rules`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': HOST, ...json },
      body: JSON.stringify({ body: '  提交前必须运行类型检查。  ' }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(calls.created[0], { body: '提交前必须运行类型检查。', enabled: true, importance: 'normal', pinned: false });

    const edited = await fetch(`${base}/v1/rules/${RULE_ID}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': HOST, ...json },
      body: JSON.stringify({ body: '新的准则正文', enabled: false, baseVersion: 1 }),
    });
    assert.equal(edited.status, 200);
    assert.equal(calls.edited.length, 1);
    assert.equal(calls.edited[0]?.ruleId, RULE_ID);
    assert.deepEqual(calls.edited[0]?.input, { body: '新的准则正文', enabled: false, baseVersion: 1 }, 'the base version reaches the Server');
  } finally { await close(); }
});

test('a rule write without a Host header is refused and never reaches the store', async () => {
  const { calls, base, close } = await harness();
  try {
    const created = await fetch(`${base}/v1/rules`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, ...json },
      body: JSON.stringify({ scope: 'global', body: '无来源的写入' }),
    });
    assert.equal(created.status, 401);
    assert.equal((await created.json() as { code: string }).code, 'UNAUTHORIZED');

    const edited = await fetch(`${base}/v1/rules/${RULE_ID}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${TOKEN}`, ...json },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(edited.status, 401);
    assert.equal(calls.created.length, 0);
    assert.equal(calls.edited.length, 0);
  } finally { await close(); }
});

test('the operator may write without a Host; a wrong token may not, whatever Host it claims', async () => {
  const { calls, base, close } = await harness();
  try {
    const operator = await fetch(`${base}/v1/rules`, {
      method: 'POST',
      headers: { authorization: `Bearer ${OPERATOR}`, ...json },
      body: JSON.stringify({ body: '管理端写入' }),
    });
    assert.equal(operator.status, 201);
    assert.equal(calls.created.length, 1);

    const unknown = await fetch(`${base}/v1/rules`, {
      method: 'POST',
      headers: { authorization: `Bearer ${'x'.repeat(32)}`, 'x-mnemoweave-host': HOST, ...json },
      body: JSON.stringify({ body: '冒名写入' }),
    });
    assert.equal(unknown.status, 401);
    assert.equal(calls.created.length, 1, 'an unknown token must not reach the store');
  } finally { await close(); }
});

test('an invalid rule request is rejected before the store is touched', async () => {
  const { calls, base, close } = await harness();
  try {
    const cases: unknown[] = [
      { body: '   ' },
      {},
      { body: '合法正文', enabled: 'yes' },
    ];
    for (const payload of cases) {
      const response = await fetch(`${base}/v1/rules`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': HOST, ...json },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 400, `${JSON.stringify(payload)} must be refused`);
    }
    const badVersion = await fetch(`${base}/v1/rules/${RULE_ID}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': HOST, ...json },
      body: JSON.stringify({ enabled: false, baseVersion: -1 }),
    });
    assert.equal(badVersion.status, 400);
    const emptyEdit = await fetch(`${base}/v1/rules/${RULE_ID}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-mnemoweave-host': HOST, ...json },
      body: JSON.stringify({}),
    });
    assert.equal(emptyEdit.status, 400);
    assert.equal(calls.created.length, 0);
    assert.equal(calls.edited.length, 0);
  } finally { await close(); }
});
