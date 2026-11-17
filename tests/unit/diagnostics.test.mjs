// What a person reads after a failure: the cause chain and the bounded log.
// These are pure functions, so they need neither a server nor a Host.
import test from 'node:test'
import assert from 'node:assert/strict'
import { errorMessage } from '../../src/host/support/error-message.ts'
import { DiagnosticLog } from '../../src/host/support/diagnostics.ts'

/** Node's fetch rejects with a bare `fetch failed` and puts the cause in `cause`. */
function transportFailure(cause) {
  return Object.assign(new TypeError('fetch failed'), { cause })
}

test('a transport failure keeps its cause', () => {
  const refused = transportFailure(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8787'), { code: 'ECONNREFUSED' }))
  assert.equal(errorMessage(refused), 'fetch failed — connect ECONNREFUSED 127.0.0.1:8787')
})

test('a nested cause chain is followed to its end', () => {
  const nested = transportFailure(Object.assign(new Error('socket hang up'), { cause: new Error('read ETIMEDOUT') }))
  assert.equal(errorMessage(nested), 'fetch failed — socket hang up — read ETIMEDOUT')
})

test('a self-referencing cause does not recurse', () => {
  const cyclic = new Error('outer')
  cyclic.cause = cyclic
  assert.equal(errorMessage(cyclic), 'outer')
})

test('a plain message is reported as it is', () => {
  assert.equal(errorMessage(new Error('Workspace memories changed during sync; retry')), 'Workspace memories changed during sync; retry')
})

test('the log keeps the recent lines newest first', () => {
  const log = new DiagnosticLog()
  log.info('sync', 'Sync started', 'https://example.invalid')
  log.failure('sync', 'global-memory: failed', transportFailure(new Error('connect ECONNREFUSED')))
  assert.deepEqual(log.recent().map(entry => entry.level), ['error', 'info'])
  assert.equal(log.recent()[0].detail, 'fetch failed — connect ECONNREFUSED')
})

test('the log bounds its own size and drops the oldest lines', () => {
  const log = new DiagnosticLog()
  for (let index = 0; index < 260; index += 1) log.info('sync', `line ${index}`)
  assert.equal(log.recent(1000).length, 200)
  assert.equal(log.recent(1000).at(-1).message, 'line 60')
  log.clear()
  assert.equal(log.recent().length, 0)
})

test('an idle review reports its failure then the writes it committed', () => {
  // The review runs unattended, so its failure and the writes it committed
  // belong in the log the Status page shows, not in an alert over the workspace.
  const log = new DiagnosticLog()
  log.failure('review', 'Idle review failed after committing writes (run mnemon-run-v1-abc); the writes below were not rolled back',
    new Error('memory subagent completed without recording its result'))
  log.warning('review', 'Committed by the unfinished review',
    'mnemo_runtime_memory · added · d203498942c70d498933cad31aaf23543c6582e15fe6f76c950a12c5a8e40f05')
  const lines = log.recent()
  assert.equal(lines.length, 2)
  assert.equal(lines[0].level, 'warning')
  assert.match(lines[0].detail, /^mnemo_runtime_memory . added . d2034/u)
  assert.equal(lines[1].level, 'error')
  assert.equal(lines[1].area, 'review')
  assert.match(lines[1].message, /Idle review failed after committing writes/u)
  assert.match(lines[1].message, /run mnemon-run-v1-abc/u)
  assert.match(lines[1].message, /not rolled back/u)
  assert.equal(lines[1].detail, 'memory subagent completed without recording its result')
})
