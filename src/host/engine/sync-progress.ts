import type { SyncOutcomeView, SyncPhase, SyncProgressView } from '../contracts/protocol.ts'
import { errorMessage } from '../support/error-message.ts'

export interface SyncRunResult {
  pulled: number
  pushed: number
  activityPulled: number
  activityPushed: number
}

/**
 * One server sync as it runs. A run states how many steps it walks, moves to
 * the next step with the copy it carries, and may report how much of that step
 * has been transferred. The handle settles the run exactly once; a later
 * report from the same handle is ignored, so a run that already ended cannot
 * overwrite what the page shows.
 */
export interface SyncRun {
  /** How many steps this run walks, once its scope is known. */
  plan(steps: number): void
  /** Begin the next step, carrying `target` when there is one to name. */
  step(phase: SyncPhase, target?: string): void
  /** How much of the current step has been carried. */
  transfer(done: number, total: number): void
  finish(result: SyncRunResult): void
  /** A run that stopped reports what it was doing and why. */
  fail(error: unknown, conflictTarget?: string): void
}

interface Running {
  phase: SyncPhase
  target?: string
  step: number
  steps: number
  done: number
  total: number
  startedAt: number
}

/**
 * What the workbench shows about the server sync this Host runs: the step in
 * flight and how the previous run ended. It lives in the Host process and is
 * not stored, so a restarted Host reports no earlier run.
 */
export class SyncProgressRegistry {
  private current: Running | undefined
  private settled: SyncOutcomeView | undefined

  /** Whether a run is in flight, so a second caller is refused instead of sharing it. */
  busy(): boolean { return this.current !== undefined }

  /** How the last run ended, for a timer deciding whether to try again. */
  last(): SyncOutcomeView | undefined { return this.settled }

  /**
   * Claim the record in one step, or answer that another run already holds it.
   * Reading {@link busy} and calling {@link begin} separately leaves a gap: a
   * caller that awaits anything between them — reading the credentials, say —
   * lets a second caller pass the same check, and two runs then copy the same
   * storage roots while each reports the other's steps.
   */
  claim(): SyncRun | undefined {
    if (this.current !== undefined) return undefined
    return this.begin()
  }

  begin(): SyncRun {
    const startedAt = Date.now()
    const running: Running = { phase: 'prepare', step: 0, steps: 0, done: 0, total: 0, startedAt }
    this.current = running
    // This run owns the record; a handle taken before a replacement no longer does.
    const mine = (): boolean => this.current === running
    return {
      plan: steps => { if (mine()) running.steps = steps },
      step: (phase, target) => {
        if (!mine()) return
        running.phase = phase
        running.step += 1
        running.done = 0
        running.total = 0
        if (target === undefined) delete running.target
        else running.target = target
      },
      transfer: (done, total) => {
        if (!mine()) return
        running.done = done
        running.total = total
      },
      finish: result => {
        if (!mine()) return
        this.current = undefined
        this.settled = { state: 'done', finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, ...result }
      },
      fail: (error, conflictTarget) => {
        if (!mine()) return
        this.current = undefined
        this.settled = {
          state: 'failed', finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAt,
          pulled: 0, pushed: 0, activityPulled: 0, activityPushed: 0,
          ...(conflictTarget === undefined ? {} : { conflictTarget }),
          error: errorMessage(error),
        }
      },
    }
  }

  view(): SyncProgressView {
    const running = this.current
    return {
      running: running !== undefined,
      ...(running === undefined ? {} : {
        phase: running.phase,
        ...(running.target === undefined ? {} : { target: running.target }),
        step: running.step,
        steps: running.steps,
        done: running.done,
        total: running.total,
        startedAt: new Date(running.startedAt).toISOString(),
      }),
      ...(this.settled === undefined ? {} : { last: this.settled }),
    }
  }
}

/** One registry per Host process, shared by every sync handler in it. */
export const syncProgress = new SyncProgressRegistry()