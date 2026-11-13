/**
 * Why an idle review did not run, per session.
 *
 * A review that never started leaves no Server-side run to inspect, so "nothing happened" would
 * otherwise be indistinguishable from "the trigger never fired". The Host records the reason it
 * declined to start in its own state directory, and the overview shows those entries beside the
 * runs that did happen.
 *
 * The reasons that stop a run before it starts are exactly the ones that do not consume an
 * attempt: no model route, missing evidence, a paused team, or a cooldown that has not elapsed.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A condition that stopped the review before any run existed. */
export type IdleSkipCode = 'no-route' | 'no-evidence' | 'paused' | 'cooldown' | 'attempts' | 'idle' | 'score';

export interface IdleSkipEntry {
  sessionId: string;
  reason: IdleSkipCode;
  /** Optional detail, such as the remaining cooldown. */
  detail?: string;
  at: string;
}

/** Only the most recent entries are kept; this list is a short explanation, not a history. */
const KEEP = 200;

interface SkipFile { version: 1; items: IdleSkipEntry[] }

function isEntry(value: unknown): value is IdleSkipEntry {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row['sessionId'] === 'string'
    && typeof row['reason'] === 'string'
    && ['no-route', 'no-evidence', 'paused', 'cooldown', 'attempts', 'idle', 'score'].includes(row['reason'])
    && typeof row['at'] === 'string';
}

export class IdleSkipJournal {
  private readonly path: string;

  constructor(stateDir: string) {
    this.path = join(stateDir, 'mnemoweave-idle-skips.json');
  }

  list(): IdleSkipEntry[] {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<SkipFile>;
      return Array.isArray(parsed.items) ? parsed.items.filter(isEntry) : [];
    } catch {
      return [];
    }
  }

  /**
   * Record one decline.
   *
   * Repeating the same reason for the same session updates the timestamp instead of appending,
   * so a session that is waiting on one cause shows one line rather than one line per tick.
   */
  record(entry: Omit<IdleSkipEntry, 'at'> & { at?: string }): IdleSkipEntry {
    const row: IdleSkipEntry = { ...entry, at: entry.at ?? new Date().toISOString() };
    const rest = this.list().filter(item => !(item.sessionId === row.sessionId && item.reason === row.reason));
    const items = [...rest, row]
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, KEEP);
    const temporary = `${this.path}.${process.pid}.tmp`;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(temporary, JSON.stringify({ version: 1, items } satisfies SkipFile), 'utf8');
    renameSync(temporary, this.path);
    return row;
  }

  /** Forget a session's decline once a run for it actually started. */
  clear(sessionId: string): void {
    const remaining = this.list().filter(item => item.sessionId !== sessionId);
    if (remaining.length === this.list().length) return;
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, items: remaining } satisfies SkipFile), 'utf8');
    renameSync(temporary, this.path);
  }
}
