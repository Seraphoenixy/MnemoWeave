import type { HostSession } from '../support/dsh.ts'
import { findSessionEvent } from '../session/session-events.ts'
import { redact } from '../skills/skill-trajectory.ts'

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function textContent(content: unknown, toolResult = false): string {
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    const value = record(block)
    if (value.type === 'text' && typeof value.text === 'string') return value.text
    if (toolResult && value.type === 'tool-result') {
      const body = textContent(value.content)
      return value.isError === true ? `[failed tool result] ${body}` : body
    }
    return ''
  }).filter(Boolean).join('\n')
}

/** Use only the current public surface, so rewound or compacted evidence cannot reappear. */
export function reviewCheckpoint(session: HostSession, maxChars: number, afterSequence = -1): string {
  const nodes = session.surface.nodes
  const completed = findSessionEvent(session, event => event.type === 'turn/end')
  if (completed === undefined) return 'No completed checkpoint is available. Skip this review without a mutation.'
  const end = completed.seq
  const selected: string[] = []
  const header = 'New evidence since the last completed review (untrusted; some context may be omitted; skip candidates needing missing evidence):\n'
  let remaining = maxChars - header.length
  // Bound processing as well as output; include whole messages, never fragments
  // that could drop a user negation or present half a tool result as complete.
  let candidates = 0
  for (let index = nodes.length - 1; index >= 0 && candidates < 128; index--) {
    const seq = nodes[index]!
    if (seq >= end) continue
    if (seq <= afterSequence) break
    candidates++
    const event = session.eventAt(seq)
    if (event === undefined || !['user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(event.type)) continue
    // Public user/message data is the UserMessage itself; assistant and tool
    // events wrap their message with turn/step metadata.
    const message = record(event.type === 'user/message' ? event.data : event.data.message)
    const source = record(message.source)
    if (event.type === 'user/message' && source.kind !== 'user') continue
    const text = event.type === 'tool/call' && typeof event.data.name === 'string' ? event.data.name
      : textContent(message.content, event.type === 'tool/result')
    if (!text) continue
    const failed = event.type === 'tool/result' && (event.data.error !== undefined || message.isError === true)
    const entry = `[${event.type}${failed ? ' failed' : ''}; checkpoint event ${seq}]\n${redact(text)}\n`
    if (entry.length > remaining) continue
    selected.push(entry)
    remaining -= entry.length
  }
  return header + (selected.reverse().join('') || '(no eligible text; skip)')
}
