import type { MemoryCatalogRecord,ConflictRecord } from '../../contracts/src/index.ts';

/** Formal text is read from Provider; this port supplies only publication metadata. */
export interface MemoryCatalogReader {
  get(memoryId: string): MemoryCatalogRecord;
  visibleProviderIds(): string[];
  /** Logical identities whose current revision is the given Provider memory id (dedup aliases). */
  currentMemoryIds(providerMemoryId: string): string[];
  getConflict(caseId:string):ConflictRecord;
}
