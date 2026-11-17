import assert from 'node:assert/strict'
import test from 'node:test'
import { reviewCheckpoint } from '../../src/host/review/review-checkpoint.ts'

test('session distillation includes new failure evidence and excludes previously reviewed turns', () => {
  const assistant = text => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
  const events = [
    assistant('Already reviewed'),
    { type: 'turn/end', data: {} },
    { type: 'tool/call', data: { name: 'diagnose' } },
    { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', isError: true, content: [{ type: 'text', text: 'Synthetic timeout' }] }] } } },
    assistant('The second check confirmed a stale lease.'),
    { type: 'turn/end', data: {} },
    assistant('Incomplete turn'),
  ]
  const session = {
    seq: events.length,
    surface: { nodes: events.map((_, index) => index) },
    eventAt: index => events[index],
    snapshotEvents: (start, end) => events.slice(start, end),
  }

  const checkpoint = reviewCheckpoint(session, 2_000, 1)
  assert.match(checkpoint, /diagnose/)
  assert.match(checkpoint, /failed tool result.*Synthetic timeout/)
  assert.match(checkpoint, /confirmed a stale lease/)
  assert.doesNotMatch(checkpoint, /Already reviewed|Incomplete turn/)
})
