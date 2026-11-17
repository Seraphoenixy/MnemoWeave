// What a workspace's snapshot merge does when both machines edited it.
//
// This drives the real Pack manager rather than a stand-in. A merge whose
// ordering, conflict ids or timestamps depended on the machine would pass a
// fake and still republish forever in practice.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MnemonPackManager } from '../../src/host/engine/pack.ts'
import { snapshotDigest } from '../../src/sync/client/snapshot.ts'
import { DocumentController } from '../../src/components/source-documents/src/controller.ts'

const INDEX = join('documents', 'index.json')

/** One managed Document on disk, the way the Documents Source lays one out. */
function seedDocument(root, id, title, body, workspaceRoot, status = 'active') {
  const filename = `${title}-${id.slice(0, 8)}.md`
  const relativePath = `documents/${status}/${filename}`
  mkdirSync(join(root, 'documents', status), { recursive: true })
  const markdown = `---\nid: ${JSON.stringify(id)}\ntitle: ${JSON.stringify(title)}\n---\n\n${body}\n`
  writeFileSync(join(root, relativePath), markdown, { mode: 0o600 })
  const record = {
    id, title, description: '', status, filename, relativePath, workspaceRoot,
    sourcePaths: [], sessionIds: [], createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z', lastAccessedAt: '2020-01-01T00:00:00.000Z',
    // The index states the managed file's own size, not the body's.
    revision: 1, contentHash: createHash('sha256').update(body).digest('hex'),
    sizeBytes: Buffer.byteLength(markdown), memoryBodyIds: [],
  }
  writeFileSync(join(root, INDEX), `${JSON.stringify({ version: 1, documents: [record] }, null, 2)}\n`, { mode: 0o600 })
  return record
}

function manager(root, name) {
  return new MnemonPackManager(
    { effectiveDataDir: () => join(root, name), withExclusive: operation => Promise.resolve(operation()) },
    { storageScope: 'workspaces', runtimeMemory: { memoryLimitBytes: 1_000_000, userLimitBytes: 1_000_000 } },
  )
}

async function workspace(run) {
  const root = await mkdtemp(join(tmpdir(), 'mnemo-merge-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

const always = () => true

test('a legacy cold-index path and digest still resolve to the original archived Markdown', async () => {
  await workspace(async root => {
    const store = join(root, 'shared')
    const original = 'Synthetic legacy diagnosis. Compare worker and lease epochs.'
    const record = seedDocument(store, 'c'.repeat(8), 'legacy-cold', original, root, 'archived')
    const oldPath = '.mnemon/' + record.relativePath
    const legacyIndex = `Stored document at ${oldPath}; SHA-256 ${record.contentHash}`
    writeFileSync(join(store, INDEX), JSON.stringify({ version: 1, documents: [{ ...record, relativePath: oldPath, memoryBodyIds: ['fixture'] }] }))
    const controller = new DocumentController(root, 1_000_000, undefined, store)
    const match = /at (\S+); SHA-256 ([0-9a-f]{64})/u.exec(legacyIndex)
    assert(match)
    assert.equal((await controller.search(match[1])).results.length, 0)
    const [document] = (await controller.search(match[1], { includeArchived: true })).results
    assert.equal(document.contentHash, match[2])
    assert.equal((await controller.search(match[2], { includeArchived: true })).results[0].id, document.id)
    assert.equal(controller.get(document.id).content, original)
    assert.deepEqual(controller.get(document.id).memoryBodyIds, ['fixture'])
  })
})

test('an unassigned legacy Document can be attached to a workspace without replacing its content', async () => {
  await workspace(async root => {
    const storage = join(root, 'shared')
    const id = 'e'.repeat(8)
    seedDocument(storage, id, 'legacy', 'Legacy decision', undefined)
    const controller = new DocumentController(root, 1_000_000, undefined, storage)
    const revision = controller.revision()
    const result = await controller.claimDocument(id, revision)
    assert.equal(result.document.workspaceRoot, root)
    assert.equal(result.document.id, id)
    assert.equal(result.document.content, 'Legacy decision')
    await assert.rejects(controller.claimDocument(id, revision), /changed|revision/iu)
    const reference = await controller.mutate({ action: 'create', title: 'Project decision', content: '', sourcePaths: [join(root, 'docs', 'adr.md')] })
    assert.deepEqual(reference.document.sourcePaths, ['docs/adr.md'])
    assert.equal(reference.document.content, '- "docs/adr.md"')
  })
})

test('a merge keeps both machines Documents', async () => {
  await workspace(async root => {
    seedDocument(join(root, 'left'), 'a'.repeat(8), 'alpha', 'left body', '/left/machine')
    seedDocument(join(root, 'right'), 'b'.repeat(8), 'beta', 'right body', '/right/machine')
    const left = manager(root, 'left')
    const right = manager(root, 'right')
    const leftSnapshot = await left.captureWorkspaceSync()
    const rightSnapshot = await right.captureWorkspaceSync()
    assert.notEqual(snapshotDigest(leftSnapshot.bytes), snapshotDigest(rightSnapshot.bytes))

    await left.mergeWorkspaceSync(rightSnapshot.bytes, always, '/left/machine')
    await right.mergeWorkspaceSync(leftSnapshot.bytes, always, '/right/machine')
    const afterLeft = JSON.parse(readFileSync(join(root, 'left', INDEX), 'utf8'))
    const afterRight = JSON.parse(readFileSync(join(root, 'right', INDEX), 'utf8'))
    assert.equal(afterLeft.documents.length, 2)
    assert.equal(afterRight.documents.length, 2)
  })
})

test("a merged Document names this machine's workspace, not the peer's path", async () => {
  // The path is local, so it must not travel: the same workspace has a different
  // directory on each machine. Without this the library would group a Document
  // under a workspace that does not exist here.
  await workspace(async root => {
    seedDocument(join(root, 'left'), 'a'.repeat(8), 'alpha', 'left body', '/left/machine')
    seedDocument(join(root, 'right'), 'b'.repeat(8), 'beta', 'right body', '/right/machine')
    const left = manager(root, 'left')
    const right = manager(root, 'right')
    const leftSnapshot = await left.captureWorkspaceSync()
    const rightSnapshot = await right.captureWorkspaceSync()
    await left.mergeWorkspaceSync(rightSnapshot.bytes, always, '/left/machine')
    await right.mergeWorkspaceSync(leftSnapshot.bytes, always, '/right/machine')
    const afterLeft = JSON.parse(readFileSync(join(root, 'left', INDEX), 'utf8'))
    const afterRight = JSON.parse(readFileSync(join(root, 'right', INDEX), 'utf8'))
    assert.ok(afterLeft.documents.every(document => document.workspaceRoot === '/left/machine'))
    assert.ok(afterRight.documents.every(document => document.workspaceRoot === '/right/machine'))
  })
})

test('a merge settles on byte-identical snapshots', async () => {
  // Without a canonical union each machine would republish the other's ordering
  // forever: the two sets are equal but the bytes are not.
  await workspace(async root => {
    seedDocument(join(root, 'left'), 'a'.repeat(8), 'alpha', 'left body', '/left/machine')
    seedDocument(join(root, 'right'), 'b'.repeat(8), 'beta', 'right body', '/right/machine')
    const left = manager(root, 'left')
    const right = manager(root, 'right')
    const leftSnapshot = await left.captureWorkspaceSync()
    const rightSnapshot = await right.captureWorkspaceSync()
    await left.mergeWorkspaceSync(rightSnapshot.bytes, always, '/left/machine')
    await right.mergeWorkspaceSync(leftSnapshot.bytes, always, '/right/machine')
    const leftUnion = await left.captureWorkspaceSync()
    const rightUnion = await right.captureWorkspaceSync()
    assert.equal(snapshotDigest(leftUnion.bytes), snapshotDigest(rightUnion.bytes), 'a merge must settle on identical bytes')
  })
})

test('merging the same content again adds nothing', async () => {
  await workspace(async root => {
    seedDocument(join(root, 'left'), 'a'.repeat(8), 'alpha', 'left body', '/left/machine')
    seedDocument(join(root, 'right'), 'b'.repeat(8), 'beta', 'right body', '/right/machine')
    const left = manager(root, 'left')
    const right = manager(root, 'right')
    const leftSnapshot = await left.captureWorkspaceSync()
    const rightSnapshot = await right.captureWorkspaceSync()
    await left.mergeWorkspaceSync(rightSnapshot.bytes, always, '/left/machine')
    await right.mergeWorkspaceSync(leftSnapshot.bytes, always, '/right/machine')
    const union = await left.captureWorkspaceSync()
    const peerUnion = await right.captureWorkspaceSync()
    // The derived conflict ids and the canonical order are stable, so a second
    // pass over the same peer snapshot is a no-op rather than a new copy.
    await left.mergeWorkspaceSync(peerUnion.bytes, always, '/left/machine')
    const again = await left.captureWorkspaceSync()
    assert.equal(snapshotDigest(again.bytes), snapshotDigest(union.bytes), 'a second merge must be a no-op')
    const index = JSON.parse(readFileSync(join(root, 'left', INDEX), 'utf8'))
    assert.equal(index.documents.length, 2, 'no copy was added')
  })
})
