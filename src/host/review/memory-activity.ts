import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ActivityStore } from '../../memory/activity.ts'
import { workingRulesActivityStore } from '../../memory/working-rules.ts'
import type { ActivityEvent } from '../../sync/activity-protocol.ts'
import type { ActivityClearResult, ActivityRecordView } from '../contracts/protocol.ts'
import { workspaceActivityStore } from './activity-history.ts'

/** The most lines one read returns, matching the run log's own bound. */
export const ACTIVITY_READ_LIMIT = 100

// Events are immutable within a stream. Cache their parsed values so ordering
// uses occurrence time even after sync or a batch of writes with equal mtimes.
const cachedEvents = new Map<string, Map<string, ActivityEvent>>()

/** One stream's events, parsed once and reused until the directory changes. */
function streamEvents(store: ActivityStore): Map<string, ActivityEvent> {
  let names: string[]
  try { names = readdirSync(join(store.directory, 'events')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
    throw error
  }
  const previous = cachedEvents.get(store.directory)
  const current = new Map<string, ActivityEvent>()
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue
    const id = name.slice(0, -5)
    let event
    try { event = previous?.get(id) ?? store.read(id) }
    catch { continue }
    current.set(id, event)
  }
  cachedEvents.set(store.directory, current)
  return current
}

/** A clear ends a stream rather than describing work, so it has no line of its own. */
function listed(event: ActivityEvent): event is Exclude<ActivityEvent, { kind: 'clear' }> {
  return event.kind !== 'clear'
}

function view(store: ActivityStore, stream: ActivityRecordView['stream'], limit: number): ActivityRecordView[] {
  const events = streamEvents(store)
  const records: ActivityRecordView[] = []
  const shown = [...events.values()].filter(listed)
  const latest = shown.sort((left, right) => (right.at ?? 0) - (left.at ?? 0) || left.id.localeCompare(right.id)).slice(0, limit)
  for (const event of latest) {
    records.push({
      at: event.at ?? 0,
      kind: event.kind,
      operation: event.operation,
      outcome: event.outcome,
      stream,
      ...(event.trigger === undefined ? {} : { trigger: event.trigger }),
      ...(event.kind === 'memory' ? { source: event.source } : {}),
      ...(event.skipReason === undefined ? {} : { skipReason: event.skipReason }),
      ...(event.kind === 'memory' && event.results !== undefined ? { results: event.results } : {}),
      ...(event.kind === 'memory' && event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.kind === 'subagent' ? { durationMs: event.durationMs, committedWrites: event.committedWrites } : {}),
    })
  }
  return records
}

/**
 * The recent memory activity this Host recorded for one workspace and for the
 * global Working Rules stream, newest first. It reads the same event files the
 * sync publishes, so a line here and a line on another machine come from the
 * same record.
 */
export function recentMemoryActivity(input: {
  /** The workspace whose activity to include; absent reads only the global stream. */
  workspace?: { root: string; path: string }
  limit?: number
}): ActivityRecordView[] {
  const limit = Math.min(Math.max(1, input.limit ?? 50), ACTIVITY_READ_LIMIT)
  const records: ActivityRecordView[] = []
  if (input.workspace !== undefined) {
    records.push(...view(workspaceActivityStore(input.workspace.root, input.workspace.path), 'workspace', limit))
  }
  records.push(...view(workingRulesActivityStore(), 'working rules', limit))
  return records.sort((left, right) => right.at - left.at).slice(0, limit)
}

/**
 * Delete the activity recorded so far in the streams this page lists: the
 * selected workspace and the global Working Rules stream.
 *
 * The events are removed, not hidden. Each stream keeps one `clear` event that
 * says where it now starts, so the next sync carries that boundary to the
 * server, which drops the batches it supersedes, and to every other client,
 * which drops the same events. A second clear on an unchanged stream records
 * nothing.
 */
export function clearMemoryActivity(input: {
  /** The workspace whose stream to clear; absent clears the global stream alone. */
  workspace?: { root: string; path: string }
}): ActivityClearResult {
  const stores: Array<[ActivityRecordView['stream'], ActivityStore]> = []
  if (input.workspace !== undefined) {
    stores.push(['workspace', workspaceActivityStore(input.workspace.root, input.workspace.path)])
  }
  stores.push(['working rules', workingRulesActivityStore()])
  // The boundary is the newest event either stream holds, so every event this
  // call could see is behind it. Using the clock alone would leave an event
  // recorded in the same millisecond in front of the clear while a slightly
  // later one stayed behind it.
  let before = 0
  for (const [, store] of stores) {
    for (const event of streamEvents(store).values()) before = Math.max(before, event.at ?? 0)
  }
  let workspace = 0
  let rules = 0
  for (const [stream, store] of stores) {
    const cleared = store.clear(before)
    if (stream === 'workspace') workspace += cleared
    else rules += cleared
  }
  return { workspace, rules }
}
