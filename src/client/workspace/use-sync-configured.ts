import { useEffect, useState } from 'react'
import type { MnemonClient } from '../connection/api.ts'

/**
 * Whether this Host can name a sync server. The header asks once per client and
 * again whenever the settings page saves a connection, so the indicator states
 * the same fact the settings page shows.
 */
export function useSyncConfigured(client: MnemonClient | undefined, revision: number): boolean | undefined {
  const [configured, setConfigured] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    if (client === undefined) { setConfigured(undefined); return }
    let active = true
    client.syncConnection().then(value => { if (active) setConfigured(value.configured) }, () => { if (active) setConfigured(undefined) })
    return () => { active = false }
  }, [client, revision])
  return configured
}