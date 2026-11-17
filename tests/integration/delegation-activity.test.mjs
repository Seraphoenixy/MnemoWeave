// What a delegated run records about itself, and what it must never record.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { activityKey } from '../../src/memory/activity.ts'
import { MnemonSubagentCoordinator } from '../../src/host/delegation/subagent.ts'
import { workspaceActivityStore } from '../../src/host/review/activity-history.ts'
import { recentMemoryActivity } from '../../src/host/review/memory-activity.ts'
import { createWriteHandler } from '../../src/host/surface/rpc.ts'

async function delegated(run) {
  const fixture = await mkdtemp(join(tmpdir(), 'mnemo-delegation-'))
  const callbacks = new Map()
  const on = (name, callback) => {
    const listeners = callbacks.get(name) ?? new Set()
    callbacks.set(name, listeners)
    listeners.add(callback)
    return () => listeners.delete(callback)
  }
  const session = (events, header = {}) => ({
    header: { cwd: fixture, ...header }, seq: events.length, surface: { nodes: [] },
    eventAt: offset => events[offset], snapshotEvents: (start, end) => events.slice(start, end),
  })
  const parent = { id: 'fixture-parent', session: session([{ type: 'turn/start', seq: 0, data: { turn: 5 } }]), ctx: {} }
  const child = {
    id: 'fixture-child', ctx: { systemPrompt: { section() {}, getSectionOrder: () => 0 }, tools: { restrict() {} } },
    session: session([
      { type: 'assistant/message', data: { turn: 4, step: 1, usage: { inputTokens: 100, outputTokens: 10 } } },
      { type: 'subagent/descriptor', data: {} },
      { type: 'assistant/chunk', data: { turn: 0, step: 1, chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 1 } } } },
      { type: 'assistant/message', data: { turn: 0, step: 1, usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 2 } } },
    ], { origin: 'subagent', parentSession: parent.id }),
  }
  let stopReason = 'completed'
  const answer = 'Synthetic answer excluded from activity'
  let structured = { answer, citations: [] }
  const subagents = {
    list: () => ['spawn'],
    getProvider: () => ({ capabilities: { depthLimit: true }, prepareContinuable() {} }),
    async startActivation() {
      for (const listener of callbacks.get('agent/created') ?? []) listener({ agent: child })
      return {
        childId: child.id, async dispose() {},
        result: Promise.resolve({ stopReason, structured, output: [] }),
      }
    },
  }
  const root = join(fixture, 'delegation')
  const config = { subagentProviderNames: [] }
  const host = { on, tools: { register: () => () => {} }, agents: { get: id => id === child.id ? child : parent } }
  const graph = { config, directory: root, source: () => ({ read: async () => ({ items: [] }) }) }
  const runtime = { config, forAgent: () => graph, executions: { workflow: async (_agent, _operation, signal) => ({ signal, release() {} }) } }
  const coordinator = new MnemonSubagentCoordinator(subagents, runtime, host)
  try {
    await run({
      answer,
      root,
      cwd: fixture,
      coordinator,
      parent,
      child,
      failNext: () => { stopReason = 'error' },
      setResult: value => { structured = value },
    })
  } finally {
    await coordinator.dispose()
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

test('a completed run records its parent, child, turn and usage', async () => {
  await delegated(async ({ answer, root, cwd, coordinator, parent, child }) => {
    const result = await coordinator.answer(parent, 'Synthetic question', [], new AbortController().signal)
    assert.equal(result.answer, answer)
    const store = workspaceActivityStore(root, cwd)
    const events = store.activityIds().map(id => store.read(id))
    assert.equal(events.length, 1)
    const completed = events[0]
    assert.equal(completed.outcome, 'completed')
    assert.equal(completed.parentSession, activityKey('session', parent.id))
    assert.equal(completed.childSession, activityKey('session', child.id))
    assert.equal(completed.turn, 5)
    assert.deepEqual(completed.usage, { uncachedInputTokens: 7, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 0 })
  })
})

test('the recorded event never carries the answer', async () => {
  await delegated(async ({ answer, root, cwd, coordinator, parent }) => {
    await coordinator.answer(parent, 'Synthetic question', [], new AbortController().signal)
    const store = workspaceActivityStore(root, cwd)
    const events = store.activityIds().map(id => store.read(id))
    assert.ok(!JSON.stringify(events).includes(answer))
  })
})

test('a failed run is recorded as failed', async () => {
  await delegated(async ({ root, cwd, coordinator, parent, failNext }) => {
    failNext()
    await assert.rejects(coordinator.answer(parent, 'Synthetic failed question', [], new AbortController().signal))
    const store = workspaceActivityStore(root, cwd)
    const events = store.activityIds().map(id => store.read(id))
    assert.ok(events.some(event => event.outcome === 'failed'))
  })
})

test('an automatic review skipped before delegation records its trigger and reason', async () => {
  await delegated(async ({ root, cwd, coordinator, parent }) => {
    coordinator.recordReviewSkip(parent, 'no-writable-target')
    const [event] = recentMemoryActivity({ workspace: { root, path: cwd } })
    assert.equal(event.operation, 'review')
    assert.equal(event.trigger, 'automatic-distillation')
    assert.equal(event.outcome, 'skipped')
    assert.equal(event.skipReason, 'no-writable-target')
    assert.equal(event.committedWrites, 0)
  })
})

test('a workbench save records an explicit trigger distinct from other delegated writes', async () => {
  await delegated(async ({ root, cwd, coordinator, parent, setResult }) => {
    setResult({ action: 'skipped', summary: 'No qualifying fixture memory', memoryBodyIds: [] })
    const signal = new AbortController().signal
    await coordinator.write(parent, 'supervised-writeback', { content: 'Synthetic manual draft' }, signal)
    await coordinator.write(parent, 'remember', { content: 'Synthetic conversational draft' }, signal)
    const outcomes = recentMemoryActivity({ workspace: { root, path: cwd } })
    assert.ok(outcomes.some(event => event.operation === 'write' && event.trigger === 'manual-save' && event.outcome === 'skipped'))
    assert.ok(outcomes.some(event => event.operation === 'write' && event.trigger === undefined))
  })
})

test('a direct save to a selected Memory Space records the workbench trigger', async () => {
  await delegated(async ({ root, cwd }) => {
    const sourceInstanceKey = 'fixture-space-source'
    const generation = {
      sourceInstances: () => [{ sourceInstanceKey, sourceTypeId: 'memory-spaces' }],
      async executeManagement() { return { revision: 'next', value: { action: 'added' } } },
    }
    const graph = { directory: root, config: { writeEnabled: true, storageScope: 'global', memoryTopology: { layers: {} } },
      memoryComposition: { current: () => generation, acquire: () => ({ generation, release() {} }) } }
    const write = createWriteHandler({ route: () => ({ graph, selectedWorkspace: { path: cwd }, participation: { excluded: false } }) })
    const result = await write('source-management-mutate', { sourceInstanceKey, operation: 'remember', trigger: 'manual-save',
      confirmed: true, expectedRevision: 'current', input: { content: 'A synthetic direct save' } })
    assert.equal(result.ok, true)
    const [event] = recentMemoryActivity({ workspace: { root, path: cwd } })
    assert.equal(event.kind, 'memory')
    assert.equal(event.trigger, 'manual-save')
    assert.equal(event.outcome, 'committed')
  })
})

test('the Status page reads a delegated run as a subagent record', async () => {
  await delegated(async ({ root, cwd, coordinator, parent }) => {
    await coordinator.answer(parent, 'Synthetic question', [], new AbortController().signal)
    const records = recentMemoryActivity({ workspace: { root, path: cwd } })
    assert.equal(records.length, 1)
    assert.equal(records[0].kind, 'subagent')
    assert.equal(records[0].stream, 'workspace')
    assert.equal(records[0].operation, 'answer')
    assert.equal(records[0].outcome, 'completed')
  })
})
