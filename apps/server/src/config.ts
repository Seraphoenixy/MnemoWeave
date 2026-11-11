import { MemoryRuntime } from '../../../packages/core/application/src/runtime.ts';
import type { ClientHttpEndpoints } from '../../../packages/protocols/http/src/index.ts';
import { z } from 'zod';
import { mkdirSync, statfsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { MnemonCliProvider } from '../../../packages/providers/mnemon/src/index.ts';
import { MemoryApplication, SyncCoordinator, applyInboxEntry, archiveDraft, assertEntryVersion, planArchive, planArchiveEdit, planArchiveState, planEditChange, planRuleCreate, planRuleEdit, ruleDraft, ruleScope, selectIdleReviewSignals, submitLocalChange, toArchiveRecord, toRuleRecord } from '../../../packages/core/application/src/index.ts';
import type { FormalProviderPort, LocalWriteState } from '../../../packages/core/application/src/index.ts';
import { ViewAssembler } from '../../../packages/core/application/src/view.ts';
import { MnemoWeaveError, ArchiveCreate, ArchiveEdit, ArchiveSearchInput, ArchiveStateInput, HostEvent, IdleReviewRunFinishInput, IdleReviewRunItem, IdleReviewRunStartInput, IdleReviewRunStartOutput, IdleReviewScanInput, IdleReviewScanOutput, MemoryCreateInput, MemoryEditInput, MemoryList, MemoryWithdrawInput, RememberInput, RuleArchiveList, RuleCreate, RuleEdit, RuleList, SyncRefreshOutput, SyncStatusOutput, ViewRequest, ARCHIVE_ACTIVE_CAPACITY_BYTES, RULE_CAPACITY_BYTES, RULE_CAPACITY_MAX_BYTES, RULE_ITEM_MAX_BYTES } from '../../../packages/core/contracts/src/index.ts';
import type { DiagnosticJobRecord, ReadGrantRecord, SyncEntryDraftValue } from '../../../packages/core/contracts/src/index.ts';
import { SqliteCandidates } from '../../../packages/infrastructure/governance/src/index.ts';
import type { PublishedFormal } from '../../../packages/infrastructure/governance/src/index.ts';
import { SyncClient } from '../../../packages/infrastructure/sync-client/src/index.ts';
import { SyncService } from './sync-service.ts';
import { isAbsolute, join } from 'node:path';
import { resolve } from 'node:path';
import { MemoryWorkflow } from '../../../packages/core/application/src/workflow.ts';
import { VersionWorkflow } from '../../../packages/core/application/src/version-workflow.ts';

const Config = z.object({
  MNEMON_BINARY: z.string().min(1).default('mnemon'), MNEMON_DATA_DIR: z.string().min(1), MNEMON_STORE: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  MNEMOWEAVE_PORT: z.coerce.number().int().min(0).max(65535).default(4317),
  MNEMOWEAVE_STATE_DIR: z.string().refine(isAbsolute, 'State directory must be absolute').optional(),
  MNEMOWEAVE_WORKER: z.enum(['on', 'off']).default('on'),
  /** One byte-accounted runtime rule collection; metadata added by injection is counted by View. */
  MNEMOWEAVE_RULE_CAPACITY_BYTES: z.coerce.number().int().min(1).max(RULE_CAPACITY_MAX_BYTES).default(RULE_CAPACITY_BYTES),
  MNEMOWEAVE_RULE_ITEM_MAX_BYTES: z.coerce.number().int().min(1).max(RULE_CAPACITY_MAX_BYTES).default(RULE_ITEM_MAX_BYTES),
  /** Active project archives per project scope; archived entries do not consume it. */
  MNEMOWEAVE_ARCHIVE_ACTIVE_CAPACITY_BYTES: z.coerce.number().int().min(1).default(ARCHIVE_ACTIVE_CAPACITY_BYTES),

  // STORAGE-02: no fixed quota is preconfigured; this floor only stops the worker before disk exhaustion.
  MNEMOWEAVE_MIN_FREE_BYTES: z.coerce.number().int().nonnegative().optional(),
  MNEMOWEAVE_QUOTA_SOFT_BYTES: z.coerce.number().int().nonnegative().default(10 * 1024 ** 3),
  MNEMOWEAVE_QUOTA_HARD_BYTES: z.coerce.number().int().nonnegative().default(20 * 1024 ** 3),
  // Remote sync is optional; all three credentials must be present together or none.
  MNEMOWEAVE_SYNC_URL: z.url().optional(),
  MNEMOWEAVE_SYNC_DEVICE_ID: z.string().trim().min(1).max(200).optional(),
  MNEMOWEAVE_SYNC_TOKEN: z.string().min(24).optional(),
  MNEMOWEAVE_SYNC_INTERVAL_MS: z.coerce.number().int().nonnegative().default(300000),
  MNEMOWEAVE_SYNC_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
});
/** Free-space floor guard for the worker; statfs errors fail open (no silent lockup). */
function diskFloorGuard(dir: string, minFreeBytes: number): () => boolean {
  return () => {
    try {
      const stats = statfsSync(dir); return stats.bavail * stats.bsize >= minFreeBytes;
    } catch { return true; }
  };
}

/**
 * Host clients authenticate with the service token and identify themselves through
 * `x-mnemoweave-host`. Without per-host grants the effective scope is the whole store, so the
 * synthetic grant only carries the caller identity; there is nothing to revoke or expire.
 */
/**
 * Keep only edges a renderer could actually draw.
 *
 * A graph response with an edge whose endpoint was dropped by the node cap would force every
 * client to re-implement this filter; a self-loop is also meaningless here, because a memory
 * cannot supersede itself. Exported so the rule is tested directly instead of through a fixture
 * that would have to run the whole candidate pipeline to produce one relation.
 */
export function drawableEdges(
  nodeIds: Iterable<string>,
  edges: Array<{ id: string; kind: string; sourceMemoryId: string; targetMemoryId: string; effectiveAt: string; reason: string }>,
): Array<{ relationId: string; kind: 'Supersedes' | 'RelatedTo' | 'Conflicts'; sourceMemoryId: string; targetMemoryId: string; reason: string; effectiveAt: string }> {
  const present = new Set(nodeIds);
  return edges
    .filter(edge => present.has(edge.sourceMemoryId) && present.has(edge.targetMemoryId) && edge.sourceMemoryId !== edge.targetMemoryId)
    .map(edge => ({
      relationId: edge.id,
      kind: edge.kind === 'Supersedes' ? 'Supersedes' as const : edge.kind === 'Conflicts' ? 'Conflicts' as const : 'RelatedTo' as const,
      sourceMemoryId: edge.sourceMemoryId,
      targetMemoryId: edge.targetMemoryId,
      reason: edge.reason,
      effectiveAt: edge.effectiveAt,
    }));
}

/**
 * A byte-bounded UTF-8 prefix. Search evidence is measured in bytes, so a cut must not
 * split a multi-byte character or it would change the text that reaches the model.
 */
function utf8Prefix(text: string, maxBytes: number): { text: string; bytes: number } {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return { text, bytes };
  const buffer = Buffer.from(text, 'utf8');
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  const prefix = buffer.subarray(0, end).toString('utf8');
  return { text: prefix, bytes: Buffer.byteLength(prefix, 'utf8') };
}

/** A deterministic ranking signal: exact title hits first, then verification, then recency. */
function scoreArchive(row: { title: string; body: string; verification: string; updatedAt?: string | undefined }, query: string): number {
  const lowered = query.toLowerCase();
  let score = Number(row.title.toLowerCase().includes(lowered)) * 12;
  score += Number(row.body.toLowerCase().includes(lowered)) * 4;
  score += row.verification === 'verified' ? 3 : row.verification === 'open' ? 1 : 0;
  return score;
}

/**
 * Only the classification the caller actually set.
 *
 * An omitted field must inherit the previous revision rather than be cleared, so this returns
 * just the present ones — an explicitly empty tag list still means "clear them".
 */
function classificationOf(input: {
  category?: string | undefined;
  knowledgeType?: string | undefined;
  importance?: number | undefined;
  tags?: string[] | undefined;
}): {
  category?: string;
  knowledgeType?: string;
  importance?: number;
  tags?: string[];
} {
  return {
    ...(input.category === undefined ? {} : { category: input.category }),
    ...(input.knowledgeType === undefined ? {} : { knowledgeType: input.knowledgeType }),
    ...(input.importance === undefined ? {} : { importance: input.importance }),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
  };
}

/**
 * List cursors are keyset positions, not array offsets.
 *
 * An offset assumes the list between pages is unchanged. It is not: publishing, withdrawing or a
 * sync apply can insert or remove a row, and an offset then repeats or skips memories. The cursor
 * therefore carries the sort key of the last row returned — `publishedAt` and `memoryId` — and the
 * next page continues strictly after that key, whatever happened in between.
 *
 * Encoded as text so clients treat it as opaque.
 */
interface ListCursor { sort: ListSort; publishedAt: string; importance: number | null; memoryId: string }

/** Orders the list can be scanned in; the cursor carries the one it was issued for. */
type ListSort = 'newest' | 'oldest' | 'importance';

function encodeListCursor(cursor: ListCursor): string {
  // `|` cannot appear in a timestamp, an integer or a UUID, so splitting stays unambiguous where
  // the ISO timestamp's own colons would not.
  return Buffer.from(`v3|${cursor.sort}|${cursor.publishedAt}|${cursor.importance ?? ''}|${cursor.memoryId}`, 'utf8').toString('base64url');
}

function decodeListCursor(cursor: string | undefined): ListCursor | null {
  if (cursor === undefined) return null;
  let decoded: string;
  try { decoded = Buffer.from(cursor, 'base64url').toString('utf8'); } catch { throw new MnemoWeaveError('INVALID_INPUT'); }
  // A v2 cursor predates sorting, so it can only mean the default order.
  const legacy = /^v2:(.+):([0-9a-f-]{36})$/.exec(decoded);
  if (legacy) return { sort: 'newest', publishedAt: legacy[1]!, importance: null, memoryId: legacy[2]! };
  const parts = decoded.split('|');
  // An unrecognised cursor is refused rather than silently restarting: restarting would show the
  // first page again and look like duplicated data.
  if (parts.length !== 5 || parts[0] !== 'v3') throw new MnemoWeaveError('INVALID_INPUT');
  const [, sort, publishedAt, importance, memoryId] = parts as [string, string, string, string, string];
  if (sort !== 'newest' && sort !== 'oldest' && sort !== 'importance') throw new MnemoWeaveError('INVALID_INPUT');
  if (!/^[0-9a-f-]{36}$/.test(memoryId) || publishedAt === '') throw new MnemoWeaveError('INVALID_INPUT');
  const parsedImportance = importance === '' ? null : Number(importance);
  if (parsedImportance !== null && !Number.isInteger(parsedImportance)) throw new MnemoWeaveError('INVALID_INPUT');
  return { sort, publishedAt, importance: parsedImportance, memoryId };
}

/**
 * Order of two entries; negative means `left` appears first.
 *
 * Every order falls back to `publishedAt` and then `memoryId`, so the sequence is total: two
 * entries can never compare equal, which is what keeps a keyset cursor from repeating or skipping.
 * An unrecorded importance sorts last rather than being guessed at, and is still returned as
 * absent so the caller can tell "not recorded" from "recorded as low".
 */
function compareEntries(
  left: { publishedAt: string; importance: number | null; memoryId: string },
  right: { publishedAt: string; importance: number | null; memoryId: string },
  sort: ListSort,
): number {
  const tieBreak = (): number => {
    if (left.publishedAt !== right.publishedAt) {
      return sort === 'oldest' ? (left.publishedAt < right.publishedAt ? -1 : 1) : (left.publishedAt > right.publishedAt ? -1 : 1);
    }
    return left.memoryId < right.memoryId ? -1 : left.memoryId > right.memoryId ? 1 : 0;
  };
  if (sort !== 'importance') return tieBreak();
  const leftRank = left.importance ?? -1;
  const rightRank = right.importance ?? -1;
  if (leftRank !== rightRank) return leftRank > rightRank ? -1 : 1;
  return tieBreak();
}

/** Strictly after the cursor in the requested order. */
function isAfterCursor(
  entry: { publishedAt: string; importance: number | null; memoryId: string },
  cursor: ListCursor | null,
): boolean {
  if (cursor === null) return true;
  return compareEntries(entry, cursor, cursor.sort) > 0;
}

function clientGrant(hostId: string): ReadGrantRecord {
  const now = Date.now();
  return {
    grantId: randomUUID(), hostId, projects: ['*'], globalIncluded: true,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 10 * 365 * 86_400_000).toISOString(), generation: 0,
  };
}

export function configure(env: NodeJS.ProcessEnv = process.env) {
  const config = Config.parse(env);
  const ruleLimits = {
    capacityBytes: config.MNEMOWEAVE_RULE_CAPACITY_BYTES,
    itemMaxBytes: Math.min(config.MNEMOWEAVE_RULE_ITEM_MAX_BYTES, config.MNEMOWEAVE_RULE_CAPACITY_BYTES),
  };
  const archiveLimitBytes = config.MNEMOWEAVE_ARCHIVE_ACTIVE_CAPACITY_BYTES;
  if (config.MNEMOWEAVE_QUOTA_SOFT_BYTES >= config.MNEMOWEAVE_QUOTA_HARD_BYTES) throw new Error('Quota soft limit must be below the hard limit');
  const provider = new MnemonCliProvider({ binary: config.MNEMON_BINARY, dataDir: config.MNEMON_DATA_DIR, store: config.MNEMON_STORE });
  const candidates = config.MNEMOWEAVE_STATE_DIR
    ? new SqliteCandidates(join(config.MNEMOWEAVE_STATE_DIR, 'governance.db'), { softBytes: config.MNEMOWEAVE_QUOTA_SOFT_BYTES, hardBytes: config.MNEMOWEAVE_QUOTA_HARD_BYTES })
    : undefined;
  let workflow: MemoryWorkflow | undefined;
  let sync: SyncService | undefined;
  let coordinator: SyncCoordinator | undefined;
  let formalProvider: FormalProviderPort | undefined;
  try {
    candidates?.bindProvider(JSON.stringify({ directory: resolve(config.MNEMON_DATA_DIR), store: config.MNEMON_STORE }));

    const syncConfigured = !!config.MNEMOWEAVE_SYNC_URL || !!config.MNEMOWEAVE_SYNC_DEVICE_ID || !!config.MNEMOWEAVE_SYNC_TOKEN;
    if (syncConfigured && !(config.MNEMOWEAVE_SYNC_URL && config.MNEMOWEAVE_SYNC_DEVICE_ID && config.MNEMOWEAVE_SYNC_TOKEN)) throw new Error('Remote sync requires URL, device id and token together');
    if (candidates && config.MNEMOWEAVE_WORKER === 'on') {
      const admit = config.MNEMOWEAVE_MIN_FREE_BYTES === undefined ? undefined : diskFloorGuard(config.MNEMOWEAVE_STATE_DIR!, config.MNEMOWEAVE_MIN_FREE_BYTES);
      // No gateway and no background capture: the runtime capture queue reports that it awaits
      // the host's own model rather than running one here.
      workflow = new MemoryWorkflow(candidates, provider, 90000, new VersionWorkflow(candidates, provider), 2, admit, 3_600_000, () => candidates.runtime.tick(undefined)); workflow.start();
    }
    const app = new MemoryApplication(provider, candidates, candidates);
    /**
   * Is this exact text already a published memory?
   *
   * Returns the existing memory in the shape the create call answers with, or null. A Provider that
   * cannot answer counts as "no match": refusing every creation because the duplicate check failed
   * would turn a transient error into a broken feature, and the publisher's own duplicate handling
   * still runs afterwards.
   */
  const findExactDuplicate = async (content: string): Promise<{
    memoryId: string; revisionId: string; providerMemoryId: string; contentHash: string; entryVersion: number; duplicate: true;
  } | null> => {
    if (!candidates) return null;
    let providerId: string;
    try {
      const exact = await provider.inspectExact(content);
      if (!exact.complete || exact.matches.length !== 1) return null;
      providerId = exact.matches[0]!.id;
    } catch { return null; }
    const hash = createHash('sha256').update(content).digest('hex');
    for (const memoryId of candidates.catalog.currentMemoryIds(providerId)) {
      const descriptor = candidates.catalog.get(memoryId);
      if (descriptor.state !== 'active') continue;
      const current = descriptor.revisions.find(revision => revision.id === descriptor.currentRevisionId);
      if (!current || current.contentHash !== hash) continue;
      return {
        memoryId, revisionId: current.id, providerMemoryId: providerId,
        contentHash: current.contentHash, entryVersion: candidates.memory.entryVersion(memoryId),
        duplicate: true,
      };
    }
    return null;
  };

  let client: ClientHttpEndpoints | undefined;
    if (candidates && config.MNEMOWEAVE_STATE_DIR) {
      // VIEW-01/02: assembly re-checks publication state and budget; grants are implicit now.
      // Rules carry no scope: every enabled rule applies to every session.
      const ruleSource = () => candidates.memory.rulesFor()
        .map(row => ({
          entryId: row.entryId, version: row.version, body: row.body,
          importance: row.importance ?? 'normal', pinned: row.pinned === true,
          bodyBytes: Buffer.byteLength(row.body, 'utf8'),
          ...(row.createdAt === undefined ? {} : { createdAt: row.createdAt }),
        }));
      const assembler = new ViewAssembler(app, { rules: ruleSource });
      const memoryRuntime = new MemoryRuntime(candidates.runtime, assembler);
      /**
       * A local write becomes visible only after the remote confirms it.
       *
       * The previous order stored the body first and submitted afterwards, so a rejected
       * write (version conflict, or an entry that already had an unconfirmed change) still
       * left the refused text in `runtime_rules` / `project_archives`, where injection and
       * recall read it. Queued and unknown outcomes are genuinely pending — those are
       * persisted, because nothing was refused and the periodic pass will finish them.
       */
      const submitLocal = async (
        scope: string,
        operation: 'create' | 'update' | 'delete',
        entry: SyncEntryDraftValue,
        baseVersion: number,
        applyLocal: () => void,
        /** Caller-supplied change id, so the caller can look up its own inbox row afterwards. */
        changeId?: string,
      ): Promise<LocalWriteState | 'local_only'> => {
        if (!coordinator) { applyLocal(); return 'local_only'; }
        const result = await submitLocalChange({ scope, operation, entry, baseVersion }, {
          ledger: candidates.ledger,
          flush: () => coordinator!.flushOutbox(),
          now: () => new Date().toISOString(),
          ...(changeId === undefined ? {} : { changeId }),
        });
        // Confirmed, queued or unknown: the change exists and will not be withdrawn, so the
        // working copy matches what the remote will serve to every other machine.
        applyLocal();
        return result.state;
      };
      /**
       * Serializes edits of one logical memory.
       *
       * The version check and the Provider write are separated by several awaits. Two requests
       * carrying the same `entryVersion` both passed the check and both published, so the base
       * version stopped protecting anything. The lock is per entry, so unrelated memories still
       * edit in parallel.
       */
      const editLocks = new Map<string, Promise<unknown>>();
      const withEditLock = async <T>(memoryId: string, operation: () => Promise<T>): Promise<T> => {
        const previous = editLocks.get(memoryId) ?? Promise.resolve();
        const run = previous.then(operation, operation);
        const settled = run.then(() => undefined, () => undefined);
        editLocks.set(memoryId, settled);
        try {
          return await run;
        } finally {
          // Only the last waiter removes the entry, so a queued edit still sees its predecessor.
          if (editLocks.get(memoryId) === settled) editLocks.delete(memoryId);
        }
      };
      /**
       * Rule capacity is a property of the whole collection, so planning two writes against the
       * same snapshot and saving both would exceed the limit. This lock covers plan, remote
       * confirmation and the local save; distinct archives keep their own locks.
       */
      let ruleWrite = Promise.resolve();
      const withRuleLock = async <T>(operation: () => Promise<T>): Promise<T> => {
        const run = ruleWrite.then(operation, operation);
        ruleWrite = run.then(() => undefined, () => undefined);
        return run;
      };
      /**
       * Archive capacity belongs to a project scope. Serializing archive writes (including state
       * changes) keeps a plan from being based on usage another write already consumed.
       */
      let archiveWrite = Promise.resolve();
      const withArchiveLock = async <T>(operation: () => Promise<T>): Promise<T> => {
        const run = archiveWrite.then(operation, operation);
        archiveWrite = run.then(() => undefined, () => undefined);
        return run;
      };
      const writeArchive = async (row: ReturnType<typeof planArchive>, baseVersion: number) => {
        if (!coordinator || !formalProvider) {
          candidates.memory.upsertArchive(row, new Date().toISOString());
          return toArchiveRecord(row);
        }
        const confirmed = candidates.memory.entryVersion(row.entryId);
        if (confirmed !== 0 && confirmed !== baseVersion) throw new MnemoWeaveError('VERSION_CONFLICT');
        const scope = `project:${row.projectId}`;
        const result = await submitLocal(scope, confirmed === 0 ? 'create' : 'update', archiveDraft(row), confirmed, () => undefined);
        if (result === 'queued') throw new MnemoWeaveError('SYNC_QUEUED');
        if (result === 'unknown') throw new MnemoWeaveError('SYNC_OUTCOME_UNKNOWN');
        await coordinator.applyScope(scope, record => applyInboxEntry(record, { store: candidates.memory, provider: formalProvider!, archiveCapacityBytes: archiveLimitBytes }));
        const current = candidates.memory.archive(row.entryId);
        if (!current || current.version <= confirmed) throw new MnemoWeaveError('SYNC_OUTCOME_UNKNOWN');
        return toArchiveRecord(current);
      };
      /** Search call budget resets when a new View is assembled, so it is a per-turn budget. */
      const archiveSearchCalls = new Map<string, number>();
      /** One durable vector backfill at a time; the row is the state, not an in-memory flag. */
      const BACKFILL_KIND = 'embedding-backfill';
      const readEmbedding = async () => { try { return await provider.embeddingStatus(); } catch { return undefined; } };
      const startBackfill = (): DiagnosticJobRecord => {
        const job = candidates.memory.beginDiagnosticJob(BACKFILL_KIND);
        void (async () => {
          try {
            const before = await readEmbedding();
            const result = await provider.embedAll();
            // `embed --all` output is not a stable contract; the coverage report is. The job is
            // succeeded only when the command reported no error, and the after-count shows what
            // actually changed.
            const after = await readEmbedding();
            candidates.memory.finishDiagnosticJob(job.id, result.error === null ? 'succeeded' : 'failed', {
              ...(before === undefined ? {} : { embeddedBefore: before.embedded }),
              ...(after === undefined ? {} : { embeddedAfter: after.embedded, total: after.total }),
              ...(result.error === null ? {} : { error: result.error }),
            });
          } catch (error) {
            candidates.memory.finishDiagnosticJob(job.id, 'failed', { error: error instanceof MnemoWeaveError ? error.code : 'INTERNAL' });
          }
        })();
        return job;
      };
      client = {
        view: async (hostId, input) => {
          archiveSearchCalls.delete(hostId);
          const request = ViewRequest.parse(input);
          const view = await memoryRuntime.view(clientGrant(hostId), request);
          candidates.memory.recordInjection({
            id: randomUUID(), hostId, sessionId: request.sessionId ?? 'unspecified',
            rulesInjected: view.rules?.length ?? 0,
            rulesOmitted: view.rulesBudget?.exceeded ? 'budget_exceeded' : null,
            ...(view.rulesBudget?.exceeded
              ? {
                rulesOmittedCount: view.rulesBudget.omittedCount,
                rulesOmissionReason: view.budgetOmissions?.find(item => item.kind === 'rules')?.reason ?? 'rule budget could not hold complete rules',
              }
              : {}),
            memoriesInjected: view.memories.length,
            usedTokens: view.budget.usedTokens,
            createdAt: new Date().toISOString(),
          });
          return view;
        },
        context: (hostId, input) => {
          if (input.close) candidates.runtime.closeSession(hostId, input.sessionId);
          const context = candidates.runtime.context(hostId, input.sessionId, input.projectId, input.task);
          return { ...context, pins: [...context.pins] };
        },
        pin: input => { candidates.catalog.get(input.memoryId); candidates.runtime.pin(input); },
        register: projectId => candidates.runtime.register(projectId),
        projects: async () => ({ projects: [...new Set([...candidates.runtime.list(), ...candidates.catalog.projects()])].sort() }),
        closeSession: (hostId, sessionId) => candidates.runtime.closeSession(hostId, sessionId),
        events: (hostId, input) => {
          const result = candidates.events.record(hostId, input);
          // The runtime projection has its own idempotency; retention skipping must not hide events from it.
          candidates.runtime.observe(hostId, HostEvent.parse(input));
          return result;
        },
        /**
         * Browse published memories.
         *
         * Order matters: the candidate set is chosen by scope first, in a stable order, and the
         * cursor records how far that scan reached. Matching the query is a later filter, so a
         * page whose candidates are all skipped does not stall — the next page continues from
         * where the scan stopped rather than from how many items were returned.
         */
        memories: async ({ query, limit, category, knowledgeType, entity, sort, cursor, projectId, includeGlobal }) => {
          const terms = query ? query.toLowerCase().split(/\s+/).filter(Boolean) : [];
          // The scan order is chosen first; the cursor then records a position in that order.
          const order: ListSort = sort ?? 'newest';
          const scoped: {
            memoryId: string; providerId: string; publishedAt: string;
            importance: number | null;
            projectId: string | null;
            current: { knowledgeType?: string; category?: string; importance?: number; tags?: string[]; entities?: string[] };
          }[] = [];
          for (const providerId of candidates.catalog.visibleProviderIds()) {
            for (const memoryId of candidates.catalog.currentMemoryIds(providerId)) {
              const descriptor = candidates.catalog.get(memoryId);
              if (descriptor.state !== 'active') continue;
              const current = descriptor.revisions.find(revision => revision.id === descriptor.currentRevisionId);
              if (!current) continue;
              scoped.push({
                memoryId, providerId,
                publishedAt: current.publishedAt,
                importance: current.importance ?? null,
                projectId: descriptor.projectId ?? null,
                current: {
                  ...(current.knowledgeType === undefined ? {} : { knowledgeType: current.knowledgeType }),
                  ...(current.category === undefined ? {} : { category: current.category }),
                  ...(current.importance === undefined ? {} : { importance: current.importance }),
                  ...(current.tags === undefined ? {} : { tags: current.tags }),
                  ...(current.entities === undefined ? {} : { entities: current.entities }),
                },
              });
            }
          }
          // Indexes describe the scoped set, not the filtered one, so choosing a category cannot
          // remove the categories you might switch to.
          const projects = new Map<string, number>();
          const categories = new Map<string, number>();
          const knowledgeTypes = new Map<string, number>();
          // Entities are compared case-insensitively but listed in their recorded spelling, so a
          // filter stays forgiving without rewriting what the memory says.
          const entityNames = new Map<string, string>();
          const entityCounts = new Map<string, number>();
          for (const entry of scoped) {
            projects.set(entry.projectId ?? '', (projects.get(entry.projectId ?? '') ?? 0) + 1);
            if (entry.current.category !== undefined) categories.set(entry.current.category, (categories.get(entry.current.category) ?? 0) + 1);
            if (entry.current.knowledgeType !== undefined) knowledgeTypes.set(entry.current.knowledgeType, (knowledgeTypes.get(entry.current.knowledgeType) ?? 0) + 1);
            for (const value of entry.current.entities ?? []) {
              const key = value.toLowerCase();
              if (!entityNames.has(key)) entityNames.set(key, value);
              entityCounts.set(key, (entityCounts.get(key) ?? 0) + 1);
            }
          }
          // Filters run before the Provider read, so they cost nothing beyond the catalog row. A
          // memory with no recorded category is not "general": it simply does not match a
          // category filter.
          const wantedEntity = entity?.toLowerCase();
          const browsable = scoped.filter(entry =>
            (projectId === undefined
              ? includeGlobal !== false || entry.projectId === null
              : entry.projectId === projectId || (includeGlobal !== false && entry.projectId === null))
            && (category === undefined || entry.current.category === category)
            && (knowledgeType === undefined || entry.current.knowledgeType === knowledgeType)
            && (wantedEntity === undefined || (entry.current.entities ?? []).some(value => value.toLowerCase() === wantedEntity)));
          browsable.sort((left, right) => compareEntries(left, right, order));
          // Continue strictly after the last row the previous page returned. Insertions and
          // withdrawals between pages can no longer shift, repeat or hide a memory.
          const after = decodeListCursor(cursor);
          // A cursor only means something inside the order it was issued for; reusing it after
          // switching order would silently skip rows, so it is refused instead.
          if (after !== null && after.sort !== order) throw new MnemoWeaveError('INVALID_INPUT');
          const remaining = after === null ? browsable : browsable.filter(entry => isAfterCursor(entry, after));
          const items: Array<Record<string, unknown>> = [];
          // Bodies are read in batches rather than one CLI process per row. The window starts at
          // exactly what the page needs and only grows when rows were skipped (a query filtered
          // them out) — reading four times the page up front made every list load pay for rows it
          // never showed.
          let windowSize = limit;
          const maxWindow = Math.max(limit * 4, 96);
          // The position of the last row this page returned; the next cursor is built from it, so
          // a row that could not be read is retried rather than skipped.
          let lastReturned = -1;
          let readFailure = false;
          let index = 0;
          while (index < remaining.length && items.length < limit && !readFailure) {
            const window = remaining.slice(index, index + windowSize);
            let bodies = new Map<string, string>();
            if (typeof provider.readMany === 'function') {
              const read = await provider.readMany(window.map(entry => entry.providerId)).catch(() => []);
              bodies = new Map(read.map(row => [row.id, row.content]));
            } else {
              for (const entry of window) {
                try { bodies.set(entry.providerId, (await provider.readMemory(entry.providerId)).content); } catch { /* counted below */ }
              }
            }
            for (let offset = 0; offset < window.length; offset += 1) {
              if (items.length >= limit) break;
              const entry = window[offset]!;
              const content = bodies.get(entry.providerId);
              if (content === undefined) {
                // A body the Provider could not return is not "no such memory". Stop here: the
                // cursor stays before this row, so a retry re-reads it instead of losing it.
                readFailure = true;
                break;
              }
              const position = index + offset;
              if (terms.length > 0 && !terms.every(term => content.toLowerCase().includes(term))) continue;
              const descriptor = candidates.catalog.get(entry.memoryId);
              const current = descriptor.revisions.find(revision => revision.id === descriptor.currentRevisionId);
              if (!current) continue;
              items.push({
                memoryId: entry.memoryId, revisionId: current.id, providerMemoryId: entry.providerId,
                applicability: descriptor.applicability, publishedAt: current.publishedAt, content,
                projectId: descriptor.projectId ?? null,
                entryVersion: candidates.memory.entryVersion(entry.memoryId),
                // Carried from the candidate so the card can label the memory without a second read.
                ...entry.current,
              });
              lastReturned = position;
            }
            index += window.length;
            // The page is still short and the provider did not fail, so rows in this window were
            // filtered out; widen the next batch instead of paying a second round trip per row.
            if (items.length < limit && !readFailure) windowSize = Math.min(windowSize * 2, maxWindow);
          }
          // Nothing could be returned and the Provider failed: report it, so the page offers a
          // retry instead of claiming the library is empty.
          if (items.length === 0 && readFailure) throw new MnemoWeaveError('PROVIDER_UNAVAILABLE');
          const cursorEntry = lastReturned >= 0 ? remaining[lastReturned]! : null;
          // More to scan when the page filled (or stopped on a read failure) and rows remain.
          const hasMore = cursorEntry !== null && lastReturned + 1 < remaining.length;
          return MemoryList.parse({
            items,
            ...(hasMore ? { nextCursor: encodeListCursor({ sort: order, publishedAt: cursorEntry.publishedAt, importance: cursorEntry.importance, memoryId: cursorEntry.memoryId }) } : {}),
            categories: [...categories].map(([value, count]) => ({ value, count })).sort((left, right) => left.value.localeCompare(right.value)),
            entities: [...entityNames].map(([key, value]) => ({ value, count: entityCounts.get(key) ?? 0 })).sort((left, right) => left.value.localeCompare(right.value)),
            knowledgeTypes: [...knowledgeTypes].map(([value, count]) => ({ value, count })).sort((left, right) => left.value.localeCompare(right.value)),
            projects: [...projects].map(([value, count]) => ({ projectId: value === '' ? null : value, count })).sort((left, right) => (left.projectId ?? '').localeCompare(right.projectId ?? '')),
          });
        },
        /**
         * Provider-ranked semantic search, mapped to memories this machine knows.
         *
         * The list endpoint matches body text over a stable scan; this one asks the Provider for
         * similarity ranking. Results are limited to the visible catalog so an explore answer can
         * never name a memory the caller could not open, and Provider hits with no catalog entry
         * are counted rather than silently dropped.
         */
        explore: async (hostId: string, input: { query: string; limit: number; minScore?: number; projectId?: string }) => {
          const recalled = await app.recallDetailed({ query: input.query, limit: input.limit, ...(input.projectId === undefined ? {} : { projectId: input.projectId }) }, clientGrant(hostId));
          const threshold = input.minScore ?? 0;
          const hits: Array<Record<string, unknown>> = [];
          for (const memory of recalled.memories) {
            // The Provider's score is the only ranking signal here; a hit below the requested floor
            // is noise the caller asked not to see.
            if ((memory.score ?? 0) < threshold) continue;
            for (const memoryId of candidates.catalog.currentMemoryIds(memory.id)) {
              const descriptor = candidates.catalog.get(memoryId);
              if (descriptor.state !== 'active') continue;
              const current = descriptor.revisions.find(revision => revision.id === descriptor.currentRevisionId);
              if (!current) continue;
              hits.push({
                memoryId, revisionId: current.id, providerMemoryId: memory.id,
                state: descriptor.state,
                content: memory.content,
                score: memory.score ?? 0,
                publishedAt: current.publishedAt,
                projectId: descriptor.projectId ?? null,
                ...(current.category === undefined ? {} : { category: current.category }),
                ...(current.knowledgeType === undefined ? {} : { knowledgeType: current.knowledgeType }),
                ...(current.tags === undefined ? {} : { tags: current.tags }),
              });
            }
          }
          // The Provider ranks by its own score and leaves ties in an unstable order: measured on
          // a fixed store, the same query returned three different orders across five calls. That
          // makes a repeated search look like the list shuffled itself, and it breaks "show more"
          // (a larger limit is only a superset if the order is a function of the hits). So the
          // Server imposes a total order of its own: score, then newest, then memoryId.
          hits.sort((left, right) => {
            const leftScore = left['score'] as number;
            const rightScore = right['score'] as number;
            if (leftScore !== rightScore) return rightScore - leftScore;
            const leftAt = left['publishedAt'] as string;
            const rightAt = right['publishedAt'] as string;
            if (leftAt !== rightAt) return leftAt < rightAt ? 1 : -1;
            const leftId = left['memoryId'] as string;
            const rightId = right['memoryId'] as string;
            return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
          });
          // A full page means the ranking had at least that many matches; asking again with a
          // larger limit is how a caller sees further down it.
          return { query: input.query, hits, unregistered: recalled.unregistered.length, truncated: hits.length >= input.limit };
        },
        /**
         * The relation graph.
         *
         * Only structure: nodes are active memories in scope, edges are catalogued relations whose
         * both endpoints are present, so nothing in the answer is undrawable. Bodies are left out
         * on purpose — reading them would cost one Provider process per node.
         */
        graph: async (hostId: string, { limit, projectId, includeGlobal }: { limit: number; projectId?: string; includeGlobal?: boolean }) => {
          void hostId;
          // The graph is drawn for one project: general memories plus that project's, never a
          // neighbour's. An edge is kept only when both endpoints are in that same view.
          const inScope = (owner: string | null): boolean => projectId === undefined || owner === projectId || (includeGlobal !== false && owner === null);
          const nodes: Array<{
            memoryId: string; publishedAt: string;
            state: 'active' | 'superseded' | 'unverified';
            category?: string; knowledgeType?: string; importance?: number;
            projectId: string | null;
          }> = [];
          const describeNode = (memoryId: string): (typeof nodes)[number] | null => {
            const descriptor = candidates.catalog.get(memoryId);
            // A withdrawn memory is not somewhere to navigate to; a superseded one has to stay,
            // because a supersede edge points at it.
            if (descriptor.state === 'superseded' && descriptor.revisions.length === 0) return null;
            if (!inScope(descriptor.projectId ?? null)) return null;
            const current = descriptor.revisions.find(revision => revision.id === descriptor.currentRevisionId);
            if (!current) return null;
            return {
              memoryId,
              state: descriptor.state === 'active' ? 'active' : descriptor.state === 'unverified' ? 'unverified' : 'superseded',
              publishedAt: current.publishedAt,
              projectId: descriptor.projectId ?? null,
              ...(current.category === undefined ? {} : { category: current.category }),
              ...(current.knowledgeType === undefined ? {} : { knowledgeType: current.knowledgeType }),
              ...(current.importance === undefined ? {} : { importance: current.importance }),
            };
          };
          const start = (memoryId: string): (typeof nodes)[number] | null => {
            const descriptor = candidates.catalog.get(memoryId);
            // The scan for starting points only walks what recall would serve.
            if (descriptor.state !== 'active') return null;
            return describeNode(memoryId);
          };
          for (const providerId of candidates.catalog.visibleProviderIds()) {
            for (const memoryId of candidates.catalog.currentMemoryIds(providerId)) {
              const node = start(memoryId);
              if (node !== null) nodes.push(node);
            }
          }
          // A supersede edge points at a memory that is no longer active, so restricting nodes to
          // active ones made every supersede edge undrawable. Pull in the far end of any relation
          // whose near end is already a node, keeping the edge instead of dropping it.
          const present = new Set(nodes.map(node => node.memoryId));
          const related = [
            ...candidates.catalog.allRelations(limit * 8),
            ...candidates.catalog.allConflictEdges(limit * 8),
          ];
          for (const edge of related) {
            for (const [near, far] of [[edge.sourceMemoryId, edge.targetMemoryId], [edge.targetMemoryId, edge.sourceMemoryId]] as const) {
              if (!present.has(near) || present.has(far)) continue;
              const node = describeNode(far);
              if (node === null) continue;
              nodes.push(node);
              present.add(far);
            }
          }
          // Newest first, so the cap keeps the most recent part of the graph rather than an
          // arbitrary slice.
          nodes.sort((left, right) => {
            if (left.publishedAt !== right.publishedAt) return left.publishedAt < right.publishedAt ? 1 : -1;
            return left.memoryId < right.memoryId ? -1 : left.memoryId > right.memoryId ? 1 : 0;
          });
          const truncated = nodes.length > limit;
          const kept = nodes.slice(0, limit);
          // Read every relation, then keep the ones whose endpoints survived the cap: a renderer
          // would have to drop the rest anyway, and doing it here keeps the contract honest.
          const keptIds = kept.map(node => node.memoryId);
          const edges = drawableEdges(keptIds, [
            ...candidates.catalog.allRelations(limit * 8),
            // A conflict that was resolved as "coexist" leaves two live memories that disagree;
            // that relationship is worth drawing, and it is the only kind that survives as a pair.
            ...candidates.catalog.allConflictEdges(limit * 8).map(edge => ({ ...edge, kind: 'Conflicts' })),
          ]);
          return { nodes: kept, edges, truncated };
        },
        /** Provider-level recall, scoped to the caller: the primitive explore is built on. */
        recall: async (hostId: string, input: unknown) => app.recall(input, clientGrant(hostId)),
        editMemory: async (memoryId, input) => withEditLock(memoryId, async () => {
          const parsed = MemoryEditInput.parse(input);
          // Read state inside the lock: a queued edit must see its predecessor's outcome.
          const descriptor = candidates.catalog.get(memoryId);
          if (descriptor.state !== 'active') throw new MnemoWeaveError('INVALID_STATE');
          const current = descriptor.revisions.find(revision => revision.id === descriptor.currentRevisionId);
          if (!current) throw new MnemoWeaveError('NOT_FOUND');
          const currentVersion = candidates.memory.entryVersion(memoryId);
          assertEntryVersion(currentVersion, parsed.entryVersion);
          const now = new Date().toISOString();
          const reason = parsed.reason ?? 'user edit from DSH memory page';
          const hash = createHash('sha256').update(parsed.content).digest('hex');
          // A memory keeps the owner it was published under. Moving it changes the sync scope of
          // the same logical id, which the version ledger cannot express yet (the old scope's
          // entry must be withdrawn while the new scope starts at version 1). Refusing is honest;
          // silently writing it under one scope while the other still lists it would diverge.
          const owner = descriptor.projectId ?? null;
          if (parsed.projectId !== undefined && parsed.projectId !== owner) throw new MnemoWeaveError('NEEDS_REVIEW');
          const scope = owner === null ? 'global' : `project:${owner}`;
          let providerId: string;
          let entryVersion: number;
          let publishedRevisionId: string | null = null;
          if (coordinator && formalProvider) {
            // The remote confirms first: a local Provider write that the remote then
            // rejects would leave an unreferenced memory behind.
            const plan = planEditChange({ entryId: memoryId, scope, content: parsed.content, entryVersion: currentVersion });
            const changeId = randomUUID();
            const result = await submitLocal(plan.scope, plan.operation, plan.entry, plan.baseVersion, () => undefined, changeId);
            if (result === 'queued') throw new MnemoWeaveError('SYNC_QUEUED');
            if (result === 'unknown') throw new MnemoWeaveError('SYNC_OUTCOME_UNKNOWN');
            await coordinator.applyScope(scope, row => applyInboxEntry(row, { store: candidates.memory, provider: formalProvider!, ruleLimits, archiveCapacityBytes: archiveLimitBytes }));
            // The apply step processes rows in order and stops at a gap or at a row awaiting
            // review, so "the current version" may still belong to an earlier revision; using it
            // would hand back a stale Revision and file the operator decision against it. The
            // inbox row itself is not a reliable witness either — a snapshot reset drops applied
            // rows — so success is decided by whether this entry gained a mapping beyond the
            // version the edit was based on.
            const mappedVersion = candidates.memory.nextMappedVersion(memoryId, currentVersion);
            if (mappedVersion === null) throw new MnemoWeaveError('SYNC_OUTCOME_UNKNOWN');
            entryVersion = mappedVersion;
            const mapped = candidates.memory.formalProviderId(memoryId, entryVersion);
            if (!mapped) throw new MnemoWeaveError('NEEDS_REVIEW');
            providerId = mapped;
            // Applying the confirmed change already appended this Revision through the
            // shared pipeline. Appending a second one here would double this machine's
            // history for a single edit, so the revision from the apply step is reused and
            // only the operator decision is recorded against it.
            const decided = candidates.catalog.currentRevisionFor(memoryId, providerId);
            if (!decided) throw new MnemoWeaveError('NEEDS_REVIEW');
            candidates.catalog.recordEditDecision(memoryId, decided.candidateId, 'local-user', reason);
            publishedRevisionId = decided.id;
          } else {
            const written = await provider.persistReviewed(parsed.content, `candidate:${randomUUID()}`);
            await provider.linkSupersedes(written.id, current.providerMemoryId, { operationId: randomUUID(), reason, effectiveAt: now });
            providerId = written.id;
            entryVersion = currentVersion + 1;
            candidates.memory.upsertFormalMap({ entryId: memoryId, version: entryVersion, providerId, contentHash: hash, state: 'applied', appliedAt: now }, now);
            candidates.memory.setEntryVersion(memoryId, entryVersion, now);
          }
          const request = RememberInput.parse({
            idempotencyKey: `edit-${randomUUID()}`.slice(0, 128), content: parsed.content, knowledgeType: 'Practice', tags: [],
            provenance: {
              source: 'local-user', sourceReference: `dsh-edit:${memoryId}`, evidence: [reason], verificationStatus: 'verified',
              confidence: 1, applicability: descriptor.applicability, limitations: '无（用户直接编辑）', lastVerified: now,
            },
          });
          // Without sync there is no pipeline to publish through, so the local edit is the
          // only publication. With sync the apply step already appended the Revision.
          if (publishedRevisionId === null) {
            const published = candidates.catalog.publishDirectEdit(memoryId, request, providerId, hash, now, 'local-user', reason, classificationOf(parsed));
            publishedRevisionId = published.revisionId;
          }
          return { memoryId, revisionId: publishedRevisionId, providerMemoryId: providerId, contentHash: hash, entryVersion };
        }),
        /**
         * Withdraw a memory. Unlike an edit this appends no new body: it records the decision,
         * stops the memory being recalled, and — with sync — publishes the withdrawal as a new
         * version so the other machines stop recalling it too. The local Provider copy is kept,
         * so history stays readable.
         */
        /**
         * Create a formal memory directly.
         *
         * The user's own input is treated as already-confirmed knowledge, so this does not wait for
         * a review: the candidate is approved the moment it is submitted, and the ordinary
         * publisher writes it to the Provider, records the catalog entry, and queues the share. The
         * wait loop exists because that publisher is a background worker — reimplementing its write
         * sequence here would duplicate the duplicate-detection and reconciliation logic.
         */
        createMemory: async (input) => {
          const parsed = MemoryCreateInput.parse(input);
          // Attribution is a write into that project's scope. An unregistered id is a typo or a
          // guess, so it is refused before anything reaches the Provider.
          const projectId = parsed.projectId ?? null;
          if (projectId !== null && !candidates.runtime.registered(projectId)) throw new MnemoWeaveError('INVALID_INPUT');
          // Creation is published by the background worker. Failing now is honest; waiting for a
          // publisher that is not running would leave the caller staring at a spinner and then
          // learn nothing happened.
          if (config.MNEMOWEAVE_WORKER !== 'on') throw new MnemoWeaveError('INVALID_STATE');
          // Identical text must not become a second memory. The publisher would find the existing
          // Provider record and publish another catalog entry pointing at it, so the check belongs
          // here, where the answer can still be "you already have this one".
          const duplicateOf = await findExactDuplicate(parsed.content);
          if (duplicateOf !== null) return duplicateOf;
          const now = new Date().toISOString();
          const hash = createHash('sha256').update(parsed.content).digest('hex');
          const reason = parsed.reason ?? 'user created from DSH memory page';
          const request = RememberInput.parse({
            idempotencyKey: `create-${randomUUID()}`.slice(0, 128),
            content: parsed.content,
            knowledgeType: parsed.knowledgeType,
            tags: parsed.tags ?? [],
            ...(parsed.category === undefined ? {} : { category: parsed.category }),
            ...(parsed.importance === undefined ? {} : { importance: parsed.importance }),
            ...(parsed.entities === undefined ? {} : { entities: parsed.entities }),
            ...(projectId === null ? {} : { projectId }),
            provenance: {
              source: 'local-user', sourceReference: `dsh-create:${randomUUID()}`,
              evidence: [reason], verificationStatus: 'verified', confidence: 1,
              applicability: projectId === null ? 'global' : `project:${projectId}`, limitations: '无（用户直接新增）', lastVerified: now,
            },
          });
          const candidate = candidates.submit(request);
          // Recording the decision keeps the history honest: the entry says a person asked for it.
          candidates.review(candidate.id, 'approve', 'local-user', reason, null);
          const deadline = Date.now() + 15_000;
          for (;;) {
            const current = candidates.get(candidate.id);
            if (current.status === 'persisted') {
              const publication = current.publication;
              if (!publication) throw new MnemoWeaveError('INTERNAL');
              // The Provider id belongs to the revision, not to the entry-version mapping: a fresh
              // publication has no mapping row yet, so asking the mapping yielded an empty string.
              const descriptor = candidates.catalog.get(publication.memoryId);
              const revision = descriptor.revisions.find(item => item.id === publication.revisionId);
              if (!revision) throw new MnemoWeaveError('INTERNAL');
              return {
                memoryId: publication.memoryId,
                revisionId: publication.revisionId,
                providerMemoryId: revision.providerMemoryId,
                contentHash: hash,
                entryVersion: candidates.memory.entryVersion(publication.memoryId),
                duplicate: false,
              };
            }
            if (current.status === 'failed' || current.status === 'rejected') {
              throw new MnemoWeaveError('PROVIDER_UNAVAILABLE');
            }
            // The publisher ticks every 500 ms; a brief wait is normal, a long one is not.
            if (Date.now() > deadline) throw new MnemoWeaveError('SYNC_OUTCOME_UNKNOWN');
            await new Promise(done => setTimeout(done, 100));
          }
        },
        withdrawMemory: async (memoryId, input) => withEditLock(memoryId, async () => {
          const parsed = MemoryWithdrawInput.parse(input);
          const descriptor = candidates.catalog.get(memoryId);
          if (descriptor.state !== 'active') throw new MnemoWeaveError('INVALID_STATE');
          const currentVersion = candidates.memory.entryVersion(memoryId);
          assertEntryVersion(currentVersion, parsed.entryVersion);
          const now = new Date().toISOString();
          if (coordinator && formalProvider) {
            const scope = descriptor.projectId ? `project:${descriptor.projectId}` : 'global';
            // The change envelope still carries a body: the contract requires one, and other
            // machines need the local read-back check to match. The withdrawal itself is
            // expressed by `withdrawnAt`, not by dropping the content.
            const current = descriptor.revisions.find(revision => revision.id === descriptor.currentRevisionId);
            if (!current) throw new MnemoWeaveError('NOT_FOUND');
            const body = (await provider.readMemory(current.providerMemoryId)).content;
            const changeId = randomUUID();
            const result = await submitLocal(scope, 'delete', {
              entryId: memoryId,
              kind: 'formal',
              scope,
              content: { format: 'plain', data: body, contentHash: createHash('sha256').update(body).digest('hex'), byteLength: Buffer.byteLength(body, 'utf8') },
              payload: { category: 'fact', importance: 3, tags: [], entities: [], relations: [] },
              withdrawnAt: now,
            }, currentVersion, () => undefined, changeId);
            if (result === 'queued') throw new MnemoWeaveError('SYNC_QUEUED');
            if (result === 'unknown') throw new MnemoWeaveError('SYNC_OUTCOME_UNKNOWN');
            const applied = candidates.ledger.inboxChange(changeId);
            if (!applied || applied.state !== 'applied') throw new MnemoWeaveError('SYNC_OUTCOME_UNKNOWN');
          }
          const withdrawn = candidates.catalog.withdrawLocal(memoryId, 'local-user', parsed.reason, now);
          // A withdrawal is a new version like any other write. Without local sync nothing else
          // advances the counter, so a later edit would be based on a version the memory no longer
          // has — and the caller would be told the withdrawal did not happen.
          const nextVersion = Math.max(currentVersion + 1, candidates.memory.entryVersion(memoryId));
          const currentRevision = descriptor.revisions.find(revision => revision.id === descriptor.currentRevisionId);
          if (currentRevision !== undefined && nextVersion > currentVersion) {
            candidates.memory.upsertFormalMap({
              entryId: memoryId, version: nextVersion, providerId: currentRevision.providerMemoryId,
              contentHash: currentRevision.contentHash, state: 'applied', appliedAt: now,
            }, now);
          }
          candidates.memory.setEntryVersion(memoryId, nextVersion, now);
          return { memoryId, revisionId: withdrawn.revisionId, entryVersion: nextVersion, withdrawnAt: now };
        }),
        lastInjection: async (hostId, sessionId) => candidates.memory.lastInjection(hostId, sessionId),
        embeddingDiagnostics: async hostId => {
          const report = await app.embeddingDiagnostics(clientGrant(hostId));
          const backfill = candidates.memory.diagnosticJob(BACKFILL_KIND);
          return { ...report, ...(backfill === undefined ? {} : { backfill }) };
        },
        embeddingBackfill: async hostId => { void hostId; return startBackfill(); },
        idleReviewScan: async (hostId, input) => {
          const request = IdleReviewScanInput.parse(input);
          const state = candidates.events.idleReview(hostId, request.sessionId);
          const selection = selectIdleReviewSignals(candidates.events.list(hostId, request.sessionId), {
            afterTurn: state.lastTurn, completedThroughTurn: request.completedThroughTurn,
            maxSignals: request.maxSignals, knownTexts: new Set(state.signals.map(signal => signal.text)),
            now: new Date().toISOString(), id: randomUUID,
          });
          candidates.events.recordIdleReview(hostId, request.sessionId, selection.lastTurn, selection.signals);
          return IdleReviewScanOutput.parse(selection);
        },
        idleReviewSignals: async (hostId, sessionId) => ({ items: candidates.events.idleReview(hostId, sessionId).signals }),
        idleReviewRunStart: async (hostId, input) => {
          const request = IdleReviewRunStartInput.parse(input);
          const started = candidates.events.beginIdleRunWithSignals(hostId, request.sessionId, request.maxSignals);
          return IdleReviewRunStartOutput.parse(started);
        },
        idleReviewPending: async hostId => ({ sessions: candidates.events.pendingIdleSessions(hostId) }),
        idleReviewRuns: async (hostId, sessionId) => ({ items: candidates.events.idleRuns(hostId, sessionId) }),
        idleReviewRunItem: async (hostId, runId, input) => candidates.events.recordIdleRunItem(hostId, runId, IdleReviewRunItem.parse(input)),
        idleReviewRunFinish: async (hostId, runId, input) => {
          const request = IdleReviewRunFinishInput.parse(input);
          return candidates.events.finishIdleRun(hostId, runId, request.state, request.error);
        },
        rules: async () => RuleList.parse({
          items: candidates.memory.everyRule().map(toRuleRecord),
          usage: candidates.memory.ruleUsage(ruleLimits),
        }),
        ruleArchive: async () => RuleArchiveList.parse({ items: candidates.memory.ruleArchive() }),
        createRule: async (input) => withRuleLock(async () => {
          const plan = planRuleCreate(input, candidates.memory.allRules(), ruleLimits);
          const now = new Date().toISOString();
          await submitLocal(ruleScope(), 'create', ruleDraft(plan.row), 0, () => candidates.memory.saveRulePlan(plan, now));
          return toRuleRecord(plan.row);
        }),
        editRule: async (ruleId, input) => withRuleLock(async () => {
          const current = candidates.memory.rule(ruleId);
          if (!current) throw new MnemoWeaveError('NOT_FOUND');
          // The editor carries the version it was opened at. Without this check two hosts would
          // both succeed and the later write would silently replace a rule the first one never
          // saw — the same class of overwrite the memory edit path refuses.
          if (input.baseVersion !== undefined && input.baseVersion !== current.version) throw new MnemoWeaveError('VERSION_CONFLICT');
          const plan = planRuleEdit(current, input, candidates.memory.allRules(), ruleLimits);
          const baseVersion = candidates.memory.entryVersion(ruleId);
          const now = new Date().toISOString();
          await submitLocal(ruleScope(), baseVersion === 0 ? 'create' : 'update', ruleDraft(plan.row), baseVersion, () => candidates.memory.saveRulePlan(plan, now));
          return toRuleRecord(plan.row);
        }),
        archives: async ({ projectId, includeWithdrawn, limit, cursor }) => {
          const rows = projectId === undefined
            ? candidates.memory.allArchives(includeWithdrawn ?? false)
            : candidates.memory.archivesFor(projectId, includeWithdrawn ?? false);
          if (cursor !== undefined && !/^\d+$/.test(cursor)) throw new MnemoWeaveError('INVALID_INPUT');
          const start = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
          if (!Number.isSafeInteger(start) || start < 0) throw new MnemoWeaveError('INVALID_INPUT');
          const pageSize = Math.min(Math.max(limit ?? 100, 1), 200);
          const page = rows.slice(start, start + pageSize);
          const projects = [...new Set((projectId === undefined ? rows.map(row => row.projectId) : [projectId]))];
          return {
            items: page.map(toArchiveRecord),
            capacities: projects.map(id => candidates.memory.archiveUsage(id, archiveLimitBytes)),
            ...(start + pageSize < rows.length ? { nextCursor: String(start + pageSize) } : {}),
          };
        },
        searchArchives: async (hostId, input) => {
          const request = ArchiveSearchInput.parse(input);
          const calls = (archiveSearchCalls.get(hostId) ?? 0) + 1;
          if (calls > 4) throw new MnemoWeaveError('ARCHIVE_SEARCH_BUDGET_EXCEEDED');
          archiveSearchCalls.set(hostId, calls);
          const rows = candidates.memory.searchArchives(request.projectId, request.query, request.includeArchived);
          const results = [];
          let totalBytes = 0;
          const total = rows.length;
          for (const row of rows) {
            if (results.length >= request.limit) continue;
            const bodyBytes = Buffer.byteLength(row.body, 'utf8');
            const excerpt = utf8Prefix(row.body, 512);
            if (totalBytes + excerpt.bytes > 4096) {
              if (results.length === 0) {
                results.push({
                  entryId: row.entryId, projectId: row.projectId, title: row.title, state: row.state ?? 'active',
                  version: row.version, verification: row.verification, excerpt: excerpt.text,
                  excerptBytes: excerpt.bytes, excerptTruncated: excerpt.bytes < bodyBytes, bodyBytes, score: scoreArchive(row, request.query),
                });
              }
              break;
            }
            totalBytes += excerpt.bytes;
            results.push({
              entryId: row.entryId, projectId: row.projectId, title: row.title, state: row.state ?? 'active',
              version: row.version, verification: row.verification, excerpt: excerpt.text,
              excerptBytes: excerpt.bytes, excerptTruncated: excerpt.bytes < bodyBytes, bodyBytes, score: scoreArchive(row, request.query),
            });
          }
          return {
            query: request.query, total, results, totalBytes, truncated: results.length >= request.limit && total > results.length,
            excerptLimitBytes: 512 as const, totalLimitBytes: 4096 as const, callsLimit: 4 as const,
          };
        },
        archiveHistory: async (entryId) => {
          if (!candidates.memory.archive(entryId)) throw new MnemoWeaveError('NOT_FOUND');
          return {
            entryId,
            items: candidates.memory.archiveHistory(entryId).map(row => ({
              revisionId: row.revision_id, entryId: row.entry_id, projectId: row.project_id, version: row.version, title: row.title,
              body: row.body, source: row.source as 'session' | 'tool' | 'user',
              verification: row.verification as 'verified' | 'open' | 'refuted', evidence: row.evidence,
              state: row.state as 'active' | 'archived', archivedAt: row.archived_at, recordedAt: row.recorded_at,
            })),
          };
        },
        editArchive: async (entryId, { baseVersion, ...input }) => withArchiveLock(async () => {
          const current = candidates.memory.archive(entryId);
          if (!current || current.withdrawnAt !== null) throw new MnemoWeaveError('NOT_FOUND');
          if (current.version !== baseVersion) throw new MnemoWeaveError('VERSION_CONFLICT');
          return writeArchive(planArchiveEdit(current, input, candidates.memory.allArchives(true), undefined, archiveLimitBytes), baseVersion);
        }),
        editArchiveState: async (entryId, input) => withArchiveLock(async () => {
          const request = ArchiveStateInput.parse(input);
          const current = candidates.memory.archive(entryId);
          if (!current || current.withdrawnAt !== null) throw new MnemoWeaveError('NOT_FOUND');
          if (current.version !== request.baseVersion) throw new MnemoWeaveError('VERSION_CONFLICT');
          const row = planArchiveState(current, request.state, candidates.memory.allArchives(true), undefined, archiveLimitBytes);
          return writeArchive(row, current.version);
        }),
        createArchive: async (input) => {
          const parsed = ArchiveCreate.parse(input);
          return withArchiveLock(async () => writeArchive(planArchive(parsed, candidates.memory.allArchives(true), undefined, archiveLimitBytes), 0));
        },
      };
      if (config.MNEMOWEAVE_SYNC_URL && config.MNEMOWEAVE_SYNC_DEVICE_ID && config.MNEMOWEAVE_SYNC_TOKEN) {
        const syncClient = new SyncClient({ baseUrl: config.MNEMOWEAVE_SYNC_URL, deviceId: config.MNEMOWEAVE_SYNC_DEVICE_ID, token: config.MNEMOWEAVE_SYNC_TOKEN, timeoutMs: config.MNEMOWEAVE_SYNC_TIMEOUT_MS });
        const formal = {
          remember: async (content: string, source: string) => {
            const match = /^mnemoweave:([0-9a-f-]{36}):(\d+)$/.exec(source);
            if (!match) throw new MnemoWeaveError('INVALID_INPUT');
            return provider.syncRemember(content, match[1]!, Number(match[2]));
          },
          linkSupersedes: (sourceId: string, targetId: string, metadata: { operationId: string; reason: string; effectiveAt: string }) => provider.linkSupersedes(sourceId, targetId, metadata),
          show: async (id: string) => provider.readMemory(id),
          forget: async (id: string) => provider.forget(id),
          findBySource: (source: string) => provider.findBySource(source),
        };
        formalProvider = formal;
        coordinator = new SyncCoordinator(syncClient, candidates.ledger);
        const service = new SyncService({
          remote: syncClient,
          coordinator,
          ledger: candidates.ledger,
          apply: row => applyInboxEntry(row, { store: candidates.memory, provider: formal, ruleLimits, archiveCapacityBytes: archiveLimitBytes }),
          intervalMs: config.MNEMOWEAVE_SYNC_INTERVAL_MS,
        });
        sync = service;
        client.syncStatus = async () => SyncStatusOutput.parse(service.status());
        client.syncRefresh = async () => SyncRefreshOutput.parse(await service.refresh());
        /**
         * Offer published memories to shared sync. Reads the durable queue rather than the
         * event argument, so a publication whose notification was lost to a crash is picked up
         * on the next start instead of never being shared.
         */
        const sharePublished = async (event: PublishedFormal | undefined): Promise<void> => {
          void event;
          for (const pending of candidates!.pendingShares()) {
            try {
              const now = new Date().toISOString();
              // Record the mapping this machine already has. Without it, pulling our own change
              // back finds no local row for the revision and writes the Provider a second time.
              candidates!.memory.upsertFormalMap({
                entryId: pending.memoryId, version: pending.version, providerId: pending.providerId,
                contentHash: pending.contentHash, state: 'applied', appliedAt: now,
              }, now);
              const changeId = randomUUID();
              const result = await submitLocalChange({
                scope: pending.scope,
                operation: pending.version === 1 ? 'create' : 'update',
                baseVersion: pending.version - 1,
                changeId,
                entry: {
                  entryId: pending.memoryId,
                  kind: 'formal',
                  scope: pending.scope,
                  content: { format: 'plain', data: pending.content, contentHash: pending.contentHash, byteLength: Buffer.byteLength(pending.content, 'utf8') },
                  payload: {
                    category: 'fact', importance: 3, tags: [], entities: [],
                    // A later reviewed revision supersedes the previous one, exactly as the edit
                    // path expresses it, so other machines can rebuild the same chain.
                    relations: pending.version > 1
                      ? [{ type: 'supersedes' as const, from: { entryId: pending.memoryId, version: pending.version - 1 }, to: { entryId: pending.memoryId, version: pending.version } }]
                      : [],
                  },
                  withdrawnAt: null,
                },
              }, {
                ledger: candidates!.ledger,
                flush: () => coordinator!.flushOutbox(),
                now: () => new Date().toISOString(),
              });
              // Only a confirmed version is a confirmed version: writing 1 unconditionally marked
              // an unconfirmed change as settled, so a later edit used a base the remote never issued.
              if (result.state === 'confirmed' && result.accepted !== null) {
                candidates!.memory.setEntryVersion(pending.memoryId, result.accepted.version, new Date().toISOString());
                await coordinator!.applyScope(pending.scope, row => applyInboxEntry(row, { store: candidates!.memory, provider: formalProvider!, ruleLimits, archiveCapacityBytes: archiveLimitBytes }));
                candidates!.settleShare(pending.memoryId, 'confirmed', null, new Date().toISOString());
              } else {
                candidates!.settleShare(pending.memoryId, 'failed', result.state === 'unknown' ? 'SYNC_OUTCOME_UNKNOWN' : 'SYNC_QUEUED', new Date().toISOString());
              }
            } catch (error) {
              const code = error instanceof MnemoWeaveError ? error.code : 'INTERNAL';
              candidates!.settleShare(pending.memoryId, 'failed', code, new Date().toISOString());
              process.stderr.write(`${JSON.stringify({ event: 'published_memory_not_shared', memoryId: pending.memoryId, code })}\n`);
            }
          }
        };
        // Registered after the function exists, so the listener always resolves.
        candidates.setPublishListener(event => { void sharePublished(event); });
        service.start();
        // Compensate for a crash between the publication commit and its notification.
        void sharePublished(undefined);
      }
    }
    return { app, port: config.MNEMOWEAVE_PORT, close: async () => { await sync?.stop(); await workflow?.stop(); candidates?.close(); }, client, storage: candidates ? () => candidates.storageStatus() : undefined };
  } catch (error) { candidates?.close(); throw error; }
}
