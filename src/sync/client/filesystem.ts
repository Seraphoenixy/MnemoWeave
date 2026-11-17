import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { withMemoryStorageLock } from '../../sdk/storage-lock.ts'
import { SyncClient, type SyncSession } from './http.ts'
import { SnapshotSync, snapshotDigest, type SnapshotSyncState, type SyncSnapshot } from './snapshot.ts'

export interface SyncEndpoint { url: string; scope: string; password: string; session?: SyncSession }

/**
 * One scope backed by a directory tree.
 *
 * The source owns both directions: it captures its content as the files an
 * archive is built from, and it assembles an archive from a set of those files.
 * That second half is what lets a pull reuse content already on this machine
 * instead of fetching the whole snapshot again.
 */
export function localSnapshotSync(endpoint: SyncEndpoint, dataDirectory: string, source: {
  capture(): Promise<SyncSnapshot>
  apply(bytes: Buffer, matches: (live: Buffer) => boolean): Promise<void>
  assemble(entries: SyncSnapshot['entries']): Buffer
}): Pick<SnapshotSync, 'sync'> {
  const client = new SyncClient(endpoint.url, endpoint.scope, endpoint.password, endpoint.session)
  const key = snapshotDigest(Buffer.from(new URL(endpoint.url).href + '\0' + endpoint.scope))
  const state = join(dataDirectory, 'state', 'server-sync-' + key + '.json')
  const sync = new SnapshotSync(client, {
    capture: () => source.capture(),
    apply: (bytes, expected) => source.apply(bytes, live => snapshotDigest(live) === expected),
    assemble: entries => source.assemble(entries),
    load() {
      try { return JSON.parse(readFileSync(state, 'utf8')) as unknown }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
    save(value: SnapshotSyncState) {
      const temporary = state + '.' + randomUUID() + '.tmp'
      mkdirSync(dirname(state), { recursive: true, mode: 0o700 })
      try {
        writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
        renameSync(temporary, state)
      } finally {
        rmSync(temporary, { force: true })
      }
    },
  })
  return { sync: options => withMemoryStorageLock(state, () => sync.sync(options)) }
}