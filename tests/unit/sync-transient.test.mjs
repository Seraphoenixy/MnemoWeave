// Which failures are retried. A sync copies scopes in sequence, so a single
// connect timeout half way through leaves the earlier scopes committed: retrying
// a transport failure matters, while retrying the server's answer does not.
import test from 'node:test'
import assert from 'node:assert/strict'
import { transient } from '../../src/sync/client/http.ts'
import { RemoteSyncConflict } from '../../src/sync/client/remote.ts'

const transport = cause => Object.assign(new TypeError('fetch failed'), { cause })

test('a connect timeout is retried', () => {
  const connectTimeout = transport(Object.assign(new Error('Connect Timeout Error'), {
    code: 'UND_ERR_CONNECT_TIMEOUT',
    message: 'Connect Timeout Error (attempted address: memory.example:443, timeout: 10000ms)',
  }))
  assert.equal(transient(connectTimeout), true)
})

test('a dropped connection is retried', () => {
  assert.equal(transient(transport(Object.assign(new Error('x'), { code: 'ECONNRESET' }))), true)
})

test('a failed name lookup is retried', () => {
  assert.equal(transient(transport(Object.assign(new Error('x'), { code: 'EAI_AGAIN' }))), true)
})

test('a bare fetch failure is retried, because it names no code at all', () => {
  assert.equal(transient(new TypeError('fetch failed')), true)
})

test("an answer from the server is not retried", () => {
  // The same request would only get the same answer.
  assert.equal(transient(new Error('Sync server returned HTTP 409')), false)
  assert.equal(transient(new Error('Sync snapshot digest mismatch')), false)
  assert.equal(transient(new Error('Sync authentication returned HTTP 401')), false)
  assert.equal(transient(new RemoteSyncConflict(1, 'conflict')), false)
})

test('something that is not an error at all is not retried', () => {
  assert.equal(transient('not an error'), false)
})
