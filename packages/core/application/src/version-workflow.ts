import { createHash } from 'node:crypto';
import { MnemoWeaveError, publicError } from '../../contracts/src/index.ts';
import type { Job } from './workflow-ports.ts';
import type { VersionExecutor, VersionRepository, VersionProvider } from './version-ports.ts';

export class VersionWorkflow implements VersionExecutor {
  private readonly repository: VersionRepository;
  private readonly provider: VersionProvider;
  constructor(repository: VersionRepository, provider: VersionProvider) { this.repository = repository; this.provider = provider; }
  async execute(job: Job): Promise<void> {
    let retryableLink = false; let uncertainContent = false;
    try {
      const operation = this.repository.versionOperation(job);
      const { plan,checkpoint } = operation;
      const content = this.repository.get(job.candidateId).request.content;
      uncertainContent = checkpoint.content === 'invoking';
      const base = await this.provider.readMemory(plan.baseProviderId);
      if (createHash('sha256').update(base.content).digest('hex') !== plan.baseHash) throw new MnemoWeaveError('PROVIDER_INTEGRITY');
      let reconciled = checkpoint.content !== 'pending';
      if (checkpoint.content !== 'verified') {
        const exact = await this.provider.inspectExact(content);
        if (!exact.complete || exact.matches.length > 1) throw new MnemoWeaveError('PROVIDER_PROTOCOL');
        if (exact.matches.length === 1) {
          checkpoint.providerId = exact.matches[0]!.id; reconciled = true;
        } else {
          if (checkpoint.content === 'invoking' && job.checkpoint !== 'retry') {
            this.repository.fail(job,'WRITE_OUTCOME_UNKNOWN',true); return;
          }
          await this.provider.health();
          checkpoint.content = 'invoking';
          this.repository.versionCheckpoint(job,checkpoint); uncertainContent = true;
          const result = await this.provider.persistReviewed(content,job.writeKey);
          checkpoint.providerId = result.id;
        }
        if (!await this.provider.verifyContent(checkpoint.providerId!,content)) throw new MnemoWeaveError('PROVIDER_INTEGRITY');
        checkpoint.content = 'verified'; uncertainContent = false;
        this.repository.versionCheckpoint(job,checkpoint);
      } else if (!checkpoint.providerId || !await this.provider.verifyContent(checkpoint.providerId,content)) {
        throw new MnemoWeaveError('PROVIDER_INTEGRITY');
      }
      if (plan.kind === 'supersede') {
        if (checkpoint.providerId === plan.baseProviderId) throw new MnemoWeaveError('REVIEW_REQUIRED');
        if (checkpoint.link !== 'verified') {
          this.repository.checkSupersedesProjection(job,checkpoint.providerId!);
          checkpoint.link = 'invoking'; this.repository.versionCheckpoint(job,checkpoint); retryableLink = true;
          await this.provider.linkSupersedes(checkpoint.providerId!,plan.baseProviderId,{ operationId: plan.id, reason: plan.reason, effectiveAt: plan.effectiveAt });
          checkpoint.link = 'verified'; this.repository.versionCheckpoint(job,checkpoint);
        }
      }
      this.repository.finish(job,{ id: checkpoint.providerId!, action: reconciled ? 'skipped' : 'added' },reconciled);
    } catch (error) {
      // Content writes are not replayed without reconciliation. A fixed link upsert may be retried.
      if(uncertainContent){
        try{
          const operation=this.repository.versionOperation(job);const content=this.repository.get(job.candidateId).request.content;
          const exact=await this.provider.inspectExact(content);
          if(exact.complete&&exact.matches.length===1&&await this.provider.verifyContent(exact.matches[0]!.id,content)){
            operation.checkpoint.content='verified';operation.checkpoint.providerId=exact.matches[0]!.id;
            this.repository.versionCheckpoint(job,operation.checkpoint);uncertainContent=false;
          }
        }catch{/* An inconclusive read never authorizes reissuing content. */}
      }
      this.repository.fail(job,publicError(error).code,uncertainContent && !retryableLink);
    }
  }
}
