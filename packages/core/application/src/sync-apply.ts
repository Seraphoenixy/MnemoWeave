import { createHash } from 'node:crypto';
import { MnemoWeaveError } from '../../contracts/src/index.ts';
import type { SyncContentValue, SyncEntryValue } from '../../contracts/src/index.ts';
import type { ApplyOutcome, SyncInboxRecord } from './sync.ts';

/**
 * Turning a received change into a local state.
 *
 * Runtime rules and project archives are stored directly. Formal memories go
 * through the Mnemon interface in a fixed order: write, link, read back, then move
 * the local mapping. Nothing is recorded as applied before the read-back matches,
 * so a recall never sees content the local Server has not verified.
 */

export interface LocalRuleRow {
  entryId: string;
  body: string;
  scope: 'global' | 'project';
  projectId: string | null;
  enabled: boolean;
  version: number;
  withdrawnAt: string | null;
}

export interface LocalArchiveRow {
  entryId: string;
  projectId: string;
  title: string;
  body: string;
  source: string;
  verification: 'verified' | 'open' | 'refuted';
  evidence: string;
  version: number;
  withdrawnAt: string | null;
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
  /** Provider id recorded for a specific revision, if this machine applied it. */
  formalProviderId(entryId: string, version: number): string | null;
  /**
   * Provider id this machine already holds for the same body, whatever version it was filed
   * under. The origin machine publishes locally before the remote assigns a version, so its
   * row and the echoed change can disagree on the number while describing the same write.
   */
  formalProviderIdByHash?(entryId: string, contentHash: string): string | null;
  /** Confirmed remote version of an entry; local writes use it as their base. */
  setEntryVersion(entryId: string, version: number, at: string): void;
  /** Mirror a synced formal revision into the local catalog, when the store has one. */
  publishSynced?(input: SyncedPublish): void;
  /** Hide a synced formal memory whose remote entry was withdrawn. */
  retireSynced?(memoryId: string, at: string): void;
}

export interface SyncedPublish {
  entryId: string;
  version: number;
  content: string;
  contentHash: string;
  providerId: string;
  scope: string;
  projectId: string | null;
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
}

function projectIdOf(entry: SyncEntryValue): string | null {
  return entry.scope === 'global' ? null : entry.scope.slice('project:'.length);
}

function ruleRow(entry: SyncEntryValue, body: string): LocalRuleRow {
  const payload = entry.payload as { enabled?: boolean };
  const projectId = projectIdOf(entry);
  return {
    entryId: entry.entryId,
    body,
    scope: projectId === null ? 'global' : 'project',
    projectId,
    enabled: payload.enabled !== false,
    version: entry.version,
    withdrawnAt: entry.withdrawnAt,
  };
}

function archiveRow(entry: SyncEntryValue, body: string): LocalArchiveRow {
  const payload = entry.payload as { title: string; source: string; verification: 'verified' | 'open' | 'refuted'; evidence: string };
  const projectId = projectIdOf(entry);
  if (projectId === null) throw new MnemoWeaveError('INVALID_INPUT');
  return {
    entryId: entry.entryId,
    projectId,
    title: payload.title,
    body,
    source: payload.source,
    verification: payload.verification,
    evidence: payload.evidence,
    version: entry.version,
    withdrawnAt: entry.withdrawnAt,
  };
}

/**
 * Apply one inbox row. Provider failures stay `needs_review` with their code, which
 * keeps the scope cursor from advancing past content the local copy does not hold.
 */
export async function applyInboxEntry(record: SyncInboxRecord, ports: ApplyPorts): Promise<ApplyOutcome> {
  const at = (ports.now ?? (() => new Date().toISOString()))();
  const entry = record.entry;
  let body: string;
  try {
    body = decodeContent(entry.content);
  } catch (error) {
    return { status: 'needs_review', error: error instanceof MnemoWeaveError ? error.code : 'PROVIDER_INTEGRITY' };
  }

  if (entry.kind === 'runtime') {
    if (record.operation === 'delete' || entry.withdrawnAt !== null) ports.store.withdrawRule(entry.entryId, at);
    else ports.store.upsertRule(ruleRow(entry, body), at);
    ports.store.setEntryVersion(entry.entryId, entry.version, at);
    return { status: 'applied' };
  }

  if (entry.kind === 'archive') {
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
      providerId, scope: entry.scope,
      projectId: entry.scope.startsWith('project:') ? entry.scope.slice('project:'.length) : null,
      category: payload.category ?? 'general', tags: payload.tags ?? [],
      // Classification travels with the revision so the local view can show what the origin
      // machine recorded instead of guessing from the body.
      ...(typeof payload.importance === 'number' ? { importance: payload.importance } : {}),
      ...(payload.entities === undefined ? {} : { entities: payload.entities }),
      at,
    });
  };
  try {
    if (record.operation === 'delete' || entry.withdrawnAt !== null) {
      // Withdrawal is a new version that stops being recalled; it is not physical deletion.
      // `forget` erases the row, so `show` fails and edges pointing at it disappear — which
      // breaks the protocol's promise that withdrawn history stays readable. The local
      // Provider copy is left intact and only the catalog pointer is retired, so the body is
      // still inspectable while recall and injection skip it.
      ports.store.upsertFormalMap({ entryId: entry.entryId, version: entry.version, providerId: previous, contentHash: entry.content.contentHash, state: 'applied', appliedAt: at }, at);
      ports.store.retireSynced?.(entry.entryId, at);
      return { status: 'applied' };
    }
    // A retry after a partial failure must not write the Provider twice.
    const existing = ports.store.formalProviderId(entry.entryId, entry.version);
    if (existing) {
      mirror(existing);
      return { status: 'applied' };
    }
    // The origin machine published this revision itself and already wrote the Provider. Its
    // mapping is keyed by the version the remote assigned, which may differ from the version
    // this row carries, so look the revision up by content hash before writing a second copy.
    const local = ports.store.formalProviderIdByHash?.(entry.entryId, entry.content.contentHash);
    if (local) {
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
    // Linking is an upsert on the Provider side, so replaying it is harmless.
    const linkTargets = async (providerId: string): Promise<void> => {
      for (const target of targetsFor(providerId)) {
        await ports.provider.linkSupersedes(providerId, target, { operationId: record.changeId, reason: 'cross-machine sync', effectiveAt: at });
      }
    };
      // The mapping is written after the Provider call, so a crash in between leaves a
      // written memory with no local row. Recover it by its stable source before writing.
      // This also makes an overlapping apply safe: the first writer's row is found by
      // source instead of being written a second time.
      const recovered = await ports.provider.findBySource?.(source);
      if (recovered) {
        // Same source, different body means the source is not unique for this change; refuse
        // rather than silently keeping the wrong content.
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
