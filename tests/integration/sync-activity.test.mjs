// Activity records travel as immutable events on their own scope: two clients
// appending at once both keep their events, and a repeated sync moves nothing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { activityKey, ActivityStore } from '../../src/memory/activity.ts'
import { activityScope, connectActivitySync } from '../../src/sync/client/activity.ts'
import { SyncClient } from '../../src/sync/client/http.ts'
import { availablePort, startServer } from '../support/sync-fixtures.mjs'

const serverEntry = fileURLToPath(new URL('../../dist/mnemo-weave-sync-server.js', import.meta.url))

async function withServer(run) {
  const fixture = await mkdtemp(join(tmpdir(), 'mnemoweave-activity-'))
  const data = join(fixture, 'store')
  const password = randomBytes(4).toString('hex')
  const env = { ...process.env, NODE_PATH: '', MNEMOWEAVE_SYNC_DATA_DIR: data, MNEMOWEAVE_SYNC_AUTH_FILE: join(data, 'auth.json') }
  const copy = join(fixture, 'server.mjs')
  const servers = []
  try {
    await copyFile(serverEntry, copy)
    spawnSync(process.execPath, [copy, '--init-auth'], { cwd: fixture, env, input: password + '\n', encoding: 'utf8', timeout: 10_000 })
    const port = await availablePort()
    const base = 'http://127.0.0.1:' + port
    const start = async () => {
      const server = startServer({ command: process.execPath, args: [copy], env, directory: fixture, port, token: password })
      servers.push(server)
      await server.ready
      return server
    }
    await run({ fixture, password, base, port, start })
  } finally {
    for (const server of servers) await server.stop()
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

const read = {
  version: 1, kind: 'memory', id: activityKey('fixture-read'),
  source: 'memory-spaces', operation: 'recall', outcome: 'skipped', skipReason: 'budget', results: 0,
}
const subagent = {
  version: 1, kind: 'subagent', id: activityKey('fixture-run'),
  operation: 'review', trigger: 'automatic-distillation', outcome: 'skipped',
  skipReason: 'no-writable-target', durationMs: 0, committedWrites: 0,
}

test('two clients appending at once both keep their events', async () => {
  await withServer(async ({ fixture, password, base, start }) => {
    await start()
    const scope = activityScope('synthetic-project')
    const firstStore = new ActivityStore(join(fixture, 'activity-a'))
    const secondStore = new ActivityStore(join(fixture, 'activity-b'))
    firstStore.save(read)
    secondStore.save(subagent)
    const firstSync = connectActivitySync({ url: base, password, scope }, firstStore)
    const secondSync = connectActivitySync({ url: base, password, scope }, secondStore)
    await Promise.all([firstSync(), secondSync()])
    // A second pass is what proves the merge was not a last-writer-wins copy.
    await Promise.all([firstSync(), secondSync()])
    assert.deepEqual(firstStore.activityIds(), [read.id, subagent.id].sort())
    assert.deepEqual(secondStore.activityIds(), firstStore.activityIds())
    assert.deepEqual(firstStore.read(subagent.id), subagent)
    // Once both hold everything, a run moves nothing.
    assert.deepEqual(await firstSync(), { cursor: 2, pushed: 0, pulled: 0 })
  })
})

test('a different scope carries only its own events', async () => {
  await withServer(async ({ fixture, password, base, start }) => {
    await start()
    const store = new ActivityStore(join(fixture, 'activity-a'))
    store.save(read)
    store.save(subagent)
    await connectActivitySync({ url: base, password, scope: activityScope('synthetic-project') }, store)()
    const separateScope = activityScope('separate-project')
    // The new scope has confirmed nothing yet, so it publishes the local events it
    // holds — both, in the one batch the run sent.
    const separate = await connectActivitySync({ url: base, password, scope: separateScope }, store)()
    assert.equal(separate.pushed, 2)
    assert.equal(separate.pulled, 0)
    const history = await new SyncClient(base, separateScope, password).pull(0)
    assert.deepEqual(history.batches.flatMap(batch => batch.changes.map(change => change.key)).sort(), [read.id, subagent.id].sort())
  })
})

test('an event ID is never overwritten or deleted', async () => {
  await withServer(async ({ fixture, password, base, start }) => {
    await start()
    const scope = activityScope('synthetic-project')
    const store = new ActivityStore(join(fixture, 'activity-a'))
    store.save(read)
    await connectActivitySync({ url: base, password, scope }, store)()
    const client = new SyncClient(base, scope, password)
    const head = (await client.pull(0)).head
    // The server keeps the event log append-only, so a delete and a rewrite of an
    // existing id are both refused where they are attempted.
    await assert.rejects(client.push({ requestId: crypto.randomUUID(), baseCursor: head, changes: [{ key: read.id, operation: 'delete' }] }), /HTTP 400/u)
    await assert.rejects(client.push({ requestId: crypto.randomUUID(), baseCursor: head, changes: [{ key: read.id, operation: 'put', value: { ...read, results: 1 } }] }), /already exists/u)
  })
})

test('a clear reaches another client and the server drops what it ended', async () => {
  await withServer(async ({ fixture, password, base, start }) => {
    await start()
    const scope = activityScope('synthetic-project')
    const first = new ActivityStore(join(fixture, 'activity-a'))
    const second = new ActivityStore(join(fixture, 'activity-b'))
    first.save(read)
    first.save(subagent)
    const firstSync = connectActivitySync({ url: base, password, scope }, first)
    const secondSync = connectActivitySync({ url: base, password, scope }, second)
    // The first pass publishes and the second carries the batch to the other
    // client, whose own run may have looked before the batch landed.
    await Promise.all([firstSync(), secondSync()])
    await Promise.all([firstSync(), secondSync()])
    assert.deepEqual(second.activityIds().sort(), [read.id, subagent.id].sort())
    const before = (await new SyncClient(base, scope, password).pull(0)).head

    // Clearing deletes the events and publishes one boundary event. The server
    // keeps that boundary as the whole scope: the batches that carried the
    // cleared events are gone, not archived.
    first.applyClear(Date.now() + 1_000)
    assert.equal(first.clear(Date.now() + 1_000), 0)
    const cleared = await firstSync()
    assert.equal(cleared.pushed, 1)
    const history = await new SyncClient(base, scope, password).pull(0)
    // One batch remains, the clear, and it is the only thing a reader can still
    // find: everything before it was dropped rather than tombstoned.
    assert.equal(history.batches.length, 1)
    assert.deepEqual(history.batches[0].changes.map(change => change.value.kind), ['clear'])
    assert.ok(history.head > before || history.batches.length === 1)

    // The other client adopts the boundary, drops its own copies, and settles.
    assert.deepEqual(second.activityIds().sort(), [read.id, subagent.id].sort())
    await secondSync()
    assert.deepEqual(second.activityIds().length, 1)
    assert.equal(second.read(second.activityIds()[0]).kind, 'clear')
    const settled = await secondSync()
    assert.equal(settled.pushed, 0)
    assert.equal(settled.pulled, 0)
  })
})

test('a client whose cursor the clear outran still synchronizes', async () => {
  await withServer(async ({ fixture, password, base, start }) => {
    await start()
    const scope = activityScope('synthetic-project')
    const first = new ActivityStore(join(fixture, 'activity-a'))
    const second = new ActivityStore(join(fixture, 'activity-b'))
    first.save(read)
    first.save(subagent)
    const firstSync = connectActivitySync({ url: base, password, scope }, first)
    const secondSync = connectActivitySync({ url: base, password, scope }, second)
    await Promise.all([firstSync(), secondSync()])
    await Promise.all([firstSync(), secondSync()])
    // The second client stops here, holding cursor 2.
    // The first clears, and the scope shrinks to the one boundary batch. A
    // cursor ahead of the new head is answered with the stream from its start
    // rather than locking that client out of a stream that legitimately shrank.
    first.applyClear(Date.now() + 1_000)
    assert.equal(first.clear(Date.now() + 1_000), 0)
    await firstSync()
    const result = await secondSync()
    assert.equal(result.pulled, 1)
    assert.deepEqual(second.activityIds().length, 1)
    assert.equal(second.read(second.activityIds()[0]).kind, 'clear')
  })
})
