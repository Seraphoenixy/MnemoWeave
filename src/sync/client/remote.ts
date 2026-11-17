import type { SyncPage, SyncPush } from '../protocol.ts'

export class RemoteSyncConflict extends Error {
  constructor(readonly cursor: number, message: string) { super(message) }
}

export interface SyncRemote {
  pull(cursor: number, signal?: AbortSignal): Promise<SyncPage>
  push(batch: SyncPush, signal?: AbortSignal): Promise<number>
  uploadBlob(digest: string, bytes: Buffer, signal?: AbortSignal): Promise<void>
  downloadBlob(digest: string, signal?: AbortSignal): Promise<Buffer>
}
