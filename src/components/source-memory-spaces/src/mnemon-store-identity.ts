/**
 * What a Mnemon store holds, as opposed to how it was used, and the merge of two versions of one.
 * The public `./space-identity` entry exposes it; its limits and test hooks stay here.
 *
 * Mnemon writes to a space whenever it is read: a recall, search or show raises
 * `access_count`, stamps `last_accessed_at` and logs the read in `oplog`. Two machines
 * that only read the same space therefore never hold the same `mnemon.db` bytes, and a
 * merge that compares bytes kept the other machine's space as a new one on every sync,
 * doubling the spaces each round (#370). Spaces are compared by their content instead:
 * every table, column and row, the edges included, except the usage columns, the read log
 * and the derived embedding and effective importance. An edge is the two memories it links
 * and its type, its table's key: a merge of spaces or a new link writes its weight, note and
 * time again, so the same edge with other values is still the same edge (#391). A memory's
 * update time is left out too: filling in its vector or keeping it from pruning moves it, while
 * an edit or a forget changes what is compared.
 *
 * Rows are compared by their columns in name order, so the order a table declares them in
 * does not matter. One version contains another when it holds every row of it. Two versions
 * of one space merge by adding to this machine's database the rows only the other holds:
 * this machine's rows, read counts, read log and schema stay as they are, and the result holds
 * the memories of both; an edge both hold keeps this machine's values. A row both sides hold
 * differently, a memory edited or forgotten on one of them, refuses the merge, and the caller
 * keeps a copy instead.
 *
 * It needs `node:sqlite` (Node 22.13, 23.4 and later). Without it, for bytes that are not a
 * readable database, for a database with a virtual table, or past the row limits, the identity
 * is the bytes' digest, and such a store contains and merges with no other, so a caller keeps
 * both versions rather than losing a memory.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type Sqlite = typeof import('node:sqlite')
type Database = InstanceType<Sqlite['DatabaseSync']>

/** Written by reading a space: the read log. */
const USAGE_TABLES = new Set(['oplog'])
/** Written by reading a space, or derived from what it holds. */
const USAGE_COLUMNS = new Set(['access_count', 'last_accessed_at', 'effective_importance', 'embedding'])
/**
 * Values a row carries beside what it holds, which Mnemon writes again without changing that
 * (#391): an edge is its key, and an import or a new link writes its weight, note and time
 * again; a memory's update time moves when its vector is filled in or it is kept from pruning.
 */
const ROW_VALUES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['edges', new Set(['weight', 'metadata', 'created_at'])],
  ['insights', new Set(['updated_at'])],
])
const SCRATCH_PREFIX = '.dsh-space-identity-'
/**
 * Past this many rows a store is compared by its bytes, and past the second limit, counted over
 * all of one identity's reads, so is every store it reads after that. Its caller may hold a lock
 * while it compares, so a crafted database must not take long: 120,000 real rows read in about
 * 0.4 s.
 */
const IDENTITY_MAX_ROWS = 500_000
const MERGE_MAX_ROWS = 2_000_000

/** Test hooks; the public entry passes none. */
export interface MnemonStoreIdentityOptions {
  /** Returns `node:sqlite`, or nothing as a Node without it does. */
  sqlite?: () => Sqlite | undefined
  /** The most rows one store is read by before it is compared by its bytes. */
  maxRows?: number
  /** The most rows all of this identity's reads take together. */
  maxMergeRows?: number
}

/** One table as the identity reads it. */
interface Table {
  /** The columns its content is compared by, in name order: all but the usage columns and an edge's values. */
  columns: string[]
  /** Every column, as a row is written back. */
  all: string[]
  /** The digest of every row's content. */
  rows: Set<string>
}

interface Contents {
  identity: string
  tables: Map<string, Table>
}

function sqlite(): Sqlite | undefined {
  try {
    // Never a static import: Node 20 has no node:sqlite, and the plugin must still load there.
    return process.getBuiltinModule?.('node:sqlite') as Sqlite | undefined
  } catch {
    return undefined
  }
}

function quote(name: string): string {
  return '"' + name.replaceAll('"', '""') + '"'
}

/** A cell as JSON that keeps SQLite's types apart: 1, 1.0, '1', x'01' and NULL all differ. */
function cell(value: unknown): unknown {
  if (value instanceof Uint8Array) return { blob: Buffer.from(value).toString('base64') }
  if (typeof value === 'bigint') return { integer: String(value) }
  if (typeof value === 'number') return { real: Object.is(value, -0) ? '-0' : String(value) }
  return value
}

/** 128 bits of a row's digest: enough to tell rows apart, half the memory of the whole digest. */
function rowDigest(columns: readonly string[], row: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(columns.map(column => cell(row[column])))).digest('base64').slice(0, 22)
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left === right || Buffer.from(left.buffer, left.byteOffset, left.byteLength).equals(right)
}

/** Cleanup never fails a merge: a copy another process holds open is swept by the next one. */
function remove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3 })
  } catch {}
}

/**
 * Reads what each database holds once, and merges two of them. Make one per comparison or merge
 * and dispose of it at the end. A process that stopped midway leaves its copies behind; the next
 * identity on the same parent sweeps them before it makes its own.
 */
export class MnemonStoreIdentity {
  private scratch: string | undefined
  private readonly known = new WeakMap<Uint8Array, Contents | null>()
  private readonly projections = new WeakMap<Uint8Array, Map<string, Set<string> | null>>()
  private readonly module: () => Sqlite | undefined
  private readonly maxRows: number
  private remaining: number

  /** `parent` holds the short-lived copies a database is read from. */
  constructor(private readonly parent: string, options: MnemonStoreIdentityOptions = {}) {
    this.module = options.sqlite ?? sqlite
    this.maxRows = options.maxRows ?? IDENTITY_MAX_ROWS
    this.remaining = options.maxMergeRows ?? MERGE_MAX_ROWS
  }

  of(bytes: Uint8Array): string {
    return this.contents(bytes)?.identity ?? 'bytes:' + digest(bytes)
  }

  /** Whether `outer` holds every row `inner` holds; `outer` may have columns `inner` lacks. */
  contains(outer: Uint8Array, inner: Uint8Array): boolean {
    if (sameBytes(outer, inner)) return true
    const whole = this.contents(outer)
    const part = this.contents(inner)
    if (whole === undefined || part === undefined) return false
    for (const [name, table] of part.tables) {
      const present = this.rowsOn(outer, whole, name, table.columns)
      if (present === undefined) return false
      for (const row of table.rows) if (!present.has(row)) return false
    }
    return true
  }

  /**
   * `local` with the rows only `incoming` holds added to it, or undefined when the two cannot
   * merge: a row both hold differently, a table or column `local` lacks, or a database that
   * cannot be read. `local` itself comes back when it already holds everything.
   */
  merge(local: Uint8Array, incoming: Uint8Array): Uint8Array | undefined {
    if (sameBytes(local, incoming)) return local
    const mine = this.contents(local)
    const theirs = this.contents(incoming)
    if (mine === undefined || theirs === undefined) return undefined
    const missing = new Map<string, Set<string>>()
    for (const [name, table] of theirs.tables) {
      const present = this.rowsOn(local, mine, name, table.columns)
      if (present === undefined) return undefined
      const rows = new Set([...table.rows].filter(row => !present.has(row)))
      if (rows.size > 0) missing.set(name, rows)
    }
    if (missing.size === 0) return local
    const module = this.module()
    const directory = this.directory()
    if (module === undefined || directory === undefined) return undefined
    const target = join(directory, randomUUID() + '.db')
    const source = join(directory, randomUUID() + '.db')
    let writer: Database | undefined
    let reader: Database | undefined
    try {
      writeFileSync(target, local, { mode: 0o600 })
      writeFileSync(source, incoming, { mode: 0o600 })
      writer = this.open(module, target, false)
      reader = this.open(module, source, true)
      if (writer === undefined || reader === undefined) return undefined
      writer.exec('BEGIN IMMEDIATE')
      // Edges may arrive before the memories they link; the keys are checked at the commit.
      writer.exec('PRAGMA defer_foreign_keys = ON')
      for (const [name, rows] of missing) {
        const table = theirs.tables.get(name)!
        const own = mine.tables.get(name)!
        const written = table.all.filter(column => own.all.includes(column))
        const insert = writer.prepare(`INSERT INTO ${quote(name)} (${written.map(quote).join(', ')}) VALUES (${written.map(() => '?').join(', ')})`)
        const statement = reader.prepare(`SELECT ${written.map(quote).join(', ')} FROM ${quote(name)}`)
        statement.setReadBigInts(true)
        for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
          if (!this.spend()) throw new Error('the merge read limit was reached')
          if (!rows.has(rowDigest(table.columns, row))) continue
          insert.run(...written.map(column => row[column] as null | number | bigint | string | Uint8Array))
        }
      }
      writer.exec('COMMIT')
      writer.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      writer.close()
      writer = undefined
      return readFileSync(target)
    } catch {
      // A key both sides hold with different content: the versions diverged.
      return undefined
    } finally {
      for (const database of [writer, reader]) {
        try {
          database?.close()
        } catch {}
      }
      for (const path of [target, source]) for (const suffix of ['', '-wal', '-shm', '-journal']) remove(path + suffix)
    }
  }

  dispose(): void {
    if (this.scratch !== undefined) remove(this.scratch)
    this.scratch = undefined
  }

  private spend(): boolean {
    this.remaining -= 1
    return this.remaining >= 0
  }

  private contents(bytes: Uint8Array): Contents | undefined {
    const known = this.known.get(bytes)
    if (known !== undefined) return known ?? undefined
    const contents = this.read(bytes)
    this.known.set(bytes, contents ?? null)
    return contents
  }

  /** The digests of a table's rows over `columns`, which may leave out columns the table has. */
  private rowsOn(bytes: Uint8Array, contents: Contents, name: string, columns: readonly string[]): Set<string> | undefined {
    const table = contents.tables.get(name)
    if (table === undefined || !columns.every(column => table.columns.includes(column))) return undefined
    if (columns.length === table.columns.length) return table.rows
    const key = JSON.stringify([name, columns])
    const cached = this.projections.get(bytes) ?? new Map<string, Set<string> | null>()
    this.projections.set(bytes, cached)
    if (!cached.has(key)) cached.set(key, this.withCopy(bytes, true, database => this.digests(database, name, columns) ?? null) ?? null)
    return cached.get(key) ?? undefined
  }

  private digests(database: Database, name: string, columns: readonly string[]): Set<string> | undefined {
    const rows = new Set<string>()
    if (columns.length === 0) return rows
    const statement = database.prepare(`SELECT ${columns.map(quote).join(', ')} FROM ${quote(name)}`)
    statement.setReadBigInts(true)
    let budget = this.maxRows
    for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
      budget -= 1
      if (budget < 0 || !this.spend()) return undefined
      rows.add(rowDigest(columns, row))
    }
    return rows
  }

  private directory(): string | undefined {
    try {
      if (this.scratch === undefined) {
        for (const name of readdirSync(this.parent)) if (name.startsWith(SCRATCH_PREFIX)) remove(join(this.parent, name))
      }
      // Made again if a sweep took it: the next identity on this root sweeps what it finds.
      if (this.scratch === undefined || !existsSync(this.scratch)) this.scratch = mkdtempSync(join(this.parent, SCRATCH_PREFIX))
    } catch {
      return undefined
    }
    return this.scratch
  }

  /** A connection to a private copy, refused when the copy is missing or empty rather than created. */
  private open(module: Sqlite, path: string, readOnly: boolean): Database | undefined {
    if (!existsSync(path)) return undefined
    const database = new module.DatabaseSync(path, { readOnly })
    database.exec('PRAGMA trusted_schema = OFF')
    const pages = database.prepare('PRAGMA page_count').get() as { page_count?: number | bigint } | undefined
    if (Number(pages?.page_count ?? 0) <= 0) {
      database.close()
      return undefined
    }
    return database
  }

  private withCopy<T>(bytes: Uint8Array, readOnly: boolean, use: (database: Database) => T | undefined): T | undefined {
    const module = this.module()
    if (module === undefined) return undefined
    const directory = this.directory()
    if (directory === undefined) return undefined
    // A private copy: SQLite may add -wal and -shm files beside it, and nothing here writes to the space.
    const path = join(directory, randomUUID() + '.db')
    let database: Database | undefined
    try {
      writeFileSync(path, bytes, { mode: 0o600 })
      database = this.open(module, path, readOnly)
      return database === undefined ? undefined : use(database)
    } catch {
      return undefined
    } finally {
      try {
        database?.close()
      } catch {}
      for (const suffix of ['', '-wal', '-shm', '-journal']) remove(path + suffix)
    }
  }

  private read(bytes: Uint8Array): Contents | undefined {
    return this.withCopy(bytes, true, database => {
      // SQLite's own list, not the schema text: a virtual table runs module code on the data,
      // so a database with one is compared by its bytes, as is one SQLite cannot list.
      const listed = database.prepare("SELECT name, type FROM pragma_table_list WHERE schema = 'main'").all() as Array<{ name: string; type: string }>
      if (listed.some(entry => entry.type !== 'table' && entry.type !== 'view')) return undefined
      const names = listed.filter(entry => entry.type === 'table' && !entry.name.startsWith('sqlite_') && !USAGE_TABLES.has(entry.name))
        .map(entry => entry.name).sort()
      const hash = createHash('sha256')
      const tables = new Map<string, Table>()
      let budget = this.maxRows
      for (const name of names) {
        const all = (database.prepare(`PRAGMA table_info(${quote(name)})`).all() as Array<{ name: string }>).map(column => column.name)
        const columns = all.filter(column => !USAGE_COLUMNS.has(column) && ROW_VALUES.get(name)?.has(column) !== true).sort()
        const rows: string[] = []
        if (columns.length > 0) {
          const statement = database.prepare(`SELECT ${columns.map(quote).join(', ')} FROM ${quote(name)}`)
          statement.setReadBigInts(true)
          for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
            budget -= 1
            if (budget < 0 || !this.spend()) return undefined
            rows.push(rowDigest(columns, row))
          }
        }
        rows.sort()
        hash.update(JSON.stringify(['table', name, columns, rows.length]))
        for (const row of rows) hash.update(row)
        tables.set(name, { columns, all, rows: new Set(rows) })
      }
      return { identity: 'content:' + hash.digest('hex'), tables }
    })
  }
}
