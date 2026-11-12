import { MnemoWeaveError } from '../../contracts/src/index.ts';

/**
 * Access checks for a single-user local deployment.
 *
 * Identity is the service token plus the `x-mnemoweave-host` header; there is no per-host grant
 * document to consult. What remains here is the boundary that does not depend on identity:
 * formal memories are one shared collection, so every identified host reads the same set, while
 * workspace archives are bounded by the session's registered workspace.
 */

export interface Caller {
  hostId: string;
  /** Workspaces the caller may read are resolved from bindings; this carries an operator bypass. */
  operator?: boolean;
}

export function assertHost(hostId: string | undefined): string {
  const value = hostId?.trim();
  if (!value) throw new MnemoWeaveError('UNAUTHORIZED');
  return value;
}

/** A workspace id named in a request must be a registered workspace. */
export function assertWorkspace(workspaceId: string | undefined): string {
  if (workspaceId === undefined || workspaceId.trim() === '') throw new MnemoWeaveError('WORKSPACE_REQUIRED');
  return workspaceId.trim();
}
