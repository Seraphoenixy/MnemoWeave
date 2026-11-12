import { createHash } from 'node:crypto';
import { MnemoWeaveError, streamOf } from '../../contracts/src/index.ts';
import type { SyncContentValue, SyncEntryValue } from '../../contracts/src/index.ts';
import type { ApplyOutcome, SyncInboxRecord } from './sync.ts';
import type { RuleLimits } from './rules.ts';
import { ruleUsage } from './rules.ts';

/**
 * Turning a received change into a local state.
 *
 * Rules and workspace archives are stored directly. Formal memories go through the Mnemon
 * interface in a fixed order: write, link, read back, then move the local mapping. Nothing is
 * recorded as applied before the read-back matches, so a recall never sees content the local
 * Server has not verified.
 */

export interface LocalRuleRow {
  entryId: string;
  body: string;
  enabled: boolean;
  version: number;
  withdrawnAt: string | null;
  importance?: 'critical' | 'normal' | 'low' | undefined;
  pinned?: boolean | undefined;
  createdAt?: string | undefined;
}

export interface LocalArchiveRow {
  entryId: string;
  workspaceId: string;
  title: string;
  body: string;
  source: string;
  verification: 'verified' | 'open' | 'refuted';
  evidence: string;
  version: number;
  withdrawnAt: string | null;
  /** Absent on rows written before the workspace model; normalized to active. */
  state?: 'active' | 'archived' | undefined;
  archivedAt?: string | null | undefined;
  updatedAt?: string | undefined;
}

export type FormalMapState = 'applied' | 'pending' | 'unknown' | 'needs_review';

export interface FormalMapRow {
  entryId: string;
  version: number;
  providerId: string | null;
  contentHash: string;
  state: FormalMapState;
  appliedAt: string | null;
}

export interface MemoryApplyStore {
  upsertRule(row: LocalRuleRow, at: string): void;
  withdrawRule(entryId: string, at: string): void;
  upsertArchive(row: LocalArchiveRow, at: string): void;
  withdrawArchive(entryId: string, at: string): void;
  upsertFormalMap(row: FormalMapRow, at: string): void;
  formalProviderId(entryId: string, version: number): string | null;
  /**
   * Provider id this machine already holds for the same body, whatever version it was filed
   * under. The origin machine publishes locally before the remote assigns a version, so its row
   * and the echoed change can disagree on the number while describing the same write.
   */
  formalProviderIdByHash?(entryId: string, contentHash: string): string | null;
  /** Confirmed remote version of an entry; local writes use it as their base. */
  setEntryVersion(entryId: string, version: number, at: string): void;
  /** Mirror a synced formal revision into the local catalog, when the store has one. */
  publishSynced?(input: SyncedPublish): void;
  /** Hide a synced formal memory whose remote entry was withdrawn. */
  retireSynced?(memoryId: string, at: string): void;
  /** Confirm the current rule set, refusing an inbound set that is over capacity. */
  applyRuleWithCapacity?(row: LocalRuleRow, at: string, limits: RuleLimits): void;
}

export interface SyncedPublish {
  entryId: string;
  version: number;
  content: string;
  contentHash: string;
  providerId: string;
  category: string;
  importance?: number;
  tags: string[];
  entities?: string[];
  at: string;
}

/** The subset of the Mnemon adapter the apply step needs. */
export interface FormalProviderPort {
  remember(content: string, source: string): Promise<{ id: string }>;
  linkSupersedes(sourceId: string, targetId: string, metadata: { operationId: string; reason: string; effectiveAt: string }): Promise<unknown>;
  show(id: string): Promise<{ id: string; content: string }>;
  forget(id: string): Promise<unknown>;
  /**
   * Locate a memory this machine already wrote under a stable `source`. A synced write is
   * `remember --no-diff`, which has no idempotency: if the process dies after the write but
   * before the mapping is recorded, a replay that only consults `formal_map` would write a
   * second copy. The source makes the previous attempt findable.
   */
  findBySource?(source: string): Promise<{ id: string; content: string } | null>;
}

/** Decode and verify a body. Encryption is not wired yet, so it is refused, not guessed. */
export function decodeContent(content: SyncContentValue): string {
  if (content.format !== 'plain') throw new MnemoWeaveError('NEEDS_REVIEW');
  const bytes = Buffer.from(content.data, 'utf8');
  if (bytes.length !== content.byteLength) throw new MnemoWeaveError('PROVIDER_INTEGRITY');
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== content.contentHash) throw new MnemoWeaveError('PROVIDER_INTEGRITY');
  return content.data;
}

export interface ApplyPorts {
  store: MemoryApplyStore;
  provider: FormalProviderPort;
  now?: () => string;
  /** Capacity is part of the local apply boundary, including retries and sync merges. */
  ruleLimits?: RuleLimits;
}

function ruleRow(entry: SyncEntryValue, body: string): LocalRuleRow {
  const payload = entry.payload as { enabled?: boolean; importance?: 'critical' | 'normal' | 'low'; pinned?: boolean };
  return {
    entryId: entry.entryId,
    body,
    enabled: payload.enabled !== false,
    version: entry.version,
    withdrawnAt: entry.withdrawnAt,
    importance: payload.importance ?? 'normal',
    pinned: payload.pinned === true,
  };
}

function archiveRow(entry: SyncEntryValue, body: string): LocalArchiveRow {
  const payload = entry.payload as {
    workspaceId?: string; title: string; source: string; verification: 'verified' | 'open' | 'refuted';
    evidence: string; state?: 'active' | 'archived'; archivedAt?: string | null;
  };
  if (typeof payload.workspaceId !== 'string') throw new MnemoWeaveError('INVALID_INPUT');
  if (streamOf(entry.kind, entry.payload) === 'rules' || streamOf(entry.kind, entry.payload) === 'formal-memories') throw new MnemoWeaveError('INVALID_INPUT');
  const state = payload.state === 'archived' ? 'archived' : 'active';
  return {
    entryId: entry.entryId,
    workspaceId: payload.workspaceId,
    title: payload.title,
    body,
    source: payload.source,
    verification: payload.verification,
    evidence: payload.evidence,
    version: entry.version,
    withdrawnAt: entry.withdrawnAt,
    state,
    archivedAt: state === 'archived' ? payload.archivedAt ?? null : null,
  };
}

/**
 * Apply one inbox row. Provider failures stay `needs_review` with their code, which keeps the
 * stream cursor from advancing past content the local copy does not hold. An inbound rule set
 * that exceeds capacity is refused the same way: it is never trimmed or archived on arrival.
 */
export async function applyInboxEntry(record: SyncInboxRecord, ports: ApplyPorts): Promise<ApplyOutcome> {
  const entry = record.entry;
  const at = entry.revisions?.find(revision => revision.version === entry.version)?.createdAt
    ?? (ports.now ?? (() => new Date().toISOString()))();
  let body: string;
  try {
    body = decodeContent(entry.content);
  } catch (error) {
    return { status: 'needs_review', error: error instanceof MnemoWeaveError ? error.code : 'PROVIDER_INTEGRITY' };
  }
  try {
    if (streamOf(entry.kind, entry.payload) !== record.stream) return { status: 'needs_review', error: 'INVALID_INPUT' };
  } catch {
    return { status: 'needs_review', error: 'INVALID_INPUT' };
  }

  if (entry.kind === 'rule') {
    if (record.operation === 'delete' || entry.withdrawnAt !== null) {
      ports.store.withdrawRule(entry.entryId, at);
    } else if (ports.store.applyRuleWithCapacity !== undefined && ports.ruleLimits !== undefined) {
      try {
        ports.store.applyRuleWithCapacity(ruleRow(entry, body), at, ports.ruleLimits);
      } catch (error) {
        if (error instanceof MnemoWeaveError && error.code === 'RULE_CAPACITY_EXCEEDED') {
          return { status: 'needs_review', error: error.code };
        }
        throw error;
      }
    } else {
      ports.store.upsertRule(ruleRow(entry, body), at);
    }
    ports.store.setEntryVersion(entry.entryId, entry.version, at);
    return { status: 'applied' };
  }

  if (entry.kind === 'workspace-archive') {
    if (record.operation === 'delete' || entry.withdrawnAt !== null) ports.store.withdrawArchive(entry.entryId, at);
    else ports.store.upsertArchive(archiveRow(entry, body), at);
    ports.store.setEntryVersion(entry.entryId, entry.version, at);
    return { status: 'applied' };
  }

  const formal = await applyFormal(record, body, ports, at);
  if (formal.status === 'applied') ports.store.setEntryVersion(entry.entryId, entry.version, at);
  return formal;
}

async function applyFormal(record: SyncInboxRecord, body: string, ports: ApplyPorts, at: string): Promise<ApplyOutcome> {
  const entry = record.entry;
  const previous = ports.store.formalProviderId(entry.entryId, entry.version - 1);
  const mirror = (providerId: string): void => {
    const payload = entry.payload as { category?: string; importance?: number; tags?: string[]; entities?: string[] };
    ports.store.publishSynced?.({
      entryId: entry.entryId, version: entry.version, content: body, contentHash: entry.content.contentHash,
      providerId,
      category: payload.category ?? 'general', tags: payload.tags ?? [],
      ...(typeof payload.importance === 'number' ? { importance: payload.importance } : {}),
      ...(payload.entities === undefined ? {} : { entities: payload.entities }),
      at,
    });
  };
  try {
    if (record.operation === 'delete' || entry.withdrawnAt !== null) {
      // Withdrawal is a new version that stops being recalled; it is not physical deletion.
      // `forget` erases the row, so `show` fails and edges pointing at it disappear.
      ports.store.upsertFormalMap({ entryId: entry.entryId, version: entry.version, providerId: previous, contentHash: entry.content.contentHash, state: 'applied', appliedAt: at }, at);
      ports.store.retireSynced?.(entry.entryId, at);
      return { status: 'applied' };
    }
    // A retry after a partial failure must not write the Provider twice.
    const existing = ports.store.formalProviderId(entry.entryId, entry.version);
    if (existing) {
      const current = await ports.provider.show(existing);
      if (current.id !== existing || current.content !== body) throw new MnemoWeaveError('PROVIDER_INTEGRITY');
      mirror(existing);
      return { status: 'applied' };
    }
    const local = ports.store.formalProviderIdByHash?.(entry.entryId, entry.content.contentHash);
    if (local) {
      const current = await ports.provider.show(local);
      if (current.id !== local || current.content !== body) throw new MnemoWeaveError('PROVIDER_INTEGRITY');
      ports.store.upsertFormalMap({ entryId: entry.entryId, version: entry.version, providerId: local, contentHash: entry.content.contentHash, state: 'applied', appliedAt: at }, at);
      mirror(local);
      return { status: 'applied' };
    }
    const source = `mnemoweave:${record.changeId}:${entry.version}`;
    // Which local memories this revision supersedes: declared relations first, then the
    // previous version of the same entry, which is how the change stream expressed it.
    const targetsFor = (providerId: string): string[] => {
      const relations = (entry.payload as { relations?: { type: string; from: { entryId: string; version: number }; to: { entryId: string; version: number } }[] }).relations ?? [];
      const targets = new Set<string>();
      for (const relation of relations) {
        if (relation.type !== 'supersedes') continue;
        if (relation.to.entryId !== entry.entryId || relation.to.version !== entry.version) continue;
        const target = ports.store.formalProviderId(relation.from.entryId, relation.from.version);
        if (target && target !== providerId) targets.add(target);
      }
      if (targets.size === 0 && previous && previous !== providerId) targets.add(previous);
      return [...targets];
    };
    const linkTargets = async (providerId: string): Promise<void> => {
      for (const target of targetsFor(providerId)) {
        await ports.provider.linkSupersedes(providerId, target, { operationId: record.changeId, reason: 'cross-machine sync', effectiveAt: at });
      }
    };
    const recovered = await ports.provider.findBySource?.(source);
    if (recovered) {
      if (createHash('sha256').update(Buffer.from(recovered.content, 'utf8')).digest('hex') !== entry.content.contentHash) {
        return { status: 'needs_review', error: 'PROVIDER_INTEGRITY' };
      }
      await linkTargets(recovered.id);
      ports.store.upsertFormalMap({ entryId: entry.entryId, version: entry.version, providerId: recovered.id, contentHash: entry.content.contentHash, state: 'applied', appliedAt: at }, at);
      mirror(recovered.id);
      return { status: 'applied' };
    }
    const written = await ports.provider.remember(body, source);
    const actual = await ports.provider.show(written.id);
    if (actual.id !== written.id || createHash('sha256').update(Buffer.from(actual.content, 'utf8')).digest('hex') !== entry.content.contentHash) {
      return { status: 'needs_review', error: 'PROVIDER_INTEGRITY' };
    }
    await linkTargets(written.id);
    ports.store.upsertFormalMap({ entryId: entry.entryId, version: entry.version, providerId: written.id, contentHash: entry.content.contentHash, state: 'applied', appliedAt: at }, at);
    mirror(written.id);
    return { status: 'applied' };
  } catch (error) {
    const code = error instanceof MnemoWeaveError ? error.code : 'PROVIDER_UNAVAILABLE';
    return { status: 'needs_review', error: code };
  }
}

/** The capacity check the local apply boundary uses for an inbound rule set. */
export function ruleSetFits(row: LocalRuleRow, existing: readonly LocalRuleRow[], limits: RuleLimits): boolean {
  const merged = [...existing.filter(entry => entry.entryId !== row.entryId), row];
  return !ruleUsage(merged, limits).exceeded;
}
