import { randomUUID } from 'node:crypto';
import { MnemoWeaveError, publicError } from '../../contracts/src/index.ts';
import type { WorkflowRepository, WriteProvider, Job } from './workflow-ports.ts';
import type { VersionExecutor } from './version-ports.ts';

/** Background coordinator. It never calls a model: semantic judgement belongs to the host's own session. */
export class MemoryWorkflow {
  private readonly repository: WorkflowRepository;
  private readonly provider: WriteProvider;
  private readonly leaseMs: number;
  private readonly versions: VersionExecutor | undefined;
  private readonly reviewConcurrency: number;
  private readonly admit: (() => boolean) | undefined;
  private readonly retentionIntervalMs: number;
  private blockedByAdmission = false;
  private lastRetentionSweepMs = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private active: Promise<void> | undefined;
  private readonly background: (() => Promise<void>) | undefined;
  constructor(repository: WorkflowRepository, provider: WriteProvider, leaseMs = 90000, versions?: VersionExecutor, reviewConcurrency = 2, admit?: () => boolean, retentionIntervalMs = 3_600_000, background?: () => Promise<void>) {
    this.background = background;
    this.repository = repository; this.provider = provider; this.leaseMs = leaseMs; this.versions = versions; this.reviewConcurrency = Math.max(1, reviewConcurrency); this.admit = admit; this.retentionIntervalMs = Math.max(0, retentionIntervalMs);
  }
  start(intervalMs = 500): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => process.stderr.write('{"event":"workflow_tick_failed"}\n')); }, intervalMs);
    this.timer.unref();
  }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.active; }
  tick(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.run().finally(() => { this.active = undefined; });
    return this.active;
  }
  private async run(): Promise<void> {
    // STORAGE-02 safety floor: below the configured free-space floor the worker stops taking
    // new work (one alert per transition) instead of risking disk exhaustion mid-write.
    if (this.admit && !this.admit()) {
      if (!this.blockedByAdmission) { this.blockedByAdmission = true; process.stderr.write(JSON.stringify({ event: 'worker_blocked_disk_floor' }) + String.fromCharCode(10)); }
      return;
    }
    if (this.blockedByAdmission) { this.blockedByAdmission = false; process.stderr.write(JSON.stringify({ event: 'worker_resumed_after_disk_floor' }) + String.fromCharCode(10)); }
    const owner = randomUUID();
    if (!this.repository.acquire(owner, this.leaseMs)) return;
    const heartbeat = setInterval(() => { try { this.repository.renew(owner, this.leaseMs); } catch { /* Fencing checks prevent a stale commit. */ } }, Math.max(100, Math.floor(this.leaseMs / 3)));
    heartbeat.unref();
    try {
      this.sweepRetentionIfDue();
      // TASK-02: already-approved writes drain before long model calls; reviews then run to
      // completion under the same lease, so a write backlog cannot starve background review.
      const queued = this.repository.claim(owner);
      if (queued) await this.write(queued);
      // TASK-01/TASK-02: up to two background model reviews run concurrently under one lease;
      // provider writes stay serialized behind them and are never parallelized here.
      const reviewing = new Set<string>();
      const reviews: Promise<void>[] = [];
      while (reviews.length < this.reviewConcurrency) {
        const id = this.repository.pending([...reviewing]);
        if (!id || reviewing.has(id)) break;
        reviewing.add(id);
        reviews.push(this.review(id, owner).finally(() => reviewing.delete(id)));
      }
      await Promise.all(reviews);
      const job = this.repository.claim(owner);
      if (job) await this.write(job);
      await this.background?.();
    } finally { clearInterval(heartbeat); this.repository.release(owner); }
  }
  /**
   * RETENTION-01/02: the lease owner schedules the sweep at most once per interval.
   * Sweep failures are logged and never fail the tick; deadlines come from stored
   * state entry times, so a delayed sweep only reports skew.
   */
  private sweepRetentionIfDue(): void {
    const sweep = this.repository.sweepRetention?.bind(this.repository);
    if (!sweep) return;
    const now = Date.now();
    if (now - this.lastRetentionSweepMs < this.retentionIntervalMs) return;
    this.lastRetentionSweepMs = now;
    try { sweep(new Date(now)); } catch { process.stderr.write(JSON.stringify({ event: 'retention_sweep_failed' }) + String.fromCharCode(10)); }
  }
  /**
   * Candidate review is deterministic. The Server never calls an external model: semantic
   * judgement belongs to the host's own session model, which decides what to submit through
   * the injection guidance and the `remember` tool. What remains here is exactly what a
   * machine can prove without a model — identical bodies, truncated lookups, explicit
   * operator intent — and everything else is parked for a human.
   */
  private async review(id: string, owner: string): Promise<void> {
    const candidate = this.repository.get(id);
    if (candidate.request.change) { this.repository.review(id,'human','rules','Version/replacement/conflict intent requires explicit operator review.',null,owner); return; }
    try {
      const exact = await this.provider.inspectExact(candidate.request.content);
      if (!exact.complete) { this.repository.review(id, 'human', 'rules', 'Duplicate lookup truncated; cannot decide.', null, owner); return; }
      if (exact.matches.length) {
        const duplicate = this.repository.isKnownDuplicate(id, exact.matches.map(memory => memory.id));
        this.repository.review(id, duplicate ? 'reject' : 'human', 'rules', duplicate ? 'Identical memory with the same known applicability already exists.' : 'Identical content exists, but applicability/evidence differs or is unknown; preserve both for review.', null, owner); return;
      }
      // No duplicate found, and there is no model here to judge anything further.
      this.repository.review(id, 'human', 'rules', 'No automatic semantic review: the Server does not call a model. A person must approve or reject this candidate.', null, owner);
    } catch {
      // A Provider failure never becomes implicit approval.
      this.repository.review(id, 'human', 'auto-review', 'Checks unavailable or inconclusive; manual review required.', null, owner);
    }
  }
  private async write(job: Job): Promise<void> {
    if (this.repository.get(job.candidateId).request.change) {
      if (!this.versions) { this.repository.fail(job,'REVIEW_REQUIRED',false); return; }
      await this.versions.execute(job); return;
    }
    let uncertain = job.checkpoint === 'writing';
    try {
      const candidate = this.repository.get(job.candidateId);
      const exact = await this.provider.inspectExact(candidate.request.content);
      if (!exact.complete || exact.matches.length > 1) throw new MnemoWeaveError('PROVIDER_PROTOCOL');
      if (exact.matches.length === 1) {
        const memory = exact.matches[0]!;
        if (!await this.provider.verifyContent(memory.id, candidate.request.content)) throw new MnemoWeaveError('PROVIDER_PROTOCOL');
        this.repository.finish(job, { id: memory.id, action: 'skipped' }, true); return;
      }
      // An expired lease or a lost response is only reconciled, never blindly replayed.
      if (job.checkpoint === 'writing') { this.repository.fail(job, 'WRITE_OUTCOME_UNKNOWN', true); return; }
      await this.provider.health();
      this.repository.writing(job); uncertain = true;
      const result = await this.provider.persistReviewed(candidate.request.content, job.writeKey);
      if (!await this.provider.verifyContent(result.id, candidate.request.content)) throw new MnemoWeaveError('PROVIDER_PROTOCOL');
      this.repository.finish(job, result, false);
    } catch (error) {
      if (uncertain) {
        try {
          const candidate = this.repository.get(job.candidateId);
          const exact = await this.provider.inspectExact(candidate.request.content);
          if (exact.complete && exact.matches.length === 1 && await this.provider.verifyContent(exact.matches[0]!.id, candidate.request.content)) {
            this.repository.finish(job, { id: exact.matches[0]!.id, action: 'skipped' }, true); return;
          }
        } catch { /* Retain unknown result, not a second write. */ }
      }
      this.repository.fail(job, publicError(error).code, uncertain);
    }
  }
}
