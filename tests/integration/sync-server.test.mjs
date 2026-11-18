// The standalone sync server as shipped: a separate process that resolves its
// own storage, proves a password with PAKE, and answers the change protocol.
//
// These cases start the built artifact rather than an in-process handler, so
// they cover the launcher and the environment contract as well.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createSRPClient } from '@swan-io/srp'
import {
  SYNC_AUTH_CHALLENGE, SYNC_AUTH_VERIFY, SYNC_PASSWORD_ITERATIONS, SYNC_SRP_GROUP, SYNC_SRP_HASH,
} from '../../src/sync/auth-protocol.ts'
import { SyncClient } from '../../src/sync/client/http.ts'
import { SyncAuthentication } from '../../src/sync/server/auth.ts'
import { availablePort, connectMcp, startServer } from '../support/sync-fixtures.mjs'

const serverEntry = fileURLToPath(new URL('../../dist/mnemo-weave-sync-server.js', import.meta.url))

/**
 * One fixture per case: a disposable directory, an initialized auth record, and
 * a started server. The case receives `start` so the fixture can stop whatever
 * it started even when the case fails part way through — a leaked child here
 * would keep the whole run alive rather than fail it.
 */
async function withServer(run) {
  const fixture = await mkdtemp(join(tmpdir(), 'mnemoweave-server-'))
  const data = join(fixture, 'store')
  const password = randomBytes(4).toString('hex')
  const env = { ...process.env, NODE_PATH: '', MNEMOWEAVE_SYNC_DATA_DIR: data, MNEMOWEAVE_SYNC_AUTH_FILE: join(data, 'auth.json') }
  const copy = join(fixture, 'server.mjs')
  const servers = []
  try {
    await copyFile(serverEntry, copy)
    const initialize = () => spawnSync(process.execPath, [copy, '--init-auth'], {
      cwd: fixture, env, input: password + '\n', encoding: 'utf8', timeout: 10_000,
    })
    const port = await availablePort()
    const base = 'http://127.0.0.1:' + port
    const start = async () => {
      const server = startServer({ command: process.execPath, args: [copy], env, directory: fixture, port, token: password })
      servers.push(server)
      await server.ready
      return server
    }
    await run({ fixture, data, env, password, port, base, start, initialize })
  } finally {
    for (const server of servers) await server.stop()
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

test('the auth record holds a verifier, not the password', async () => {
  await withServer(async ({ env, password, initialize }) => {
    const initialized = initialize()
    assert.equal(initialized.status, 0, initialized.stderr)
    const saved = await readFile(env.MNEMOWEAVE_SYNC_AUTH_FILE, 'utf8')
    assert.deepEqual(Object.keys(JSON.parse(saved)), ['version', 'salt', 'verifier'])
    assert.ok(!saved.includes(password))
    // An existing record is never overwritten: rotating is a deliberate act.
    assert.notEqual(initialize().status, 0)
    assert.equal(await readFile(env.MNEMOWEAVE_SYNC_AUTH_FILE, 'utf8'), saved)
  })
})

test('a password is proved with PAKE and the session is accepted once', async () => {
  await withServer(async ({ env, password, base, start, initialize }) => {
    initialize()
    const saved = await readFile(env.MNEMOWEAVE_SYNC_AUTH_FILE, 'utf8')
    await start()
    const post = (path, body) => fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    })
    const get = (path, token) => fetch(base + path, {
      headers: token === undefined ? {} : { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(5000),
    })
    const changes = '/v1/sync/working-rules/changes'
    assert.equal((await get('/health')).status, 200)
    // A credential is required, and the password is not one.
    assert.equal((await get(changes)).status, 401)
    assert.equal((await get(changes, password)).status, 401)
    assert.equal((await post(SYNC_AUTH_CHALLENGE, { clientPublic: 'invalid' })).status, 400)

    const srp = createSRPClient(SYNC_SRP_HASH, SYNC_SRP_GROUP)
    const ephemeral = srp.generateEphemeral()
    const pending = await post(SYNC_AUTH_CHALLENGE, { clientPublic: ephemeral.public })
    assert.equal(pending.status, 200)
    const challenge = await pending.json()
    const privateKey = await srp.deriveSafePrivateKey(challenge.salt, password, SYNC_PASSWORD_ITERATIONS)
    const proof = await srp.deriveSession(ephemeral.secret, challenge.serverPublic, challenge.salt, '', privateKey)
    const verification = { challengeId: challenge.challengeId, clientProof: proof.proof }
    const verified = await post(SYNC_AUTH_VERIFY, verification)
    assert.equal(verified.status, 200)
    const session = await verified.json()
    await srp.verifySession(ephemeral.public, proof, session.serverProof)
    assert.equal((await get(changes, session.token)).status, 200)
    // The same proof is refused a second time, so a captured request does not
    // replay into a session later.
    assert.equal((await post(SYNC_AUTH_VERIFY, verification)).status, 401)
    await assert.rejects(new SyncClient(base, 'working-rules', randomBytes(32).toString('hex')).pull(0), /authentication returned HTTP 401/u)

    // A challenge expires, and a session token expires after its own lifetime.
    let now = 0
    const auth = new SyncAuthentication(JSON.parse(saved), () => now)
    const expiring = await auth.challenge(ephemeral.public)
    const expiringProof = await srp.deriveSession(ephemeral.secret, expiring.serverPublic, expiring.salt, '', privateKey)
    now = 60_000
    assert.equal(await auth.verify(expiring.challengeId, expiringProof.proof), undefined)
    const fresh = await auth.challenge(ephemeral.public)
    const freshProof = await srp.deriveSession(ephemeral.secret, fresh.serverPublic, fresh.salt, '', privateKey)
    const expiringSession = await auth.verify(fresh.challengeId, freshProof.proof)
    const authorization = 'Bearer ' + expiringSession.token
    assert.equal(auth.authorized(authorization), true)
    now += 30 * 60_000
    assert.equal(auth.authorized(authorization), false)
  })
})

test('two isolated MCP processes share Working Rules through the server', async () => {
  await withServer(async ({ fixture, password, port, start, initialize }) => {
    initialize()
    await start()
    const clients = []
    const call = async (profile, name, args) => {
      const mcp = await connectMcp({
        entry: fileURLToPath(new URL('../../dist/mnemo-weave-mcp.js', import.meta.url)),
        env: {
          MNEMON_DATA_DIR: join(fixture, profile),
          MNEMOWEAVE_SYNC_URL: 'http://127.0.0.1:' + port,
          MNEMOWEAVE_SYNC_PASSWORD: password,
        },
      })
      clients.push(mcp)
      return mcp.call(name, args)
    }
    try {
      const content = 'Synthetic rule transferred between isolated MCP processes.'
      const updated = 'Synthetic rule replaced between isolated MCP processes.'
      await call('first', 'mnemo_runtime_memory', { action: 'add', content, importance: 'critical' })
      const read = await call('second', 'mnemo_working_rules', {})
      assert.deepEqual(read.entries, [{ content, importance: 'critical' }])
      assert.match(read.text, new RegExp(`- ${content}`))
      await call('second', 'mnemo_runtime_memory', { action: 'replace', old_text: content, content: updated })
      const afterReplace = await call('first', 'mnemo_working_rules', {})
      assert.deepEqual(afterReplace.entries, [{ content: updated, importance: 'critical' }])
      await call('first', 'mnemo_runtime_memory', { action: 'remove', old_text: updated })
      const afterRemove = await call('second', 'mnemo_working_rules', {})
      assert.deepEqual(afterRemove.entries, [])
    } finally {
      await Promise.allSettled(clients.map(client => client.close()))
    }
  })
})
