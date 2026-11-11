import { MnemoWeaveError } from '../../contracts/src/index.ts';
import type { ReadGrantRecord } from '../../contracts/src/index.ts';

/**
 * Memory visibility.
 *
 * A formal memory is either general (`projectId` null) or owned by one project. General memory
 * is readable wherever the grant includes the global scope; project memory needs that project
 * in the grant. Attribution never grants access on its own: the Server resolves the stored
 * owner and asks this function, so a request cannot widen its own reach.
 */
export function mayRead(grant: ReadGrantRecord): boolean {
  return grant.globalIncluded;
}

/** Whether this grant covers a memory with the given owner (null = general knowledge). */
export function mayReadMemory(grant: ReadGrantRecord, projectId: string | null | undefined): boolean {
  if (projectId === null || projectId === undefined) return grant.globalIncluded;
  return grant.projects.includes('*') || grant.projects.includes(projectId);
}

/** A project named in a request must be inside the grant; naming it is not authorization. */
export function assertProjectReadable(grant: ReadGrantRecord, projectId: string | undefined): void {
  if (projectId === undefined) return;
  if (!grant.projects.includes('*') && !grant.projects.includes(projectId)) throw new MnemoWeaveError('SCOPE_FORBIDDEN');
}

export function assertGrant(grant: ReadGrantRecord): void {
  if (Date.parse(grant.expiresAt) <= Date.now()) throw new MnemoWeaveError('UNAUTHORIZED');
}
