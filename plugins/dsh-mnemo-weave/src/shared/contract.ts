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

/** Health plus whether this Host can actually use the Server's memory endpoints. */
export interface UiStatus {
  status: AvailabilityStatus;
  /** The Server error code when `status` is not ok; shown as written, never guessed at. */
  reason?: string;
  serverUrl: string;
  hostId: string;
  checkedAt: string;
  version?: string;
}

/** One list row: `MemoryListItem` from the Server contract. */
export interface UiMemorySummary {
  memoryId: string;
  revisionId: string;
  providerMemoryId: string;
  scope: 'project' | 'global';
  projectId?: string;
  applicability: string;
  publishedAt: string;
  content: string;
  entryVersion: number;
}

export interface UiMemoryList {
  query: string | null;
  limit: number;
  returned: number;
  items: UiMemorySummary[];
}

export interface UiMemoryRevision {
  revisionId: string;
  number: number;
  publishedAt: string;
  effectiveAt: string;
  current: boolean;
}

/** The selected published revision plus its metadata; `content` is the authoritative text. */
export interface UiMemoryDetail {
  memoryId: string;
  revisionId: string;
  providerMemoryId: string;
  scope: 'project' | 'global';
  projectId?: string;
  applicability: string;
  state: 'active' | 'superseded' | 'unverified';
  content: string;
  publishedAt: string;
  revisions: UiMemoryRevision[];
  entryVersion: number;
}

/** `PATCH /v1/memories/{id}` body; the Server appends a new revision and moves the pointer. */
export interface UiEditInput {
  memoryId: string;
  content: string;
  reason?: string;
  /** Base version shown to the user; the Server rejects the edit when it moved. */
  entryVersion: number;
}

export interface UiEditResult {
  memoryId: string;
  revisionId: string;
  providerMemoryId: string;
  contentHash: string;
  entryVersion: number;
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
  scope: 'global' | 'project';
  projectId: string | null;
  body: string;
  enabled: boolean;
  version: number;
  withdrawnAt: string | null;
}

/** One project archive: `ArchiveRecord` from the Server contract. */
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
}

export interface RpcOk<T> { ok: true; value: T }
export interface RpcFailure { ok: false; error: { message: string; code?: string } }
export type RpcResult<T> = RpcOk<T> | RpcFailure;

export type RpcEndpoint = 'status' | 'memories' | 'memory' | 'edit' | 'config' | 'injection' | 'rules' | 'archives' | 'sync' | 'syncRefresh';

export interface MemoriesRequest { query?: string; limit?: number }
export interface MemoryRequest { memoryId: string }

export function isRpcOk<T>(result: RpcResult<T>): result is RpcOk<T> {
  return result.ok === true && Object.hasOwn(result, 'value');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
