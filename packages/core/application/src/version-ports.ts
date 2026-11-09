import type { Job, WriteResult, WriteProvider } from './workflow-ports.ts';

export interface VersionPlan {
  id: string; candidateId: string; kind: 'revise' | 'supersede' | 'coexist';
  memoryId: string; revisionId: string; number: number; parentId: string | null;
  targetMemoryId: string; baseRevisionId: string; baseProviderId: string; baseHash: string;
  effectiveAt: string; reason: string; evidence: string[];
  conflictCaseId?: string;
}
export interface VersionCheckpoint {
  content: 'pending' | 'invoking' | 'verified'; providerId?: string;
  link: 'pending' | 'invoking' | 'verified' | 'none';
}
export interface VersionOperation { plan: VersionPlan; checkpoint: VersionCheckpoint }
export interface VersionRepository {
  versionOperation(job: Job): VersionOperation;
  versionCheckpoint(job: Job, checkpoint: VersionCheckpoint): void;
  checkSupersedesProjection(job:Job,sourceProviderId:string):void;
  get(id: string): { request: { content: string } };
  finish(job: Job, result: WriteResult, reconciled: boolean): void;
  fail(job: Job, code: string, uncertain: boolean): void;
}
export interface VersionProvider extends WriteProvider {
  readMemory(id: string): Promise<{ id: string; content: string }>;
  linkSupersedes(sourceId: string, targetId: string, metadata: { operationId: string; reason: string; effectiveAt: string }): Promise<unknown>;
}
export interface VersionExecutor { execute(job: Job): Promise<void> }
