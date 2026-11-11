import type { Assessment, CandidateRecord } from '../../contracts/src/index.ts';

export interface WriteResult { id: string; action: 'added' | 'skipped' }
export interface WriteProvider {
  health(): Promise<unknown>;
  recall(input: { query: string; limit: number }): Promise<{ memories: { id: string; content: string }[] }>;
  inspectExact(content: string): Promise<{ matches: { id: string; content: string }[]; complete: boolean }>;
  verifyContent(id: string, content: string): Promise<boolean>;
  persistReviewed(content: string, writeKey: string): Promise<WriteResult>;
}
export type ReviewDecision = 'approve' | 'reject' | 'human';
export interface Job { taskId: string; runId: string; candidateId: string; writeKey: string; checkpoint: 'ready' | 'writing' | 'retry'; owner: string }
export interface WorkflowRepository {
  get(id: string): CandidateRecord;
  /** Oldest pending candidate; `exclude` skips candidates this worker is already reviewing. */
  pending(exclude?: readonly string[]): string | undefined;
  isKnownDuplicate(candidateId: string, providerIds: string[]): boolean;
  acquire(owner: string, duration: number): boolean;
  renew(owner: string, duration: number): boolean;
  release(owner: string): void;
  review(id: string, decision: ReviewDecision, actor: string, reason: string, assessment: Assessment | null, owner?: string): CandidateRecord;
  claim(owner: string): Job | undefined;
  writing(job: Job): void;
  finish(job: Job, result: WriteResult, reconciled: boolean): void;
  fail(job: Job, code: string, uncertain: boolean): void;
  retry(id: string, actor: string, reason: string): CandidateRecord;
  /** Optional RETENTION-01/02 sweep (candidate bodies and session events); scheduled by the workflow. */
  sweepRetention?(now: Date): unknown;
}
