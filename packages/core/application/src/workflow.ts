import { randomUUID } from 'node:crypto';
import { MnemoWeaveError, SemanticAssessment, publicError } from '../../contracts/src/index.ts';
import type { ModelGateway, WorkflowRepository, WriteProvider, Job } from './workflow-ports.ts';
import type { VersionExecutor } from './version-ports.ts';

/** Background coordinator. Model calls are restricted to the declared candidate-review component. */
export class MemoryWorkflow {
  private readonly repository: WorkflowRepository;
  private readonly provider: WriteProvider;
  private readonly gateway: ModelGateway | undefined;
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
  constructor(repository: WorkflowRepository, provider: WriteProvider, gateway?: ModelGateway, leaseMs = 90000, versions?: VersionExecutor, reviewConcurrency = 2, admit?: () => boolean, retentionIntervalMs = 3_600_000, background?: () => Promise<void>) {
    this.background = background;
    this.repository = repository; this.provider = provider; this.gateway = gateway; this.leaseMs = leaseMs; this.versions = versions; this.reviewConcurrency = Math.max(1, reviewConcurrency); this.admit = admit; this.retentionIntervalMs = Math.max(0, retentionIntervalMs);
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
  private async review(id: string, owner: string): Promise<void> {
    const candidate = this.repository.get(id);
    if (candidate.request.change) { this.repository.review(id,'human','rules','Version/replacement/conflict intent requires explicit operator review.',null,owner); return; }
    let assessment = null;
    try {
      const exact = await this.provider.inspectExact(candidate.request.content);
      if (!exact.complete) { this.repository.review(id, 'human', 'rules', 'Duplicate lookup truncated; cannot decide.', null, owner); return; }
      if (exact.matches.length) {
        const duplicate = this.repository.isKnownDuplicate(id, exact.matches.map(memory => memory.id));
        this.repository.review(id, duplicate ? 'reject' : 'human', 'rules', duplicate ? 'Identical memory with the same known applicability already exists.' : 'Identical content exists, but applicability/evidence differs or is unknown; preserve both for review.', null, owner); return;
      }
      const related = await this.provider.recall({ query: candidate.request.content.slice(0, 2000), limit: 20 });
      if (!this.gateway) { this.repository.review(id, 'human', 'rules', 'Semantic Model Gateway is not configured.', null, owner); return; }
      assessment = SemanticAssessment.parse(await this.gateway.assess('candidate-review', candidate, related.memories));
      const values = Object.values(assessment.checks);
      const important = candidate.request.knowledgeType === 'Architecture' || candidate.request.scope === 'global';
      const uncertain = values.some(check => check.result === 'uncertain');
      const unverified = candidate.request.provenance.verificationStatus !== 'verified' || !candidate.request.provenance.lastVerified;
      if (important || unverified || uncertain || assessment.requiresHuman || assessment.conflict !== 'none') {
        this.repository.review(id, 'human', 'auto-review', assessment.summary, assessment, owner);
      } else if (assessment.checks.reuse.result === 'fail') {
        this.repository.review(id, 'reject', 'auto-review', assessment.summary, assessment, owner);
      } else if (values.every(check => check.result === 'pass')) {
        this.repository.review(id, 'approve', 'auto-review', assessment.summary, assessment, owner);
      } else {
        this.repository.review(id, 'human', 'auto-review', assessment.summary, assessment, owner);
      }
    } catch {
      // A model/refusal/Provider failure never becomes implicit approval.
      this.repository.review(id, 'human', 'auto-review', 'Checks unavailable, invalid or inconclusive; manual review required.', assessment, owner);
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
