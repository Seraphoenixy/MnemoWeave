import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { createApi, RpcFailure } from '../../plugins/dsh-mnemo-weave/src/client/api.ts';
import type { ClientConnection } from '../../plugins/dsh-mnemo-weave/src/client/dsh-types.ts';
import { createRpcHandler } from '../../plugins/dsh-mnemo-weave/src/ui/rpc.ts';
import type { MemorySource } from '../../plugins/dsh-mnemo-weave/src/ui/memory-source.ts';

const packageRoot = join(import.meta.dirname, '..', '..', 'plugins', 'dsh-mnemo-weave');
const requireFromPackage = createRequire(join(packageRoot, 'package.json'));
const esbuild = requireFromPackage('esbuild') as typeof import('esbuild');
const React = requireFromPackage('react') as typeof import('react');
const { renderToString } = requireFromPackage('react-dom/server') as typeof import('react-dom/server');
type ReactElement = import('react').ReactElement;

interface Registration { options: { name: string; id?: string; key?: string; order?: number; label?: string | (() => string); inject?: () => Record<string, unknown> }; component: (props: never) => unknown }

async function bundle(): Promise<string> {
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { name: string };
  const result = await esbuild.build({
    entryPoints: [join(packageRoot, 'src/client/index.tsx')],
    bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2022',
    jsx: 'automatic', charset: 'utf8', legalComments: 'none', logLevel: 'silent',
    external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/*'],
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const body = result.outputFiles.map(file => file.text).join('');
  return `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;${body};return module.exports; } });`;
}

interface FakeHead { children: unknown[]; append(node: unknown): void }
interface FakeDocument { head: FakeHead; createElement(tag: string): { tag: string; dataset: Record<string, string>; textContent: string }; querySelector(): null; documentElement: { lang: string } }

interface Harness {
  loaded: Array<{ id: string; exports: Record<string, unknown> }>;
  document: FakeDocument;
}

function harness(): Harness {
  const children: unknown[] = [];
  return {
    loaded: [],
    document: {
      head: { children, append(node: unknown) { children.push(node); } },
      createElement(tag: string) { return { tag, dataset: {}, textContent: '' }; },
      querySelector() { return null; },
      documentElement: { lang: 'zh-CN' },
    },
  };
}

function run(code: string, state: Harness): void {
  const window = {
    __ModuleLoader__: {
      load(input: { id: string; factory: (req: (name: string) => unknown) => Record<string, unknown> }) {
        state.loaded.push({ id: input.id, exports: input.factory(name => {
          if (name === 'react') return React;
          if (name === 'react/jsx-runtime') return requireFromPackage('react/jsx-runtime');
          if (name === 'react-dom') return requireFromPackage('react-dom');
          throw new Error(`unexpected require: ${name}`);
        }) });
      },
    },
  };
  const context = vm.createContext({ window, document: state.document, navigator: { language: 'zh-CN' }, console });
  vm.runInContext('var require = window.__require;', context);
  vm.runInContext(code, context);
}

function makeContext(state: Harness & { throwOnSidebar?: boolean }, calls: { injected: string[]; registered: Registration[]; released: string[]; styles: number }) {
  return {
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
    layout: { selectPanel: () => undefined },
    locale: { getSnapshot: () => ({ active: 'zh-CN' }) },
    effect(setup: () => void | (() => void)) { return setup(); },
    slots: {
      inject(name: string, setup: () => () => void) { calls.injected.push(name); return setup(); },
      register(options: Registration['options'], component: Registration['component']) {
        calls.registered.push({ options, component });
        return () => { calls.released.push(options.name); };
      },
    },
  };
}

test('the built client bundle registers a page and a sidebar entry through DSH slots', async () => {
  const code = await bundle();
  assert.match(code, /__ModuleLoader__\.load/);
  const state = harness();
  run(code, state);
  assert.equal(state.loaded.length, 1);
  const module = state.loaded[0]!;
  assert.equal(module.id, 'dsh-mnemo-weave');
  assert.equal(typeof module.exports['apply'], 'function');
  assert.equal(module.exports['name'], 'dsh-mnemo-weave');
  assert.deepEqual([...(module.exports['inject'] as string[])].sort(), ['connection', 'layout', 'locale', 'slots']);

  const calls = { injected: [] as string[], registered: [] as Registration[], released: [] as string[], styles: 0 };
  const apply = module.exports['apply'] as (ctx: unknown) => void;
  apply(makeContext(state, calls));
  assert.deepEqual(calls.injected, ['main', 'sidebar.panellist']);
  assert.equal(calls.registered.length, 2);
  assert.equal(calls.registered[0]?.options.name, 'main');
  assert.equal(calls.registered[0]?.options.key, 'mnemoweave');
  assert.equal(typeof calls.registered[0]?.options.inject, 'function');
  assert.deepEqual(Object.keys(calls.registered[0]?.options.inject?.() ?? {}).sort(), ['connection', 'locale']);
  const entry = calls.registered[1]!;
  assert.equal(entry.options.name, 'sidebar.panellist');
  assert.equal(entry.options.id, 'mnemoweave');
  assert.equal(entry.options.order, 40);
  assert.equal(typeof entry.options.label, 'function');
  assert.equal((entry.options.label as () => string)(), '记忆中枢');
  // Styles are injected once, into the document head.
  assert.equal(state.document.head.children.length, 1);
  assert.equal((state.document.head.children[0] as { dataset: Record<string, string> }).dataset['mnemoweaveUi'], 'dsh-mnemo-weave-styles');
});

test('the page renders its editable shell and names unavailable data instead of inventing it', async () => {
  const code = await bundle();
  const state = harness();
  run(code, state);
  const calls = { injected: [] as string[], registered: [] as Registration[], released: [] as string[], styles: 0 };
  (state.loaded[0]!.exports['apply'] as (ctx: unknown) => void)(makeContext(state, calls));
  const page = calls.registered[0]!.component as unknown as (props: { connection: unknown; locale: unknown }) => ReactElement;
  const html = renderToString(React.createElement(page, { connection: { rpc: { call: async () => ({ ok: true, value: {} }) } }, locale: { getSnapshot: () => ({ active: 'zh-CN' }) } }));
  assert.match(html, /记忆中枢/);
  // The header carries no descriptive subtitle: connection state is the status row's job.
  assert.doesNotMatch(html, /直连 MnemoWeave Server/, 'no subtitle repeats the transport');
  assert.doesNotMatch(html, /主机:/, 'the host id is not repeated in the header');
  // The five class tabs are the top-level navigation; overview is the landing page.
  for (const label of ['概览', '运行时记忆', '项目档案', '正式记忆', '设置']) assert.match(html, new RegExp(label));
  assert.match(html, /最近一次注入/);
  assert.match(html, /尚无注入记录/);
  assert.match(html, /本机与远端同步/);
  assert.match(html, /正在加载|未配置远端同步/);
  assert.match(html, /服务信息/);
  assert.doesNotMatch(html, /undefined/);
  // No Bridge, no read-only wording, and no token value can appear in the page shell.
  assert.doesNotMatch(html, /Bridge|只读/);
  assert.doesNotMatch(html, /MNEMOWEAVE_TOKEN=/);
});

/**
 * The page's data path: one channel, five endpoints. A failure keeps the Server's code so the
 * banner can name it; nothing is retried or replaced with empty data here.
 */
test('the page calls the Host channel by endpoint and keeps Server error codes', async () => {
  const calls: Array<{ channel: string; endpoint: string; payload: unknown }> = [];
  const connection = {
    rpc: {
      call: async (channel: string, endpoint: string, payload?: unknown) => {
        calls.push({ channel, endpoint, payload });
        return { ok: true as const, value: { memoryId: 'memory-1', revisionId: 'r', providerMemoryId: 'p', contentHash: 'h' } };
      },
    },
  } as unknown as ClientConnection;
  const api = createApi(connection);
  await api.status();
  await api.config();
  await api.memories({ query: 'release', limit: 20 });
  await api.memory('memory-1');
  await api.edit({ memoryId: 'memory-1', content: 'next text', reason: 'fix', entryVersion: 3 });
  await api.injection();
  await api.rules();
  await api.archives();
  await api.sync();
  await api.syncRefresh();
  assert.deepEqual(calls.map(call => call.endpoint), ['status', 'config', 'memories', 'memory', 'edit', 'injection', 'rules', 'archives', 'sync', 'syncRefresh']);
  assert.ok(calls.every(call => call.channel === '/dsh-mnemo-weave'));
  assert.deepEqual(calls[2]?.payload, { query: 'release', limit: 20 });
  assert.deepEqual(calls[3]?.payload, { memoryId: 'memory-1' });
  assert.deepEqual(calls[4]?.payload, { memoryId: 'memory-1', content: 'next text', reason: 'fix', entryVersion: 3 });

  const failing = createApi({
    rpc: { call: async () => ({ ok: false, error: { message: 'denied', code: 'UNAUTHORIZED' } }) },
  } as unknown as ClientConnection);
  await assert.rejects(() => failing.status(), (error: unknown) => error instanceof RpcFailure && error.code === 'UNAUTHORIZED');
});

test('a failing sidebar registration releases the panel it already registered', async () => {
  const code = await bundle();
  const state = harness();
  run(code, state);
  const calls = { injected: [] as string[], registered: [] as Registration[], released: [] as string[], styles: 0 };
  const context = makeContext(state, calls);
  context.slots.register = (options: Registration['options'], component: Registration['component']) => {
    if (options.name === 'sidebar.panellist') throw new Error('slot conflict');
    calls.registered.push({ options, component });
    return () => { calls.released.push(options.name); };
  };
  assert.throws(() => (state.loaded[0]!.exports['apply'] as (ctx: unknown) => void)(context), /slot conflict/);
  assert.deepEqual(calls.released, ['main']);
});

/**
 * The client tree throws `cannot get property "locale" without inject` for a service the plugin did
 * not declare. That exception used to escape through the sidebar's locale subscriber — which derives
 * panel metadata at registration and on every locale change — and failed the whole web boot with
 * `1 entry did not activate`. The label must answer with its fallback instead.
 */
test('the sidebar label never throws when the locale service cannot be read', async () => {
  const code = await bundle();
  for (const mode of ['throwing', 'missing'] as const) {
    const state = harness();
    run(code, state);
    const calls = { injected: [] as string[], registered: [] as Registration[], released: [] as string[], styles: 0 };
    const context = makeContext(state, calls) as unknown as Record<string, unknown>;
    if (mode === 'throwing') {
      Object.defineProperty(context, 'locale', {
        configurable: true,
        get() { throw new Error('cannot get property "locale" without inject'); },
      });
    } else {
      delete context['locale'];
    }
    (state.loaded[0]!.exports['apply'] as (ctx: unknown) => void)(context);
    const entry = calls.registered[1]!;
    assert.equal(entry.options.name, 'sidebar.panellist');
    assert.equal((entry.options.label as () => string)(), 'MnemoWeave Memory', `${mode} locale must fall back to the English label`);
    const pageInject = calls.registered[0]!.options.inject!;
    assert.deepEqual(Object.keys(pageInject()).sort(), ['connection', 'locale']);
    assert.equal(pageInject()['locale'], undefined, `${mode} locale must reach the page as undefined`);
  }
});

interface SourceCalls {
  memories?: unknown;
  graph?: unknown;
  edit?: { memoryId: string; content: string; reason?: string };
  withdraw?: { memoryId: string; reason: string; entryVersion: number };
}

function stubSource(calls: SourceCalls, failure?: { code: string }): MemorySource {
  return {
    describe: () => ({ serverUrl: 'http://127.0.0.1:4317', hostId: 'dsh', hasToken: true }),
    status: async () => ({
      status: 'ok', serverUrl: 'http://127.0.0.1:4317', hostId: 'dsh', checkedAt: '2026-11-09T03:00:00.000Z',
    }),
    memories: async (input: Record<string, unknown>) => {
      calls.memories = input;
      return { query: (input['query'] as string | undefined) ?? null, limit: Number(input['limit']), returned: 0, items: [] };
    },
    memory: async () => { throw new Error('unexpected memory read'); },
    edit: async (input: { memoryId: string; content: string; reason?: string }) => {
      calls.edit = input;
      if (failure !== undefined) throw Object.assign(new Error('server said no'), { code: failure.code });
      return { memoryId: input.memoryId, revisionId: 'r', providerMemoryId: 'p', contentHash: 'h' };
    },
    withdraw: async (input: { memoryId: string; reason: string; entryVersion: number }) => {
      calls.withdraw = input;
      if (failure !== undefined) throw Object.assign(new Error('server said no'), { code: failure.code });
      return { memoryId: input.memoryId, revisionId: 'r2', entryVersion: input.entryVersion + 1, withdrawnAt: '2026-11-11T00:00:00.000Z' };
    },
    graph: async (input: { scope?: string; projectId?: string; limit?: number }) => {
      calls.graph = input;
      if (failure !== undefined) throw Object.assign(new Error('server said no'), { code: failure.code });
      return { nodes: [], edges: [], truncated: false };
    },
  } as unknown as MemorySource;
}

/**
 * Request validation happens in the Host and before any network call: an invalid payload never
 * reaches the source, and a Server failure keeps its code so the page can name it.
 */
test('the Host RPC validates requests before the Server call and passes Server codes through', async () => {
  const calls: SourceCalls = {};
  const handler = createRpcHandler(stubSource(calls));
  const memoryId = '11111111-1111-4111-8111-111111111111';

  const notUuid = await handler('edit', { memoryId: 'memory-1', content: 'next text' });
  assert.equal(notUuid.ok, false);
  if (notUuid.ok) throw new Error('expected a failure');
  assert.equal(notUuid.error.code, 'INVALID_INPUT');

  const blank = await handler('edit', { memoryId, content: '   ' });
  assert.equal(blank.ok, false);
  if (blank.ok) throw new Error('expected a failure');
  assert.equal(blank.error.code, 'INVALID_INPUT');
  assert.equal(calls.edit, undefined, 'invalid payloads must not reach the Server');

  const oversized = await handler('edit', { memoryId, content: 'x'.repeat(8001) });
  assert.equal(oversized.ok, false);
  if (oversized.ok) throw new Error('expected a failure');
  assert.equal(oversized.error.code, 'INVALID_INPUT');

  const badLimit = await handler('memories', { limit: 0 });
  assert.equal(badLimit.ok, false);
  if (badLimit.ok) throw new Error('expected a failure');
  assert.equal(badLimit.error.code, 'INVALID_INPUT');


  const unknown = await handler('revision', {});
  assert.equal(unknown.ok, false);
  if (unknown.ok) throw new Error('expected a failure');
  assert.equal(unknown.error.code, 'UNKNOWN_ENDPOINT');

  const saved = await handler('edit', { memoryId, content: 'next text', reason: '  fix  ', entryVersion: 4 });
  assert.equal(saved.ok, true);
  assert.deepEqual(calls.edit, { memoryId, content: 'next text', reason: 'fix', entryVersion: 4 });

  const rejected = createRpcHandler(stubSource({}, { code: 'NOT_FOUND' }));
  const failed = await rejected('edit', { memoryId, content: 'next text', entryVersion: 0 });
  assert.equal(failed.ok, false);
  if (failed.ok) throw new Error('expected a failure');
  assert.equal(failed.error.code, 'NOT_FOUND');

  const status = await handler('status', {});
  assert.equal(status.ok, true);
});

test('the Host RPC exposes rules, archives and the local-to-remote sync state', async () => {
  const source = {
    ...stubSource({}),
    rules: async () => [{ entryId: 'r1', scope: 'global', projectId: null, body: '准则', enabled: true, version: 1, withdrawnAt: null }],
    archives: async () => [{ entryId: 'a1', projectId: 'alpha', title: '标题', body: '正文', source: 'tool', verification: 'open', evidence: '证据', version: 1, withdrawnAt: null }],
    sync: async () => ({ enabled: true, scopes: [{ scope: 'global', cursor: 3, lastPullAt: null, lastError: null, pending: 1, unknown: 0, unapplied: 0 }], updatedAt: '2026-11-10T08:00:00.000Z' }),
    refreshSync: async () => ({ scopes: ['global'], pulled: 1, applied: 1, errors: [], skipped: false }),
  } as unknown as MemorySource;
  const handler = createRpcHandler(source);
  const rules = await handler('rules', {});
  assert.equal(rules.ok, true);
  if (rules.ok) assert.equal((rules.value as Array<{ body: string }>)[0]?.body, '准则');
  const archives = await handler('archives', {});
  assert.equal(archives.ok, true);
  if (archives.ok) assert.equal((archives.value as Array<{ projectId: string }>)[0]?.projectId, 'alpha');
  const sync = await handler('sync', {});
  assert.equal(sync.ok, true);
  if (sync.ok) assert.equal((sync.value as { scopes: Array<{ pending: number }> }).scopes[0]?.pending, 1);
  const pass = await handler('syncRefresh', {});
  assert.equal(pass.ok, true);
});

test('the Host RPC exposes the host-scoped injection report', async () => {
  const source = {
    ...stubSource({}),
    injection: async () => ({
      id: '33333333-3333-4333-8333-333333333333', sessionId: 's-1',
      rulesInjected: 1, rulesOmitted: null, memoriesInjected: 2, usedTokens: 320,
      createdAt: '2026-11-09T02:50:00.000Z',
    }),
  } as unknown as MemorySource;
  const result = await createRpcHandler(source)('injection', {});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal((result.value as { rulesInjected: number }).rulesInjected, 1);
});

/**
 * Withdrawal is a write, so it is validated like an edit: an unusable payload must fail in the
 * Host instead of reaching the Server. The reason is required because the history keeps it.
 */
test('withdrawal requires a reason and a base version before reaching the Server', async () => {
  const calls: SourceCalls = {};
  const handler = createRpcHandler(stubSource(calls));
  const memoryId = '11111111-1111-4111-8111-111111111111';

  for (const payload of [
    { memoryId: 'memory-1', reason: 'x', entryVersion: 0 },
    { memoryId, reason: '   ', entryVersion: 0 },
    { memoryId, entryVersion: 0 },
    { memoryId, reason: 'x' },
    { memoryId, reason: 'x', entryVersion: -1 },
  ]) {
    const result = await handler('withdraw', payload);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(payload)}`);
    if (result.ok) continue;
    assert.equal(result.error.code, 'INVALID_INPUT');
  }
  assert.equal(calls.withdraw, undefined, 'invalid payloads must not reach the Server');

  const accepted = await handler('withdraw', { memoryId, reason: '不再适用', entryVersion: 3 });
  assert.equal(accepted.ok, true);
  if (!accepted.ok) throw new Error('expected success');
  assert.deepEqual(calls.withdraw, { memoryId, reason: '不再适用', entryVersion: 3 });
  assert.equal((accepted.value as { entryVersion: number }).entryVersion, 4);
});

test('a withdrawal the Server refuses keeps the Server code', async () => {
  const rejected = createRpcHandler(stubSource({}, { code: 'VERSION_CONFLICT' }));
  const result = await rejected('withdraw', { memoryId: '11111111-1111-4111-8111-111111111111', reason: 'x', entryVersion: 0 });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected a failure');
  assert.equal(result.error.code, 'VERSION_CONFLICT');
});

/**
 * Classification is editable, and optional on the wire: an omitted field is inherited by the new
 * revision, so an invalid value must be refused rather than silently dropped.
 */
test('classification on an edit is validated before the Server call', async () => {
  const calls: SourceCalls = {};
  const handler = createRpcHandler(stubSource(calls));
  const memoryId = '11111111-1111-4111-8111-111111111111';

  for (const payload of [
    { memoryId, content: 'x', entryVersion: 0, category: 'nonsense' },
    { memoryId, content: 'x', entryVersion: 0, knowledgeType: 'Nope' },
    { memoryId, content: 'x', entryVersion: 0, importance: 0 },
    { memoryId, content: 'x', entryVersion: 0, importance: 6 },
    { memoryId, content: 'x', entryVersion: 0, tags: ['ok', '   '] },
    { memoryId, content: 'x', entryVersion: 0, tags: Array.from({ length: 21 }, (_, index) => `t${index}`) },
  ]) {
    const result = await handler('edit', payload);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(payload).slice(0, 120)}`);
    if (result.ok) continue;
    assert.equal(result.error.code, 'INVALID_INPUT');
  }
  assert.equal(calls.edit, undefined, 'invalid classification must not reach the Server');

  const accepted = await handler('edit', {
    memoryId, content: '带分类的正文', entryVersion: 0,
    category: 'decision', importance: 4, tags: [' 发布 ', '回滚'],
  });
  assert.equal(accepted.ok, true);
  assert.deepEqual(calls.edit, {
    memoryId, content: '带分类的正文', entryVersion: 0,
    category: 'decision', importance: 4, tags: ['发布', '回滚'],
  }, 'tags are trimmed and the classification travels on');

  // Omitting the fields must leave them out entirely, which is what makes them inherited.
  const plain = await handler('edit', { memoryId, content: '只改正文', entryVersion: 1 });
  assert.equal(plain.ok, true);
  assert.deepEqual(calls.edit, { memoryId, content: '只改正文', entryVersion: 1 });
});

/**
 * The graph request is validated in the Host before any call.
 *
 * Its bounds mirror the Server's. A memory graph is one global set now, so the only request
 * field left is the node cap.
 */
test('the graph request is validated before it reaches the Server', async () => {
  const calls: SourceCalls = {};
  const handler = createRpcHandler(stubSource(calls));

  const defaults = await handler('graph', {});
  assert.equal(defaults.ok, true);
  assert.deepEqual(calls.graph, {}, 'no bounds means the Server defaults apply');

  const bounded = await handler('graph', { limit: 50 });
  assert.equal(bounded.ok, true);
  assert.deepEqual(calls.graph, { limit: 50 });

  for (const payload of [
    { limit: 0 },
    { limit: 501 },
    { limit: 1.5 },
    { limit: 'many' },
  ]) {
    const result = await handler('graph', payload);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(payload)}`);
    if (result.ok) continue;
    assert.equal(result.error.code, 'INVALID_INPUT');
  }
  assert.deepEqual(calls.graph, { limit: 50 }, 'a rejected request never reaches the Server');
});

/**
 * Every validated filter must reach the source.
 *
 * A handler that validates a field but forgets to forward it is worse than one that rejects it:
 * the request succeeds and returns unfiltered data, so the control silently matches everything.
 * That is exactly what happened to the category, entity and sort controls.
 */
test('every list filter the Host validates is forwarded to the source', async () => {
  const calls: SourceCalls = {};
  const handler = createRpcHandler(stubSource(calls));

  const result = await handler('memories', {
    limit: 20,
    category: 'decision', knowledgeType: 'Practice', entity: 'MnemoWeave', sort: 'importance',
    query: '关键词', cursor: 'abc',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.memories, {
    limit: 20,
    category: 'decision', knowledgeType: 'Practice', entity: 'MnemoWeave', sort: 'importance',
    query: '关键词', cursor: 'abc',
  }, 'no validated field is dropped on the way to the source');

  // And the defaults stay defaults: nothing is invented when the caller asks for nothing.
  const plain = await handler('memories', {});
  assert.equal(plain.ok, true);
  const untouched = calls.memories as Record<string, unknown>;
  assert.deepEqual(Object.keys(untouched), ['limit'], 'only the page size is supplied');
  assert.equal(typeof untouched['limit'], 'number');
});
