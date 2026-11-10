import { MnemoWeaveError, SyncAccepted, SyncChangeInput, SyncEntry, SyncPullInput, SyncPullPage, SyncScopesOutput, SyncSnapshot } from '../../../core/contracts/src/index.ts';
import type { ErrorCode, SyncAcceptedValue, SyncChangeRequest, SyncEntryValue, SyncPullPageValue, SyncPullRequest, SyncScopesValue, SyncSnapshotValue } from '../../../core/contracts/src/index.ts';
import { VersionConflictError } from '../../../core/application/src/sync.ts';
import type { SyncRemotePort } from '../../../core/application/src/sync.ts';

/**
 * Local Server side of the sync protocol. It never decides versions: the remote
 * assigns them, and every failure keeps the distinction the UI needs — a request
 * that never left the machine is queued and safe to retry, one that timed out
 * after sending has an unknown outcome until a changeId lookup answers.
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

export class SyncClient implements SyncRemotePort {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  readonly deviceId: string;

  constructor(options: SyncClientOptions) {
    const url = options.baseUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) throw new MnemoWeaveError('INVALID_INPUT');
    if (options.token.trim().length < 24) throw new MnemoWeaveError('UNAUTHORIZED');
    this.baseUrl = url;
    this.token = options.token.trim();
    this.deviceId = options.deviceId;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async health(): Promise<SyncHealth> {
    const body = await this.send('/v1/sync/health') as SyncHealth;
    if (body.ready !== true || typeof body.protocol !== 'number') throw new MnemoWeaveError('PROVIDER_PROTOCOL');
    return body;
  }

  async scopes(): Promise<SyncScopesValue> {
    return SyncScopesOutput.parse(await this.send('/v1/sync/scopes'));
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
    const search = new URLSearchParams({ scope: parsed.scope, since: String(parsed.since), limit: String(parsed.limit) });
    return SyncPullPage.parse(await this.send(`/v1/sync/changes?${search.toString()}`));
  }

  /** Port adapter used by the coordinator. */
  push(change: SyncChangeRequest): Promise<SyncAcceptedValue> {
    return this.submitChange(change);
  }

  pull(scope: string, since: number, limit: number): Promise<SyncPullPageValue> {
    return this.pullChanges({ scope, since, limit });
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

  async snapshot(scope: string): Promise<SyncSnapshotValue> {
    return SyncSnapshot.parse(await this.send(`/v1/sync/snapshot?${new URLSearchParams({ scope }).toString()}`));
  }

  private async send(path: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('sync timeout')), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) },
      });
      const text = await response.text();
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
    // The fetch implementation rejects some ports before opening a socket.
    if ((current as { message?: unknown }).message === 'bad port') return true;
    const cause = (current as { cause?: unknown }).cause;
    if (cause) queue.push(cause);
    const errors = (current as { errors?: unknown }).errors;
    if (Array.isArray(errors)) queue.push(...errors);
  }
  return false;
}
