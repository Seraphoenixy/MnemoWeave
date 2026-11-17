import { createHash } from 'node:crypto'
import { isActivityScope } from '../activity-protocol.ts'
import { validateSyncPassword } from '../auth-protocol.ts'
import { SYNC_BLOB_BYTES, SYNC_MAX_BATCH_BYTES, syncCursor, syncDigest, syncPage, syncScope, type SyncPage, type SyncPush } from '../protocol.ts'
import { loginToSyncServer } from './auth.ts'
import { RemoteSyncConflict, type SyncRemote } from './remote.ts'

export interface SyncSession { token?: string }

/** How many times one request is attempted before the run gives up. */
const ATTEMPTS = 3
/** Waits between attempts: a refused connection often clears in a second. */
const RETRY_MS = [400, 1_200] as const

/**
 * Whether a failed request is worth repeating. A connection that timed out,
 * was refused, or dropped mid-response says nothing about the request itself,
 * so the same request may well succeed; a conflict, a refused password or a
 * malformed page is an answer, and repeating it only repeats the answer.
 */
export function transient(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current !== undefined && depth < 4; depth += 1) {
    const code = typeof current === 'object' && current !== null && 'code' in current ? (current as { code?: unknown }).code : undefined
    if (typeof code === 'string' && /^(?:UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)$/u.test(code)) return true
    // A bare `fetch failed` with no code is still a transport failure.
    if (current instanceof TypeError && current.message === 'fetch failed') return true
    current = typeof current === 'object' && current !== null && 'cause' in current ? (current as { cause?: unknown }).cause : undefined
  }
  return false
}

function wait(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) { reject(signal.reason); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = (): void => { clearTimeout(timer); reject(signal?.reason) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** HTTP transport for the sync protocol. */
export class SyncClient implements SyncRemote {
  private readonly base: URL
  private readonly endpoint: URL
  private readonly scope: string
  constructor(url: string, scope: string, private readonly password: string, private readonly session: SyncSession = {}) {
    const base = new URL(url)
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
    if (base.username || base.password || base.search || base.hash
      || (base.protocol !== 'https:' && !(loopback && base.protocol === 'http:'))) {
      throw new Error('Sync server requires an HTTPS URL or a local loopback HTTP URL')
    }
    validateSyncPassword(password)
    this.base = base
    this.scope = syncScope.parse(scope)
    this.endpoint = new URL(base)
    this.endpoint.pathname = base.pathname.replace(/\/+$/u, '') + '/v1/sync/' + this.scope + '/changes'
  }

  async authenticate(signal?: AbortSignal): Promise<void> {
    this.session.token = await loginToSyncServer(this.base, this.password, signal ?? null)
  }

  async pull(cursor: number, signal?: AbortSignal): Promise<SyncPage> {
    const url = new URL(this.endpoint)
    url.searchParams.set('cursor', String(syncCursor.parse(cursor)))
    const page = syncPage.parse(await this.request(url, { signal: signal ?? null }))
    // A snapshot scope publishes every batch in turn. An activity scope is
    // compacted by its clears, so it may hand back a batch whose cursor is not
    // the one after the requested cursor, or none at all while still reporting a
    // later head; both mean "the events in between were cleared".
    const activity = isActivityScope(this.scope)
    if (page.cursor > page.head || page.batches.some((batch, index) => index > 0 && batch.cursor <= page.batches[index - 1]!.cursor)
      || (!activity && (page.cursor !== cursor + page.batches.length
        || (page.cursor < page.head && page.batches.length === 0)
        || page.batches.some((batch, index) => batch.cursor !== cursor + index + 1)))) {
      throw new Error('Sync server returned a non-contiguous change page')
    }
    return page
  }

  async push(batch: SyncPush, signal?: AbortSignal): Promise<number> {
    const body = JSON.stringify(batch)
    if (Buffer.byteLength(body, 'utf8') > SYNC_MAX_BATCH_BYTES) throw new Error('Sync batch is too large')
    const result = await this.request(this.endpoint, { method: 'POST', body, signal: signal ?? null })
    return syncCursor.parse((result as { cursor?: unknown })?.cursor)
  }

  private blobUrl(digest: string): URL {
    const url = new URL(this.endpoint)
    url.pathname = url.pathname.replace(/changes$/u, 'blobs/' + syncDigest.parse(digest))
    return url
  }

  async uploadBlob(digest: string, bytes: Buffer, signal?: AbortSignal): Promise<void> {
    // Checked here as well as at the server, so an oversized entry names itself
    // instead of failing as a bare HTTP 413 part way through a run.
    if (bytes.length > SYNC_BLOB_BYTES) throw new Error('Sync entry exceeds the 128 MiB file limit (' + bytes.length + ' bytes)')
    const url = this.blobUrl(digest)
    const existing = await this.fetch(url, { method: 'HEAD', signal: signal ?? null })
    if (existing.ok) return
    if (existing.status !== 404) throw new Error('Sync blob check returned HTTP ' + existing.status)
    await this.request(url, { method: 'PUT', body: new Uint8Array(bytes), signal: signal ?? null })
  }

  async downloadBlob(digest: string, signal?: AbortSignal): Promise<Buffer> {
    const response = await this.fetch(this.blobUrl(digest), { signal: signal ?? null })
    if (!response.ok || Number(response.headers.get('content-length')) > SYNC_BLOB_BYTES) {
      throw new Error('Sync blob response is unavailable or too large')
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > SYNC_BLOB_BYTES || createHash('sha256').update(bytes).digest('hex') !== digest) {
      throw new Error('Sync blob digest mismatch')
    }
    return bytes
  }

  private async fetch(url: URL, init: RequestInit): Promise<Response> {
    const send = (token: string) => fetch(url, {
      ...init,
      redirect: 'error',
      headers: { Authorization: 'Bearer ' + token, ...(init.method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
    })
    // One request is attempted a few times when the transport fails, because a
    // sync copies many scopes in sequence: a single timeout half way through
    // leaves the earlier scopes committed and the rest untouched.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.send(send, init)
      } catch (error) {
        if (attempt >= ATTEMPTS - 1 || !transient(error) || init.signal?.aborted === true) throw error
        await wait(RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!, init.signal ?? null)
      }
    }
  }

  /** One attempt, including the one re-authentication a stale token costs. */
  private async send(send: (token: string) => Promise<Response>, init: RequestInit): Promise<Response> {
    const previous = this.session.token
    if (previous !== undefined) {
      const response = await send(previous)
      if (response.status !== 401) return response
      await response.body?.cancel()
      delete this.session.token
    }
    const token = await loginToSyncServer(this.base, this.password, init.signal ?? null)
    this.session.token = token
    return send(token)
  }

  private async request(url: URL, init: RequestInit): Promise<unknown> {
    const response = await this.fetch(url, init)
    const body = await response.text()
    let data: unknown
    let readable = true
    try { data = JSON.parse(body) } catch { readable = false }
    // The server's own `error` is the only thing that says why a batch was
    // refused; reporting the status alone turns a fixable rejection into a
    // number. A response that is not JSON at all — a proxy's error page, say —
    // names its source instead of failing later as a parse error.
    const reason = typeof data === 'object' && data !== null && typeof (data as { error?: unknown }).error === 'string'
      ? (data as { error: string }).error : undefined
    if (response.status === 409) {
      if (!readable) throw new Error('Sync server returned an unreadable conflict response')
      throw new RemoteSyncConflict(syncCursor.parse((data as { cursor?: unknown }).cursor), reason ?? 'Sync conflict')
    }
    if (!response.ok) {
      throw new Error('Sync server returned HTTP ' + response.status + (reason === undefined ? '' : ': ' + reason))
    }
    if (!readable) throw new Error('Sync server returned a response that is not JSON')
    return data
  }
}
