import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { DiagnosticJob, MnemoWeaveError, RememberInput } from '../../../core/contracts/src/index.ts';
import type { DiagnosticJobRecord, InjectionReportRecord } from '../../../core/contracts/src/index.ts';
import type { FormalMapRow, LocalArchiveRow, LocalRuleRow, MemoryApplyStore, SyncedPublish } from '../../../core/application/src/sync-apply.ts';
import { archiveActiveBytes, archiveUsage, ruleUsage } from '../../../core/application/src/rules.ts';
import type { RuleArchiveRow, RuleLimits } from '../../../core/application/src/rules.ts';
import type { SqliteMemoryCatalog } from './catalog.ts';

/**
 * Local storage for the three memory classes.
 *
 * Rules and workspace archives live here as the working copy; the remote keeps the confirmed
 * version. Formal memories keep only this machine's mapping from logical revision to the local
 * Mnemon id — never the body, which stays authoritative in Mnemon.
 */

type Transaction = <T>(operation: () => T) => T;

interface RuleDbRow {
  entry_id: string; body: string; enabled: number; version: number; withdrawn_at: string | null;
  importance: string; pinned: number; created_at: string; archived_at: string | null;
}

interface ArchiveDbRow {
  entry_id: string; workspace_id: string; title: string; body: string; source: string; verification: string;
  evidence: string; version: number; withdrawn_at: string | null; state: string; archived_at: string | null; updated_at: string;
}

interface ArchiveRevisionDbRow {
  revision_id: string; entry_id: string; workspace_id: string; version: number; title: string; body: string; source: string;
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
    entryId: row.entry_id, workspaceId: row.workspace_id, title: row.title, body: row.body,
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

  stageSnapshot() {
    const changes: Array<() => void> = [];
    const maps = new Map<string, FormalMapRow>();
    const rules = new Map<string, LocalRuleRow>();
    const withdrawnRules = new Set<string>();
    let ruleLimits: RuleLimits | undefined;
    const store: MemoryApplyStore = {
      upsertRule: (row, at) => changes.push(() => this.upsertRule(row, at)),
      withdrawRule: (entryId, at) => {
        withdrawnRules.add(entryId);
        rules.delete(entryId);
        changes.push(() => this.withdrawRule(entryId, at));
      },
      upsertArchive: (row, at) => changes.push(() => this.upsertArchive(row, at)),
      withdrawArchive: (entryId, at) => changes.push(() => this.withdrawArchive(entryId, at)),
      upsertFormalMap: (row, at) => {
        maps.set(`${row.entryId}:${row.version}`, row);
        changes.push(() => this.upsertFormalMap(row, at));
      },
      formalProviderId: (entryId, version) => {
        const pending = maps.get(`${entryId}:${version}`);
        return pending ? pending.providerId : this.formalProviderId(entryId, version);
      },
      formalProviderIdByHash: (entryId, hash) =>
        [...maps.values()].find(row => row.entryId === entryId && row.contentHash === hash && row.providerId)?.providerId
          ?? this.formalProviderIdByHash(entryId, hash),
      setEntryVersion: (entryId, version, at) => changes.push(() => this.setEntryVersion(entryId, version, at)),
      publishSynced: input => changes.push(() => this.publishSynced(input)),
      retireSynced: memoryId => changes.push(() => this.retireSynced(memoryId)),
      applyRuleWithCapacity: (row, at, limits) => {
        rules.set(row.entryId, row);
        withdrawnRules.delete(row.entryId);
        ruleLimits = limits;
        changes.push(() => this.upsertRule(row, at));
      },
    };
    return {
      store,
      commit: (finish: () => void): void => this.transaction(() => {
        if (ruleLimits) {
          const merged = this.allRules().filter(row => !rules.has(row.entryId) && !withdrawnRules.has(row.entryId));
          if (ruleUsage([...merged, ...rules.values()], ruleLimits).exceeded) {
            throw new MnemoWeaveError('RULE_CAPACITY_EXCEEDED');
          }
        }
        for (const change of changes) change();
        finish();
      }),
    };
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
   * The most recent jobs of one kind, newest first.
   *
   * A failed or interrupted run is history the page must be able to show: it explains why a
   * coverage number did not move and whether a restart cut the work short.
   */
  diagnosticJobs(kind: string, limit: number): DiagnosticJobRecord[] {
    return this.db.prepare('SELECT * FROM diagnostic_jobs WHERE kind=? ORDER BY started_at DESC, rowid DESC LIMIT ?')
      .all(kind, limit).map(row => DiagnosticJob.parse({
        id: row['id'], kind: row['kind'], state: row['state'], startedAt: row['started_at'],
        finishedAt: row['finished_at'] ?? null, detail: JSON.parse(String(row['detail_json'] ?? '{}')),
      }));
  }

  /**
   * A synced formal revision becomes a local catalog revision, so the memory is visible and
   * editable on this machine. Provenance records that it arrived by sync.
   */
  publishSynced(input: SyncedPublish): void {
    if (!this.catalog) return;
    const request = RememberInput.parse({
      idempotencyKey: `sync-${input.entryId.slice(0, 8)}-${input.version}`,
      content: input.content,
      tags: input.tags,
      provenance: {
        source: 'sync',
        sourceReference: `mnemoweave:${input.entryId}:${input.version}`,
      },
    });
    this.catalog.publishSynced(input.entryId, request, input.providerId, input.contentHash, input.at, 'sync', `synced revision ${input.version}`, {
      category: input.category,
      ...(input.importance === undefined ? {} : { importance: input.importance }),
      tags: input.tags,
      ...(input.entities === undefined ? {} : { entities: input.entities }),
    }, input.version);
  }

  retireSynced(memoryId: string): void {
    this.catalog?.retireSynced(memoryId);
  }

  private persistRule(row: LocalRuleRow, at: string): void {
    this.db.prepare(`
      INSERT INTO runtime_rules(entry_id, body, scope, project_id, enabled, version, withdrawn_at, updated_at, importance, pinned, created_at, archived_at)
      VALUES(?, ?, 'global', NULL, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(entry_id) DO UPDATE SET body=excluded.body, scope='global', project_id=NULL,
        enabled=excluded.enabled, version=excluded.version, withdrawn_at=excluded.withdrawn_at, updated_at=excluded.updated_at,
        importance=excluded.importance, pinned=excluded.pinned, archived_at=NULL
    `).run(row.entryId, row.body, row.enabled ? 1 : 0, row.version, row.withdrawnAt, at, row.importance ?? 'normal', row.pinned === true ? 1 : 0, row.createdAt ?? at);
  }

  upsertRule(row: LocalRuleRow, at: string): void {
    this.transaction(() => this.persistRule(row, at));
  }

  /**
   * Apply a synced rule. An inbound set that exceeds capacity is refused, not trimmed: local
   * capacity maintenance is gone, so an over-capacity set is a protocol error to report rather
   * than text to silently drop.
   */
  applyRuleWithCapacity(row: LocalRuleRow, at: string, limits: RuleLimits): void {
    this.transaction(() => {
      const before = this.allRules();
      const merged = [...before.filter(entry => entry.entryId !== row.entryId), { ...row, createdAt: row.createdAt ?? at }];
      const usage = ruleUsage(merged, limits);
      if (usage.exceeded && usage.usedBytes >= ruleUsage(before, limits).usedBytes) throw new MnemoWeaveError('RULE_CAPACITY_EXCEEDED');
      this.persistRule({ ...row, createdAt: row.createdAt ?? at }, at);
    });
  }

  /** Persist one user write: the rule row only; capacity is checked before this is called. */
  saveRule(row: LocalRuleRow, at: string): void {
    this.transaction(() => this.persistRule(row, at));
  }

  withdrawRule(entryId: string, at: string): void {
    this.transaction(() => {
      this.db.prepare('UPDATE runtime_rules SET withdrawn_at = ?, enabled = 0, updated_at = ? WHERE entry_id = ?').run(at, at, entryId);
    });
  }

  /** Exact rule rows taken out of the resident set, newest first. */
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

  /** Keep the exact text of a rule that left the resident set, so history stays readable. */
  private recordArchiveRevision(row: LocalArchiveRow, at: string, revisionId: string): void {
    this.db.prepare(`
      INSERT INTO project_archive_revisions(revision_id, entry_id, version, workspace_id, title, body, source, verification, evidence, state, archived_at, recorded_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entry_id, version) DO UPDATE SET
        state=excluded.state, archived_at=excluded.archived_at, recorded_at=excluded.recorded_at
    `).run(revisionId, row.entryId, row.version, row.workspaceId, row.title, row.body, row.source, row.verification, row.evidence, row.state ?? 'active', row.archivedAt ?? null, at);
  }

  upsertArchive(row: LocalArchiveRow, at: string, revisionId: string = randomUUID()): void {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO project_archives(entry_id, workspace_id, title, body, source, verification, evidence, version, withdrawn_at, updated_at, state, archived_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entry_id) DO UPDATE SET workspace_id=excluded.workspace_id, title=excluded.title, body=excluded.body,
          source=excluded.source, verification=excluded.verification, evidence=excluded.evidence, version=excluded.version,
          withdrawn_at=excluded.withdrawn_at, updated_at=excluded.updated_at, state=excluded.state, archived_at=excluded.archived_at
      `).run(row.entryId, row.workspaceId, row.title, row.body, row.source, row.verification, row.evidence, row.version, row.withdrawnAt, at, row.state ?? 'active', row.archivedAt ?? null);
      this.recordArchiveRevision(row, at, revisionId);
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
   * A synced write is only successful once its revision has a local Provider mapping, so this is
   * what an edit checks instead of trusting a possibly-dropped inbox row.
   */
  nextMappedVersion(entryId: string, baseVersion: number): number | null {
    const row = this.db.prepare(
      'SELECT MIN(version) AS version FROM formal_map WHERE entry_id = ? AND version > ? AND provider_id IS NOT NULL',
    ).get(entryId, baseVersion) as { version: number | null } | undefined;
    const version = row?.version ?? null;
    return version === null ? null : Number(version);
  }

  /**
   * Provider id already recorded for this exact body, under any version. The origin machine writes
   * the Provider before the remote assigns a version, so the same publication can be filed under
   * different version numbers on the way out and back.
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

  /** Enabled, non-withdrawn rules; every rule applies to every session and is injected whole. */
  rulesFor(): LocalRuleRow[] {
    const rows = this.db.prepare(`
      SELECT entry_id, body, enabled, version, withdrawn_at, importance, pinned, created_at, archived_at FROM runtime_rules
      WHERE withdrawn_at IS NULL AND enabled = 1 AND archived_at IS NULL
      ORDER BY created_at ASC, entry_id ASC
    `).all() as unknown as RuleDbRow[];
    return rows.map(ruleFrom);
  }

  /** Every resident rule, disabled included: listing and the capacity check need them. */
  allRules(): LocalRuleRow[] {
    const rows = this.db.prepare(`
      SELECT entry_id, body, enabled, version, withdrawn_at, importance, pinned, created_at, archived_at FROM runtime_rules
      WHERE withdrawn_at IS NULL AND archived_at IS NULL
      ORDER BY created_at ASC, entry_id ASC
    `).all() as unknown as RuleDbRow[];
    return rows.map(ruleFrom);
  }

  everyRule(): LocalRuleRow[] { return this.allRules(); }

  rule(entryId: string): LocalRuleRow | null {
    const row = this.db.prepare('SELECT entry_id, body, enabled, version, withdrawn_at, importance, pinned, created_at, archived_at FROM runtime_rules WHERE entry_id = ? AND withdrawn_at IS NULL AND archived_at IS NULL').get(entryId) as RuleDbRow | undefined;
    return row ? ruleFrom(row) : null;
  }

  ruleUsage(limits?: RuleLimits) { return ruleUsage(this.allRules(), limits); }

  archive(entryId: string): LocalArchiveRow | null {
    const row = this.db.prepare('SELECT entry_id, workspace_id, title, body, source, verification, evidence, version, withdrawn_at, state, archived_at, updated_at FROM project_archives WHERE entry_id = ?').get(entryId) as ArchiveDbRow | undefined;
    return row ? archiveFrom(row) : null;
  }

  archivesFor(workspaceId: string, includeWithdrawn = false): LocalArchiveRow[] {
    const rows = this.db.prepare(`
      SELECT entry_id, workspace_id, title, body, source, verification, evidence, version, withdrawn_at, state, archived_at, updated_at FROM project_archives
      WHERE workspace_id = ? ${includeWithdrawn ? '' : 'AND withdrawn_at IS NULL'}
      ORDER BY updated_at DESC
    `).all(workspaceId) as unknown as ArchiveDbRow[];
    return rows.map(archiveFrom);
  }

  /** Every archive across all workspaces, grouped by workspace then newest first. */
  allArchives(includeWithdrawn = false): LocalArchiveRow[] {
    const rows = this.db.prepare(`
      SELECT entry_id, workspace_id, title, body, source, verification, evidence, version, withdrawn_at, state, archived_at, updated_at FROM project_archives
      ${includeWithdrawn ? '' : 'WHERE withdrawn_at IS NULL'}
      ORDER BY workspace_id ASC, updated_at DESC
    `).all() as unknown as ArchiveDbRow[];
    return rows.map(archiveFrom);
  }

  archiveUsage(workspaceId: string, limitBytes?: number) { return archiveUsage(workspaceId, this.archivesFor(workspaceId, true), limitBytes); }

  /** Search metadata without loading every body; the caller bounds excerpts and totals. */
  searchArchives(workspaceId: string, query: string, includeArchived = false): LocalArchiveRow[] {
    return this.archivesFor(workspaceId, false)
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

  archiveRevisionById(revisionId: string): ArchiveRevisionDbRow | undefined {
    return this.db.prepare('SELECT * FROM project_archive_revisions WHERE revision_id=?').get(revisionId) as ArchiveRevisionDbRow | undefined;
  }

  archiveHistory(entryId: string): ArchiveRevisionDbRow[] {
    return this.db.prepare(`
      SELECT revision_id, entry_id, workspace_id, version, title, body, source, verification, evidence, state, archived_at, recorded_at
      FROM project_archive_revisions WHERE entry_id = ? ORDER BY version DESC
    `).all(entryId) as unknown as ArchiveRevisionDbRow[];
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
