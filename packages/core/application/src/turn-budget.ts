import { createHash, randomUUID } from 'node:crypto';
import { MnemoWeaveError } from '../../contracts/src/index.ts';
import {
  ARCHIVE_SEGMENT_CHARS, ARCHIVE_SEARCH_MAX_CALLS, ARCHIVE_SEARCH_TOTAL_CHARS,
  MODEL_RECALL_FIRST_CHARS, MODEL_RECALL_FIRST_LIMIT, MODEL_RECALL_ITEM_CHARS,
  MODEL_RECALL_TOTAL_CHARS, MODEL_RECALL_TOTAL_LIMIT, MODEL_RELATED_LIMIT, MODEL_RELATED_TOTAL_CHARS,
} from '../../contracts/src/index.ts';

/**
 * Per-turn model budgets.
 *
 * Budgets are accounted per Host, session, agent and turn. The model never supplies those
 * identities: a trusted host reads them from the tool execution context and the Server checks
 * them against the recorded binding, so a model argument cannot widen its own quota.
 *
 * Content is measured in UTF-16 code units, which is what the host tool actually returns.
 * Trimming never splits a surrogate pair.
 */

export interface TurnKey {
  hostId: string;
  sessionId: string;
  agentId: string;
  turnId: string;
}

function turnKey(key: TurnKey): string {
  return JSON.stringify([key.hostId, key.sessionId, key.agentId, key.turnId]);
}

/** Clip to a UTF-16 code-unit budget without splitting a surrogate pair. */
export function clipChars(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let end = Math.max(0, max);
  // Do not end between a high and a low surrogate.
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return { text: text.slice(0, end), truncated: true };
}

export interface RecallBudgetState {
  /** Distinct queries this turn, in order. */
  queries: string[];
  /** Provider memory ids already delivered, so a replay and a second query do not repeat one. */
  deliveredIds: Set<string>;
  deliveredChars: number;
  /** How many entries were already delivered, both queries combined. */
  deliveredCount: number;
  relatedUsed: boolean;
  relatedChars: number;
  relatedIds: Set<string>;
  bodyRead: boolean;
  archiveCalls: number;
}

export interface BudgetedMemory {
  id: string;
  content: string;
  score?: number | undefined;
  /** Relevance bucket derived from the Provider's `confidence`; absent means unknown. */
  relevance?: 'high' | 'medium' | 'low' | 'unknown' | undefined;
}

export type RecallOutcome = {
  memories: Array<{ id: string; content: string; excerpt: boolean; relevance?: 'high' | 'medium' | 'low' | 'unknown' }>;
  truncated: boolean;
  /** A repeat of a query already answered this turn: the earlier result is replayed. */
  replayed: boolean;
};

/**
 * One turn's model-facing read budgets.
 *
 * Direct recall: at most two distinct queries, 6 entries and 4,800 code units total, 1,200 per
 * entry. The first query may use up to 4 entries and 3,600 characters; the second uses what is
 * left. Repeating a query replays the earlier answer and makes no Provider call. Medium and
 * unknown relevance contribute at most one entry each; low relevance is dropped.
 */
export class TurnBudget {
  private readonly state: RecallBudgetState;
  readonly key: TurnKey;
  private readonly firstAnswer = new Map<string, RecallOutcome>();

  constructor(key: TurnKey, state?: RecallBudgetState) {
    this.key = key;
    this.state = state ?? {
      queries: [], deliveredIds: new Set(), deliveredChars: 0, deliveredCount: 0,
      relatedUsed: false, relatedChars: 0, relatedIds: new Set(), bodyRead: false, archiveCalls: 0,
    };
  }

  get archiveCalls(): number { return this.state.archiveCalls; }
  get bodyRead(): boolean { return this.state.bodyRead; }
  get deliveredIds(): ReadonlySet<string> { return this.state.deliveredIds; }
  get queries(): readonly string[] { return this.state.queries; }

  /** Record one archive tool call; search and segmented reads share the budget. */
  takeArchiveCall(): void {
    if (this.state.archiveCalls >= ARCHIVE_SEARCH_MAX_CALLS) throw new MnemoWeaveError('TURN_BUDGET_EXCEEDED');
    this.state.archiveCalls += 1;
  }

  /**
   * Bound one recall answer. `answer` is the Provider result in rank order. The function is
   * deterministic and does not call the Provider, so a retry inside the same turn replays it.
   */
  acceptRecall(query: string, answer: readonly BudgetedMemory[]): RecallOutcome {
    const existing = this.firstAnswer.get(query);
    if (existing) return { ...existing, replayed: true };
    if (this.state.queries.length >= 2) throw new MnemoWeaveError('TURN_BUDGET_EXCEEDED');
    const first = this.state.queries.length === 0;
    const entryLimit = first ? Math.min(MODEL_RECALL_FIRST_LIMIT, MODEL_RECALL_TOTAL_LIMIT) : MODEL_RECALL_TOTAL_LIMIT - this.state.deliveredCount;
    const charLimit = first ? MODEL_RECALL_FIRST_CHARS : MODEL_RECALL_TOTAL_CHARS - this.state.deliveredChars;
    this.state.queries.push(query);
    const memories: RecallOutcome['memories'] = [];
    let used = 0;
    let medium = 0;
    let unknown = 0;
    let truncated = false;
    for (const memory of answer) {
      if (memories.length >= entryLimit) { truncated = true; break; }
      if (this.state.deliveredIds.has(memory.id)) continue;
      const relevance = memory.relevance ?? 'unknown';
      // Low relevance is noise; medium and unknown each contribute at most one entry per turn.
      if (relevance === 'low') continue;
      if (relevance === 'medium') { if (medium >= 1) continue; }
      if (relevance === 'unknown') { if (unknown >= 1) continue; }
      const budget = Math.min(MODEL_RECALL_ITEM_CHARS, charLimit - used, MODEL_RECALL_TOTAL_CHARS - this.state.deliveredChars - used);
      if (budget <= 0) { truncated = true; break; }
      const clipped = clipChars(memory.content, budget);
      if (clipped.text === '') { truncated = true; break; }
      memories.push({
        id: memory.id, content: clipped.text, excerpt: clipped.truncated,
        ...(relevance === 'unknown' ? {} : { relevance }),
      });
      used += clipped.text.length;
      if (clipped.truncated) truncated = true;
      if (relevance === 'medium') medium += 1;
      if (relevance === 'unknown') unknown += 1;
    }
    const outcome: RecallOutcome = { memories, truncated, replayed: false };
    for (const memory of memories) {
      this.state.deliveredIds.add(memory.id);
      this.state.deliveredCount += 1;
    }
    this.state.deliveredChars += used;
    this.firstAnswer.set(query, outcome);
    return outcome;
  }

  /**
   * Bound a relation expansion: once per turn, 4 entries and 4,000 characters, never a memory
   * already delivered this turn. The start memory must be one this turn recalled directly.
   */
  acceptRelated(startId: string, answer: readonly BudgetedMemory[]): { memories: Array<{ id: string; content: string; excerpt: boolean }>; truncated: boolean } {
    if (!this.state.deliveredIds.has(startId)) throw new MnemoWeaveError('INVALID_INPUT');
    if (this.state.relatedUsed) throw new MnemoWeaveError('TURN_BUDGET_EXCEEDED');
    this.state.relatedUsed = true;
    const memories: Array<{ id: string; content: string; excerpt: boolean }> = [];
    let used = 0;
    let truncated = false;
    for (const memory of answer) {
      if (memories.length >= MODEL_RELATED_LIMIT) { truncated = true; break; }
      if (this.state.deliveredIds.has(memory.id) || this.state.relatedIds.has(memory.id)) continue;
      const budget = Math.min(MODEL_RECALL_ITEM_CHARS, MODEL_RELATED_TOTAL_CHARS - used);
      if (budget <= 0) { truncated = true; break; }
      const clipped = clipChars(memory.content, budget);
      if (clipped.text === '') { truncated = true; break; }
      memories.push({ id: memory.id, content: clipped.text, excerpt: clipped.truncated });
      used += clipped.text.length;
      if (clipped.truncated) truncated = true;
    }
    for (const memory of memories) {
      this.state.relatedIds.add(memory.id);
      this.state.deliveredChars += memory.content.length;
    }
    this.state.relatedChars += used;
    return { memories, truncated };
  }

  /** One complete body read of a memory this turn already recalled; 8,000 UTF-8 bytes at most. */
  takeBodyRead(memoryId: string, content: string, maxBytes = 8_000): { content: string; excerpt: boolean } {
    if (!this.state.deliveredIds.has(memoryId) && !this.state.relatedIds.has(memoryId)) throw new MnemoWeaveError('INVALID_INPUT');
    if (this.state.bodyRead) throw new MnemoWeaveError('TURN_BUDGET_EXCEEDED');
    this.state.bodyRead = true;
    if (Buffer.byteLength(content, 'utf8') <= maxBytes) return { content, excerpt: false };
    // The stored limit is in bytes; trim on a character boundary so the text stays valid.
    let out = '';
    for (const character of content) {
      if (Buffer.byteLength(out + character, 'utf8') > maxBytes) break;
      out += character;
    }
    return { content: out, excerpt: true };
  }

  /** An archive search excerpt budget: total characters across the returned hits. */
  static clipArchiveExcerpts(rows: readonly { entryId: string; body: string; title: string }[], totalChars = ARCHIVE_SEARCH_TOTAL_CHARS): { excerpts: Array<{ entryId: string; excerpt: string; truncated: boolean }>; usedChars: number } {
    const excerpts: Array<{ entryId: string; excerpt: string; truncated: boolean }> = [];
    let used = 0;
    for (const row of rows) {
      const budget = totalChars - used;
      if (budget <= 0) break;
      const clipped = clipChars(row.body, budget);
      if (clipped.text === '') break;
      excerpts.push({ entryId: row.entryId, excerpt: clipped.text, truncated: clipped.truncated });
      used += clipped.text.length;
    }
    return { excerpts, usedChars: used };
  }

  toJSON(): RecallBudgetState & { key: TurnKey } {
    return {
      ...this.state,
      deliveredIds: new Set(this.state.deliveredIds),
      relatedIds: new Set(this.state.relatedIds),
      key: this.key,
    };
  }
}

/** In-memory turn budget registry; the Server process owns one instance. */
export class TurnBudgetRegistry {
  private readonly budgets = new Map<string, TurnBudget>();
  private readonly limit: number;
  constructor(limit = 512) {
    this.limit = limit;
  }
  for(key: TurnKey): TurnBudget {
    const id = turnKey(key);
    const existing = this.budgets.get(id);
    if (existing) return existing;
    if (this.budgets.size >= this.limit) {
      // Dropping the oldest turn is safe: a new turn simply starts with a fresh budget.
      const oldest = this.budgets.keys().next().value;
      if (oldest !== undefined) this.budgets.delete(oldest);
    }
    const budget = new TurnBudget(key);
    this.budgets.set(id, budget);
    return budget;
  }
  /** End of a turn: the budget is not carried forward. */
  release(key: TurnKey): void { this.budgets.delete(turnKey(key)); }
  size(): number { return this.budgets.size; }
}

/** Stable token for a cursor, so an archive segment cursor cannot be edited to point elsewhere. */
export function segmentCursorToken(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32) + randomUUID().slice(0, 8);
}

/**
 * The actions each trigger may perform.
 *
 * The trigger is the Host's claim about where the action came from, so it decides what the action
 * may do: a conversation may correct or withdraw a memory, the organizer may withdraw only a
 * memory the instruction named, and the idle review may only add. A trigger that does not allow an
 * action is refused rather than downgraded, because the narrower permission is the whole point.
 */
export const TRIGGER_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  conversation: ['create', 'edit', 'withdraw', 'skip'],
  organize: ['create', 'edit', 'withdraw', 'skip'],
  'reply-save': ['create', 'skip'],
  'archive-distill': ['create'],
  'idle-review': ['create', 'edit', 'remove', 'skip'],
};

/** Throws when the action is outside what the trigger may perform. */
export function assertTriggerAllows(trigger: string, action: string): void {
  const allowed = TRIGGER_ACTIONS[trigger];
  if (allowed === undefined) throw new MnemoWeaveError('INVALID_INPUT');
  if (!allowed.includes(action)) throw new MnemoWeaveError('SCOPE_FORBIDDEN');
}

/**
 * The per-trigger action count. A conversation accepts one model-initiated item, a reply save one,
 * the organizer up to eight, the archive distillation one, and the idle review one.
 */
export const TRIGGER_MAX_ACTIONS: Readonly<Record<string, number>> = {
  conversation: 1,
  organize: 8,
  'reply-save': 1,
  'archive-distill': 1,
  // The review's two changes are different kinds: one rule change and one archive create, at
  // fixed action indexes 0 and 1.
  'idle-review': 2,
};
