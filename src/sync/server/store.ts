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
