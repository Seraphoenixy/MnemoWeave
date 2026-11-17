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
}
