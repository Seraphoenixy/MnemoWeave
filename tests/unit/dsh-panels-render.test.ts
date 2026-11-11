import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UiExplore, UiGraph, UiSettings, UiSyncStatus } from '../../plugins/dsh-mnemo-weave/src/shared/contract.ts';

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
const skillsOutfile = join(root, 'skills.mjs');
const modalOutfile = join(root, 'modal.mjs');
type PanelComponent = (props: Record<string, unknown>) => ReactElement | null;
type Panels = Record<'ExplorePanel' | 'GraphSection' | 'EntitiesPanel' | 'ArchivesPanel' | 'RuntimePanel' | 'MemoryPageHeader' | 'MemoryOverviewPanel' | 'SettingsPanel' | 'CreateMemoryForm', PanelComponent>;
type SkillPanels = Record<'SkillBacktestPanel', PanelComponent>;
type ModalPanels = Record<'Modal', PanelComponent>;
let panels: Panels;
let skills: SkillPanels;
let modals: ModalPanels;

before(async () => {
  mkdirSync(root, { recursive: true });
  await build({
    entryPoints: [resolve('plugins/dsh-mnemo-weave/src/client/panels.tsx')],
    bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
    target: 'node24', outfile,
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  await build({
    entryPoints: [resolve('plugins/dsh-mnemo-weave/src/client/skill-backtest.tsx')],
    bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
    target: 'node24', outfile: skillsOutfile,
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  await build({
    entryPoints: [resolve('plugins/dsh-mnemo-weave/src/client/modal.tsx')],
    bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
    target: 'node24', outfile: modalOutfile,
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  panels = (await import(pathToFileURL(outfile).href)) as Panels;
  skills = (await import(pathToFileURL(skillsOutfile).href)) as SkillPanels;
  modals = (await import(pathToFileURL(modalOutfile).href)) as ModalPanels;
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
      providerMemoryId: 'p1', state: 'active', content: '第一条命中的正文',
      score: 0.93, publishedAt: '2026-11-10T00:00:00.000Z', category: 'decision',
    },
    {
      memoryId: '33333333-3333-4333-8333-333333333333', revisionId: '44444444-4444-4444-8444-444444444444',
      providerMemoryId: 'p2', state: 'superseded',
      content: '第二条命中的正文', score: 0.61, publishedAt: '2026-11-09T00:00:00.000Z',
    },
  ],
};

const graphFixture: UiGraph = {
  nodes: [
    { memoryId: '11111111-1111-4111-8111-111111111111', state: 'active', publishedAt: '2026-11-10T00:00:00.000Z', importance: 5 },
    { memoryId: '22222222-2222-4222-8222-222222222222', state: 'superseded', publishedAt: '2026-11-09T00:00:00.000Z', category: 'decision' },
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

const settingsFixture: UiSettings = {
  interface: { defaultTab: 'overview', pageSize: 25, source: 'preference' },
  connection: { serverUrl: 'http://127.0.0.1:4317', hostId: 'local-server', source: 'preference', hostSource: 'environment' },
  credential: { configured: true, source: 'environment', lastAuth: 'ok' },
  autoStart: { enabled: true, taskName: 'MnemoWeave Local Server', source: 'preference' },
  injection: { projectId: null, injectTimeoutMs: 900, source: 'preference', timeoutSource: 'preference' },
  diagnostics: { serverReady: true, providerReady: true, syncEnabled: true, settingsPath: 'C:/tmp/settings.json' },
};

const syncFixture: UiSyncStatus = {
  enabled: true,
  updatedAt: '2026-11-11T05:00:00.000Z',
  scopes: [{ scope: 'global', cursor: 12, lastPullAt: '2026-11-11T05:00:00.000Z', lastError: null, pending: 1, unknown: 0, unapplied: 0 }],
};

test('the settings page carries the sync state instead of a page-level tab', () => {
  const html = render(panels.SettingsPanel, {
    settings: settingsFixture, language: 'zh', busy: false, notice: null,
    connectionTest: null, wakeTest: null, registerTest: null,
    sync: syncFixture, syncError: null, syncPass: null,
    onSaveInterface: noop, onSaveConnection: noop, onSaveInjection: noop, onSaveAutoStart: noop,
    onRegisterTask: noop, onTestConnection: noop, onTestWake: noop, onRefreshSync: noop,
  });
  assert.match(html, /设置/, 'the settings page renders');
  assert.equal(html.match(/<section class="mwui-pane">/g)?.length, 1, 'the settings page is one card');
  assert.match(html, /本机 Server 与远端同步 Server/, 'sync is a section of the settings page');
  // Ordering is the contract: sync follows the local connection group and precedes auto-start, so
  // both server settings read as one card rather than as separate pages.
  const connectionAt = html.indexOf('本机连接');
  const syncAt = html.indexOf('本机 Server 与远端同步 Server');
  const autoStartAt = html.indexOf('自动启动');
  assert.ok(connectionAt >= 0 && syncAt > connectionAt && autoStartAt > syncAt, 'the sync group sits inside the settings card');
  assert.match(html, /立即同步/, 'the sync action lives with its status');
  assert.match(html, /data-tone="warn">1</, 'pending counts are shown in the sync table');
  assert.doesNotMatch(html, /undefined/, 'no field is printed raw');
});

test('the skills page uses the shared two-pane chrome', () => {
  const html = render(skills.SkillBacktestPanel, {
    language: 'zh',
    conversations: async () => [],
    review: async () => ({ kind: 'none' }),
    run: async () => ({
      baseline: { answer: '', steps: '', checks: [] },
      candidate: { answer: '', steps: '', checks: [] },
      regressions: [],
    }),
  });
  assert.match(html, /<form class="mwui-body"/, 'the page is a two-pane body, not a free-standing form');
  assert.match(html, /<section class="mwui-pane" aria-label="会话复盘"/, 'review owns the left pane');
  assert.match(html, /<section class="mwui-pane" aria-label="文本回测"/, 'backtest owns the right pane');
  assert.match(html, /class="mwui-button"/, 'actions use the page button style');
  assert.match(html, /class="mwui-field"/, 'fields carry the page label style');
  assert.match(html, /还没有回测结果/, 'an empty result is stated, not left blank');
  assert.doesNotMatch(html, /undefined|NaN/, 'no field is printed raw');
});

test('memory forms are modal windows instead of page layout', () => {
  const modalHtml = render(modals.Modal, {
    title: '编辑正式记忆', language: 'zh', busy: false, dirty: false, onClose: noop,
    children: createElement('textarea', { className: 'mwui-input mwui-textarea', defaultValue: '正文' }),
  });
  assert.match(modalHtml, /role="dialog"/, 'the window is a dialog');
  assert.match(modalHtml, /aria-modal="true"/, 'the page behind it is marked as inert');
  assert.match(modalHtml, /aria-label="编辑正式记忆"/, 'the window carries its title');
  assert.match(modalHtml, /aria-label="关闭"/, 'the window has a labelled close action');
  assert.match(modalHtml, /mwui-modal-body/, 'its content scrolls inside the window');

  const formHtml = render(panels.CreateMemoryForm, {
    draft: { content: '', knowledgeType: 'Practice', category: '', importance: '', tags: '', entities: '', reason: '' },
    busy: false, error: null, language: 'zh', onChange: noop, onCancel: noop, onSubmit: noop,
  });
  assert.doesNotMatch(formHtml, /mwui-pane/, 'the form brings no card chrome of its own');
  assert.match(formHtml, /mwui-edit-actions/, 'its actions sit in the window body');
});

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

test('the graph section draws a node per memory and a line per drawable relation', () => {
  const html = render(panels.GraphSection, {
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

test('the graph section renders an empty canvas without pretending it has data', () => {
  const html = render(panels.GraphSection, {
    graph: { nodes: [], edges: [], truncated: false }, loading: false, error: null, language: 'zh',
    focusId: null, onReload: noop, onOpen: noop,
  });
  assert.match(html, /还没有可绘制的记忆/);
  assert.equal((html.match(/<line /g) ?? []).length, 0);
});

test('the formal-memory header names the page, its count and its four views', () => {
  const html = render(panels.MemoryPageHeader, {
    count: '已载入 3 条', language: 'zh', active: 'content', creating: false, saving: false,
    onSelect: noop, onCreate: noop,
  });
  assert.match(html, /正式记忆/, 'the page names itself');
  assert.match(html, /已载入 3 条/, 'the loaded count is in the header');
  for (const label of ['概览', '检索', '内容', '实体']) assert.ok(html.includes(label), `the page offers the "${label}" view`);
  // The content view is the landing view of this store, not the first entry in the strip.
  assert.match(html, /data-active="true">内容</, 'the active view is marked');
  assert.match(html, /新增记忆/, 'the page-level action is in the header');
  assert.doesNotMatch(html, /undefined/, 'no field is printed raw');
});

test('the formal-memory overview counts what it holds and embeds the graph', () => {
  const summary = (memoryId: string, category: string) => ({
    memoryId, revisionId: 'r-' + memoryId, providerMemoryId: 'p-' + memoryId,
    applicability: 'all', publishedAt: '2026-11-10T00:00:00.000Z', content: '正文', entryVersion: 1,
    category,
  });
  const html = render(panels.MemoryOverviewPanel, {
    memories: {
      query: null, limit: 50, returned: 2,
      items: [summary('11111111-1111-4111-8111-111111111111', 'decision'), summary('22222222-2222-4222-8222-222222222222', 'fact')],
    },
    entities: [{ value: 'MnemoWeave', count: 2 }],
    graph: graphFixture, graphLoading: false, graphError: null, language: 'zh',
    focusId: null, onReloadGraph: noop, onOpen: noop,
  });
  assert.match(html, /已载入记忆/, 'the overview counts the loaded set');
  assert.match(html, /图谱节点/, 'the graph count is part of the overview');
  assert.equal((html.match(/<g /g) ?? []).length, 2, 'the graph itself is inside the overview');
  assert.match(html, /data-kind="Supersedes"/, 'its relations are drawn there too');
  assert.doesNotMatch(html, /undefined|NaN/, 'no field is printed raw');
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

test("the runtime panel offers the write path and shows each rule with its state", () => {
  const html = render(panels.RuntimePanel, {
    rules: [
      { entryId: '11111111-1111-4111-8111-111111111111', body: '提交前必须运行类型检查。', enabled: true, version: 2, withdrawnAt: null },
      { entryId: '22222222-2222-4222-8222-222222222222', body: '第二条准则', enabled: false, version: 1, withdrawnAt: null },
    ],
    error: null, selected: '11111111-1111-4111-8111-111111111111', language: 'zh',
    onSelect: noop, onCreate: async () => {}, onSave: async () => {},
  });
  assert.match(html, />新增</, 'the page offers publication');
  assert.match(html, />编辑</, 'an opened rule offers the edit form');
  assert.match(html, /提交前必须运行类型检查。/, 'the opened rule body is rendered');
  assert.match(html, /停用/, 'a disabled rule says so');
  assert.doesNotMatch(html, /alpha/, 'a rule carries no project');
  assert.doesNotMatch(html, /undefined|NaN/, 'no field is printed raw');
});

test('a graph with nodes but no relations explains the empty canvas', () => {
  // Nine dots and no lines looks broken; the page must say why nothing was drawn between them.
  const html = render(panels.GraphSection, {
    graph: {
      nodes: [
        { memoryId: '11111111-1111-4111-8111-111111111111', state: 'active', publishedAt: '2026-11-10T00:00:00.000Z' },
        { memoryId: '22222222-2222-4222-8222-222222222222', scope: 'global', state: 'active', publishedAt: '2026-11-09T00:00:00.000Z' },
      ],
      edges: [], truncated: false,
    },
    loading: false, error: null, language: 'zh', focusId: null, onReload: noop, onOpen: noop,
  });
  assert.match(html, /还没有目录关系/, 'the reason for an edgeless graph is stated');
  assert.equal((html.match(/<g /g) ?? []).length, 2, 'the nodes are still drawn');
});
