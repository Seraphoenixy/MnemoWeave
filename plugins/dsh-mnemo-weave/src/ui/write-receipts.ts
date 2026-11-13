/**
 * Submitted write actions and their receipts.
 *
 * Every confirmed write has three parts that must survive a page reload together: the task id,
 * the action index and the request itself. The Server already keys its receipt on
 * `(host, task, index)` and resolves an unknown outcome in place, so the Host's job is to keep the
 * request it sent and to ask about that same key again rather than mint a new one.
 *
 * The journal is a small JSON file beside the Host preferences. It records the request per key, so
 * a reopened page can retry the identical payload; re-sending a different payload under the same
 * key would be `IDEMPOTENCY_CONFLICT`, which is the Server refusing a silent second write.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

/** Status shown for one submitted action. */
export type WriteReceiptStatus =
  | 'published' | 'duplicate' | 'applied' | 'skipped'
  | 'needs_review' | 'queued' | 'unknown' | 'failed'
  /** Recorded locally before the Server answered; never returned by the Server. */
  | 'pending';

export interface WriteReceiptEntry {
  taskId: string;
  index: number;
  kind: 'formal-memory' | 'rule' | 'workspace-archive';
  action: 'create' | 'edit' | 'withdraw' | 'remove' | 'skip';
  status: WriteReceiptStatus;
  /** What the user confirmed, kept so the same request can be sent again. */
  request: Record<string, unknown>;
  /** The confirmation text and base version captured at submit time, when the trigger has one. */
  confirmation?: { text: string; baseVersion?: number };
  memoryId?: string;
  entryId?: string;
  entryVersion?: number;
  candidateId?: string;
  errorCode?: string;
  updatedAt: string;
}

/** How many settled entries are kept; the unsettled ones are never evicted. */
const KEEP_SETTLED = 100;

/** Statuses a reopened page must still be able to act on. */
export const UNSETTLED: ReadonlySet<WriteReceiptStatus> = new Set(['pending', 'queued', 'unknown']);

/** Statuses that will never change without a new submission. */
export const SETTLED: ReadonlySet<WriteReceiptStatus> = new Set([
  'published', 'duplicate', 'applied', 'skipped', 'needs_review', 'failed',
]);

export function isUnsettled(status: WriteReceiptStatus): boolean {
  return UNSETTLED.has(status);
}

interface JournalFile { version: 1; items: WriteReceiptEntry[] }

function empty(): JournalFile { return { version: 1, items: [] }; }

function readJournal(path: string): JournalFile {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return empty(); }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return empty();
    const items = (parsed as { items?: unknown }).items;
    if (!Array.isArray(items)) return empty();
    return { version: 1, items: items.filter(item => isEntry(item)) };
  } catch {
    // A damaged journal is not worth failing a write over: the Server still holds the receipts,
    // and the page can list the unsettled ones from there.
    return empty();
  }
}

function isEntry(value: unknown): value is WriteReceiptEntry {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row['taskId'] === 'string' && typeof row['index'] === 'number'
    && typeof row['kind'] === 'string' && typeof row['action'] === 'string'
    && typeof row['status'] === 'string' && typeof row['updatedAt'] === 'string'
    && typeof row['request'] === 'object' && row['request'] !== null;
}

function prune(items: WriteReceiptEntry[]): WriteReceiptEntry[] {
  const unsettled = items.filter(item => isUnsettled(item.status));
  const settled = items.filter(item => !isUnsettled(item.status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, KEEP_SETTLED);
  return [...unsettled, ...settled];
}

export class WriteReceiptJournal {
  private readonly path: string;

  constructor(stateDir: string, hostScope?: string) {
    const suffix = hostScope === undefined ? '' : '-' + createHash('sha256').update(hostScope).digest('hex');
    this.path = join(stateDir, `mnemoweave-write-receipts${suffix}.json`);
  }

  beginBatch(entries: readonly Omit<WriteReceiptEntry, 'status' | 'updatedAt'>[]): void {
    const updatedAt = new Date().toISOString();
    this.write(current => {
      const known = new Set(current.map(item => item.taskId + ':' + item.index));
      return [...current, ...entries.flatMap(entry => {
        const key = entry.taskId + ':' + entry.index;
        if (known.has(key)) return [];
        known.add(key);
        return [{ ...entry, status: 'pending' as const, updatedAt }];
      })];
    });
  }

  /** A task id for one confirmed action. Minted once, reused by every retry of that action. */
  static newTaskId(): string { return randomUUID(); }

  list(): WriteReceiptEntry[] {
    return readJournal(this.path).items
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  find(taskId: string, index: number): WriteReceiptEntry | undefined {
    return readJournal(this.path).items.find(item => item.taskId === taskId && item.index === index);
  }

  /** Record a submission before it is sent: from here on the request is replayable. */
  begin(entry: Omit<WriteReceiptEntry, 'status' | 'updatedAt'> & { status?: WriteReceiptStatus }): WriteReceiptEntry {
    const record: WriteReceiptEntry = {
      ...entry,
      status: entry.status ?? 'pending',
      updatedAt: new Date().toISOString(),
    };
    this.write(current => {
      const rest = current.filter(item => !(item.taskId === record.taskId && item.index === record.index));
      return [...rest, record];
    });
    return record;
  }

  /** Replace one entry's outcome. An entry that was never begun is recorded anyway. */
  settle(entry: WriteReceiptEntry): WriteReceiptEntry {
    const record = { ...entry, updatedAt: new Date().toISOString() };
    this.write(current => {
      const rest = current.filter(item => !(item.taskId === record.taskId && item.index === record.index));
      return [...rest, record];
    });
    return record;
  }

  /** Drop the request body of a settled entry, keeping the outcome line for the history. */
  private write(update: (items: WriteReceiptEntry[]) => WriteReceiptEntry[]): void {
    const next = prune(update(readJournal(this.path).items));
    const file: JournalFile = { version: 1, items: next };
    // Written through a sibling file and renamed so a crash leaves the previous journal intact
    // rather than a half-written one.
    const temporary = `${this.path}.${process.pid}.tmp`;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(temporary, JSON.stringify(file), 'utf8');
    renameSync(temporary, this.path);
  }
}

/** Where the journal lives: the Host state directory, next to the preferences it belongs to. */
export function journalFor(settingsFile: string, hostScope?: string): WriteReceiptJournal {
  return new WriteReceiptJournal(dirname(settingsFile), hostScope);
}
