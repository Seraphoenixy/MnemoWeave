import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeEntitiesAndTags } from '../../src/components/source-memory-spaces/src/contracts.ts'
import { buildSpaceEntityIndex, entityIdfWeight, matchQueryEntityKeys } from '../../src/components/source-memory-spaces/src/entity-index.ts'
import { MemorySpaceRegistry } from '../../src/components/source-memory-spaces/src/memory-spaces.ts'
import { MemoryProviderCatalog } from '../../src/components/source-memory-spaces/src/providers/catalog.ts'
import { MemoryProviderAdapterRegistry } from '../../src/components/source-memory-spaces/src/providers/registry.ts'
import { MemorySpacesService } from '../../src/components/source-memory-spaces/src/service.ts'
import { MnemonNativeProvider } from '../../src/components/provider-mnemon-native/src/driver.ts'
import { createRunner } from '../../src/components/source-memory-spaces/src/runner.ts'
import { resolveMemorySpacesConfig } from '../../src/components/source-memory-spaces/src/config.ts'

function createHarness(insights, relatedMap = new Map()) {
  const dir = mkdtempSync(join(tmpdir(), 'mnemo-entity-recall-'))
  const config = resolveMemorySpacesConfig({ dataDir: dir, defaultRecallLimit: 5 })
  const runner = createRunner(config)
  const catalog = new MemoryProviderCatalog([{
    id: 'mock-provider',
    label: 'Mock',
    kind: 'local',
    workspaceBinding: 'automatic',
    summary: 'Mock provider',
    origin: 'third-party',
    serviceConfigured: true,
    capabilities: {
      search: true, browse: true, graph: false, entities: true, related: true,
      remember: true, link: true, forget: true, writeMode: 'exact', deletionMode: 'soft',
    },
    fields: [],
  }])
  const memorySpaces = new MemorySpaceRegistry(runner, false, () => new Date(), catalog)
  memorySpaces.updateProviderService('mock-provider', {}, [], true)
  const space = memorySpaces.create({
    id: 'test-space',
    name: 'Test Space',
    description: 'Test',
    providerId: 'mock-provider',
    active: true,
  })
  let migratedCalls = 0
  const adapters = new MemoryProviderAdapterRegistry()
  adapters.register({ id: 'mock-provider', create: () => ({
    id: 'mock-provider',
    scoreSemantics: { kind: 'normalized-relevance' },
    status: async () => ({
      healthy: true,
      stats: { totalInsights: insights.length, deletedInsights: 0, edgeCount: 0, oplogCount: 1, dbSizeBytes: 100 },
    }),
    search: async () => ({
      results: [
        // Pure-vector unrelated high-score distraction
        { id: 'vec-unrelated', content: 'Unrelated semantic noise about cooking pasta', category: 'general', importance: 3, score: 0.96 },
        // Entity-matched lower-score result
        ...insights.filter(item => item.id === 'e2').map(item => ({ ...item, score: 0.72 })),
      ],
    }),
    graph: async () => ({ nodes: [], edges: [] }),
    list: async () => insights,
    get: async (_body, id) => insights.find(item => item.id === id),
    remember: async () => ({ action: 'stored', id: 'new-1' }),
    rememberMany: async (_body, requests) => requests.map((req, index) => {
      const id = `rev-${index + 1}`
      insights.push({ id, ...req })
      return { action: 'added', id }
    }),
    forget: async (_body, id) => {
      const index = insights.findIndex(item => item.id === id)
      if (index !== -1) insights.splice(index, 1)
      return { status: 'deleted', id }
    },
    related: async (_body, id) => relatedMap.get(id) ?? [],
    migrateLegacyTags: async () => {
      migratedCalls += 1
      let count = 0
      for (const item of insights) {
        if ((item.tags?.length ?? 0) > 0) {
          item.entities = mergeEntitiesAndTags(item.entities, item.tags)
          delete item.tags
          count += 1
        }
      }
      return { migrated: count }
    },
  }) })
  const service = new MemorySpacesService(runner, config, memorySpaces, undefined, adapters, catalog)
  return {
    dir,
    space,
    service,
    migratedCalls: () => migratedCalls,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('mergeEntitiesAndTags deduplicates case-insensitively and preserves order', () => {
  const merged = mergeEntitiesAndTags(['SQLite', 'DSH'], ['sqlite', 'local-first', 'dsh'])
  assert.deepEqual(merged, ['SQLite', 'DSH', 'local-first'])
})

test('entityIdfWeight scores rare entities higher than frequent ones and matchQueryEntityKeys finds query entities', () => {
  const index = buildSpaceEntityIndex([
    { id: '1', content: 'a', entities: ['common', 'SQLite'] },
    { id: '2', content: 'b', entities: ['common'] },
    { id: '3', content: 'c', entities: ['common'] },
  ], 3, true)
  assert.ok(entityIdfWeight(index, 'sqlite') > entityIdfWeight(index, 'common'))
  assert.deepEqual(matchQueryEntityKeys(index, 'How does SQLite work?'), ['sqlite'])
})

test('matchQueryEntityKeys requires whole-token match for short ASCII/alphanumeric keys, supports Chinese terms, and ignores legacy invalid keys', () => {
  const index = buildSpaceEntityIndex([
    { id: '1', content: 'Go compiler', entities: ['Go', 'V8', 'DSH', 'C++', '记忆空间'] },
    { id: '2', content: 'Legacy noise', entities: ['如', '1', 'G1', '系统'] },
  ], 2, true)
  assert.deepEqual(matchQueryEntityKeys(index, 'good ipv80 oldsh log10 android'), [])
  assert.deepEqual(matchQueryEntityKeys(index, '配置DSH中的记忆空间'), ['dsh', '记忆空间'])
  assert.deepEqual(matchQueryEntityKeys(index, '用C++和V8引擎'), ['v8', 'c++'])
  assert.deepEqual(matchQueryEntityKeys(index, 'Go runtime'), ['go'])
  assert.deepEqual(matchQueryEntityKeys(index, '如 G1 系统 1'), [])
})

test('search prioritizes entity-matched insights, demotes pure-vector noise, and expands 1-hop entity graph when under limit', async () => {
  const insights = [
    { id: 'e1', content: 'Connection pool configuration details', category: 'decision', importance: 4, entities: ['SQLite'] },
    { id: 'e2', content: 'WAL journal mode enabled for concurrency', category: 'fact', importance: 3, entities: ['SQLite'] },
    { id: 'g0', content: 'Other unrelated entry', category: 'general', importance: 2, entities: ['Other'] },
  ]
  const relatedMap = new Map([
    ['e2', [{ id: 'g1', content: '1-hop linked memory on checkpoint interval', category: 'insight', importance: 3, entities: ['Checkpoint'] }]],
  ])
  const harness = createHarness(insights, relatedMap)
  try {
    const response = await harness.service.search({ query: 'SQLite configuration', limit: 4 })
    const ids = response.results.map(item => item.id)
    // Entity matches (e1 entity-index 0.784, e2 both-matched 0.72) come first, then 1-hop graph neighbor g1, then pure-vector fallback vec-unrelated
    assert.deepEqual(ids, ['e1', 'e2', 'g1', 'vec-unrelated'])
  } finally {
    harness.cleanup()
  }
})

test('list matches entities and migrateLegacyTags rewrites legacy tags into entities', async () => {
  const insights = [
    { id: 'm1', content: 'Legacy entry', category: 'general', importance: 3, tags: ['legacy-tag'], entities: ['SQLite'] },
  ]
  const harness = createHarness(insights)
  try {
    const listed = await harness.service.list({ query: 'legacy-tag' })
    assert.equal(listed.items.length, 1)
    assert.deepEqual(listed.items[0].entities, ['SQLite', 'legacy-tag'])
    assert.equal(listed.items[0].tags, undefined)

    const migration = await harness.service.migrateLegacyTags()
    assert.equal(migration.migrated, 1)
    assert.deepEqual(migration.spaces, [harness.service.spaceDirectory().items[0].id])
    assert.equal(harness.migratedCalls(), 1)
    assert.equal(insights[0].tags, undefined)
    assert.deepEqual(insights[0].entities, ['SQLite', 'legacy-tag'])
  } finally {
    harness.cleanup()
  }
})

test('remember with replacesId updates metadata-only edits and skips truly equivalent insights', async () => {
  const insights = [
    { id: 'orig-1', content: 'Use SQLite WAL mode', category: 'general', importance: 3, entities: ['OldPath'] },
  ]
  const harness = createHarness(insights)
  try {
    const beforeEntities = await harness.service.entities()
    assert.deepEqual(beforeEntities.items.map(item => item.entity), ['OldPath'])

    const unchanged = await harness.service.remember({
      replacesId: 'orig-1',
      content: 'Use SQLite WAL mode',
      category: 'general',
      importance: 3,
      entities: ['OldPath'],
      memoryBodyId: harness.space.id,
    })
    assert.equal(unchanged.action, 'skipped')
    assert.equal(unchanged.reason, 'equivalent-insight')

    const updated = await harness.service.remember({
      replacesId: 'orig-1',
      content: 'Use SQLite WAL mode',
      category: 'general',
      importance: 3,
      entities: ['SQLite', 'WAL'],
      memoryBodyId: harness.space.id,
    })
    assert.equal(updated.action, 'updated')
    assert.equal(updated.previousId, 'orig-1')
    assert.equal(insights.length, 1)
    assert.equal(insights[0].id, updated.id)
    assert.deepEqual(insights[0].entities, ['SQLite', 'WAL'])

    const afterEntities = await harness.service.entities()
    assert.deepEqual(afterEntities.items.map(item => item.entity), ['SQLite', 'WAL'])
  } finally {
    harness.cleanup()
  }
})

test('service.remember filters clauses with commas and invalid entities without throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mnemo-entity-filter-'))
  try {
    const config = resolveMemorySpacesConfig({ dataDir: dir, defaultRecallLimit: 5 })
    const runner = createRunner(config)
    const catalog = new MemoryProviderCatalog([{
      id: 'mock-provider',
      label: 'Mock',
      kind: 'local',
      workspaceBinding: 'automatic',
      summary: 'Mock provider',
      origin: 'third-party',
      serviceConfigured: true,
      capabilities: {
        search: true, browse: true, graph: false, entities: true, related: true,
        remember: true, link: true, forget: true, writeMode: 'exact', deletionMode: 'soft',
      },
      fields: [],
    }])
    const memorySpaces = new MemorySpaceRegistry(runner, false, () => new Date(), catalog)
    memorySpaces.updateProviderService('mock-provider', {}, [], true)
    const space = memorySpaces.create({
      id: 'test-space',
      name: 'Test Space',
      description: 'Test',
      providerId: 'mock-provider',
      active: true,
    })
    let capturedRequest
    const adapters = new MemoryProviderAdapterRegistry()
    adapters.register({ id: 'mock-provider', create: () => ({
      id: 'mock-provider',
      status: async () => ({ healthy: true }),
      search: async () => ({ results: [] }),
      graph: async () => ({ nodes: [], edges: [] }),
      list: async () => [],
      remember: async (_body, request) => {
        capturedRequest = request
        return { action: 'stored', id: 'new-1' }
      },
    }) })
    const service = new MemorySpacesService(runner, config, memorySpaces, undefined, adapters, catalog)
    await service.remember({
      content: '记忆空间实体验证规则',
      entities: ['核对被审数据,表述明确', 'G1-G9', 'G1', '如', '1', '系统', '记忆空间', 'SQLite'],
      memoryBodyId: space.id,
    })
    assert.deepEqual(capturedRequest.entities, ['记忆空间', 'SQLite'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MnemonNativeProvider uses --entity-mode provided for remember and single replacesId revisions', async () => {
  const calls = []
  const provider = new MnemonNativeProvider({
    runJson: async (args, options) => {
      calls.push({ args, options })
      return { action: 'added', id: 'new-id' }
    },
  })
  const space = { id: 'default', name: 'Default', description: '', provider: { id: 'mnemon-native', label: 'Mnemon Native', capabilities: {} }, active: true }
  await provider.remember(space, { content: '「引用片段」使用 SQLite', category: 'fact', importance: 4, entities: ['SQLite'], source: 'agent' })
  await provider.rememberMany(space, [{ replacesId: 'old-1', content: '「引用片段」无实体', category: 'fact', importance: 4, source: 'agent' }])

  assert.equal(calls.length, 2)
  assert.ok(calls[0].args.includes('--entity-mode'))
  assert.equal(calls[0].args[calls[0].args.indexOf('--entity-mode') + 1], 'provided')
  assert.equal(calls[0].args.includes('--no-diff'), false)

  assert.equal(calls[1].args[0], 'remember')
  assert.ok(calls[1].args.includes('--no-diff'))
  assert.ok(calls[1].args.includes('--entity-mode'))
  assert.equal(calls[1].args[calls[1].args.indexOf('--entity-mode') + 1], 'provided')
  assert.equal(calls[1].args.includes('--entities'), false)
})
