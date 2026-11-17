// When the timer may start a run: switched on, a server configured, nothing in
// flight, and no conflict only a person can settle.
import test from 'node:test'
import assert from 'node:assert/strict'
import { AutoSyncScheduler } from '../../src/host/engine/auto-sync.ts'
import { SyncProgressRegistry } from '../../src/host/engine/sync-progress.ts'

const idle = { pulled: 0, pushed: 0, activityPulled: 0, activityPushed: 0 }
const enabled = { enabled: true, intervalMs: 60_000 }

test('a switched-off timer never runs', async () => {
  const registry = new SyncProgressRegistry()
  const scheduler = new AutoSyncScheduler(() => ({ enabled: false, intervalMs: 60_000 }), registry, async () => {})
  try {
    assert.equal(await scheduler.ready(), false)
  } finally { scheduler.dispose() }
})

test('a switched-on timer is ready when nothing holds the record', async () => {
  const registry = new SyncProgressRegistry()
  const scheduler = new AutoSyncScheduler(() => enabled, registry, async () => {})
  try {
    assert.equal(await scheduler.ready(), true)
  } finally { scheduler.dispose() }
})

test('a Host with no saved connection stays idle instead of failing every interval', async () => {
  // The check reads the credential store, so it answers with a promise.
  const registry = new SyncProgressRegistry()
  const scheduler = new AutoSyncScheduler(() => enabled, registry, async () => {}, async () => false)
  try {
    assert.equal(await scheduler.ready(), false)
  } finally { scheduler.dispose() }
})

test('a run in flight keeps the timer from starting another', async () => {
  const registry = new SyncProgressRegistry()
  const scheduler = new AutoSyncScheduler(() => enabled, registry, async () => {})
  try {
    const run = registry.begin()
    assert.equal(await scheduler.ready(), false)
    run.fail(new Error('server unreachable'))
  } finally { scheduler.dispose() }
})

test('a plain failure is retried on the next tick', async () => {
  const registry = new SyncProgressRegistry()
  const scheduler = new AutoSyncScheduler(() => enabled, registry, async () => {})
  try {
    registry.begin().fail(new Error('server unreachable'))
    assert.equal(await scheduler.ready(), true)
  } finally { scheduler.dispose() }
})

test('a conflict pauses the timer until it is resolved', async () => {
  const registry = new SyncProgressRegistry()
  const scheduler = new AutoSyncScheduler(() => enabled, registry, async () => {})
  try {
    registry.begin().fail(new Error('both copies changed'), 'global-memory')
    assert.equal(await scheduler.ready(), false)
    // A run that settles on no change clears the conflict, and the timer resumes.
    registry.begin().finish(idle)
    assert.equal(await scheduler.ready(), true)
  } finally { scheduler.dispose() }
})
