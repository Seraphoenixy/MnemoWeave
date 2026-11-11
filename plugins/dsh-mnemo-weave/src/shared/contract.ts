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
  applicability: string;
  publishedAt: string;
  content: string;
  entryVersion: number;
  /** Classification of the current revision; absent means it was never recorded. */
  knowledgeType?: string;
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
  knowledgeTypes?: Array<{ value: string; count: number }>;
  /** Entities named by current revisions, in their recorded spelling. */
  entities?: Array<{ value: string; count: number }>;
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
   * Classification recorded for this revision. `knowledgeType` comes from a local Remember;
   * `category`, `importance`, `tags` and `entities` arrive with a synced entry. Absent means it
   * was never recorded — not that it was empty.
   */
  knowledgeType?: string;
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
  applicability: string;
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
  score: number;
  publishedAt: string;
  category?: string;
  knowledgeType?: string;
  tags?: string[];
}

/** Structure-only graph: nodes are memories, edges are catalogued relations. */
export interface UiGraphNode {
  memoryId: string;
  /** A supersede edge points at a retired memory, so those are nodes too. */
  state: 'active' | 'superseded' | 'unverified';
  publishedAt: string;
  category?: string;
  knowledgeType?: string;
  importance?: number;
}

export interface UiGraphEdge {
  relationId: string;
  kind: 'Supersedes' | 'RelatedTo' | 'Conflicts';
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
  /** The score floor this result was filtered with, echoed so the page can explain an empty list. */
  minScore: number;
}

/** `POST /v1/memories`: publish a new formal memory without a review round. */
export interface UiCreateInput {
  content: string;
  /** Required on creation: there is no previous revision to inherit from. */
  knowledgeType: string;
  category?: string;
  importance?: number;
  tags?: string[];
  entities?: string[];
  /**
   * Only the archive branch of a task-organized save needs a project; the formal memory and the
   * runtime rule it can also produce are global.
   */
  projectId?: string;
  reason?: string;
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
  knowledgeType?: string;
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
export interface UiInjection {
  id: string;
  sessionId: string;
  rulesInjected: number;
  rulesOmitted: 'budget_exceeded' | null;
  memoriesInjected: number;
  usedTokens: number;
  createdAt: string;
}

/** One runtime rule: `RuleRecord` from the Server contract. */
export interface UiRule {
  entryId: string;
  body: string;
  enabled: boolean;
  version: number;
  withdrawnAt: string | null;
}

/** `POST /v1/rules`: publish a runtime rule directly, without a review round. */
export interface UiRuleCreateInput {
  body: string;
  enabled?: boolean;
}

/** `PATCH /v1/rules/{ruleId}`: body and enabled state; `baseVersion` refuses a stale write. */
export interface UiRuleEditInput {
  body?: string;
  enabled?: boolean;
  baseVersion?: number;
}

/** One project archive: `ArchiveRecord` from the Server contract. */
export type UiArchiveDraft = Pick<UiArchive, 'projectId' | 'title' | 'body' | 'verification' | 'evidence'>;

export interface UiArchive {
  entryId: string;
  projectId: string;
  title: string;
  body: string;
  source: 'session' | 'tool' | 'user';
  verification: 'verified' | 'open' | 'refuted';
  evidence: string;
  version: number;
  withdrawnAt: string | null;
}

/** One scope of this local Server's sync relationship with the remote sync Server. */
export interface UiSyncScope {
  scope: string;
  cursor: number;
  lastPullAt: string | null;
  lastError: string | null;
  pending: number;
  unknown: number;
  unapplied: number;
}

export interface UiSyncStatus {
  enabled: boolean;
  scopes: UiSyncScope[];
  updatedAt: string;
}

/** Result of one manual sync pass. */
export interface UiSyncPass {
  scopes: string[];
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
}

/** Where a value came from. The settings page shows this beside each field. */
export type UiConfigSource = 'preference' | 'profile' | 'environment' | 'default' | 'missing';

/** Page preferences: browser-only behaviour, saved to the DSH profile. */
export interface UiPreferences {
  defaultTab: string;
  pageSize: number;
  /** The injection wait budget; a session no longer names a project for injection. */
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
  /** Injection settings; applied as a group with the project and budget together. */
  injection: { projectId: string | null; injectTimeoutMs: number; source: UiConfigSource; timeoutSource: UiConfigSource };
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

export type UiSaveResult = { kind: 'formal' | 'runtime' | 'archive'; entryId: string }
  | { kind: 'review'; reason: string } | { kind: 'duplicate' };

export type RpcEndpoint = 'status' | 'memories' | 'memory' | 'create' | 'organizeMemory' | 'skillBacktest' | 'skillConversations' | 'skillReview' | 'edit' | 'withdraw' | 'explore' | 'graph' | 'graph' | 'config' | 'injection' | 'rules' | 'createRule' | 'editRule' | 'saveArchive' | 'archives' | 'sync' | 'syncRefresh' | 'registerTask'
  | 'settings' | 'saveInterface' | 'saveConnection' | 'saveInjection' | 'saveAutoStart' | 'testConnection' | 'testWake';

export interface MemoriesRequest {
  query?: string;
  limit?: number;
  /** Opaque continuation from a previous page. */
  cursor?: string;
  /** Keep only memories whose current revision carries this classification. */
  category?: string;
  knowledgeType?: string;
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
