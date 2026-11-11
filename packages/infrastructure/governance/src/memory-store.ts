import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { DiagnosticJob, MnemoWeaveError, RememberInput } from '../../../core/contracts/src/index.ts';
import type { DiagnosticJobRecord, InjectionReportRecord } from '../../../core/contracts/src/index.ts';
import type { FormalMapRow, LocalArchiveRow, LocalRuleRow, MemoryApplyStore, SyncedPublish } from '../../../core/application/src/sync-apply.ts';
import { archiveActiveBytes, archiveUsage, maintain, ruleUsage } from '../../../core/application/src/rules.ts';
import type { RuleArchiveRow, RuleLimits, RuleMaintenancePlan } from '../../../core/application/src/rules.ts';
import type { SqliteMemoryCatalog } from './catalog.ts';

/**
 * Local storage for the three memory classes (schema v16).
 *
 * Runtime rules and project archives live here as the working copy; the remote
 * keeps the confirmed version. Formal memories keep only this machine's mapping
 * from logical revision to the local Mnemon id — never the body, which stays
 * authoritative in Mnemon.
 */

type Transaction = <T>(operation: () => T) => T;

interface RuleDbRow {
  entry_id: string; body: string; enabled: number; version: number; withdrawn_at: string | null;
  importance: string; pinned: number; created_at: string; archived_at: string | null;
}

interface ArchiveDbRow {
  entry_id: string; project_id: string; title: string; body: string; source: string; verification: string;
  evidence: string; version: number; withdrawn_at: string | null; state: string; archived_at: string | null; updated_at: string;
}

interface ArchiveRevisionDbRow {
  revision_id: string; entry_id: string; project_id: string; version: number; title: string; body: string; source: string;
  verification: string; evidence: string; state: string; archived_at: string | null; recorded_at: string;
}

interface MapDbRow {
  entry_id: string; version: number; provider_id: string | null; content_hash: string; state: string; applied_at: string | null;
}

function ruleFrom(row: RuleDbRow): LocalRuleRow {
  return {
    entryId: row.entry_id, body: row.body, enabled: row.enabled === 1, version: row.version,
    withdrawnAt: row.withdrawn_at, importance: row.importance as LocalRuleRow['importance'],
    pinned: row.pinned === 1, createdAt: row.created_at,
  };
}

function archiveFrom(row: ArchiveDbRow): LocalArchiveRow {
  return {
    entryId: row.entry_id, projectId: row.project_id, title: row.title, body: row.body,
    source: row.source, verification: row.verification as LocalArchiveRow['verification'],
    evidence: row.evidence, version: row.version, withdrawnAt: row.withdrawn_at,
    state: row.state as LocalArchiveRow['state'], archivedAt: row.archived_at, updatedAt: row.updated_at,
  };
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

  /** Durable maintenance job: the latest row of one kind, running or settled. */
  diagnosticJob(kind: string): DiagnosticJobRecord | undefined {
    const row = this.db.prepare('SELECT * FROM diagnostic_jobs WHERE kind=? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(kind);
    return row === undefined ? undefined : DiagnosticJob.parse({
      id: row['id'], kind: row['kind'], state: row['state'], startedAt: row['started_at'],
      finishedAt: row['finished_at'] ?? null, detail: JSON.parse(String(row['detail_json'] ?? '{}')),
    });
  }

  /** Start one job of a kind; a kind already running is refused rather than queued. */
  beginDiagnosticJob(kind: string): DiagnosticJobRecord {
    return this.transaction(() => {
      const running = this.db.prepare("SELECT id FROM diagnostic_jobs WHERE kind=? AND state='running'").get(kind);
      if (running !== undefined) throw new MnemoWeaveError('INVALID_STATE');
      const id = randomUUID();
      this.db.prepare('INSERT INTO diagnostic_jobs(id,kind,state,started_at,finished_at,detail_json) VALUES(?,?,?,?,?,?)')
        .run(id, kind, 'running', new Date().toISOString(), null, '{}');
      return this.diagnosticJob(kind)!;
    });
  }

  finishDiagnosticJob(id: string, state: 'succeeded' | 'failed' | 'interrupted', detail: Record<string, unknown>): void {
    this.db.prepare('UPDATE diagnostic_jobs SET state=?, finished_at=?, detail_json=? WHERE id=?')
      .run(state, new Date().toISOString(), JSON.stringify(detail), id);
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
      ...(input.projectId === null ? {} : { projectId: input.projectId }),
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

  private persistRule(row: LocalRuleRow, at: string): void {
    this.db.prepare(`
      INSERT INTO runtime_rules(entry_id, body, scope, project_id, enabled, version, withdrawn_at, updated_at, importance, pinned, created_at, archived_at)
      VALUES(?, ?, 'global', NULL, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(entry_id) DO UPDATE SET body=excluded.body, scope=excluded.scope, project_id=excluded.project_id,
        enabled=excluded.enabled, version=excluded.version, withdrawn_at=excluded.withdrawn_at, updated_at=excluded.updated_at,
        importance=excluded.importance, pinned=excluded.pinned, archived_at=NULL
    `).run(row.entryId, row.body, row.enabled ? 1 : 0, row.version, row.withdrawnAt, at, row.importance ?? 'normal', row.pinned === true ? 1 : 0, row.createdAt ?? at);
  }

  upsertRule(row: LocalRuleRow, at: string): void {
    this.transaction(() => this.persistRule(row, at));
  }

  /** Apply a synced rule and archive lower-priority entries when the active set is full. */
  applyRuleWithCapacity(row: LocalRuleRow, at: string, limits: RuleLimits): RuleArchiveRow[] {
    return this.transaction(() => {
      const existing = this.allRules();
      const others = existing.filter(entry => entry.entryId !== row.entryId);
      const plan = maintain([...others, { ...row, createdAt: row.createdAt ?? at }], row.entryId, limits, at);
      this.persistRulePlan(plan, at);
      return plan.archived;
    });
  }

  private persistRulePlan(plan: RuleMaintenancePlan, at: string): void {
    for (const row of plan.active) this.persistRule(row, at);
    for (const archived of plan.archived) {
      this.db.prepare('UPDATE runtime_rules SET archived_at = ?, updated_at = ? WHERE entry_id = ?').run(archived.archivedAt, at, archived.ruleId);
      this.db.prepare(`
        INSERT OR IGNORE INTO runtime_rule_archive(archive_id, rule_id, rule_version, body, importance, pinned, archived_at, reason)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      `).run(archived.archiveId, archived.ruleId, archived.ruleVersion, archived.body, archived.importance, archived.pinned ? 1 : 0, archived.archivedAt, archived.reason);
    }
  }

  /** Persist a planned human write, including rules the maintenance pass moved out. */
  saveRulePlan(plan: RuleMaintenancePlan, at: string): void {
    this.transaction(() => this.persistRulePlan(plan, at));
  }

  withdrawRule(entryId: string, at: string): void {
    this.transaction(() => {
      this.db.prepare('UPDATE runtime_rules SET withdrawn_at = ?, enabled = 0, updated_at = ? WHERE entry_id = ?').run(at, at, entryId);
    });
  }

  /** Exact archived rule rows, newest first. */
  ruleArchive(): RuleArchiveRow[] {
    const rows = this.db.prepare(`
      SELECT archive_id, rule_id, rule_version, body, importance, pinned, archived_at, reason
      FROM runtime_rule_archive ORDER BY archived_at DESC
    `).all() as unknown as Array<Record<string, unknown>>;
    return rows.map(row => ({
      archiveId: String(row['archive_id']), ruleId: String(row['rule_id']), ruleVersion: Number(row['rule_version']),
      body: String(row['body']), importance: String(row['importance']) as RuleArchiveRow['importance'],
      pinned: Number(row['pinned']) === 1, archivedAt: String(row['archived_at']), reason: String(row['reason']) as RuleArchiveRow['reason'],
    }));
  }

  private recordArchiveRevision(row: LocalArchiveRow, at: string): void {
    this.db.prepare(`
      INSERT INTO project_archive_revisions(revision_id, entry_id, version, project_id, title, body, source, verification, evidence, state, archived_at, recorded_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entry_id, version) DO UPDATE SET
        state=excluded.state, archived_at=excluded.archived_at, recorded_at=excluded.recorded_at
    `).run(randomUUID(), row.entryId, row.version, row.projectId, row.title, row.body, row.source, row.verification, row.evidence, row.state ?? 'active', row.archivedAt ?? null, at);
  }

  upsertArchive(row: LocalArchiveRow, at: string): void {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO project_archives(entry_id, project_id, title, body, source, verification, evidence, version, withdrawn_at, updated_at, state, archived_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entry_id) DO UPDATE SET project_id=excluded.project_id, title=excluded.title, body=excluded.body,
          source=excluded.source, verification=excluded.verification, evidence=excluded.evidence, version=excluded.version,
          withdrawn_at=excluded.withdrawn_at, updated_at=excluded.updated_at, state=excluded.state, archived_at=excluded.archived_at
      `).run(row.entryId, row.projectId, row.title, row.body, row.source, row.verification, row.evidence, row.version, row.withdrawnAt, at, row.state ?? 'active', row.archivedAt ?? null);
      this.recordArchiveRevision(row, at);
    });
  }

  /**
   * Apply a synced archive. If the incoming body does not fit, least-recently-updated active
   * archives of that project are archived locally until it does; the incoming text is never
   * dropped. The local archive keeps every body and version.
   */
  applyArchiveWithCapacity(row: LocalArchiveRow, at: string, limitBytes: number): LocalArchiveRow[] {
    return this.transaction(() => {
      const projectRows = this.archivesFor(row.projectId, true);
      const others = projectRows.filter(entry => entry.entryId !== row.entryId);
      const activeOthers = others.filter(entry => entry.state !== 'archived');
      if (row.state !== 'archived' && archiveActiveBytes(activeOthers) + Buffer.byteLength(row.body, 'utf8') > limitBytes) {
        const archived: LocalArchiveRow[] = [];
        let used = archiveActiveBytes(activeOthers);
        const candidates = activeOthers
          .slice()
          .sort((left, right) => (left.updatedAt ?? '').localeCompare(right.updatedAt ?? '') || left.entryId.localeCompare(right.entryId));
        for (const candidate of candidates) {
          if (used + Buffer.byteLength(row.body, 'utf8') <= limitBytes) break;
          const next: LocalArchiveRow = { ...candidate, state: 'archived', archivedAt: at, updatedAt: at };
          this.upsertArchive(next, at);
          archived.push(next);
          used -= Buffer.byteLength(candidate.body, 'utf8');
        }
        this.upsertArchive(row, at);
        return archived;
      }
      this.upsertArchive(row, at);
      return [];
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

  formalProviderId(entryId: string, version: number): string | null {
    const row = this.db.prepare('SELECT provider_id FROM formal_map WHERE entry_id = ? AND version = ?').get(entryId, version) as { provider_id: string | null } | undefined;
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

  /** Enabled, non-withdrawn, non-archived rules; every rule applies to every session. */
  rulesFor(): LocalRuleRow[] {
    const rows = this.db.prepare(`
      SELECT entry_id, body, enabled, version, withdrawn_at, importance, pinned, created_at, archived_at FROM runtime_rules
      WHERE withdrawn_at IS NULL AND enabled = 1 AND archived_at IS NULL
      ORDER BY created_at ASC, entry_id ASC
    `).all() as unknown as RuleDbRow[];
    return rows.map(ruleFrom);
  }

  /** Every non-archived rule, disabled included: operator listing and budget checks need them. */
  allRules(): LocalRuleRow[] {
    const rows = this.db.prepare(`
      SELECT entry_id, body, enabled, version, withdrawn_at, importance, pinned, created_at, archived_at FROM runtime_rules
      WHERE withdrawn_at IS NULL AND archived_at IS NULL
      ORDER BY created_at ASC, entry_id ASC
    `).all() as unknown as RuleDbRow[];
    return rows.map(ruleFrom);
  }

  /** Every rule still in the active set, disabled included: the operator list shows them. */
  everyRule(): LocalRuleRow[] {
    const rows = this.db.prepare(`
      SELECT entry_id, body, enabled, version, withdrawn_at, importance, pinned, created_at, archived_at FROM runtime_rules
      WHERE withdrawn_at IS NULL AND archived_at IS NULL
      ORDER BY created_at ASC, entry_id ASC
    `).all() as unknown as RuleDbRow[];
    return rows.map(ruleFrom);
  }

  rule(entryId: string): LocalRuleRow | null {
    const row = this.db.prepare('SELECT entry_id, body, enabled, version, withdrawn_at, importance, pinned, created_at, archived_at FROM runtime_rules WHERE entry_id = ? AND withdrawn_at IS NULL AND archived_at IS NULL').get(entryId) as RuleDbRow | undefined;
    return row ? ruleFrom(row) : null;
  }

  ruleUsage(limits?: RuleLimits) { return ruleUsage(this.allRules(), limits); }

  archive(entryId: string): LocalArchiveRow | null {
    const row = this.db.prepare('SELECT entry_id, project_id, title, body, source, verification, evidence, version, withdrawn_at, state, archived_at, updated_at FROM project_archives WHERE entry_id = ?').get(entryId) as ArchiveDbRow | undefined;
    return row ? archiveFrom(row) : null;
  }

  archivesFor(projectId: string, includeWithdrawn = false): LocalArchiveRow[] {
    const rows = this.db.prepare(`
      SELECT entry_id, project_id, title, body, source, verification, evidence, version, withdrawn_at, state, archived_at, updated_at FROM project_archives
      WHERE project_id = ? ${includeWithdrawn ? '' : 'AND withdrawn_at IS NULL'}
      ORDER BY updated_at DESC
    `).all(projectId) as unknown as ArchiveDbRow[];
    return rows.map(archiveFrom);
  }

  /** Every archive across all projects, newest first. */
  allArchives(includeWithdrawn = false): LocalArchiveRow[] {
    const rows = this.db.prepare(`
      SELECT entry_id, project_id, title, body, source, verification, evidence, version, withdrawn_at, state, archived_at, updated_at FROM project_archives
      ${includeWithdrawn ? '' : 'WHERE withdrawn_at IS NULL'}
      ORDER BY project_id ASC, updated_at DESC
    `).all() as unknown as ArchiveDbRow[];
    return rows.map(archiveFrom);
  }

  archiveUsage(projectId: string, limitBytes?: number) { return archiveUsage(projectId, this.archivesFor(projectId, true), limitBytes); }

  /** Search metadata without loading every body; the caller bounds excerpts and totals. */
  searchArchives(projectId: string, query: string, includeArchived = false): LocalArchiveRow[] {
    return this.archivesFor(projectId, false)
      .filter(entry => includeArchived || entry.state !== 'archived')
      .filter(entry => entry.title.toLowerCase().includes(query.toLowerCase())
        || entry.body.toLowerCase().includes(query.toLowerCase())
        || entry.evidence.toLowerCase().includes(query.toLowerCase()))
      .sort((left, right) => {
        const title = Number(right.title.toLowerCase().includes(query.toLowerCase())) - Number(left.title.toLowerCase().includes(query.toLowerCase()));
        if (title !== 0) return title;
        return (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '');
      });
  }

  archiveHistory(entryId: string): ArchiveRevisionDbRow[] {
    const rows = this.db.prepare(`
      SELECT revision_id, entry_id, project_id, version, title, body, source, verification, evidence, state, archived_at, recorded_at
      FROM project_archive_revisions WHERE entry_id = ? ORDER BY version DESC
    `).all(entryId) as unknown as ArchiveRevisionDbRow[];
    return rows;
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
