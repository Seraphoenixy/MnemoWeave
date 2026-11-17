import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { activityKey, publishActivityFile, type ActivityStore } from '../../memory/activity.ts'
import { z } from 'zod'
import { activityEvent, WORKSPACE_ACTIVITY_PREFIX } from '../activity-protocol.ts'
import { syncCursor } from '../protocol.ts'
import type { SyncEndpoint } from './filesystem.ts'
import { SyncClient } from './http.ts'
import { RemoteSyncConflict, type SyncRemote } from './remote.ts'

const BATCH_SIZE = 128

export function activityScope(workspace: string): string {
  return WORKSPACE_ACTIVITY_PREFIX + activityKey(workspace)
}

export function connectActivitySync(endpoint: SyncEndpoint, store: ActivityStore) {
  const client = new SyncClient(endpoint.url, endpoint.scope, endpoint.password, endpoint.session)
  const replicaId = activityKey(new URL(endpoint.url).href, endpoint.scope)
  return (signal?: AbortSignal) => store.exclusive(() => mergeActivity(client, store, replicaId, signal))
}

async function mergeActivity(client: Pick<SyncRemote, 'pull' | 'push'>, store: ActivityStore, replicaId: string, signal?: AbortSignal) {
  const directory = join(store.directory, 'remotes', replicaId)
  const cursorPath = join(directory, 'cursor')
  const marker = (id: string) => join(directory, 'received', id)
  const acknowledge = (id: string) => {
    try { publishActivityFile(marker(id), '') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  let cursor = 0
  try { cursor = syncCursor.parse(JSON.parse(readFileSync(cursorPath, 'utf8'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  let pulled = 0
  let pushed = 0
  let conflicts = 0
  const candidates = store.localActivityIds()
  let position = 0

  for (;;) {
    signal?.throwIfAborted()
    const page = await client.pull(cursor, signal)
    for (const batch of page.batches) {
      for (const change of batch.changes) {
        if (change.operation !== 'put') throw new Error('Activity sync cannot delete events')
        const event = activityEvent.parse(change.value)
        if (event.id !== change.key) throw new Error('Activity event ID does not match its sync key')
        store.merge(event)
        if (!existsSync(marker(event.id))) {
          acknowledge(event.id)
          pulled += 1
        }
      }
    }
    if (page.cursor !== cursor) publishActivityFile(cursorPath, JSON.stringify(page.cursor), true)
    cursor = page.cursor
    if (cursor < page.head) continue
    let end = position
    const pending: string[] = []
    while (end < candidates.length && pending.length < BATCH_SIZE) {
      const id = candidates[end++]!
      if (!existsSync(marker(id))) pending.push(id)
    }
    if (pending.length === 0) return { cursor, pulled, pushed }
    try {
      await client.push({
        requestId: randomUUID(), baseCursor: cursor,
        changes: pending.map(id => ({ key: id, operation: 'put', value: z.json().parse(store.read(id)) })),
      }, signal)
    } catch (error) {
      if (!(error instanceof RemoteSyncConflict) || ++conflicts >= 8) throw error
      continue
    }
    for (const id of pending) acknowledge(id)
    position = end
    pushed += pending.length
    conflicts = 0
  }
}
