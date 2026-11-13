/**
 * Authorized-write transactions: submit once, then resolve by the same key.
 *
 * A write that a person confirmed must produce one effect. Three things make that true:
 *
 * 1. The Host mints the task id before sending and records the exact request.
 * 2. The Server keys its receipt on `(host, task, index)` and refuses a different payload under
 *    the same key.
 * 3. A retry, a reopened page and a crash all resolve that key instead of creating a new one.
 *
 * This module owns (1) and the resolution loop. It never decides whether a write is allowed; the
 * Server does that with the same rules for every trigger.
 */
import { randomUUID } from 'node:crypto';
import type { UiPendingWrite, WriteTaskOutcome } from '../shared/contract.ts';
import type { MemorySource } from './memory-source.ts';
import type { WriteReceiptEntry, WriteReceiptJournal, WriteReceiptStatus } from './write-receipts.ts';
import { isUnsettled } from './write-receipts.ts';

export interface SubmitInput {
  kind: WriteTaskOutcome['kind'];
  action: WriteTaskOutcome['action'];
  /** Everything the Server needs; `trigger` and `runId` are added by the caller. */
  request: Record<string, unknown>;
  confirmation?: { text: string; baseVersion?: number };
}

/** Outcome of one submission, already recorded in the journal. */
export interface SubmittedWrite {
  taskId: string;
  index: number;
  status: WriteReceiptStatus;
  entryId?: string;
  memoryId?: string;
  entryVersion?: number;
  candidateId?: string;
  errorCode?: string;
}

/** A refusal the Server returned before claiming the key leaves no receipt to resolve. */
export class WriteRefused extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'WriteRefused';
    this.code = code;
  }
}

/** Statuses a refused submission can produce; they are final for that key. */
const REFUSALS = new Set([
  'SCOPE_FORBIDDEN', 'INVALID_INPUT', 'UNAUTHORIZED', 'TURN_NO_RETENTION', 'WORKSPACE_REQUIRED',
  'IDEMPOTENCY_CONFLICT', 'INVALID_STATE', 'NOT_FOUND', 'REVIEW_REQUIRED', 'VERSION_CONFLICT',
  'RULE_CAPACITY_EXCEEDED', 'RULE_ITEM_TOO_LARGE', 'ARCHIVE_CAPACITY_EXCEEDED',
]);

export class WriteTransactions {
  private readonly source: MemorySource;
  private readonly journalSource: WriteReceiptJournal | (() => WriteReceiptJournal);

  constructor(source: MemorySource, journal: WriteReceiptJournal | (() => WriteReceiptJournal)) {
    this.source = source;
    this.journalSource = journal;
  }

  private get journal(): WriteReceiptJournal {
    return typeof this.journalSource === 'function' ? this.journalSource() : this.journalSource;
  }

  /**
   * Submit one confirmed action under a fresh task id, or resume the one already recorded.
   *
   * `taskId` is supplied by a caller that already minted an id (a preview the user confirmed
   * earlier); omitting it mints one now. Repeating this call with the same `taskId` and `index`
   * returns the recorded outcome without sending anything.
   */
  async submit(input: SubmitInput & { taskId?: string; index?: number }): Promise<SubmittedWrite> {
    const taskId = input.taskId ?? randomUUID();
    const index = input.index ?? 0;
    const existing = this.journal.find(taskId, index);
    if (existing !== undefined) {
      if (JSON.stringify(existing.request) !== JSON.stringify(input.request)) throw new WriteRefused('IDEMPOTENCY_CONFLICT');
      return isUnsettled(existing.status) ? this.retry(taskId, index) : toSubmitted(existing);
    }
    this.prepare([{ ...input, taskId, index }]);
    return this.dispatch(taskId, index, input.kind, input.action, input.request);
  }

  prepare(inputs: readonly (SubmitInput & { taskId: string; index: number })[]): void {
    this.journal.beginBatch(inputs);
  }

  async refreshIdleReceipts(): Promise<void> {
    for (const entry of this.journal.list()) {
      if (entry.request['trigger'] !== 'idle-review' || !isUnsettled(entry.status)) continue;
      await this.resolve(entry.taskId, entry.index).catch(() => undefined);
    }
  }

  /**
   * Ask the Server about one recorded action and record the answer.
   *
   * Used by a reopened page: it resolves an unknown outcome without resending the request. A key
   * the Server does not know is reported as such rather than retried blindly, because the write
   * may never have reached it.
   */
  async resolve(taskId: string, index: number): Promise<SubmittedWrite> {
    const journal = this.journal;
    const existing = journal.find(taskId, index);
    try {
      const outcome = await this.source.writeTaskReceipt(taskId, index);
      return toSubmitted(this.record(existing ?? {
        taskId, index, kind: outcome.kind, action: outcome.action, request: {}, status: outcome.status, updatedAt: outcome.updatedAt,
      }, outcome, journal));
    } catch (error) {
      const code = errorCode(error);
      if (code === 'NOT_FOUND') throw new WriteRefused('NOT_FOUND');
      throw error;
    }
  }

  /** Every action of this Host that still needs an answer, Host journal included. */
  async pending(): Promise<UiPendingWrite[]> {
    const recorded = this.journal.list();
    const known = new Set(recorded.map(entry => `${entry.taskId}:${entry.index}`));
    // The Server side is authoritative: an entry this Host forgot, or one another process
    // submitted, still shows up so the page can offer its receipt.
    const remote = await this.source.unsettledWriteTasks(100).catch(() => []);
    const rows: UiPendingWrite[] = recorded.map(entry => ({
      taskId: entry.taskId, index: entry.index, kind: entry.kind, action: entry.action,
      status: entry.status, request: entry.request, updatedAt: entry.updatedAt,
      ...(entry.confirmation === undefined ? {} : { confirmation: entry.confirmation }),
      ...(entry.entryId === undefined ? {} : { entryId: entry.entryId }),
      ...(entry.memoryId === undefined ? {} : { memoryId: entry.memoryId }),
      ...(entry.entryVersion === undefined ? {} : { entryVersion: entry.entryVersion }),
      ...(entry.candidateId === undefined ? {} : { candidateId: entry.candidateId }),
      ...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode }),
    }));
    for (const outcome of remote) {
      if (known.has(`${outcome.taskId}:${outcome.index}`)) continue;
      rows.push({
        taskId: outcome.taskId, index: outcome.index, kind: outcome.kind, action: outcome.action,
        status: outcome.status, request: {}, updatedAt: outcome.updatedAt,
        ...(outcome.entryId === null ? {} : { entryId: outcome.entryId }),
        ...(outcome.memoryId === null ? {} : { memoryId: outcome.memoryId }),
        ...(outcome.entryVersion === null ? {} : { entryVersion: outcome.entryVersion }),
        ...(outcome.candidateId === null ? {} : { candidateId: outcome.candidateId }),
        ...(outcome.errorCode === null ? {} : { errorCode: outcome.errorCode }),
      });
    }
    return rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /** The recorded request for one key, so a caller can resend it verbatim. */
  recorded(taskId: string, index: number): WriteReceiptEntry | undefined {
    return this.journal.find(taskId, index);
  }

  /**
   * Resend a recorded request under its original key.
   *
   * Only reached after the user is told the previous attempt's outcome could not be confirmed.
   * The payload is the recorded one, so the Server either replays its receipt or refuses; it can
   * never interpret this as a second, different write.
   */
  async retry(taskId: string, index: number): Promise<SubmittedWrite> {
    const journal = this.journal;
    const entry = journal.find(taskId, index);
    if (entry === undefined) throw new WriteRefused('NOT_FOUND');
    if (!isUnsettled(entry.status)) return toSubmitted(entry);
    try { return await this.resolve(taskId, index); }
    catch (error) {
      if (!(error instanceof WriteRefused) || error.code !== 'NOT_FOUND' || Object.keys(entry.request).length === 0) throw error;
    }
    if (JSON.stringify(this.journal.find(taskId, index)?.request) !== JSON.stringify(entry.request)) throw new WriteRefused('NOT_FOUND');
    return this.dispatch(taskId, index, entry.kind, entry.action, entry.request);
  }

  private async dispatch(
    taskId: string, index: number, kind: WriteTaskOutcome['kind'],
    action: WriteTaskOutcome['action'], request: Record<string, unknown>,
  ): Promise<SubmittedWrite> {
    const journal = this.journal;
    let outcome: WriteTaskOutcome;
    try {
      outcome = await this.source.writeTaskAction(taskId, index, request);
    } catch (error) {
      const code = errorCode(error);
      // A refusal before the key was claimed leaves no receipt; recording it as `failed` keeps
      // the entry from looking unsettled forever, and the code is what the page reports.
      if (REFUSALS.has(code)) {
        const entry = journal.find(taskId, index)!;
        journal.settle({ ...entry, status: 'failed', errorCode: code });
        throw new WriteRefused(code);
      }
      // Anything else (timeout, transport) is unresolved: the write may have happened. Leaving
      // the entry `pending` is what makes the page ask instead of submitting again.
      throw error;
    }
    return toSubmitted(this.record(journal.find(taskId, index) ?? {
      taskId, index, kind, action, request, status: 'pending', updatedAt: new Date().toISOString(),
    }, outcome, journal));
  }

  private record(entry: WriteReceiptEntry, outcome: WriteTaskOutcome, journal: WriteReceiptJournal): WriteReceiptEntry {
    return journal.settle({
      taskId: entry.taskId,
      index: entry.index,
      kind: entry.kind,
      action: entry.action,
      request: entry.request,
      status: outcome.status,
      updatedAt: outcome.updatedAt,
      ...(entry.confirmation === undefined ? {} : { confirmation: entry.confirmation }),
      ...(outcome.entryId === null ? {} : { entryId: outcome.entryId }),
      ...(outcome.memoryId === null ? {} : { memoryId: outcome.memoryId }),
      ...(outcome.entryVersion === null ? {} : { entryVersion: outcome.entryVersion }),
      ...(outcome.candidateId === null ? {} : { candidateId: outcome.candidateId }),
      ...(outcome.errorCode === null ? {} : { errorCode: outcome.errorCode }),
    });
  }
}

function toSubmitted(entry: WriteReceiptEntry): SubmittedWrite {
  return {
    taskId: entry.taskId,
    index: entry.index,
    status: entry.status,
    ...(entry.entryId === undefined ? {} : { entryId: entry.entryId }),
    ...(entry.memoryId === undefined ? {} : { memoryId: entry.memoryId }),
    ...(entry.entryVersion === undefined ? {} : { entryVersion: entry.entryVersion }),
    ...(entry.candidateId === undefined ? {} : { candidateId: entry.candidateId }),
    ...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode }),
  };
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return 'INTERNAL';
}
