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
    remember: async () => ({ action: 'stored', id: 'new-1' }),
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
