const DOCUMENT_RECEIPT_FIELDS = ['id', 'title', 'description', 'status', 'revision', 'contentHash', 'sizeBytes', 'sourcePaths', 'memoryBodyIds', 'archivedAt', 'archiveSummary'] as const

/**
 * The fields of a written Document the model needs to refer to it: never its body, which it just
 * wrote, nor a path under the storage root, which it could read as one in the workspace. The
 * content hash is what an archive's lineage names.
 */
export function documentReceipt(value: unknown): unknown {
  const result = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  const snapshot = result?.snapshot
  if (result === undefined || typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return value
  const { snapshot: _snapshot, document, ...rest } = result
  const totals = snapshot as Record<string, unknown>
  const written = typeof document === 'object' && document !== null && !Array.isArray(document) ? document as Record<string, unknown> : undefined
  return {
    ...rest,
    ...(written === undefined ? {} : { document: Object.fromEntries(DOCUMENT_RECEIPT_FIELDS.filter(key => written[key] !== undefined).map(key => [key, written[key]])) }),
    documents: { active: totals.activeCount, archived: totals.archivedCount, activeBytes: totals.activeBytes, limitBytes: totals.limitBytes },
  }
}
