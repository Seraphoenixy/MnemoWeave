import { InjectionController } from '../../adapters/shared-sdk/src/injection.ts';
import type { InjectionOutcome, InjectionTrigger } from '../../adapters/shared-sdk/src/injection.ts';
import type { ViewRecord } from '../../core/contracts/src/index.ts';

/**
 * HOST-05 triggers that rebuild the bound View. Events outside this set keep the current
 * View and never reinject; the Bridge decides which Host event maps to which trigger.
 */
const REFRESH_TRIGGERS: ReadonlySet<InjectionTrigger> = new Set<InjectionTrigger>([
  'session_started', 'message_user', 'tool_failure', 'tool_important',
  'explicit_recall', 'budget_near', 'license_change',
]);

export interface SessionInjectionRequest {
  sessionId: string;
  turnId: string;
  trigger: InjectionTrigger;
  query?: string | null | undefined;
  projectId?: string | undefined;
  task?: string | undefined;
  budgetTokens?: number | undefined;
  pinned?: ReadonlyArray<{ memoryId: string; tier: 'critical' | 'normal' }> | undefined;
}

export interface SessionInjectionResult extends InjectionOutcome { text?: string }

/**
 * Bridge-hosted injection state (HOST-05). One controller per Host session keeps the bound
 * View across short-lived hook processes: session start assembles a full View, later
 * triggers deliver a new generation, and ordinary events reuse what is already bound.
 */
export class InjectionSessions {
  private readonly sessions = new Map<string, { controller: InjectionController }>();
  private readonly assemble: (input: {
    query: string | null; sessionId?: string; projectId?: string | undefined; task?: string | undefined; budgetTokens?: number | undefined;
    pinned?: ReadonlyArray<{ memoryId: string; tier: 'critical' | 'normal' }> | undefined;
  }) => Promise<ViewRecord>;
  private readonly isRevoked: () => Promise<boolean>;
  private readonly deadlineMs: number;
  private readonly closed = new Set<string>();
  private readonly isViewUsable: ((view: ViewRecord) => Promise<boolean>) | undefined;

  constructor(options: {
    assemble: (input: {
      query: string | null; sessionId?: string; projectId?: string | undefined; task?: string | undefined; budgetTokens?: number | undefined;
      pinned?: ReadonlyArray<{ memoryId: string; tier: 'critical' | 'normal' }> | undefined;
    }) => Promise<ViewRecord>;
    isRevoked: () => Promise<boolean>;
    deadlineMs?: number;
    isViewUsable?: (view: ViewRecord) => Promise<boolean>;
  }) {
    this.assemble = options.assemble;
    this.isViewUsable = options.isViewUsable;
    this.isRevoked = options.isRevoked;
    this.deadlineMs = options.deadlineMs ?? 2_000;
  }

  get sessionCount(): number { return this.sessions.size; }

  async handle(request: SessionInjectionRequest): Promise<SessionInjectionResult> {
    if (this.closed.has(request.sessionId)) return { status: 'unavailable', reason: 'session ended', usedLocalReplica: false, deliveredAtTurn: request.turnId };
    const controller = this.controllerFor(request);
    if (!REFRESH_TRIGGERS.has(request.trigger)) return { status: 'unavailable', reason: 'unsupported trigger', usedLocalReplica: false, deliveredAtTurn: request.turnId };
    const outcome = await controller.inject(request.trigger, { sessionId: request.sessionId, turnId: request.turnId }, request.query ?? null, false, query => this.assemble({ ...request, query }));
    if (outcome.status !== 'injected') return outcome;
    const view = controller.currentViewFor(request.sessionId);
    return view && view.viewId === outcome.viewId ? { ...outcome, text: renderView(view) } : { status: 'unavailable', reason: 'view superseded before delivery', usedLocalReplica: false, deliveredAtTurn: request.turnId };
  }

  close(sessionId: string): void { this.sessions.get(sessionId)?.controller.dispose(); this.sessions.delete(sessionId); this.closed.add(sessionId); }

  private controllerFor(request: SessionInjectionRequest): InjectionController {
    const existing = this.sessions.get(request.sessionId);
    if (existing) return existing.controller;
    const pinned = request.pinned;
    const controller = new InjectionController(
      { recall: async () => ({ status: 'ok', memories: [] }), isRevoked: this.isRevoked, ...(this.isViewUsable ? { isViewUsable: this.isViewUsable } : {}) },
      async query => this.assemble({ query, ...(pinned !== undefined ? { pinned } : {}) }),
      { deadlineMs: this.deadlineMs },
    );
    this.sessions.set(request.sessionId, { controller });
    return controller;
  }
}

/** Renders the delivered View for Host additionalContext; a miss renders nothing. */
export function renderView(view: ViewRecord): string {
  const memories = view.memories.map(memory => {
    const excerpt = memory.excerpt ? ' (excerpt)' : '';
    return `- [${memory.tier}; ${memory.memoryId}@${memory.revisionId}; ${memory.scope}${memory.projectId ? ':' + memory.projectId : ''}] ${memory.content}${excerpt}`;
  }).join('\n');
  return [view.dataTime ? `Replica data time: ${view.dataTime}${view.stale ? ' (stale)' : ''}` : '', view.guidance, view.runtime?.task ? `Current task (untrusted): ${view.runtime.task}` : '', ...(view.workingContext ?? []).map(entry => `Working context [${entry.eventId}] (untrusted): ${entry.text}`), memories].filter(Boolean).join('\n');
}
