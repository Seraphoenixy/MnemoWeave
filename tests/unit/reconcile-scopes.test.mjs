import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyReconcileOperations,
  emptyDocumentSnapshot,
  parseReconcileResult,
  reconcileModelContract,
  reconcilePrompt,
  sourceApplier,
} from '../../src/host/engine/reconcile.ts'

const machine = { id: 'm1', label: 'Machine 1' }
const runtime = {
  storageKind: 'working-rules',
  revision: 'rev-1',
  entries: [
    { id: 'r1', target: 'memory', content: 'Always run typecheck.', importance: 'critical', created_at: '2026-01-01T00:00:00Z' },
  ],
  targets: {
    memory: { used: 20, limit: 1000, entryCount: 1 },
    user: { used: 0, limit: 1000, entryCount: 0 },
  },
}
const documents = {
  ...emptyDocumentSnapshot('D:/repo', '2026-01-01T00:00:00Z'),
  documents: [
    { id: 'doc-1', title: 'Old Design', description: 'Outdated', status: 'active', sizeBytes: 120, updatedAt: '2026-01-01T00:00:00Z', sourcePaths: [] },
  ],
}
const memorySpaces = [
  {
    id: 'space-1',
    name: 'Project Space',
    insights: [
      { id: 'ins-1', content: 'Use SQLite WAL mode', category: 'decision', importance: 4, entities: ['SQLite'] },
      { id: 'ins-2', content: 'SQLite WAL mode improves concurrency', category: 'insight', importance: 3, entities: ['SQLite'] },
    ],
  },
]

test('reconcileModelContract returns distinct contracts per scope', () => {
  const wr = reconcileModelContract(runtime, 'working-rules')
  const docs = reconcileModelContract(runtime, 'documents')
  const ms = reconcileModelContract(runtime, 'memory-spaces')
  assert.notEqual(wr.schema, docs.schema)
  assert.notEqual(docs.schema, ms.schema)
  assert.deepEqual(docs.schema.properties.operations.items.properties.kind.enum, ['document-archive'])
  assert.deepEqual(ms.schema.properties.operations.items.properties.kind.enum, ['insight-revise', 'insight-forget', 'insight-link'])
})

test('reconcilePrompt includes guidance and scope-specific memorySpaces evidence', () => {
  const prompt = reconcilePrompt({
    scope: 'memory-spaces',
    machine,
    runtime,
    documents,
    memorySpaces,
    foreignMachines: [],
    guidance: '合并重复的 SQLite 条目',
  })
  assert.match(prompt, /Active Memory Spaces \(1\):/)
  assert.match(prompt, /ins-1/)
  assert.match(prompt, /合并重复的 SQLite 条目/)
  assert.doesNotMatch(prompt, /Shared Working Rules/)
})

test('parseReconcileResult enforces scope boundaries and validates memory-spaces operations', () => {
  const evidence = {
    scope: 'memory-spaces',
    machine,
    runtime,
    documents,
    memorySpaces,
    foreignMachines: [],
  }
  assert.throws(() => parseReconcileResult({
    title: 'Invalid cross-scope',
    summary: 'Should fail',
    action: 'planned',
    operations: [{ kind: 'document-archive', documentId: 'doc-1', reason: 'test' }],
  }, evidence), /outside memory-spaces scope/)

  const parsed = parseReconcileResult({
    title: 'Consolidate SQLite insights',
    summary: 'Merge duplicate SQLite notes and link.',
    action: 'planned',
    operations: [
      { kind: 'insight-revise', memoryBodyId: 'space-1', replacesId: 'ins-1', content: 'Use SQLite WAL mode for concurrency', category: 'decision', importance: 4, entities: ['SQLite', 'G1', '如', '系统'], reason: 'Merge duplicate facts' },
      { kind: 'insight-revise', memoryBodyId: 'space-1', replacesId: 'ins-2', content: 'Clean all invalid entities', entities: ['G2', '1', '已修改。'], reason: 'Strip invalid entities' },
      { kind: 'insight-forget', memoryBodyId: 'space-1', id: 'ins-2', reason: 'Covered by revised entry' },
      { kind: 'insight-link', memoryBodyId: 'space-1', sourceId: 'ins-1', targetId: 'ins-2', edgeType: 'semantic', weight: 0.8, reason: 'Related SQLite topic' },
    ],
  }, evidence)
  assert.equal(parsed.operations.length, 4)
  assert.equal(parsed.operations[0].kind, 'insight-revise')
  assert.deepEqual(parsed.operations[0].entities, ['SQLite'])
  assert.equal(parsed.operations[1].kind, 'insight-revise')
  assert.deepEqual(parsed.operations[1].entities, [])
  assert.equal(parsed.operations[2].kind, 'insight-forget')
  assert.equal(parsed.operations[3].kind, 'insight-link')
})

test('applyReconcileOperations executes memory-spaces operations through sourceApplier', async () => {
  const calls = []
  const applier = sourceApplier({
    runtime: { mutate: async () => ({}) },
    documents: { read: async () => ({}), mutate: async () => ({}) },
    memorySpaces: {
      mutate: async (operation, input) => {
        calls.push({ operation, input })
        if (operation === 'remember') return { action: 'updated', id: 'ins-new' }
        return { action: 'ok' }
      },
    },
  })
  const outcome = await applyReconcileOperations([
    { kind: 'insight-revise', memoryBodyId: 'space-1', replacesId: 'ins-1', content: 'Consolidated SQLite WAL rule', entities: ['SQLite'], reason: 'Merge' },
    { kind: 'insight-forget', memoryBodyId: 'space-1', id: 'ins-2', reason: 'Duplicate' },
    { kind: 'insight-link', memoryBodyId: 'space-1', sourceId: 'ins-1', targetId: 'ins-2', edgeType: 'entity', reason: 'Same entity' },
  ], applier, new AbortController().signal)

  assert.equal(outcome.applied, 3)
  assert.deepEqual(outcome.failures, [])
  assert.equal(calls[0].operation, 'remember')
  assert.equal(calls[0].input.replacesId, 'ins-1')
  assert.equal(calls[1].operation, 'forget')
  assert.equal(calls[2].operation, 'link')
  assert.equal(calls[2].input.type, 'entity')
})
