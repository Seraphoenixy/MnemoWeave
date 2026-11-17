import type { ResolvedAutoSyncConfig } from '../contracts/protocol.ts'
import type { SyncProgressRegistry } from './sync-progress.ts'

/** The longest delay a timer accepts; a longer interval waits in two steps. */
const MAX_TIMER_MS = 2_147_483_647

/** How long to wait before looking again while another caller's run is in flight. */
const BUSY_RECHECK_MS = 30_000

/**
 * Runs the server sync on a timer, as Ygdria's desktop does: a tick checks the
 * same conditions a person would before pressing the button, and starts a run
 * only when every one of them holds.
 *
 * A run that ends on a conflict is not retried. Both copies changed, and only a
 * person can say which one survives, so the timer stops until the conflict is
 * resolved. Every other failure — an unreachable server, a refused password —
 * is retried on the next tick, because the next attempt may well succeed.
 */
export class AutoSyncScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private stopped = true

  constructor(
    private readonly settings: () => ResolvedAutoSyncConfig,
    private readonly progress: SyncProgressRegistry,
    private readonly run: () => Promise<void>,
    /** Whether a sync server is configured at all, so an unconfigured Host stays quiet. */
    private readonly configured: () => boolean | Promise<boolean> = () => true,
  ) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.schedule()
  }

  /** Whether a run may start now: switched on, a server configured, nothing in flight, no conflict waiting. */
  async ready(): Promise<boolean> {
    if (!this.settings().enabled) return false
    // A Host with no saved connection and no environment pair has nothing to
    // reach; ticking would only record a failure nobody can act on.
    if (!await this.configured()) return false
    if (this.progress.busy()) return false
    const last = this.progress.last()
    return last?.state !== 'failed' || last.conflictTarget === undefined
  }

  /**
   * Re-read the settings after they changed. A switch that was turned off stops
   * the timer; one turned on starts it from now, not from when it was turned off.
   */
  settingsChanged(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (this.stopped) return
    this.schedule()
  }

  dispose(): void {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private schedule(delayMs?: number): void {
    if (this.timer !== undefined || this.stopped) return
    const { enabled, intervalMs } = this.settings()
    if (!enabled) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick()
    }, Math.min(delayMs ?? intervalMs, MAX_TIMER_MS))
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    if (this.running) return
    if (!await this.ready()) {
      // A conflict waiting on a person is not going to clear by itself, so the
      // next look is one interval away. A run in flight — this Host's own, or a
      // press in another window — ends on its own, but not on a schedule this
      // timer can see, so look again soon rather than after a whole interval.
      this.schedule(this.progress.busy() ? Math.min(BUSY_RECHECK_MS, this.settings().intervalMs) : undefined)
      return
    }
    this.running = true
    try {
      await this.run()
    } catch {
      // The run reports its own failure through the progress registry, which is
      // what the next tick reads. Nothing is logged twice here.
    } finally {
      this.running = false
      this.schedule()
    }
  }
}