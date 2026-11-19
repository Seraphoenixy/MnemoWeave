import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { connectMcp } from '../support/sync-fixtures.mjs'

test('MCP Working Rules use the DSH mutation contract in an isolated profile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mnemo-mcp-tools-'))
  let mcp
  try {
    mcp = await connectMcp({
      entry: fileURLToPath(new URL('../../dist/mnemo-weave-mcp.js', import.meta.url)),
      env: { MNEMON_DATA_DIR: directory },
    })
    const { tools } = await mcp.client.listTools()
    const mutation = tools.find(tool => tool.name === 'mnemo_runtime_memory')
    assert.deepEqual(mutation.inputSchema.required, ['action'])
    assert.equal(mutation.inputSchema.additionalProperties, false)
    assert.deepEqual(Object.keys(mutation.inputSchema.properties).sort(), ['action', 'content', 'importance', 'old_text'])
    assert.deepEqual(mutation.inputSchema.properties.action.enum, ['add', 'replace', 'remove'])
    const write = args => mcp.call('mnemo_runtime_memory', args)
    const read = args => mcp.call('mnemo_working_rules', args)
    await write({ action: 'add', content: 'Synthetic standing rule', importance: 'critical' })
    await write({ action: 'add', content: 'Synthetic second rule' })
    assert.equal((await read({})).entries.length, 2)
    const replaced = await write({ action: 'replace', old_text: 'Synthetic standing rule', content: 'Synthetic replacement rule', importance: 'low' })
    assert.match(replaced.message, /original importance preserved/u)
    assert.deepEqual((await read({})).entries[0], { content: 'Synthetic replacement rule', importance: 'critical' })
    await assert.rejects(write({ action: 'add' }), /content/u)
    await assert.rejects(write({ action: 'add', content: 'Rejected target rule', target: 'user' }), /target/u)
    await assert.rejects(write({ action: 'remove', old_text: 'Synthetic' }), /Multiple/u)
    await write({ action: 'remove', old_text: 'Synthetic replacement rule' })
    assert.deepEqual((await read({})).entries, [{ content: 'Synthetic second rule', importance: 'normal' }])
  } finally {
    await mcp?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('MCP server exposes all DSH memory tools and executes Documents & Memory Spaces end-to-end', async () => {
  const { MEMORY_TOOLS } = await import('../../src/host/contracts/memory-tools.ts')
  const fixture = await mkdtemp(join(tmpdir(), 'mnemoweave-mcp-parity-'))
  const dataDir = join(fixture, 'data')
  let mcp
  try {
    mcp = await connectMcp({
      entry: fileURLToPath(new URL('../../dist/mnemo-weave-mcp.js', import.meta.url)),
      env: {
        ...process.env,
        MNEMON_DATA_DIR: dataDir,
        MNEMON_STORAGE_SCOPE: 'workspaces',
      },
    })

    const listed = await mcp.client.listTools()
    const names = listed.tools.map(tool => tool.name).sort()
    const expected = ['mnemo_working_rules', ...Object.keys(MEMORY_TOOLS)].sort()
    assert.deepEqual(names, expected)

    const status = await mcp.call('mnemo_status', {})
    assert.equal(typeof status, 'object')

    const createdDoc = await mcp.call('mnemo_document_manage', {
      action: 'create',
      title: 'MCP Parity Design',
      description: 'Notes on MCP tool parity with DSH.',
      content: 'MCP tools now share the Composable Memory runtime with DSH.',
    })
    assert.equal(createdDoc.memoryReceipt.status, 'succeeded')
    assert.equal(createdDoc.memoryReceipt.completion, 'committed')
    assert.ok(createdDoc.document?.id)

    const foundDocs = await mcp.call('mnemo_document_search', { query: 'Parity Design' })
    assert.ok(Array.isArray(foundDocs.results), JSON.stringify(foundDocs))
    assert.ok(foundDocs.results.some(item => item.id === createdDoc.document.id), JSON.stringify({ createdDoc, foundDocs }))

    const space = await mcp.call('mnemo_memory_body_create', {
      name: 'mcp-test-space',
      description: 'Isolated synthetic space for MCP tool verification.',
    })
    assert.equal(space.memoryReceipt.status, 'succeeded')
    const spaceId = space.memoryBodyId
    assert.ok(spaceId, JSON.stringify(space))
    await mcp.call('mnemo_memory_body_update', { memoryBodyId: spaceId, active: true })

    const bodies = await mcp.call('mnemo_memory_bodies', {})
    assert.ok(JSON.stringify(bodies).includes(spaceId))

    const first = await mcp.call('mnemo_remember', {
      content: 'First synthetic MCP insight for recall and linking.',
      category: 'insight',
      importance: 4,
      memoryBodyId: spaceId,
    })
    assert.equal(first.memoryReceipt.status, 'succeeded')
    const firstId = first.id ?? first.node?.id ?? first.memoryId
    assert.ok(firstId, JSON.stringify(first))

    const second = await mcp.call('mnemo_remember', {
      content: 'Distinct follow-up graph node for traversal verification.',
      category: 'insight',
      importance: 3,
      memoryBodyId: spaceId,
    })
    assert.equal(second.memoryReceipt.status, 'succeeded')
    const secondId = second.id ?? second.node?.id ?? second.memoryId
    assert.ok(secondId, JSON.stringify(second))

    const recalled = await mcp.call('mnemo_recall', {
      query: 'synthetic MCP insight',
      memoryBodyIds: [spaceId],
    })
    assert.ok(Array.isArray(recalled.results), JSON.stringify(recalled))
    assert.ok(recalled.results.some(item => item.id === firstId))

    const linked = await mcp.call('mnemo_link', {
      sourceId: firstId,
      targetId: secondId,
      type: 'semantic',
      reason: 'Synthetic test link',
      memoryBodyId: spaceId,
    })
    assert.equal(linked.memoryReceipt.status, 'succeeded')

    const related = await mcp.call('mnemo_related', {
      id: firstId,
      memoryBodyId: spaceId,
    })
    assert.ok(Array.isArray(related.results), JSON.stringify(related))
    assert.ok(related.results.some(item => item.id === secondId), JSON.stringify(related))

    const forgotten = await mcp.call('mnemo_forget', {
      id: secondId,
      memoryBodyId: spaceId,
    })
    assert.equal(forgotten.memoryReceipt.status, 'succeeded')

    const updatedSpace = await mcp.call('mnemo_memory_body_update', {
      memoryBodyId: spaceId,
      active: false,
    })
    assert.equal(updatedSpace.memoryReceipt.status, 'succeeded')
  } finally {
    await mcp?.close().catch(() => undefined)
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('MCP tool surface matches DSH required parameters and strictness', async () => {
  const { MEMORY_TOOLS } = await import('../../src/host/contracts/memory-tools.ts')
  const { registerTools } = await import('../../src/host/surface/tools.ts')
  const definitions = []
  const ctx = { tools: { register: tool => { definitions.push(tool); return () => {} } } }
  const contributions = {
    committedContributionSnapshot: () => ({ sources: [
      { definition: { manifest: { typeId: 'memory-spaces' } } },
      { definition: { manifest: { typeId: 'documents' } } },
      { definition: { manifest: { typeId: 'runtime' } } },
    ] }),
    onCommittedContributionsChanged: () => () => {},
  }
  const dispose = registerTools(ctx, { config: { writeEnabled: true } }, {}, contributions)
  dispose()

  const fixture = await mkdtemp(join(tmpdir(), 'mnemoweave-mcp-schema-'))
  let mcp
  try {
    mcp = await connectMcp({
      entry: fileURLToPath(new URL('../../dist/mnemo-weave-mcp.js', import.meta.url)),
      env: { ...process.env, MNEMON_DATA_DIR: join(fixture, 'data'), MNEMON_STORAGE_SCOPE: 'global' },
    })
    const listed = await mcp.client.listTools()
    const mcpTools = Object.fromEntries(listed.tools.map(tool => [tool.name, tool.inputSchema]))
    const dshTools = Object.fromEntries(definitions.map(tool => [tool.name, tool.parameters]))
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ['mnemo_working_rules', ...Object.keys(MEMORY_TOOLS)].sort())

    for (const [name, schema] of Object.entries(mcpTools)) {
      assert.equal(schema.additionalProperties, false, `${name} must reject unknown parameters`)
    }
    assert.equal(mcpTools.mnemo_document_search.properties.workspaceId, undefined, 'MCP cannot resolve a DSH workspace id')
    assert.deepEqual(mcpTools.mnemo_document_search.required, ['query'])

    for (const [name, dsh] of Object.entries(dshTools)) {
      const mcp = mcpTools[name]
      assert.ok(mcp, `missing MCP tool ${name}`)
      assert.deepEqual(mcp.required ?? [], dsh.required ?? [], `${name} required parameters`)
      assert.equal(dsh.additionalProperties, false, `${name} DSH strictness`)
      const mcpKeys = Object.keys(mcp.properties ?? {}).sort()
      const dshKeys = Object.keys(dsh.properties ?? {}).sort()
      if (name === 'mnemo_document_search') {
        assert.deepEqual(dshKeys.filter(key => !mcpKeys.includes(key)), ['workspaceId'])
      } else {
        assert.deepEqual(mcpKeys, dshKeys, `${name} parameter names`)
      }
    }
  } finally {
    await mcp?.close().catch(() => undefined)
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('MCP Document writes return a trimmed receipt and archive locally', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'mnemoweave-mcp-documents-'))
  let mcp
  try {
    mcp = await connectMcp({
      entry: fileURLToPath(new URL('../../dist/mnemo-weave-mcp.js', import.meta.url)),
      env: { ...process.env, MNEMON_DATA_DIR: join(fixture, 'data'), MNEMON_STORAGE_SCOPE: 'global' },
    })
    const created = await mcp.call('mnemo_document_manage', {
      action: 'create',
      title: 'Receipt shape',
      description: 'Checks the model-facing Document receipt.',
      content: 'Trimmed receipt body.',
    })
    assert.equal(created.document?.title, 'Receipt shape')
    assert.equal(created.snapshot, undefined, 'the full Documents snapshot stays off the model surface')
    assert.equal(typeof created.documents.active, 'number')
    assert.equal(typeof created.documents.limitBytes, 'number')
    assert.equal(created.memoryReceipt.status, 'succeeded')

    const archived = await mcp.call('mnemo_document_manage', { action: 'archive', id: created.document.id })
    assert.equal(archived.snapshot, undefined)
    assert.equal(archived.document.status, 'archived')
    assert.equal(archived.document.content, undefined)
    assert.equal(typeof archived.documents.archived, 'number')
    assert.ok(archived.maintenance?.archivedDocumentIds.includes(created.document.id))
  } finally {
    await mcp?.close().catch(() => undefined)
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('MCP rejects an inactive remember target and preserves importance on replace', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'mnemoweave-mcp-guard-'))
  let mcp
  try {
    mcp = await connectMcp({
      entry: fileURLToPath(new URL('../../dist/mnemo-weave-mcp.js', import.meta.url)),
      env: { ...process.env, MNEMON_DATA_DIR: join(fixture, 'data'), MNEMON_STORAGE_SCOPE: 'global' },
    })
    const space = await mcp.call('mnemo_memory_body_create', { name: 'inactive-target', description: 'Synthetic inactive target.' })
    await mcp.call('mnemo_memory_body_update', { memoryBodyId: space.memoryBodyId, active: true })
    await mcp.call('mnemo_memory_body_update', { memoryBodyId: space.memoryBodyId, active: false })
    await assert.rejects(mcp.call('mnemo_remember', { content: 'Should not land in an inactive space.', memoryBodyId: space.memoryBodyId }), /switched off/u)

    await mcp.call('mnemo_runtime_memory', { action: 'add', content: 'Importance custody rule.', importance: 'critical' })
    const replaced = await mcp.call('mnemo_runtime_memory', { action: 'replace', old_text: 'Importance custody rule.', content: 'Importance custody rule v2.', importance: 'low' })
    assert.match(replaced.message, /original importance preserved/u)
    const read = await mcp.call('mnemo_working_rules', {})
    assert.deepEqual(read.entries, [{ content: 'Importance custody rule v2.', importance: 'critical' }])
  } finally {
    await mcp?.close().catch(() => undefined)
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('MCP keeps Recall admission across a remember write', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'mnemoweave-mcp-related-'))
  let mcp
  try {
    mcp = await connectMcp({
      entry: fileURLToPath(new URL('../../dist/mnemo-weave-mcp.js', import.meta.url)),
      env: { ...process.env, MNEMON_DATA_DIR: join(fixture, 'data'), MNEMON_STORAGE_SCOPE: 'global' },
    })
    const space = await mcp.call('mnemo_memory_body_create', { name: 'related-after-remember', description: 'Synthetic relation space.' })
    const spaceId = space.memoryBodyId
    await mcp.call('mnemo_memory_body_update', { memoryBodyId: spaceId, active: true })
    const first = await mcp.call('mnemo_remember', { content: 'Anchor-only recall token for the relation probe.', memoryBodyId: spaceId })
    const second = await mcp.call('mnemo_remember', { content: 'Neighbour memory of the anchor.', memoryBodyId: spaceId })
    const firstId = first.id ?? first.node?.id ?? first.memoryId
    const secondId = second.id ?? second.node?.id ?? second.memoryId
    await mcp.call('mnemo_link', { sourceId: firstId, targetId: secondId, memoryBodyId: spaceId })

    const recalled = await mcp.call('mnemo_recall', { query: 'Anchor-only token', memoryBodyIds: [spaceId] })
    assert.ok(recalled.results.some(item => item.id === firstId))
    await mcp.call('mnemo_remember', { content: 'Unrelated third memory after recall.', memoryBodyId: spaceId })
    const related = await mcp.call('mnemo_related', { id: firstId, memoryBodyId: spaceId })
    assert.notEqual(related.notRun, true, JSON.stringify(related))
    assert.ok(related.results.some(item => item.id === secondId), JSON.stringify(related))
  } finally {
    await mcp?.close().catch(() => undefined)
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
