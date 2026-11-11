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
    limit: 20, scope: 'project', projectId: 'alpha', cursor: 'abc',
    category: 'decision', knowledgeType: 'Practice', entity: 'MnemoWeave', sort: 'importance', query: '关键词',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(source['memories']?.[0], {
    limit: 20, scope: 'project', projectId: 'alpha', cursor: 'abc',
    category: 'decision', knowledgeType: 'Practice', entity: 'MnemoWeave', sort: 'importance', query: '关键词',
  });
});

test('the detail, edit, withdraw, graph and explore requests forward their fields', async () => {
  const { rpc, source } = await harness();

  await rpc('memory', { memoryId: UUID, revisionId: REVISION });
  assert.deepEqual(source['memory'], [UUID, REVISION], 'a historical read keeps the revision');

  await rpc('create', {
    content: '新记忆的正文', knowledgeType: 'Practice', category: 'decision', importance: 4,
    tags: ['a'], entities: ['MnemoWeave'], scope: 'project', projectId: ' alpha ', reason: '理由',
  });
  assert.deepEqual(source['create']?.[0], {
    content: '新记忆的正文', knowledgeType: 'Practice', category: 'decision', importance: 4,
    tags: ['a'], entities: ['MnemoWeave'], scope: 'project', projectId: 'alpha', reason: '理由',
  }, 'a new memory keeps every field, and the project id is trimmed');

  await rpc('edit', { memoryId: UUID, content: '新正文', entryVersion: 3, reason: '理由', category: 'decision', importance: 4, tags: ['a'] });
  assert.deepEqual(source['edit']?.[0], {
    memoryId: UUID, content: '新正文', entryVersion: 3, reason: '理由', category: 'decision', importance: 4, tags: ['a'],
  }, 'classification on an edit is not dropped');

  await rpc('withdraw', { memoryId: UUID, reason: '撤回原因', entryVersion: 4 });
  assert.deepEqual(source['withdraw']?.[0], { memoryId: UUID, reason: '撤回原因', entryVersion: 4 });

  await rpc('graph', { scope: 'global', limit: 120 });
  assert.deepEqual(source['graph']?.[0], { scope: 'global', limit: 120 });

  await rpc('explore', { query: '语义检索', limit: 15, minScore: 0.4 });
  assert.deepEqual(source['explore']?.[0], { query: '语义检索', limit: 15, minScore: 0.4 }, 'the score floor reaches the source');
});

test('each settings request forwards only the fields it owns', async () => {
  const { rpc, settings } = await harness();

  await rpc('saveInterface', { defaultTab: 'memories', defaultScope: 'global', pageSize: 40 });
  assert.deepEqual(settings['saveInterface']?.[0], { defaultTab: 'memories', defaultScope: 'global', pageSize: 40 });

  await rpc('saveInjection', { projectId: 'alpha', injectTimeoutMs: 2500 });
  assert.deepEqual(settings['saveInjection']?.[0], { projectId: 'alpha', injectTimeoutMs: 2500 });

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
    ['memories', { scope: 'nonsense' }],
    ['memories', { sort: 'sideways' }],
    ['graph', { scope: 'project' }],
    ['explore', { query: '' }],
    ['create', { content: '', knowledgeType: 'Practice' }],
    ['create', { content: 'x' }],
    ['create', { content: 'x', knowledgeType: 'Nope' }],
    ['create', { content: 'x', knowledgeType: 'Practice', scope: 'project' }],
    ['create', { content: 'x', knowledgeType: 'Practice', importance: 9 }],
    ['edit', { memoryId: UUID, content: '', entryVersion: 0 }],
    ['withdraw', { memoryId: UUID, reason: '   ', entryVersion: 0 }],
    ['saveAutoStart', { enabled: 'yes' }],
  ] as const) {
    const result = await rpc(endpoint, payload);
    assert.equal(result.ok, false, `${endpoint} should have rejected ${JSON.stringify(payload)}`);
  }
  assert.deepEqual(source, {}, 'a rejected request never reaches the memory source');
  assert.deepEqual(settings, {}, 'a rejected request never reaches the settings service');
});
