/**
 * The v23 schema as one baseline script, for a database that does not exist yet.
 *
 * A fresh database used to be created at v1 and then walked through all 22 migration steps, and
 * every step first wrote a `VACUUM INTO` snapshot. On an empty database there is no data to
 * protect, so those 22 snapshots were pure cost: creating one scratch store took about 29 seconds
 * and left 22 files behind, and the test suite creates dozens of stores per run.
 *
 * The migration chain is still the authority for every existing database; this file only states
 * where that chain ends up. `schema-baseline.test.ts` keeps the two in agreement by migrating a
 * v1 database through the chain and comparing the resulting structure with this baseline, so a new
 * migration that forgets to update the baseline fails that test instead of silently producing two
 * different v23 shapes.
 *
 * Generated from the migration chain; edit it together with the migration that changed the shape.
 */
export const SCHEMA_V23: readonly string[] = [
  // 1
  `CREATE TABLE archive_distillations(draft_id TEXT PRIMARY KEY,host_id TEXT NOT NULL,workspace_id TEXT NOT NULL,entry_id TEXT NOT NULL,entry_version INTEGER NOT NULL,source_content_hash TEXT NOT NULL,content TEXT NOT NULL,category TEXT,importance INTEGER,tags_json TEXT,entities_json TEXT,reason TEXT NOT NULL,assessment TEXT NOT NULL,content_hash TEXT NOT NULL,created_at TEXT NOT NULL,task_id TEXT) STRICT`,
  // The v21→v22 archive migration writes this backup only when a legacy `project_id` column is
  // present; a database created at v23 still matches the migration chain by having it empty.
  `CREATE TABLE archive_project_backup(entry_id TEXT PRIMARY KEY, project_id TEXT NOT NULL) STRICT`,
  // 3
  `CREATE TABLE catalog_conflict_decisions(id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES catalog_conflicts(id),actor TEXT NOT NULL,decision TEXT NOT NULL,reason TEXT NOT NULL,evidence_json TEXT NOT NULL,created_at TEXT NOT NULL)`,
  // 4
  `CREATE TABLE catalog_conflicts(id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL UNIQUE REFERENCES governance_candidates(id),target_memory_id TEXT NOT NULL REFERENCES catalog_memories(id),base_revision_id TEXT NOT NULL REFERENCES catalog_revisions(id),state TEXT NOT NULL,follow_up_candidate_id TEXT REFERENCES governance_candidates(id))`,
  // 5
  `CREATE TABLE catalog_memories( id TEXT PRIMARY KEY, current_revision_id TEXT, state TEXT NOT NULL CHECK(state IN ('active','superseded','unverified')), scope TEXT NOT NULL ) STRICT`,
  // 6
  `CREATE TABLE catalog_operations(id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL UNIQUE REFERENCES governance_candidates(id),plan_json TEXT NOT NULL,checkpoint_json TEXT NOT NULL,state TEXT NOT NULL)`,
  // 7
  `CREATE TABLE catalog_relations(id TEXT PRIMARY KEY,kind TEXT NOT NULL,source_memory_id TEXT NOT NULL REFERENCES catalog_memories(id),source_revision_id TEXT NOT NULL REFERENCES catalog_revisions(id),target_memory_id TEXT NOT NULL REFERENCES catalog_memories(id),target_revision_id TEXT NOT NULL REFERENCES catalog_revisions(id),effective_at TEXT NOT NULL,reason TEXT NOT NULL,evidence_json TEXT NOT NULL,native_projected INTEGER NOT NULL)`,
  // 8
  `CREATE TABLE catalog_reservations(memory_id TEXT PRIMARY KEY REFERENCES catalog_memories(id),operation_id TEXT NOT NULL UNIQUE REFERENCES catalog_operations(id))`,
  // 9
  `CREATE TABLE catalog_revisions( id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES catalog_memories(id), revision_number INTEGER NOT NULL, parent_id TEXT REFERENCES catalog_revisions(id), provider_memory_id TEXT NOT NULL, content_hash TEXT NOT NULL, candidate_id TEXT NOT NULL UNIQUE REFERENCES governance_candidates(id), published_at TEXT NOT NULL, effective_at TEXT NOT NULL, scope TEXT, category TEXT, importance INTEGER, tags_json TEXT, entities_json TEXT, UNIQUE(memory_id,revision_number) ) STRICT`,
  // 10
  `CREATE TABLE diagnostic_jobs( id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, detail_json TEXT NOT NULL DEFAULT '{}' )`,
  // 11
  `CREATE TABLE entry_versions(entry_id TEXT PRIMARY KEY, version INTEGER NOT NULL, updated_at TEXT NOT NULL)`,
  // 12
  `CREATE TABLE formal_map(entry_id TEXT NOT NULL, version INTEGER NOT NULL, provider_id TEXT, content_hash TEXT NOT NULL, state TEXT NOT NULL, applied_at TEXT, PRIMARY KEY(entry_id, version))`,
  // 13
  `CREATE TABLE governance_candidate_bodies(candidate_id TEXT PRIMARY KEY REFERENCES governance_candidates(id), content TEXT NOT NULL, content_hash TEXT NOT NULL)`,
  // 14
  `CREATE TABLE governance_candidates ( id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, request_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status='pending_review'), submitted_at TEXT NOT NULL , body_cleared_at TEXT) STRICT`,
  // 15
  `CREATE TABLE governance_execution_receipts(id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES governance_candidates(id), task_id TEXT NOT NULL REFERENCES governance_tasks(id), run_id TEXT NOT NULL REFERENCES governance_runs(id), result_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
  // 16
  `CREATE TABLE governance_lifecycle(candidate_id TEXT PRIMARY KEY REFERENCES governance_candidates(id), status TEXT NOT NULL, changed_at TEXT)`,
  // 17
  `CREATE TABLE "governance_outbox"(id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES governance_tasks(id))`,
  // 18
  `CREATE TABLE governance_provider_binding(id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL)`,
  // 19
  `CREATE TABLE governance_review_tasks(id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL UNIQUE REFERENCES governance_candidates(id), kind TEXT NOT NULL, state TEXT NOT NULL)`,
  // 20
  `CREATE TABLE governance_reviews(id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES governance_candidates(id), decision TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL, assessment_json TEXT, created_at TEXT NOT NULL)`,
  // 21
  `CREATE TABLE governance_runs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES governance_tasks(id), state TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT)`,
  // 22
  `CREATE TABLE governance_submission_receipts ( id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL UNIQUE REFERENCES governance_candidates(id), status TEXT NOT NULL CHECK(status='candidate') ) STRICT`,
  // 23
  `CREATE TABLE governance_tasks(id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL UNIQUE REFERENCES governance_candidates(id), write_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL, checkpoint TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER, owner TEXT, first_failed_at INTEGER, alerted_at INTEGER)`,
  // 24
  `CREATE TABLE governance_workflow_lock(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, until_ms INTEGER NOT NULL)`,
  // 25
  // The single lock row is part of the empty-database shape, not migration data.
  `INSERT INTO governance_workflow_lock(id, owner, until_ms) VALUES(1, NULL, 0)`,
  // 26
  `CREATE TABLE idle_review_runs( id TEXT PRIMARY KEY, host_id TEXT NOT NULL, session_id TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, error TEXT NOT NULL DEFAULT '', items_json TEXT NOT NULL DEFAULT '[]', signal_ids_json TEXT NOT NULL DEFAULT '[]' )`,
  // 27
  `CREATE TABLE idle_review_signals( id TEXT PRIMARY KEY, host_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id INTEGER NOT NULL, event_id TEXT NOT NULL, text TEXT NOT NULL, project_id TEXT, reason TEXT NOT NULL, created_at TEXT NOT NULL, run_id TEXT, UNIQUE(host_id, session_id, event_id) )`,
  // 28
  `CREATE TABLE idle_review_state( host_id TEXT NOT NULL, session_id TEXT NOT NULL, last_turn INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(host_id, session_id) )`,
  // 29
  `CREATE TABLE legacy_formal_pending(memory_id TEXT PRIMARY KEY) STRICT`,
  // 30
  `CREATE TABLE legacy_project_owners( memory_id TEXT PRIMARY KEY, project_id TEXT NOT NULL ) STRICT`,
  // 31
  `CREATE TABLE legacy_sync_inbox_backup(scope TEXT NOT NULL, seq INTEGER NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(scope, seq)) STRICT`,
  // 32
  `CREATE TABLE legacy_sync_outbox_backup(change_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL) STRICT`,
  // 33
  `CREATE TABLE project_archive_revisions( revision_id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, version INTEGER NOT NULL, workspace_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, source TEXT NOT NULL, verification TEXT NOT NULL, evidence TEXT NOT NULL, state TEXT NOT NULL, archived_at TEXT, recorded_at TEXT NOT NULL, UNIQUE(entry_id, version) )`,
  // 34
  `CREATE TABLE project_archives(entry_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, source TEXT NOT NULL, verification TEXT NOT NULL, evidence TEXT NOT NULL, version INTEGER NOT NULL, withdrawn_at TEXT, updated_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active', archived_at TEXT)`,
  // 35
  `CREATE TABLE project_bindings(project_id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  // 40
  `CREATE TABLE runtime_injections(id TEXT PRIMARY KEY, host_id TEXT NOT NULL, session_id TEXT NOT NULL, outcome_json TEXT NOT NULL, created_ms INTEGER NOT NULL)`,
  // 43
  `CREATE TABLE runtime_rule_archive( archive_id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, rule_version INTEGER NOT NULL, body TEXT NOT NULL, importance TEXT NOT NULL, pinned INTEGER NOT NULL, archived_at TEXT NOT NULL, reason TEXT NOT NULL, UNIQUE(rule_id, rule_version) )`,
  // 44
  `CREATE TABLE runtime_rules(entry_id TEXT PRIMARY KEY, body TEXT NOT NULL, scope TEXT NOT NULL, project_id TEXT, enabled INTEGER NOT NULL, version INTEGER NOT NULL, withdrawn_at TEXT, updated_at TEXT NOT NULL, importance TEXT NOT NULL DEFAULT 'normal', pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT '', archived_at TEXT)`,
  // 47
  `CREATE TABLE session_event_refs(host_id TEXT NOT NULL, event_id TEXT NOT NULL, candidate_id TEXT NOT NULL REFERENCES governance_candidates(id), PRIMARY KEY(host_id,event_id,candidate_id))`,
  // 48
  `CREATE TABLE session_events(host_id TEXT NOT NULL, event_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT, project_id TEXT, kind TEXT NOT NULL CHECK(kind IN ('session.started','session.ended','message.user','message.assistant.final','tool.completed')), occurred_at TEXT NOT NULL, received_at TEXT NOT NULL, source_ref TEXT NOT NULL, adapter_version TEXT NOT NULL, protocol_version TEXT NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('hot','archived','cleared')), important INTEGER NOT NULL DEFAULT 0, protected_reason TEXT, archived_at TEXT, inferred INTEGER NOT NULL DEFAULT 0, payload_json TEXT NOT NULL, PRIMARY KEY(host_id,event_id))`,
  // 49
  `CREATE TABLE session_workspaces( host_id TEXT NOT NULL, session_id TEXT NOT NULL, workspace_id TEXT REFERENCES workspaces(workspace_id), bound_at TEXT NOT NULL, PRIMARY KEY(host_id, session_id) ) STRICT`,
  // 50
  `CREATE TABLE share_outbox( memory_id TEXT PRIMARY KEY, version INTEGER NOT NULL, provider_id TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, scope TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','confirmed','failed')), attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL )`,
  // 51
  `CREATE TABLE "sync_inbox"(stream TEXT NOT NULL, seq INTEGER NOT NULL, change_id TEXT NOT NULL, entry_id TEXT NOT NULL, version INTEGER NOT NULL, operation TEXT NOT NULL, entry_json TEXT NOT NULL, state TEXT NOT NULL, error TEXT, received_at TEXT NOT NULL, PRIMARY KEY(stream, seq))`,
  // 52
  `CREATE TABLE "sync_outbox"(change_id TEXT PRIMARY KEY, stream TEXT NOT NULL, entry_id TEXT NOT NULL, base_version INTEGER NOT NULL, operation TEXT NOT NULL, entry_json TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  // 53
  `CREATE TABLE "sync_state"(stream TEXT PRIMARY KEY, cursor INTEGER NOT NULL, last_pull_at TEXT, last_error TEXT)`,
  // 54
  `CREATE TABLE turn_event_ids( host_id TEXT NOT NULL, event_id TEXT NOT NULL, event_hash TEXT NOT NULL, created_ms INTEGER NOT NULL, PRIMARY KEY(host_id, event_id) ) STRICT`,
  // 55
  `CREATE TABLE turn_messages( host_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, event_id TEXT NOT NULL, text TEXT NOT NULL, no_retention INTEGER NOT NULL, created_ms INTEGER NOT NULL, PRIMARY KEY(host_id, event_id) ) STRICT`,
  // 56
  `CREATE TABLE turn_no_retention( host_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, created_ms INTEGER NOT NULL, PRIMARY KEY(host_id, session_id, turn_id) ) STRICT`,
  // 57
  `CREATE TABLE turn_sessions( host_id TEXT NOT NULL, session_id TEXT NOT NULL, closed INTEGER NOT NULL, updated_ms INTEGER NOT NULL, PRIMARY KEY(host_id, session_id) ) STRICT`,
  // 58
  `CREATE TABLE workspace_bindings( workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id), root_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, PRIMARY KEY(workspace_id, root_path) ) STRICT`,
  // 59
  `CREATE TABLE workspaces( workspace_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL ) STRICT`,
  // 60
  `CREATE TABLE write_task_receipts( host_id TEXT NOT NULL, task_id TEXT NOT NULL, action_index INTEGER NOT NULL, kind TEXT NOT NULL, action TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL, memory_id TEXT, entry_version INTEGER, entry_id TEXT, candidate_id TEXT, error_code TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(host_id, task_id, action_index) ) STRICT`,
  // 61
  `CREATE INDEX diagnostic_jobs_kind ON diagnostic_jobs(kind, started_at)`,
  // 62
  // 63
  `CREATE INDEX idle_review_runs_session ON idle_review_runs(host_id, session_id, started_at)`,
  // 64
  `CREATE INDEX idle_review_signals_run ON idle_review_signals(host_id, run_id)`,
  // 65
  `CREATE INDEX idle_review_signals_session ON idle_review_signals(host_id, session_id, turn_id)`,
  // 66
  `CREATE INDEX project_archive_revisions_entry ON project_archive_revisions(entry_id, version)`,
  // 67
  `CREATE INDEX project_archives_state ON project_archives(workspace_id, state)`,
  // 68
  `CREATE INDEX runtime_injections_created ON runtime_injections(created_ms)`,
  // 69
  `CREATE INDEX runtime_rules_active ON runtime_rules(archived_at, enabled)`,
  // 70
  `CREATE INDEX share_outbox_state ON share_outbox(state)`,
  // 71
  `CREATE INDEX sync_outbox_streams_state ON "sync_outbox"(state)`,
  // 72
  `CREATE INDEX turn_messages_session ON turn_messages(host_id, session_id, created_ms)`,
  // 73
  `CREATE TRIGGER catalog_operation_plan_immutable BEFORE UPDATE OF plan_json ON catalog_operations BEGIN SELECT RAISE(ABORT,'Operation plan is immutable'); END`,
  // 74
  `CREATE TRIGGER catalog_revisions_immutable_delete BEFORE DELETE ON catalog_revisions BEGIN SELECT RAISE(ABORT,'Revision is immutable'); END`,
  // 75
  `CREATE TRIGGER catalog_revisions_immutable_update BEFORE UPDATE ON catalog_revisions BEGIN SELECT RAISE(ABORT,'Revision is immutable'); END`,
];
