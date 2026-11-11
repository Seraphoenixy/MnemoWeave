import type { MemoryCatalogRecord,ConflictRecord } from '../../contracts/src/index.ts';

/** Formal text is read from Provider; this port supplies only publication metadata. */
export interface MemoryCatalogReader {
  get(memoryId: string): MemoryCatalogRecord;
  visibleProviderIds(): string[];
  /** Logical identities whose current revision is the given Provider memory id (dedup aliases). */
  currentMemoryIds(providerMemoryId: string): string[];
  getConflict(caseId:string):ConflictRecord;
  /**
   * Owning project of a memory; null means general knowledge. Optional so a test catalogue can
   * omit it: an absent implementation is treated as general, which is the migration default.
   */
  memoryProject?(memoryId: string): string | null;
}
