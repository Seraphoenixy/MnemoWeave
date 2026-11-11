import type { DatabaseSync } from 'node:sqlite';
import { RememberInput } from '../../../core/contracts/src/index.ts';
import type { InjectionReportRecord } from '../../../core/contracts/src/index.ts';
import type { FormalMapRow, LocalArchiveRow, LocalRuleRow, MemoryApplyStore, SyncedPublish } from '../../../core/application/src/sync-apply.ts';
import type { SqliteMemoryCatalog } from './catalog.ts';

/**
 * Local storage for the three memory classes (schema v11).
 *
 * Runtime rules and project archives live here as the working copy; the remote
 * keeps the confirmed version. Formal memories keep only this machine's mapping
 * from logical revision to the local Mnemon id — never the body, which stays
 * authoritative in Mnemon.
 */

type Transaction = <T>(operation: () => T) => T;

interface RuleDbRow {
  entry_id: string; body: string; enabled: number; version: number; withdrawn_at: string | null;
}

interface ArchiveDbRow {
  entry_id: string; project_id: string; title: string; body: string; source: string; verification: string; evidence: string; version: number; withdrawn_at: string | null;
}

interface MapDbRow {
  entry_id: string; version: number; provider_id: string | null; content_hash: string; state: string; applied_at: string | null;
}

export class SqliteMemoryStore implements MemoryApplyStore {
  private readonly db: DatabaseSync;
  private readonly transaction: Transaction;
  private readonly catalog: SqliteMemoryCatalog | undefined;

  constructor(db: DatabaseSync, transaction: Transaction, catalog?: SqliteMemoryCatalog) {
    this.db = db;
    this.transaction = transaction;
    this.catalog = catalog;
  }

  /**
   * A synced formal revision becomes a local catalog revision, so the memory is
   * visible and editable on this machine. Provenance records that it arrived by sync.
   */
  publishSynced(input: SyncedPublish): void {
    if (!this.catalog) return;
    const request = RememberInput.parse({
      idempotencyKey: `sync-${input.entryId.slice(0, 8)}-${input.version}`,
      content: input.content,
      knowledgeType: 'Practice',
      tags: input.tags,
      provenance: {
        source: 'sync',
        sourceReference: `mnemoweave:${input.entryId}:${input.version}`,
        evidence: [`synced from the shared server at ${input.at}`],
        verificationStatus: 'verified',
        confidence: 1,
        applicability: 'global',
        limitations: '内容由其他设备写入，本机未重新审核',
        lastVerified: input.at,
      },
    });
    // The classification comes from the entry payload, not from the synthetic request: a synced
    // entry knows its category, importance and entities, and the `knowledgeType: 'Practice'` above
    // is only a schema placeholder that must not become the recorded classification.
    this.catalog.publishSynced(input.entryId, request, input.providerId, input.contentHash, input.at, 'sync', `synced revision ${input.version}`, {
      category: input.category,
      ...(input.importance === undefined ? {} : { importance: input.importance }),
      tags: input.tags,
      ...(input.entities === undefined ? {} : { entities: input.entities }),
    });
  }

  retireSynced(memoryId: string): void {
    this.catalog?.retireSynced(memoryId);
  }

  upsertRule(row: LocalRuleRow, at: string): void {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO runtime_rules(entry_id, body, scope, project_id, enabled, version, withdrawn_at, updated_at)
        VALUES(?, ?, 'global', NULL, ?, ?, ?, ?)
        ON CONFLICT(entry_id) DO UPDATE SET body=excluded.body, scope=excluded.scope, project_id=excluded.project_id,
          enabled=excluded.enabled, version=excluded.version, withdrawn_at=excluded.withdrawn_at, updated_at=excluded.updated_at
      `).run(row.entryId, row.body, row.enabled ? 1 : 0, row.version, row.withdrawnAt, at);
    });
  }

  withdrawRule(entryId: string, at: string): void {
    this.transaction(() => {
      this.db.prepare('UPDATE runtime_rules SET withdrawn_at = ?, enabled = 0, updated_at = ? WHERE entry_id = ?').run(at, at, entryId);
    });
  }

  upsertArchive(row: LocalArchiveRow, at: string): void {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO project_archives(entry_id, project_id, title, body, source, verification, evidence, version, withdrawn_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entry_id) DO UPDATE SET project_id=excluded.project_id, title=excluded.title, body=excluded.body,
          source=excluded.source, verification=excluded.verification, evidence=excluded.evidence, version=excluded.version,
          withdrawn_at=excluded.withdrawn_at, updated_at=excluded.updated_at
      `).run(row.entryId, row.projectId, row.title, row.body, row.source, row.verification, row.evidence, row.version, row.withdrawnAt, at);
    });
  }

  withdrawArchive(entryId: string, at: string): void {
    this.transaction(() => {
      this.db.prepare('UPDATE project_archives SET withdrawn_at = ?, updated_at = ? WHERE entry_id = ?').run(at, at, entryId);
    });
  }

  upsertFormalMap(row: FormalMapRow, at: string): void {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO formal_map(entry_id, version, provider_id, content_hash, state, applied_at)
        VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(entry_id, version) DO UPDATE SET provider_id=excluded.provider_id, content_hash=excluded.content_hash,
          state=excluded.state, applied_at=excluded.applied_at
      `).run(row.entryId, row.version, row.providerId, row.contentHash, row.state, row.appliedAt ?? at);
    });
  }

  /** Highest confirmed version for an entry; 0 when the remote has never confirmed it. */
  entryVersion(entryId: string): number {
    const row = this.db.prepare('SELECT version FROM entry_versions WHERE entry_id = ?').get(entryId) as { version: number } | undefined;
    return row?.version ?? 0;
  }

  setEntryVersion(entryId: string, version: number, at: string): void {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO entry_versions(entry_id, version, updated_at) VALUES(?, ?, ?)
        ON CONFLICT(entry_id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at
      `).run(entryId, version, at);
    });
  }

  formalProviderId(entryId: string, version: number): string | null {    const row = this.db.prepare('SELECT provider_id FROM formal_map WHERE entry_id = ? AND version = ?').get(entryId, version) as { provider_id: string | null } | undefined;
    return row?.provider_id ?? null;
  }

  /**
   * The lowest mapped version above `baseVersion`, or null when this entry gained no mapping.
   * A synced write is only successful once its revision has a local Provider mapping, so this
   * is what an edit checks instead of trusting a possibly-dropped inbox row.
   */
  nextMappedVersion(entryId: string, baseVersion: number): number | null {
    const row = this.db.prepare(
      'SELECT MIN(version) AS version FROM formal_map WHERE entry_id = ? AND version > ? AND provider_id IS NOT NULL',
    ).get(entryId, baseVersion) as { version: number | null } | undefined;
    const version = row?.version ?? null;
    return version === null ? null : Number(version);
  }

  /**
   * Provider id already recorded for this exact body, under any version. The origin machine
   * writes the Provider before the remote assigns a version, so the same publication can be
   * filed under different version numbers on the way out and back.
   */
  formalProviderIdByHash(entryId: string, contentHash: string): string | null {
    const row = this.db.prepare(
      "SELECT provider_id FROM formal_map WHERE entry_id = ? AND content_hash = ? AND provider_id IS NOT NULL ORDER BY version DESC LIMIT 1",
    ).get(entryId, contentHash) as { provider_id: string | null } | undefined;
    return row?.provider_id ?? null;
  }

  formalMap(entryId: string): FormalMapRow[] {
    const rows = this.db.prepare('SELECT entry_id, version, provider_id, content_hash, state, applied_at FROM formal_map WHERE entry_id = ? ORDER BY version ASC').all(entryId) as unknown as MapDbRow[];
    return rows.map((row) => ({ entryId: row.entry_id, version: row.version, providerId: row.provider_id, contentHash: row.content_hash, state: row.state as FormalMapRow['state'], appliedAt: row.applied_at }));
  }

  /** Enabled, non-withdrawn rules; every rule applies to every session. */
  rulesFor(): LocalRuleRow[] {
    const rows = this.db.prepare(`
      SELECT entry_id, body, enabled, version, withdrawn_at FROM runtime_rules
      WHERE withdrawn_at IS NULL AND enabled = 1
      ORDER BY version ASC
    `).all() as unknown as RuleDbRow[];
    return rows.map((row) => ({ entryId: row.entry_id, body: row.body, enabled: row.enabled === 1, version: row.version, withdrawnAt: row.withdrawn_at }));
  }

  /** Every rule, disabled included: operator listing and budget checks need them. */
  allRules(): LocalRuleRow[] {
    const rows = this.db.prepare(`
      SELECT entry_id, body, enabled, version, withdrawn_at FROM runtime_rules
      WHERE withdrawn_at IS NULL
      ORDER BY version ASC
    `).all() as unknown as RuleDbRow[];
    return rows.map((row) => ({ entryId: row.entry_id, body: row.body, enabled: row.enabled === 1, version: row.version, withdrawnAt: row.withdrawn_at }));
  }

  /** Every live rule; the memory page lists them without narrowing. */
  everyRule(): LocalRuleRow[] {
    return this.allRules();
  }

  rule(entryId: string): LocalRuleRow | null {
    const row = this.db.prepare('SELECT entry_id, body, enabled, version, withdrawn_at FROM runtime_rules WHERE entry_id = ?').get(entryId) as RuleDbRow | undefined;
    return row ? { entryId: row.entry_id, body: row.body, enabled: row.enabled === 1, version: row.version, withdrawnAt: row.withdrawn_at } : null;
  }

  archive(entryId: string): LocalArchiveRow | null {
    const row = this.db.prepare('SELECT entry_id, project_id, title, body, source, verification, evidence, version, withdrawn_at FROM project_archives WHERE entry_id = ?').get(entryId) as ArchiveDbRow | undefined;
    return row ? { entryId: row.entry_id, projectId: row.project_id, title: row.title, body: row.body, source: row.source, verification: row.verification as LocalArchiveRow['verification'], evidence: row.evidence, version: row.version, withdrawnAt: row.withdrawn_at } : null;
  }

  archivesFor(projectId: string, includeWithdrawn = false): LocalArchiveRow[] {
    const rows = this.db.prepare(`
      SELECT entry_id, project_id, title, body, source, verification, evidence, version, withdrawn_at FROM project_archives
      WHERE project_id = ? ${includeWithdrawn ? '' : 'AND withdrawn_at IS NULL'}
      ORDER BY updated_at DESC
    `).all(projectId) as unknown as ArchiveDbRow[];
    return rows.map((row) => ({ entryId: row.entry_id, projectId: row.project_id, title: row.title, body: row.body, source: row.source, verification: row.verification as LocalArchiveRow['verification'], evidence: row.evidence, version: row.version, withdrawnAt: row.withdrawn_at }));
  }

  /** Every archive across all projects, newest first. */
  allArchives(includeWithdrawn = false): LocalArchiveRow[] {
    const rows = this.db.prepare(`
      SELECT entry_id, project_id, title, body, source, verification, evidence, version, withdrawn_at FROM project_archives
      ${includeWithdrawn ? '' : 'WHERE withdrawn_at IS NULL'}
      ORDER BY project_id ASC, updated_at DESC
    `).all() as unknown as ArchiveDbRow[];
    return rows.map((row) => ({ entryId: row.entry_id, projectId: row.project_id, title: row.title, body: row.body, source: row.source, verification: row.verification as LocalArchiveRow['verification'], evidence: row.evidence, version: row.version, withdrawnAt: row.withdrawn_at }));
  }

  /** Append what one injection delivered; the newest row is the operator view. */
  recordInjection(report: InjectionReportRecord): void {
    this.transaction(() => {
      this.db.prepare('INSERT INTO runtime_injections(id, host_id, session_id, outcome_json, created_ms) VALUES(?, ?, ?, ?, ?)')
        .run(report.id, report.hostId, report.sessionId, JSON.stringify(report), Date.parse(report.createdAt));
    });
  }

  /** Newest injection report; a host narrows it to its own rows through `hostId`. */
  lastInjection(hostId?: string, sessionId?: string): InjectionReportRecord | null {
    const clauses: string[] = [];
    const values: string[] = [];
    if (hostId !== undefined) { clauses.push('host_id = ?'); values.push(hostId); }
    if (sessionId !== undefined) { clauses.push('session_id = ?'); values.push(sessionId); }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    const row = this.db.prepare(`SELECT outcome_json FROM runtime_injections${where} ORDER BY created_ms DESC LIMIT 1`).get(...values) as { outcome_json: string } | undefined;
    return row ? JSON.parse(row.outcome_json) as InjectionReportRecord : null;
  }
}
