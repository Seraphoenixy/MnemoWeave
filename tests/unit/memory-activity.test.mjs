// The memory activity a person reads on the Status page: newest first, the two
// streams merged, and only structured fields — never a body, a query or a path.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { activityKey } from '../../src/memory/activity.ts'
import { workingRulesActivityStore } from '../../src/memory/working-rules.ts'
import { workspaceActivityStore } from '../../src/host/review/activity-history.ts'
import { clearMemoryActivity, recentMemoryActivity } from '../../src/host/review/memory-activity.ts'

const read = {
  version: 1, kind: 'memory', id: activityKey('read-event'), at: 1_700_000_000_000,
  session: activityKey('session', 'synthetic'), turn: 1,
  source: 'memory-spaces', operation: 'recall', outcome: 'returned', results: 3,
}

const subagent = {
  version: 1, kind: 'subagent', id: activityKey('subagent-event'), at: 1_700_000_001_000,
  parentSession: activityKey('session', 'synthetic'), operation: 'answer', outcome: 'completed',
  durationMs: 1_200, committedWrites: 2,
}

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'mnemo-activity-'))
  // The global Working Rules stream lives under the data directory. It is read
  // from the environment by the Host's own entry points, so a case that clears
  // it has to point that variable at its disposable directory; it is restored
  // after every case even when the case throws.
  const previous = process.env.MNEMON_DATA_DIR
  process.env.MNEMON_DATA_DIR = join(root, 'working-rules')
  try {
    await run({ root, workspace: join(root, 'a-workspace') })
  } finally {
    if (previous === undefined) delete process.env.MNEMON_DATA_DIR
    else process.env.MNEMON_DATA_DIR = previous
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

test('both streams are read, newest first', async () => {
  await fixture(async ({ root, workspace }) => {
    const store = workspaceActivityStore(root, workspace)
    store.record({ ...read, at: 1_700_000_000_000 })
    store.record({ ...subagent, at: 1_700_000_005_000 })
    const records = recentMemoryActivity({ workspace: { root, path: workspace } })
    assert.equal(records.length, 2)
    assert.ok(records.every(record => record.stream === 'workspace'))
    assert.ok(records[0].at >= records[1].at, 'newest first')
  })
})

test('a memory event keeps its source, operation and outcome', async () => {
  await fixture(async ({ root, workspace }) => {
    workspaceActivityStore(root, workspace).record(read)
    const [record] = recentMemoryActivity({ workspace: { root, path: workspace } })
    assert.equal(record.kind, 'memory')
    assert.equal(record.source, 'memory-spaces')
    assert.equal(record.operation, 'recall')
    assert.equal(record.outcome, 'returned')
    assert.equal(record.results, 3)
  })
})

test('a delegated run reports its task type, duration and committed writes', async () => {
  await fixture(async ({ root, workspace }) => {
    workspaceActivityStore(root, workspace).record(subagent)
    const [record] = recentMemoryActivity({ workspace: { root, path: workspace } })
    assert.equal(record.kind, 'subagent')
    assert.equal(record.operation, 'answer')
    assert.equal(record.outcome, 'completed')
    assert.equal(record.durationMs, 1_200)
    assert.equal(record.committedWrites, 2)
  })
})

test('a skip reason travels with the event that skipped', async () => {
  await fixture(async ({ root, workspace }) => {
    workspaceActivityStore(root, workspace).record({ ...read, outcome: 'skipped', skipReason: 'budget' })
    const [record] = recentMemoryActivity({ workspace: { root, path: workspace } })
    assert.equal(record.outcome, 'skipped')
    assert.equal(record.skipReason, 'budget')
  })
})

test('a limit keeps the most recent lines, not the oldest', async () => {
  await fixture(async ({ root, workspace }) => {
    const store = workspaceActivityStore(root, workspace)
    store.record({ ...read, id: activityKey('later'), at: 1_700_000_009_000 })
    store.record({ ...read, at: 1_700_000_000_000 })
    const all = recentMemoryActivity({ workspace: { root, path: workspace } })
    const limited = recentMemoryActivity({ workspace: { root, path: workspace }, limit: 1 })
    assert.equal(limited.length, 1)
    assert.equal(limited[0].at, all[0].at)
  })
})

test('an absent workspace reads the global stream alone', async () => {
  await fixture(async ({ root, workspace }) => {
    workspaceActivityStore(root, workspace).record(read)
    const records = recentMemoryActivity({})
    assert.ok(records.every(record => record.stream === 'working rules'))
  })
})

test('a clear deletes the events it ends and keeps one boundary event', async () => {
  await fixture(async ({ root, workspace }) => {
    const store = workspaceActivityStore(root, workspace)
    store.record({ ...read, at: 1_700_000_000_000 })
    store.record({ ...subagent, at: 1_700_000_005_000 })
    assert.deepEqual(clearMemoryActivity({ workspace: { root, path: workspace } }), { workspace: 2, rules: 0 })
    assert.deepEqual(recentMemoryActivity({ workspace: { root, path: workspace } }), [])
    // The events are gone from disk, not hidden behind a growing list of what
    // was removed; what stays is the one event that marks where the stream now
    // starts, which is what travels to the server and to another client.
    const remaining = store.activityIds()
    assert.equal(remaining.length, 1)
    assert.equal(store.read(remaining[0]).kind, 'clear')
    // A second press on the emptied stream removes nothing, so it only moves the
    // boundary: the stream still holds exactly one boundary event.
    assert.deepEqual(clearMemoryActivity({ workspace: { root, path: workspace } }), { workspace: 0, rules: 0 })
    const after = store.activityIds()
    assert.equal(after.length, 1)
    assert.equal(store.read(after[0]).kind, 'clear')
  })
})

test('activity recorded after a clear is kept and listed again', async () => {
  await fixture(async ({ root, workspace }) => {
    const store = workspaceActivityStore(root, workspace)
    store.record(read)
    clearMemoryActivity({ workspace: { root, path: workspace } })
    const later = { ...subagent, id: activityKey('later-event'), at: Date.now() + 1_000 }
    store.record(later)
    const records = recentMemoryActivity({ workspace: { root, path: workspace } })
    assert.deepEqual(records.map(record => record.operation), ['answer'])
    assert.ok(store.activityIds().includes(later.id))
  })
})

test('another client applying a clear drops the events it ended', async () => {
  await fixture(async ({ root, workspace }) => {
    const store = workspaceActivityStore(root, workspace)
    store.record({ ...read, at: 1_700_000_000_000 })
    const older = { ...subagent, at: 1_700_000_005_000 }
    store.record(older)
    assert.equal(store.applyClear(1_700_000_009_000), 2)
    assert.deepEqual(recentMemoryActivity({ workspace: { root, path: workspace } }), [])
    assert.deepEqual(store.activityIds(), [])
    // Newer activity is not touched by a boundary that predates it.
    const newer = { ...subagent, id: activityKey('newer-event'), at: 1_700_000_020_000 }
    store.record(newer)
    assert.equal(store.applyClear(1_700_000_009_000), 0)
    assert.deepEqual(store.activityIds(), [newer.id])
  })
})

test('a clear covers the global stream beside the selected workspace', async () => {
  await fixture(async ({ root, workspace }) => {
    workspaceActivityStore(root, workspace).record(read)
    workingRulesActivityStore().record({ ...read, id: activityKey('rules-event'), source: 'runtime', operation: 'mutate', outcome: 'committed' })
    assert.deepEqual(clearMemoryActivity({ workspace: { root, path: workspace } }), { workspace: 1, rules: 1 })
    assert.deepEqual(recentMemoryActivity({ workspace: { root, path: workspace } }), [])
    // The clear event itself is a boundary, not a line on the page.
    assert.deepEqual(recentMemoryActivity({}), [])
  })
})

test('local failure details and usage are returned on status reads and removed on clear', async () => {
  await fixture(async ({ root, workspace }) => {
    const store = workspaceActivityStore(root, workspace)
    const failedSubagent = {
      ...subagent,
      id: activityKey('failed-subagent'),
      outcome: 'failed',
      usage: { uncachedInputTokens: 120, outputTokens: 35, cacheReadTokens: 10, cacheWriteTokens: 0 },
    }
    store.record(failedSubagent)
    store.recordDetail(failedSubagent.id, 'memory subagent completed without recording its result')
    const [record] = recentMemoryActivity({ workspace: { root, path: workspace } })
    assert.equal(record.outcome, 'failed')
    assert.equal(record.detail, 'memory subagent completed without recording its result')
    assert.deepEqual(record.usage, failedSubagent.usage)
    // Synced event JSON remains untouched (no local detail field inside events/).
    assert.equal('detail' in store.read(failedSubagent.id), false)
    clearMemoryActivity({ workspace: { root, path: workspace } })
    assert.equal(store.readDetail(failedSubagent.id), undefined)
  })
})
