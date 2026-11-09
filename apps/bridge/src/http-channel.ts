import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MnemoWeaveError } from '../../../packages/core/contracts/src/index.ts';
import type { ReadGrantRecord } from '../../../packages/core/contracts/src/index.ts';
import { Bridge } from '../../../packages/bridge/src/index.ts';
import type { SyncChannel } from '../../../packages/bridge/src/index.ts';

/** HTTP transport for the accepted sync protocol (WP7 wiring; same machine, service token). */
export class HttpSyncChannel implements SyncChannel {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly hostId: string;
  private readonly snapshotDir: string;
  constructor(baseUrl: string, token: string, hostId: string, snapshotDir: string) {
    this.baseUrl = baseUrl; this.token = token; this.hostId = hostId; this.snapshotDir = snapshotDir;
    mkdirSync(snapshotDir, { recursive: true });
  }
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      signal: AbortSignal.timeout(10_000),
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        'x-mnemoweave-host': this.hostId,
        ...(init.headers ?? {}),
      },
    });
    return response;
  }
  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.request(path, init);
    const body = await response.json() as { code?: string } & Record<string, unknown>;
    if (!response.ok) throw new MnemoWeaveError((body.code as MnemoWeaveError['code']) ?? 'PROVIDER_UNAVAILABLE');
    return body as T;
  }
  async runtimeContext(input: { sessionId: string; projectId?: string; task?: string }) {
    return this.json<import('../../../packages/core/contracts/src/index.ts').RuntimeContext>('/v1/runtime/context', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(300) });
  }
  async changes(sinceSeq: number): Promise<{ changes: import('../../../packages/bridge/src/index.ts').SyncChange[]; windowOldestSeq: number; latestSeq: number }> {
    return this.json(`/v1/sync/changes?since=${encodeURIComponent(String(sinceSeq))}`);
  }
  async snapshot(): Promise<{ path: string; latestSeq: number }> {
    const response = await this.request('/v1/sync/snapshot');
    if (!response.ok) throw new MnemoWeaveError('PROVIDER_UNAVAILABLE');
    const latestSeq = Number(response.headers.get('x-sync-latest-seq') ?? '0');
    const path = join(this.snapshotDir, `snapshot-${randomUUID()}.db`);
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
    return { path, latestSeq };
  }
  async partitionSummaries(): Promise<{ memoryId: string; currentRevisionId: string; contentHashes: string[] }[]> {
    return this.json('/v1/sync/verify');
  }
  /** Pairing fetch: the grant itself is issued by an operator over /v1/sync/grant (AUTH-04). */
  async issueGrant(_hostId: string): Promise<ReadGrantRecord> {
    return this.json<ReadGrantRecord>('/v1/sync/grant');
  }
  async licenseWatermark(): Promise<number> {
    return (await this.json<{ watermark: number }>('/v1/sync/watermark', { signal: AbortSignal.timeout(250) })).watermark;
  }
  async isRevoked(hostId: string): Promise<boolean> {
    return (await this.json<{ revoked: boolean }>('/v1/sync/watermark', { signal: AbortSignal.timeout(250) })).revoked;
  }
  async submitIntent(hostId: string, intent: { intentId: string; kind: string; payload: Record<string, unknown>; baselineRef: string | undefined }): Promise<{ status: 'accepted' | 'isolated'; reference?: string }> {
    return this.json('/v1/sync/intents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(intent) });
  }
}

export function bridgeFromEnv(env: NodeJS.ProcessEnv = process.env): {
  bridge: Bridge; intervalMs: number;
  serverUrl: string; token: string; hostId: string;
  injectionPort: number; injectionToken: string;
  uiPort: number; uiToken: string | undefined;
} {
  const Config = parseBridgeEnv(env);
  const channel = new HttpSyncChannel(Config.MNEMOWEAVE_SERVER, Config.MNEMOWEAVE_TOKEN, Config.MNEMOWEAVE_BRIDGE_HOST_ID, join(Config.MNEMOWEAVE_BRIDGE_DIR, 'snapshots'));
  const bridge = new Bridge(Config.MNEMOWEAVE_BRIDGE_DIR, Config.MNEMOWEAVE_BRIDGE_HOST_ID, channel, Config.MNEMOWEAVE_MIN_FREE_BYTES === undefined ? {} : { minFreeBytes: Config.MNEMOWEAVE_MIN_FREE_BYTES });
  return {
    bridge, intervalMs: Config.MNEMOWEAVE_SYNC_INTERVAL_MS,
    serverUrl: Config.MNEMOWEAVE_SERVER, token: Config.MNEMOWEAVE_TOKEN, hostId: Config.MNEMOWEAVE_BRIDGE_HOST_ID,
    injectionPort: Config.MNEMOWEAVE_BRIDGE_PORT,
    injectionToken: Config.MNEMOWEAVE_BRIDGE_TOKEN ?? Config.MNEMOWEAVE_TOKEN,
    uiPort: Config.MNEMOWEAVE_BRIDGE_UI_PORT,
    uiToken: Config.MNEMOWEAVE_BRIDGE_UI_TOKEN,
  };
}

// Inline config parsing keeps the entry self-contained; all values are explicit env vars.
function parseBridgeEnv(env: NodeJS.ProcessEnv): { MNEMOWEAVE_SERVER: string; MNEMOWEAVE_TOKEN: string; MNEMOWEAVE_BRIDGE_DIR: string; MNEMOWEAVE_BRIDGE_HOST_ID: string; MNEMOWEAVE_SYNC_INTERVAL_MS: number; MNEMOWEAVE_MIN_FREE_BYTES: number | undefined; MNEMOWEAVE_BRIDGE_PORT: number; MNEMOWEAVE_BRIDGE_TOKEN: string | undefined; MNEMOWEAVE_BRIDGE_UI_PORT: number; MNEMOWEAVE_BRIDGE_UI_TOKEN: string | undefined } {
  const fail = (message: string): never => { throw new Error(message); };
  const server = env.MNEMOWEAVE_SERVER ?? fail('MNEMOWEAVE_SERVER is required');
  const token = env.MNEMOWEAVE_TOKEN ?? fail('MNEMOWEAVE_TOKEN is required');
  const dir = env.MNEMOWEAVE_BRIDGE_DIR ?? fail('MNEMOWEAVE_BRIDGE_DIR is required');
  const hostId = env.MNEMOWEAVE_BRIDGE_HOST_ID ?? fail('MNEMOWEAVE_BRIDGE_HOST_ID is required');
  if (token.length < 24) fail('MNEMOWEAVE_TOKEN must contain at least 24 characters');
  if (!/^https?:\/\//.test(server)) fail('MNEMOWEAVE_SERVER must be an HTTP(S) URL');
  const injectionToken = env.MNEMOWEAVE_BRIDGE_TOKEN;
  if (injectionToken !== undefined && injectionToken.length < 24) fail('MNEMOWEAVE_BRIDGE_TOKEN must contain at least 24 characters');
  const injectionPort = Number(env.MNEMOWEAVE_BRIDGE_PORT ?? 4318);
  if (!Number.isInteger(injectionPort) || injectionPort < 1 || injectionPort > 65535) fail('MNEMOWEAVE_BRIDGE_PORT must be an integer between 1 and 65535');
  // The UI endpoint is read-only and opt-in: without a separate token it never listens.
  const uiToken = env.MNEMOWEAVE_BRIDGE_UI_TOKEN;
  if (uiToken !== undefined && uiToken.length < 24) fail('MNEMOWEAVE_BRIDGE_UI_TOKEN must contain at least 24 characters');
  if (uiToken !== undefined && uiToken === token) fail('MNEMOWEAVE_BRIDGE_UI_TOKEN must differ from MNEMOWEAVE_TOKEN');
  const uiPort = Number(env.MNEMOWEAVE_BRIDGE_UI_PORT ?? 4319);
  if (!Number.isInteger(uiPort) || uiPort < 1 || uiPort > 65535) fail('MNEMOWEAVE_BRIDGE_UI_PORT must be an integer between 1 and 65535');
  if (uiPort === injectionPort) fail('MNEMOWEAVE_BRIDGE_UI_PORT must differ from MNEMOWEAVE_BRIDGE_PORT');
  return {
    MNEMOWEAVE_SERVER: server.replace(/\/$/, ''), MNEMOWEAVE_TOKEN: token,
    MNEMOWEAVE_BRIDGE_DIR: dir, MNEMOWEAVE_BRIDGE_HOST_ID: hostId,
    MNEMOWEAVE_SYNC_INTERVAL_MS: Math.max(1_000, Number(env.MNEMOWEAVE_SYNC_INTERVAL_MS ?? 30_000)), // SYNC-04
    MNEMOWEAVE_MIN_FREE_BYTES: env.MNEMOWEAVE_MIN_FREE_BYTES === undefined ? undefined : Number(env.MNEMOWEAVE_MIN_FREE_BYTES),
    MNEMOWEAVE_BRIDGE_PORT: injectionPort,
    MNEMOWEAVE_BRIDGE_TOKEN: injectionToken,
    MNEMOWEAVE_BRIDGE_UI_PORT: uiPort,
    MNEMOWEAVE_BRIDGE_UI_TOKEN: uiToken,
  };
}
