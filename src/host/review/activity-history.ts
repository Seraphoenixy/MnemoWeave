import { join } from 'node:path'
import { ActivityStore, activityKey } from '../../memory/activity.ts'
import { activityEvent, type MemoryActivityEvent, type SubagentActivityEvent } from '../../sync/activity-protocol.ts'
import { workspaceStorageId } from '../../sdk/workspace-storage.ts'
import { memoryTool } from '../contracts/memory-tools.ts'
import { sessionTurnEvents } from '../session/session-events.ts'
import type { HostAgent, HostSessionEvent } from '../support/dsh.ts'
import { MNEMON_ACTIVITY_SCHEMA, parseMnemonActivityMeta } from './activity-presentation.ts'

export function workspaceActivityStore(root: string, workspace: string): ActivityStore {
  return new ActivityStore(join(root, 'state', 'activity', 'workspaces', workspaceStorageId(workspace)))
}

export function activityStoreForAgent(root: string, agent: HostAgent, workspace?: string): ActivityStore | undefined {
  const path = (workspace ?? agent.session.header?.cwd)?.trim()
  if (!path) return undefined
  return workspaceActivityStore(root, path)
}

export function recordAgentTurn(agent: HostAgent, turn: number, storage: () => { root: string; workspace?: string } | undefined): void {
  try {
    const location = storage()
    if (location === undefined) return
    const store = activityStoreForAgent(location.root, agent, location.workspace)
    if (store === undefined) return
    for (const event of collectTurnActivity(agent.id, agent.session.header?.parentSession, turn, sessionTurnEvents(agent.session, turn))) store.record(event)
  } catch {
    console.error('MnemoWeave could not collect memory activity for a turn')
  }
}

export function collectTurnActivity(session: string, parentSession: string | undefined, turn: number, events: Iterable<HostSessionEvent>): MemoryActivityEvent[] {
  const pending = new Map<string, { name: string; time?: number }>()
  const activity: MemoryActivityEvent[] = []
  const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  const settled = (callId: string, call: { name: string; time?: number }, event?: HostSessionEvent) => {
    const tool = memoryTool(call.name)
    if (tool?.kind !== 'read' && tool?.kind !== 'write') return
    const raw = event?.data.meta as { schema?: unknown; skipReason?: unknown; resultCount?: unknown; recordIds?: unknown; replayed?: unknown; writeOutcome?: unknown } | undefined
    const meta = raw?.schema === MNEMON_ACTIVITY_SCHEMA ? raw : undefined
    const data = parseMnemonActivityMeta(meta, callId, call.name)
    const skipReason = meta?.skipReason === 'budget' || meta?.skipReason === 'not-run' || meta?.skipReason === 'unavailable' ? meta.skipReason : undefined
    const results = validTime(meta?.resultCount) ? meta.resultCount : undefined
    const writeIds = Array.isArray(meta?.recordIds) ? meta.recordIds.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 300) : []
    const ids = data.read?.items.map(item => item.id).filter(id => !/^item-\d+$/u.test(id))
      ?? (data.writeback === undefined ? [] : writeIds.length > 0 ? writeIds : data.writeback.item.id === tool.operation ? [] : [data.writeback.item.id])
    const writeOutcome = meta?.writeOutcome === 'skipped' || meta?.writeOutcome === 'failed' ? meta.writeOutcome : 'unconfirmed'
    const outcome = event === undefined ? 'unknown' : event.data.error !== undefined ? 'failed'
      : tool.kind === 'write' ? data.writeback === undefined ? writeOutcome : 'committed'
        : skipReason !== undefined ? 'skipped' : results === undefined ? 'unknown' : results === 0 ? 'empty' : 'returned'
    const record = activityEvent.safeParse({
      version: 1, kind: 'memory', id: activityKey('dsh-tool', session, turn, callId),
      session: activityKey('session', session),
      ...(parentSession === undefined ? {} : { parentSession: activityKey('session', parentSession) }),
      turn, source: tool.sourceTypeId, operation: tool.operation, outcome,
      ...(results === undefined || outcome === 'failed' ? {} : { results }),
      ...(skipReason === undefined || outcome !== 'skipped' ? {} : { skipReason }),
      ...(meta?.replayed === true && tool.kind === 'read' && outcome !== 'failed' ? { replayed: true } : {}),
      ...(ids.length === 0 || outcome === 'failed' ? {} : { records: ids.slice(0, 16).map(id => activityKey('record', tool.sourceTypeId ?? '', id)) }),
      ...(validTime(event?.time) ? { at: event.time } : {}),
      ...(validTime(event?.time) && call.time !== undefined && event.time >= call.time ? { durationMs: event.time - call.time } : {}),
    })
    if (record.success && record.data.kind === 'memory') activity.push(record.data)
  }
  for (const event of events) {
    if (event.type === 'tool/call' && event.data.turn === turn && typeof event.data.callId === 'string' && typeof event.data.name === 'string') {
      pending.set(event.data.callId, { name: event.data.name, ...(validTime(event.time) ? { time: event.time } : {}) })
    }
    if (event.type !== 'tool/result') continue
    const message = event.data.message as { source?: { callId?: unknown } } | undefined
    const callId = message?.source?.callId
    if (typeof callId !== 'string') continue
    const call = pending.get(callId)
    if (call === undefined) continue
    pending.delete(callId)
    settled(callId, call, event)
  }
  for (const [callId, call] of pending) settled(callId, call)
  return activity
}

export function recordSubagentActivity(store: ActivityStore | undefined, parent: HostAgent, turn: number | undefined, runId: string, childId: string | undefined, result: Pick<SubagentActivityEvent, 'operation' | 'outcome' | 'durationMs' | 'committedWrites' | 'usage'>): void {
  store?.record({
    version: 1, kind: 'subagent', id: activityKey('dsh-subagent', runId), at: Date.now(), ...result,
    parentSession: activityKey('session', parent.id),
    ...(turn === undefined ? {} : { turn }),
    ...(childId === undefined ? {} : { childSession: activityKey('session', childId) }),
  })
}
