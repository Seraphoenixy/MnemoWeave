/**
 * Capacity and retrieval limits shared by contracts, the Application Core, the Server and the
 * DSH surface. Byte limits are measured on UTF-8 bytes, never on JavaScript string length, so
 * multi-byte text cannot pass a check that the stored form would fail.
 */

export const RULE_DELIMITER = '\n§\n';
export const RULE_CAPACITY_BYTES = 14 * 1024;
export const RULE_ITEM_MAX_BYTES = 8 * 1024;
export const RULE_CAPACITY_MAX_BYTES = 1024 * 1024;
/** A maintenance pass aims below the limit, not exactly at it. */
export const RULE_MAINTENANCE_TARGET_RATIO = 0.7;

export const ARCHIVE_BODY_MAX_BYTES = 2 * 1024 * 1024;
export const ARCHIVE_ACTIVE_CAPACITY_BYTES = 10 * 1024 * 1024;
/**
 * Transport ceiling for one JSON request. A 2 MiB body can approach 4 MiB once quotes and
 * control characters are JSON-escaped, so the HTTP readers allow 8 MiB rather than 256 KiB.
 */
export const REQUEST_BODY_MAX_BYTES = 8 * 1024 * 1024;
/** Upstream documents clamp a search to 50; the model-facing default is smaller. */
export const ARCHIVE_SEARCH_LIMIT_DEFAULT = 5;
export const ARCHIVE_SEARCH_LIMIT_MAX = 20;
export const ARCHIVE_SEARCH_EXCERPT_BYTES = 512;
export const ARCHIVE_SEARCH_TOTAL_BYTES = 4096;
export const ARCHIVE_SEARCH_MAX_CALLS = 4;

/** Provider Recall accepts at most 50 hits; callers may still ask for fewer. */
export const RECALL_LIMIT_DEFAULT = 10;
export const RECALL_LIMIT_MAX = 50;
/** Model evidence is a smaller projection than the Provider's Recall surface. */
export const MODEL_EVIDENCE_LIMIT = 5;
export const MODEL_EVIDENCE_LIMIT_MAX = 8;
export const MODEL_EVIDENCE_BODY_BYTES = 1024;
export const MODEL_EVIDENCE_TOTAL_BYTES = 8 * 1024;
