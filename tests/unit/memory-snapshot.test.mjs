import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareMemorySnapshot } from '../../src/host/session/memory-snapshot.ts'

test('the next snapshot retires the old rules copy and redundant reminder', () => {
  const plugin = (form, text) => ({ type: 'user/message', data: { role: 'user',
    source: { kind: 'dsh-mnemo-weave', form }, content: [{ type: 'text', text }] } })
  const events = [
    plugin('memory-snapshot', 'Old snapshot containing Working Rules.'),
    plugin('instructions', '[dsh-mnemo-weave] Use the memory tools.'),
    plugin('instructions', 'Continue from the tool results above.'),
    { type: 'user/message', data: { role: 'user', source: { kind: 'user' } } },
  ]
  const retired = []
  const session = { surface: { nodes: [0, 1, 2, 3] }, eventAt: index => events[index],
    append: (_type, _data, options) => retired.push(options.surfaceOp.startSeq) }
  const next = prepareMemorySnapshot(session, 'MNEMON VIEW TOOLS (available in this View): mnemo_recall')
  assert.equal(next.message.source.form, 'memory-snapshot')
  next.retire(2, 1)
  assert.deepEqual(retired, [0, 1])
})
