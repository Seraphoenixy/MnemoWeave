import { MnemoWeaveError } from '../../contracts/src/index.ts';
import type { ReadGrantRecord } from '../../contracts/src/index.ts';

export interface ScopedMemory { scope: 'project' | 'global'; projectId?: string | undefined }
/** Unattributed legacy project memories require an explicit all-projects grant. */
export function mayRead(grant: ReadGrantRecord, memory: ScopedMemory): boolean {
  return memory.scope === 'global' ? grant.globalIncluded
    : grant.projects.includes('*') || (memory.projectId !== undefined && grant.projects.includes(memory.projectId));
}
export function assertGrant(grant: ReadGrantRecord): void {
  if (Date.parse(grant.expiresAt) <= Date.now()) throw new MnemoWeaveError('UNAUTHORIZED');
}
