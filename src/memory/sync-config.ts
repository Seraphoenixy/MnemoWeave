import type { SyncEndpoint } from '../sync/client/filesystem.ts'

export function syncServerEndpoint(scope: string): SyncEndpoint | undefined {
  const url = process.env.MNEMOWEAVE_SYNC_URL
  const password = process.env.MNEMOWEAVE_SYNC_PASSWORD ?? process.env.MNEMOWEAVE_SYNC_TOKEN
  if (url === undefined && password === undefined) return undefined
  if (!url || !password) throw new Error('Set both MNEMOWEAVE_SYNC_URL and MNEMOWEAVE_SYNC_PASSWORD for synchronization')
  return { url, password, scope }
}
