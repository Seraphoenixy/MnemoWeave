import { isIPv4 } from 'node:net';
import { MnemoWeaveError, SYNC_PROTOCOL_HEADER, SYNC_PROTOCOL_VERSION, SyncAccepted, SyncChangeInput, SyncEntry, SyncPullInput, SyncPullPage, SyncSnapshot, SyncStreamsOutput } from '../../../core/contracts/src/index.ts';
import type { ErrorCode, SyncAcceptedValue, SyncChangeRecordValue, SyncChangeRequest, SyncEntryValue, SyncPullPageValue, SyncPullRequest, SyncSnapshotValue, SyncStreamsValue } from '../../../core/contracts/src/index.ts';
import { VersionConflictError } from '../../../core/application/src/sync.ts';
import type { SyncRemotePort } from '../../../core/application/src/sync.ts';

/**
 * Local Server side of the sync protocol. It never decides versions: the remote assigns them, and
 * every failure keeps the distinction the UI needs — a request that never left the machine is
 * queued and safe to retry, one that timed out after sending has an unknown outcome until a
 * changeId lookup answers.
 *
 * Every request names the protocol version. A remote that answers with a mismatch stops the
 * caller from guessing: a protocol-1 remote has no streams, so the answer is an explicit
 * `SYNC_PROTOCOL_MISMATCH` rather than a retry that could half-apply a change.
 */
export class SyncTransportError extends MnemoWeaveError {
  readonly reachedRemote: boolean;
  constructor(reachedRemote: boolean) {
    super('SYNC_UNAVAILABLE');
    this.name = 'SyncTransportError';
    this.reachedRemote = reachedRemote;
  }
}

const KNOWN_CODES: readonly ErrorCode[] = [
  'INVALID_INPUT', 'UNAUTHORIZED', 'NOT_FOUND', 'DEVICE_REVOKED', 'SCOPE_FORBIDDEN',
  'VERSION_CONFLICT', 'CHANGE_ID_REUSED', 'CHANGE_ID_EXPIRED', 'SNAPSHOT_REQUIRED',
  'RULE_CAPACITY_EXCEEDED', 'ARCHIVE_CAPACITY_EXCEEDED',
];

export interface SyncClientOptions {
  baseUrl: string;
  deviceId: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface SyncHealth {
  ready: true;
  protocol: number;
  now: string;
}

export function syncBaseUrl(value: string): string {
  const url = URL.parse(value.trim());
  if (!url || url.username || url.password || url.search || url.hash) throw new MnemoWeaveError('INVALID_INPUT');
  const loopback = url.hostname === '[::1]' || (isIPv4(url.hostname) && url.hostname.startsWith('127.'));
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new MnemoWeaveError('INVALID_INPUT');
  return url.href.replace(/\/+$/, '');
}

export class SyncClient implements SyncRemotePort {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  readonly deviceId: string;

  constructor(options: SyncClientOptions) {
    this.baseUrl = syncBaseUrl(options.baseUrl);
    if (options.token.trim().length < 24) throw new MnemoWeaveError('UNAUTHORIZED');
    this.token = options.token.trim();
    this.deviceId = options.deviceId;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async health(): Promise<SyncHealth> {
    const body = await this.send('/v1/sync/health') as SyncHealth;
    if (body.ready !== true || typeof body.protocol !== 'number') throw new MnemoWeaveError('PROVIDER_PROTOCOL');
    if (body.protocol !== SYNC_PROTOCOL_VERSION) throw new MnemoWeaveError('UNSUPPORTED_VERSION');
    return body;
  }

  async streams(): Promise<SyncStreamsValue> {
    return SyncStreamsOutput.parse(await this.send('/v1/sync/streams'));
  }

  async submitChange(change: SyncChangeRequest): Promise<SyncAcceptedValue> {
    const parsed = SyncChangeInput.parse(change);
    return SyncAccepted.parse(await this.send('/v1/sync/changes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed),
    }));
  }

  async pullChanges(query: SyncPullRequest): Promise<SyncPullPageValue> {
    const parsed = SyncPullInput.parse(query);
    const search = new URLSearchParams({ stream: parsed.stream, since: String(parsed.since), limit: String(parsed.limit) });
    return SyncPullPage.parse(await this.send(`/v1/sync/changes?${search.toString()}`));
  }

  push(change: SyncChangeRequest): Promise<SyncAcceptedValue> { return this.submitChange(change); }

  pull(stream: string, since: number, limit: number): Promise<SyncPullPageValue> {
    return this.pullChanges({ stream, since, limit });
  }

  /** `null` means the remote has no receipt: the change never landed. */
  async receipt(changeId: string): Promise<SyncAcceptedValue | null> {
    try {
      return SyncAccepted.parse(await this.send(`/v1/sync/receipts/${encodeURIComponent(changeId)}`));
    } catch (error) {
      if (error instanceof MnemoWeaveError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async entry(entryId: string): Promise<SyncEntryValue> {
    return SyncEntry.parse(await this.send(`/v1/sync/entries/${encodeURIComponent(entryId)}`));
  }

  async snapshot(stream: string): Promise<SyncSnapshotValue> {
    return SyncSnapshot.parse(await this.send(`/v1/sync/snapshot?${new URLSearchParams({ stream }).toString()}`));
  }

  private async send(path: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('sync timeout')), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.token}`,
          [SYNC_PROTOCOL_HEADER]: String(SYNC_PROTOCOL_VERSION),
          ...(init.headers ?? {}),
        },
      });
      const text = await response.text();
      if (response.status === 409) {
        const parsed = text ? JSON.parse(text) as { code?: unknown } : {};
        if (parsed.code === 'SYNC_PROTOCOL_MISMATCH') throw new MnemoWeaveError('UNSUPPORTED_VERSION');
      }
      const body: unknown = text ? JSON.parse(text) : {};
      if (!response.ok) throw this.mapError(response.status, body);
      return body;
    } catch (error) {
      if (error instanceof MnemoWeaveError) throw error;
      throw new SyncTransportError(!neverLeftMachine(error));
    } finally {
      clearTimeout(timer);
    }
  }

  private mapError(status: number, body: unknown): MnemoWeaveError {
    const code = (body as { code?: unknown } | null)?.code;
    if (code === 'VERSION_CONFLICT') {
      const current = (body as { currentEntry?: unknown }).currentEntry;
      const parsed = SyncEntry.safeParse(current);
      if (parsed.success) return new VersionConflictError(parsed.data);
    }
    if (typeof code === 'string' && (KNOWN_CODES as readonly string[]).includes(code)) return new MnemoWeaveError(code as ErrorCode);
    if (status === 401) return new MnemoWeaveError('UNAUTHORIZED');
    if (status === 403) return new MnemoWeaveError('SCOPE_FORBIDDEN');
    if (status === 404) return new MnemoWeaveError('NOT_FOUND');
    if (status === 400) return new MnemoWeaveError('INVALID_INPUT');
    return new MnemoWeaveError('INTERNAL');
  }
}

/** Connection refused or an unresolvable host means no request bytes were delivered. */
function neverLeftMachine(error: unknown): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return true;
    if ((current as { message?: unknown }).message === 'bad port') return true;
    const cause = (current as { cause?: unknown }).cause;
    if (cause) queue.push(cause);
    const errors = (current as { errors?: unknown }).errors;
    if (Array.isArray(errors)) queue.push(...errors);
  }
  return false;
}
