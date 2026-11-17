import { isActivityClear } from '../activity-protocol.ts'
import type { SyncPage, SyncPush } from '../protocol.ts'

export class SyncConflict extends Error {
  constructor(readonly cursor: number, message = 'Pull committed changes before retrying this batch') {
    super(message)
  }
}

export interface SyncStore {
  hasBlob(scope: string, digest: string): boolean
  readBlob(scope: string, digest: string): Uint8Array | undefined
  putBlob(scope: string, digest: string, bytes: Uint8Array): void
  /** Remove blocks the newest manifest no longer names, keeping recent ones. */
  pruneBlobs?(scope: string): number
  pull(scope: string, cursor: number): SyncPage
  push(scope: string, input: SyncPush): { cursor: number }
}

/**
 * Whether a pushed batch ends the activity a stream still holds. A clear needs
 * the store to drop the batches that came before it, so the log shrinks instead
 * of growing by the size of what was cleared.
 */
export function carriesActivityClear(changes: SyncPush['changes']): boolean {
  return changes.some(change => change.operation === 'put' && isActivityClear(change.value))
}
