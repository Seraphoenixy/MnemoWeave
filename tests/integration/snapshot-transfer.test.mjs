// A scope is addressed file by file: a run moves only the entries whose content
// differs, and a push refused by a concurrent commit is retried rather than
// ending the run.
//
// The remote is a stand-in with counters, because what is being checked is the
// number of transfers, not the wire format.
import test from 'node:test'
import assert from 'node:assert/strict'
import { strToU8, zipSync } from 'fflate'
import { SnapshotSync, snapshotDigest } from '../../src/sync/client/snapshot.ts'
import { RemoteSyncConflict } from '../../src/sync/client/remote.ts'

/** The deterministic archive the replica assembles: fixed order, fixed mtime. */
const archive = entries => Buffer.from(zipSync(
  Object.fromEntries(Object.keys(entries).sort().map(path => [path, entries[path]])),
  { level: 6, mtime: new Date(1980, 0, 1) },
))

const bytesOf = record => Object.fromEntries(Object.entries(record).map(([path, text]) => [path, strToU8(text)]))

/** A replica over an in-memory file set, counting what the transport carried. */
function replica(transport, files = {}) {
  let state
  let received
  const sync = new SnapshotSync(transport, {
    async capture() {
      const entries = bytesOf(files)
      return { bytes: archive(entries), entries, empty: Object.keys(entries).length === 0 }
    },
    async apply(bytes) { received = bytes },
    assemble: entries => archive(entries),
    load() { return state },
    save(value) { state = value },
  })
  return { run: options => sync.sync(options), set: value => { files = value }, received: () => received }
}

const first = { 'manifest.json': '{"v":1}', 'payload/a.md': 'alpha', 'payload/b.md': 'beta' }
const changed = { ...first, 'payload/a.md': 'alpha changed' }

test('a first publish sends every entry', async () => {
  const calls = { uploads: 0, downloads: 0 }
  const transport = {
    pull: async () => ({ cursor: 0, head: 0, batches: [] }),
    push: async () => 1,
    uploadBlob: async () => { calls.uploads += 1 },
    downloadBlob: async () => { throw new Error('nothing to download') },
  }
  const source = replica(transport, first)
  const result = await source.run()
  assert.equal(result.action, 'pushed')
  assert.equal(calls.uploads, 3)
  assert.equal(calls.downloads, 0)
})

test('changing one file of three uploads one entry', async () => {
  // A recorded manifest names the earlier digests, so republishing reuses the
  // blobs the peer already stored.
  const calls = { uploads: 0, downloads: 0 }
  const firstBytes = bytesOf(first)
  const recorded = {
    bytes: snapshotDigest(archive(firstBytes)),
    files: Object.entries(firstBytes).map(([path, bytes]) => ({ path, digest: snapshotDigest(bytes) })),
  }
  const transport = {
    pull: async () => ({ cursor: 1, head: 1, batches: [{ cursor: 1, changes: [{ key: 'memory-snapshot', operation: 'put', value: recorded }] }] }),
    push: async () => 2,
    uploadBlob: async () => { calls.uploads += 1 },
    downloadBlob: async () => { throw new Error('nothing to download') },
  }
  let saved
  const sync = new SnapshotSync(transport, {
    async capture() {
      const entries = bytesOf(changed)
      return { bytes: archive(entries), entries, empty: false }
    },
    async apply() {},
    assemble: entries => archive(entries),
    load() { return { cursor: 1, remote: recorded } },
    save(value) { saved = value },
  })
  await sync.sync({})
  assert.equal(calls.uploads, 1, 'one new entry is uploaded')
  assert.ok(saved.remote.files.length === 3)
})

test('progress counts the files that moved, not the files examined', async () => {
  const peerFiles = { 'manifest.json': bytesOf(first)['manifest.json'], 'payload/a.md': strToU8('alpha'), 'payload/b.md': strToU8('beta on the peer'), 'payload/c.md': strToU8('gamma') }
  const peerArchive = archive(peerFiles)
  const heldEntries = Object.fromEntries(Object.entries(peerFiles).filter(([path]) => path !== 'payload/b.md'))
  const store = new Map(Object.entries(peerFiles).map(([path, bytes]) => [snapshotDigest(bytes), bytes]))
  const transport = {
    pull: async () => ({
      cursor: 1, head: 1,
      batches: [{ cursor: 1, changes: [{ key: 'memory-snapshot', operation: 'put', value: {
        bytes: snapshotDigest(peerArchive),
        files: Object.entries(peerFiles).map(([path, bytes]) => ({ path, digest: snapshotDigest(bytes) })),
      } }] }],
    }),
    push: async () => 2,
    uploadBlob: async () => {},
    downloadBlob: async digest => store.get(digest),
  }
  const reports = []
  const sync = new SnapshotSync(transport, {
    async capture() { return { bytes: archive(heldEntries), entries: heldEntries, empty: false } },
    async apply() {},
    assemble: entries => archive(entries),
    load() {
      return { cursor: 0, remote: {
        bytes: snapshotDigest(archive(heldEntries)),
        files: Object.entries(heldEntries).map(([path, bytes]) => ({ path, digest: snapshotDigest(bytes) })),
      } }
    },
    save() {},
  })
  await sync.sync({ transfer: progress => reports.push(progress) })
  assert.deepEqual(reports, [{ done: 1, total: 1 }], 'one file moved, so one file is reported')
})

test('a refused push is retried and settles instead of ending the run', async () => {
  // The retry re-reads the peer's manifest; when both copies then hold the same
  // content it settles as "unchanged" rather than asking which copy to keep.
  const recordedEntries = bytesOf({ 'manifest.json': '{"v":1}', 'payload/a.md': 'shared' })
  const localEntries = bytesOf({ 'manifest.json': '{"v":1}', 'payload/a.md': 'locally edited' })
  const manifestOf = entries => ({
    bytes: snapshotDigest(archive(entries)),
    files: Object.entries(entries).map(([path, bytes]) => ({ path, digest: snapshotDigest(bytes) })),
  })
  let pulls = 0
  let pushes = 0
  const sync = new SnapshotSync({
    async pull() {
      pulls += 1
      // The peer first holds the recorded archive, so this run publishes; it then
      // reports the local content, as a concurrent identical write would.
      const manifest = manifestOf(pulls === 1 ? recordedEntries : localEntries)
      return { cursor: pulls, head: pulls, batches: [{ cursor: pulls, changes: [{ key: 'memory-snapshot', operation: 'put', value: manifest }] }] }
    },
    async push() { pushes += 1; throw new RemoteSyncConflict(pulls, 'the peer committed a newer batch') },
    async uploadBlob() {},
    async downloadBlob(digest) {
      for (const bytes of [...Object.values(recordedEntries), ...Object.values(localEntries)]) if (snapshotDigest(bytes) === digest) return bytes
      throw new Error('unknown blob')
    },
  }, {
    async capture() { return { bytes: archive(localEntries), entries: localEntries, empty: false } },
    async apply() {},
    assemble: entries => archive(entries),
    load() { return { cursor: 0, remote: manifestOf(recordedEntries) } },
    save() {},
  })
  const outcome = await sync.sync({})
  assert.equal(outcome.action, 'unchanged', 'a refused push is retried and settles')
  assert.equal(pushes, 1)
  assert.equal(pulls, 2, 'the retry re-reads the peer manifest')
})

test('a second run with nothing changed moves nothing', async () => {
  let pulls = 0
  const calls = { uploads: 0, downloads: 0 }
  const entries = bytesOf(first)
  const manifest = {
    bytes: snapshotDigest(archive(entries)),
    files: Object.entries(entries).map(([path, bytes]) => ({ path, digest: snapshotDigest(bytes) })),
  }
  const sync = new SnapshotSync({
    async pull() { pulls += 1; return { cursor: 1, head: 1, batches: [{ cursor: 1, changes: [{ key: 'memory-snapshot', operation: 'put', value: manifest }] }] } },
    async push() { throw new Error('nothing should be pushed') },
    async uploadBlob() { calls.uploads += 1 },
    async downloadBlob() { calls.downloads += 1 },
  }, {
    async capture() { return { bytes: archive(entries), entries, empty: false } },
    async apply() {},
    assemble: entries => archive(entries),
    load() { return { cursor: 1, remote: manifest } },
    save() {},
  })
  assert.equal((await sync.sync({})).action, 'unchanged')
  assert.deepEqual(calls, { uploads: 0, downloads: 0 })
})

test('a state file from the block-based build is re-published, not rejected', async () => {
  // `{ digest, blocks }` names an archive this build cannot rebuild. Refusing it
  // would leave the scope unable to synchronize at all, so the cursor is kept
  // and only the manifest is dropped.
  let state = { cursor: 0, remote: { digest: 'a'.repeat(64), blocks: ['b'.repeat(64)] } }
  const entries = bytesOf({ 'manifest.json': '{"v":1}', 'payload/a.md': 'alpha' })
  const sync = new SnapshotSync({
    async pull() { return { cursor: 0, head: 0, batches: [] } },
    async push() { return 3 },
    async uploadBlob() {},
    async downloadBlob() { throw new Error('a legacy state must not pull') },
  }, {
    async capture() { return { bytes: archive(entries), entries, empty: false } },
    async apply() { throw new Error('a legacy state must not pull') },
    assemble: entries => archive(entries),
    load() { return state },
    save(value) { state = value },
  })
  assert.equal((await sync.sync({})).action, 'pushed')
  assert.ok(Array.isArray(state.remote.files), 'the state is rewritten in the file manifest form')
  assert.equal(state.remote.blocks, undefined)
})

test('a merge request against a scope that cannot merge is refused', async () => {
  // Falling back to replacing one side's content with the other's would lose
  // exactly what the caller asked to keep.
  const sync = new SnapshotSync({
    pull: async () => ({ cursor: 0, head: 0, batches: [] }),
    push: async () => 1,
    uploadBlob: async () => {},
    downloadBlob: async () => { throw new Error('nothing to download') },
  }, {
    async capture() { return { bytes: archive(bytesOf(first)), entries: bytesOf(first), empty: false } },
    async apply() {},
    assemble: entries => archive(entries),
    load() { return undefined },
    save() {},
  })
  await assert.rejects(sync.sync({ merge: true }), /cannot merge/u)
})
