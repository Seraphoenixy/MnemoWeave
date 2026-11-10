import type { ApplyOutcome, SyncCoordinator, SyncInboxRecord, SyncLedgerPort } from '../../../packages/core/application/src/sync.ts';

/**
 * Periodic and on-demand sync for one local Server.
 *
 * One pass per scope, in this order: resolve unknown submissions, push the outbox,
 * pull new changes, apply them. A failing scope records its error and does not stop
 * the others; overlapping passes are skipped rather than queued.
 */

export interface SyncStatusScope {
  scope: string;
  cursor: number;
  lastPullAt: string | null;
  lastError: string | null;
  pending: number;
  unknown: number;
  unapplied: number;
}

export interface SyncStatus {
  enabled: boolean;
  scopes: SyncStatusScope[];
  updatedAt: string;
}

export interface SyncPassResult {
  scopes: string[];
  pulled: number;
  applied: number;
  errors: string[];
  skipped: boolean;
}

/** Only the coordinator actions a pass needs, so tests can drive it directly. */
export type SyncPassDriver = Pick<SyncCoordinator, 'resolveUnknown' | 'flushOutbox' | 'pullScope' | 'applyScope' | 'captureSnapshot'>;

export interface SyncServiceOptions {
  remote: { scopes(): Promise<{ scopes: { scope: string; canRead: boolean }[] }> };
  coordinator: SyncPassDriver;
  ledger: SyncLedgerPort;
  apply: (row: SyncInboxRecord) => Promise<ApplyOutcome>;
  intervalMs?: number;
  now?: () => string;
}

export class SyncService {
  private readonly remote: SyncServiceOptions['remote'];
  private readonly coordinator: SyncPassDriver;
  private readonly ledger: SyncLedgerPort;
  private readonly apply: (row: SyncInboxRecord) => Promise<ApplyOutcome>;
  private readonly intervalMs: number;
  private readonly now: () => string;
  private readonly scopes = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(options: SyncServiceOptions) {
    this.remote = options.remote;
    this.coordinator = options.coordinator;
    this.ledger = options.ledger;
    this.apply = options.apply;
    this.intervalMs = options.intervalMs ?? 300000;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get enabled(): boolean { return true; }

  start(): void {
    this.stop();
    void this.refresh().catch(() => undefined);
    if (this.intervalMs > 0) {
      this.timer = setInterval(() => { void this.refresh().catch(() => undefined); }, this.intervalMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async refresh(): Promise<SyncPassResult> {
    if (this.running) return { scopes: [...this.scopes], pulled: 0, applied: 0, errors: [], skipped: true };
    this.running = true;
    try {
      const grants = await this.remote.scopes();
      for (const grant of grants.scopes) if (grant.canRead) this.scopes.add(grant.scope);
      let pulled = 0;
      let applied = 0;
      const errors: string[] = [];
      await this.coordinator.resolveUnknown();
      await this.coordinator.flushOutbox();
      for (const scope of [...this.scopes]) {
        try {
          const page = await this.coordinator.pullScope(scope);
          pulled += page.received;
          if (page.needsSnapshot) {
            const snapshot = await this.coordinator.captureSnapshot(scope, this.apply);
            applied += snapshot.applied;
            if (snapshot.failed > 0) errors.push(`${scope}:SNAPSHOT_APPLY_INCOMPLETE`);
            continue;
          }
          const result = await this.coordinator.applyScope(scope, this.apply);
          applied += result.applied;
        } catch (error) {
          errors.push(`${scope}:${error instanceof Error ? error.name : 'error'}`);
          this.ledger.setError(scope, error instanceof Error ? error.message.slice(0, 200) : 'SYNC_UNAVAILABLE', this.now());
        }
      }
      return { scopes: [...this.scopes], pulled, applied, errors, skipped: false };
    } finally {
      this.running = false;
    }
  }

  status(): SyncStatus {
    // A scope with queued work must stay visible while the remote is unreachable, so the
    // scope list merges the grants already seen with the scopes the outbox mentions.
    const scopes = new Set(this.scopes);
    for (const row of [...this.ledger.outbox('pending'), ...this.ledger.outbox('unknown')]) scopes.add(row.scope);
    return {
      enabled: true,
      updatedAt: this.now(),
      scopes: [...scopes].sort().map((scope) => {
        const state = this.ledger.state(scope);
        return {
          scope,
          cursor: state.cursor,
          lastPullAt: state.lastPullAt,
          lastError: state.lastError,
          pending: this.ledger.outbox('pending').filter(row => row.scope === scope).length,
          unknown: this.ledger.outbox('unknown').filter(row => row.scope === scope).length,
          unapplied: this.ledger.inbox(scope).length,
        };
      }),
    };
  }
}
