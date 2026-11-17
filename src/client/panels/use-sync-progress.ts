import { useEffect, useState } from 'react'
import type { SyncProgressView } from '../../host/contracts/protocol.ts'
import type { MnemonClient } from '../connection/api.ts'

/** How often a page reads a run in flight; a copy of a large memory reports often enough. */
const POLL_MS = 800
/** How often a page with nothing running looks, so another window's run still shows here. */
const IDLE_MS = 15_000

/**
 * The server sync this Host reports. Reads are fast while a run is in flight,
 * so the step and the blocks it carries stay current, and slow otherwise, so a
 * run another window starts still appears on this page.
 */
export function useSyncProgressView(client: MnemonClient | undefined, busy: boolean): SyncProgressView | null {
  const [view, setView] = useState<SyncProgressView | null>(null)
  useEffect(() => {
    if (client === undefined) {
      setView(null)
      return
    }
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (delay: number): void => {
      timer = setTimeout(read, delay)
    }
    const read = (): void => {
      timer = undefined
      client.syncProgress().then(value => {
        if (!active) return
        setView(value)
        schedule(value.running || busy ? POLL_MS : IDLE_MS)
      }, () => {
        // The run's own call reports its failure; a read that cannot answer
        // backs off and asks again rather than leaving the page stale.
        if (active) schedule(busy ? POLL_MS : IDLE_MS)
      })
    }
    read()
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [client, busy])
  return view
}

/** Whole seconds since a run started, counted while the page shows it. */
export function useElapsedSeconds(startedAt: string | undefined, running: boolean): number | undefined {
  const [seconds, setSeconds] = useState<number | undefined>(() => elapsed(startedAt))
  useEffect(() => {
    setSeconds(elapsed(startedAt))
    if (!running || startedAt === undefined) return
    const since = startedAt
    const timer = setInterval(() => setSeconds(elapsed(since)), 1000)
    return () => clearInterval(timer)
  }, [startedAt, running])
  return running ? seconds : undefined
}

function elapsed(startedAt: string | undefined): number | undefined {
  if (startedAt === undefined) return undefined
  const started = Date.parse(startedAt)
  return Number.isNaN(started) ? undefined : Math.max(0, Math.round((Date.now() - started) / 1000))
}