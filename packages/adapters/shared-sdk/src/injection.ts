import { performance } from 'node:perf_hooks';

/**
 * Host-agnostic resident-rule delivery.
 *
 * The only thing injected is the complete rule set. There is no bounded View, no session
 * projection and no memory budget: a rule block either arrives whole or the delivery fails and the
 * host reports it. A partial set would let the model believe a rule was removed when it was
 * merely not delivered.
 */

export interface RuleSource {
  rules(): Promise<{ rules: Array<{ entryId: string; version: number; body: string; importance?: 'critical' | 'normal' | 'low'; bodyBytes: number }>; usedBytes: number; limitBytes: number; complete: boolean }>;
  /** Live authorization check; a revoked session must not receive a fresh block. */
  isAuthorized?(): Promise<boolean>;
}

export type InjectionStatus = 'injected' | 'unavailable' | 'denied' | 'incomplete';

export interface InjectionOutcome {
  status: InjectionStatus;
  reason: string;
  /** Present only on a real delivery; never on a miss. */
  deliveredAtTurn?: string;
  usedBytes?: number;
  limitBytes?: number;
}

export interface InjectionTurn { sessionId: string; turnId: string }

const DEFAULT_DEADLINE_MS = 2_000;

/**
 * Host-agnostic injection controller: one complete rule delivery per turn, a monotonic foreground
 * deadline, and an explicit miss. Late results are never delivered into a new turn.
 */
export class InjectionController {
  private readonly deadlineMs: number;
  private readonly source: RuleSource;
  private current: { sessionId: string; turnId: string; text: string } | undefined;
  private generation = 0;
  private disposed = false;
  constructor(source: RuleSource, options: { deadlineMs?: number } = {}) {
    this.source = source;
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  }

  /** The block already delivered for this session, if the host may reuse it inside one turn. */
  currentBlockFor(sessionId: string): string | undefined {
    return !this.disposed && this.current?.sessionId === sessionId ? this.current.text : undefined;
  }

  /** Same turn, same text: reuse. A new turn reads again, even when nothing changed. */
  cachedForTurn(sessionId: string, turnId: string): string | undefined {
    if (this.disposed || this.current?.sessionId !== sessionId) return undefined;
    return this.current.turnId === turnId ? this.current.text : undefined;
  }

  dispose(): void { this.disposed = true; this.generation += 1; this.current = undefined; }

  async inject(turn: InjectionTurn): Promise<InjectionOutcome> {
    const deadline = performance.now() + this.deadlineMs;
    const generation = ++this.generation;
    const live = () => !this.disposed && this.generation === generation;
    const bounded = async <T>(operation: Promise<T>): Promise<T | undefined> => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) { void operation.catch(() => undefined); return undefined; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation,
          new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), remaining); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    };
    try {
      if (this.disposed) return { status: 'unavailable', reason: 'session ended' };
      if (this.source.isAuthorized) {
        const authorized = await bounded(this.source.isAuthorized());
        if (!live()) return { status: 'unavailable', reason: 'turn superseded or session ended' };
        if (authorized === undefined) return { status: 'unavailable', reason: 'authorization deadline exceeded' };
        if (authorized !== true) return { status: 'denied', reason: 'revoked' };
      }
      const delivered = await bounded(this.source.rules());
      if (delivered === undefined) return { status: 'unavailable', reason: 'foreground deadline exceeded; normal tasks may continue' };
      if (!live()) return { status: 'unavailable', reason: 'turn superseded or session ended' };
      if (!delivered.complete) return { status: 'incomplete', reason: 'the host output limit could not hold every rule', usedBytes: delivered.usedBytes, limitBytes: delivered.limitBytes };
      const text = renderRules(delivered.rules);
      if (text !== '') this.current = { sessionId: turn.sessionId, turnId: turn.turnId, text };
      return { status: 'injected', reason: 'resident rules delivered whole', deliveredAtTurn: turn.turnId, usedBytes: delivered.usedBytes, limitBytes: delivered.limitBytes };
    } catch {
      return { status: 'unavailable', reason: 'rule delivery unavailable' };
    }
  }
}

/**
 * Render every rule whole, in the order the Server returned. No rule is trimmed, reordered or
 * dropped here; an empty set renders nothing.
 */
export function renderRules(rules: ReadonlyArray<{ body: string }>): string {
  const bodies = rules.map(rule => rule.body.trim()).filter(body => body !== '');
  if (bodies.length === 0) return '';
  return `准则（用户确认，按此执行）：\n${bodies.map(body => `- ${body}`).join('\n')}`;
}
