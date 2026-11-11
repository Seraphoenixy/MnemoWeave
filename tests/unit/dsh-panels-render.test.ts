import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UiExplore, UiGraph } from '../../plugins/dsh-mnemo-weave/src/shared/contract.ts';

/**
 * Render each panel to static markup.
 *
 * The view-model tests cover the calculations; this covers the wiring — a panel that throws on a
 * missing field, prints `undefined`, or renders an empty frame when it has data is a bug no pure
 * function can catch. Node cannot import `.tsx` directly, so the panels are bundled with the same
 * esbuild already used for the real build, then rendered with `react-dom/server`. No browser and
 * no extra dependency.
 */

const root = resolve('work', `panels-render-${randomUUID()}`);
const outfile = join(root, 'panels.mjs');
type PanelComponent = (props: Record<string, unknown>) => ReactElement | null;
type Panels = Record<'ExplorePanel' | 'GraphPanel' | 'EntitiesPanel' | 'ArchivesPanel', PanelComponent>;
let panels: Panels;

before(async () => {
  mkdirSync(root, { recursive: true });
  await build({
    entryPoints: [resolve('plugins/dsh-mnemo-weave/src/client/panels.tsx')],
    bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
    target: 'node24', outfile,
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  panels = (await import(pathToFileURL(outfile).href)) as Panels;
});

after(() => { rmSync(root, { recursive: true, force: true }); });

const noop = (): void => {};

const exploreResult: UiExplore = {
  query: 'TypeScript',
  unregistered: 2,
  truncated: true,
  minScore: 0.5,
  hits: [
    {
      memoryId: '11111111-1111-4111-8111-111111111111', revisionId: '22222222-2222-4222-8222-222222222222',
      providerMemoryId: 'p1', scope: 'global', state: 'active', content: '第一条命中的正文',
      score: 0.93, publishedAt: '2026-11-10T00:00:00.000Z', category: 'decision',
    },
    {
      memoryId: '33333333-3333-4333-8333-333333333333', revisionId: '44444444-4444-4444-8444-444444444444',
      providerMemoryId: 'p2', scope: 'project', projectId: 'alpha', state: 'superseded',
      content: '第二条命中的正文', score: 0.61, publishedAt: '2026-11-09T00:00:00.000Z',
    },
  ],
};

const graphFixture: UiGraph = {
  nodes: [
    { memoryId: '11111111-1111-4111-8111-111111111111', scope: 'global', state: 'active', publishedAt: '2026-11-10T00:00:00.000Z', importance: 5 },
    { memoryId: '22222222-2222-4222-8222-222222222222', scope: 'project', projectId: 'alpha', state: 'superseded', publishedAt: '2026-11-09T00:00:00.000Z', category: 'decision' },
  ],
  edges: [{
    relationId: 'edge-1', kind: 'Supersedes',
    sourceMemoryId: '11111111-1111-4111-8111-111111111111',
    targetMemoryId: '22222222-2222-4222-8222-222222222222',
    reason: '新版本取代旧版本', effectiveAt: '2026-11-10T00:00:00.000Z',
  }],
  truncated: true,
};

const render = (component: PanelComponent, props: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(component, props));

test('the explore panel renders its hits, the unpublished count and the score floor', () => {
  const html = render(panels.ExplorePanel, {
    query: 'TypeScript', result: exploreResult, error: null, busy: false, language: 'zh', minScore: 0.5, limit: 20,
    onChangeQuery: noop, onChangeMinScore: noop, onSearch: noop, onShowMore: noop, onOpen: noop,
  });
  assert.match(html, /第一条命中的正文/);
  assert.match(html, /0\.93/, 'the score is shown so the ranking is not opaque');
  assert.match(html, /另有 2 条/, 'unpublished Provider hits are counted, not silently dropped');
  assert.match(html, /显示更多/, 'a truncated result offers more');
  assert.doesNotMatch(html, /undefined|NaN/, 'no field is printed raw');
});

test('an empty explore result reads differently with and without a floor', () => {
  const base = {
    query: 'x', error: null, busy: false, language: 'zh', limit: 20,
    onChangeQuery: noop, onChangeMinScore: noop, onSearch: noop, onShowMore: noop, onOpen: noop,
  };
  const withFloor = render(panels.ExplorePanel, { ...base, minScore: 0.5, result: { query: 'x', unregistered: 0, truncated: false, minScore: 0.5, hits: [] } });
  const withoutFloor = render(panels.ExplorePanel, { ...base, minScore: 0, result: { query: 'x', unregistered: 0, truncated: false, minScore: 0, hits: [] } });
  assert.match(withFloor, /门槛/, 'an empty list under a floor suggests lowering it');
  assert.notEqual(withFloor, withoutFloor, 'the two empty states do not read the same');
});

test('the graph panel draws a node per memory and a line per drawable relation', () => {
  const html = render(panels.GraphPanel, {
    graph: graphFixture, loading: false, error: null, language: 'zh',
    focusId: '11111111-1111-4111-8111-111111111111', onReload: noop, onOpen: noop,
  });
  assert.equal((html.match(/<g /g) ?? []).length, 2, 'one group per node');
  assert.equal((html.match(/<line /g) ?? []).length, 1, 'one line per relation');
  assert.match(html, /data-kind="Supersedes"/, 'a supersede is distinguishable in the markup');
  assert.match(html, /data-focus="true"/, 'the open memory is marked');
  assert.match(html, /节点已达上限/, 'a truncated graph says so');
  // A NaN in an SVG coordinate renders an empty canvas rather than failing loudly.
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test('the graph panel renders an empty canvas without pretending it has data', () => {
  const html = render(panels.GraphPanel, {
    graph: { nodes: [], edges: [], truncated: false }, loading: false, error: null, language: 'zh',
    focusId: null, onReload: noop, onOpen: noop,
  });
  assert.match(html, /还没有可绘制的记忆/);
  assert.equal((html.match(/<line /g) ?? []).length, 0);
});

test('the entities panel lists every entity with its count and marks the applied one', () => {
  const html = render(panels.EntitiesPanel, {
    entities: [{ value: 'MnemoWeave', count: 3 }, { value: 'DSH', count: 1 }],
    query: '', error: null, loading: false, language: 'zh', active: 'dsh',
    onChangeQuery: noop, onSelect: noop,
  });
  assert.match(html, /MnemoWeave/);
  assert.match(html, /DSH/);
  assert.match(html, /data-active="true"/, 'the entity currently applied is marked, ignoring case');
});

test('the entities panel filters by name and says when nothing matches', () => {
  const html = render(panels.EntitiesPanel, {
    entities: [{ value: 'MnemoWeave', count: 3 }],
    query: 'nobody', error: null, loading: false, language: 'zh', active: '',
    onChangeQuery: noop, onSelect: noop,
  });
  assert.match(html, /没有匹配的实体名/, 'an empty filter result is explained');
  assert.doesNotMatch(html, /MnemoWeave<\/span>/, 'the filtered-out entity is not listed');
});

test('a graph with nodes but no relations explains the empty canvas', () => {
  // Nine dots and no lines looks broken; the page must say why nothing was drawn between them.
  const html = render(panels.GraphPanel, {
    graph: {
      nodes: [
        { memoryId: '11111111-1111-4111-8111-111111111111', scope: 'global', state: 'active', publishedAt: '2026-11-10T00:00:00.000Z' },
        { memoryId: '22222222-2222-4222-8222-222222222222', scope: 'global', state: 'active', publishedAt: '2026-11-09T00:00:00.000Z' },
      ],
      edges: [], truncated: false,
    },
    loading: false, error: null, language: 'zh', focusId: null, onReload: noop, onOpen: noop,
  });
  assert.match(html, /还没有目录关系/, 'the reason for an edgeless graph is stated');
  assert.equal((html.match(/<g /g) ?? []).length, 2, 'the nodes are still drawn');
});
