// Blob collection walks backwards one batch at a time and stops at the first
// manifest. It must find that manifest when non-manifest batches follow it, and
// it must terminate: the walk advances strictly downward by cursor.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SqliteSyncStore } from '../../src/sync/server/sqlite.ts'

const digest = text => createHash('sha256').update(text).digest('hex')

test('a manifest behind non-manifest batches is still found', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mnemo-walk-'))
  const store = new SqliteSyncStore(join(directory, 'sync.sqlite'))
  try {
    const scope = 'workspace-walk'
    const pushBatch = changes => store.push(scope, {
      requestId: randomUUID(), baseCursor: store.pull(scope, 0).head, changes,
    })
    for (const text of ['live one', 'live two']) store.putBlob(scope, digest(text), Buffer.from(text))
    pushBatch([{ key: 'memory-snapshot', operation: 'put', value: {
      bytes: 'a'.repeat(64),
      files: [{ path: 'a.md', digest: digest('live one') }, { path: 'b.md', digest: digest('live two') }],
    } }])
    // Two later batches that carry no manifest at all.
    pushBatch([{ key: 'unrelated', operation: 'put', value: { note: 1 } }])
    pushBatch([{ key: 'unrelated-2', operation: 'put', value: { note: 2 } }])
    // Age every blob so the prune has something to consider.
    store.db.prepare('UPDATE sync_blobs SET created_at = 0').run()
    store.pruneBlobs(scope)
    assert.equal(store.hasBlob(scope, digest('live one')), true, 'the walk finds a manifest behind non-manifest batches')
    assert.equal(store.hasBlob(scope, digest('live two')), true)
  } finally {
    store.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('a blob no manifest names is pruned', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mnemo-walk-'))
  const store = new SqliteSyncStore(join(directory, 'sync.sqlite'))
  try {
    const scope = 'workspace-prune'
    store.putBlob(scope, digest('orphan'), Buffer.from('orphan'))
    store.putBlob(scope, digest('live'), Buffer.from('live'))
    store.push(scope, {
      requestId: randomUUID(), baseCursor: 0,
      changes: [{ key: 'memory-snapshot', operation: 'put', value: {
        bytes: 'a'.repeat(64), files: [{ path: 'a.md', digest: digest('live') }],
      } }],
    })
    store.db.prepare('UPDATE sync_blobs SET created_at = 0').run()
    store.pruneBlobs(scope)
    assert.equal(store.hasBlob(scope, digest('live')), true)
    assert.equal(store.hasBlob(scope, digest('orphan')), false)
  } finally {
    store.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
