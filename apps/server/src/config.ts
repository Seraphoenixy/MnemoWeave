import { mkdirSync, readFileSync, statfsSync } from 'node:fs';
import { readSyncCredential } from './sync-credential.ts';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { ClientHttpEndpoints, TurnIdentity } from '../../../packages/protocols/http/src/index.ts';
import { MnemonCliProvider } from '../../../packages/providers/mnemon/src/index.ts';
import {
  MemoryApplication, SyncCoordinator, TRIGGER_MAX_ACTIONS, TurnBudgetRegistry, applyInboxEntry, archiveDraft, assertEntryVersion, assertTriggerAllows,
  clipChars, planArchive, planArchiveEdit, planArchiveState, planEditChange, planRuleCreate, planRuleEdit,
  planWithdrawChange, ruleDraft, ruleUsage, selectIdleReviewSignals, submitLocalChange, toArchiveRecord,
  toRuleRecord, archiveUsage, archiveReleaseCandidates,
} from '../../../packages/core/application/src/index.ts';
import type { FormalProviderPort, LocalWriteState } from '../../../packages/core/application/src/index.ts';
import {
  ArchiveDistillationCreate, ArchiveStateInput, ARCHIVE_ACTIVE_CAPACITY_BYTES, FORMAL_STREAM, HostEvent, LegacyWorkspaceMap, SyncFormalPayload,
  IdleReviewRunFinishInput, IdleReviewRunItem, IdleReviewRunStartInput, IdleReviewRunStartOutput,
  IdleReviewScanInput, IdleReviewScanOutput, MemoryCreateInput, MemoryEditInput, MemoryList, MemoryWithdrawInput,
  MnemoWeaveError, RULE_CAPACITY_BYTES, RULE_CAPACITY_MAX_BYTES, RULE_ITEM_MAX_BYTES, RecallInput, RememberInput,
  RuleArchiveList, RuleCreate, RuleEdit, RuleList, SyncRefreshOutput, SyncStatusOutput, WriteTaskAction,
} from '../../../packages/core/contracts/src/index.ts';
import type { PublishedFormal } from '../../../packages/infrastructure/governance/src/index.ts';
import type { WriteTaskReceiptRecord } from '../../../packages/core/contracts/src/index.ts';
import type { RecallResult } from '../../../packages/core/contracts/src/index.ts';
import { SqliteCandidates } from '../../../packages/infrastructure/governance/src/index.ts';
import { SyncClient } from '../../../packages/infrastructure/sync-client/src/index.ts';
import { SyncService } from './sync-service.ts';
import { MemoryWorkflow } from '../../../packages/core/application/src/workflow.ts';
import { VersionWorkflow } from '../../../packages/core/application/src/version-workflow.ts';

const Config = z.object({
  MNEMON_BINARY: z.string().min(1).default('mnemon'), MNEMON_DATA_DIR: z.string().min(1), MNEMON_STORE: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  MNEMOWEAVE_PORT: z.coerce.number().int().min(0).max(65535).default(4317),
  MNEMOWEAVE_LEGACY_WORKSPACE_MAP: z.string().optional(),
  MNEMOWEAVE_STATE_DIR: z.string().refine(isAbsolute, 'State directory must be absolute').optional(),
  MNEMOWEAVE_WORKER: z.enum(['on', 'off']).default('on'),
  /** One byte-accounted rule collection; every enabled rule is injected whole. */
  MNEMOWEAVE_RULE_CAPACITY_BYTES: z.coerce.number().int().min(1).max(RULE_CAPACITY_MAX_BYTES).default(RULE_CAPACITY_BYTES),
  MNEMOWEAVE_RULE_ITEM_MAX_BYTES: z.coerce.number().int().min(1).max(RULE_CAPACITY_MAX_BYTES).default(RULE_ITEM_MAX_BYTES),
  /** Active workspace archives per workspace; archived entries do not consume it. */
  MNEMOWEAVE_ARCHIVE_ACTIVE_CAPACITY_BYTES: z.coerce.number().int().min(1).default(ARCHIVE_ACTIVE_CAPACITY_BYTES),
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
 * Keep only edges a renderer could actually draw.
 *
 * A graph response with an edge whose endpoint was dropped by the node cap would force every
 * client to re-implement this filter; a self-loop is also meaningless here. Exported so the rule
 * is tested directly instead of through a fixture that would have to run the whole pipeline.
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

/** A deterministic ranking signal: exact title hits first, then verification, then recency. */
export function scoreArchive(row: { title: string; body: string; verification: string }, query: string): number {
  const lowered = query.toLowerCase();
  let score = Number(row.title.toLowerCase().includes(lowered)) * 12;
  score += Number(row.body.toLowerCase().includes(lowered)) * 4;
  score += row.verification === 'verified' ? 3 : row.verification === 'open' ? 1 : 0;
  return score;
}

/**
 * Only the classification the caller actually set. An omitted field inherits the previous
 * revision rather than being cleared; an explicitly empty tag list still means "clear them".
 */
export function classificationOf(input: {
  category?: string | undefined;
  importance?: number | undefined;
  tags?: string[] | undefined;
  entities?: string[] | undefined;
}): { category?: string; importance?: number; tags?: string[]; entities?: string[] } {
  return {
    ...(input.category === undefined ? {} : { category: input.category }),
    ...(input.importance === undefined ? {} : { importance: input.importance }),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
    ...(input.entities === undefined ? {} : { entities: input.entities }),
  };
}

interface ListCursor { sort: ListSort; publishedAt: string; importance: number | null; memoryId: string }
type ListSort = 'newest' | 'oldest' | 'importance';

/** List cursors are keyset positions, not array offsets, so concurrent writes cannot shift a page. */
export function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(`v3|${cursor.sort}|${cursor.publishedAt}|${cursor.importance ?? ''}|${cursor.memoryId}`, 'utf8').toString('base64url');
}

export function decodeListCursor(cursor: string | undefined): ListCursor | null {
  if (cursor === undefined) return null;
  let decoded: string;
  try { decoded = Buffer.from(cursor, 'base64url').toString('utf8'); } catch { throw new MnemoWeaveError('INVALID_INPUT'); }
  const parts = decoded.split('|');
  if (parts.length !== 5 || parts[0] !== 'v3') throw new MnemoWeaveError('INVALID_INPUT');
  const [, sort, publishedAt, importance, memoryId] = parts as [string, string, string, string, string];
  if (sort !== 'newest' && sort !== 'oldest' && sort !== 'importance') throw new MnemoWeaveError('INVALID_INPUT');
  if (!/^[0-9a-f-]{36}$/.test(memoryId) || publishedAt === '') throw new MnemoWeaveError('INVALID_INPUT');
  const parsedImportance = importance === '' ? null : Number(importance);
  if (parsedImportance !== null && !Number.isInteger(parsedImportance)) throw new MnemoWeaveError('INVALID_INPUT');
  return { sort, publishedAt, importance: parsedImportance, memoryId };
}

export function compareEntries(
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

export function isAfterCursor(
  entry: { publishedAt: string; importance: number | null; memoryId: string },
  cursor: ListCursor | null,
): boolean {
  if (cursor === null) return true;
  return compareEntries(entry, cursor, cursor.sort) > 0;
}

/**
 * Archive segment cursors are opaque and bound to the host, session, entry, workspace and version
 * they were issued for. Changing any of those (especially a new archive version) invalidates the
 * cursor instead of resuming at an offset into text the user never saw.
 */
interface SegmentCursor { hostId: string; sessionId: string; entryId: string; workspaceId: string; version: number; offset: number }

export function encodeSegmentCursor(cursor: SegmentCursor): string {
  return Buffer.from(`s1|${cursor.hostId}|${cursor.sessionId}|${cursor.entryId}|${cursor.workspaceId}|${cursor.version}|${cursor.offset}`, 'utf8').toString('base64url');
}

export function decodeSegmentCursor(value: string): SegmentCursor {
  let decoded: string;
  try { decoded = Buffer.from(value, 'base64url').toString('utf8'); } catch { throw new MnemoWeaveError('INVALID_INPUT'); }
  const parts = decoded.split('|');
  if (parts.length !== 7 || parts[0] !== 's1') throw new MnemoWeaveError('INVALID_INPUT');
  const [, hostId, sessionId, entryId, workspaceId, version, offset] = parts as [string, string, string, string, string, string, string];
  const parsedVersion = Number(version);
  const parsedOffset = Number(offset);
  if (!Number.isInteger(parsedVersion) || parsedVersion < 1 || !Number.isInteger(parsedOffset) || parsedOffset < 0) {
    throw new MnemoWeaveError('INVALID_INPUT');
  }
  return { hostId, sessionId, entryId, workspaceId, version: parsedVersion, offset: parsedOffset };
}

/** Shape one stored receipt for the HTTP contract. */
function toReceipt(row: {
  taskId: string; index: number; kind: string; action: string; status: string;
  memoryId: string | null; entryVersion: number | null; entryId: string | null;
  candidateId: string | null; errorCode: string | null; updatedAt: string;
}): WriteTaskReceiptRecord {
  return {
    taskId: row.taskId, index: row.index,
    kind: row.kind as WriteTaskReceiptRecord['kind'],
    action: row.action as WriteTaskReceiptRecord['action'],
    status: row.status as WriteTaskReceiptRecord['status'],
    memoryId: row.memoryId, entryVersion: row.entryVersion, entryId: row.entryId,
    candidateId: row.candidateId, errorCode: row.errorCode, updatedAt: row.updatedAt,
  };
}

export function configure(env: NodeJS.ProcessEnv = process.env) {
  const config = Config.parse(env);
  if (config.MNEMOWEAVE_STATE_DIR && !config.MNEMOWEAVE_SYNC_URL && !config.MNEMOWEAVE_SYNC_DEVICE_ID && !config.MNEMOWEAVE_SYNC_TOKEN) {
    const credential = readSyncCredential(config.MNEMOWEAVE_STATE_DIR);
    if (credential) {
      config.MNEMOWEAVE_SYNC_URL = credential.baseUrl;
      config.MNEMOWEAVE_SYNC_DEVICE_ID = credential.deviceId;
      config.MNEMOWEAVE_SYNC_TOKEN = credential.token;
    }
  }
  const ruleLimits = {
    capacityBytes: config.MNEMOWEAVE_RULE_CAPACITY_BYTES,
    itemMaxBytes: Math.min(config.MNEMOWEAVE_RULE_ITEM_MAX_BYTES, config.MNEMOWEAVE_RULE_CAPACITY_BYTES),
  };
  const archiveLimitBytes = config.MNEMOWEAVE_ARCHIVE_ACTIVE_CAPACITY_BYTES;
  if (config.MNEMOWEAVE_QUOTA_SOFT_BYTES >= config.MNEMOWEAVE_QUOTA_HARD_BYTES) throw new Error('Quota soft limit must be below the hard limit');
  // The project-based configuration was removed with the workspace model. A stale value is
  // reported once at start so the operator moves to MNEMOWEAVE_WORKSPACE_ID instead of silently
  // running without a binding.
  if (env['MNEMOWEAVE_PROJECT_ID'] !== undefined) {
    process.stderr.write(`${JSON.stringify({ event: 'config_expired', variable: 'MNEMOWEAVE_PROJECT_ID', replacement: 'MNEMOWEAVE_WORKSPACE_ID' })}\n`);
  }
  const provider = new MnemonCliProvider({ binary: config.MNEMON_BINARY, dataDir: config.MNEMON_DATA_DIR, store: config.MNEMON_STORE });
  const syncConfigured = !!config.MNEMOWEAVE_SYNC_URL || !!config.MNEMOWEAVE_SYNC_DEVICE_ID || !!config.MNEMOWEAVE_SYNC_TOKEN;
  if (syncConfigured && !(config.MNEMOWEAVE_SYNC_URL && config.MNEMOWEAVE_SYNC_DEVICE_ID && config.MNEMOWEAVE_SYNC_TOKEN)) throw new Error('Remote sync requires URL, device id and token together');
  const candidates = config.MNEMOWEAVE_STATE_DIR
    ? new SqliteCandidates(join(config.MNEMOWEAVE_STATE_DIR, 'governance.db'), { softBytes: config.MNEMOWEAVE_QUOTA_SOFT_BYTES, hardBytes: config.MNEMOWEAVE_QUOTA_HARD_BYTES, shareEnabled: syncConfigured,
        ...(config.MNEMOWEAVE_LEGACY_WORKSPACE_MAP ? { legacyWorkspaces: LegacyWorkspaceMap.parse(JSON.parse(readFileSync(config.MNEMOWEAVE_LEGACY_WORKSPACE_MAP, 'utf8'))) } : {}),
      })
    : undefined;
  let workflow: MemoryWorkflow | undefined;
  let sync: SyncService | undefined;
  let coordinator: SyncCoordinator | undefined;
  let syncClient: SyncClient | undefined;
  let formalProvider: FormalProviderPort | undefined;
  const budgets = new TurnBudgetRegistry();
  const BACKFILL_KIND = 'embedding-backfill';
  let drainPublications: (() => Promise<unknown>) | undefined;
  try {
    candidates?.bindProvider(JSON.stringify({ directory: resolve(config.MNEMON_DATA_DIR), store: config.MNEMON_STORE }));

    if (candidates && config.MNEMOWEAVE_WORKER === 'on') {
      const admit = config.MNEMOWEAVE_MIN_FREE_BYTES === undefined ? undefined : diskFloorGuard(config.MNEMOWEAVE_STATE_DIR!, config.MNEMOWEAVE_MIN_FREE_BYTES);
      workflow = new MemoryWorkflow(candidates, provider, 90000, new VersionWorkflow(candidates, provider), 2, admit, 3_600_000, async () => candidates!.turns.tick());
      workflow.start();
    }
    const app = new MemoryApplication(provider, candidates, candidates);

    const adoptExternalMemory = (row: RecallResult['memories'][number], stamp: string): void => {
      // Server-owned writes become visible through their publication or sync projection.
      // The source survives a crash between the CLI write and the governance commit.
      if (row.source?.startsWith('mnemoweave:')) return;
      candidates?.catalog.adoptProviderMemory(row.id, row.content, stamp, {
        ...(row.category === undefined ? {} : { category: row.category }),
        ...(row.importance === undefined ? {} : { importance: row.importance }),
        ...(row.tags === undefined ? {} : { tags: row.tags }),
        ...(row.entities === undefined ? {} : { entities: row.entities }),
      });
    };

    /**
     * Is this exact text already a published memory? The check covers the whole shared
     * collection: a Provider id that anchors an active catalog memory with the same body is the
     * same knowledge, whichever workspace the caller was working in.
     */
    const findExactDuplicate = async (content: string): Promise<{
      memoryId: string; revisionId: string; providerMemoryId: string; contentHash: string; entryVersion: number; duplicate: true;
    } | null> => {
      if (!candidates) return null;
      let matches: Awaited<ReturnType<typeof provider.inspectExact>>['matches'];
      try {
        const exact = await provider.inspectExact(content);
        if (!exact.complete) return null;
        matches = exact.matches;
      } catch { return null; }
      const hash = createHash('sha256').update(content, 'utf8').digest('hex');
      const memoryIds = new Set(matches.flatMap(match => candidates.catalog.currentMemoryIds(match.id)));
      for (const memoryId of [...memoryIds].sort()) {
        const descriptor = candidates.catalog.get(memoryId);
        if (descriptor.state !== 'active' || (syncConfigured && candidates.hasUnsettledShare(memoryId))) continue;
        const current = descriptor.revisions.find(revision => revision.id === descriptor.currentRevisionId);
        if (!current || current.contentHash !== hash) continue;
        return {
          memoryId, revisionId: current.id, providerMemoryId: current.providerMemoryId,
          contentHash: current.contentHash, entryVersion: candidates.memory.entryVersion(memoryId),
          duplicate: true,
        };
      }
      return null;
    };

    let client: ClientHttpEndpoints | undefined;
    if (candidates && config.MNEMOWEAVE_STATE_DIR) {
      const now = () => new Date().toISOString();
      /**
       * Serializes edits of one logical memory. The version check and the Provider write are
       * separated by several awaits; without the lock two requests carrying the same
       * `entryVersion` both pass the check and both publish.
       */
      const editLocks = new Map<string, Promise<unknown>>();
      const withEditLock = async <T>(memoryId: string, operation: () => Promise<T>): Promise<T> => {
        const previous = editLocks.get(memoryId) ?? Promise.resolve();
        const run = previous.then(operation, operation);
        const settled = run.then(() => undefined, () => undefined);
        editLocks.set(memoryId, settled);
        try { return await run; }
        finally { if (editLocks.get(memoryId) === settled) editLocks.delete(memoryId); }
      };
      /** Rule capacity is a property of the whole collection, so writes plan against one snapshot. */
      let ruleWrite = Promise.resolve();
      const withRuleLock = async <T>(operation: () => Promise<T>): Promise<T> => {
        const run = ruleWrite.then(operation, operation);
        ruleWrite = run.then(() => undefined, () => undefined);
        return run;
      };
      /** Archive capacity belongs to one workspace; writes for that workspace are serialized. */
      const archiveWrites = new Map<string, Promise<unknown>>();
      const withArchiveLock = async <T>(workspaceId: string, operation: () => Promise<T>): Promise<T> => {
        const previous = archiveWrites.get(workspaceId) ?? Promise.resolve();
        const run = previous.then(operation, operation);
        archiveWrites.set(workspaceId, run.then(() => undefined, () => undefined));
        return run;
      };

      /**
       * A local write becomes visible only after the remote confirms it. Queued and unknown
       * outcomes are persisted because nothing was refused.
       */
      const submitLocal = async (input: Parameters<typeof submitLocalChange>[0], applyLocal: () => void): Promise<LocalWriteState | 'local_only'> => {
        if (!coordinator) { applyLocal(); return 'local_only'; }
        const result = await submitLocalChange(input, {
          ledger: candidates.ledger,
          flush: () => coordinator!.flushOutbox(),
          now,
        });
        return result.state;
      };
      const applyFormal = async (): Promise<void> => {
        await coordinator!.applyStream(FORMAL_STREAM, row => applyInboxEntry(row, { store: candidates!.memory, provider: formalProvider!, ruleLimits }));
      };
      type FormalEditInput = ReturnType<typeof MemoryEditInput.parse>;
      const readEditBase = (memoryId: string, entryVersion: number) => {
        const descriptor = candidates.catalog.get(memoryId);
        if (descriptor.state !== 'active') throw new MnemoWeaveError('INVALID_STATE');
        const current = descriptor.revisions.find(revision => revision.id === descriptor.currentRevisionId);
        if (!current) throw new MnemoWeaveError('NOT_FOUND');
        const currentVersion = candidates.memory.entryVersion(memoryId);
        assertEntryVersion(currentVersion, entryVersion);
        return { descriptor, current, currentVersion };
      };
      const executeFormalEdit = async (
        memoryId: string, input: FormalEditInput, base: ReturnType<typeof readEditBase>,
        origin: { actor: 'local-user' | 'task-agent'; reference: string; reason: string; evidence: string[] },
      ) => {
        const { descriptor, current, currentVersion } = base;
        const hash = createHash('sha256').update(input.content, 'utf8').digest('hex');
        const category = input.category ?? current.category ?? 'general';
        const importance = input.importance ?? current.importance ?? 3;
        const tags = input.tags ?? current.tags ?? [];
        const entities = input.entities ?? current.entities ?? [];
        if (current.contentHash === hash
          && category === (current.category ?? 'general')
          && importance === (current.importance ?? 3)
          && JSON.stringify(tags) === JSON.stringify(current.tags ?? [])
          && JSON.stringify(entities) === JSON.stringify(current.entities ?? [])) {
          return { memoryId, revisionId: current.id, providerMemoryId: current.providerMemoryId, contentHash: hash, entryVersion: currentVersion, duplicate: true as const };
        }
        if (coordinator && formalProvider) {
          const state = await submitLocal(planEditChange({
            entryId: memoryId, content: input.content, entryVersion: currentVersion,
            category: category as never, importance, tags, entities,
          }), () => undefined);
          if (state === 'queued') throw new MnemoWeaveError('SYNC_QUEUED');
          if (state === 'unknown') throw new MnemoWeaveError('SYNC_OUTCOME_UNKNOWN');
          await applyFormal();
          const entryVersion = candidates.memory.nextMappedVersion(memoryId, currentVersion);
          if (entryVersion === null) throw new MnemoWeaveError('SYNC_OUTCOME_UNKNOWN');
          const providerId = candidates.memory.formalProviderId(memoryId, entryVersion);
          if (!providerId) throw new MnemoWeaveError('NEEDS_REVIEW');
          const revision = candidates.catalog.syncedRevisionFor(memoryId, entryVersion, providerId);
          if (!revision) throw new MnemoWeaveError('NEEDS_REVIEW');
          candidates.catalog.recordEditDecision(memoryId, revision.candidateId, origin.actor, origin.reason);
          return { memoryId, revisionId: revision.id, providerMemoryId: providerId, contentHash: hash, entryVersion };
        }

        let providerId = current.providerMemoryId;
        if (current.contentHash !== hash) {
          const written = await provider.persistReviewed(input.content, `candidate:${randomUUID()}`);
          providerId = written.id;
          await provider.linkSupersedes(providerId, current.providerMemoryId, { operationId: randomUUID(), reason: origin.reason, effectiveAt: now() });
        }
        const time = now();
        const entryVersion = currentVersion + 1;
        const published = candidates.commitDirectEdit(memoryId, RememberInput.parse({
          idempotencyKey: `edit-${randomUUID()}`.slice(0, 128), content: input.content,
          category, importance, tags, entities,
          provenance: {
            source: origin.actor, sourceReference: origin.reference,
          },
        }), providerId, hash, time, entryVersion, origin.actor, origin.reason, classificationOf(input));
        return { memoryId, revisionId: published.revisionId, providerMemoryId: providerId, contentHash: hash, entryVersion };
      };

      /** Apply an archive stream whose stream id carries the workspace id. */
      const applyArchive = async (workspaceId: string): Promise<void> => {
        const stream = `workspace-archives:${workspaceId}`;
        await coordinator!.applyStream(stream, row => applyInboxEntry(row, { store: candidates!.memory, provider: formalProvider!, ruleLimits }));
      };

      /** Rule writes: plan, remote-confirm, then accept. A refused capacity leaves the draft. */
      const writeRule = async (operation: 'create' | 'update', row: ReturnType<typeof planRuleCreate>['row'], baseVersion: number, changeId?: string) => {
        const state = await submitLocal({ operation, entry: ruleDraft(row), baseVersion, ...(changeId === undefined ? {} : { changeId }) }, () => candidates.memory.saveRule(row, now()));
        if (state === 'queued') throw new MnemoWeaveError('SYNC_QUEUED');
        if (state === 'unknown') throw new MnemoWeaveError('SYNC_OUTCOME_UNKNOWN');
        if (state === 'confirmed') {
          await coordinator!.applyStream('rules', entry => applyInboxEntry(entry, { store: candidates.memory, provider: formalProvider!, ruleLimits }));
          if (candidates.memory.entryVersion(row.entryId) < row.version) throw new MnemoWeaveError('SYNC_OUTCOME_UNKNOWN');
        }
        return toRuleRecord(row);
      };

      /**
       * Publish one workspace archive through the remote when sync is enabled. The remote assigns
       * the version; the local copy is written only after that version is applied, and the
       * confirmed version is what the caller gets back.
       */
      const writeArchive = async (row: ReturnType<typeof planArchive>, baseVersion: number, changeId?: string) => {
        if (!coordinator || !formalProvider) {
          candidates.memory.upsertArchive(row, now(), changeId);
          candidates.memory.setEntryVersion(row.entryId, Math.max(1, row.version), now());
          return toArchiveRecord(row);
        }
        const confirmed = candidates.memory.entryVersion(row.entryId);
        if (confirmed !== 0 && confirmed !== baseVersion) throw new MnemoWeaveError('VERSION_CONFLICT');
        const state = await submitLocal({ operation: confirmed === 0 ? 'create' : 'update', entry: archiveDraft(row), baseVersion: confirmed, ...(changeId === undefined ? {} : { changeId }) }, () => undefined);
        if (state === 'queued') throw new MnemoWeaveError('SYNC_QUEUED');
        if (state === 'unknown') throw new MnemoWeaveError('SYNC_OUTCOME_UNKNOWN');
        await applyArchive(row.workspaceId);
        const current = candidates.memory.archive(row.entryId);
        if (!current || current.version <= confirmed) throw new MnemoWeaveError('SYNC_OUTCOME_UNKNOWN');
        return toArchiveRecord(current);
      };

      /** Share one published memory now and wait for the remote to confirm and apply it. */
      type Publication = { memoryId: string; revisionId: string; providerId: string };
      type ShareResult = 'confirmed' | 'queued' | 'unknown' | 'failed' | NonNullable<Awaited<ReturnType<typeof findExactDuplicate>>>;
      const shares = new Map<string, Promise<ShareResult>>();
      drainPublications = () => Promise.allSettled(shares.values());
      let formalCreates: Promise<unknown> = Promise.resolve();
      const withFormalCreateLock = <T>(operation: () => Promise<T>): Promise<T> => {
        const run = formalCreates.then(operation, operation);
        formalCreates = run.then(() => undefined, () => undefined);
        return run;
      };
      const sharePublishedMemory = async (publication: Publication): Promise<ShareResult> => {
        if (!coordinator) return 'confirmed';
        const descriptor = candidates.catalog.get(publication.memoryId);
        const revision = descriptor.revisions.find(item => item.id === publication.revisionId);
        if (!revision) return 'failed';
        const published: PublishedFormal = {
          memoryId: publication.memoryId,
          providerId: publication.providerId,
          version: revision.number,
          content: (await provider.readMemory(publication.providerId)).content,
          contentHash: revision.contentHash,
          stream: FORMAL_STREAM,
        };
        candidates.memory.upsertFormalMap({
          entryId: published.memoryId, version: published.version, providerId: published.providerId,
          contentHash: published.contentHash, state: 'applied', appliedAt: now(),
        }, now());
        try {
          const outstanding = candidates.ledger.outboxForEntry(published.memoryId);
          if (outstanding?.state === 'pending') return 'queued';
          if (outstanding?.state === 'unknown') return 'unknown';
          const state = candidates.ledger.confirmedOutbox(published.memoryId, published.version - 1)
            ? 'confirmed' : await submitLocal({
            operation: published.version === 1 ? 'create' : 'update',
            baseVersion: published.version - 1,
            entry: {
              entryId: published.memoryId,
              kind: 'formal-memory',
              content: { format: 'plain', data: published.content, contentHash: published.contentHash, byteLength: Buffer.byteLength(published.content, 'utf8') },
              payload: {
                category: SyncFormalPayload.shape.category.safeParse(revision.category).data ?? 'general',
                importance: revision.importance ?? 3,
                tags: revision.tags ?? [], entities: revision.entities ?? [],
                relations: published.version > 1
                  ? [{ type: 'supersedes' as const, from: { entryId: published.memoryId, version: published.version - 1 }, to: { entryId: published.memoryId, version: published.version } }]
                  : [],
              },
              withdrawnAt: null,
            },
          }, () => undefined);
          if (state === 'queued') return 'queued';
          if (state === 'unknown') return 'unknown';
          const change = candidates.ledger.confirmedOutbox(published.memoryId, published.version - 1);
          if (change && !candidates.ledger.inboxChange(change.changeId)) {
            const receipt = await syncClient!.receipt(change.changeId);
            if (!receipt) return 'unknown';
            if (receipt.entryId !== published.memoryId) {
              const apply = (row: Parameters<typeof applyInboxEntry>[0]) =>
                applyInboxEntry(row, { store: candidates.memory, provider: formalProvider!, ruleLimits });
              const page = await coordinator.pullStream(FORMAL_STREAM);
              if (page.needsSnapshot) await coordinator.captureSnapshot(FORMAL_STREAM, apply);
              else await applyFormal();
              if (!candidates.memory.formalProviderId(receipt.entryId, receipt.version)) return 'unknown';
              const descriptor = candidates.catalog.get(receipt.entryId);
              const revision = descriptor.revisions.find(item => item.number === receipt.version);
              if (!revision || (await provider.readMemory(revision.providerMemoryId)).content !== published.content) return 'unknown';
              candidates.catalog.retireSynced(published.memoryId);
              candidates.settleShare(published.memoryId, 'confirmed', null, now());
              return {
                memoryId: receipt.entryId, revisionId: revision.id, providerMemoryId: revision.providerMemoryId,
                contentHash: revision.contentHash, entryVersion: receipt.version, duplicate: true,
              };
            }
          }
          await applyFormal();
          // Success means the local catalog maps the version the remote assigned, not merely that
          // the push returned.
          if (!candidates.memory.formalProviderId(published.memoryId, published.version)) return 'unknown';
          candidates.settleShare(published.memoryId, 'confirmed', null, now());
          return 'confirmed';
        } catch (error) {
          const code = error instanceof MnemoWeaveError ? error.code : 'INTERNAL';
          candidates.settleShare(published.memoryId, 'failed', code, now());
          process.stderr.write(`${JSON.stringify({ event: 'published_memory_not_shared', memoryId: published.memoryId, code })}\n`);
          return 'failed';
        }
      };

      const shareMemory = (publication: Publication): Promise<ShareResult> => {
        const running = shares.get(publication.revisionId);
        if (running) return running;
        const share = sharePublishedMemory(publication).finally(() => shares.delete(publication.revisionId));
        shares.set(publication.revisionId, share);
        return share;
      };

      /**
       * The workspace a session is bound to. The model never supplies it: the host reads it from
       * the session and the Server resolves the binding it recorded at session start.
       */
      const sessionWorkspace = (hostId: string, turn: TurnIdentity | undefined): string => {
        if (turn === undefined) throw new MnemoWeaveError('WORKSPACE_REQUIRED');
        const workspaceId = candidates.workspaces.sessionWorkspace(hostId, turn.sessionId);
        if (workspaceId === null) throw new MnemoWeaveError('WORKSPACE_REQUIRED');
        return workspaceId;
      };
      /**
       * A model-facing read must present a turn the Server can account for. A turn marked
       * "do not retain" may not start a write or read a per-turn budget beyond its own reads.
       */
      const requireTurn = (hostId: string, turn: TurnIdentity): TurnIdentity => {
        if (candidates.turns.isClosed(hostId, turn.sessionId)) throw new MnemoWeaveError('INVALID_STATE');
        return turn;
      };

      /** Read the whole rule set and report it; an over-capacity set is refused, never trimmed. */
      const injectionFor = async (hostId: string, sessionId: string) => {
        const rows = candidates.memory.rulesFor();
        const usage = ruleUsage(rows, ruleLimits);
        if (usage.exceeded) throw new MnemoWeaveError('RULE_CAPACITY_EXCEEDED');
        const createdAt = now();
        const record = {
          hostId, sessionId,
          rules: rows.map(row => ({
            entryId: row.entryId, version: row.version, body: row.body,
            importance: row.importance ?? 'normal', bodyBytes: Buffer.byteLength(row.body, 'utf8'),
          })),
          usedBytes: usage.usedBytes, limitBytes: usage.limitBytes, complete: true, createdAt,
        };
        candidates.memory.recordInjection({ id: randomUUID(), hostId, sessionId, ruleCount: record.rules.length, usedBytes: usage.usedBytes, createdAt });
        return record;
      };

      /** One durable vector backfill at a time; the row is the state, not an in-memory flag. */
      const readEmbedding = async () => { try { return await provider.embeddingStatus(); } catch { return undefined; } };
      const startBackfill = (): import('../../../packages/core/contracts/src/index.ts').DiagnosticJobRecord => {
        const job = candidates.memory.beginDiagnosticJob(BACKFILL_KIND);
        void (async () => {
          try {
            const before = await readEmbedding();
            const result = await provider.embedAll();
            const after = await readEmbedding();
            candidates.memory.finishDiagnosticJob(job.id, result.error === null ? 'succeeded' : 'failed', {
              ...(before === undefined ? {} : { embeddedBefore: before.embedded, coverageBefore: before.total === 0 ? 0 : before.embedded / before.total }),
              ...(after === undefined ? {} : { embeddedAfter: after.embedded, total: after.total, coverageAfter: after.total === 0 ? 0 : after.embedded / after.total }),
              ...(result.error === null ? {} : { error: result.error }),
            });
          } catch (error) {
            candidates.memory.finishDiagnosticJob(job.id, 'failed', { error: error instanceof MnemoWeaveError ? error.code : 'INTERNAL' });
          }
        })();
        return job;
      };

      /**
       * Publish one formal-memory create from an authorized task action.
       *
       * Shared by the ordinary task create and the archive-distillation confirmation: both hand
       * over a fixed body plus classification, and both follow the same duplicate, review and
       * sync-confirmation rules.
       */
      const publishFormalTaskAction = async (input: {
        hostId: string;
        taskId: string;
        index: number;
        content: string;
        reason: string;
        trigger: 'conversation' | 'organize' | 'reply-save' | 'archive-distill' | 'idle-review';
        category?: string | undefined;
        importance?: number | undefined;
        tags?: string[] | undefined;
        entities?: string[] | undefined;
        evidenceRefs?: string[] | undefined;
        assessment?: 'supported' | 'uncertain' | 'conflict' | undefined;
      }): Promise<{ status: 'published' | 'duplicate' | 'needs_review' | 'queued' | 'unknown'; memoryId?: string | null; entryVersion?: number | null; candidateId?: string | null }> => withFormalCreateLock(async () => {
        const duplicate = await findExactDuplicate(input.content);
        if (duplicate !== null) return { status: 'duplicate', memoryId: duplicate.memoryId, entryVersion: duplicate.entryVersion };
        const reference = `write-task:${input.taskId}:${input.index}`;
        const key = createHash('sha256').update(JSON.stringify([input.hostId, input.taskId, input.index])).digest('hex');
        const verifiedAt = candidates.writeTasks.receipt(input.hostId, input.taskId, input.index)?.updatedAt;
        if (input.assessment === 'uncertain' || input.assessment === 'conflict') {
          const candidate = candidates.submit(RememberInput.parse({
            idempotencyKey: `task-${key}`, content: input.content,
            tags: input.tags ?? [],
            ...(input.category === undefined ? {} : { category: input.category }),
            ...(input.importance === undefined ? {} : { importance: input.importance }),
            ...(input.entities === undefined ? {} : { entities: input.entities }),
            ...(input.evidenceRefs === undefined ? {} : { evidenceRefs: input.evidenceRefs }),
            provenance: {
              source: 'task-agent', sourceReference: reference,
            },
          }));
          return { status: 'needs_review', candidateId: candidate.id };
        }
        const request = RememberInput.parse({
          idempotencyKey: `task-${key}`, content: input.content,
          tags: input.tags ?? [],
          ...(input.category === undefined ? {} : { category: input.category }),
          ...(input.importance === undefined ? {} : { importance: input.importance }),
          ...(input.entities === undefined ? {} : { entities: input.entities }),
          ...(input.evidenceRefs === undefined ? {} : { evidenceRefs: input.evidenceRefs }),
          provenance: {
            source: 'task-agent', sourceReference: reference,
          },
        });
        const candidate = candidates.submit(request);
        if (candidate.status === 'pending_review' || candidate.status === 'needs_review') {
          candidates.review(candidate.id, 'approve', 'task-agent', input.reason);
        }
        let publication: Publication;
        try {
          publication = await waitForPublication(candidate.id);
        } catch (error) {
          if (error instanceof MnemoWeaveError && error.code === 'SYNC_OUTCOME_UNKNOWN') {
            return { status: 'unknown', candidateId: candidate.id };
          }
          throw error;
        }
        const shareState = await shareMemory(publication);
        if (shareState === 'queued' || shareState === 'unknown') return { status: shareState, candidateId: candidate.id };
        if (shareState === 'failed') return { status: 'needs_review', candidateId: candidate.id };
        if (typeof shareState !== 'string') return { status: 'duplicate', memoryId: shareState.memoryId, entryVersion: shareState.entryVersion };
        return { status: 'published', memoryId: publication.memoryId, entryVersion: candidates.memory.entryVersion(publication.memoryId) };
      });

      /**
       * The checks that can refuse an action outright, run before its receipt is claimed.
       *
       * The trigger bounds which actions and how many; an idle-review action must name the Host's
       * own open run. None of this depends on the action's outcome, so refusing here leaves no
       * receipt behind.
       */
      /**
       * Resolve one evidence reference for the action that cites it.
       *
       * A conversation write cites a persisted user event of the same turn; a reply save cites
       * the confirmed reply; an organize task cites the host's own persisted instruction; a
       * distillation cites its draft confirmation. A reference that does not resolve for this
       * Host is an invalid request, not a weaker write: the whole point of the field is that the
       * assertion can be checked.
       */
      const assertEvidence = (hostId: string, action: ReturnType<typeof WriteTaskAction.parse>, taskId: string): void => {
        const refs = action.evidenceRefs ?? [];
        if (refs.length === 0) return;
        if (action.trigger === 'archive-distill') {
          // The single reference is the user's confirmation of this draft.
          if (action.draftId === undefined || refs.length !== 1 || refs[0] !== `confirm:${action.draftId}`) throw new MnemoWeaveError('INVALID_INPUT');
          return;
        }
        if (action.trigger === 'organize') {
          // The organizer's evidence is the host's own instruction and confirmation, bound to the
          // task; the Server cannot re-read those, so it only requires the task binding shape.
          if (!refs.every(ref => ref.includes(taskId))) throw new MnemoWeaveError('INVALID_INPUT');
          return;
        }
        if (action.trigger === 'reply-save') {
          // One save cites exactly one reply. The Server cannot read the Host's transcript, so it
          // checks the shape and that the turn this reply belongs to is one it recorded.
          if (refs.length !== 1 || !/^reply:.{1,200}$/.test(refs[0]!)) throw new MnemoWeaveError('INVALID_INPUT');
          if (action.sessionId === undefined || action.turnId === undefined) throw new MnemoWeaveError('INVALID_INPUT');
          const recorded = candidates.turns.messages(hostId, action.sessionId)
            .some(item => item.turnId === action.turnId);
          if (!recorded) throw new MnemoWeaveError('INVALID_INPUT');
          return;
        }
        const sessionId = action.sessionId;
        const turnId = action.turnId;
        for (const ref of refs) {
          if (sessionId === undefined) throw new MnemoWeaveError('INVALID_INPUT');
          const message = candidates.turns.messages(hostId, sessionId).find(item => item.eventId === ref);
          if (message === undefined) throw new MnemoWeaveError('INVALID_INPUT');
          if (action.trigger === 'idle-review' && (message.noRetention || candidates.turns.isNoRetention(hostId, sessionId, message.turnId))) {
            throw new MnemoWeaveError('TURN_NO_RETENTION');
          }
          // A user event is usable for the turn that produced it, either as this turn's own
          // write or as the reply a save cites within the same session.
          if (turnId !== undefined && message.turnId !== turnId && action.trigger === 'conversation') throw new MnemoWeaveError('INVALID_INPUT');
        }
      };

      const assertWriteTaskAllowed = (hostId: string, action: ReturnType<typeof WriteTaskAction.parse>, taskId: string): void => {
        if (action.trigger === 'conversation' && action.kind === 'formal-memory') throw new MnemoWeaveError('SCOPE_FORBIDDEN');
        assertTriggerAllows(action.trigger, action.action);
        // The per-trigger ceiling bounds how many actions of one kind a task may exist: an idle
        // review gets one rule change (index 0) and one archive create (index 1).
        const ceiling = TRIGGER_MAX_ACTIONS[action.trigger] ?? 1;
        if (action.trigger === 'idle-review' && action.kind === 'workspace-archive') {
          if (ceiling < 2) throw new MnemoWeaveError('SCOPE_FORBIDDEN');
        }
        if (action.trigger === 'idle-review') {
          if (action.kind === 'formal-memory') throw new MnemoWeaveError('SCOPE_FORBIDDEN');
          if (action.runId === undefined || action.sessionId === undefined) throw new MnemoWeaveError('INVALID_INPUT');
          const run = candidates.events.idleRun(hostId, action.runId);
          if (run === null) throw new MnemoWeaveError('NOT_FOUND');
          if (run.sessionId !== action.sessionId) throw new MnemoWeaveError('SCOPE_FORBIDDEN');
          if (run.state !== 'running') throw new MnemoWeaveError('INVALID_STATE');
        }
        assertEvidence(hostId, action, taskId);
        const noRetention = candidates.turns.isNoRetention(hostId, action.sessionId ?? '', action.turnId);
        if (noRetention && action.trigger !== 'reply-save') throw new MnemoWeaveError('TURN_NO_RETENTION');
      };

      /** Execute one action of an authorized write task. Host code only; never a model tool. */
      const executeWriteTask = async (hostId: string, taskId: string, index: number, action: ReturnType<typeof WriteTaskAction.parse>): Promise<{
        status: WriteTaskReceiptRecord['status'];
        memoryId?: string | null;
        entryVersion?: number | null;
        entryId?: string | null;
        candidateId?: string | null;
        errorCode?: string | null;
      }> => {
        if (action.action === 'skip') return { status: 'skipped' };
        const changeId = taskResourceChangeId(hostId, taskId, index);

        if (action.kind === 'rule') {
          if (action.trigger === 'conversation' && action.sessionId === undefined) throw new MnemoWeaveError('INVALID_INPUT');
          return withRuleLock(async () => {
            if (action.action === 'create') {
              const plan = planRuleCreate({
                body: action.body!, enabled: action.enabled ?? true,
              }, candidates.memory.allRules(), ruleLimits);
              const record = await writeRule('create', { ...plan.row, entryId: changeId }, 0, changeId);
              return { status: 'applied', entryId: record.entryId, entryVersion: record.version };
            }
            const current = action.entryId === undefined ? null : candidates.memory.rule(action.entryId);
            if (!current) throw new MnemoWeaveError('NOT_FOUND');
            if (current.version !== action.baseVersion) throw new MnemoWeaveError('VERSION_CONFLICT');
            if (action.action === 'remove') {
              const plan = planRuleEdit(current, { remove: true, baseVersion: current.version }, candidates.memory.allRules(), ruleLimits);
              const record = await writeRule('update', plan.row, current.version, changeId);
              return { status: 'applied', entryId: record.entryId, entryVersion: record.version };
            }
            const plan = planRuleEdit(current, {
              ...(action.body === undefined ? {} : { body: action.body }),
              ...(action.enabled === undefined ? {} : { enabled: action.enabled }),
              baseVersion: current.version,
            }, candidates.memory.allRules(), ruleLimits);
            const record = await writeRule('update', plan.row, current.version, changeId);
            return { status: 'applied', entryId: record.entryId, entryVersion: record.version };
          });
        }

        if (action.kind === 'workspace-archive') {
          const turn: TurnIdentity | undefined = action.sessionId === undefined ? undefined : {
            sessionId: action.sessionId, turnId: action.turnId ?? '', agentId: 'task-agent',
          };
          const workspaceId = sessionWorkspace(hostId, turn);
          return withArchiveLock(workspaceId, async () => {
            if (action.action === 'create') {
              const plan = planArchive({
                workspaceId, title: action.title!, body: action.body!,
                source: action.source ?? 'session', verification: action.verification ?? 'open',
                evidence: action.evidence ?? (action.evidenceRefs ?? []).join('\n').slice(0, 2000),
              }, candidates.memory.allArchives(true), now(), archiveLimitBytes);
              const record = await writeArchive({ ...plan, entryId: changeId }, 0, changeId);
              return { status: 'applied', entryId: record.entryId, entryVersion: record.version };
            }
            const current = action.entryId === undefined ? null : candidates.memory.archive(action.entryId);
            if (!current || current.workspaceId !== workspaceId) throw new MnemoWeaveError('NOT_FOUND');
            if (current.version !== action.baseVersion) throw new MnemoWeaveError('VERSION_CONFLICT');
            const plan = planArchiveEdit(current, {
              ...(action.title === undefined ? {} : { title: action.title }),
              ...(action.body === undefined ? {} : { body: action.body }),
              ...(action.verification === undefined ? {} : { verification: action.verification }),
              ...(action.evidence === undefined ? {} : { evidence: action.evidence }),
            }, candidates.memory.allArchives(true), now(), archiveLimitBytes);
            const record = await writeArchive(plan, current.version, changeId);
            return { status: 'applied', entryId: record.entryId, entryVersion: record.version };
          });
        }

        // formal-memory
        if (action.action === 'withdraw') {
          if (action.memoryId === undefined || action.entryVersion === undefined) throw new MnemoWeaveError('INVALID_INPUT');
          return withEditLock(action.memoryId, async () => {
            const descriptor = candidates.catalog.get(action.memoryId!);
            if (descriptor.state !== 'active') throw new MnemoWeaveError('INVALID_STATE');
            const currentVersion = candidates.memory.entryVersion(action.memoryId!);
            assertEntryVersion(currentVersion, action.entryVersion!);
            const current = descriptor.revisions.find(revision => revision.id === descriptor.currentRevisionId);
            if (!current) throw new MnemoWeaveError('NOT_FOUND');
            if (coordinator && formalProvider) {
              const body = (await provider.readMemory(current.providerMemoryId)).content;
              const state = await submitLocal(planWithdrawChange({
                entryId: action.memoryId!, content: body, entryVersion: currentVersion, at: now(),
                category: (current.category ?? 'general') as never, importance: current.importance ?? 3,
                tags: current.tags ?? [], entities: current.entities ?? [],
              }), () => undefined);
              if (state === 'queued') throw new MnemoWeaveError('SYNC_QUEUED');
              if (state === 'unknown') throw new MnemoWeaveError('SYNC_OUTCOME_UNKNOWN');
              await applyFormal();
            }
            const withdrawn = candidates.catalog.withdrawLocal(action.memoryId!, 'task-agent', action.reason, now());
            const nextVersion = Math.max(currentVersion + 1, candidates.memory.entryVersion(action.memoryId!));
            candidates.memory.upsertFormalMap({
              entryId: action.memoryId!, version: nextVersion, providerId: current.providerMemoryId,
              contentHash: current.contentHash, state: 'applied', appliedAt: now(),
            }, now());
            candidates.memory.setEntryVersion(action.memoryId!, nextVersion, now());
            return { status: 'published', memoryId: action.memoryId!, entryVersion: nextVersion, entryId: null };
          });
        }

        if (action.action === 'edit') {
          if (action.memoryId === undefined || action.entryVersion === undefined || action.content === undefined) throw new MnemoWeaveError('INVALID_INPUT');
          return withEditLock(action.memoryId, async () => {
            const base = readEditBase(action.memoryId!, action.entryVersion!);
            if (action.assessment === 'uncertain' || action.assessment === 'conflict') {
              const candidate = candidates.submit(RememberInput.parse({
                idempotencyKey: `task-${taskId}-${index}`.slice(0, 128), content: action.content!,
                tags: action.tags ?? [],
                ...(action.category === undefined ? {} : { category: action.category }),
                ...(action.importance === undefined ? {} : { importance: action.importance }),
                ...(action.entities === undefined ? {} : { entities: action.entities }),
                provenance: {
                  source: 'task-agent', sourceReference: `write-task:${taskId}:${index}`,
                },
              }));
              return { status: 'needs_review', candidateId: candidate.id };
            }
            const result = await executeFormalEdit(action.memoryId!, {
              content: action.content!, entryVersion: action.entryVersion!,
              category: action.category, importance: action.importance,
              tags: action.tags, entities: action.entities,
            }, base, {
              actor: 'task-agent', reference: `write-task:${taskId}:${index}`,
              reason: action.reason, evidence: action.evidenceRefs ?? [action.reason],
            });
            return { status: result.duplicate ? 'duplicate' : 'published', memoryId: result.memoryId, entryVersion: result.entryVersion };
          });
        }

        /**
         * A confirmed archive distillation publishes the draft's fixed text.
         *
         * The draft names its source version and content hash; a source edited or archived after
         * the preview no longer matches, so the confirmation is refused rather than publishing
         * text the user did not see. The draft is bound to the task once, so a retry returns the
         * original publication instead of creating a second memory.
         */
        if (action.draftId !== undefined) {
          // The draft id is the task id: one draft has at most one create action, so the receipt
          // key (Host, task, index) is exactly the confirmation of that draft.
          if (taskId !== action.draftId) throw new MnemoWeaveError('INVALID_INPUT');
          if (index !== 0) throw new MnemoWeaveError('INVALID_INPUT');
          const draft = candidates.distillations.get(action.draftId);
          if (!draft || draft.hostId !== hostId) throw new MnemoWeaveError('NOT_FOUND');
          const source = candidates.memory.archive(draft.entryId);
          if (!source || source.workspaceId !== draft.workspaceId || source.withdrawnAt !== null) throw new MnemoWeaveError('NOT_FOUND');
          const sourceHash = createHash('sha256').update(source.body, 'utf8').digest('hex');
          if (draft.taskId === null) {
            if (source.version !== draft.entryVersion || sourceHash !== draft.sourceContentHash) throw new MnemoWeaveError('VERSION_CONFLICT');
            candidates.distillations.attachTask(draft.draftId, taskId);
          } else if (draft.taskId !== taskId) {
            throw new MnemoWeaveError('INVALID_STATE');
          }
          const distilled = await publishFormalTaskAction({
            hostId, taskId, index, content: draft.content, reason: action.reason,
            ...(draft.category === null ? {} : { category: draft.category }),
            ...(draft.importance === null ? {} : { importance: draft.importance }),
            ...(draft.tags === null ? {} : { tags: draft.tags }),
            ...(draft.entities === null ? {} : { entities: draft.entities }),
            ...(action.evidenceRefs === undefined ? {} : { evidenceRefs: action.evidenceRefs }),
            ...(draft.assessment === 'supported' || draft.assessment === 'uncertain' || draft.assessment === 'conflict'
              ? { assessment: draft.assessment } : {}),
            trigger: 'archive-distill',
          });
          return distilled;
        }

        // formal-memory create
        if (action.content === undefined) throw new MnemoWeaveError('INVALID_INPUT');
        return publishFormalTaskAction({
          hostId, taskId, index, content: action.content, reason: action.reason, trigger: action.trigger,
          ...(action.category === undefined ? {} : { category: action.category }),
          ...(action.importance === undefined ? {} : { importance: action.importance }),
          ...(action.tags === undefined ? {} : { tags: action.tags }),
          ...(action.entities === undefined ? {} : { entities: action.entities }),
          ...(action.evidenceRefs === undefined ? {} : { evidenceRefs: action.evidenceRefs }),
          ...(action.assessment === undefined ? {} : { assessment: action.assessment }),
        });
      };

      /** The worker publishes asynchronously; a brief wait is normal, a long one is not. */
      const waitForPublication = async (candidateId: string): Promise<{ memoryId: string; revisionId: string; providerId: string }> => {
        const deadline = Date.now() + 15_000;
        for (;;) {
          const current = candidates.get(candidateId);
          if (current.status === 'persisted') {
            if (!current.publication) throw new MnemoWeaveError('INTERNAL');
            const descriptor = candidates.catalog.get(current.publication.memoryId);
            const revision = descriptor.revisions.find(item => item.id === current.publication!.revisionId);
            if (!revision) throw new MnemoWeaveError('INTERNAL');
            return { memoryId: current.publication.memoryId, revisionId: current.publication.revisionId, providerId: revision.providerMemoryId };
          }
          if (current.status === 'failed' || current.status === 'rejected') throw new MnemoWeaveError('PROVIDER_UNAVAILABLE');
          if (Date.now() > deadline) throw new MnemoWeaveError('SYNC_OUTCOME_UNKNOWN');
          await new Promise(done => setTimeout(done, 100));
        }
      };

      const activeWriteTasks = new Map<string, Promise<WriteTaskReceiptRecord>>();
      const taskResourceChangeId = (hostId: string, taskId: string, index: number): string => {
        const hex = createHash('sha256').update(JSON.stringify([hostId, taskId, index])).digest('hex');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      };
      const refreshFormalReceipt = async (hostId: string, row: NonNullable<ReturnType<typeof candidates.writeTasks.receipt>>) => {
        if (row.kind !== 'formal-memory' && ['unknown', 'queued'].includes(row.status)) {
          const changeId = taskResourceChangeId(hostId, row.taskId, row.index);
          const outbox = candidates.ledger.outboxChange(changeId);
          if (outbox?.state === 'conflict' || outbox?.state === 'needs_review') {
            return candidates.writeTasks.settle(hostId, row.taskId, row.index, { status: 'failed', errorCode: outbox.lastError ?? 'NEEDS_REVIEW' });
          }
          const inbox = candidates.ledger.inboxChange(changeId);
          if (inbox?.state === 'applied') {
            return candidates.writeTasks.settle(hostId, row.taskId, row.index, { status: 'applied', entryId: inbox.entryId, entryVersion: inbox.version });
          }
          if (outbox || activeWriteTasks.has(JSON.stringify([hostId, row.taskId, row.index]))) return row;
          if (!coordinator && row.action === 'create') {
            const version = row.kind === 'rule' ? candidates.memory.rule(changeId)?.version : candidates.memory.archive(changeId)?.version;
            if (version !== undefined) return candidates.writeTasks.settle(hostId, row.taskId, row.index, { status: 'applied', entryId: changeId, entryVersion: version });
          }
        }
        if (row.kind !== 'formal-memory' || !row.candidateId || !['queued', 'unknown', 'needs_review'].includes(row.status)) return row;
        const candidate = candidates.get(row.candidateId);
        if (candidate.status === 'rejected' || candidate.status === 'failed') {
          return candidates.writeTasks.settle(hostId, row.taskId, row.index, { status: 'failed', candidateId: row.candidateId });
        }
        if (candidate.status !== 'persisted') return row;
        const publication = await waitForPublication(row.candidateId);
        const share = await shareMemory(publication);
        if (share === 'queued' || share === 'unknown' || share === 'failed') return row;
        const result = share === 'confirmed'
          ? { status: 'published', memoryId: publication.memoryId, entryVersion: candidates.memory.entryVersion(publication.memoryId) }
          : { status: 'duplicate', memoryId: share.memoryId, entryVersion: share.entryVersion };
        return candidates.writeTasks.settle(hostId, row.taskId, row.index, { ...result, candidateId: row.candidateId });
      };

      client = {
        // ── Injection and diagnostics ──
        inject: async (hostId, input) => {
          const request = input as { sessionId?: unknown };
          if (typeof request.sessionId !== 'string' || request.sessionId.trim() === '') throw new MnemoWeaveError('INVALID_INPUT');
          if (candidates.turns.isClosed(hostId, request.sessionId)) throw new MnemoWeaveError('INVALID_STATE');
          return injectionFor(hostId, request.sessionId);
        },
        lastInjection: async (hostId, sessionId) => candidates.memory.lastInjection(hostId, sessionId),
        closeSession: (hostId, sessionId) => candidates.turns.closeSession(hostId, sessionId),
        events: (hostId, input) => candidates.turns.observe(hostId, HostEvent.parse(input)),
        embeddingDiagnostics: async () => {
          const report = await app.embeddingDiagnostics();
          const backfill = candidates.memory.diagnosticJob(BACKFILL_KIND);
          return { ...report, ...(backfill === undefined ? {} : { backfill }) };
        },
        embeddingBackfill: async () => startBackfill(),
        embeddingBackfillHistory: async (_hostId, limit) => ({ items: candidates.memory.diagnosticJobs(BACKFILL_KIND, limit) }),

        // ── Workspaces ──
        workspaces: async ({ hostId, operator }) => ({
          items: candidates.workspaces.list()
            .filter(workspace => operator || candidates.workspaces.accessibleTo(workspace.workspaceId, hostId))
            .map(workspace => ({
              workspaceId: workspace.workspaceId, name: workspace.name, createdAt: workspace.createdAt,
              ...(operator ? { boundRootCount: candidates.workspaces.bindingCount(workspace.workspaceId) } : {}),
            })),
        }),
        registerWorkspace: async (input) => {
          const workspace = candidates.workspaces.register(input.workspaceId, input.name);
          return { ...workspace, boundRootCount: candidates.workspaces.bindingCount(workspace.workspaceId) };
        },
        bindWorkspace: async (workspaceId, rootPath) => {
          candidates.workspaces.bind(workspaceId, rootPath);
          const workspace = candidates.workspaces.get(workspaceId);
          if (!workspace) throw new MnemoWeaveError('NOT_FOUND');
          return { ...workspace, boundRootCount: candidates.workspaces.bindingCount(workspaceId) };
        },
        /**
         * The host claims the workspace one session works in. A directory and an explicit id must
         * agree; a session that already has a binding cannot switch it.
         */
        bindSession: async (hostId, sessionId, input) => {
          let workspaceId: string | null = null;
          if (input.rootPath !== undefined) workspaceId = candidates.workspaces.workspaceForRoot(input.rootPath);
          if (input.workspaceId !== undefined) {
            if (!candidates.workspaces.has(input.workspaceId)) throw new MnemoWeaveError('INVALID_INPUT');
            if (workspaceId !== null && workspaceId !== input.workspaceId) throw new MnemoWeaveError('INVALID_INPUT');
            workspaceId = input.workspaceId;
          }
          const bound = candidates.workspaces.bindSession(hostId, sessionId, workspaceId);
          return { sessionId, workspaceId: bound.workspaceId, boundAt: bound.boundAt };
        },
        sessionWorkspace: (hostId, sessionId) => candidates.workspaces.sessionWorkspace(hostId, sessionId),

        // ── Rules ──
        rules: async () => RuleList.parse({ items: candidates.memory.allRules().map(toRuleRecord), usage: ruleUsage(candidates.memory.allRules(), ruleLimits) }),
        ruleArchive: async () => RuleArchiveList.parse({ items: candidates.memory.ruleArchive() }),
        createRule: async (input) => withRuleLock(async () => {
          const plan = planRuleCreate(input, candidates.memory.allRules(), ruleLimits);
          return writeRule('create', plan.row, 0);
        }),
        editRule: async (ruleId, input) => withRuleLock(async () => {
          const current = candidates.memory.rule(ruleId);
          if (!current) throw new MnemoWeaveError('NOT_FOUND');
          if (input.baseVersion !== current.version) throw new MnemoWeaveError('VERSION_CONFLICT');
          if (input.remove === true) {
            const plan = planRuleEdit(current, { remove: true, baseVersion: current.version }, candidates.memory.allRules(), ruleLimits);
            return writeRule('update', plan.row, current.version);
          }
          const plan = planRuleEdit(current, input, candidates.memory.allRules(), ruleLimits);
          return writeRule('update', plan.row, current.version);
        }),

        // ── Archives ──
        archives: async ({ workspaceId, includeWithdrawn, limit, cursor }) => {
          const selected = workspaceId?.trim() ?? '';
          if (selected === '') throw new MnemoWeaveError('WORKSPACE_REQUIRED');
          if (!candidates.workspaces.has(selected)) throw new MnemoWeaveError('NOT_FOUND');
          const rows = candidates.memory.archivesFor(selected, includeWithdrawn ?? false);
          if (cursor !== undefined && !/^\d+$/.test(cursor)) throw new MnemoWeaveError('INVALID_INPUT');
          const start = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
          if (!Number.isSafeInteger(start) || start < 0) throw new MnemoWeaveError('INVALID_INPUT');
          const pageSize = Math.min(Math.max(limit ?? 100, 1), 200);
          const page = rows.slice(start, start + pageSize);
          return {
            items: page.map(toArchiveRecord),
            capacities: [archiveUsage(selected, candidates.memory.archivesFor(selected, true), archiveLimitBytes)],
            ...(start + pageSize < rows.length ? { nextCursor: String(start + pageSize) } : {}),
          };
        },
        /**
         * Capacity maintenance: the active archives whose release would free the most room,
         * oldest first. Nothing is archived here; the user picks a row and confirms separately.
         */
        archiveReleaseCandidates: async (workspaceId, limit) => {
          const selected = workspaceId?.trim() ?? '';
          if (selected === '') throw new MnemoWeaveError('WORKSPACE_REQUIRED');
          if (!candidates.workspaces.has(selected)) throw new MnemoWeaveError('NOT_FOUND');
          const all = candidates.memory.archivesFor(selected, true);
          const pageSize = Math.min(Math.max(limit ?? 20, 1), 100);
          const items = archiveReleaseCandidates(selected, all, pageSize);
          const activeCount = all.filter(row => row.workspaceId === selected && row.state !== 'archived' && row.withdrawnAt === null).length;
          return {
            workspaceId: selected,
            capacity: archiveUsage(selected, all, archiveLimitBytes),
            items,
            remaining: Math.max(0, activeCount - items.length),
          };
        },
        searchArchives: async (hostId, input) => {
          const selected = input.workspaceId?.trim() ?? '';
          if (selected === '') throw new MnemoWeaveError('WORKSPACE_REQUIRED');
          if (!candidates.workspaces.has(selected)) throw new MnemoWeaveError('NOT_FOUND');
          const query = input.query;
          const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
          const rows = candidates.memory.searchArchives(selected, query, input.includeArchived === true);
          const total = rows.length;
          const results: Array<Record<string, unknown>> = [];
          let totalChars = 0;
          for (const row of rows) {
            if (results.length >= limit) break;
            const budget = 6_000 - totalChars;
            if (budget <= 0) break;
            const excerpt = clipChars(row.body, Math.min(budget, 600));
            if (excerpt.text === '') break;
            totalChars += excerpt.text.length;
            results.push({
              entryId: row.entryId, workspaceId: row.workspaceId, title: row.title, state: row.state ?? 'active',
              version: row.version, verification: row.verification, excerpt: excerpt.text,
              excerptChars: excerpt.text.length, excerptTruncated: excerpt.truncated,
              bodyChars: row.body.length, score: scoreArchive(row, query),
            });
          }
          return {
            query, total, results, totalChars,
            truncated: results.length >= limit && total > results.length,
            totalLimitChars: 6_000 as const, callsLimit: 4 as const,
          };
        },
        /** Search inside the session's bound workspace for a model tool: the model has no workspace. */
        searchArchivesForTurn: async (hostId, input, turn) => {
          const workspaceId = sessionWorkspace(hostId, requireTurn(hostId, turn));
          const budget = budgets.for({ ...turn, hostId });
          budget.takeArchiveCall();
          const rows = candidates.memory.searchArchives(workspaceId, input.query, input.includeArchived === true);
          const total = rows.length;
          const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
          const results: Array<Record<string, unknown>> = [];
          let totalChars = 0;
          for (const row of rows) {
            if (results.length >= limit) break;
            const remaining = 6_000 - totalChars;
            if (remaining <= 0) break;
            const excerpt = clipChars(row.body, remaining);
            if (excerpt.text === '') break;
            totalChars += excerpt.text.length;
            results.push({
              entryId: row.entryId, workspaceId: row.workspaceId, title: row.title, state: row.state ?? 'active',
              version: row.version, verification: row.verification, excerpt: excerpt.text,
              excerptChars: excerpt.text.length, excerptTruncated: excerpt.truncated,
              bodyChars: row.body.length, score: scoreArchive(row, input.query),
            });
          }
          return {
            query: input.query, total, results, totalChars,
            truncated: results.length >= limit && total > results.length,
            totalLimitChars: 6_000 as const, callsLimit: 4 as const,
          };
        },
        archiveHistory: async (entryId) => {
          if (!candidates.memory.archive(entryId)) throw new MnemoWeaveError('NOT_FOUND');
          return {
            entryId,
            items: candidates.memory.archiveHistory(entryId).map(row => ({
              revisionId: row.revision_id, entryId: row.entry_id, workspaceId: row.workspace_id,
              version: row.version, title: row.title, body: row.body,
              source: row.source as 'session' | 'tool' | 'user',
              verification: row.verification as 'verified' | 'open' | 'refuted', evidence: row.evidence,
              state: row.state as 'active' | 'archived', archivedAt: row.archived_at, recordedAt: row.recorded_at,
            })),
          };
        },
        /** One model-facing segment; a cursor from another host, session, entry or version is refused. */
        archiveSegment: async (hostId, entryId, cursor, turn) => {
          if (turn === undefined) throw new MnemoWeaveError('WORKSPACE_REQUIRED');
          requireTurn(hostId, turn);
          const budget = budgets.for({ ...turn, hostId });
          const workspaceId = sessionWorkspace(hostId, turn);
          budget.takeArchiveCall();
          const row = candidates.memory.archive(entryId);
          if (!row || row.workspaceId !== workspaceId || row.withdrawnAt !== null) throw new MnemoWeaveError('NOT_FOUND');
          let offset = 0;
          if (cursor !== undefined) {
            const decoded = decodeSegmentCursor(cursor);
            if (decoded.hostId !== hostId || decoded.sessionId !== turn.sessionId
              || decoded.entryId !== entryId || decoded.workspaceId !== workspaceId || decoded.version !== row.version) {
              throw new MnemoWeaveError('VERSION_CONFLICT');
            }
            offset = decoded.offset;
          }
          const segment = clipChars(row.body.slice(offset), 6_000);
          const nextOffset = offset + segment.text.length;
          const complete = nextOffset >= row.body.length;
          return {
            entryId, workspaceId, version: row.version, title: row.title,
            content: segment.text,
            ...(complete ? {} : { nextCursor: encodeSegmentCursor({ hostId, sessionId: turn.sessionId, entryId, workspaceId, version: row.version, offset: nextOffset }) }),
            complete,
            totalChars: row.body.length,
          };
        },
        createArchive: async (input) => {
          if (!candidates.workspaces.has(input.workspaceId)) throw new MnemoWeaveError('NOT_FOUND');
          const workspaceId = input.workspaceId;
          return withArchiveLock(workspaceId, async () => {
            const plan = planArchive(input, candidates.memory.allArchives(true), now(), archiveLimitBytes);
            return writeArchive(plan, 0);
          });
        },
        editArchive: async (entryId, input) => {
          const current = candidates.memory.archive(entryId);
          if (!current || current.withdrawnAt !== null) throw new MnemoWeaveError('NOT_FOUND');
          if (current.version !== input.baseVersion) throw new MnemoWeaveError('VERSION_CONFLICT');
          const workspaceId = current.workspaceId;
          return withArchiveLock(workspaceId, async () => {
            const plan = planArchiveEdit(current, input, candidates.memory.allArchives(true), now(), archiveLimitBytes);
            return writeArchive(plan, current.version);
          });
        },
        editArchiveState: async (entryId, input) => {
          const request = ArchiveStateInput.parse(input);
          const current = candidates.memory.archive(entryId);
          if (!current || current.withdrawnAt !== null) throw new MnemoWeaveError('NOT_FOUND');
          return withArchiveLock(current.workspaceId, async () => {
            const latest = candidates.memory.archive(entryId);
            if (!latest || latest.withdrawnAt !== null) throw new MnemoWeaveError('NOT_FOUND');
            if (request.changeId !== undefined) {
              const change = candidates.ledger.outboxChange(request.changeId);
              if (change) {
                const state = 'state' in change.entry.payload ? change.entry.payload.state ?? 'active' : 'active';
                if (change.entryId !== entryId || change.baseVersion !== request.baseVersion || state !== request.state) {
                  throw new MnemoWeaveError('IDEMPOTENCY_CONFLICT');
                }
                if (change.state === 'pending') throw new MnemoWeaveError('SYNC_QUEUED');
                if (change.state === 'unknown') throw new MnemoWeaveError('SYNC_OUTCOME_UNKNOWN');
                if (change.state === 'conflict') throw new MnemoWeaveError('VERSION_CONFLICT');
                if (change.state !== 'confirmed') throw new MnemoWeaveError('NEEDS_REVIEW');
                await applyArchive(latest.workspaceId);
                const applied = candidates.memory.archive(entryId);
                if (!applied || applied.version <= request.baseVersion) throw new MnemoWeaveError('SYNC_OUTCOME_UNKNOWN');
                return toArchiveRecord(applied);
              }
              const revision = candidates.memory.archiveRevisionById(request.changeId);
              if (revision) {
                if (revision.entry_id !== entryId || revision.version !== request.baseVersion + 1 || revision.state !== request.state) {
                  throw new MnemoWeaveError('IDEMPOTENCY_CONFLICT');
                }
                return toArchiveRecord(latest);
              }
            }
            if (latest.version !== request.baseVersion) throw new MnemoWeaveError('VERSION_CONFLICT');
            const plan = planArchiveState(latest, request.state, candidates.memory.allArchives(true), now(), archiveLimitBytes);
            return writeArchive(plan, latest.version, request.changeId);
          });
        },

        // ── Formal memories ──
        memories: async ({ query, limit, category, entity, sort, cursor }) => {
          const terms = query ? query.toLowerCase().split(/\s+/).filter(Boolean) : [];
          const order: ListSort = sort ?? 'newest';
          /**
           * The list answers "what memories exist", so the Provider is the source of truth.
           *
           * Every entry it holds is adopted into the catalog if this Server has not seen it yet:
           * a memory written by another tool, or before this catalog existed, is still part of the
           * library. The catalog then supplies what only it knows — the entry version, the
           * revision history — while the Provider supplies the body and classification.
           */
          const providerRows = await provider.listAll();
          const stamp = now();
          for (const row of providerRows) adoptExternalMemory(row, stamp);
          const scoped: Array<{
            memoryId: string; providerId: string; publishedAt: string; importance: number | null;
            revisionId: string; entryVersion: number; contentHash: string;
            current: { category?: string; importance?: number; tags?: string[]; entities?: string[] };
          }> = [];
          /**
           * Classification the Provider holds for rows the catalog has not recorded it for.
           *
           * The list is assembled from the catalog because only it knows the entry version and the
           * revision chain, but the catalog may predate classification being recorded. The Provider
           * always has a category (rows stored without one are held as `general`), so it supplies
           * the field whenever the catalog left it empty. Nothing is written back: the catalog is
           * authoritative for what it recorded, and rewriting an immutable revision to fill a gap
           * would be a silent history change.
           */
          const providerMeta = new Map(providerRows.map(row => [row.id, row] as const));
          for (const providerId of candidates.catalog.visibleProviderIds()) {
            for (const memoryId of candidates.catalog.currentMemoryIds(providerId)) {
              const descriptor = candidates.catalog.get(memoryId);
              if (descriptor.state !== 'active') continue;
              const current = descriptor.revisions.find(revision => revision.id === descriptor.currentRevisionId);
              if (!current) continue;
              const fromProvider = providerMeta.get(providerId);
              const category = current.category ?? fromProvider?.category;
              const importance = current.importance ?? fromProvider?.importance;
              const tags = current.tags ?? fromProvider?.tags;
              const entities = current.entities ?? fromProvider?.entities;
              scoped.push({
                memoryId, providerId, publishedAt: current.publishedAt, importance: importance ?? null,
                revisionId: current.id, entryVersion: candidates.memory.entryVersion(memoryId), contentHash: current.contentHash,
                current: {
                  ...(category === undefined ? {} : { category }),
                  ...(importance === undefined ? {} : { importance }),
                  ...(tags === undefined ? {} : { tags }),
                  ...(entities === undefined ? {} : { entities }),
                },
              });
            }
          }
          /**
           * The entity index is the Provider's frequency table, not a recount of this page.
           *
           * `status.top_entities` is maintained by the store over every memory it holds, so it is
           * the only source that stays whole when the list is filtered or paged. Entities the
           * catalog recorded but the Provider has not indexed are merged in afterwards, because a
           * freshly written memory may not be in the store's table yet.
           */
          /**
           * The entity index is the Provider's frequency table, widened by the catalog's own rows.
           *
           * `top_entities` is maintained by the store over every memory it holds, so it is the
           * only source that stays whole when the list is filtered or paged — but it is a *top*
           * table, not a complete index, so an entity it omits would otherwise report zero and be
           * unfilterable. Counting the catalog's rows only for entities the table does not already
           * list keeps both properties: whole counts where the Provider knows them, and coverage
           * for what it does not.
           */
          const providerStats = typeof provider.stats === 'function'
            ? await provider.stats().catch(() => null)
            : null;
          /**
           * The category index counts rows by the classification the list will report.
           *
           * The Provider's `by_category` counts only what it was told: a memory written with a
           * category here but persisted to the Provider without one lands under `general` there,
           * while the catalog holds the reviewed value. Counting the assembled rows keeps the
           * index and the filterable list in agreement, which is the property the picker needs.
           */
          const categories = new Map<string, number>();
          const entityNames = new Map<string, string>();
          const entityCounts = new Map<string, number>();
          /**
           * The Provider's frequency table seeds the index.
           *
           * `top_entities` is computed over every memory the store holds, so it is the only count
           * that stays whole when the list is filtered or paged. It is a *top* table rather than a
           * complete index, so entries it omits are counted from the catalog below; entries it
           * lists are not recounted, or each memory would be added twice.
           */
          if (providerStats !== null) {
            for (const entry of providerStats.topEntities) {
              const key = entry.entity.toLowerCase();
              if (!entityNames.has(key)) entityNames.set(key, entry.entity);
              entityCounts.set(key, entry.count);
            }
          }
          for (const entry of scoped) {
            if (entry.current.category !== undefined) categories.set(entry.current.category, (categories.get(entry.current.category) ?? 0) + 1);
            for (const value of entry.current.entities ?? []) {
              const key = value.toLowerCase();
              if (!entityNames.has(key)) entityNames.set(key, value);
              // The Provider's table already counted this memory for that entity; adding it again
              // would double the number. Only entities the table omitted are counted here.
              if (providerStats === null || !providerStats.topEntities.some(item => item.entity.toLowerCase() === key)) {
                entityCounts.set(key, (entityCounts.get(key) ?? 0) + 1);
              }
            }
          }
          const wantedEntity = entity?.toLowerCase();
          const browsable = scoped.filter(entry =>
            (category === undefined || entry.current.category === category)
            && (wantedEntity === undefined || (entry.current.entities ?? []).some(value => value.toLowerCase() === wantedEntity)));
          browsable.sort((left, right) => compareEntries(left, right, order));
          const after = decodeListCursor(cursor);
          if (after !== null && after.sort !== order) throw new MnemoWeaveError('INVALID_INPUT');
          const remaining = after === null ? browsable : browsable.filter(entry => isAfterCursor(entry, after));
          const items: Array<Record<string, unknown>> = [];
          let windowSize = limit;
          const maxWindow = Math.max(limit * 4, 96);
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
              if (!candidates.catalog.currentMemoryIds(entry.providerId).includes(entry.memoryId)) continue;
              if (content === undefined) { readFailure = true; break; }
              if (createHash('sha256').update(content).digest('hex') !== entry.contentHash) {
                throw new MnemoWeaveError('PROVIDER_INTEGRITY');
              }
              const position = index + offset;
              if (terms.length > 0 && !terms.every(term => content.toLowerCase().includes(term))) continue;
              const descriptor = candidates.catalog.get(entry.memoryId);
              const current = descriptor.revisions.find(revision => revision.id === descriptor.currentRevisionId);
              if (descriptor.state !== 'active' || current?.id !== entry.revisionId
                || candidates.memory.entryVersion(entry.memoryId) !== entry.entryVersion) continue;
              items.push({
                memoryId: entry.memoryId, revisionId: entry.revisionId, providerMemoryId: entry.providerId,
                publishedAt: entry.publishedAt, content,
                entryVersion: entry.entryVersion,
                ...entry.current,
              });
              lastReturned = position;
            }
            index += window.length;
            if (items.length < limit && !readFailure) windowSize = Math.min(windowSize * 2, maxWindow);
          }
          if (items.length === 0 && readFailure) throw new MnemoWeaveError('PROVIDER_UNAVAILABLE');
          const cursorEntry = lastReturned >= 0 ? remaining[lastReturned]! : null;
          const hasMore = cursorEntry !== null && lastReturned + 1 < remaining.length;
          return MemoryList.parse({
            items,
            ...(hasMore ? { nextCursor: encodeListCursor({ sort: order, publishedAt: cursorEntry.publishedAt, importance: cursorEntry.importance, memoryId: cursorEntry.memoryId }) } : {}),
            categories: [...categories].map(([value, count]) => ({ value, count })).sort((left, right) => left.value.localeCompare(right.value)),
            // Most-referenced first: the index is a frequency table, and the reader looking for
            // the entities that matter reads the top of it. Equal counts fall back to the name so
            // the order does not shuffle between requests.
            entities: [...entityNames].map(([key, value]) => ({ value, count: entityCounts.get(key) ?? 0 }))
              .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value)),
            // The whole catalog, not the filtered page: a tab badge reports the size of the
            // collection, so filtering the list must not make it look like rows were lost.
            total: scoped.length,
          });
        },
        /**
         * Provider-ranked search over the shared collection. An optional hint is a workspace name
         * used as an extra relevance line; it never filters the result set.
         *
         * There is no score floor. The recall quality policy has already decided which rows are
         * relevant and how many of the weaker tiers to admit; a floor on top of that would ask the
         * caller to guess a number on the Provider's fused scale, which is not a similarity and
         * differs by retrieval mode.
         */
        explore: async (_hostId, input) => {
          const query = input.hint === undefined ? input.query : `${input.query}\n${input.hint}`;
          const recalled = await app.recallDetailed({ query, limit: input.limit, mode: input.mode, category: input.category });
          const hits: Array<Record<string, unknown>> = [];
          for (const memory of recalled.memories) {
            for (const memoryId of candidates.catalog.currentMemoryIds(memory.id)) {
              const descriptor = candidates.catalog.get(memoryId);
              if (descriptor.state !== 'active') continue;
              const current = descriptor.revisions.find(revision => revision.id === descriptor.currentRevisionId);
              if (!current) continue;
              hits.push({
                memoryId, revisionId: current.id, providerMemoryId: memory.id,
                state: descriptor.state, content: memory.content,
                ...(memory.score === undefined ? {} : { score: memory.score }),
                ...(memory.relevance === undefined ? {} : { relevance: memory.relevance }),
                publishedAt: current.publishedAt,
                ...(current.category === undefined ? {} : { category: current.category }),
                ...(current.tags === undefined ? {} : { tags: current.tags }),
              });
            }
          }
          hits.sort((left, right) => {
            // The policy already decided which rows belong in the answer and in which tier. The
            // re-sort only makes that decision reproducible: the Provider's own tie order was
            // measured to change between calls for one query, so ties are broken here on facts
            // the catalog owns.
            const order = { high: 0, medium: 1, unknown: 2, low: 3 } as const;
            const tier = (row: Record<string, unknown>): number => order[(row['relevance'] as keyof typeof order | undefined) ?? 'unknown'] ?? 2;
            if (tier(left) !== tier(right)) return tier(left) - tier(right);
            const leftScore = left['score'] as number | undefined;
            const rightScore = right['score'] as number | undefined;
            if (leftScore !== undefined && rightScore !== undefined && leftScore !== rightScore) return rightScore - leftScore;
            if (leftScore === undefined && rightScore !== undefined) return 1;
            if (leftScore !== undefined && rightScore === undefined) return -1;
            const leftAt = left['publishedAt'] as string;
            const rightAt = right['publishedAt'] as string;
            if (leftAt !== rightAt) return leftAt < rightAt ? 1 : -1;
            const leftId = left['memoryId'] as string;
            const rightId = right['memoryId'] as string;
            return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
          });
          return { query: input.query, hits, unregistered: recalled.unregistered.length, truncated: hits.length >= input.limit };
        },
        graph: async (_hostId, { limit }) => {
          const nodes: Array<{
            memoryId: string; publishedAt: string; state: 'active' | 'superseded' | 'unverified';
            category?: string; importance?: number; label?: string;
          }> = [];
          const describeNode = (memoryId: string): (typeof nodes)[number] | null => {
            const descriptor = candidates.catalog.get(memoryId);
            if (descriptor.state === 'superseded' && descriptor.revisions.length === 0) return null;
            const current = descriptor.revisions.find(revision => revision.id === descriptor.currentRevisionId);
            if (!current) return null;
            return {
              memoryId,
              state: descriptor.state === 'active' ? 'active' : descriptor.state === 'unverified' ? 'unverified' : 'superseded',
              publishedAt: current.publishedAt,
              ...(current.category === undefined ? {} : { category: current.category }),
              ...(current.importance === undefined ? {} : { importance: current.importance }),
            };
          };
          /**
           * The graph is the Provider's own, not a picture of this Server's bookkeeping.
           *
           * `viz` is the official export and carries the edges the store actually holds — entity
           * co-occurrence, backbone links, semantic and causal relations — so drawing only the
           * catalog's supersede/conflict edges would hide most of the structure. The catalog's
           * logical relations are added on top, because they record decisions the Provider cannot
           * know about. Both are drawn; neither replaces the other.
           */
          const providerGraph = typeof provider.graph === 'function'
            ? await provider.graph().catch(() => null)
            : null;
          /** Provider id to the logical memory id it was adopted as. */
          const providerToLogical = new Map<string, string>();
          if (providerGraph !== null) {
            const stamp = now();
            const providerRows = await provider.listAll().catch(() => null);
            const bodyById = new Map((providerRows ?? []).map(row => [row.id, row] as const));
            for (const node of providerGraph.nodes) {
              const row = bodyById.get(node.id);
              if (row !== undefined) adoptExternalMemory(row, stamp);
              const logical = candidates.catalog.currentMemoryIds(node.id)[0];
              if (logical !== undefined) providerToLogical.set(node.id, logical);
            }
          }
          for (const providerId of candidates.catalog.visibleProviderIds()) {
            for (const memoryId of candidates.catalog.currentMemoryIds(providerId)) {
              const descriptor = candidates.catalog.get(memoryId);
              if (descriptor.state !== 'active') continue;
              const node = describeNode(memoryId);
              if (node !== null) nodes.push(node);
            }
          }
          const present = new Set(nodes.map(node => node.memoryId));
          for (const edge of [...candidates.catalog.allRelations(limit * 8), ...candidates.catalog.allConflictEdges(limit * 8)]) {
            for (const [near, far] of [[edge.sourceMemoryId, edge.targetMemoryId], [edge.targetMemoryId, edge.sourceMemoryId]] as const) {
              if (!present.has(near) || present.has(far)) continue;
              const node = describeNode(far);
              if (node === null) continue;
              nodes.push(node);
              present.add(far);
            }
          }
          nodes.sort((left, right) => {
            if (left.publishedAt !== right.publishedAt) return left.publishedAt < right.publishedAt ? 1 : -1;
            return left.memoryId < right.memoryId ? -1 : left.memoryId > right.memoryId ? 1 : 0;
          });
          const truncated = nodes.length > limit || (providerGraph?.truncated ?? false);
          const kept = nodes.slice(0, limit);
          const keptIds = new Set(kept.map(node => node.memoryId));
          // The catalog's own decisions first: they are the edges this Server is authoritative for.
          const edges = drawableEdges(kept.map(node => node.memoryId), [
            ...candidates.catalog.allRelations(limit * 8),
            ...candidates.catalog.allConflictEdges(limit * 8).map(edge => ({ ...edge, kind: 'Conflicts' })),
          ]);
          // Then the Provider's, translated through the adoption map, keeping only the ones whose
          // both ends survived the node limit so the drawing has no dangling endpoints.
          if (providerGraph !== null) {
            const seen = new Set(edges.map(edge => `${edge.sourceMemoryId}>${edge.targetMemoryId}`));
            for (const edge of providerGraph.edges) {
              const source = providerToLogical.get(edge.sourceId);
              const target = providerToLogical.get(edge.targetId);
              if (source === undefined || target === undefined) continue;
              if (!keptIds.has(source) || !keptIds.has(target)) continue;
              const key = `${source}>${target}`;
              if (seen.has(key)) continue;
              seen.add(key);
              // The Provider knows the edge but not our audit fields, so the edge names its own
              // origin instead of borrowing a decision record that does not exist.
              edges.push({
                sourceMemoryId: source, targetMemoryId: target, kind: 'RelatedTo',
                relationId: `provider:${edge.label || 'edge'}`,
                reason: edge.label === '' ? 'Provider graph edge' : `Provider graph edge: ${edge.label}`,
                effectiveAt: now(),
              });
            }
          }
          /**
           * Entities become nodes too.
           *
           * A memory graph drawn only from catalogued relations answers "what superseded what",
           * which is a small part of the structure: most of what connects these memories is the
           * entities they share. The Provider already indexes that, so the shared entities are
           * added as nodes with a link to each memory that names them. A memory with no catalogued
           * relation is then still visibly attached to the rest.
           */
          const entityNodes: Array<{
            memoryId: string; kind: 'entity'; state: 'active'; publishedAt: string;
            category: 'entity'; label: string; occurrenceCount: number;
          }> = [];
          const entityEdges: Array<{
            relationId: string; kind: 'Entity'; sourceMemoryId: string; targetMemoryId: string;
            reason: string; effectiveAt: string;
          }> = [];
          if (typeof provider.stats === 'function') {
            const stats = await provider.stats().catch(() => null);
            if (stats !== null) {
              // Which memories name each entity, taken from the rows already read for the nodes.
              const bodyById = new Map<string, readonly string[]>();
              for (const node of kept) {
                const descriptor = candidates.catalog.get(node.memoryId);
                const current = descriptor.revisions.find(revision => revision.id === descriptor.currentRevisionId);
                if (current?.entities !== undefined) bodyById.set(node.memoryId, current.entities);
              }
              const entityToMemories = new Map<string, { display: string; memoryIds: string[] }>();
              for (const [memoryId, entities] of bodyById) {
                for (const raw of entities) {
                  const key = raw.toLowerCase();
                  if (key === '') continue;
                  const entry = entityToMemories.get(key);
                  if (entry === undefined) entityToMemories.set(key, { display: raw, memoryIds: [memoryId] });
                  else entry.memoryIds.push(memoryId);
                }
              }
              // Only entities that actually connect something are drawn: a node hanging off one
              // memory adds clutter without showing a relation.
              const shared = [...entityToMemories.values()]
                .filter(entry => entry.memoryIds.length > 1)
                .sort((left, right) => right.memoryIds.length - left.memoryIds.length || left.display.localeCompare(right.display))
                .slice(0, 24);
              const stamp = now();
              for (const entry of shared) {
                entityNodes.push({
                  memoryId: entry.display, kind: 'entity', state: 'active', publishedAt: stamp,
                  category: 'entity', label: entry.display, occurrenceCount: entry.memoryIds.length,
                });
                for (const memoryId of entry.memoryIds) {
                  entityEdges.push({
                    relationId: `entity:${entry.display}:${memoryId}`, kind: 'Entity',
                    sourceMemoryId: entry.display, targetMemoryId: memoryId,
                    reason: `Shared entity: ${entry.display}`, effectiveAt: stamp,
                  });
                }
              }
            }
          }
          return {
            nodes: [...kept, ...entityNodes],
            edges: [...edges, ...entityEdges],
            truncated,
          };
        },
        /** Model-facing recall; the per-turn budget is enforced from the turn identity. */
        recall: async (hostId, input, turn) => {
          const request = RecallInput.parse(input);
          // A management recall (no turn) is bounded by the administrative limit; a model call
          // always names its turn and is charged against that turn's budget.
          /**
           * Attach the logical memory id so a model tool can open the body it was shown: `id` is
           * the Provider's identifier, which the read route does not accept.
           */
          const attachLogical = <T extends { id: string }>(memories: readonly T[]): Array<T & { memoryId?: string }> => memories.flatMap(memory => {
            const logical = candidates.catalog.currentMemoryIds(memory.id)
              .filter(memoryId => candidates.catalog.get(memoryId).state === 'active');
            return logical.length === 0 ? [memory] : logical.map(memoryId => ({ ...memory, memoryId }));
          });
          if (turn === undefined) {
            const result = await app.recallDetailed({ query: request.query, limit: Math.min(request.limit, 50) });
            return { ...result, memories: attachLogical(result.memories) };
          }
          requireTurn(hostId, turn);
          const budget = budgets.for({ ...turn, hostId });
          const result = await app.recallDetailed({ query: request.query, limit: Math.min(request.limit, 50) });
          // The band the quality policy assigned travels with the row: the budget admits at most
          // one medium and one unknown entry per turn, so it has to know which tier a row is in
          // rather than reading the Provider's own `confidence` label, which describes a fused
          // score that may not be the score shown.
          const answer = budget.acceptRecall(request.query, result.memories.map(memory => ({
            id: memory.id, content: memory.content,
            ...(memory.score === undefined ? {} : { score: memory.score }),
            ...(memory.relevance === undefined ? {} : { relevance: memory.relevance }),
          })));
          const byProvider = new Map(result.memories.map(memory => [memory.id, memory] as const));
          return {
            memories: attachLogical(answer.memories.flatMap(item => {
              const memory = byProvider.get(item.id);
              return memory === undefined
                ? []
                : [{
                  id: item.id, content: item.content,
                  ...(memory.score === undefined ? {} : { score: memory.score }),
                  ...(item.relevance === undefined ? {} : { relevance: item.relevance }),
                }];
            })),
            complete: !answer.truncated,
          };
        },
        related: async (hostId, input, turn) => {
          if (turn === undefined) throw new MnemoWeaveError('UNAUTHORIZED');
          requireTurn(hostId, turn);
          const request = input as { memoryId?: unknown; edge?: unknown };
          if (typeof request.memoryId !== 'string') throw new MnemoWeaveError('INVALID_INPUT');
          const budget = budgets.for({ ...turn, hostId });
          const descriptor = candidates.catalog.get(request.memoryId);
          const revision = descriptor.revisions.find(item => item.id === descriptor.currentRevisionId);
          if (!revision) throw new MnemoWeaveError('NOT_FOUND');
          const edge = request.edge === 'semantic' || request.edge === 'causal' || request.edge === 'entity' || request.edge === 'temporal' ? request.edge : 'supersedes';
          const related = await provider.related(revision.providerMemoryId, edge);
          const mapped = related.flatMap(item => candidates.catalog.currentMemoryIds(item.id).map(memoryId => ({ memoryId, content: item.content })));
          const answer = budget.acceptRelated(revision.providerMemoryId, mapped.map(item => ({ id: item.memoryId, content: item.content })));
          const byLogical = new Map(mapped.map(item => [item.memoryId, item] as const));
          return {
            memories: answer.memories.flatMap(item => {
              const logical = byLogical.get(item.id);
              return logical === undefined ? [] : [{ memoryId: item.id, content: item.content, excerpt: item.excerpt }];
            }),
            truncated: answer.truncated,
          };
        },
        createMemory: async (input) => withFormalCreateLock(async () => {
          const parsed = MemoryCreateInput.parse(input);
          if (config.MNEMOWEAVE_WORKER !== 'on') throw new MnemoWeaveError('INVALID_STATE');
          const duplicate = await findExactDuplicate(parsed.content);
          if (duplicate !== null) return duplicate;
          const hash = createHash('sha256').update(parsed.content, 'utf8').digest('hex');
          const reason = parsed.reason ?? '用户在记忆界面直接新增';
          const request = RememberInput.parse({
            idempotencyKey: `create-${randomUUID()}`.slice(0, 128),
            content: parsed.content, tags: parsed.tags ?? [],
            ...(parsed.category === undefined ? {} : { category: parsed.category }),
            ...(parsed.importance === undefined ? {} : { importance: parsed.importance }),
            ...(parsed.entities === undefined ? {} : { entities: parsed.entities }),
            provenance: {
              source: 'local-user', sourceReference: `user-create:${randomUUID()}`,
            },
          });
          const candidate = candidates.submit(request);
          candidates.review(candidate.id, 'approve', 'local-user', reason);
          const publication = await waitForPublication(candidate.id);
          const shareState = coordinator ? await shareMemory(publication) : 'confirmed';
          if (shareState === 'queued') throw new MnemoWeaveError('SYNC_QUEUED');
          if (shareState === 'unknown') throw new MnemoWeaveError('SYNC_OUTCOME_UNKNOWN');
          if (shareState === 'failed') throw new MnemoWeaveError('NEEDS_REVIEW');
          if (typeof shareState !== 'string') return shareState;
          return {
            memoryId: publication.memoryId, revisionId: publication.revisionId,
            providerMemoryId: publication.providerId, contentHash: hash,
            entryVersion: candidates.memory.entryVersion(publication.memoryId),
          };
        }),
        editMemory: async (memoryId, input) => withEditLock(memoryId, async () => {
          const parsed = MemoryEditInput.parse(input);
          const reason = parsed.reason ?? '用户在记忆界面直接编辑';
          return executeFormalEdit(memoryId, parsed, readEditBase(memoryId, parsed.entryVersion), {
            actor: 'local-user', reference: `user-edit:${memoryId}`, reason, evidence: [reason],
          });
        }),
        withdrawMemory: async (memoryId, input) => withEditLock(memoryId, async () => {
          const parsed = MemoryWithdrawInput.parse(input);
          const descriptor = candidates.catalog.get(memoryId);
          if (descriptor.state !== 'active') throw new MnemoWeaveError('INVALID_STATE');
          const currentVersion = candidates.memory.entryVersion(memoryId);
          assertEntryVersion(currentVersion, parsed.entryVersion);
          const at = now();
          const current = descriptor.revisions.find(revision => revision.id === descriptor.currentRevisionId);
          if (!current) throw new MnemoWeaveError('NOT_FOUND');
          if (coordinator && formalProvider) {
            const body = (await provider.readMemory(current.providerMemoryId)).content;
            const state = await submitLocal(planWithdrawChange({
              entryId: memoryId, content: body, entryVersion: currentVersion, at,
              category: (current.category ?? 'general') as never, importance: current.importance ?? 3,
              tags: current.tags ?? [], entities: current.entities ?? [],
            }), () => undefined);
            if (state === 'queued') throw new MnemoWeaveError('SYNC_QUEUED');
            if (state === 'unknown') throw new MnemoWeaveError('SYNC_OUTCOME_UNKNOWN');
            await applyFormal();
          }
          const withdrawn = candidates.catalog.withdrawLocal(memoryId, 'local-user', parsed.reason, at);
          const nextVersion = Math.max(currentVersion + 1, candidates.memory.entryVersion(memoryId));
          candidates.memory.upsertFormalMap({
            entryId: memoryId, version: nextVersion, providerId: current.providerMemoryId,
            contentHash: current.contentHash, state: 'applied', appliedAt: at,
          }, at);
          candidates.memory.setEntryVersion(memoryId, nextVersion, at);
          return { memoryId, revisionId: withdrawn.revisionId, entryVersion: nextVersion, withdrawnAt: at };
        }),

        // ── Authorized write tasks ──
        writeTaskAction: async (hostId, taskId, index, input) => {
          const action = WriteTaskAction.parse(input);
          // Authorize before claiming: a refused action must not take the task key, or the action
          // that would have been allowed could never run under that key again.
          const requestHash = createHash('sha256').update(JSON.stringify(action)).digest('hex');
          const existing = candidates.writeTasks.receipt(hostId, taskId, index);
          if (!existing) assertWriteTaskAllowed(hostId, action, taskId);
          const claim = candidates.writeTasks.claim({ hostId, taskId, index, kind: action.kind, action: action.action, requestHash });
          // A replay of the same action returns the latest known receipt; it is never executed twice.
          if (claim.existing && (action.kind !== 'formal-memory' || claim.existing.status !== 'unknown' || claim.existing.candidateId)) {
            return toReceipt(await refreshFormalReceipt(hostId, claim.existing));
          }
          if (existing) assertWriteTaskAllowed(hostId, action, taskId);
          const key = JSON.stringify([hostId, taskId, index]);
          const active = activeWriteTasks.get(key);
          if (active) return active;
          const execution = executeWriteTask(hostId, taskId, index, action)
            .catch(error => {
              if (!(error instanceof MnemoWeaveError)) throw error;
              if (error.code === 'SYNC_QUEUED' || error.code === 'SYNC_OUTCOME_UNKNOWN') {
                return { status: error.code === 'SYNC_QUEUED' ? 'queued' : 'unknown', errorCode: error.code } as const;
              }
              candidates.writeTasks.settle(hostId, taskId, index, { status: 'failed', errorCode: error.code });
              throw error;
            })
            .then(receipt => toReceipt(candidates.writeTasks.settle(hostId, taskId, index, receipt)))
            .finally(() => activeWriteTasks.delete(key));
          activeWriteTasks.set(key, execution);
          return execution;
        },
        writeTaskReceipt: async (hostId, taskId, index) => {
          const row = candidates.writeTasks.receipt(hostId, taskId, index);
          if (!row) throw new MnemoWeaveError('NOT_FOUND');
          return toReceipt(await refreshFormalReceipt(hostId, row));
        },
        writeTaskReceipts: async (hostId, limit) => ({
          items: await Promise.all(candidates.writeTasks.unsettledReceipts(hostId, limit)
            .map(async row => toReceipt(await refreshFormalReceipt(hostId, row)))),
        }),

        // ── Archive distillation ──
        createDistillation: async (hostId, input) => {
          const parsed = ArchiveDistillationCreate.parse(input);
          const row = candidates.memory.archive(parsed.source.entryId);
          if (!row || row.workspaceId !== parsed.source.workspaceId || row.withdrawnAt !== null) throw new MnemoWeaveError('NOT_FOUND');
          const sourceHash = createHash('sha256').update(row.body, 'utf8').digest('hex');
          if (row.version !== parsed.source.entryVersion || sourceHash !== parsed.source.contentHash) throw new MnemoWeaveError('VERSION_CONFLICT');
          const contentHash = createHash('sha256').update(parsed.content, 'utf8').digest('hex');
          const draft = candidates.distillations.create({
            hostId, workspaceId: parsed.source.workspaceId, entryId: parsed.source.entryId,
            entryVersion: parsed.source.entryVersion, sourceContentHash: parsed.source.contentHash,
            content: parsed.content,
            category: parsed.category ?? null, importance: parsed.importance ?? null,
            tags: parsed.tags ?? null, entities: parsed.entities ?? null,
            reason: parsed.reason, assessment: parsed.assessment, contentHash,
          });
          return toDistillation(draft);
        },
        readDistillation: async (hostId, draftId) => {
          const draft = candidates.distillations.get(draftId);
          if (!draft || draft.hostId !== hostId) throw new MnemoWeaveError('NOT_FOUND');
          const source = candidates.memory.archive(draft.entryId);
          if (!source || source.workspaceId !== draft.workspaceId || source.withdrawnAt !== null) throw new MnemoWeaveError('NOT_FOUND');
          return toDistillation(draft);
        },

        // ── Idle review ──
        idleReviewScan: async (hostId, input) => {
          const request = IdleReviewScanInput.parse(input);
          const state = candidates.events.idleReview(hostId, request.sessionId);
          // The scan reads the retained user turns, not the selectively persisted event ledger: an
          // ordinary user message is skipped by the retention selector, and it is exactly the
          // material an idle review judges.
          const turns = candidates.turns.messages(hostId, request.sessionId).map(message => ({
            eventId: message.eventId, sessionId: request.sessionId,
            turnId: message.turnId, kind: 'message.user' as const,
            payload: { text: message.text, ...(message.noRetention ? { noRetention: true as const } : {}) },
          }));
          const selection = selectIdleReviewSignals(turns, {
            afterTurn: state.lastTurn, completedThroughTurn: request.completedThroughTurn,
            maxSignals: request.maxSignals, knownTexts: new Set(state.signals.map(signal => signal.text)),
            now: now(), id: randomUUID,
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
        idleReviewPending: async hostId => ({
          sessions: candidates.events.pendingIdleSessions(hostId).map(session => {
            const latest = candidates.events.idleRuns(hostId, session.sessionId)[0];
            return { ...session, workspaceId: candidates.workspaces.sessionWorkspace(hostId, session.sessionId),
              attempt: latest?.attempt ?? 0, lastStartedAt: latest?.startedAt ?? null };
          }),
        }),
        idleReviewRecent: async (hostId, limit) => ({ items: candidates.events.recentIdleRuns(hostId, limit) }),
        idleReviewRuns: async (hostId, sessionId) => ({ items: candidates.events.idleRuns(hostId, sessionId) }),
        idleReviewRunItem: async (hostId, runId, input) => candidates.events.recordIdleRunItem(hostId, runId, IdleReviewRunItem.parse(input)),
        idleReviewRunFinish: async (hostId, runId, input) => {
          const request = IdleReviewRunFinishInput.parse(input);
          return candidates.events.finishIdleRun(hostId, runId, request.state, request.error);
        },
      };

      // ── Sync ──
      if (config.MNEMOWEAVE_SYNC_URL && config.MNEMOWEAVE_SYNC_DEVICE_ID && config.MNEMOWEAVE_SYNC_TOKEN) {
        syncClient = new SyncClient({ baseUrl: config.MNEMOWEAVE_SYNC_URL, deviceId: config.MNEMOWEAVE_SYNC_DEVICE_ID, token: config.MNEMOWEAVE_SYNC_TOKEN, timeoutMs: config.MNEMOWEAVE_SYNC_TIMEOUT_MS });
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
        coordinator = new SyncCoordinator(syncClient, candidates.ledger, now, snapshot => {
          const stage = candidates.memory.stageSnapshot();
          return {
            apply: row => applyInboxEntry(row, { store: stage.store, provider: formal, ruleLimits }),
            commit: advance => stage.commit(() => {
              if (snapshot.stream === FORMAL_STREAM) {
                candidates.catalog.verifyMigratedFormalEntries(snapshot.entries.map(entry => entry.entryId));
              }
              advance();
            }),
          };
        });
        const service = new SyncService({
          remote: syncClient,
          coordinator,
          ledger: candidates.ledger,
          apply: row => applyInboxEntry(row, { store: candidates.memory, provider: formal, ruleLimits }),
          intervalMs: config.MNEMOWEAVE_SYNC_INTERVAL_MS,
          settlePublications: async () => {
            for (const pending of candidates.pendingShares()) {
              const descriptor = candidates.catalog.get(pending.memoryId);
              const revision = descriptor.revisions.find(item => item.number === pending.version);
              if (revision) await shareMemory({ memoryId: pending.memoryId, revisionId: revision.id, providerId: pending.providerId });
            }
          },
        });
        sync = service;
        const endpoints = client!;
        endpoints.syncStatus = async () => SyncStatusOutput.parse(service.status());
        endpoints.syncRefresh = async () => SyncRefreshOutput.parse(await service.refresh());
        candidates.setPublishListener(event => {
          void shareMemory({ memoryId: event.memoryId, revisionId: candidates!.catalog.get(event.memoryId).currentRevisionId, providerId: event.providerId })
            .catch(error => process.stderr.write(JSON.stringify({ event: 'publication_share_failed', code: error instanceof MnemoWeaveError ? error.code : 'INTERNAL' }) + '\n'));
        });
        service.start();
      }
    }
    if (!client) throw new Error('Memory endpoints require a state directory');
    return {
      app, port: config.MNEMOWEAVE_PORT,
      close: async () => { await sync?.stop(); await workflow?.stop(); await drainPublications?.(); candidates?.close(); },
      client, storage: candidates ? () => candidates.storageStatus() : undefined,
    };
  } catch (error) { candidates?.close(); throw error; }
}

/** Distillation drafts are returned as the contract, with the source metadata intact. */
function toDistillation(draft: import('../../../packages/infrastructure/governance/src/workspace-store.ts').DistillationRow) {
  return {
    draftId: draft.draftId,
    source: {
      workspaceId: draft.workspaceId, entryId: draft.entryId,
      entryVersion: draft.entryVersion, contentHash: draft.sourceContentHash,
    },
    content: draft.content,
    ...(draft.category === null ? {} : { category: draft.category as never }),
    ...(draft.importance === null ? {} : { importance: draft.importance }),
    ...(draft.tags === null ? {} : { tags: draft.tags }),
    ...(draft.entities === null ? {} : { entities: draft.entities }),
    reason: draft.reason,
    assessment: draft.assessment as never,
    contentHash: draft.contentHash,
    createdAt: draft.createdAt,
    taskId: draft.taskId,
  };
}
