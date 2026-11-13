/**
 * The wire contract between the MnemoWeave DSH plugin halves.
 *
 * This file is self-contained: the client bundle is built from it and the Host half
 * imports it directly. The shapes mirror the Server contract in
 * `packages/core/contracts/src/index.ts` and the calls in `packages/client/src/index.ts`
 * (`GET /v1/memories`, `GET /v1/memories/{id}`, `PATCH /v1/memories/{id}`, `GET /health/ready`);
 * a server-side shape change belongs there first and then lands here.
 */

// DSH resolves RPC channels as `/name`: `@deepseek-ai/dsh-client-connection` rejects a name that
// does not match /^\/[A-Za-z0-9._~-]+$/ (or that equals "/api") when the Host half registers it.
export const RPC_CHANNEL = '/dsh-mnemo-weave';

export type AvailabilityStatus = 'ok' | 'unauthorized' | 'unavailable';

/**
 * Local Server lifecycle as the memory page reports it.
 *
 * The Server is hosted by the "MnemoWeave Local Server" scheduled task, so DSH can be opened
 * before it is up. `starting` means the task was woken (or is still initialising its memory
 * provider) and the page should keep polling; `connected` means requests can be made now.
 */
export type ServerPhase = 'connected' | 'starting' | 'failed';

/** Why the page shows a failed phase; the codes mirror `ServerProbeFailure` in `packages/client`. */
export type ServerPhaseReason =
  | 'connection_refused'
  | 'timeout'
  | 'address_conflict'
  | 'unauthorized'
  | 'task_missing'
  | 'task_failed';

/** Reported alongside the health status so the page can distinguish "starting" from "broken". */
export interface UiServerPhase {
  phase: ServerPhase;
  reason?: ServerPhaseReason;
  /** Human-readable cause, already safe to show: no paths, stderr or credentials. */
  detail?: string;
  /** True when this attempt asked the scheduled task to run the Server. */
  taskRun: boolean;
}

/** Health plus whether this Host can actually use the Server's memory endpoints. */
export interface UiStatus {
  status: AvailabilityStatus;
  /** The Server error code when `status` is not ok; shown as written, never guessed at. */
  reason?: string;
  serverUrl: string;
  hostId: string;
  checkedAt: string;
  version?: string;
  /** Lifecycle of the local Server this page talks to. */
  server: UiServerPhase;
}

/** One list row: `MemoryListItem` from the Server contract. */
export interface UiMemorySummary {
  memoryId: string;
  revisionId: string;
  providerMemoryId: string;
  publishedAt: string;
  content: string;
  entryVersion: number;
  /** Classification of the current revision; absent means it was never recorded. */
  category?: string;
  importance?: number;
  tags?: string[];
  entities?: string[];
}

/** Orders the list can be scanned in. */
export type ListSort = 'newest' | 'oldest' | 'importance';

export interface UiMemoryList {
  query: string | null;
  limit: number;
  returned: number;
  items: UiMemorySummary[];
  /** Opaque continuation; absent when the scan is exhausted. */
  nextCursor?: string;
  /** Classification values present in the set, with counts, for the filter picker. */
  categories?: Array<{ value: string; count: number }>;
  /** Entities named by current revisions, in their recorded spelling. */
  entities?: Array<{ value: string; count: number }>;
  /**
   * Size of the whole collection, before any query or entity filter.
   *
   * A tab badge that counted `items` would report the filtered size as the library's size.
   */
  total?: number;
}

export interface UiMemoryRevision {
  revisionId: string;
  number: number;
  /** The revision this one replaced; null for the first. Renders the chain, not just a list. */
  parentId: string | null;
  /** sha256 of the body, so a reader can tell two same-looking revisions apart. */
  contentHash: string;
  candidateId: string;
  publishedAt: string;
  effectiveAt: string;
  /**
   * Classification recorded for this revision. Absent means it was never recorded — not that it
   * was empty.
   */
  category?: string;
  importance?: number;
  tags?: string[];
  entities?: string[];
  /** The revision recall and injection currently serve. */
  current: boolean;
  /** The revision this response describes; differs from `current` when reading history. */
  selected: boolean;
}

/** A logical relation the detail view offers to follow; the target may be unreadable. */
export interface UiMemoryRelation {
  relationId: string;
  kind: 'Supersedes' | 'RelatedTo';
  sourceMemoryId: string;
  sourceRevisionId: string;
  targetMemoryId: string;
  targetRevisionId: string;
  effectiveAt: string;
  reason: string;
  /** Why the relation is believed; shown so a supersede is not just an assertion. */
  evidence: string[];
  /** True when the edge also exists in the Provider, not only in this catalog. */
  nativeProjected: boolean;
}

/** One open disagreement about a memory, with the decisions recorded so far. */
export interface UiMemoryConflict {
  caseId: string;
  state: 'open' | 'resolving' | 'resolved' | 'unverified';
  baseRevisionId: string;
  decisions: Array<{ actor: string; decision: string; reason: string; evidence: string[]; createdAt: string }>;
}

/** The selected published revision plus its metadata; `content` is the authoritative text. */
export interface UiMemoryDetail {
  memoryId: string;
  /** The revision this response carries (a historical one when history was requested). */
  revisionId: string;
  /** The live revision, independent of what was selected. */
  currentRevisionId: string;
  isCurrent: boolean;
  providerMemoryId: string;
  state: 'active' | 'superseded' | 'unverified';
  content: string;
  publishedAt: string;
  revisions: UiMemoryRevision[];
  entryVersion: number;
  relations: UiMemoryRelation[];
  conflicts: UiMemoryConflict[];
}

/** One Provider-ranked search hit, already mapped to a memory this machine knows. */
export interface UiExploreHit {
  memoryId: string;
  revisionId: string;
  providerMemoryId: string;
  state: 'active' | 'superseded' | 'unverified';
  content: string;
  /** Present only when the Provider reported a score for this row. */
  score?: number;
  /** Relevance band the Server's policy assigned; the page groups on it, never on the number. */
  relevance?: 'high' | 'medium' | 'low' | 'unknown';
  publishedAt: string;
  category?: string;
  tags?: string[];
}

/**
 * One node of the relation graph.
 *
 * Memories and entities share the drawing: an entity node is the same shape of thing to a reader —
 * something several memories point at — and drawing entities as nodes is what shows how memories
 * cluster. A node is a memory unless `kind` says otherwise.
 */
export interface UiGraphNode {
  /** The memory id, or the entity name for an entity node. */
  memoryId: string;
  kind?: 'memory' | 'entity';
  /** A supersede edge points at a retired memory, so those are nodes too. */
  state: 'active' | 'superseded' | 'unverified';
  publishedAt: string;
  category?: string;
  importance?: number;
  /** Memory content or the entity name, whichever the node stands for. */
  label?: string;
  /** How many memories name this entity; absent for a memory node. */
  occurrenceCount?: number;
}

export interface UiGraphEdge {
  relationId: string;
  /**
   * `Entity` is drawn from the Provider's own index rather than a catalogued decision: it records
   * that two memories share an entity, which no review produced.
   */
  kind: 'Supersedes' | 'RelatedTo' | 'Conflicts' | 'Entity';
  sourceMemoryId: string;
  targetMemoryId: string;
  reason: string;
  effectiveAt: string;
}

export interface UiGraph {
  nodes: UiGraphNode[];
  edges: UiGraphEdge[];
  /** True when the node cap was reached, so this is a subset of the catalog. */
  truncated: boolean;
}

export interface UiExplore {
  query: string;
  hits: UiExploreHit[];
  /** Provider hits that were never published here; counted, never shown as if openable. */
  unregistered: number;
  /** True when the page filled its limit, so a larger limit may reveal more. */
  truncated: boolean;
}

/** `POST /v1/memories`: publish a new formal memory without a review round. */
export interface UiCreateInput {
  content: string;
  /** Classification for the first revision; absent means none is recorded. */
  category?: string;
  importance?: number;
  tags?: string[];
  entities?: string[];
  reason?: string;
  /** Which memory class a task-organized save writes; the user chooses it in the form. */
  target?: 'formal-memory' | 'workspace-archive' | 'rule';
}

export interface UiCreateResult {
  memoryId: string;
  revisionId: string;
  providerMemoryId: string;
  contentHash: string;
  entryVersion: number;
}

/** `PATCH /v1/memories/{id}` body; the Server appends a new revision and moves the pointer. */
export interface UiEditInput {
  memoryId: string;
  content: string;
  reason?: string;
  /** Base version shown to the user; the Server rejects the edit when it moved. */
  entryVersion: number;
  /** Omitted fields are inherited from the revision being edited. */
  category?: string;
  importance?: number;
  /** An empty array clears the tags; omitting the field keeps them. */
  tags?: string[];
}

/** `POST /v1/memories/{id}/withdraw`: recall and injection stop serving it, history stays. */
export interface UiWithdrawInput {
  memoryId: string;
  reason: string;
  entryVersion: number;
}
export interface UiWithdrawResult {
  memoryId: string;
  revisionId: string;
  entryVersion: number;
  withdrawnAt: string;
}
export interface UiEditResult {
  memoryId: string;
  revisionId: string;
  providerMemoryId: string;
  contentHash: string;
  entryVersion: number;
}

/** Outcome of asking to register the local Server task (one elevation prompt). */
export type UiRegisterResult = 'registered' | 'already_registered' | 'denied' | 'failed';
export interface UiRegisterTest {
  result: UiRegisterResult;
  /** Why it failed, or what the system said; shown as written. */
  detail?: string;
}

/** What the last View for this host delivered; `null` when the host never injected. */
/** Last injection result: how many rules the resident block carried, and why it failed if it did. */
export interface UiInjection {
  id: string;
  sessionId: string;
  ruleCount: number;
  usedBytes: number;
  failure?: 'deadline' | 'output_limit' | 'request_failed';
  createdAt: string;
}

/** One runtime rule: `RuleRecord` from the Server contract. */
export interface UiEmbeddingDiagnostics {
  provider: 'mnemon';
  model: string;
  protocol: string;
  serviceAvailable: boolean;
  modelAvailable: boolean;
  embedded: number;
  total: number;
  coverage: number;
  recallMode: 'semantic' | 'keyword' | 'unknown';
  degraded: boolean;
  lastError: string | null;
  checkedAt: string;
  /** Latest vector backfill job, when one has ever run. */
  backfill?: UiDiagnosticJob | null;
}

export interface UiIdleReviewSignal {
  id: string; sessionId: string; turnId: number; eventId: string; text: string;
  reason: 'correction' | 'standing-instruction' | 'durable-fact'; createdAt: string;
}

export interface UiIdleReviewItem {
  index: number; action: 'create' | 'edit' | 'remove' | 'skip';
  kind: 'rule' | 'workspace-archive' | 'formal-memory';
  state: 'applied' | 'failed' | 'skipped'; targetId?: string; detail?: Record<string, unknown>;
}

export interface UiSkillEntry {
  name: string; description: string; path: string; root: string;
  scope: 'project' | 'user'; hash: string; bodyBytes: number; shadowedBy?: string;
}

export interface UiSkillReport {
  items: UiSkillEntry[];
  invalid: Array<{ path: string; reason: string }>;
  roots: string[];
}

export interface UiSkillVersion {
  id: string; hash: string; savedAt: string; source: 'adopt' | 'restore';
}

export interface UiSkillWrite { hash: string; version: UiSkillVersion }

export interface UiSkillCreateResult { path: string; hash: string }



export interface UiSkillDraft {
  id: string;
  /** The workspace the review ran in; a draft keeps pointing at it after switching projects. */
  workspace: string;
  /** The skill file the draft was reviewed against, or null for a new skill. */
  skillPath: string | null;
  createdAt: string;
  reason: string;
  evidence: Array<{ step: number; role: 'user' | 'assistant'; text: string }>;
  baseline: string;
  candidate: string;
  scenario: string;
  checks: string[];
  report: SkillBacktestResult | null;
  backtestError: string | null;
  adoptedAt: string | null;
  dismissedAt: string | null;
}

export interface UiSkillText { text: string; hash: string }

export interface UiTrashEntry {
  id: string; name: string; originalPath: string; root: string; removedAt: string;
}

export interface UiOrganizeItem {
  index: number;
  action: 'create' | 'edit' | 'withdraw' | 'skip';
  state: 'applied' | 'failed' | 'skipped';
  targetId?: string;
  detail?: Record<string, unknown>;
}

export interface UiOrganizeResult { items: UiOrganizeItem[] }

/**
 * One proposed operation of an organize plan.
 *
 * `before` is the text the Agent was shown for an edit or a withdrawal, and `content` is what it
 * proposes to write; showing both is what makes individual confirmation meaningful.
 */
export interface UiOrganizePlanItem {
  index: number;
  action: 'create' | 'edit' | 'withdraw' | 'skip';
  reason: string;
  targetId?: string;
  entryVersion?: number;
  before?: string;
  content?: string;
}

export interface UiOrganizePlan { items: UiOrganizePlanItem[] }

export interface UiIdleReviewRun {  id: string; sessionId: string; state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  attempt: number; startedAt: string; finishedAt: string | null; error: string | null; items: UiIdleReviewItem[];
}

/** One condition that stopped an idle review before any run existed. */
export interface UiIdleSkip {
  sessionId: string;
  reason: 'no-route' | 'no-evidence' | 'paused' | 'cooldown' | 'attempts' | 'idle' | 'score';
  detail?: string;
  at: string;
}

/** One write action as the Server reports it; `queued` and `unknown` still need a follow-up. */
export interface WriteTaskOutcome {
  taskId: string;
  index: number;
  kind: 'formal-memory' | 'rule' | 'workspace-archive';
  action: 'create' | 'edit' | 'withdraw' | 'remove' | 'skip';
  status: 'published' | 'duplicate' | 'applied' | 'skipped' | 'needs_review' | 'queued' | 'unknown' | 'failed';
  memoryId: string | null;
  entryId: string | null;
  entryVersion: number | null;
  candidateId: string | null;
  errorCode: string | null;
  updatedAt: string;
}

/** One outstanding action, joined with what the Host recorded when it submitted it. */
export interface UiPendingWrite {
  taskId: string;
  index: number;
  kind: 'formal-memory' | 'rule' | 'workspace-archive';
  action: 'create' | 'edit' | 'withdraw' | 'remove' | 'skip';
  /** `pending` means the Host never learned the outcome; asking the Server resolves it. */
  status: WriteTaskOutcome['status'] | 'pending';
  /** What was submitted, so the same request can be sent under the same key. */
  request: Record<string, unknown>;
  /** The text the user confirmed at submit time, when the trigger has one. */
  confirmation?: { text: string; baseVersion?: number };
  entryId?: string;
  memoryId?: string;
  entryVersion?: number;
  candidateId?: string;
  errorCode?: string;
  updatedAt: string;
}

export interface UiDiagnosticJob {  state: 'running' | 'succeeded' | 'failed' | 'interrupted';
  startedAt: string;
  finishedAt: string | null;
  detail?: Record<string, unknown>;
  id?: string;
  kind?: string;
}

export interface UiRule {
  entryId: string;
  body: string;
  enabled: boolean;
  version: number;
  withdrawnAt: string | null;
  importance: 'critical' | 'normal' | 'low';
  pinned: boolean;
  bodyBytes: number;
}

export interface UiRuleUsage {
  limitBytes: number;
  itemMaxBytes: number;
  usedBytes: number;
  entryCount: number;
  exceeded: boolean;
  overByBytes: number;
}

/** `POST /v1/rules`: publish a runtime rule directly, without a review round. */
export interface UiRuleCreateInput {
  body: string;
  enabled?: boolean;
  importance?: 'critical' | 'normal' | 'low';
  pinned?: boolean;
}

/** `PATCH /v1/rules/{ruleId}`: body and state; `baseVersion` is the version the editor read. */
export interface UiRuleEditInput {
  body?: string;
  enabled?: boolean;
  importance?: 'critical' | 'normal' | 'low';
  pinned?: boolean;
  /** Removing appends a version and takes the text out of the resident set. */
  remove?: true;
  baseVersion: number;
}

/** One project archive: `ArchiveRecord` from the Server contract. */
export type UiArchiveDraft = Pick<UiArchive, 'workspaceId' | 'title' | 'body' | 'verification' | 'evidence'>;

export interface UiArchive {
  entryId: string;
  workspaceId: string;
  title: string;
  body: string;
  source: 'session' | 'tool' | 'user';
  verification: 'verified' | 'open' | 'refuted';
  evidence: string;
  version: number;
  withdrawnAt: string | null;
  state: 'active' | 'archived';
  archivedAt: string | null;
  bodyBytes: number;
}

export interface UiArchiveCapacity {
  workspaceId: string;
  activeBytes: number;
  limitBytes: number;
  activeCount: number;
  archivedCount: number;
  exceeded: boolean;
}

/** One archive offered for capacity release, oldest-confirmed first. */
export interface UiArchiveReleaseCandidate {
  entryId: string;
  title: string;
  bodyBytes: number;
  version: number;
  updatedAt: string;
}

/** Capacity maintenance view: what would free room, plus the current capacity. */
export interface UiArchiveReleaseCandidates {
  workspaceId: string;
  capacity: UiArchiveCapacity;
  items: UiArchiveReleaseCandidate[];
  remaining: number;
}

export interface UiArchiveSearchHit {
  entryId: string;
  workspaceId: string;
  title: string;
  state: 'active' | 'archived';
  version: number;
  verification: 'verified' | 'open' | 'refuted';
  excerpt: string;
  excerptChars: number;
  excerptTruncated: boolean;
  bodyChars: number;
  score: number;
}

export interface UiArchiveSearch {
  query: string;
  total: number;
  results: UiArchiveSearchHit[];
  totalChars: number;
  truncated: boolean;
  totalLimitChars: number;
  callsLimit: number;
}

/** One stored version of an archive; the body is complete, not an excerpt. */
export interface UiArchiveHistory {
  revisionId: string;
  entryId: string;
  workspaceId: string;
  version: number;
  title: string;
  body: string;
  state: 'active' | 'archived';
  recordedAt: string;
}

/**
 * A distillation preview: the draft text the user is about to share, its classification, and the
 * source version it was derived from. Nothing has been published at this point.
 */
export interface UiDistillationDraft {
  kind: 'draft';
  draftId: string;
  source: { workspaceId: string; entryId: string; entryVersion: number; contentHash: string };
  content: string;
  category?: string;
  importance?: number;
  tags?: string[];
  entities?: string[];
  reason: string;
  assessment: 'supported' | 'uncertain' | 'conflict';
  /** The part of the source body the draft was produced from, as a character range. */
  usedRange: { start: number; end: number; truncated: boolean };
  /** Present when a task was already created for this draft. */
  taskId?: string;
}

/** A distillation that produced no draft; the reason is shown to the user. */
export interface UiDistillationSkip {
  kind: 'skip';
  reason: string;
}

/** One published or pending result of a confirmed distillation. */
export interface UiDistillationResult {
  kind: 'receipt';
  taskId: string;
  index: number;
  status: 'published' | 'duplicate' | 'queued' | 'unknown' | 'needs_review' | 'failed' | 'applied';
  memoryId?: string;
  entryVersion?: number;
  candidateId?: string;
  errorCode?: string;
}

/** One registered workspace; a host sees the id and name, never a local path. */
export interface UiWorkspace {
  workspaceId: string;
  name: string;
  createdAt: string;
  /** Present only for an operator view: how many local roots are bound. */
  boundRootCount?: number;
}

/** One stream of this local Server's sync relationship with the remote sync Server. */
export interface UiSyncStream {
  stream: string;
  cursor: number;
  lastPullAt: string | null;
  lastError: string | null;
  pending: number;
  unknown: number;
  unapplied: number;
}

export interface UiSyncStatus {
  enabled: boolean;
  /**
   * Why the status is unavailable, as a stable reason rather than an error code.
   *
   * `REVIEW_REQUIRED` is what the Server answers when no remote sync is configured: a normal
   * state, not a fault. It arrives as an RPC failure, and the Host RPC layer re-wraps thrown
   * errors without their code, so the page could only ever show a generic failure. Reporting the
   * reason as data keeps the distinction the Server already makes.
   */
  unavailableReason?: 'not-configured' | 'unauthorized' | 'unreachable';
  protocol: number;
  streams: UiSyncStream[];
  updatedAt: string;
}

/** Result of one manual sync pass. */
export interface UiSyncPass {
  streams: string[];
  pulled: number;
  applied: number;
  errors: string[];
  skipped: boolean;
}

/** What the Host half is configured with; never the token itself. */
export interface UiConfigView {
  serverUrl: string;
  hostId: string;
  hasToken: boolean;
  /** Which layer supplied each value, so the page can say who manages it. */
  sources?: Record<string, string>;
  /**
   * The build identity of the Host half, so the page can compare it with its own.
   *
   * The two halves are loaded at different moments — the Host when DSH starts, the page when it
   * is fetched — so they can disagree without anything failing at load time. Reporting it here is
   * what turns that into a stated fact instead of a missing button.
   */
  hostBuild?: string;
}

/** Where a value came from. The settings page shows this beside each field. */
export type UiConfigSource = 'preference' | 'profile' | 'environment' | 'default' | 'missing';

/** Page preferences: browser-only behaviour, saved to the DSH profile. */
export interface UiPreferences {
  defaultTab: string;
  pageSize: number;
  /** The injection wait budget; a session names no project and no memory for injection. */
  injectTimeoutMs: number;
  autoStart: boolean;
}

/** The whole settings surface, grouped the way the page presents it. */
export interface UiSettings {
  /** Interface preferences, applied immediately. */
  interface: { defaultTab: string; pageSize: number; source: UiConfigSource };
  /** Local connection: address and Host identity, applied after a successful test. */
  connection: { serverUrl: string; hostId: string; source: UiConfigSource; hostSource: UiConfigSource };
  /** Token presence and the last authentication result; the value is never returned. */
  credential: {
    configured: boolean;
    source: UiConfigSource;
    lastAuth: 'ok' | 'unauthorized' | 'unavailable' | 'unknown';
  };
  /** Local Server auto-start on a refused connection. */
  autoStart: { enabled: boolean; taskName: string; source: UiConfigSource };
  /** Injection settings: the wait budget and the optional explicit workspace binding. */
  injection: { workspaceId: string | null; injectTimeoutMs: number; source: UiConfigSource; timeoutSource: UiConfigSource };
  /** Read-only diagnostics; the settings page's sync section owns the actions. */
  diagnostics: { serverReady: boolean; providerReady: boolean; syncEnabled: boolean; settingsPath: string };
}

/** Outcome of a connection test: distinct causes stay distinct. */
export type UiConnectionTestReason = 'ok' | 'unauthorized' | 'address_conflict' | 'connection_refused' | 'invalid';

export interface UiConnectionTest {
  ok: boolean;
  reason: UiConnectionTestReason;
  /** Server service identity when the endpoint answered; absent when it did not. */
  service?: string;
  detail?: string;
}

/** Outcome of asking the scheduled task to start the local Server. */
export type UiWakeResult = 'already_running' | 'woken' | 'task_missing' | 'timeout' | 'failed';

export interface UiWakeTest {
  result: UiWakeResult;
  detail?: string;
}

export interface RpcOk<T> { ok: true; value: T }
export interface RpcFailure { ok: false; error: { message: string; code?: string } }
export type RpcResult<T> = RpcOk<T> | RpcFailure;

export type SkillReviewResult = { kind: 'none' } | {
  kind: 'draft';
  input: SkillBacktestInput;
  reason: string;
  evidence: { step: number; role: 'user' | 'assistant'; text: string }[];
  report?: SkillBacktestResult;
  backtestError?: string;
};
export interface SkillBacktestInput { baseline: string; candidate: string; scenario: string; checks: string[] }
export interface SkillBacktestSide {
  answer: string;
  steps: string;
  checks: { passed: boolean; reason: string }[];
}
export interface SkillBacktestResult {
  baseline: SkillBacktestSide;
  candidate: SkillBacktestSide;
  regressions: string[];
}

export type UiSaveResult = { kind: 'formal' | 'rule' | 'workspace-archive'; entryId: string }
  | { kind: 'review'; reason: string } | { kind: 'duplicate' };

export type RpcEndpoint = 'status' | 'memories' | 'memory' | 'create' | 'organizeMemory' | 'skillBacktest' | 'skillConversations' | 'skillReview' | 'edit' | 'withdraw' | 'explore' | 'graph' | 'config' | 'injection' | 'rules' | 'ruleUsage' | 'saveRuleLimits' | 'createRule' | 'editRule' | 'saveArchive' | 'archives' | 'archiveCapacities' | 'archiveSearch' | 'archiveHistory' | 'setArchiveState' | 'workspaces' | 'sync' | 'syncRefresh' | 'registerTask'
  | 'settings' | 'saveInterface' | 'saveConnection' | 'saveInjection' | 'saveAutoStart' | 'testConnection' | 'testWake';

export interface MemoriesRequest {
  query?: string;
  limit?: number;
  /** Opaque continuation from a previous page. */
  cursor?: string;
  /** Keep only memories whose current revision carries this classification. */
  category?: string;
  /** Case-insensitive match against an entity named by the current revision. */
  entity?: string;
  /** Scan order; a cursor only applies to the order it was issued for. */
  sort?: ListSort;
}
export interface MemoryRequest {
  memoryId: string;
  /** Omit for the current revision; supply one to read a historical version. */
  revisionId?: string;
}

export function isRpcOk<T>(result: RpcResult<T>): result is RpcOk<T> {
  return result.ok === true && Object.hasOwn(result, 'value');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
