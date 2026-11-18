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
    assert.deepEqual(Object.keys(mutation.inputSchema.properties).sort(), ['action', 'branches', 'content', 'importance', 'old_text'])
    assert.deepEqual(mutation.inputSchema.properties.action.enum, ['add', 'replace', 'remove'])
    const write = args => mcp.call('mnemo_runtime_memory', args)
    const read = args => mcp.call('mnemo_working_rules', args)
    await write({ action: 'add', content: 'Synthetic standing rule', importance: 'critical' })
    await write({ action: 'add', content: 'Synthetic branch rule', branches: ['feature/test'] })
    assert.equal((await read({})).entries.length, 1)
    assert.equal((await read({ branch: 'feature/test' })).entries.length, 2)
    assert.equal((await read({ branch: 'main' })).entries.length, 1)
    await write({ action: 'replace', old_text: 'Synthetic standing rule', content: 'Synthetic replacement rule', importance: 'low' })
    assert.deepEqual((await read({})).entries, [{ content: 'Synthetic replacement rule', importance: 'low' }])
    await write({ action: 'replace', old_text: 'Synthetic branch rule', content: 'Synthetic updated branch rule' })
    assert.deepEqual((await read({ branch: 'feature/test' })).entries[1].branches, ['feature/test'])
    await write({ action: 'replace', old_text: 'Synthetic updated branch rule', content: 'Synthetic unscoped rule', branches: [] })
    assert.equal((await read({})).entries.length, 2)
    await assert.rejects(write({ action: 'add' }), /content/u)
    await assert.rejects(write({ action: 'add', content: 'Rejected target rule', target: 'user' }), /target/u)
    await assert.rejects(write({ action: 'remove', old_text: 'Synthetic' }), /Multiple/u)
    await write({ action: 'remove', old_text: 'Synthetic replacement rule' })
    assert.deepEqual((await read({})).entries, [{ content: 'Synthetic unscoped rule', importance: 'normal' }])
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
