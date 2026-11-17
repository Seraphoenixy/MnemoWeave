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
        // Another machine's clear ends the events it named here too, so both
        // copies hold the same short stream instead of this one keeping a
        // history the other already dropped.
        if (event.kind === 'clear') store.applyClear(event.before)
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
      // A clear removes the local marker with its event; a candidate whose file
      // is gone was cleared since this run read the list.
      if (!existsSync(marker(id)) && existsSync(join(store.directory, 'events', id + '.json'))) pending.push(id)
    }
    if (pending.length === 0) return { cursor, pulled, pushed }
    try {
      const accepted = await client.push({
        requestId: randomUUID(), baseCursor: cursor,
        changes: pending.map(id => ({ key: id, operation: 'put', value: z.json().parse(store.read(id)) })),
      }, signal)
      // A clear compacts the scope, so the server answers with the cursor that
      // remains rather than one after the batch it replaced.
      cursor = accepted
      position = end
    } catch (error) {
      if (!(error instanceof RemoteSyncConflict) || ++conflicts >= 8) throw error
      continue
    }
    for (const id of pending) acknowledge(id)
    pushed += pending.length
    conflicts = 0
  }
}
