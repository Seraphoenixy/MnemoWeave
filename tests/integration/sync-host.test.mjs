// What a DSH Host synchronizes, and how two clients that name the same
// workspace differently end up holding the same content.
//
// A workspace scope merges instead of replacing: DSH derives a workspace id from
// the local absolute path, so two machines hold the same workspace under names
// that differ. A conflict there would make each machine's edits take turns
// overwriting the other's.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { activityKey } from '../../src/memory/activity.ts'
import { workspaceActivityStore } from '../../src/host/review/activity-history.ts'
import { createSyncHandler } from '../../src/host/surface/rpc.ts'
import { diagnostics } from '../../src/host/support/diagnostics.ts'
import { availablePort, startServer } from '../support/sync-fixtures.mjs'

const serverEntry = fileURLToPath(new URL('../../dist/mnemo-weave-sync-server.js', import.meta.url))

/**
 * One DSH Host stand-in over the real sync handler.
 *
 * The scope it synchronizes is a single byte string per workspace rather than a
 * whole Pack, so a case can say what each side holds and read the result. What
 * it exercises — the handler, the replica, the merge call, the run record — is
 * the production path.
 */
function host(fixture, machine, names, scope) {
  const directory = join(fixture, machine)
  const workspaces = names.map(name => ({ id: machine + '-' + name, title: name, path: join(directory, name) }))
  const memories = new Map(names.map(name => [name, Buffer.alloc(0)]))
  const split = text => text === '' ? [] : text.split(',')
  const union = (left, right) => [...new Set([...split(left), ...split(right)])].sort().join(',')
  let credential
  const credentials = {
    readRecord: async () => credential,
    modifyRecord: async (_key, mutate) => { credential = await mutate(credential) },
  }
  const runtime = {
    config: scope,
    snapshot: () => ({ config: scope, directory }),
    syncWorkspaces: () => workspaces,
    forWorkspaceId: id => {
      const workspace = workspaces.find(entry => entry.id === id)
      return {
        directory: workspace.path,
        memoryComposition: { current: () => undefined },
        packs: {
          captureWorkspaceSync: async () => {
            const bytes = memories.get(workspace.title)
            return { bytes, entries: { 'content.bin': bytes }, empty: bytes.length === 0 }
          },
          assembleWorkspaceSync: entries => Buffer.from(entries['content.bin'] ?? Buffer.alloc(0)),
          replaceWorkspaceSync: async (bytes, matches) => {
            assert.ok(matches(memories.get(workspace.title)))
            memories.set(workspace.title, bytes)
          },
          mergeWorkspaceSync: async (bytes, matches) => {
            assert.ok(matches(memories.get(workspace.title)))
            memories.set(workspace.title, Buffer.from(union(memories.get(workspace.title).toString('utf8'), bytes.toString('utf8'))))
          },
        },
      }
    },
  }
  return { handler: createSyncHandler(runtime, undefined, () => credentials), workspaces, memories }
}

async function withServer(run) {
  const fixture = await mkdtemp(join(tmpdir(), 'mnemoweave-host-'))
  const data = join(fixture, 'store')
  const password = randomBytes(4).toString('hex')
  const env = { ...process.env, NODE_PATH: '', MNEMOWEAVE_SYNC_DATA_DIR: data, MNEMOWEAVE_SYNC_AUTH_FILE: join(data, 'auth.json') }
  const copy = join(fixture, 'server.mjs')
  const servers = []
  const restore = new Map()
  try {
    await copyFile(serverEntry, copy)
    spawnSync(process.execPath, [copy, '--init-auth'], { cwd: fixture, env, input: password + '\n', encoding: 'utf8', timeout: 10_000 })
    for (const key of ['MNEMOWEAVE_SYNC_URL', 'MNEMOWEAVE_SYNC_PASSWORD', 'MNEMON_DATA_DIR']) restore.set(key, process.env[key])
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
    for (const [key, value] of restore) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    for (const server of servers) await server.stop()
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

/** Two hosts over one server, each configured with the workspace scope. */
async function twoHosts(input) {
  const { fixture, password, base, start, names } = input
  await start()
  process.env.MNEMON_DATA_DIR = join(fixture, 'dsh-working-rules')
  const scope = { storageScope: 'workspaces', writeEnabled: true }
  const sender = host(fixture, 'sender', names, scope)
  const receiver = host(fixture, 'receiver', [...names].reverse(), scope)
  for (const entry of [sender, receiver]) {
    const saved = await entry.handler('save-connection', { url: base, password }, AbortSignal.timeout(10_000))
    assert.deepEqual(saved, { ok: true, value: { url: base + '/', configured: true, writable: true } })
    assert.deepEqual(await entry.handler('connection', {}), saved)
  }
  delete process.env.MNEMOWEAVE_SYNC_URL
  delete process.env.MNEMOWEAVE_SYNC_PASSWORD
  return { sender, receiver }
}

const idle = { ok: true, value: { pulled: 0, pushed: 0, activityPulled: 0, activityPushed: 0 } }

test('a first sync publishes, a second pulls, and a third moves nothing', async () => {
  await withServer(async ({ fixture, password, base, port, start }) => {
    const { sender, receiver } = await twoHosts({ fixture, password, base, port, start, names: ['global-project', '第二个项目'] })
    sender.memories.set('global-project', Buffer.from('project A'))
    sender.memories.set('第二个项目', Buffer.from('project B'))
    const firstWorkspace = sender.workspaces[0].path
    const senderActivity = workspaceActivityStore(firstWorkspace, firstWorkspace)
    const newEvent = { version: 1, kind: 'memory', id: activityKey('new-global-event'), source: 'memory-spaces', operation: 'recall', outcome: 'returned', results: 1 }
    senderActivity.record(newEvent)

    const pushed = await sender.handler('sync-all', {})
    assert.equal(pushed.ok, true, JSON.stringify(pushed))
    assert.equal(pushed.value.pushed, 2)
    const pulled = await receiver.handler('sync-all', {})
    assert.equal(pulled.ok, true, JSON.stringify(pulled))
    assert.equal(pulled.value.pulled, 2)
    assert.deepEqual(receiver.memories, sender.memories)
    // Activity travels on its own stream and reached the receiver's own directory.
    const receivingPath = receiver.workspaces.find(entry => entry.title === 'global-project').path
    assert.ok(workspaceActivityStore(receivingPath, receivingPath).activityIds().includes(newEvent.id))
    assert.deepEqual(await receiver.handler('sync-all', {}), idle)
  })
})

test('two edits to one workspace both survive and the copies settle', async () => {
  await withServer(async ({ fixture, password, base, port, start }) => {
    const { sender, receiver } = await twoHosts({ fixture, password, base, port, start, names: ['global-project', '第二个项目'] })
    sender.memories.set('global-project', Buffer.from('project A'))
    sender.memories.set('第二个项目', Buffer.from('project B'))
    assert.equal((await sender.handler('sync-all', {})).ok, true)
    assert.equal((await receiver.handler('sync-all', {})).ok, true)

    receiver.memories.set('第二个项目', Buffer.from('receiver edit'))
    sender.memories.set('第二个项目', Buffer.from('sender edit'))
    const senderMerge = await sender.handler('sync-all', {})
    assert.equal(senderMerge.ok, true, JSON.stringify(senderMerge))
    const receiverMerge = await receiver.handler('sync-all', {})
    assert.equal(receiverMerge.ok, true, JSON.stringify(receiverMerge))
    // The receiver took the sender's edit and kept its own.
    assert.equal(receiver.memories.get('第二个项目').toString('utf8'), 'project B,receiver edit,sender edit')
    // One more pass on the sender gives it the receiver's edit too.
    assert.equal((await sender.handler('sync-all', {})).ok, true)
    assert.equal(sender.memories.get('第二个项目').toString('utf8'), 'project B,receiver edit,sender edit')
    // Settled: both hold the same union, so neither republishes it.
    assert.deepEqual(await sender.handler('sync-all', {}), idle)
    assert.deepEqual(await receiver.handler('sync-all', {}), idle)
    const progress = await receiver.handler('progress', {})
    assert.equal(progress.value.last.state, 'done')
    assert.equal(progress.value.last.conflictTarget, undefined)
  })
})

test('an idle run is summarized in two lines, not one per scope', async () => {
  await withServer(async ({ fixture, password, base, port, start }) => {
    const { receiver } = await twoHosts({ fixture, password, base, port, start, names: ['global-project', '第二个项目'] })
    assert.equal((await receiver.handler('sync-all', {})).ok, true)
    diagnostics.clear()
    const idleRun = await receiver.handler('sync-all', {})
    assert.equal(idleRun.ok, true, JSON.stringify(idleRun))
    assert.deepEqual(
      [idleRun.value.pulled, idleRun.value.pushed, idleRun.value.activityPulled, idleRun.value.activityPushed],
      [0, 0, 0, 0],
    )
    // Three snapshots (Working Rules and both workspaces) and three activity
    // streams, reported as one line per group.
    const lines = diagnostics.recent()
    assert.deepEqual(lines.map(entry => entry.message),
      ['Sync finished', 'activity: 3 scopes unchanged', 'memory: 3 ranges unchanged', 'Sync started'])
    assert.match(lines[1].detail, /^\d+ ms$/u)
    diagnostics.clear()
  })
})

test('a scope that moved is named by its workspace, not its hashed key', async () => {
  await withServer(async ({ fixture, password, base, port, start }) => {
    const { sender, receiver } = await twoHosts({ fixture, password, base, port, start, names: ['global-project', '第二个项目'] })
    // Both sides need content before a merge can happen at all: a scope whose
    // local copy is empty simply pulls, and one the peer lacks simply publishes.
    sender.memories.set('第二个项目', Buffer.from('project B'))
    assert.equal((await sender.handler('sync-all', {})).ok, true)
    assert.equal((await receiver.handler('sync-all', {})).ok, true)
    diagnostics.clear()
    sender.memories.set('第二个项目', Buffer.from('sender edit'))
    const moved = await sender.handler('sync-all', {})
    assert.equal(moved.ok, true, JSON.stringify(moved))
    const messages = diagnostics.recent().map(entry => entry.message)
    assert.ok(messages.includes('第二个项目: merged'), messages.join('\n'))
    assert.ok(!messages.some(message => message.startsWith('activity-workspace-')), 'no hashed scope key is shown')
    diagnostics.clear()
  })
})
