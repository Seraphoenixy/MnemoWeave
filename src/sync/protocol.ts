import { z } from 'zod'

export const SYNC_MAX_BATCH_BYTES = 8 * 1024 * 1024
/**
 * The largest single file a scope may carry, matching the Pack reader's own
 * per-entry limit. One blob request carries one whole file, so this bound is
 * also the body limit of that request: a scope whose file exceeds it cannot be
 * synchronized at all, and the writer reports that instead of failing later
 * with a truncated upload.
 */
export const SYNC_BLOB_BYTES = 128 * 1024 * 1024
export const syncDigest = z.string().regex(/^[a-f0-9]{64}$/u)
export const SYNC_PAGE_LIMIT = 128

export const syncScope = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u)
export const syncCursor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
/** A path inside one scope's snapshot, matching the archive entry it names. */
export const syncEntryPath = z.string().min(1).max(1024)
const recordKey = z.string().min(1).max(512)

/**
 * What one scope publishes: a snapshot named by one digest, described as the
 * files it is built from. A replica compares its own files against this list,
 * so a run moves only the entries whose content differs instead of the whole
 * snapshot. `bytes` is the digest of the assembled archive, which is what makes
 * the result verifiable end to end.
 */
/**
 * The most files one scope may publish, matching the Pack reader's own entry
 * limit so a scope that can be exported can also be described. A manifest of
 * this size stays far below the batch limit even with long document paths.
 */
export const SYNC_MAX_FILES = 4096

export const syncManifest = z.strictObject({
  bytes: syncDigest,
  files: z.array(z.strictObject({ path: syncEntryPath, digest: syncDigest })).min(1).max(SYNC_MAX_FILES),
})
export type SyncManifest = z.infer<typeof syncManifest>

const change = z.discriminatedUnion('operation', [
  z.strictObject({ key: recordKey, operation: z.literal('put'), value: z.json() }),
  z.strictObject({ key: recordKey, operation: z.literal('delete') }),
])

export const syncPush = z.strictObject({
  requestId: z.uuid(),
  baseCursor: syncCursor,
  changes: z.array(change).min(1).max(1024),
}).refine(batch => new Set(batch.changes.map(entry => entry.key)).size === batch.changes.length, {
  message: 'A batch can modify each record only once',
})

export const syncBatch = z.strictObject({
  cursor: syncCursor,
  requestId: z.uuid(),
  changes: z.array(change).min(1).max(1024),
})

export const syncPage = z.strictObject({
  cursor: syncCursor,
  head: syncCursor,
  batches: z.array(syncBatch),
})

export type SyncPush = z.infer<typeof syncPush>
export type SyncPage = z.infer<typeof syncPage>
