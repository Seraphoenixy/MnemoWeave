import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

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
  assert.deepEqual([...(module.exports['inject'] as string[])].sort(), ['connection', 'layout', 'slots']);

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
  assert.equal((entry.options.label as () => string)(), 'MnemoWeave 记忆');
  // Styles are injected once, into the document head.
  assert.equal(state.document.head.children.length, 1);
  assert.equal((state.document.head.children[0] as { dataset: Record<string, string> }).dataset['mnemoweaveUi'], 'dsh-mnemo-weave-styles');
});

test('the page renders its read-only shell and names unavailable data instead of inventing it', async () => {
  const code = await bundle();
  const state = harness();
  run(code, state);
  const calls = { injected: [] as string[], registered: [] as Registration[], released: [] as string[], styles: 0 };
  (state.loaded[0]!.exports['apply'] as (ctx: unknown) => void)(makeContext(state, calls));
  const page = calls.registered[0]!.component as unknown as (props: { connection: unknown; locale: unknown }) => ReactElement;
  const html = renderToString(React.createElement(page, { connection: { rpc: { call: async () => ({ ok: true, value: {} }) } }, locale: { getSnapshot: () => ({ active: 'zh-CN' }) } }));
  assert.match(html, /MnemoWeave 记忆/);
  assert.match(html, /只读视图/);
  assert.match(html, /搜索本机记忆/);
  assert.match(html, /从左侧选择一条记忆/);
  assert.match(html, /离线意图队列/);
  assert.doesNotMatch(html, /undefined/);
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
