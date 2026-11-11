import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Render the whole memory page once.
 *
 * The panels are covered individually; this covers the page itself, which is where a crash blanks
 * everything. Effects do not run under `react-dom/server`, so this is a first-paint check: the
 * page must produce markup with an unusable connection, without throwing, and without printing
 * `undefined` into the UI. It needs no browser and no extra dependency: esbuild is already the
 * project's bundler.
 */

const root = resolve('work', `page-render-${randomUUID()}`);
const outfile = join(root, 'page.mjs');
type PageModule = { MemoryPage: (props: Record<string, unknown>) => { props: unknown } | null };
let page: PageModule;

before(async () => {
  mkdirSync(root, { recursive: true });
  await build({
    entryPoints: [resolve('plugins/dsh-mnemo-weave/src/client/page.tsx')],
    bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
    target: 'node24', outfile,
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  page = (await import(pathToFileURL(outfile).href)) as PageModule;
});

after(() => { rmSync(root, { recursive: true, force: true }); });

/** A connection that refuses every call, standing in for "the Server is not running yet". */
function refusingConnection(): { rpc: { call: () => Promise<never> } } {
  return { rpc: { call: async () => { throw new Error('no server'); } } };
}

test('the page renders its first frame with a refusing connection', () => {
  // Without a locale service the page picks its own default, so the language is stated explicitly
  // here rather than assumed from the environment.
  const html = renderToStaticMarkup(createElement(page.MemoryPage as (props: Record<string, unknown>) => React.ReactElement, {
    connection: refusingConnection(),
    locale: { getSnapshot: () => ({ active: 'zh' }), subscribe: () => () => undefined },
  }));
  assert.ok(html.length > 500, 'a real frame is produced, not an empty shell');
  // The tab bar is the page's skeleton: every tab must exist even before any data arrives.
  for (const key of ['概览', '运行时记忆', '项目档案', '正式记忆', '实体', '探索', '图谱', '同步', '设置']) {
    assert.ok(html.includes(key), `the tab bar offers "${key}"`);
  }
  assert.doesNotMatch(html, /\bundefined\b/, 'no field is printed raw');
  assert.doesNotMatch(html, /NaN/, 'no number is printed as NaN');
});

test('the page renders with a locale service that reports an English preference', () => {
  const html = renderToStaticMarkup(createElement(page.MemoryPage as (props: Record<string, unknown>) => React.ReactElement, {
    connection: refusingConnection(),
    locale: { getSnapshot: () => ({ active: 'en' }), subscribe: () => () => undefined },
  }));
  assert.ok(html.includes('Overview'), 'the language preference is applied to the first frame');
  assert.ok(html.includes('Formal memories'));
});

test('a connection that throws synchronously does not blank the page', () => {
  // A misconfigured bridge can throw before returning a promise; the page must still paint.
  const throwing = { rpc: { call: () => { throw new Error('bridge is gone'); } } };
  const html = renderToStaticMarkup(createElement(page.MemoryPage as (props: Record<string, unknown>) => React.ReactElement, {
    connection: throwing,
  }));
  assert.ok(html.length > 500);
});
