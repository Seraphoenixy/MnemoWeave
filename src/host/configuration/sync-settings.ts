import { syncServerEndpoint } from '../../memory/sync-config.ts'
import { SyncClient } from '../../sync/client/http.ts'
import type { HostCredentialsService } from '../support/dsh.ts'

const KEY = 'dsh-mnemo-weave/sync-server'
const SCOPE = 'working-rules'
export type SyncCredentialStore = () => HostCredentialsService | undefined

export async function hostSyncEndpoint(store?: SyncCredentialStore) {
  const record = await store?.()?.readRecord(KEY) as { kind?: string; payload?: { url?: string; password?: string } } | undefined
  if (record === undefined) return syncServerEndpoint(SCOPE)
  const { url, password } = record.payload ?? {}
  if (record.kind !== 'grant' || typeof url !== 'string' || typeof password !== 'string') throw new Error('Invalid saved sync connection')
  return { url, password, scope: SCOPE }
}

export async function syncConnectionView(store?: SyncCredentialStore) {
  const writable = store?.() !== undefined
  try {
    const endpoint = await hostSyncEndpoint(store)
    if (endpoint !== undefined) {
      new SyncClient(endpoint.url, endpoint.scope, endpoint.password)
      return { url: endpoint.url, configured: true, writable }
    }
  } catch {
    // Keep the editor available to repair an invalid previous connection.
  }
  return { url: '', configured: false, writable }
}

/**
 * Whether this Host can name a sync server at all: a saved connection, or the
 * environment pair an unattended Host reads. Reading the credential store is
 * asynchronous, so this answers with a promise; a store that cannot be read
 * counts as configured, so a real problem is reported rather than hidden.
 */
export async function hasSyncConnection(store?: SyncCredentialStore): Promise<boolean> {
  const credentials = store?.()
  if (credentials !== undefined) {
    try {
      if (await credentials.readRecord(KEY) !== undefined) return true
    } catch {
      return true
    }
  }
  const url = process.env.MNEMOWEAVE_SYNC_URL
  const password = process.env.MNEMOWEAVE_SYNC_PASSWORD ?? process.env.MNEMOWEAVE_SYNC_TOKEN
  return Boolean(url && password)
}

export async function saveSyncConnection(store: SyncCredentialStore | undefined, url: unknown, password: unknown, signal?: AbortSignal) {
  const credentials = store?.()
  if (credentials === undefined) throw new Error('DSH credentials storage is unavailable')
  if (typeof url !== 'string' || typeof password !== 'string') throw new Error('Sync server address and password must be text')
  let address: string
  try { address = new URL(url.trim()).href } catch { throw new Error('Invalid sync server address') }
  const client = new SyncClient(address, SCOPE, password)
  await client.authenticate(signal ?? AbortSignal.timeout(15_000))
  await credentials.modifyRecord(KEY, async () => ({ kind: 'grant', payload: { url: address, password } }))
  return syncConnectionView(store)
}
