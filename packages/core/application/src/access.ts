import { MnemoWeaveError } from '../../contracts/src/index.ts';
import type { ReadGrantRecord } from '../../contracts/src/index.ts';

/**
 * Memory visibility.
 *
 * Formal memories are global: there is no per-project scope to check any more. The grant still
 * carries its own fields for the project archives and project registration paths, so this only
 * answers whether the installing Host may read formal memory at all.
 */
export function mayRead(grant: ReadGrantRecord): boolean {
  return grant.globalIncluded;
}
export function assertGrant(grant: ReadGrantRecord): void {
  if (Date.parse(grant.expiresAt) <= Date.now()) throw new MnemoWeaveError('UNAUTHORIZED');
}
