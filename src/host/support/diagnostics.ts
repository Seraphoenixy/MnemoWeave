import type { DiagnosticEntry, DiagnosticLevel } from '../contracts/protocol.ts'
import { errorMessage } from './error-message.ts'

/** How many lines are kept. A Host runs for weeks; the page shows the recent end. */
const CAPACITY = 200

/**
 * The Host's recent activity, kept in memory only. It answers "what happened
 * before it failed" without writing a log file, and it is deliberately not
 * synchronized, Packed or persisted: it describes this process, and a restarted
 * Host has nothing to say about the previous one.
 */
export class DiagnosticLog {
  private entries: DiagnosticEntry[] = []

  write(level: DiagnosticLevel, area: string, message: string, detail?: string): void {
    this.entries.push({ at: Date.now(), level, area, message, ...(detail === undefined ? {} : { detail }) })
    // Drop from the front in one step rather than shifting per line.
    if (this.entries.length > CAPACITY) this.entries = this.entries.slice(-CAPACITY)
  }

  info(area: string, message: string, detail?: string): void { this.write('info', area, message, detail) }
  warning(area: string, message: string, detail?: string): void { this.write('warning', area, message, detail) }
  error(area: string, message: string, detail?: string): void { this.write('error', area, message, detail) }

  /** Record a failure with its cause chain, which is the point of keeping a log at all. */
  failure(area: string, context: string, error: unknown): void {
    this.write('error', area, context, errorMessage(error))
  }

  /** Newest first, which is the order a person reads a failure in. */
  recent(limit = CAPACITY): DiagnosticEntry[] {
    return this.entries.slice(-limit).reverse()
  }

  clear(): void { this.entries = [] }
}

/** One log per Host process, shared by the sync, memory and server paths. */
export const diagnostics = new DiagnosticLog()