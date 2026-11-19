import { createHash, randomUUID } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { activityEvent, activityId, type ActivityEvent } from '../sync/activity-protocol.ts'
import { withMemoryStorageLock } from '../sdk/storage-lock.ts'

export function activityKey(...identity: Array<string | number>): string {
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

export function publishActivityFile(file: string, contents: string, replace = false): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx', flush: true })
    if (replace) renameSync(temporary, file)
    else linkSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export class ActivityStore {
  constructor(readonly directory: string) {}

  save(value: ActivityEvent): void {
    const event = activityEvent.parse(value)
    const own = join(this.directory, 'local', event.id)
    try { publishActivityFile(own, '') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    this.merge(event)
  }

  merge(value: ActivityEvent): void {
    const event = activityEvent.parse(value)
    const file = this.eventFile(event.id)
    const contents = JSON.stringify(event) + '\n'
    if (!existsSync(file)) {
      try { publishActivityFile(file, contents); return }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    if (JSON.stringify(this.read(event.id)) + '\n' !== contents) throw new Error('Activity event ID has conflicting contents')
  }

  record(value: ActivityEvent): void {
    try { this.save(value) } catch { console.error('MnemoWeave could not persist a memory activity event') }
  }

  /** Store a local-only diagnostic/failure detail for an event (never synced across machines). */
  recordDetail(id: string, detail: string): void {
    const trimmed = detail.trim()
    if (!trimmed) return
    try {
      const parsedId = activityId.parse(id)
      const bounded = trimmed.length <= 2000 ? trimmed : `${trimmed.slice(0, 1999)}…`
      publishActivityFile(this.detailFile(parsedId), bounded, true)
    } catch {
      // Local detail is best-effort and must never fail the activity record itself.
    }
  }

  readDetail(id: string): string | undefined {
    try {
      const parsedId = activityId.parse(id)
      const file = this.detailFile(parsedId)
      if (!existsSync(file)) return undefined
      const text = readFileSync(file, 'utf8').trim()
      return text === '' ? undefined : text
    } catch {
      return undefined
    }
  }

  /**
   * End the activity recorded at or before `before`, and publish the clear so
   * another client ends the same events.
   *
   * The files go: keeping them while only hiding them makes every later clean-up
   * larger than the problem it solves, and old activity stops being useful once
   * it is read. What remains is one small `clear` event, which the sync carries
   * and which is what tells the other machine (and the server) where the stream
   * now starts.
   *
   * A clear newer than the newest event still publishes: the streams must agree
   * on where they end even when this machine had nothing to remove.
   */
  clear(before: number): number {
    let removed = 0
    let boundary = 0
    const superseded: string[] = []
    for (const id of this.activityIds()) {
      let event: ActivityEvent
      try { event = this.read(id) } catch { continue }
      if (event.kind === 'clear') {
        boundary = Math.max(boundary, event.before)
        // One boundary is enough: an older clear says nothing the newer one
        // does not, so only the newest is kept.
        if (event.before < before) superseded.push(id)
        continue
      }
      if ((event.at ?? 0) > before) continue
      rmSync(this.eventFile(id), { force: true })
      rmSync(join(this.directory, 'local', id), { force: true })
      rmSync(this.detailFile(id), { force: true })
      removed += 1
    }
    // Only a clear that removed something, or that moves the boundary later,
    // publishes: pressing the action twice must not keep appending events to the
    // stream it just emptied.
    if (removed > 0 || boundary < before) {
      for (const id of superseded) {
        rmSync(this.eventFile(id), { force: true })
        rmSync(join(this.directory, 'local', id), { force: true })
      }
      this.save({ version: 1, kind: 'clear', id: activityKey('clear', randomUUID()), at: before, before })
    }
    return removed
  }

  /**
   * Apply another machine's clear: the events it ended stop being kept here too,
   * so both copies hold the same small stream rather than one copy growing
   * forever. Newer activity is left alone.
   */
  applyClear(before: number): number {
    let removed = 0
    for (const id of this.activityIds()) {
      let event: ActivityEvent
      try { event = this.read(id) } catch { continue }
      if (event.kind === 'clear' || (event.at ?? 0) > before) continue
      rmSync(this.eventFile(id), { force: true })
      rmSync(join(this.directory, 'local', id), { force: true })
      rmSync(this.detailFile(id), { force: true })
      removed += 1
    }
    return removed
  }

  activityIds(): string[] {
    try {
      return readdirSync(join(this.directory, 'events')).flatMap(name => /^[a-f0-9]{64}\.json$/u.test(name) ? [name.slice(0, -5)] : []).sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  localActivityIds(): string[] {
    try {
      return readdirSync(join(this.directory, 'local')).filter(id => activityId.safeParse(id).success && existsSync(this.eventFile(id))).sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  read(id: string): ActivityEvent {
    const event = activityEvent.parse(JSON.parse(readFileSync(this.eventFile(id), 'utf8')))
    if (event.id !== id) throw new Error('Activity event ID does not match its filename')
    return event
  }

  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return withMemoryStorageLock(this.directory, operation)
  }

  private eventFile(id: string): string {
    return join(this.directory, 'events', activityId.parse(id) + '.json')
  }

  private detailFile(id: string): string {
    return join(this.directory, 'details', activityId.parse(id) + '.txt')
  }
}
