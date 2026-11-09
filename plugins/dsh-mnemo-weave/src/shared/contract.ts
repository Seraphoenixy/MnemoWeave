/**
 * The wire contract between the MnemoWeave DSH plugin halves and the Bridge UI API.
 *
 * This file is self-contained: the client bundle is built from it and the host entry
 * imports it directly, so neither needs the MnemoWeave workspace at runtime. Types
 * mirror `packages/bridge/src/ui-read.ts` (UI API v1); a shape change bumps
 * `UI_API_VERSION` on both sides.
 */

// DSH resolves RPC channels as `/name`: `@deepseek-ai/dsh-client-connection` rejects a name that
// does not match /^\/[A-Za-z0-9._~-]+$/ (or that equals "/api") when the Host half registers it.
export const RPC_CHANNEL = '/dsh-mnemo-weave';
export const UI_API_VERSION = 1 as const;

export type AvailabilityStatus = 'ok' | 'unauthorized' | 'unavailable' | 'corrupted';

export interface UiGrantView {
  grantId: string;
  projects: string[];
  globalIncluded: boolean;
  issuedAt: string;
  expiresAt: string;
  generation: number;
  expired: boolean;
  revoked: boolean;
}

export interface UiReplicaView {
  available: boolean;
  corrupted: boolean;
  appliedSeq: number;
  generation: number;
  dataTime: string;
  verifiedAt: string | null;
  stale: boolean;
  pendingContent: number;
  memories: number;
  revisions: number;
}

export interface UiStatus {
  schemaVersion: number;
  hostId: string;
  generatedAt: string;
  paired: boolean;
  grant: UiGrantView | null;
  replica: UiReplicaView | null;
  intents: { queued: number; isolated: number };
}

export interface UiMemorySummary {
  memoryId: string;
  revisionId: string;
  state: 'active' | 'superseded' | 'unverified';
  scope: 'project' | 'global';
  projectId?: string;
  applicability: string;
  revisionNumber: number;
  providerMemoryId: string;
  publishedAt: string;
  excerpt: string;
  contentLength: number;
}

export interface UiMemoryList {
  status: AvailabilityStatus;
  reason?: string;
  query: string | null;
  scope: 'project' | 'global' | null;
  projectId: string | null;
  total: number;
  returned: number;
  complete: boolean;
  dataTime: string | null;
  items: UiMemorySummary[];
}

export interface UiRevision {
  status: AvailabilityStatus;
  reason?: string;
  memoryId: string;
  revisionId: string;
  number: number;
  publishedAt: string;
  effectiveAt: string;
  current: boolean;
  content: string | null;
}

/** What the Host half is configured with; never the token itself. */
export interface UiConfigView {
  bridgeUrl: string;
  hostId: string | null;
  timeoutMs: number;
  hasToken: boolean;
}

export interface UiMemoryRevision {
  revisionId: string;
  number: number;
  publishedAt: string;
  effectiveAt: string;
  current: boolean;
}

export interface UiMemoryRelation {
  id: string;
  kind: string;
  targetMemoryId: string;
  reason: string;
  effectiveAt: string;
}

export interface UiMemoryDetail {
  status: AvailabilityStatus;
  reason?: string;
  memoryId: string;
  revisionId: string | null;
  state: 'active' | 'superseded' | 'unverified';
  scope: 'project' | 'global';
  projectId?: string;
  applicability: string;
  content: string | null;
  revisions: UiMemoryRevision[];
  relations: UiMemoryRelation[];
}

export interface UiIntent {
  intentId: string;
  kind: string;
  state: 'queued' | 'acknowledged' | 'isolated';
  createdAt: string;
  sessionId?: string;
  receiptRef?: string;
}

export interface UiIntents {
  status: AvailabilityStatus;
  reason?: string;
  queued: number;
  isolated: number;
  items: UiIntent[];
}

export interface RpcOk<T> { ok: true; value: T }
export interface RpcFailure { ok: false; error: { message: string; code?: string } }
export type RpcResult<T> = RpcOk<T> | RpcFailure;

export type RpcEndpoint = 'status' | 'config' | 'memories' | 'memory' | 'revision' | 'intents';

export interface MemoriesRequest { query?: string; limit?: number; scope?: 'project' | 'global'; projectId?: string }
export interface MemoryRequest { memoryId: string }
export interface RevisionRequest { memoryId: string; revisionId: string }

export function isRpcOk<T>(result: RpcResult<T>): result is RpcOk<T> {
  return result.ok === true && Object.hasOwn(result, 'value');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
