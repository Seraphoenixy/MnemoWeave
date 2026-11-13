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
import { tempDir } from '../support/temp.ts';
import { formatBytes } from '../../plugins/dsh-mnemo-weave/src/client/view-model.ts';

/**
 * Render each panel to static markup.
 *
 * The view-model tests cover the calculations; this covers the wiring — a panel that throws on a
 * missing field, prints `undefined`, or renders an empty frame when it has data is a bug no pure
 * function can catch. Node cannot import `.tsx` directly, so the panels are bundled with the same
 * esbuild already used for the real build, then rendered with `react-dom/server`. No browser and
 * no extra dependency.
 */

const root = await tempDir('dsh-panels-render', 'panels-render-');
const outfile = join(root, 'panels.mjs');
const skillsOutfile = join(root, 'skills.mjs');
const modalOutfile = join(root, 'modal.mjs');
type PanelComponent = (props: Record<string, unknown>) => ReactElement | null;
type Panels = Record<'ExplorePanel' | 'GraphSection' | 'EntitiesPanel' | 'ArchivesPanel' | 'RuntimePanel' | 'MemoryPageHeader' | 'MemoryOverviewPanel' | 'SettingsPanel' | 'CreateMemoryForm' | 'CapacityMeter' | 'SyncGroup', PanelComponent>;
type SkillPanels = Record<'SkillBacktestPanel' | 'SkillListPanel', PanelComponent>;
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
  hits: [
    {
      memoryId: '11111111-1111-4111-8111-111111111111', revisionId: '22222222-2222-4222-8222-222222222222',
      providerMemoryId: 'p1', state: 'active', content: '第一条命中的正文',
      score: 0.93, relevance: 'high', publishedAt: '2026-11-10T00:00:00.000Z', category: 'decision',
    },
    {
      memoryId: '33333333-3333-4333-8333-333333333333', revisionId: '44444444-4444-4444-8444-444444444444',
      providerMemoryId: 'p2', state: 'superseded',
      // A row the Provider ranked without a score: it still has a band, and no number is printed.
      content: '第二条命中的正文', relevance: 'medium', publishedAt: '2026-11-09T00:00:00.000Z',
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
  injection: { workspaceId: null, injectTimeoutMs: 900, source: 'preference', timeoutSource: 'preference' },
  diagnostics: { serverReady: true, providerReady: true, syncEnabled: true, settingsPath: 'C:/tmp/settings.json' },
};

const syncFixture: UiSyncStatus = {
  enabled: true,
  protocol: 2,
  updatedAt: '2026-11-11T05:00:00.000Z',
  streams: [
    { stream: 'rules', cursor: 12, lastPullAt: '2026-11-11T05:00:00.000Z', lastError: null, pending: 1, unknown: 0, unapplied: 0 },
    { stream: 'formal-memories', cursor: 40, lastPullAt: '2026-11-11T05:00:00.000Z', lastError: null, pending: 0, unknown: 0, unapplied: 0 },
  ],
};

test('the settings page shows the Provider recall diagnosis without inventing values', () => {
  const base = {
    settings: settingsFixture, language: 'zh', busy: false, notice: null,
    connectionTest: null, wakeTest: null, registerTest: null,
    sync: syncFixture, syncError: null, syncPass: null,
    onSaveInterface: noop, onSaveConnection: noop, onSaveInjection: noop, onSaveAutoStart: noop,
    onRegisterTask: noop, onTestConnection: noop, onTestWake: noop, onRefreshSync: noop,
  };
  const report = {
    provider: 'mnemon' as const, model: 'nomic-embed-text', protocol: 'ollama',
    serviceAvailable: false, modelAvailable: false, embedded: 2, total: 4, coverage: 0.5,
    recallMode: 'keyword' as const, degraded: true, lastError: 'embedding service unreachable',
    checkedAt: '2026-11-11T00:00:00.000Z',
    backfill: { state: 'failed' as const, startedAt: '2026-11-11T00:00:00.000Z', finishedAt: '2026-11-11T00:01:00.000Z', detail: { error: 'PROVIDER_UNAVAILABLE' } },
  };
  const html = render(panels.SettingsPanel, { ...base, diagnostics: report });
  assert.match(html, /召回诊断/, 'the diagnosis has its own group');
  assert.match(html, /关键词召回/, 'the recall mode is named');
  assert.match(html, /2\/4 · 50%/, 'coverage is shown as a count and a ratio');
  assert.match(html, /embedding service unreachable/, 'the last failure is shown as reported');
  assert.match(html, /已降级/, 'a degraded backend is labelled');
  assert.match(html, /向量补建/, 'the last backfill job is named');
  assert.match(html, /失败 · PROVIDER_UNAVAILABLE/, 'the job outcome carries its error code');

  const loading = render(panels.SettingsPanel, { ...base, diagnostics: undefined });
  assert.doesNotMatch(loading, /关键词召回/, 'a loading read shows no made-up mode');
  const failed = render(panels.SettingsPanel, { ...base, diagnostics: null });
  assert.doesNotMatch(failed, /undefined/, 'a failed read prints no raw field');
});

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
    draft: { content: '', category: '', importance: '', tags: '', entities: '', projectId: '', reason: '' },
    busy: false, error: null, language: 'zh', onChange: noop, onCancel: noop, onSubmit: noop,
  });
  assert.doesNotMatch(formHtml, /mwui-pane/, 'the form brings no card chrome of its own');
  assert.match(formHtml, /mwui-edit-actions/, 'its actions sit in the window body');
});

test('the explore panel renders its hits, their relevance bands and the unpublished count', () => {
  const html = render(panels.ExplorePanel, {
    query: 'TypeScript', mode: 'keyword', category: 'fact', result: exploreResult, error: null, busy: false, language: 'zh', limit: 20,
    onChangeMode: noop, onChangeCategory: noop,
    onChangeQuery: noop, onSearch: noop, onShowMore: noop, onOpen: noop,
  });
  assert.match(html, /第一条命中的正文/);
  assert.match(html, /直接搜索/);
  assert.match(html, /检索策略/);
  assert.match(html, /value="keyword" selected/);
  assert.match(html, /value="fact" selected/);
  assert.match(html, /0\.93/, 'a reported score is shown so the ranking is not opaque');
  assert.match(html, /高度相关/, 'the policy band is stated for a scored row');
  assert.match(html, /较相关/, 'the band is stated even when the Provider reported no score');
  assert.match(html, /另有 2 条/, 'unpublished Provider hits are counted, not silently dropped');
  assert.match(html, /显示更多/, 'a truncated result offers more');
  assert.doesNotMatch(html, /undefined|NaN/, 'no field is printed raw');
  // The page offers no score floor: relevance is decided by the policy that knows the scale.
  assert.doesNotMatch(html, /门槛/, 'no threshold control is rendered');
  assert.doesNotMatch(html, /mwui-minscore/, 'the floor select is gone');
});

test('an empty explore result explains the query rather than a threshold', () => {
  const html = render(panels.ExplorePanel, {
    query: 'x', mode: 'smart', category: '', error: null, busy: false, language: 'zh', limit: 20,
    onChangeMode: noop, onChangeCategory: noop,
    onChangeQuery: noop, onSearch: noop, onShowMore: noop, onOpen: noop,
    result: { query: 'x', unregistered: 0, truncated: false, hits: [] },
  });
  assert.match(html, /没有相关度足够的记忆/, 'the empty state names the cause');
  assert.doesNotMatch(html, /门槛/, 'there is no threshold to lower');
});

test('the graph section draws a node per memory and a curve per drawable relation', () => {
  const html = render(panels.GraphSection, {
    graph: graphFixture, loading: false, error: null, language: 'zh',
    focusId: '11111111-1111-4111-8111-111111111111', onReload: noop,
  });
  assert.equal((html.match(/<g /g) ?? []).length, 2, 'one group per node');
  // Edges are quadratic curves so that several relations between the same pair stay separable.
  assert.equal((html.match(/class="mwui-graph-edge"/g) ?? []).length, 1, 'one curve per relation');
  assert.match(html, /data-edge="Supersedes"/, 'a supersede is distinguishable in the markup');
  assert.match(html, /data-selected="true"/, 'the open memory is marked');
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
  assert.equal((html.match(/class="mwui-graph-edge"/g) ?? []).length, 0);
});

test('the formal-memory header names the page and its four views', () => {
  const html = render(panels.MemoryPageHeader, {
    language: 'zh', active: 'content', creating: false, saving: false,
    onSelect: noop, onCreate: noop,
  });
  assert.doesNotMatch(html, /整理记忆/, 'the organize entry needs a Host that can run tasks');

  const organized = render(panels.MemoryPageHeader, {
    language: 'zh', active: 'content', creating: false, saving: false,
    onSelect: noop, onCreate: noop, onOrganize: noop,
  });
  assert.match(organized, /整理记忆/, 'the organize entry sits beside creation');
  assert.match(html, /正式记忆/, 'the page names itself');
  assert.doesNotMatch(html, /已载入/);
  for (const label of ['概览', '检索', '内容', '实体']) assert.ok(html.includes(label), `the page offers the "${label}" view`);
  // The content view is the landing view of this store, not the first entry in the strip.
  assert.match(html, /data-active="true">内容</, 'the active view is marked');
  assert.match(html, /新增记忆/, 'the page-level action is in the header');
  assert.doesNotMatch(html, /undefined/, 'no field is printed raw');
  // The shared collection has no workspace filter, so the header carries no selector at all —
  // passing the removed props has no effect rather than drawing a dead control.
  const withRemovedProps = render(panels.MemoryPageHeader, {
    language: 'zh', active: 'content', creating: false, saving: false,
    projects: [{ projectId: null, count: 2 }], project: 'alpha', onProject: noop, onSelect: noop, onCreate: noop,
  });
  assert.doesNotMatch(withRemovedProps, /查看项目/);
  assert.doesNotMatch(withRemovedProps, /全部项目/);
});

test('the formal-memory overview counts what it holds and embeds the graph', () => {
  const summary = (memoryId: string, category: string) => ({
    memoryId, revisionId: 'r-' + memoryId, providerMemoryId: 'p-' + memoryId, publishedAt: '2026-11-10T00:00:00.000Z', content: '正文', entryVersion: 1,
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
  assert.match(html, /data-edge="Supersedes"/, 'its relations are drawn there too');
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
  assert.match(html, /aria-pressed="true"/, 'the entity currently applied is marked, ignoring case');
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
    loading: false, error: null, language: 'zh', focusId: null, onReload: noop,
  });
  assert.match(html, /还没有目录关系/, 'the reason for an edgeless graph is stated');
  assert.equal((html.match(/<g /g) ?? []).length, 2, 'the nodes are still drawn');
});

test('the skills page lists loadable skills with scope and unloadable count', () => {
  const html = render(skills.SkillListPanel, {
    language: 'zh', error: null, onRefresh: noop,
    report: {
      roots: ['/w/.dsh/skills', '/w/.agents/skills', '/h/.dsh/skills', '/h/.agents/skills'],
      items: [
        { name: 'alpha', description: 'Project skill', path: '/w/.dsh/skills/alpha/SKILL.md', root: '/w/.dsh/skills', scope: 'project', hash: 'a'.repeat(64), bodyBytes: 12 },
        { name: 'gamma', description: 'User skill', path: '/h/.dsh/skills/gamma/SKILL.md', root: '/h/.dsh/skills', scope: 'user', hash: 'b'.repeat(64), bodyBytes: 9 },
      ],
      invalid: [{ path: '/w/.agents/skills/bad/SKILL.md', reason: 'missing-frontmatter' }],
    },
  });
  assert.match(html, /可加载技能/);
  assert.match(html, /alpha/);
  assert.match(html, /项目/);
  assert.match(html, /gamma/);
  assert.match(html, /用户/);
  assert.match(html, /1 个文件无法加载/);
  const empty = render(skills.SkillListPanel, { language: 'zh', report: { roots: [], items: [], invalid: [] }, error: null, onRefresh: noop });
  assert.match(empty, /没有可加载的/);

  const compared = render(skills.SkillListPanel, {
    language: 'zh', report: { roots: [], items: [], invalid: [] }, error: null, onRefresh: noop,
    selected: '/w/.dsh/skills/alpha/SKILL.md',
    versions: [{ id: 'v-1', hash: 'c'.repeat(64), savedAt: '2026-11-12T00:00:00.000Z', source: 'adopt' }],
    diff: { versionId: 'v-1', lines: [{ kind: 'remove', text: 'old body' }, { kind: 'add', text: 'new body' }] },
  });
  assert.match(compared, /\+1 行，-1 行/);
  assert.match(compared, /old body/);
  assert.match(compared, /new body/);
});

test('a capacity meter reports a clamped percentage and keeps the real figures', () => {
  // The fill cannot overflow, so an over-limit state has to be readable from the label. Without
  // that, "full" and "over full" would draw identically.
  const half = render(panels.CapacityMeter, { used: 512, limit: 1024, language: 'zh' });
  assert.match(half, /role="progressbar"/);
  assert.match(half, /aria-valuenow="50"/, 'half of the limit reads as half');
  assert.match(half, /512 B \/ 1\.0 KB/, 'the exact figures sit beside the bar');

  const over = render(panels.CapacityMeter, { used: 2048, limit: 1024, exceeded: true, language: 'zh' });
  assert.match(over, /aria-valuenow="100"/, 'the bar stops at full instead of overflowing');
  assert.match(over, /已超出/, 'the over-limit state is stated, not just drawn as full');
  assert.match(over, /data-tone="warn"/);

  // An absent limit must not draw a full bar: that would read as "no room left".
  const none = render(panels.CapacityMeter, { used: 100, limit: 0, language: 'zh' });
  assert.match(none, /aria-valuenow="0"/, 'an unknown limit is empty, not full');
});

test('byte figures use the unit a reader compares at a glance', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(10_000), '9.8 KB', 'a value under ten keeps one decimal');
  assert.equal(formatBytes(10 * 1024), '10 KB', 'ten and above drop the decimal');
  assert.equal(formatBytes(10 * 1024 * 1024), '10 MB');
  assert.equal(formatBytes(Number.NaN), '—');
  assert.equal(formatBytes(-1), '—');
});

test('selecting a node marks it, dims the rest, and describes it in the inspector', () => {
  // The drawing and the inspector are one selection seen twice: a node that highlights without
  // its neighbours staying loud is not selecting anything, and an inspector with no emphasis in
  // the graph leaves the reader looking for what they just picked.
  // Three memories in a chain: selecting the middle one leaves the ends connected and the third
  // memory unconnected, which is what makes "recedes" observable at all.
  const chain = {
    nodes: [
      { memoryId: '11111111-1111-4111-8111-111111111111', state: 'active' as const, publishedAt: '2026-11-10T00:00:00.000Z' },
      { memoryId: '22222222-2222-4222-8222-222222222222', state: 'active' as const, publishedAt: '2026-11-10T00:00:00.000Z' },
      { memoryId: '33333333-3333-4333-8333-333333333333', state: 'active' as const, publishedAt: '2026-11-10T00:00:00.000Z' },
    ],
    edges: [{ relationId: 'e1', kind: 'RelatedTo' as const, sourceMemoryId: '11111111-1111-4111-8111-111111111111', targetMemoryId: '22222222-2222-4222-8222-222222222222', reason: 'why', effectiveAt: '2026-11-10T00:00:00.000Z' }],
    truncated: false,
  };
  const html = render(panels.GraphSection, {
    graph: chain, loading: false, error: null, language: 'zh',
    focusId: '11111111-1111-4111-8111-111111111111', onReload: noop,
  });
  // The selected node is marked; everything not connected to it is dimmed.
  assert.match(html, /data-selected="true"/);
  assert.match(html, /data-muted="true"/, 'nodes away from the selection recede');
  // The inspector describes the selection instead of the empty prompt.
  assert.doesNotMatch(html, /选择一个节点/);
  assert.match(html, /记忆详情/);
  assert.match(html, /11111111-1111-4111-8111-111111111111/, 'the inspector names the memory');
});

test('with nothing selected the inspector invites a pick and nothing is dimmed', () => {
  const html = render(panels.GraphSection, {
    graph: graphFixture, loading: false, error: null, language: 'zh', focusId: null, onReload: noop, onOpen: noop,
  });
  assert.match(html, /选择一个节点/);
  assert.doesNotMatch(html, /data-muted="true"/, 'no selection means no emphasis to give');
  assert.doesNotMatch(html, /data-selected="true"/);
});

test('an entity node offers the entity page, not a memory that does not exist', () => {
  const graph = {
    nodes: [
      { memoryId: '11111111-1111-4111-8111-111111111111', state: 'active' as const, publishedAt: '2026-11-10T00:00:00.000Z' },
      { memoryId: '22222222-2222-4222-8222-222222222222', state: 'active' as const, publishedAt: '2026-11-10T00:00:00.000Z' },
      { memoryId: 'MnemoWeave', kind: 'entity' as const, state: 'active' as const, publishedAt: '2026-11-10T00:00:00.000Z', category: 'entity', label: 'MnemoWeave', occurrenceCount: 2 },
    ],
    edges: [
      { relationId: 'e1', kind: 'Entity' as const, sourceMemoryId: 'MnemoWeave', targetMemoryId: '11111111-1111-4111-8111-111111111111', reason: 'shared', effectiveAt: '2026-11-10T00:00:00.000Z' },
      { relationId: 'e2', kind: 'Entity' as const, sourceMemoryId: 'MnemoWeave', targetMemoryId: '22222222-2222-4222-8222-222222222222', reason: 'shared', effectiveAt: '2026-11-10T00:00:00.000Z' },
    ],
    truncated: false,
  };
  const html = render(panels.GraphSection, {
    graph, loading: false, error: null, language: 'zh', focusId: 'MnemoWeave', onReload: noop,
    onExploreEntity: noop,
  });
  assert.match(html, /实体详情/);
  assert.match(html, /查看引用它的记忆/, 'an entity leads to the memories naming it');
  assert.doesNotMatch(html, /打开这条记忆/, 'an entity is not openable as a memory');
});

test('a memory node leads to a search around it, not to its own body', () => {
  // A node is a starting point. Opening the body answers what the memory page already answers;
  // searching its text answers what else resembles it, which only this drawing can lead to.
  const html = render(panels.GraphSection, {
    graph: graphFixture, loading: false, error: null, language: 'zh',
    focusId: '11111111-1111-4111-8111-111111111111', onReload: noop,
    onExploreMemory: noop,
  });
  assert.match(html, /围绕这条检索/, 'the primary action searches around the memory');
  assert.doesNotMatch(html, /打开这条记忆/, 'the graph no longer offers to open the body');
  // The node group is not a link: the only control that does anything is in the inspector.
  assert.doesNotMatch(html, /<a [^>]*graph-node/, 'a node is not an anchor');
});

test('an unconfigured sync is reported as a state, not as a failed read', () => {
  // The Server answers 409 REVIEW_REQUIRED when no remote sync exists. That is a normal state;
  // showing it as "read failed · RPC_FAILED" sent the reader looking for a broken Server.
  const off = render(panels.SyncGroup, {
    sync: { enabled: false, protocol: 0, streams: [], updatedAt: '2026-11-10T00:00:00.000Z', unavailableReason: 'not-configured' },
    error: null, pass: null, language: 'zh', busy: false, onRefresh: noop,
  });
  assert.match(off, /未配置远端同步/, 'the reason is stated');
  assert.doesNotMatch(off, /读取失败/, 'a normal state is not called a failure');

  const denied = render(panels.SyncGroup, {
    sync: { enabled: false, protocol: 0, streams: [], updatedAt: '2026-11-10T00:00:00.000Z', unavailableReason: 'unauthorized' },
    error: null, pass: null, language: 'zh', busy: false, onRefresh: noop,
  });
  assert.match(denied, /令牌被拒绝/, 'a rejected device token says so instead of "unavailable"');
});
