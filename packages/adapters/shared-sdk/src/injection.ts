import { performance } from 'node:perf_hooks';
import { MnemoWeaveError } from '../../../core/contracts/src/index.ts';
import type { ViewRecord } from '../../../core/contracts/src/index.ts';

/** Host-agnostic retrieval source: the Bridge (local-first) or the Server. */
export interface InjectionRecallSource {
  recall(query: string, limit?: number): Promise<{
    status: 'ok' | 'unauthorized' | 'unavailable' | 'corrupted';
    reason?: string;
    memories?: { id: string; content: string; score?: number }[];
    dataTime?: string;
  }>;
  /** Live revocation check (AUTH-02); must consult the current server/license state. */
  isRevoked(): Promise<boolean>;
  isViewUsable?(view: ViewRecord): Promise<boolean>;
}

export interface InjectionOutcome {
  status: 'injected' | 'unavailable' | 'denied' | 'budget_exceeded';
  reason: string;
  /** viewId is present only on real delivery — never on a miss (HOST-04). */
  viewId?: string;
  viewGeneration?: number;
  usedLocalReplica: boolean;
  deliveredAtTurn: string;
  dataTime?: string;
}

export type InjectionTrigger = 'session_started' | 'message_user' | 'tool_failure' | 'tool_important' | 'explicit_recall' | 'budget_near' | 'license_change';

export interface InjectionTurn { sessionId: string; turnId: string }

const DEFAULT_DEADLINE_MS = 2_000; // HOST-06

/**
 * Host-agnostic injection controller (HOST-04/05/06): session-start full views,
 * incremental triggers only, a monotonic foreground deadline with explicit unavailability,
 * revocation denial mid-deadline, and late results delivered only as new views.
 */
export class InjectionController {
  private currentView: ViewRecord | undefined;
  private currentSession: string | undefined;
  private generation = 0;
  private disposed = false;
  private late: { sessionId: string; view: ViewRecord; generation: number } | undefined;
  private readonly deadlineMs: number;
  private readonly recallSource: InjectionRecallSource;
  private readonly assemble: (query: string | null, memories: { id: string; content: string; score?: number }[]) => Promise<ViewRecord>;
  constructor(
    recallSource: InjectionRecallSource,
    assemble: (query: string | null, memories: { id: string; content: string; score?: number }[]) => Promise<ViewRecord>,
    options: { deadlineMs?: number } = {},
  ) { this.recallSource = recallSource; this.assemble = assemble; this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS; }
  currentViewFor(sessionId: string): ViewRecord | undefined { return !this.disposed && this.currentSession === sessionId ? this.currentView : undefined; }
  isIncrementalTrigger(trigger: InjectionTrigger): boolean { return trigger !== 'session_started'; }
  dispose(): void { this.disposed = true; this.generation++; this.late = undefined; this.currentView = undefined; }
  async inject(trigger: InjectionTrigger, turn: InjectionTurn, query: string | null, usedLocalReplica: boolean, override?: typeof this.assemble): Promise<InjectionOutcome> {
    const deadline = performance.now() + this.deadlineMs;
    const previousGeneration = this.generation;
    const generation = ++this.generation;
    const assemble = override ?? this.assemble;
    const outcome = (status: InjectionOutcome['status'], reason: string): InjectionOutcome => ({ status, reason, usedLocalReplica, deliveredAtTurn: turn.turnId });
    const live = () => !this.disposed && this.generation === generation;
    const deadlineResult = Symbol('deadline');
    const bounded = async <T>(operation: Promise<T>): Promise<T | typeof deadlineResult> => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) { void operation.catch(() => undefined); return deadlineResult; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([operation, new Promise<typeof deadlineResult>(resolve => { timer = setTimeout(() => resolve(deadlineResult), remaining); })]); }
      finally { if (timer) clearTimeout(timer); }
    };
    const authorized = async (): Promise<InjectionOutcome | undefined> => {
      const revoked = await bounded(this.recallSource.isRevoked());
      if (!live()) return outcome('unavailable', 'turn superseded or session ended');
      if (revoked === deadlineResult) return outcome('unavailable', 'authorization deadline exceeded');
      if (revoked) return outcome('denied', 'revoked');
      return undefined;
    };
    const deliver = async (view: ViewRecord, reason: string): Promise<InjectionOutcome> => {
      const denied = await authorized(); if (denied) return denied;
      if (this.recallSource.isViewUsable) {
        const usable = await bounded(this.recallSource.isViewUsable(view));
        if (usable !== true || !live()) return outcome('unavailable', 'view authorization or runtime revision changed');
      }
      this.currentView = view; this.currentSession = turn.sessionId;
      return { ...outcome('injected', reason), viewId: view.viewId, viewGeneration: view.generation, usedLocalReplica: view.delivery === 'local_replica' || usedLocalReplica, dataTime: view.dataTime ?? view.createdAt };
    };
    const registerLate = (view: ViewRecord): void => { if (live()) this.late = { sessionId: turn.sessionId, view, generation }; };
    try {
      if (this.disposed) return outcome('unavailable', 'session ended');
      const denied = await authorized(); if (denied) return denied;
      const pending = this.late; this.late = undefined;
      if (query === null && pending?.sessionId === turn.sessionId && pending.generation === previousGeneration) return deliver(pending.view, 'late result delivered as a new view');
      let memories: { id: string; content: string; score?: number }[] = [];
      if (query !== null) {
        const retrieval = this.recallSource.recall(query);
        const result = await bounded(retrieval);
        if (result === deadlineResult) {
          // Reuse the original read: never submit a second request on timeout.
          void retrieval.then(result => result.status === 'ok' && live() ? assemble(query, result.memories ?? []).then(registerLate) : undefined).catch(() => undefined);
          return outcome('unavailable', 'foreground deadline exceeded; normal tasks may continue');
        }
        if (!live()) return outcome('unavailable', 'turn superseded or session ended');
        if (result.status !== 'ok') return outcome(result.status === 'unauthorized' ? 'denied' : 'unavailable', result.reason ?? result.status);
        memories = result.memories ?? [];
      }
      const assembly = assemble(query, memories);
      const view = await bounded(assembly);
      if (view === deadlineResult) { void assembly.then(registerLate).catch(() => undefined); return outcome('unavailable', 'foreground deadline exceeded during assembly'); }
      return deliver(view, trigger);
    } catch (error) {
      return outcome(error instanceof MnemoWeaveError && error.code === 'VIEW_BUDGET_EXCEEDED' ? 'budget_exceeded' : 'unavailable', 'view assembly or authorization unavailable');
    }
  }
}
