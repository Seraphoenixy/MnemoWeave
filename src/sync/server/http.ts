import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import { activityEvent, isActivityScope } from '../activity-protocol.ts'
import { SYNC_AUTH_CHALLENGE, SYNC_AUTH_VERIFY, syncChallengeRequest, syncVerifyRequest } from '../auth-protocol.ts'
import { SYNC_BLOB_BYTES, SYNC_MAX_BATCH_BYTES, syncCursor, syncDigest, syncPush, syncScope } from '../protocol.ts'
import type { SyncAuthentication } from './auth.ts'
import { SyncConflict, type SyncStore } from './store.ts'

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

const digestBytes = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(request.headers['content-length']) > limit) throw new RequestError(413, 'Sync request is too large')
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = chunk as Buffer
    size += bytes.length
    if (size > limit) throw new RequestError(413, 'Sync request is too large')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

async function readJson(request: IncomingMessage, limit = SYNC_MAX_BATCH_BYTES): Promise<unknown> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new RequestError(415, 'Expected application/json')
  }
  const bytes = await readBody(request, limit)
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown }
  catch { throw new RequestError(400, 'Invalid JSON') }
}

export function createSyncServer(store: SyncStore, auth: SyncAuthentication) {
  return createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      if (status === 413) response.setHeader('Connection', 'close')
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(body))
    }
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (request.method === 'GET' && url.pathname === '/health') return send(200, { status: 'ok' })
      if (request.method === 'POST' && url.pathname === SYNC_AUTH_CHALLENGE) {
        const input = syncChallengeRequest.safeParse(await readJson(request, 2048))
        if (!input.success) return send(400, { error: 'Invalid authentication request' })
        const challenge = await auth.challenge(input.data.clientPublic)
        if (challenge === undefined) {
          response.setHeader('Retry-After', '60')
          return send(429, { error: 'Too many authentication attempts' })
        }
        return send(200, challenge)
      }
      if (request.method === 'POST' && url.pathname === SYNC_AUTH_VERIFY) {
        const input = syncVerifyRequest.safeParse(await readJson(request, 2048))
        if (!input.success) return send(400, { error: 'Invalid authentication request' })
        const session = await auth.verify(input.data.challengeId, input.data.clientProof)
        if (session === undefined) return send(401, { error: 'Authentication failed' })
        return send(200, session)
      }
      if (!auth.authorized(request.headers.authorization)) return send(401, { error: 'Unauthorized' })
      const blob = /^\/v1\/sync\/([^/]+)\/blobs\/([^/]+)$/u.exec(url.pathname)
      if (blob !== null) {
        const scope = syncScope.safeParse(blob[1])
        const key = syncDigest.safeParse(blob[2])
        if (!scope.success || !key.success) return send(400, { error: 'Invalid blob scope or digest' })
        if (isActivityScope(scope.data)) return send(404, { error: 'Activity scopes accept events only' })
        if (request.method === 'HEAD') {
          response.writeHead(store.hasBlob(scope.data, key.data) ? 200 : 404, { 'Cache-Control': 'no-store' }).end()
          return
        }
        if (request.method === 'GET') {
          const bytes = store.readBlob(scope.data, key.data)
          if (bytes === undefined) return send(404, { error: 'Blob not found' })
          response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' }).end(bytes)
          return
        }
        if (request.method === 'PUT') {
          const bytes = await readBody(request, SYNC_BLOB_BYTES)
          if (digestBytes(bytes) !== key.data) return send(400, { error: 'Blob digest mismatch' })
          store.putBlob(scope.data, key.data, bytes)
          return send(200, { stored: true })
        }
        response.setHeader('Allow', 'GET, HEAD, PUT')
        return send(405, { error: 'Method not allowed' })
      }
      const match = /^\/v1\/sync\/([^/]+)\/changes$/u.exec(url.pathname)
      if (match === null) return send(404, { error: 'Not found' })
      const scope = syncScope.safeParse(match[1])
      if (!scope.success) return send(400, { error: 'Invalid scope' })
      if (request.method === 'GET') {
        const raw = url.searchParams.get('cursor') ?? '0'
        const cursor = syncCursor.safeParse(/^\d+$/u.test(raw) ? Number(raw) : NaN)
        if (!cursor.success) return send(400, { error: 'Invalid cursor' })
        return send(200, store.pull(scope.data, cursor.data))
      }
      if (request.method === 'POST') {
        const input = syncPush.safeParse(await readJson(request))
        if (!input.success) return send(400, { error: 'Invalid sync batch' })
        if (isActivityScope(scope.data) && input.data.changes.some(change => {
          if (change.operation !== 'put') return true
          const event = activityEvent.safeParse(change.value)
          return !event.success || event.data.id !== change.key
        })) return send(400, { error: 'Invalid activity event batch' })
        return send(200, store.push(scope.data, input.data))
      }
      response.setHeader('Allow', 'GET, POST')
      return send(405, { error: 'Method not allowed' })
    } catch (error) {
      if (error instanceof SyncConflict) return send(409, { error: error.message, cursor: error.cursor })
      if (error instanceof RequestError) return send(error.status, { error: error.message })
      console.error('MnemoWeave sync request failed', error instanceof Error ? error.name : 'Unknown error')
      return send(500, { error: 'Internal server error' })
    }
  })
}
