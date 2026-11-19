import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { StorageRoot } from './storage-root.ts'
import type { MnemonReviewEntry, MnemonReviewLedgerView, MnemonReviewOpinion, MnemonReviewStatus } from '../contracts/protocol.ts'

export const MNEMON_REVIEW_DIRECTORY = 'state'
export const MNEMON_REVIEW_FILE = 'review-ledger.json'
/** The ledger is a worklist, not an archive: the oldest decided proposals fall off first. */
const MAX_REVIEW_ENTRIES = 200
const MAX_REVIEW_TEXT = 4_000
const STATUSES: readonly MnemonReviewStatus[] = ['pending', 'accepted', 'rejected']

interface LedgerFile {
  version: 1
  entries: MnemonReviewEntry[]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: unknown, limit = MAX_REVIEW_TEXT): string {
  return typeof value === 'string' ? value.slice(0, limit) : ''
}

function strings(value: unknown, limit = 64): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, limit) : []
}

function parseOpinions(value: unknown): MnemonReviewOpinion[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw): MnemonReviewOpinion[] => {
    const opinion = record(raw)
    if (opinion === undefined || typeof opinion.id !== 'string' || typeof opinion.text !== 'string') return []
    return [{
      id: opinion.id,
      author: opinion.author === 'agent' ? 'agent' : 'user',
      text: text(opinion.text),
      createdAt: typeof opinion.createdAt === 'string' ? opinion.createdAt : new Date().toISOString(),
    }]
  })
}

/** A proposal that no longer parses is dropped rather than failing the whole ledger. */
function parseEntry(value: unknown): MnemonReviewEntry | undefined {
  const entry = record(value)
  if (entry === undefined || typeof entry.id !== 'string' || entry.id.trim() === '') return undefined
  if (typeof entry.status !== 'string' || !STATUSES.includes(entry.status as MnemonReviewStatus)) return undefined
  if (!Array.isArray(entry.operations)) return undefined
  const machine = record(entry.machine) ?? {}
  const createdAt = typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString()
  return {
    id: entry.id,
    ...(entry.runtimeStorageKind === 'working-rules' ? { runtimeStorageKind: 'working-rules' as const } : {}),
    createdAt,
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : createdAt,
    status: entry.status as MnemonReviewStatus,
    title: text(entry.title, 200),
    summary: text(entry.summary),
    machine: { id: text(machine.id, 120), label: text(machine.label, 200) },
    foreignMachines: strings(entry.foreignMachines, 32),
    operations: entry.operations as MnemonReviewEntry['operations'],
    opinions: parseOpinions(entry.opinions),
    ...(typeof entry.decidedAt === 'string' ? { decidedAt: entry.decidedAt } : {}),
    ...(typeof entry.appliedAt === 'string' ? { appliedAt: entry.appliedAt } : {}),
    ...(Array.isArray(entry.appliedOperations)
      ? { appliedOperations: entry.appliedOperations.filter((index): index is number => Number.isInteger(index) && index >= 0) }
      : {}),
    ...(typeof entry.failure === 'string' ? { failure: text(entry.failure) } : {}),
  }
}

/**
 * The review ledger holds what a reconciliation proposed and what reviewers said about
 * it. Proposals are inert: an entry is only ever applied when someone accepts it.
 */
export class MnemonReviewLedger {
  private readonly root: string

  constructor(runner: Pick<StorageRoot, 'effectiveDataDir'>) {
    this.root = resolve(runner.effectiveDataDir())
  }

  directory(): string {
    return join(this.root, MNEMON_REVIEW_DIRECTORY)
  }

  path(): string {
    return join(this.directory(), MNEMON_REVIEW_FILE)
  }

  list(): MnemonReviewEntry[] {
    return this.read().entries
  }

  view(): MnemonReviewLedgerView {
    const entries = this.list()
    const latest = entries[0]
    return {
      path: this.path(),
      entries,
      pending: entries.filter(entry => entry.status === 'pending').length,
      ...(latest === undefined ? {} : { latest }),
    }
  }

  get(id: string): MnemonReviewEntry | undefined {
    return this.list().find(entry => entry.id === id)
  }

  /** One proposal from one reconciliation run. Every run is kept, even when it finds nothing. */
  create(input: Pick<MnemonReviewEntry, 'title' | 'summary' | 'machine' | 'foreignMachines' | 'operations' | 'runtimeStorageKind' | 'reconcileScope'>): MnemonReviewEntry {
    const at = new Date().toISOString()
    const entry: MnemonReviewEntry = {
      id: randomUUID(),
      ...(input.reconcileScope === undefined ? {} : { reconcileScope: input.reconcileScope }),
      ...(input.runtimeStorageKind === undefined ? {} : { runtimeStorageKind: input.runtimeStorageKind }),
      createdAt: at,
      updatedAt: at,
      status: 'pending',
      title: text(input.title, 200),
      summary: text(input.summary),
      machine: { id: text(input.machine.id, 120), label: text(input.machine.label, 200) },
      foreignMachines: strings(input.foreignMachines, 32),
      operations: input.operations,
      opinions: [],
    }
    this.save([entry, ...this.list()])
    return entry
  }

  /** An opinion never decides anything by itself; it is what a reviewer thinks. */
  addOpinion(id: string, author: MnemonReviewOpinion['author'], value: string): MnemonReviewEntry {
    const opinion = text(value).trim()
    if (opinion === '') throw new Error('a review opinion must not be empty')
    return this.update(id, entry => ({
      ...entry,
      opinions: [...entry.opinions, { id: randomUUID(), author, text: opinion, createdAt: new Date().toISOString() }],
    }))
  }

  decide(id: string, status: Exclude<MnemonReviewStatus, 'pending'>): MnemonReviewEntry {
    return this.update(id, entry => {
      if (entry.status !== 'pending') throw new Error('this review was already decided: ' + entry.id)
      const { failure: _failure, ...rest } = entry
      return { ...rest, status, decidedAt: new Date().toISOString() }
    })
  }

  /**
   * Reopening is how an opinion that changes a decision is honoured. It also starts the
   * plan over: what a reviewer answers is the plan as a whole, so a position that ran
   * under the old decision is offered again and read against the new one.
   */
  reopen(id: string): MnemonReviewEntry {
    return this.update(id, entry => {
      const { decidedAt: _decidedAt, appliedAt: _appliedAt, appliedOperations: _appliedOperations, failure: _failure, ...rest } = entry
      return { ...rest, status: 'pending' }
    })
  }

  /**
   * Records one run of the plan: which positions committed, and - when one failed - what
   * stopped it. Those positions are what keeps a partly applied plan in the worklist and
   * takes a finished one out of it.
   */
  applied(id: string, failure?: string, committed: readonly number[] = []): MnemonReviewEntry {
    return this.update(id, entry => {
      const { appliedAt: _appliedAt, failure: _failure, ...rest } = entry
      const done = [...new Set([...(entry.appliedOperations ?? []), ...committed])].sort((left, right) => left - right)
      return failure === undefined
        ? { ...rest, appliedAt: new Date().toISOString(), appliedOperations: done }
        : { ...rest, appliedOperations: done, failure }
    })
  }

  private update(id: string, change: (entry: MnemonReviewEntry) => MnemonReviewEntry): MnemonReviewEntry {
    const entries = this.list()
    const index = entries.findIndex(entry => entry.id === id)
    if (index < 0) throw new Error('unknown review entry: ' + id)
    const next = { ...change(entries[index]!), updatedAt: new Date().toISOString() }
    entries[index] = next
    this.save(entries)
    return next
  }

  private read(): LedgerFile {
    if (!existsSync(this.path())) return { version: 1, entries: [] }
    const parsed = JSON.parse(readFileSync(this.path(), 'utf8')) as unknown
    const file = record(parsed)
    if (file?.version !== 1 || !Array.isArray(file.entries)) throw new Error('review ledger is invalid: ' + this.path())
    return { version: 1, entries: file.entries.map(parseEntry).filter((entry): entry is MnemonReviewEntry => entry !== undefined) }
  }

  private save(entries: MnemonReviewEntry[]): void {
    const kept = entries.length <= MAX_REVIEW_ENTRIES ? entries : [
      ...entries.filter(entry => entry.status === 'pending'),
      ...entries.filter(entry => entry.status !== 'pending'),
    ].slice(0, MAX_REVIEW_ENTRIES)
    mkdirSync(this.directory(), { recursive: true, mode: 0o700 })
    const temporary = `${this.path()}.${process.pid}-${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify({ version: 1, entries: kept }, null, 2)}\n`, { mode: 0o600 })
      renameSync(temporary, this.path())
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}
