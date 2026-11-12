/**
 * Capacity and retrieval limits shared by contracts, the Application Core, the Server and the
 * DSH surface. Byte limits are measured on UTF-8 bytes, never on JavaScript string length, so
 * multi-byte text cannot pass a check that the stored form would fail. Model-facing content
 * budgets are measured in UTF-16 code units, matching what a host tool actually returns.
 */

export const RULE_DELIMITER = '\n§\n';
/** Total capacity of the one shared rule collection, including the delimiter between entries. */
export const RULE_CAPACITY_BYTES = 10_000;
export const RULE_ITEM_MAX_BYTES = 8 * 1024;
export const RULE_CAPACITY_MAX_BYTES = 1024 * 1024;

export const ARCHIVE_BODY_MAX_BYTES = 2 * 1024 * 1024;
export const ARCHIVE_ACTIVE_CAPACITY_BYTES = 10 * 1024 * 1024;
/**
 * Transport ceiling for one JSON request. A 2 MiB archive body can approach 4 MiB once quotes
 * and control characters are JSON-escaped; the worst case is covered by 16 MiB rather than a
 * tighter bound that a legitimate body could exceed.
 */
export const REQUEST_BODY_MAX_BYTES = 16 * 1024 * 1024;

/** Model-facing archive usage: search and segmented reads share one per-turn call budget. */
export const ARCHIVE_SEARCH_LIMIT_DEFAULT = 5;
export const ARCHIVE_SEARCH_LIMIT_MAX = 20;
/** Search excerpts and one segment are bounded in UTF-16 code units, not bytes. */
export const ARCHIVE_SEARCH_TOTAL_CHARS = 6_000;
export const ARCHIVE_SEGMENT_CHARS = 6_000;
export const ARCHIVE_SEARCH_MAX_CALLS = 4;

/** Provider Recall accepts at most 50 hits; callers may still ask for fewer. */
export const RECALL_LIMIT_DEFAULT = 10;
export const RECALL_LIMIT_MAX = 50;

/** Model evidence for one turn: first query 4 entries, both queries at most 6 total. */
export const MODEL_RECALL_FIRST_LIMIT = 4;
export const MODEL_RECALL_TOTAL_LIMIT = 6;
export const MODEL_RECALL_TOTAL_CHARS = 4_800;
export const MODEL_RECALL_FIRST_CHARS = 3_600;
export const MODEL_RECALL_ITEM_CHARS = 1_200;
/** Relation expansion: once per turn, at most 4 entries. */
export const MODEL_RELATED_LIMIT = 4;
export const MODEL_RELATED_TOTAL_CHARS = 4_000;
/** One complete body read per turn; the stored body limit is in UTF-8 bytes. */
export const MODEL_FULL_BODY_BYTES = 8_000;

/** Task Agent input budget: evidence for one model task, per-archive cap included. */
export const TASK_EVIDENCE_CHARS = 24_000;
export const TASK_ARCHIVE_EVIDENCE_CHARS = 12_000;
export const TASK_OUTPUT_TOKENS = 4_096;
export const TASK_DEADLINE_MS = 60_000;
