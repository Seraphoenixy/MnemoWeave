// One sync run's progress record: what the page shows while it runs, and what
// the timer reads to decide whether another may start.
import test from 'node:test'
import assert from 'node:assert/strict'
import { SyncProgressRegistry } from '../../src/host/engine/sync-progress.ts'

const idle = { pulled: 0, pushed: 0, activityPulled: 0, activityPushed: 0 }

test('a run states its steps and how much of the current one moved', () => {
  const registry = new SyncProgressRegistry()
  const run = registry.begin()
  run.plan(3)
  run.step('snapshot', 'global-memory')
  run.transfer(1, 2)
  const view = registry.view()
  assert.equal(view.running, true)
  assert.equal(view.phase, 'snapshot')
  assert.equal(view.target, 'global-memory')
  assert.equal(view.step, 1)
  assert.equal(view.steps, 3)
  assert.deepEqual([view.done, view.total], [1, 2])
  assert.ok(!Number.isNaN(Date.parse(view.startedAt)))
})

test('a settled run ignores a later report from the same handle', () => {
  const registry = new SyncProgressRegistry()
  const run = registry.begin()
  run.finish({ pulled: 2, pushed: 1, activityPulled: 4, activityPushed: 5 })
  run.transfer(2, 2)
  run.fail(new Error('stale'))
  const settled = registry.view()
  assert.equal(settled.running, false)
  assert.equal(settled.last.state, 'done')
  assert.deepEqual(
    [settled.last.pulled, settled.last.pushed, settled.last.activityPulled, settled.last.activityPushed],
    [2, 1, 4, 5],
  )
})

test('the record is claimed in one step, never checked and then taken', () => {
  // Two callers arriving together must not both start a run: each would copy the
  // same storage roots while reporting the other's steps.
  const registry = new SyncProgressRegistry()
  const holders = [registry.claim(), registry.claim(), registry.claim()]
  assert.equal(holders.filter(Boolean).length, 1)
  assert.equal(registry.busy(), true)
  holders[0].fail(new Error('unreachable server'))
  assert.equal(registry.busy(), false)
  assert.equal(registry.last().state, 'failed')
})

test('a released record can be claimed again, so the timer keeps working', () => {
  const registry = new SyncProgressRegistry()
  registry.claim().fail(new Error('unreachable server'))
  const next = registry.claim()
  assert.ok(next)
  next.finish(idle)
  assert.equal(registry.busy(), false)
})
