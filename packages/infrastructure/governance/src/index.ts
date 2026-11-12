import { SqliteTurnStore } from './turn-store.ts';
import { SqliteSyncLedger } from './sync-ledger.ts';
import { SqliteMemoryStore } from './memory-store.ts';
import { SqliteDistillationStore, SqliteEvidenceStore, SqliteWorkspaceStore, SqliteWriteTaskStore } from './workspace-store.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { CandidateRepository } from '../../../core/application/src/index.ts';
import { Candidate, CandidateRequest, FORMAL_STREAM, MnemoWeaveError, RememberInput } from '../../../core/contracts/src/index.ts';
import type { CandidateRecord, LegacyWorkspaceMapValue, RememberRequest, RetentionSweepReport } from '../../../core/contracts/src/index.ts';
import { CANDIDATE_BODY_RETENTION_DAYS } from './events.ts';

export * from './sync-ledger.ts';
export * from './memory-store.ts';

const DAY_MS = 86_400_000;
/** Larger candidate bodies live in content-addressed files; metadata stays in SQLite. */
const BLOB_THRESHOLD_BYTES = 4096;
const BLOB_ORPHAN_GRACE_MS = 3_600_000;
import type { Assessment } from '../../../core/contracts/src/index.ts';
import type { WorkflowRepository, ReviewDecision, Job, WriteResult } from '../../../core/application/src/workflow-ports.ts';
import { SqliteMemoryCatalog } from './catalog.ts';
import { SessionEventStore } from './events.ts';
import type { VersionCheckpoint } from '../../../core/application/src/version-ports.ts';
import type {ConflictResolutionRequest} from '../../../core/contracts/src/index.ts';

/** A formal memory that has just been published from a reviewed candidate. */
export interface PublishedFormal {
  memoryId: string;
  providerId: string;
  version: number;
  content: string;
  contentHash: string;
  /** Formal memories share one stream; the field stays so a publication names where it goes. */
  stream: string;
}

/** Incremental governance schema v1. No formal memory, Revision or replica schema. */
export class SqliteCandidates implements CandidateRepository, WorkflowRepository {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;
  private readonly shareEnabled: boolean;
  private readonly blobsDir: string;
  private readonly quotaSoftBytes: number | undefined;
  private readonly quotaHardBytes: number | undefined;
  private quotaSoftLogged = false;
  private transactionDepth = 0;
  readonly catalog: SqliteMemoryCatalog;
  readonly events: SessionEventStore;
  readonly turns: SqliteTurnStore;
  readonly ledger: SqliteSyncLedger;
  readonly memory: SqliteMemoryStore;
  readonly workspaces: SqliteWorkspaceStore;
  readonly writeTasks: SqliteWriteTaskStore;
  readonly distillations: SqliteDistillationStore;
  readonly evidence: SqliteEvidenceStore;
  /**
   * Called after a reviewed publication commits, so the Server can offer the published
   * memory to shared sync. The catalog's `syncHook` is an internal change stream, not a
   * publish notification: nothing set it, so an approved candidate never reached the other
   * machines. Registered once at composition time; it runs after the transaction commits
   * and is never allowed to fail the publication.
   */
  private publishListener: ((event: PublishedFormal) => void) | undefined;
  setPublishListener(listener: ((event: PublishedFormal) => void) | undefined): void { this.publishListener = listener; }
  private announcePublished(memoryId: string, providerId: string, version: number, content: string, contentHash: string, stream: string): void {
    if (!this.publishListener) return;
    try { this.publishListener({ memoryId, providerId, version, content, contentHash, stream }); }
    catch { process.stderr.write(JSON.stringify({ event: 'publish_listener_failed', memoryId }) + String.fromCharCode(10)); }
  }
  /** Ordered change stream (internal audit only): catalog mutations append here in the same transaction. */
  constructor(path: string, quota: { softBytes?: number; hardBytes?: number; legacyWorkspaces?: LegacyWorkspaceMapValue; shareEnabled?: boolean } = {}) {
    if (!isAbsolute(path)) throw new Error('Governance database path must be absolute');
    if (quota.softBytes !== undefined && quota.hardBytes !== undefined && quota.softBytes >= quota.hardBytes) throw new Error('Quota soft limit must be below the hard limit');
    this.dbPath = path;
    this.shareEnabled = quota.shareEnabled ?? true;
    this.blobsDir = join(dirname(path), 'blobs');
    mkdirSync(this.blobsDir, { recursive: true });
    this.quotaSoftBytes = quota.softBytes;
    this.quotaHardBytes = quota.hardBytes;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.transaction(() => {
        const version = Number(this.db.prepare('PRAGMA user_version').get()!['user_version']);
      if (version > 23) throw new Error('Unsupported governance schema version');
        if (version === 0) {
          if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()) throw new Error('Refusing to initialize an unidentified existing database');
          this.db.exec(`
            CREATE TABLE governance_candidates (
              id TEXT PRIMARY KEY,
              idempotency_key TEXT NOT NULL UNIQUE,
              request_hash TEXT NOT NULL,
              request_json TEXT NOT NULL,
              status TEXT NOT NULL CHECK(status='pending_review'),
              submitted_at TEXT NOT NULL
            ) STRICT;
            CREATE TABLE governance_submission_receipts (
              id TEXT PRIMARY KEY,
              candidate_id TEXT NOT NULL UNIQUE REFERENCES governance_candidates(id),
              status TEXT NOT NULL CHECK(status='candidate')
            ) STRICT;
            PRAGMA user_version=1;
          `);
        } else {
          // Validate ownership before changing any persistent database settings.
          this.db.prepare(`SELECT c.id, c.idempotency_key, c.request_hash, c.request_json,
            c.status, c.submitted_at, r.id, r.status FROM governance_candidates c
            JOIN governance_submission_receipts r ON r.candidate_id=c.id LIMIT 0`).all();
        }
      });
      if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) === 1) {
        // VACUUM INTO uses SQLite's consistent snapshot, including committed WAL pages.
        const destination = `${path}.pre-v2.${randomUUID()}.db`;
        this.db.prepare('VACUUM INTO ?').run(destination);
        this.transaction(() => {
          if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) !== 1) return;
          this.db.exec(`
            CREATE TABLE governance_lifecycle(candidate_id TEXT PRIMARY KEY REFERENCES governance_candidates(id), status TEXT NOT NULL);
            CREATE TABLE governance_reviews(id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES governance_candidates(id), decision TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL, assessment_json TEXT, created_at TEXT NOT NULL);
            CREATE TABLE governance_review_tasks(id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL UNIQUE REFERENCES governance_candidates(id), kind TEXT NOT NULL, state TEXT NOT NULL);
            CREATE TABLE governance_tasks(id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL UNIQUE REFERENCES governance_candidates(id), write_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL, checkpoint TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER, owner TEXT);
            CREATE TABLE governance_outbox(id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES governance_tasks(id), state TEXT NOT NULL);
            CREATE TABLE governance_runs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES governance_tasks(id), state TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT);
            CREATE TABLE governance_execution_receipts(id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES governance_candidates(id), task_id TEXT NOT NULL REFERENCES governance_tasks(id), run_id TEXT NOT NULL REFERENCES governance_runs(id), result_json TEXT NOT NULL, created_at TEXT NOT NULL);
            CREATE TABLE governance_provider_binding(id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL);
            CREATE TABLE governance_workflow_lock(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, until_ms INTEGER NOT NULL);
            INSERT INTO governance_workflow_lock VALUES(1,NULL,0);
            PRAGMA user_version=2;
          `);
        });
      }
      this.catalog = new SqliteMemoryCatalog(this.db, path, operation => this.transaction(operation));
      if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) === 5) {
        const destination = `${path}.pre-v6.${randomUUID()}.db`;
        this.db.prepare('VACUUM INTO ?').run(destination);
        this.transaction(() => {
          if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) !== 5) return;
          this.db.exec(`
            ALTER TABLE governance_tasks ADD COLUMN first_failed_at INTEGER;
            ALTER TABLE governance_tasks ADD COLUMN alerted_at INTEGER;
            -- WP2 decision: the Outbox is an enqueue journal that advances with its Task;
            -- the mirror states (dispatching/failed/delivered) implied an independent dispatcher and are removed.
            CREATE TABLE governance_outbox_v6(id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES governance_tasks(id));
            INSERT INTO governance_outbox_v6(id, task_id) SELECT id, task_id FROM governance_outbox;
            DROP TABLE governance_outbox;
            ALTER TABLE governance_outbox_v6 RENAME TO governance_outbox;
            PRAGMA user_version=6;
          `);
        });
      }
      if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) === 6) {
        const destination = `${path}.pre-v7.${randomUUID()}.db`;
        this.db.prepare('VACUUM INTO ?').run(destination);
        this.transaction(() => {
          if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) !== 6) return;
          this.db.exec(`
            ALTER TABLE governance_candidates ADD COLUMN body_cleared_at TEXT;
            CREATE TABLE governance_candidate_bodies(candidate_id TEXT PRIMARY KEY REFERENCES governance_candidates(id), content TEXT NOT NULL, content_hash TEXT NOT NULL);
            ALTER TABLE governance_lifecycle ADD COLUMN changed_at TEXT;
            CREATE TABLE session_events(host_id TEXT NOT NULL, event_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT, project_id TEXT,
              kind TEXT NOT NULL CHECK(kind IN ('session.started','session.ended','message.user','message.assistant.final','tool.completed')),
              occurred_at TEXT NOT NULL, received_at TEXT NOT NULL, source_ref TEXT NOT NULL, adapter_version TEXT NOT NULL, protocol_version TEXT NOT NULL,
              stage TEXT NOT NULL CHECK(stage IN ('hot','archived','cleared')), important INTEGER NOT NULL DEFAULT 0, protected_reason TEXT,
              archived_at TEXT, inferred INTEGER NOT NULL DEFAULT 0, payload_json TEXT NOT NULL, PRIMARY KEY(host_id,event_id));
            CREATE TABLE session_event_refs(host_id TEXT NOT NULL, event_id TEXT NOT NULL, candidate_id TEXT NOT NULL REFERENCES governance_candidates(id), PRIMARY KEY(host_id,event_id,candidate_id));
            ALTER TABLE catalog_revisions ADD COLUMN applicability TEXT;
            ALTER TABLE catalog_revisions ADD COLUMN scope TEXT;
            PRAGMA user_version=7;
          `);
          // Split bodies out of request_json: the body ledger becomes the content authority and
          // 30-day clearing deletes only that row. Metadata stays in request_json forever.
          const candidates = this.db.prepare('SELECT id, request_json FROM governance_candidates').all();
          const insertBody = this.db.prepare('INSERT INTO governance_candidate_bodies VALUES(?,?,?)');
          for (const row of candidates) {
            const request = RememberInput.parse(JSON.parse(String(row['request_json'])));
            insertBody.run(String(row['id']), request.content, createHash('sha256').update(request.content).digest('hex'));
          }
          // Revision provenance columns free the version catalog from candidate request parsing.
          // The immutability trigger guards content and identity; the provenance backfill is
          // their one-time initialization, so the trigger is rebuilt after the migration.
          const revisions = this.db.prepare(`SELECT r.id AS revision_id, r.candidate_id, c.request_json FROM catalog_revisions r
            JOIN governance_candidates c ON c.id=r.candidate_id`).all();
          this.db.exec('DROP TRIGGER IF EXISTS catalog_revisions_immutable_update;');
          const setRevision = this.db.prepare('UPDATE catalog_revisions SET applicability=?, scope=? WHERE id=?');
          for (const row of revisions) {
            const request = RememberInput.parse(JSON.parse(String(row['request_json'])));
            setRevision.run(request.provenance.applicability, 'global', String(row['revision_id']));
          }
          this.db.exec(`CREATE TRIGGER catalog_revisions_immutable_update BEFORE UPDATE ON catalog_revisions BEGIN SELECT RAISE(ABORT,'Revision is immutable'); END;`);
          this.db.exec('UPDATE governance_lifecycle SET changed_at=(SELECT submitted_at FROM governance_candidates c WHERE c.id=governance_lifecycle.candidate_id) WHERE changed_at IS NULL');
        });
      }
      if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) === 7) {
        const destination = `${path}.pre-v8.${randomUUID()}.db`;
        this.db.prepare('VACUUM INTO ?').run(destination);
        this.transaction(() => {
          if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) !== 7) return;
          // WP6 (SYNC-P1–P8): ordered change stream, per-host grants and the revocation watermark.
          this.db.exec(`
            CREATE TABLE sync_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL, entity_id TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, op_at TEXT NOT NULL);
            CREATE TABLE sync_grants(grant_id TEXT PRIMARY KEY, host_id TEXT NOT NULL UNIQUE, projects_json TEXT NOT NULL, global_included INTEGER NOT NULL, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, generation INTEGER NOT NULL, revoked_at TEXT);
            CREATE TABLE sync_license_state(id INTEGER PRIMARY KEY CHECK(id=1), revocation_watermark INTEGER NOT NULL);
            INSERT INTO sync_license_state VALUES(1,0);
            PRAGMA user_version=8;
          `);
        });
      }
      if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) === 8) {
        const destination = `${path}.pre-v9.${randomUUID()}.db`;
        this.db.prepare('VACUUM INTO ?').run(destination);
        this.transaction(() => {
          if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) !== 8) return;
          // Historical step: v23 drops the schedule this introduced. The step keeps its original
          // shape so a library at v8 still walks the chain one version at a time.
          this.db.exec(`
            CREATE TABLE catalog_review_state(memory_id TEXT PRIMARY KEY REFERENCES catalog_memories(id),knowledge_type TEXT NOT NULL,interval_days INTEGER NOT NULL,last_reviewed_at TEXT,due_at TEXT NOT NULL);
            CREATE TABLE catalog_review_history(id TEXT PRIMARY KEY,memory_id TEXT NOT NULL REFERENCES catalog_memories(id),reviewed_at TEXT NOT NULL,reviewer TEXT NOT NULL,reason TEXT NOT NULL);
            PRAGMA user_version=9;
          `);
        });
      }
      if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) === 9) {
        this.db.prepare('VACUUM INTO ?').run(`${path}.pre-v10.${randomUUID()}.db`);
        this.transaction(() => {
          if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) !== 9) return;
          this.db.exec(`
            CREATE TABLE runtime_user_events(host_id TEXT NOT NULL,event_id TEXT NOT NULL,event_json TEXT NOT NULL,created_ms INTEGER NOT NULL,PRIMARY KEY(host_id,event_id));
            CREATE TABLE runtime_projects(id TEXT PRIMARY KEY);
            CREATE TABLE runtime_pins(id TEXT PRIMARY KEY,pin_json TEXT NOT NULL);
            CREATE TABLE runtime_sessions(host_id TEXT NOT NULL,session_id TEXT NOT NULL,project_id TEXT,task TEXT,entries_json TEXT NOT NULL,revision INTEGER NOT NULL,closed INTEGER NOT NULL,updated_ms INTEGER NOT NULL,capture_state TEXT NOT NULL,PRIMARY KEY(host_id,session_id));
            CREATE TABLE runtime_event_ids(host_id TEXT NOT NULL,event_id TEXT NOT NULL,created_ms INTEGER NOT NULL,event_hash TEXT NOT NULL,PRIMARY KEY(host_id,event_id));
            CREATE TABLE runtime_capture_tasks(id TEXT PRIMARY KEY,host_id TEXT NOT NULL,session_id TEXT NOT NULL,project_id TEXT,input_json TEXT NOT NULL,state TEXT NOT NULL,owner TEXT,until_ms INTEGER NOT NULL,attempts INTEGER NOT NULL,next_ms INTEGER NOT NULL,created_ms INTEGER NOT NULL);
            CREATE TABLE runtime_capture_runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,owner TEXT NOT NULL,state TEXT NOT NULL,started_ms INTEGER NOT NULL,ended_ms INTEGER);
            CREATE TABLE runtime_capture_receipts(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,run_id TEXT NOT NULL,result_json TEXT NOT NULL,created_ms INTEGER NOT NULL);
            PRAGMA user_version=10;
          `);
        });
      }
      if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) === 10) {
        this.db.prepare('VACUUM INTO ?').run(`${path}.pre-v11.${randomUUID()}.db`);
        this.transaction(() => {
          if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) !== 10) return;
          // v11: three-class memory tables plus the per-scope sync ledgers. Cursors are keyed
          // by scope because a device may be granted only some projects; a global cursor would
          // stall on gaps it cannot see, or skip other projects' unapplied changes.
          this.db.exec(`
            CREATE TABLE sync_state(scope TEXT PRIMARY KEY, cursor INTEGER NOT NULL, last_pull_at TEXT, last_error TEXT);
            CREATE TABLE sync_outbox(change_id TEXT PRIMARY KEY, scope TEXT NOT NULL, entry_id TEXT NOT NULL, base_version INTEGER NOT NULL, operation TEXT NOT NULL, entry_json TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE INDEX sync_outbox_state ON sync_outbox(state);
            CREATE TABLE sync_inbox(scope TEXT NOT NULL, seq INTEGER NOT NULL, change_id TEXT NOT NULL, entry_id TEXT NOT NULL, version INTEGER NOT NULL, operation TEXT NOT NULL, entry_json TEXT NOT NULL, state TEXT NOT NULL, error TEXT, received_at TEXT NOT NULL, PRIMARY KEY(scope, seq));
            CREATE TABLE formal_map(entry_id TEXT NOT NULL, version INTEGER NOT NULL, provider_id TEXT, content_hash TEXT NOT NULL, state TEXT NOT NULL, applied_at TEXT, PRIMARY KEY(entry_id, version));
            CREATE TABLE runtime_rules(entry_id TEXT PRIMARY KEY, body TEXT NOT NULL, scope TEXT NOT NULL, project_id TEXT, enabled INTEGER NOT NULL, version INTEGER NOT NULL, withdrawn_at TEXT, updated_at TEXT NOT NULL);
            CREATE TABLE project_archives(entry_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, source TEXT NOT NULL, verification TEXT NOT NULL, evidence TEXT NOT NULL, version INTEGER NOT NULL, withdrawn_at TEXT, updated_at TEXT NOT NULL);
            CREATE TABLE project_bindings(project_id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE runtime_injections(id TEXT PRIMARY KEY, host_id TEXT NOT NULL, session_id TEXT NOT NULL, outcome_json TEXT NOT NULL, created_ms INTEGER NOT NULL);
            CREATE INDEX runtime_injections_created ON runtime_injections(created_ms);
            DROP TABLE IF EXISTS sync_log;
            DROP TABLE IF EXISTS sync_grants;
            DROP TABLE IF EXISTS sync_license_state;
            PRAGMA user_version=11;
          `);
        });
      }
      if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) === 11) {
        this.db.prepare('VACUUM INTO ?').run(`${path}.pre-v12.${randomUUID()}.db`);
        this.transaction(() => {
          if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) !== 11) return;
          // v12: confirmed entry versions, independent of the formal Provider mapping. Rules,
          // archives and formal memories all carry a remote-assigned version; a local write
          // uses the last confirmed version as its base, so the ledger no longer guesses.
          this.db.exec(`
            CREATE TABLE entry_versions(entry_id TEXT PRIMARY KEY, version INTEGER NOT NULL, updated_at TEXT NOT NULL);
            INSERT INTO entry_versions(entry_id, version, updated_at)
              SELECT entry_id, MAX(version), COALESCE(MAX(applied_at), strftime('%Y-%m-%dT%H:%M:%fZ','now')) FROM formal_map GROUP BY entry_id;
            PRAGMA user_version=12;
          `);
        });
      }
      if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) === 12) {
        this.db.prepare('VACUUM INTO ?').run(`${path}.pre-v13.${randomUUID()}.db`);
        this.transaction(() => {
          if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) !== 12) return;
          // v13: a publication that still has to be offered to shared sync.
          //
          // Publishing used to commit and then notify a listener outside the transaction. A
          // process that died in between left the memory local-only with nothing to replay, so
          // the other machines never saw it. The row is written in the same transaction as the
          // publication and cleared once the change is confirmed, which makes the window
          // recoverable on the next start instead of lost.
          this.db.exec(`
            CREATE TABLE share_outbox(
              memory_id TEXT PRIMARY KEY,
              version INTEGER NOT NULL,
              provider_id TEXT NOT NULL,
              content TEXT NOT NULL,
              content_hash TEXT NOT NULL,
              scope TEXT NOT NULL,
              state TEXT NOT NULL CHECK(state IN ('pending','confirmed','failed')),
              attempts INTEGER NOT NULL DEFAULT 0,
              last_error TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE INDEX share_outbox_state ON share_outbox(state);
            PRAGMA user_version=13;
          `);
        });
      }
      if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) === 13) {
        this.db.prepare('VACUUM INTO ?').run(`${path}.pre-v14.${randomUUID()}.db`);
        this.transaction(() => {
          if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) !== 13) return;
          // v14: classification per revision.
          //
          // A synced formal entry carries `category`, `importance`, tags and entities; existing
          // revisions keep NULL, which the contract reports as "unknown" rather than as an empty
          // tag list. v23 drops the knowledge-type column this step also introduced.
          this.db.exec(`
            ALTER TABLE catalog_revisions ADD COLUMN knowledge_type TEXT;
            ALTER TABLE catalog_revisions ADD COLUMN category TEXT;
            ALTER TABLE catalog_revisions ADD COLUMN importance INTEGER;
            ALTER TABLE catalog_revisions ADD COLUMN tags_json TEXT;
            ALTER TABLE catalog_revisions ADD COLUMN entities_json TEXT;
            PRAGMA user_version=14;
          `);
        });
      }
      if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) === 14) {
        this.db.prepare('VACUUM INTO ?').run(`${path}.pre-v15.${randomUUID()}.db`);
        this.transaction(() => {
          if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) !== 14) return;
          // v15: formal memories and runtime rules stop being project-scoped.
          //
          // A memory is a statement about the work, not an attribute of one directory, and a rule
          // is a principle that holds everywhere. Project identity now belongs only to project
          // archives, which are working notes about one repository. Project-scoped memories and
          // rules cannot be reinterpreted as global ones — that would silently widen what a
          // session sees — so they are cleared instead, together with everything hanging off
          // them: catalog revisions, relations, conflicts and their sync bookkeeping.
          //
          // `scope`/`project_id` columns stay in place and are written as 'global'/NULL. Dropping
          // them would rewrite every table that references a revision, and a fresh migration is a
          // worse risk than two unused columns.
          this.db.exec(`
            DELETE FROM catalog_relations WHERE source_memory_id IN (SELECT id FROM catalog_memories WHERE scope <> 'global')
              OR target_memory_id IN (SELECT id FROM catalog_memories WHERE scope <> 'global');
            DELETE FROM catalog_conflict_decisions WHERE case_id IN (SELECT id FROM catalog_conflicts WHERE target_memory_id IN (SELECT id FROM catalog_memories WHERE scope <> 'global'));
            DELETE FROM catalog_conflicts WHERE target_memory_id IN (SELECT id FROM catalog_memories WHERE scope <> 'global');
            DELETE FROM catalog_reservations WHERE memory_id IN (SELECT id FROM catalog_memories WHERE scope <> 'global');
            DELETE FROM catalog_revisions WHERE memory_id IN (SELECT id FROM catalog_memories WHERE scope <> 'global');
            DELETE FROM catalog_memories WHERE scope <> 'global';
            UPDATE catalog_memories SET scope = 'global';
            DELETE FROM runtime_rules WHERE scope <> 'global' OR project_id IS NOT NULL;
            UPDATE runtime_rules SET scope = 'global', project_id = NULL;
            PRAGMA user_version=15;
          `);
        });
      }
      if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) === 15) {
        this.db.prepare('VACUUM INTO ?').run(`${path}.pre-v16.${randomUUID()}.db`);
        this.transaction(() => {
          if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) !== 15) return;
          // v16: byte-accounted runtime rules and archive state/history.
          //
          // Rules keep their old `scope`/`project_id` columns for compatibility with the v15
          // payloads, but gains importance, a pinned flag and a local archive. Archives gain an
          // active/archived state and an append-only revision table; existing rows are backfilled
          // with their current version so no history is invented.
          this.db.exec(`
            ALTER TABLE runtime_rules ADD COLUMN importance TEXT NOT NULL DEFAULT 'normal';
            ALTER TABLE runtime_rules ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE runtime_rules ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
            ALTER TABLE runtime_rules ADD COLUMN archived_at TEXT;
            UPDATE runtime_rules SET created_at = updated_at WHERE created_at = '';
            CREATE TABLE runtime_rule_archive(
              archive_id TEXT PRIMARY KEY,
              rule_id TEXT NOT NULL,
              rule_version INTEGER NOT NULL,
              body TEXT NOT NULL,
              importance TEXT NOT NULL,
              pinned INTEGER NOT NULL,
              archived_at TEXT NOT NULL,
              reason TEXT NOT NULL,
              UNIQUE(rule_id, rule_version)
            );
            CREATE INDEX runtime_rules_active ON runtime_rules(archived_at, enabled);
            ALTER TABLE project_archives ADD COLUMN state TEXT NOT NULL DEFAULT 'active';
            ALTER TABLE project_archives ADD COLUMN archived_at TEXT;
            CREATE INDEX project_archives_state ON project_archives(project_id, state);
            CREATE TABLE project_archive_revisions(
              revision_id TEXT PRIMARY KEY,
              entry_id TEXT NOT NULL,
              version INTEGER NOT NULL,
              project_id TEXT NOT NULL,
              title TEXT NOT NULL,
              body TEXT NOT NULL,
              source TEXT NOT NULL,
              verification TEXT NOT NULL,
              evidence TEXT NOT NULL,
              state TEXT NOT NULL,
              archived_at TEXT,
              recorded_at TEXT NOT NULL,
              UNIQUE(entry_id, version)
            );
            CREATE INDEX project_archive_revisions_entry ON project_archive_revisions(entry_id, version);
            INSERT OR IGNORE INTO project_archive_revisions(revision_id, entry_id, version, project_id, title, body, source, verification, evidence, state, archived_at, recorded_at)
              SELECT entry_id, entry_id, version, project_id, title, body, source, verification, evidence, 'active', NULL, updated_at FROM project_archives;
            PRAGMA user_version=16;
          `);
        });
      }
      if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) === 16) {
        this.db.prepare('VACUUM INTO ?').run(`${path}.pre-v17.${randomUUID()}.db`);
        this.transaction(() => {
          if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) !== 16) return;
          // v17: a formal memory belongs to one project or to general knowledge. Existing rows
          // keep a null owner, which is exactly "general": no body, id, revision, relation or
          // Provider mapping is rewritten by this step.
          this.db.exec(`
            ALTER TABLE catalog_memories ADD COLUMN project_id TEXT;
            CREATE INDEX catalog_memories_project ON catalog_memories(project_id);
            PRAGMA user_version=17;
          `);
        });
      }
      if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) === 17) {
        this.db.prepare('VACUUM INTO ?').run(`${path}.pre-v18.${randomUUID()}.db`);
        this.transaction(() => {
          if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) !== 17) return;
          // v18: durable maintenance jobs. The Provider work runs in this process; the row keeps
          // its state across restarts, and a job left `running` is marked interrupted on open.
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS diagnostic_jobs(
              id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
              started_at TEXT NOT NULL, finished_at TEXT, detail_json TEXT NOT NULL DEFAULT '{}'
            );
            CREATE INDEX IF NOT EXISTS diagnostic_jobs_kind ON diagnostic_jobs(kind, started_at);
            PRAGMA user_version=18;
          `);
        });
      }
      if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) === 18) {
        this.db.prepare('VACUUM INTO ?').run(`${path}.pre-v19.${randomUUID()}.db`);
        this.transaction(() => {
          if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) !== 18) return;
          // v19: idle-review watermark and selected signals, per host session. Selection is
          // deterministic; these rows are the durable evidence the task Agent reads later.
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS idle_review_state(
              host_id TEXT NOT NULL, session_id TEXT NOT NULL, last_turn INTEGER NOT NULL, updated_at TEXT NOT NULL,
              PRIMARY KEY(host_id, session_id)
            );
            CREATE TABLE IF NOT EXISTS idle_review_signals(
              id TEXT PRIMARY KEY, host_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id INTEGER NOT NULL,
              event_id TEXT NOT NULL, text TEXT NOT NULL, project_id TEXT, reason TEXT NOT NULL, created_at TEXT NOT NULL,
              UNIQUE(host_id, session_id, event_id)
            );
            CREATE INDEX IF NOT EXISTS idle_review_signals_session ON idle_review_signals(host_id, session_id, turn_id);
            PRAGMA user_version=19;
          `);
        });
      }
      if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) === 19) {
        this.db.prepare('VACUUM INTO ?').run(`${path}.pre-v20.${randomUUID()}.db`);
        this.transaction(() => {
          if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) !== 19) return;
          // v20: one idle-review run per session at a time, with per-item results the task Agent
          // reports after its writes. A run left running by a killed process is interrupted on open.
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS idle_review_runs(
              id TEXT PRIMARY KEY, host_id TEXT NOT NULL, session_id TEXT NOT NULL, state TEXT NOT NULL,
              attempt INTEGER NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, error TEXT NOT NULL DEFAULT '',
              items_json TEXT NOT NULL DEFAULT '[]', signal_ids_json TEXT NOT NULL DEFAULT '[]'
            );
            CREATE INDEX IF NOT EXISTS idle_review_runs_session ON idle_review_runs(host_id, session_id, started_at);
            PRAGMA user_version=20;
          `);
        });
      }
      if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) === 20) {
        this.db.prepare('VACUUM INTO ?').run(`${path}.pre-v21.${randomUUID()}.db`);
        this.transaction(() => {
          if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) !== 20) return;
          // v21: a signal is reserved by the run that is processing it. A failed or cancelled run
          // releases its signals so a retry sees them again; a succeeded run keeps them consumed.
          const hasRunId = this.db.prepare("PRAGMA table_info(idle_review_signals)").all().some(row => row['name'] === 'run_id');
          this.db.exec(`
            ${hasRunId ? '' : 'ALTER TABLE idle_review_signals ADD COLUMN run_id TEXT;'}
            CREATE INDEX IF NOT EXISTS idle_review_signals_run ON idle_review_signals(host_id, run_id);
            PRAGMA user_version=21;
          `);
        });
      }
      if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) === 21) {
        this.db.prepare('VACUUM INTO ?').run(`${path}.pre-v22.${randomUUID()}.db`);
        this.transaction(() => {
          if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) !== 21) return;
          // v22: the workspace model.
          //
          // Formal memories become one shared collection: the catalog keeps no owner column in
          // any new schema, and the legacy `project_id` values are preserved only as a migration
          // backup table, never read by the product. Workspaces are stable UUIDs; every device
          // binds its own root directory, and a session records the workspace it works in.
          // Archives move from a project id to a workspace id. Sync streams replace scopes in the
          // local ledgers: existing rows are re-keyed by their derived stream so a running
          // installation can keep serving while the remote is migrated separately.
          // Which signals a run reserved, so a partial failure retries only the unfinished ones.
          const runColumns = this.db.prepare("PRAGMA table_info(idle_review_runs)").all().map(row => String(row['name']));
          if (!runColumns.includes('signal_ids_json')) {
            this.db.exec(`ALTER TABLE idle_review_runs ADD COLUMN signal_ids_json TEXT NOT NULL DEFAULT '[]';`);
          }
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS workspaces(
              workspace_id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              created_at TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS workspace_bindings(
              workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
              root_path TEXT NOT NULL UNIQUE,
              created_at TEXT NOT NULL,
              PRIMARY KEY(workspace_id, root_path)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS session_workspaces(
              host_id TEXT NOT NULL,
              session_id TEXT NOT NULL,
              workspace_id TEXT REFERENCES workspaces(workspace_id),
              bound_at TEXT NOT NULL,
              PRIMARY KEY(host_id, session_id)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS legacy_project_owners(
              memory_id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS write_task_receipts(
              host_id TEXT NOT NULL,
              task_id TEXT NOT NULL,
              action_index INTEGER NOT NULL,
              kind TEXT NOT NULL,
              action TEXT NOT NULL,
              request_hash TEXT NOT NULL,
              status TEXT NOT NULL,
              memory_id TEXT,
              entry_version INTEGER,
              entry_id TEXT,
              candidate_id TEXT,
              error_code TEXT,
              updated_at TEXT NOT NULL,
              PRIMARY KEY(host_id, task_id, action_index)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS archive_distillations(
              draft_id TEXT PRIMARY KEY,
              host_id TEXT NOT NULL,
              workspace_id TEXT NOT NULL,
              entry_id TEXT NOT NULL,
              entry_version INTEGER NOT NULL,
              source_content_hash TEXT NOT NULL,
              content TEXT NOT NULL,
              category TEXT,
              importance INTEGER,
              tags_json TEXT,
              entities_json TEXT,
              reason TEXT NOT NULL,
              assessment TEXT NOT NULL,
              content_hash TEXT NOT NULL,
              created_at TEXT NOT NULL,
              task_id TEXT
            ) STRICT;
            CREATE TABLE IF NOT EXISTS host_evidence(
              id TEXT PRIMARY KEY,
              host_id TEXT NOT NULL,
              session_id TEXT NOT NULL,
              turn_id TEXT NOT NULL,
              kind TEXT NOT NULL,
              ref TEXT NOT NULL,
              summary TEXT NOT NULL,
              detail TEXT,
              created_at TEXT NOT NULL
            ) STRICT;
            CREATE INDEX IF NOT EXISTS host_evidence_turn ON host_evidence(host_id, session_id, turn_id);
            CREATE TABLE IF NOT EXISTS turn_sessions(
              host_id TEXT NOT NULL,
              session_id TEXT NOT NULL,
              closed INTEGER NOT NULL,
              updated_ms INTEGER NOT NULL,
              PRIMARY KEY(host_id, session_id)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS turn_event_ids(
              host_id TEXT NOT NULL,
              event_id TEXT NOT NULL,
              event_hash TEXT NOT NULL,
              created_ms INTEGER NOT NULL,
              PRIMARY KEY(host_id, event_id)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS turn_messages(
              host_id TEXT NOT NULL,
              session_id TEXT NOT NULL,
              turn_id TEXT NOT NULL,
              event_id TEXT NOT NULL,
              text TEXT NOT NULL,
              no_retention INTEGER NOT NULL,
              created_ms INTEGER NOT NULL,
              PRIMARY KEY(host_id, event_id)
            ) STRICT;
            CREATE INDEX IF NOT EXISTS turn_messages_session ON turn_messages(host_id, session_id, created_ms);
            CREATE TABLE IF NOT EXISTS turn_no_retention(
              host_id TEXT NOT NULL,
              session_id TEXT NOT NULL,
              turn_id TEXT NOT NULL,
              created_ms INTEGER NOT NULL,
              PRIMARY KEY(host_id, session_id, turn_id)
            ) STRICT;
            PRAGMA user_version=22;
          `);
          // Preserve the legacy attribution, then drop the column so no read path can filter by
          // it again: a shared collection has no owner. The backup table is not read by the
          // product; it exists so an operator can answer "which project did this come from"
          // during the migration.
          const hasOwner = this.db.prepare("SELECT 1 FROM pragma_table_info('catalog_memories') WHERE name='project_id'").get() !== undefined;
          if (hasOwner) {
            this.db.exec(`
              INSERT OR IGNORE INTO legacy_project_owners(memory_id, project_id)
                SELECT id, project_id FROM catalog_memories WHERE project_id IS NOT NULL;
              UPDATE catalog_memories SET scope='global', project_id=NULL;
              DROP INDEX IF EXISTS catalog_memories_project;
              ALTER TABLE catalog_memories DROP COLUMN project_id;
            `);
          }
          // Keep original project ownership for reconciliation and migrate both current and historical rows.
          const archiveColumns = this.db.prepare("PRAGMA table_info(project_archives)").all().map(row => String(row['name']));
          if (archiveColumns.includes('project_id') && !archiveColumns.includes('workspace_id')) {
            this.db.exec(`
              CREATE TABLE IF NOT EXISTS archive_project_backup(entry_id TEXT PRIMARY KEY, project_id TEXT NOT NULL) STRICT;
              INSERT OR IGNORE INTO archive_project_backup(entry_id, project_id) SELECT entry_id, project_id FROM project_archives;
              ALTER TABLE project_archives RENAME COLUMN project_id TO workspace_id;
            `);
          }
          const revisionColumns = this.db.prepare("PRAGMA table_info(project_archive_revisions)").all().map(row => String(row['name']));
          if (revisionColumns.includes('project_id') && !revisionColumns.includes('workspace_id')) {
            this.db.exec(`ALTER TABLE project_archive_revisions RENAME COLUMN project_id TO workspace_id;`);
          }
          if (archiveColumns.includes('project_id') || revisionColumns.includes('project_id')) {
            const projects = this.db.prepare(`
              SELECT workspace_id FROM project_archives
              UNION SELECT workspace_id FROM project_archive_revisions
            `).all();
            const mapped: { projectId: string; workspaceId: string; name: string }[] = [];
            for (const row of projects) {
              const projectId = String(row['workspace_id']);
              const workspace = Object.hasOwn(quota.legacyWorkspaces ?? {}, projectId) ? quota.legacyWorkspaces![projectId] : undefined;
              if (!workspace) throw new Error(`Missing workspace migration mapping for project ${projectId}`);
              mapped.push({ projectId, ...workspace });
            }
            this.db.exec('CREATE TEMP TABLE archive_workspace_migration(project_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL)');
            for (const workspace of mapped) {
              this.db.prepare('INSERT INTO archive_workspace_migration VALUES(?, ?)').run(workspace.projectId, workspace.workspaceId);
              this.db.prepare('INSERT OR IGNORE INTO workspaces(workspace_id, name, created_at) VALUES(?, ?, ?)').run(workspace.workspaceId, workspace.name, new Date().toISOString());
            }
            for (const table of ['project_archives', 'project_archive_revisions']) {
              this.db.exec(`UPDATE ${table} SET workspace_id=(SELECT workspace_id FROM archive_workspace_migration WHERE project_id=${table}.workspace_id)`);
            }
            this.db.exec('DROP TABLE archive_workspace_migration');
          }
          // Local sync ledgers: a scope becomes a stream.
          //
          // Legacy cursors and completed queues are replaced by a fresh snapshot for each stream.
          const legacyLedger = this.db.prepare("SELECT 1 FROM pragma_table_info('sync_outbox') WHERE name='scope'").get() !== undefined;
          this.db.exec(`
            DROP TABLE IF EXISTS sync_state_streams;
            DROP TABLE IF EXISTS sync_outbox_streams;
            DROP TABLE IF EXISTS sync_inbox_streams;
            CREATE TABLE sync_state_streams(stream TEXT PRIMARY KEY, cursor INTEGER NOT NULL, last_pull_at TEXT, last_error TEXT);
            CREATE TABLE sync_outbox_streams(change_id TEXT PRIMARY KEY, stream TEXT NOT NULL, entry_id TEXT NOT NULL, base_version INTEGER NOT NULL, operation TEXT NOT NULL, entry_json TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS sync_outbox_streams_state ON sync_outbox_streams(state);
            CREATE TABLE sync_inbox_streams(stream TEXT NOT NULL, seq INTEGER NOT NULL, change_id TEXT NOT NULL, entry_id TEXT NOT NULL, version INTEGER NOT NULL, operation TEXT NOT NULL, entry_json TEXT NOT NULL, state TEXT NOT NULL, error TEXT, received_at TEXT NOT NULL, PRIMARY KEY(stream, seq));
          `);
          if (legacyLedger) {
            const outstanding = this.db.prepare(`
              SELECT 1 FROM sync_outbox WHERE state <> 'confirmed'
              UNION ALL SELECT 1 FROM sync_inbox WHERE state <> 'applied'
              UNION ALL SELECT 1 FROM share_outbox WHERE ?
              LIMIT 1
            `).get(Number(this.shareEnabled));
            if (outstanding) throw new Error('Drain legacy sync and publication queues before migrating');
            if (this.shareEnabled) this.db.exec(`
              CREATE TABLE IF NOT EXISTS legacy_formal_pending(memory_id TEXT PRIMARY KEY) STRICT;
              INSERT OR IGNORE INTO legacy_formal_pending SELECT DISTINCT entry_id FROM formal_map;
              INSERT OR IGNORE INTO legacy_formal_pending SELECT entry_id FROM sync_outbox
                WHERE json_extract(entry_json, '$.kind') IN ('formal', 'formal-memory');
              INSERT OR IGNORE INTO legacy_formal_pending SELECT entry_id FROM sync_inbox
                WHERE json_extract(entry_json, '$.kind') IN ('formal', 'formal-memory');
            `);
            // Only a store that still carries the scope-keyed ledgers needs the backup; a store
            // already keyed by stream keeps its rows through the copy below unchanged.
            this.db.exec(`
              DROP TABLE IF EXISTS legacy_sync_outbox_backup;
              DROP TABLE IF EXISTS legacy_sync_inbox_backup;
              CREATE TABLE legacy_sync_outbox_backup(change_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL) STRICT;
              CREATE TABLE legacy_sync_inbox_backup(scope TEXT NOT NULL, seq INTEGER NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(scope, seq)) STRICT;
              INSERT OR IGNORE INTO legacy_sync_outbox_backup(change_id, payload_json)
                SELECT change_id, json_object('scope', scope, 'entry', json(entry_json), 'operation', operation, 'state', state) FROM sync_outbox;
              INSERT OR IGNORE INTO legacy_sync_inbox_backup(scope, seq, payload_json)
                SELECT scope, seq, json_object('changeId', change_id, 'entry', json(entry_json), 'version', version) FROM sync_inbox;
            `);
          } else {
            this.db.exec(`
              INSERT OR IGNORE INTO sync_outbox_streams(change_id, stream, entry_id, base_version, operation, entry_json, state, attempts, last_error, created_at, updated_at)
                SELECT change_id, stream, entry_id, base_version, operation, entry_json, state, attempts, last_error, created_at, updated_at FROM sync_outbox;
            `);
          }
          this.db.exec(`
            DROP TABLE IF EXISTS sync_state;
            DROP TABLE IF EXISTS sync_outbox;
            DROP TABLE IF EXISTS sync_inbox;
            ALTER TABLE sync_state_streams RENAME TO sync_state;
            ALTER TABLE sync_outbox_streams RENAME TO sync_outbox;
            ALTER TABLE sync_inbox_streams RENAME TO sync_inbox;
          `);
        });
      }
      this.db.prepare("UPDATE idle_review_signals SET run_id=NULL WHERE run_id IN (SELECT id FROM idle_review_runs WHERE state='running')").run();
      this.db.prepare("UPDATE idle_review_runs SET state='interrupted', finished_at=? WHERE state='running'").run(new Date().toISOString());

      // No job survives this process: a row still marked running belongs to a killed run.
      this.db.prepare("UPDATE diagnostic_jobs SET state='interrupted', finished_at=? WHERE state='running'").run(new Date().toISOString());
      this.db.prepare('SELECT category, importance, tags_json, entities_json FROM catalog_revisions LIMIT 0').all();
      this.db.prepare('SELECT memory_id, version, provider_id, content, content_hash, scope, state FROM share_outbox LIMIT 0').all();
      this.db.prepare('SELECT workspace_id, name, created_at FROM workspaces LIMIT 0').all();
      this.db.prepare('SELECT host_id, session_id, closed FROM turn_sessions LIMIT 0').all();
      this.db.prepare('SELECT host_id, task_id, action_index, status FROM write_task_receipts LIMIT 0').all();
      this.db.prepare('SELECT entry_id, workspace_id, version FROM project_archives LIMIT 0').all();
      this.ledger = new SqliteSyncLedger(this.db, operation => this.transaction(operation));
      this.memory = new SqliteMemoryStore(this.db, operation => this.transaction(operation), this.catalog);
      this.workspaces = new SqliteWorkspaceStore(this.db, operation => this.transaction(operation));
      this.writeTasks = new SqliteWriteTaskStore(this.db, operation => this.transaction(operation));
      this.distillations = new SqliteDistillationStore(this.db, operation => this.transaction(operation));
      this.evidence = new SqliteEvidenceStore(this.db, operation => this.transaction(operation));
      this.turns = new SqliteTurnStore(this.db, operation => this.transaction(operation));
      this.events = new SessionEventStore(this.db, operation => this.transaction(operation));
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) === 22) {
        this.db.prepare('VACUUM INTO ?').run(path + '.pre-v23.' + randomUUID() + '.db');
        this.transaction(() => {
          if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) !== 22) return;
          // The knowledge-type domain and the review schedule derived from it are both gone.
          // Existing rows are cleared rather than left readable: a removed dimension that still
          // answers queries is a second, undocumented classification system.
          this.db.exec(
            'DROP TABLE IF EXISTS catalog_review_state;'
            + 'DROP TABLE IF EXISTS catalog_review_history;'
            + 'DROP TABLE IF EXISTS archive_distillations;'
            + 'CREATE TABLE archive_distillations('
            + 'draft_id TEXT PRIMARY KEY,host_id TEXT NOT NULL,workspace_id TEXT NOT NULL,'
            + 'entry_id TEXT NOT NULL,entry_version INTEGER NOT NULL,source_content_hash TEXT NOT NULL,'
            + 'content TEXT NOT NULL,category TEXT,importance INTEGER,tags_json TEXT,entities_json TEXT,'
            + 'reason TEXT NOT NULL,assessment TEXT NOT NULL,content_hash TEXT NOT NULL,'
            + 'created_at TEXT NOT NULL,task_id TEXT) STRICT;',
          );
          // A draft is a preview, not a record: an unfinished one is recreated from its source.
          this.db.exec('DROP TRIGGER IF EXISTS catalog_revisions_immutable_update;');
          const hasKnowledge = this.db.prepare("SELECT 1 FROM pragma_table_info('catalog_revisions') WHERE name='knowledge_type'").get() !== undefined;
          if (hasKnowledge) this.db.exec('ALTER TABLE catalog_revisions DROP COLUMN knowledge_type;');
          this.db.exec("CREATE TRIGGER catalog_revisions_immutable_update BEFORE UPDATE ON catalog_revisions BEGIN SELECT RAISE(ABORT,'Revision is immutable'); END;");
          this.db.exec('PRAGMA user_version=23;');
        });
      }
    } catch (error) { this.db.close(); throw error; }
  }
  private transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return operation();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth++;
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.transactionDepth--; }
  }
  submit(input: RememberRequest): CandidateRecord {
    const request = RememberInput.parse(input);
    // The stable hash covers the FULL normalized request (body included) and never changes,
    // even after retention clearing removes the body; metadata-only JSON is stored instead.
    const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id, request_hash FROM governance_candidates WHERE idempotency_key=?').get(request.idempotencyKey);
      if (existing) {
        const stored = this.db.prepare('SELECT request_hash, request_json FROM governance_candidates WHERE id=?').get(existing['id']!);
        let storedHash = String(stored!['request_hash']);
        if (storedHash !== hash) {
          // Legacy rows normalize differently; a cleared body can no longer be re-derived and fails closed.
          try { storedHash = createHash('sha256').update(JSON.stringify(RememberInput.parse(JSON.parse(String(stored!['request_json']))))).digest('hex'); } catch { /* fail closed */ }
        }
        if (storedHash !== hash) throw new MnemoWeaveError('IDEMPOTENCY_CONFLICT');
        return this.get(String(existing['id']));
      }
      const id = randomUUID();
      const submittedAt = new Date().toISOString();
      this.enforceQuota();
      this.db.prepare('INSERT INTO governance_candidates(id,idempotency_key,request_hash,request_json,status,submitted_at) VALUES(?,?,?,?,?,?)')
        .run(id, request.idempotencyKey, hash, JSON.stringify({ ...request, content: '' }), 'pending_review', submittedAt);
      this.db.prepare('INSERT INTO governance_candidate_bodies(candidate_id,content,content_hash) VALUES(?,?,?)')
        .run(id, this.storeBody(request.content), createHash('sha256').update(request.content).digest('hex'));
      this.db.prepare('INSERT INTO governance_submission_receipts VALUES(?,?,?)').run(randomUUID(), id, 'candidate');
      this.catalog.registerConflict(id,request);
      return this.get(id);
    });
  }
  commitDirectEdit(
    memoryId: string, request: RememberRequest, providerId: string, hash: string, time: string,
    entryVersion: number, actor: string, reason: string, meta: Parameters<SqliteMemoryCatalog['publishDirectEdit']>[7],
  ) {
    return this.transaction(() => {
      const revision = this.catalog.publishDirectEdit(memoryId, request, providerId, hash, time, actor, reason, meta);
      this.memory.upsertFormalMap({ entryId: memoryId, version: entryVersion, providerId, contentHash: hash, state: 'applied', appliedAt: time }, time);
      this.memory.setEntryVersion(memoryId, entryVersion, time);
      return revision;
    });
  }

  get(candidateId: string): CandidateRecord {
    const row = this.db.prepare(`SELECT c.*, r.id AS receipt_id FROM governance_candidates c
      JOIN governance_submission_receipts r ON r.candidate_id=c.id WHERE c.id=?`).get(candidateId);
    if (!row) throw new MnemoWeaveError('NOT_FOUND');
    const storedRequest = CandidateRequest.parse(JSON.parse(String(row['request_json'])));
    const body = this.db.prepare('SELECT content FROM governance_candidate_bodies WHERE candidate_id=?').get(candidateId);
    const request: RememberRequest = { ...storedRequest, content: body ? this.loadBody(String(body['content'])) : '' };
    const lifecycle = this.db.prepare('SELECT status FROM governance_lifecycle WHERE candidate_id=?').get(candidateId);
    const reviews = this.db.prepare('SELECT * FROM governance_reviews WHERE candidate_id=? ORDER BY rowid').all(candidateId).map(review => ({
      id: review['id'], decision: review['decision'], actor: review['actor'], reason: review['reason'], createdAt: review['created_at'], assessment: review['assessment_json'] ? JSON.parse(String(review['assessment_json'])) : null,
    }));
    const executionReceipts = this.db.prepare('SELECT * FROM governance_execution_receipts WHERE candidate_id=? ORDER BY rowid').all(candidateId).map(receipt => ({ id: receipt['id'], taskId: receipt['task_id'], runId: receipt['run_id'], createdAt: receipt['created_at'], ...JSON.parse(String(receipt['result_json'])) }));
    const task = this.db.prepare('SELECT id,write_key,state,checkpoint,attempts,next_at FROM governance_tasks WHERE candidate_id=?').get(candidateId);
    const publication = this.catalog.publicationForCandidate(candidateId);
    const conflictCaseId=this.catalog.conflictForCandidate(candidateId);
    return Candidate.parse({ id: row['id'], status: lifecycle?.['status'] ?? row['status'], submittedAt: row['submitted_at'], request, reviews, executionReceipts, ...(task ? { task } : {}), ...(publication ? { publication } : {}),...(conflictCaseId?{conflictCaseId}:{}),...(body ? {} : { bodyCleared: true }),
      receipt: { id: row['receipt_id'], candidateId: row['id'], idempotencyKey: request.idempotencyKey, status: 'candidate', submittedAt: row['submitted_at'] },
    });
  }
  bindProvider(identity: string): void {
    this.transaction(() => {
      const binding = this.db.prepare('SELECT identity FROM governance_provider_binding WHERE id=1').get();
      if (binding && binding['identity'] !== identity) throw new Error('Governance database belongs to a different Provider store');
      this.db.prepare('INSERT OR IGNORE INTO governance_provider_binding VALUES(1,?)').run(identity);
    });
  }
  pending(exclude: readonly string[] = []): string | undefined {
    const filter = exclude.length ? `AND c.id NOT IN (${exclude.map(() => '?').join(',')})` : '';
    const row = this.db.prepare(`SELECT c.id FROM governance_candidates c LEFT JOIN governance_lifecycle l ON l.candidate_id=c.id
      WHERE (l.candidate_id IS NULL OR l.status='pending_review') ${filter} ORDER BY c.rowid LIMIT 1`).get(...exclude);
    return row ? String(row['id']) : undefined;
  }
  isKnownDuplicate(candidateId: string, providerIds: string[]): boolean {
    const incoming = this.get(candidateId).request;
    return providerIds.every(providerId => this.db.prepare(`SELECT r.candidate_id FROM governance_candidates c
      JOIN governance_execution_receipts r ON r.candidate_id=c.id
      WHERE json_extract(r.result_json,'$.status')='persisted' AND json_extract(r.result_json,'$.providerMemoryId')=?`).all(providerId).some(row => {
      const candidateId = String(row['candidate_id']);
      const body = this.db.prepare('SELECT content FROM governance_candidate_bodies WHERE candidate_id=?').get(candidateId);
      if (!body) return false; // cleared body: no content comparison, never a false duplicate
      const prior = CandidateRequest.parse(JSON.parse(String(this.db.prepare('SELECT request_json FROM governance_candidates WHERE id=?').get(candidateId)!['request_json'])));
      return String(body['content']) === incoming.content && JSON.stringify(prior.tags) === JSON.stringify(incoming.tags) && JSON.stringify(prior.provenance) === JSON.stringify(incoming.provenance);
    }));
  }
  acquire(owner: string, duration: number): boolean {
    return this.db.prepare('UPDATE governance_workflow_lock SET owner=?,until_ms=? WHERE id=1 AND until_ms<=?').run(owner, Date.now() + duration, Date.now()).changes === 1;
  }
  renew(owner: string, duration: number): boolean {
    return this.db.prepare('UPDATE governance_workflow_lock SET until_ms=? WHERE id=1 AND owner=? AND until_ms>?').run(Date.now() + duration, owner, Date.now()).changes === 1;
  }
  release(owner: string): void { this.db.prepare('UPDATE governance_workflow_lock SET owner=NULL,until_ms=0 WHERE id=1 AND owner=?').run(owner); }
  private fence(owner: string): void {
    if (!this.db.prepare('SELECT id FROM governance_workflow_lock WHERE id=1 AND owner=? AND until_ms>?').get(owner, Date.now())) throw new MnemoWeaveError('INVALID_STATE');
  }
  private status(id: string, state: string): void {
    // changed_at records when the CURRENT state was entered; retention periods start here.
    this.db.prepare(`INSERT INTO governance_lifecycle(candidate_id,status,changed_at) VALUES(?,?,?)
      ON CONFLICT(candidate_id) DO UPDATE SET status=excluded.status, changed_at=excluded.changed_at`).run(id, state, new Date().toISOString());
  }
  private recordReview(id: string, decision: string, actor: string, reason: string, assessment: Assessment | null): void {
    this.db.prepare('INSERT INTO governance_reviews VALUES(?,?,?,?,?,?,?)').run(randomUUID(), id, decision, actor, reason, assessment ? JSON.stringify(assessment) : null, new Date().toISOString());
  }
  review(id: string, decision: ReviewDecision, actor: string, reason: string, assessment: Assessment | null, owner?: string,resolution?:'revise'|'supersede'|'coexist'): CandidateRecord {
    return this.transaction(() => {
      if (owner) this.fence(owner);
      const candidate = this.get(id);
      if (!['pending_review', 'needs_review'].includes(candidate.status)) throw new MnemoWeaveError('INVALID_STATE');
      if (decision === 'approve' && candidate.request.change) this.catalog.prepare(id,candidate.request,resolution);
      this.recordReview(id, decision, actor, reason, assessment);
      this.status(id, decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'needs_review');
      if(decision==='reject')this.catalog.dismissCaseForCandidate(id,actor,reason);
      if (decision === 'human') {
        this.db.prepare('INSERT OR IGNORE INTO governance_review_tasks VALUES(?,?,?,?)').run(randomUUID(), id, assessment?.conflict && assessment.conflict !== 'none' ? 'conflict' : 'quality', 'open');
      } else {
        this.db.prepare("UPDATE governance_review_tasks SET state='resolved' WHERE candidate_id=?").run(id);
      }
      if (decision === 'approve') {
        const taskId = randomUUID();
        this.db.prepare('INSERT INTO governance_tasks(id,candidate_id,write_key,state,checkpoint,attempts,next_at,owner) VALUES(?,?,?,?,?,?,?,?)').run(taskId, id, `candidate:${id}`, 'queued', 'ready', 0, Date.now(), null);
        this.db.prepare('INSERT INTO governance_outbox VALUES(?,?)').run(randomUUID(), taskId);
      }
      return this.get(id);
    });
  }
  claim(owner: string): Job | undefined {
    return this.transaction(() => {
      this.fence(owner);
      const row = this.db.prepare(`SELECT * FROM governance_tasks WHERE state='running' OR (state IN ('queued','failed') AND next_at IS NOT NULL AND next_at<=?) ORDER BY rowid LIMIT 1`).get(Date.now());
      if (!row) return undefined;
      this.db.prepare("UPDATE governance_runs SET state='interrupted',ended_at=? WHERE task_id=? AND state='running'").run(new Date().toISOString(), row['id']!);
      this.db.prepare("UPDATE governance_tasks SET state='running',owner=?,attempts=attempts+1 WHERE id=?").run(owner, row['id']!);
      this.status(String(row['candidate_id']), 'persisting');
      const runId = randomUUID();
      this.db.prepare('INSERT INTO governance_runs VALUES(?,?,?,?,?)').run(runId, row['id']!, 'running', new Date().toISOString(), null);
      return { taskId: String(row['id']), runId, candidateId: String(row['candidate_id']), writeKey: String(row['write_key']), checkpoint: String(row['checkpoint']) as Job['checkpoint'], owner };
    });
  }
  private checkJob(job: Job): void {
    this.fence(job.owner);
    if (!this.db.prepare("SELECT id FROM governance_tasks WHERE id=? AND state='running' AND owner=?").get(job.taskId, job.owner)) throw new MnemoWeaveError('INVALID_STATE');
  }
  writing(job: Job): void {
    this.transaction(() => { this.checkJob(job); this.db.prepare("UPDATE governance_tasks SET checkpoint='writing' WHERE id=?").run(job.taskId); });
  }
  versionOperation(job: Job) { this.checkJob(job); return this.catalog.operation(job.candidateId); }
  versionCheckpoint(job: Job, checkpoint: VersionCheckpoint): void {
    this.transaction(() => { this.checkJob(job); this.catalog.checkpoint(job.candidateId,checkpoint); });
  }
  checkSupersedesProjection(job:Job,sourceProviderId:string):void{
    this.transaction(()=>{this.checkJob(job);this.catalog.checkSupersedesProjection(job.candidateId,sourceProviderId);});
  }
  finish(job: Job, result: WriteResult, reconciled: boolean): void {
    const published = this.transaction(() => {
      this.checkJob(job);
      const request = this.get(job.candidateId).request;
      const contentHash = createHash('sha256').update(request.content).digest('hex');
      let memoryId: string;
      let revisionId: string | undefined;
      if (request.change) {
        this.catalog.publishOperation(job.candidateId, request, result.id, contentHash, new Date().toISOString());
        const plan = this.catalog.operation(job.candidateId).plan;
        memoryId = plan.memoryId;
      } else {
        const initial = this.catalog.publishInitial(job.candidateId, request, result.id, contentHash, new Date().toISOString());
        memoryId = initial.memoryId;
        revisionId = (initial as { revisionId?: string }).revisionId;
      }
      this.recordReceipt(job, { status: 'persisted', providerMemoryId: result.id, providerAction: result.action, writeKey: job.writeKey, reconciled, contentHash });
      this.db.prepare("UPDATE governance_tasks SET state='succeeded',next_at=NULL,owner=NULL,first_failed_at=NULL,alerted_at=NULL WHERE id=?").run(job.taskId);
      this.db.prepare("UPDATE governance_runs SET state='succeeded',ended_at=? WHERE id=?").run(new Date().toISOString(), job.runId);
      this.status(job.candidateId, 'persisted');
      // Published version of the entry this publication produced.
      const number = revisionId
        ? Number((this.db.prepare('SELECT revision_number FROM catalog_revisions WHERE id=?').get(revisionId) as { revision_number?: number } | undefined)?.revision_number ?? 1)
        : Number((this.db.prepare('SELECT revision_number FROM catalog_revisions WHERE memory_id=? ORDER BY revision_number DESC LIMIT 1').get(memoryId) as { revision_number?: number } | undefined)?.revision_number ?? 1);
      // Durable share marker, same transaction as the publication: if the process dies before
      // the listener runs, the next start still knows this memory owes a shared change.
      const shareStream = FORMAL_STREAM;
      if (this.shareEnabled) this.db.prepare(`
        INSERT INTO share_outbox(memory_id, version, provider_id, content, content_hash, scope, state, attempts, last_error, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)
        ON CONFLICT(memory_id) DO UPDATE SET version=excluded.version, provider_id=excluded.provider_id,
          content=excluded.content, content_hash=excluded.content_hash, scope=excluded.scope,
          state='pending', last_error=NULL, updated_at=excluded.updated_at
      `).run(memoryId, number, result.id, request.content, contentHash, shareStream, new Date().toISOString(), new Date().toISOString());
      return { request, memoryId, contentHash, number };
    });
    // Outside the transaction: the listener may touch the network or the ledger, and a
    // publication that committed must not be rolled back because sharing it failed. The
    // durable row written inside `finish` is what makes a crash here recoverable.
    this.announcePublished(
      published.memoryId, result.id, published.number, published.request.content, published.contentHash,
      FORMAL_STREAM,
    );
  }

  /** Publications that still have to reach shared sync; drained on start and after each publish. */
  hasUnsettledShare(memoryId: string): boolean {
    return this.db.prepare('SELECT 1 FROM share_outbox WHERE memory_id=?').get(memoryId) !== undefined;
  }

  pendingShares(limit = 20): PublishedFormal[] {
    const rows = this.db.prepare(
      "SELECT memory_id, version, provider_id, content, content_hash, scope FROM share_outbox WHERE state = 'pending' ORDER BY created_at LIMIT ?",
    ).all(limit) as unknown as { memory_id: string; version: number; provider_id: string; content: string; content_hash: string; scope: string }[];
    return rows.map(row => ({
      memoryId: String(row.memory_id), version: Number(row.version), providerId: String(row.provider_id),
      content: String(row.content), contentHash: String(row.content_hash),
      stream: String(row.scope) === 'global' || String(row.scope).startsWith('project:') ? FORMAL_STREAM : String(row.scope),
    }));
  }

  /** Mark a share attempt finished. `confirmed` clears it; `failed` keeps it for a later retry. */
  settleShare(memoryId: string, state: 'confirmed' | 'failed', error: string | null, at: string): void {
    this.transaction(() => {
      if (state === 'confirmed') {
        this.db.prepare('DELETE FROM share_outbox WHERE memory_id = ?').run(memoryId);
        return;
      }
      this.db.prepare('UPDATE share_outbox SET state = ?, attempts = attempts + 1, last_error = ?, updated_at = ? WHERE memory_id = ?')
        .run(state, error, at, memoryId);
    });
  }
  private recordReceipt(job: Job, result: unknown): void {
    this.db.prepare('INSERT INTO governance_execution_receipts VALUES(?,?,?,?,?,?)').run(randomUUID(), job.candidateId, job.taskId, job.runId, JSON.stringify(result), new Date().toISOString());
  }
  fail(job: Job, code: string, uncertain: boolean): void {
    this.transaction(() => {
      this.checkJob(job);
      // TASK-04: non-model recoverable infrastructure failures keep retrying with capped backoff
      // and alert after 24 hours; semantic/integrity failures wait for an operator instead.
      const task = this.db.prepare('SELECT attempts, first_failed_at, alerted_at FROM governance_tasks WHERE id=?').get(job.taskId)!;
      const now = Date.now();
      const retryable = !uncertain && !['PROVIDER_INTEGRITY', 'REVIEW_REQUIRED', 'INVALID_STATE', 'UNSUPPORTED_VERSION'].includes(code);
      const retryAt = retryable ? now + Math.min(2000 * 2 ** (Number(task['attempts']) - 1), 900000) : null;
      let firstFailedAt = task['first_failed_at'] === null ? null : Number(task['first_failed_at']);
      let alertedAt = task['alerted_at'] === null ? null : Number(task['alerted_at']);
      if (retryable) {
        firstFailedAt ??= now;
        if (now - firstFailedAt > 86_400_000 && alertedAt === null) {
          alertedAt = now;
          process.stderr.write(`${JSON.stringify({ event: 'task_retry_alert', taskId: job.taskId, candidateId: job.candidateId, code, failingSince: new Date(firstFailedAt).toISOString() })}\n`);
        }
      }
      this.recordReceipt(job, { status: 'failed', code, uncertain, writeKey: job.writeKey });
      this.db.prepare("UPDATE governance_tasks SET state='failed',next_at=?,owner=NULL,first_failed_at=?,alerted_at=? WHERE id=?").run(retryAt, firstFailedAt, alertedAt, job.taskId);
      this.db.prepare("UPDATE governance_runs SET state='failed',ended_at=? WHERE id=?").run(new Date().toISOString(), job.runId);
      this.status(job.candidateId, 'failed');
    });
  }
  retry(id: string, actor: string, reason: string): CandidateRecord {
    return this.transaction(() => {
      if (this.get(id).status !== 'failed') throw new MnemoWeaveError('INVALID_STATE');
      this.recordReview(id, 'retry', actor, reason, null);
      this.db.prepare("UPDATE governance_tasks SET state='queued',checkpoint='retry',next_at=?,first_failed_at=NULL,alerted_at=NULL WHERE candidate_id=?").run(Date.now(), id);
      this.status(id, 'approved');
      return this.get(id);
    });
  }
  amend(id: string, request: RememberRequest, actor: string, reason: string): CandidateRecord {
    return this.transaction(() => {
      const replacement = this.submit(request);
      if (replacement.id === id) throw new MnemoWeaveError('INVALID_INPUT');
      this.review(id, 'reject', actor, `${reason}\nReplacement candidate: ${replacement.id}`, null);
      this.recordReview(replacement.id, 'resubmitted', actor, `Amended from ${id}: ${reason}`, null);
      return this.get(replacement.id);
    });
  }
  resolveConflict(input:ConflictResolutionRequest,actor:string):CandidateRecord{
    return this.transaction(()=>{
      const conflict=this.catalog.getConflict(input.caseId);
      const candidate=this.get(conflict.candidateId);
      if(candidate.status!=='needs_review')throw new MnemoWeaveError('INVALID_STATE');
      let followUp:CandidateRecord|undefined;
      if(input.decision==='coexist'){
        const replacement=input.replacement!;
        if(replacement.change?.kind!=='coexist'||replacement.change.targetMemoryId!==conflict.targetMemoryId||replacement.change.expectedRevisionId!==conflict.baseRevisionId)throw new MnemoWeaveError('INVALID_INPUT');
        followUp=this.submit(replacement);
        if(followUp.id===candidate.id||followUp.status!=='pending_review')throw new MnemoWeaveError('INVALID_INPUT');
      }
      this.catalog.resolve(input.caseId,input.decision,actor,input.reason,input.evidence,followUp?.id);
      if(input.decision==='keep_existing')return this.review(candidate.id,'reject',actor,input.reason,null);
      if(input.decision==='unverified')return this.review(candidate.id,'human',actor,input.reason,null);
      if(input.decision==='coexist'){
        this.review(candidate.id,'reject',actor,`${input.reason}\nQualified replacement: ${followUp!.id}`,null);
        this.recordReview(followUp!.id,'resubmitted',actor,`Conflict ${input.caseId}: ${input.reason}`,null);
        return this.get(followUp!.id);
      }
      return this.review(candidate.id,'approve',actor,input.reason,null,undefined,input.decision);
    });
  }
  cancelVersion(candidateId:string,actor:string,reason:string):CandidateRecord{
    return this.transaction(()=>{
      const candidate=this.get(candidateId);if(!candidate.request.change||!['approved','persisting','failed'].includes(candidate.status))throw new MnemoWeaveError('INVALID_STATE');
      const task=this.db.prepare('SELECT * FROM governance_tasks WHERE candidate_id=?').get(candidateId)!;
      if(task['state']==='running'&&this.db.prepare('SELECT id FROM governance_workflow_lock WHERE until_ms>?').get(Date.now()))throw new MnemoWeaveError('INVALID_STATE');
      this.catalog.cancel(candidateId,actor,reason);this.recordReview(candidateId,'reject',actor,`Cancelled unpublished version: ${reason}`,null);
      const runId=randomUUID();const now=new Date().toISOString();
      this.db.prepare('INSERT INTO governance_runs VALUES(?,?,?,?,?)').run(runId,task['id']!,'cancelled',now,now);
      this.db.prepare('INSERT INTO governance_execution_receipts VALUES(?,?,?,?,?,?)').run(randomUUID(),candidateId,task['id']!,runId,JSON.stringify({status:'failed',code:'OPERATION_CANCELLED',uncertain:true,writeKey:task['write_key']}),now);
      this.db.prepare("UPDATE governance_runs SET state='cancelled',ended_at=? WHERE task_id=? AND state='running'").run(now,task['id']!);
      this.db.prepare("UPDATE governance_tasks SET state='cancelled',next_at=NULL,owner=NULL WHERE candidate_id=?").run(candidateId);
      this.status(candidateId,'rejected');return this.get(candidateId);
    });
  }
  /** Large bodies are content-addressed files; the metadata row stores a `blob:<sha256>` marker. */
  private storeBody(content: string): string {
    if (Buffer.byteLength(content, 'utf8') <= BLOB_THRESHOLD_BYTES) return content;
    const hash = createHash('sha256').update(content).digest('hex');
    const staging = join(this.blobsDir, `.tmp-${hash}-${randomUUID()}`);
    writeFileSync(staging, content, 'utf8');
    renameSync(staging, join(this.blobsDir, hash));
    return `blob:${hash}`;
  }
  private loadBody(stored: string): string {
    if (!stored.startsWith('blob:')) return stored;
    const hash = stored.slice(5);
    try {
      const content = readFileSync(join(this.blobsDir, hash), 'utf8');
      if (createHash('sha256').update(content).digest('hex') !== hash) throw new MnemoWeaveError('PROVIDER_INTEGRITY');
      return content;
    } catch (error) {
      if (error instanceof MnemoWeaveError) throw error;
      throw new MnemoWeaveError('PROVIDER_INTEGRITY');
    }
  }
  /** Blob GC: only unreferenced objects older than the grace window are removed. */
  collectBlobs(now: Date = new Date()): number {
    const referenced = new Set(this.db.prepare("SELECT content FROM governance_candidate_bodies WHERE content LIKE 'blob:%'").all().map(row => String(row['content']).slice(5)));
    let removed = 0;
    for (const name of readdirSync(this.blobsDir)) {
      if (referenced.has(name)) continue;
      const path = join(this.blobsDir, name);
      try {
        if (now.getTime() - statSync(path).mtimeMs < BLOB_ORPHAN_GRACE_MS) continue;
        unlinkSync(path); removed++;
      } catch { /* already gone */ }
    }
    return removed;
  }
  /** STORAGE-02: measured over the governance database and its WAL, not the Provider store. */  private databaseBytes(): number {
    let total = 0;
    for (const suffix of ['', '-wal']) {
      try { total += statSync(`${this.dbPath}${suffix}`).size; } catch { /* file not created yet */ }
    }
    return total;
  }
  /** Hard limit rejects new growth; soft limit reports once per process and lets cleanup run. */
  private enforceQuota(): void {
    if (this.quotaHardBytes === undefined) return;
    const usedBytes = this.databaseBytes();
    if (usedBytes >= this.quotaHardBytes) throw new MnemoWeaveError('QUOTA_EXCEEDED');
    if (this.quotaSoftBytes !== undefined && usedBytes >= this.quotaSoftBytes && !this.quotaSoftLogged) {
      this.quotaSoftLogged = true;
      process.stderr.write(`${JSON.stringify({ event: 'quota_soft_exceeded', usedBytes, softBytes: this.quotaSoftBytes })}${String.fromCharCode(10)}`);
    }
  }
  /** Synced version of a logical memory, used as the edit base version. */
  entryVersion(memoryId: string): number {
    return this.memory.entryVersion(memoryId);
  }
  storageStatus(): { usedBytes: number; state: 'ok' | 'soft' | 'hard'; softBytes?: number; hardBytes?: number } {
    const usedBytes = this.databaseBytes();
    const state = this.quotaHardBytes !== undefined && usedBytes >= this.quotaHardBytes ? 'hard' as const
      : this.quotaSoftBytes !== undefined && usedBytes >= this.quotaSoftBytes ? 'soft' as const : 'ok' as const;
    return {
      usedBytes, state,
      ...(this.quotaSoftBytes !== undefined ? { softBytes: this.quotaSoftBytes } : {}),
      ...(this.quotaHardBytes !== undefined ? { hardBytes: this.quotaHardBytes } : {}),
    };
  }
  /**
   * RETENTION-01/02 sweep: event hot→archive→clear lifecycle plus candidate body clearing.
   * Deadlines are computed from planned stage times (state entry / received_at), so delayed
   * sweeps never extend them; skew is reported instead of silently shifting deadlines.
   */
  sweepRetention(now: Date = new Date()): RetentionSweepReport {
    const report: RetentionSweepReport = { archivedEvents: 0, clearedEvents: 0, protectedEvents: 0, clearedCandidates: 0, deferredCandidates: [], planSkewMs: { events: 0, candidates: 0 } };
    this.events.sweepEvents(now, report);
    let maxSkew = 0;
    const clearedBlobs: string[] = [];
    this.transaction(() => {
      const rows = this.db.prepare(`SELECT c.id, c.request_json, c.submitted_at, c.status AS base_status, l.status AS lifecycle_status, l.changed_at
        FROM governance_candidates c LEFT JOIN governance_lifecycle l ON l.candidate_id=c.id`).all();
      for (const row of rows) {
        const candidateId = String(row['id']);
        const status = row['lifecycle_status'] === null ? String(row['base_status']) : String(row['lifecycle_status']);
        if (status !== 'rejected' && status !== 'persisted') { report.deferredCandidates.push({ candidateId, reason: `status_${status}` }); continue; }
        const clearableSince = row['changed_at'] === null ? String(row['submitted_at']) : String(row['changed_at']);
        if (new Date(clearableSince).getTime() > now.getTime() - CANDIDATE_BODY_RETENTION_DAYS * DAY_MS) { report.deferredCandidates.push({ candidateId, reason: 'retention_not_due' }); continue; }
        const activeTask = this.db.prepare("SELECT state FROM governance_tasks WHERE candidate_id=? AND state IN ('queued','running')").get(candidateId);
        if (activeTask) { report.deferredCandidates.push({ candidateId, reason: 'active_task' }); continue; }
        const openReviewTask = this.db.prepare("SELECT id FROM governance_review_tasks WHERE candidate_id=? AND state='open'").get(candidateId);
        if (openReviewTask) { report.deferredCandidates.push({ candidateId, reason: 'review_task' }); continue; }
        const conflictCase = this.db.prepare('SELECT id FROM catalog_conflicts WHERE candidate_id=? OR follow_up_candidate_id=?').get(candidateId, candidateId);
        if (conflictCase) { report.deferredCandidates.push({ candidateId, reason: 'conflict_case_evidence' }); continue; }
        const evidenceRef = this.db.prepare('SELECT event_id FROM session_event_refs WHERE candidate_id=?').get(candidateId);
        if (evidenceRef) { report.deferredCandidates.push({ candidateId, reason: 'protected_evidence' }); continue; }
        // Post-v7 rows already store metadata-only JSON; legacy rows are scrubbed here. Either
        // way the body row is the content authority and is removed with the same transaction.
        const body = this.db.prepare('SELECT content FROM governance_candidate_bodies WHERE candidate_id=?').get(candidateId);
        if (body && String(body['content']).startsWith('blob:')) clearedBlobs.push(String(body['content']).slice(5));
        const request = CandidateRequest.parse(JSON.parse(String(row['request_json'])));
        this.db.prepare('UPDATE governance_candidates SET request_json=?, body_cleared_at=? WHERE id=?')
          .run(JSON.stringify({ ...request, content: '' }), now.toISOString(), candidateId);
        this.db.prepare('DELETE FROM governance_candidate_bodies WHERE candidate_id=?').run(candidateId);
        maxSkew = Math.max(maxSkew, now.getTime() - (new Date(clearableSince).getTime() + CANDIDATE_BODY_RETENTION_DAYS * DAY_MS));
        report.clearedCandidates++;
      }
      report.planSkewMs.candidates = maxSkew;
    });
    for (const hash of clearedBlobs) {
      try { unlinkSync(join(this.blobsDir, hash)); } catch { /* already collected */ }
    }
    this.collectBlobs(now);
    return report;
  }

  close(): void { this.db.close(); }
}
