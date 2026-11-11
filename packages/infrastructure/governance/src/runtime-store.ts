import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CaptureOutput, MnemoWeaveError, PinInput } from '../../../core/contracts/src/index.ts';
import type { HostEventRecord, PinRecord, RuntimeContext, RememberRequest } from '../../../core/contracts/src/index.ts';
import type { RuntimeRepository, CaptureGateway } from '../../../core/application/src/runtime.ts';
import { utf8Prefix } from '../../../core/application/src/view.ts';

type Transaction = <T>(operation: () => T) => T;
type Entry = RuntimeContext['entries'][number];
const RETENTION_MS = 7 * 86_400_000;

/** Owns bounded, provisional session material and formal-memory references, never formal text. */
export class SqliteRuntime implements RuntimeRepository {
  private readonly db: DatabaseSync;
  private readonly transaction: Transaction;
  private readonly submit: (request: RememberRequest) => { id: string };
  private readonly protectEvidence: (hostId: string, event: HostEventRecord, candidateId: string) => void;
  constructor(db: DatabaseSync, transaction: Transaction, submit: (request: RememberRequest) => { id: string }, protectEvidence: (hostId: string, event: HostEventRecord, candidateId: string) => void) { this.db = db; this.transaction = transaction; this.submit = submit; this.protectEvidence = protectEvidence; }
  register(projectId: string): void {
    if (!projectId.trim() || projectId.length > 200 || projectId === '*') throw new MnemoWeaveError('INVALID_INPUT');
    this.db.prepare('INSERT OR IGNORE INTO runtime_projects VALUES(?)').run(projectId);
  }
  registered(projectId: string): boolean { return !!this.db.prepare('SELECT id FROM runtime_projects WHERE id=?').get(projectId); }
  pin(input: PinRecord): void {
    const pin = PinInput.parse(input);
    if (pin.projectId && !this.registered(pin.projectId)) throw new MnemoWeaveError('INVALID_INPUT');
    const identity = JSON.stringify([pin.scope, pin.projectId ?? '', pin.hostId ?? '', pin.sessionId ?? '', pin.memoryId]);
    this.transaction(() => {
      this.db.prepare('DELETE FROM runtime_pins WHERE id=?').run(identity);
      if (!pin.remove) this.db.prepare('INSERT INTO runtime_pins VALUES(?,?)').run(identity, JSON.stringify(pin));
    });
  }
  context(hostId: string, sessionId: string, projectId?: string, task?: string): RuntimeContext {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM runtime_sessions WHERE host_id=? AND session_id=?').get(hostId, sessionId);
      let entries: Entry[] = row && Number(row['updated_ms']) > Date.now() - RETENTION_MS ? JSON.parse(String(row['entries_json'])) as Entry[] : [];
      const previousProject = row?.['project_id'] ? String(row['project_id']) : undefined;
      if (projectId && previousProject && projectId !== previousProject) throw new MnemoWeaveError('INVALID_STATE');
      const project = projectId ?? previousProject;
      if (project && !this.registered(project)) throw new MnemoWeaveError('INVALID_INPUT');
      const previousTask = row && Number(row['updated_ms']) > Date.now() - RETENTION_MS && row['task'] ? String(row['task']) : null;
      const currentTask = task ?? previousTask;
      const revision = Number(row?.['revision'] ?? 0) + (task !== undefined && task !== previousTask || projectId !== undefined && projectId !== previousProject ? 1 : 0);
      const closed = row?.['closed'] === 1;
      if (!row || revision !== Number(row['revision'])) {
        this.db.prepare(`INSERT INTO runtime_sessions VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(host_id,session_id) DO UPDATE SET project_id=excluded.project_id,task=excluded.task,revision=excluded.revision,updated_ms=excluded.updated_ms`)
          .run(hostId, sessionId, project ?? null, currentTask, JSON.stringify(entries), revision, closed ? 1 : 0, Date.now(), 'idle');
      }
      const pins = this.db.prepare('SELECT pin_json FROM runtime_pins ORDER BY id').all().map(value => PinInput.parse(JSON.parse(String(value['pin_json'])))).filter(pin =>
        pin.scope === 'global' || pin.scope === 'project' && pin.projectId === project || pin.scope === 'host' && pin.hostId === hostId || pin.scope === 'session' && pin.hostId === hostId && pin.sessionId === sessionId);
      return { sessionId, ...(project ? { projectId: project } : {}), task: currentTask, revision, closed, entries, pins: pins.map(({ memoryId, tier }) => ({ memoryId, tier })), capture: String(row?.['capture_state'] ?? 'idle') };
    });
  }
  observe(hostId: string, event: HostEventRecord): void {
    this.transaction(() => {
      const eventHash = createHash('sha256').update(JSON.stringify({ sessionId: event.sessionId, projectId: event.projectId, kind: event.kind, payload: event.payload })).digest('hex');
      const existing = this.db.prepare('SELECT event_hash FROM runtime_event_ids WHERE host_id=? AND event_id=?').get(hostId, event.eventId);
      if (existing) { if (existing['event_hash'] !== eventHash) throw new MnemoWeaveError('IDEMPOTENCY_CONFLICT'); return; }
      const context = this.context(hostId, event.sessionId, event.projectId ?? undefined);
      if (context.closed) throw new MnemoWeaveError('INVALID_STATE');
      this.db.prepare('INSERT INTO runtime_event_ids VALUES(?,?,?,?)').run(hostId, event.eventId, Date.now(), eventHash);
      const text = typeof event.payload.text === 'string' ? event.payload.text : '';
      const forget = event.kind === 'message.user' && /(?:do not remember|don't remember|不要记住|不要记录|别记住)/i.test(text);
      let entries = context.entries;
      let task = context.task;
      if (forget) {
        this.db.prepare("DELETE FROM runtime_user_events WHERE host_id=? AND json_extract(event_json,'$.sessionId')=?").run(hostId, event.sessionId);
        entries = []; task = null;
        this.db.prepare("UPDATE runtime_capture_tasks SET state='cancelled',input_json='[]' WHERE host_id=? AND session_id=? AND state!='succeeded'").run(hostId, event.sessionId);
      } else if (event.kind === 'message.user' && text.trim()) {
        this.db.prepare('INSERT OR IGNORE INTO runtime_user_events VALUES(?,?,?,?)').run(hostId, event.eventId, JSON.stringify(event), Date.now());
        entries = [...entries, { eventId: event.eventId, text: utf8Prefix(text, 2000), kind: 'user' as const }].slice(-12);
        while (Buffer.byteLength(JSON.stringify(entries), 'utf8') > 8000) entries.shift();
        if (!/^(?:继续|继续吧|好的|好|continue|go on|yes|ok)[。.!！\s]*$/i.test(text.trim())) task = utf8Prefix(text, 2000);
      } else if (event.kind === 'tool.completed' && event.payload.outcome === 'failure') {
        entries = [...entries, { eventId: event.eventId, text: `Tool failed: ${String(event.payload.toolName ?? 'unknown')}`, kind: 'tool' as const }].slice(-12);
      }
      const capture = forget ? 'cancelled' : context.capture;
      this.db.prepare("DELETE FROM runtime_user_events WHERE host_id=? AND json_extract(event_json,'$.sessionId')=? AND event_id NOT IN (SELECT json_extract(value,'$.eventId') FROM json_each(?)) AND event_id NOT IN (SELECT json_extract(e.value,'$.eventId') FROM runtime_capture_tasks t,json_each(t.input_json) e WHERE t.host_id=? AND t.session_id=? AND t.state IN ('queued','running','failed'))").run(hostId, event.sessionId, JSON.stringify(entries), hostId, event.sessionId);
      this.db.prepare('UPDATE runtime_sessions SET entries_json=?,task=?,revision=revision+1,updated_ms=?,capture_state=? WHERE host_id=? AND session_id=?')
        .run(JSON.stringify(entries), task, Date.now(), capture, hostId, event.sessionId);
      if (['message.assistant.final', 'session.ended'].includes(event.kind) && entries.some(entry => entry.kind === 'user')) {
        const users = entries.filter(entry => entry.kind === 'user');
        const hash = createHash('sha256').update(JSON.stringify([hostId, event.sessionId, users])).digest('hex');
        this.db.prepare("INSERT OR IGNORE INTO runtime_capture_tasks(id,host_id,session_id,project_id,input_json,state,owner,until_ms,attempts,next_ms,created_ms) VALUES(?,?,?,?,?,'queued',NULL,0,0,0,?)")
          .run(hash, hostId, event.sessionId, context.projectId ?? null, JSON.stringify(users), Date.now());
        this.db.prepare("UPDATE runtime_sessions SET capture_state='queued' WHERE host_id=? AND session_id=?").run(hostId, event.sessionId);
      }
      if (event.kind === 'session.ended') this.closeSession(hostId, event.sessionId);
    });
  }
  closeSession(hostId: string, sessionId: string): void {
    this.db.prepare('UPDATE runtime_sessions SET closed=1,revision=revision+1 WHERE host_id=? AND session_id=?').run(hostId, sessionId);
  }
  private assertCaptureScope(_hostId: string, projectId: string | undefined): void {
    // No per-host grants any more: the only scope rule left is an explicitly registered project.
    if (projectId !== undefined && !this.registered(projectId)) throw new MnemoWeaveError('UNAUTHORIZED');
  }
  /**
   * Runs retention housekeeping for runtime capture.
   *
   * The Server no longer extracts candidates from session events: extraction was a model call,
   * and the decision is that semantic judgement belongs to the host's own session model, which
   * proposes candidates through `remember` while the conversation runs. A queued capture task
   * is therefore reported as `awaiting_model` — meaning the host's model, not a Server-side one.
   * The gateway parameter stays so a caller cannot silently start extraction again by wiring a
   * route; it is always passed `undefined` from composition.
   */
  async tick(gateway: CaptureGateway | undefined): Promise<void> {
    const now = Date.now();
    this.transaction(() => {
      this.db.prepare("UPDATE runtime_capture_tasks SET input_json='[]',state=CASE WHEN state='succeeded' THEN state ELSE 'cancelled' END WHERE created_ms<?").run(now - RETENTION_MS);
      this.db.prepare("UPDATE runtime_sessions SET entries_json='[]',task=NULL WHERE updated_ms<?").run(now - RETENTION_MS);
      this.db.prepare('DELETE FROM runtime_event_ids WHERE created_ms<?').run(now - RETENTION_MS);
      this.db.prepare('DELETE FROM runtime_user_events WHERE created_ms<?').run(now - RETENTION_MS);
    });
    if (!gateway) {
      this.db.prepare("UPDATE runtime_sessions SET capture_state='awaiting_model' WHERE capture_state='queued'").run();
      return;
    }
    const owner = randomUUID();
    const task = this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM runtime_capture_tasks WHERE ((state IN ('queued','failed') AND next_ms<=?) OR (state='running' AND until_ms<?)) AND created_ms>=? ORDER BY created_ms LIMIT 1").get(now, now, now - RETENTION_MS);
      if (!row) return undefined;
      const runId = randomUUID();
      this.db.prepare("UPDATE runtime_capture_tasks SET state='running',owner=?,until_ms=?,attempts=attempts+1 WHERE id=?").run(owner, now + 360_000, String(row['id']));
      this.db.prepare("INSERT INTO runtime_capture_runs VALUES(?,?,?,'running',?,NULL)").run(runId, String(row['id']), owner, now);
      return Object.assign(row, { runId });
    });
    if (!task) return;
    try {
      this.assertCaptureScope(String(task['host_id']), task['project_id'] ? String(task['project_id']) : undefined);
      const entries = JSON.parse(String(task['input_json'])) as Entry[];
      const result = CaptureOutput.parse(await gateway.capture('memory-capture', entries));
      const ids = new Set(entries.map(entry => entry.eventId));
      if (result.candidates.some(candidate => candidate.eventIds.some(id => !ids.has(id)))) throw new MnemoWeaveError('PROVIDER_PROTOCOL');
      this.transaction(() => {
        const live = this.db.prepare("SELECT state,owner,until_ms FROM runtime_capture_tasks WHERE id=?").get(String(task['id']));
        if (live?.['state'] !== 'running' || live['owner'] !== owner || Number(live['until_ms']) <= Date.now()) throw new MnemoWeaveError('INVALID_STATE');
        this.assertCaptureScope(String(task['host_id']), task['project_id'] ? String(task['project_id']) : undefined);
        const candidate = result.candidates[0];
        let reference: string | null = null;
        // Unknown project identity cannot silently promote the fact to Global.
        if (candidate && !task['project_id']) throw new MnemoWeaveError('REVIEW_REQUIRED');
        if (candidate) reference = this.submit({
          idempotencyKey: `capture_${String(task['id'])}`, content: candidate.content, knowledgeType: 'Practice', tags: ['capture'], scope: 'project', projectId: String(task['project_id']),
          provenance: { source: 'runtime-capture', sourceReference: `session:${String(task['session_id'])}`, evidence: candidate.eventIds.map(id => `event:${String(task['host_id'])}:${id}`), verificationStatus: 'unverified', confidence: 0.5, applicability: `Project ${String(task['project_id'])}`, limitations: 'Model-extracted user statement; technical correctness has not been independently verified.', lastVerified: null },
        }).id;
        if (reference && candidate) for (const id of candidate.eventIds) {
          const evidence = this.db.prepare('SELECT event_json FROM runtime_user_events WHERE host_id=? AND event_id=?').get(String(task['host_id']), id);
          if (!evidence) throw new MnemoWeaveError('REVIEW_REQUIRED');
          this.protectEvidence(String(task['host_id']), JSON.parse(String(evidence['event_json'])) as HostEventRecord, reference);
        }
        this.db.prepare("UPDATE runtime_capture_tasks SET state='succeeded',input_json='[]' WHERE id=?").run(String(task['id']));
        this.db.prepare("UPDATE runtime_capture_runs SET state='succeeded',ended_ms=? WHERE id=?").run(Date.now(), task.runId);
        this.db.prepare('INSERT INTO runtime_capture_receipts VALUES(?,?,?,?,?)').run(randomUUID(), String(task['id']), task.runId, JSON.stringify({ status: 'candidate', candidateId: reference }), Date.now());
        this.db.prepare("UPDATE runtime_sessions SET capture_state='completed' WHERE host_id=? AND session_id=?").run(String(task['host_id']), String(task['session_id']));
      });
    } catch (error) {
      this.transaction(() => {
        const state = error instanceof MnemoWeaveError && ['UNAUTHORIZED', 'REVIEW_REQUIRED', 'PROVIDER_PROTOCOL'].includes(error.code) ? 'needs_review' : 'failed';
        const updated = this.db.prepare("UPDATE runtime_capture_tasks SET state=?,next_ms=? WHERE id=? AND owner=? AND state='running'").run(state, Date.now() + Math.min(900_000, 2000 * 2 ** Math.min(20, Number(task['attempts']))), String(task['id']), owner);
        this.db.prepare("UPDATE runtime_capture_runs SET state='failed',ended_ms=? WHERE id=?").run(Date.now(), task.runId);
        this.db.prepare('INSERT INTO runtime_capture_receipts VALUES(?,?,?,?,?)').run(randomUUID(), String(task['id']), task.runId, JSON.stringify({ status: 'failed', code: error instanceof MnemoWeaveError ? error.code : 'PROVIDER_UNAVAILABLE' }), Date.now());
        if (updated.changes) this.db.prepare("UPDATE runtime_sessions SET capture_state=? WHERE host_id=? AND session_id=?").run(state, String(task['host_id']), String(task['session_id']));
      });
    }
  }
}
