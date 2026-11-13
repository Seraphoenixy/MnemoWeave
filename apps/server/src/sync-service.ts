import type { ApplyOutcome, SyncCoordinator, SyncInboxRecord, SyncLedgerPort } from '../../../packages/core/application/src/sync.ts';
import { SYNC_PROTOCOL_VERSION } from '../../../packages/core/contracts/src/index.ts';

/**
 * Periodic and on-demand sync for one local Server.
 *
 * One pass, in this order: resolve unknown submissions, push the outbox, then for each readable
 * stream pull new changes and apply them. A failing stream records its error and does not stop
 * the others; overlapping passes are skipped rather than queued.
 */

export interface SyncStatusStreamState {
  stream: string;
  cursor: number;
  lastPullAt: string | null;
  lastError: string | null;
  pending: number;
  unknown: number;
  unapplied: number;
}

export interface SyncStatus {
  enabled: boolean;
  protocol: typeof SYNC_PROTOCOL_VERSION;
  streams: SyncStatusStreamState[];
  updatedAt: string;
}

export interface SyncPassResult {
  streams: string[];
  pulled: number;
  applied: number;
  errors: string[];
  skipped: boolean;
}

/** Only the coordinator actions a pass needs, so tests can drive it directly. */
export type SyncPassDriver = Pick<SyncCoordinator, 'resolveUnknown' | 'flushOutbox' | 'pullStream' | 'applyStream' | 'captureSnapshot'>;

export interface SyncServiceOptions {
  remote: { streams(): Promise<{ streams: { stream: string; canRead: boolean }[] }> };
  coordinator: SyncPassDriver;
  ledger: SyncLedgerPort;
  apply: (row: SyncInboxRecord) => Promise<ApplyOutcome>;
  intervalMs?: number;
  now?: () => string;
  settlePublications?: () => Promise<void>;
}

export class SyncService {
  private readonly remote: SyncServiceOptions['remote'];
  private readonly coordinator: SyncPassDriver;
  private readonly ledger: SyncLedgerPort;
  private readonly apply: (row: SyncInboxRecord) => Promise<ApplyOutcome>;
  private readonly intervalMs: number;
  private readonly settlePublications: SyncServiceOptions['settlePublications'];
  private readonly now: () => string;
  private readonly streams = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** The pass in flight, so `stop()` can wait for it instead of closing the ledger underneath it. */
  private inFlight: Promise<SyncPassResult> | undefined;

  constructor(options: SyncServiceOptions) {
    this.remote = options.remote;
    this.coordinator = options.coordinator;
    this.ledger = options.ledger;
    this.apply = options.apply;
    this.intervalMs = options.intervalMs ?? 300000;
    this.settlePublications = options.settlePublications;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get enabled(): boolean { return true; }

  start(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    void this.refresh().catch(() => undefined);
    if (this.intervalMs > 0) {
      this.timer = setInterval(() => { void this.refresh().catch(() => undefined); }, this.intervalMs);
      this.timer.unref?.();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch(() => undefined);
    this.inFlight = undefined;
  }

  refresh(): Promise<SyncPassResult> {
    if (this.running) return Promise.resolve({ streams: [...this.streams], pulled: 0, applied: 0, errors: [], skipped: true });
    const pass = this.runPass();
    this.inFlight = pass;
    return pass;
  }

  private async runPass(): Promise<SyncPassResult> {
    this.running = true;
    try {
      const discovered = await this.remote.streams();
      for (const stream of discovered.streams) if (stream.canRead) this.streams.add(stream.stream);
      let pulled = 0;
      let applied = 0;
      const errors: string[] = [];
      await this.coordinator.resolveUnknown();
      await this.coordinator.flushOutbox();
      for (const stream of [...this.streams]) {
        try {
          const page = await this.coordinator.pullStream(stream);
          pulled += page.received;
          if (page.needsSnapshot) {
            const snapshot = await this.coordinator.captureSnapshot(stream, this.apply);
            applied += snapshot.applied;
            if (snapshot.failed > 0) errors.push(`${stream}:SNAPSHOT_APPLY_INCOMPLETE`);
            continue;
          }
          const result = await this.coordinator.applyStream(stream, this.apply);
          applied += result.applied;
        } catch (error) {
          errors.push(`${stream}:${error instanceof Error ? error.name : 'error'}`);
          this.ledger.setError(stream, error instanceof Error ? error.message.slice(0, 200) : 'SYNC_UNAVAILABLE', this.now());
        }
      }
      await this.settlePublications?.();
      return { streams: [...this.streams], pulled, applied, errors, skipped: false };
    } finally {
      this.running = false;
    }
  }

  status(): SyncStatus {
    // A stream with queued work must stay visible while the remote is unreachable, so the stream
    // list merges the streams already discovered with the streams the outbox mentions.
    const streams = new Set(this.streams);
    for (const row of [...this.ledger.outbox('pending'), ...this.ledger.outbox('unknown')]) streams.add(row.stream);
    return {
      enabled: true,
      protocol: SYNC_PROTOCOL_VERSION,
      updatedAt: this.now(),
      streams: [...streams].sort().map((stream) => {
        const state = this.ledger.state(stream);
        return {
          stream,
          cursor: state.cursor,
          lastPullAt: state.lastPullAt,
          lastError: state.lastError,
          pending: this.ledger.outbox('pending').filter(row => row.stream === stream).length,
          unknown: this.ledger.outbox('unknown').filter(row => row.stream === stream).length,
          unapplied: this.ledger.inbox(stream).length,
        };
      }),
    };
  }
}
