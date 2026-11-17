// The settings channel the page writes the automatic sync through. Those two
// nested paths must be accepted; the whitelist is not opened wholesale.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSettingsHandler } from '../../src/host/configuration/settings.ts'

function handler() {
  const written = []
  const view = {
    ns: 'mnemon',
    value: { autoSync: { enabled: false, intervalMs: 900_000 } },
    base: {}, user: {}, revision: 1, applies: 'live',
  }
  return {
    written,
    handler: createSettingsHandler({
      writable: true,
      describe: () => [view],
      mutate: async (_ns, ops) => { written.push(...ops) },
    }),
  }
}

test('the enable switch is writable', async () => {
  const { handler: settings, written } = handler()
  const saved = await settings('mutate', { ops: [{ op: 'set', path: ['autoSync', 'enabled'], value: true }] })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.deepEqual(written.map(op => [op.path.join('.'), op.value]), [['autoSync.enabled', true]])
})

test('the interval is writable', async () => {
  const { handler: settings, written } = handler()
  const saved = await settings('mutate', { ops: [{ op: 'set', path: ['autoSync', 'intervalMs'], value: 300_000 }] })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.deepEqual(written.map(op => [op.path.join('.'), op.value]), [['autoSync.intervalMs', 300_000]])
})

test('a value outside the range the scheduler accepts is refused where it is written', async () => {
  const { handler: settings } = handler()
  assert.equal((await settings('mutate', { ops: [{ op: 'set', path: ['autoSync', 'intervalMs'], value: 1_000 }] })).ok, false)
  assert.equal((await settings('mutate', { ops: [{ op: 'set', path: ['autoSync', 'enabled'], value: 'yes' }] })).ok, false)
})

test('an unrelated nested field stays refused', async () => {
  const { handler: settings } = handler()
  assert.equal((await settings('mutate', { ops: [{ op: 'set', path: ['autoSync', 'other'], value: 1 }] })).ok, false)
})
