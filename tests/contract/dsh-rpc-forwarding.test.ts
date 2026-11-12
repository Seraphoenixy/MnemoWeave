import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRpcHandler } from '../../plugins/dsh-mnemo-weave/src/ui/rpc.ts';
import type { MemorySource } from '../../plugins/dsh-mnemo-weave/src/ui/memory-source.ts';
import type { SettingsService } from '../../plugins/dsh-mnemo-weave/src/ui/settings.ts';

/**
 * Every validated field must reach the layer that uses it.
 *
 * A handler that validates a field and then forgets to forward it is worse than one that rejects
 * it: the request succeeds and the caller gets unfiltered data, so the control silently behaves as
 * if it matched everything. That is exactly what happened to the category, entity and sort
 * controls; this file makes the whole class of mistake fail loudly, once per endpoint.
 *
 * The stubs are proxies: any method the handler calls is recorded without being enumerated here,
 * so a new endpoint is covered the moment it exists.
 */

type Recorded = Record<string, unknown[]>;

const UUID = '11111111-1111-4111-8111-111111111111';
const REVISION = '22222222-2222-4222-8222-222222222222';

function recorder<T>(value: unknown = {}): { stub: T; calls: Recorded } {
  const calls: Recorded = {};
  const stub = new Proxy({}, {
    get: (_target, name: string) => async (...args: unknown[]) => {
      calls[name] = args;
      return value;
    },
  }) as unknown as T;
  return { stub, calls };
}

async function harness(): Promise<{
  rpc: (endpoint: string, payload?: unknown) => Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string } }>;
  source: Recorded;
  settings: Recorded;
}> {
  const source = recorder<MemorySource>();
  const settings = recorder<SettingsService>();
  // The handler is synchronous for the settings reads, so a promiseless return is fine there; the
  // proxy always returns a promise and `ok()` accepts it.
  const rpc = createRpcHandler(source.stub, settings.stub) as unknown as (
    endpoint: string,
    payload?: unknown,
  ) => Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string } }>;
  return { rpc, source: source.calls, settings: settings.calls };
}

test('the list request forwards every filter it validated', async () => {
  const { rpc, source } = await harness();
  const result = await rpc('memories', {
    limit: 20, cursor: 'abc',
    category: 'decision', entity: 'MnemoWeave', sort: 'importance', query: '关键词',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(source['memories']?.[0], {
    limit: 20, cursor: 'abc',
    category: 'decision', entity: 'MnemoWeave', sort: 'importance', query: '关键词',
  });
});

test('the detail, edit, withdraw, graph and explore requests forward their fields', async () => {
  const { rpc, source } = await harness();

  await rpc('memory', { memoryId: UUID, revisionId: REVISION });
  assert.deepEqual(source['memory'], [UUID, REVISION], 'a historical read keeps the revision');

  await rpc('create', {
    content: '新记忆的正文', category: 'decision', importance: 4,
    tags: ['a'], entities: ['MnemoWeave'], reason: '理由',
  });
  assert.deepEqual(source['create']?.[0], {
    content: '新记忆的正文', category: 'decision', importance: 4,
    tags: ['a'], entities: ['MnemoWeave'], reason: '理由',
  }, 'a new memory keeps every field');

  await rpc('edit', { memoryId: UUID, content: '新正文', entryVersion: 3, reason: '理由', category: 'decision', importance: 4, tags: ['a'] });
  assert.deepEqual(source['edit']?.[0], {
    memoryId: UUID, content: '新正文', entryVersion: 3, reason: '理由', category: 'decision', importance: 4, tags: ['a'],
  }, 'classification on an edit is not dropped');

  await rpc('withdraw', { memoryId: UUID, reason: '撤回原因', entryVersion: 4 });
  assert.deepEqual(source['withdraw']?.[0], { memoryId: UUID, reason: '撤回原因', entryVersion: 4 });

  await rpc('graph', { limit: 120 });
  assert.deepEqual(source['graph']?.[0], { limit: 120 }, 'the node cap is the graph\'s only argument');

  await rpc('explore', { query: '语义检索', limit: 15, minScore: 0.4 });
  assert.deepEqual(source['explore']?.[0], { query: '语义检索', limit: 15, minScore: 0.4 }, 'the score floor reaches the source');
});

test('rule writes forward every validated field, including the base version', async () => {
  const { rpc, source } = await harness();

  await rpc('createRule', { body: '  提交前必须运行类型检查。  ', enabled: false });
  assert.deepEqual(source['createRule']?.[0], {
    body: '提交前必须运行类型检查。', enabled: false,
  }, 'the body is trimmed and the enabled flag is kept');

  await rpc('editRule', { ruleId: UUID, body: '新的准则', enabled: true, baseVersion: 2 });
  assert.deepEqual(source['editRule'], [UUID, { body: '新的准则', enabled: true, baseVersion: 2 }], 'the base version reaches the source');
});

test('each settings request forwards only the fields it owns', async () => {
  const { rpc, settings } = await harness();

  await rpc('saveInterface', { defaultTab: 'memories', pageSize: 40 });
  assert.deepEqual(settings['saveInterface']?.[0], { defaultTab: 'memories', pageSize: 40 });

  await rpc('saveInjection', { injectTimeoutMs: 2500 });
  assert.deepEqual(settings['saveInjection']?.[0], { injectTimeoutMs: 2500 });

  await rpc('saveAutoStart', { enabled: true });
  assert.deepEqual(settings['saveAutoStart']?.[0], { enabled: true });

  await rpc('saveConnection', { serverUrl: 'http://127.0.0.1:4400', hostId: 'dsh' });
  assert.deepEqual(settings['saveConnection']?.[0], { serverUrl: 'http://127.0.0.1:4400', hostId: 'dsh' });

  await rpc('testConnection', { serverUrl: 'http://127.0.0.1:4400' });
  assert.deepEqual(settings['testConnection']?.[0], { serverUrl: 'http://127.0.0.1:4400' });

  await rpc('testWake', { serverUrl: 'http://127.0.0.1:4400' });
  assert.deepEqual(settings['testWake']?.[0], { baseUrl: 'http://127.0.0.1:4400' }, 'the wake probe gets the address it must reach');
});

test('a rejected request forwards nothing at all', async () => {
  const { rpc, source, settings } = await harness();
  for (const [endpoint, payload] of [
    ['memories', { limit: 0 }],
    ['memories', { sort: 'sideways' }],
    ['graph', { limit: 900 }],
    ['explore', { query: '' }],
    ['create', { content: '' }],
    ['create', { content: 'x', category: 'nope' }],
    // The removed field is still refused rather than silently ignored.
    ['create', { content: 'x', knowledgeType: 'Practice' }],
    ['create', { content: 'x', importance: 9 }],
    ['edit', { memoryId: UUID, content: '', entryVersion: 0 }],
    ['withdraw', { memoryId: UUID, reason: '   ', entryVersion: 0 }],
    ['createRule', { body: '   ' }],
    ['createRule', { body: 'x'.repeat(4001) }],
    ['editRule', { ruleId: 'not-a-uuid', enabled: false }],
    ['editRule', { ruleId: UUID }],
    ['editRule', { ruleId: UUID, enabled: false, baseVersion: -1 }],
    ['saveAutoStart', { enabled: 'yes' }],
  ] as const) {
    const result = await rpc(endpoint, payload);
    assert.equal(result.ok, false, `${endpoint} should have rejected ${JSON.stringify(payload)}`);
  }
  assert.deepEqual(source, {}, 'a rejected request never reaches the memory source');
  assert.deepEqual(settings, {}, 'a rejected request never reaches the settings service');
});

test('the registration action is forwarded and unavailable without the settings service', async () => {
  const { rpc, settings } = await harness();
  const registered = await rpc('registerTask', {});
  assert.equal(registered.ok, true);
  assert.deepEqual(settings['registerTask'], [], 'the action takes no request fields');

  const source = recorder<MemorySource>();
  const handler = createRpcHandler(source.stub) as unknown as (
    endpoint: string,
    payload?: unknown,
  ) => Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string } }>;
  const missing = await handler('registerTask', {});
  assert.equal(missing.ok, false);
  assert.equal(missing.ok ? '' : missing.error.code, 'PROVIDER_UNAVAILABLE');
  assert.deepEqual(source.calls, {}, 'registration never touches the memory source');
});
