import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSRPClient } from '@swan-io/srp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  SYNC_AUTH_CHALLENGE, SYNC_AUTH_VERIFY, SYNC_PASSWORD_ITERATIONS, SYNC_SRP_GROUP, SYNC_SRP_HASH,
} from '../src/sync/auth-protocol.ts'
import { SyncClient, transient } from '../src/sync/client/http.ts'
import { SnapshotSync, snapshotDigest } from '../src/sync/client/snapshot.ts'
import { SYNC_BLOB_BYTES, SYNC_MAX_FILES, syncManifest } from '../src/sync/protocol.ts'
import { strToU8, zipSync } from 'fflate'
import { RemoteSyncConflict } from '../src/sync/client/remote.ts'
import { SyncAuthentication } from '../src/sync/server/auth.ts'
import { SqliteSyncStore } from '../src/sync/server/sqlite.ts'
import { ActivityStore, activityKey } from '../src/memory/activity.ts'
import { WORKING_RULES_ACTIVITY_SCOPE } from '../src/sync/activity-protocol.ts'
import { activityScope, connectActivitySync } from '../src/sync/client/activity.ts'
import { MnemonSubagentCoordinator } from '../src/host/delegation/subagent.ts'
import { workspaceActivityStore } from '../src/host/review/activity-history.ts'
import { SyncProgressRegistry } from '../src/host/engine/sync-progress.ts'
import { AutoSyncScheduler } from '../src/host/engine/auto-sync.ts'
import { createSettingsHandler } from '../src/host/configuration/settings.ts'
import { createSyncHandler } from '../src/host/surface/rpc.ts'
import { errorMessage } from '../src/host/support/error-message.ts'
import { DiagnosticLog } from '../src/host/support/diagnostics.ts'

const fixture = await mkdtemp(join(tmpdir(), 'mnemoweave-sync-'))
const serverEntry = join(fixture, 'server.mjs')
const packagedLauncher = process.argv[2]
const serverCommand = packagedLauncher === undefined ? process.execPath : resolve(packagedLauncher)
const serverArgs = packagedLauncher === undefined ? [serverEntry] : []
const mcpEntry = fileURLToPath(new URL('../dist/mnemo-weave-mcp.js', import.meta.url))
const password = randomBytes(4).toString('hex')
const data = join(fixture, 'store')
const env = { ...process.env, NODE_PATH: '', MNEMOWEAVE_SYNC_DATA_DIR: data, MNEMOWEAVE_SYNC_AUTH_FILE: join(data, 'auth.json') }
const serverEnv = packagedLauncher === undefined ? env : {
  HOME: fixture,
  PATH: join(fixture, 'no-system-tools'),
  MNEMOWEAVE_SYNC_DATA_DIR: data,
  MNEMOWEAVE_SYNC_AUTH_FILE: env.MNEMOWEAVE_SYNC_AUTH_FILE,
}
const clients = []
let running

async function availablePort() {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address()
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  return port
}

async function start(port) {
  const processEnv = { ...serverEnv, MNEMOWEAVE_SYNC_PORT: String(port), MNEMOWEAVE_SYNC_TOKEN: password }
  const child = spawn(serverCommand, serverArgs, { cwd: fixture, env: processEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  running = { child, done: once(child, 'exit') }
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const timeout = AbortSignal.timeout(10_000)
  await Promise.race([
    once(child.stdout, 'data', { signal: timeout }),
    running.done.then(([code]) => { throw new Error('Standalone server exited with ' + code + '\n' + stderr) }),
  ])
}

async function stop() {
  if (running === undefined) return
  running.child.kill()
  await running.done
  running = undefined
}

async function callMcp(port, profile, name, args) {
  const client = new Client({ name: 'mnemoweave-sync-smoke', version: '1.0.0' })
  clients.push(client)
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntry],
    env: {
      MNEMON_DATA_DIR: join(fixture, profile),
      MNEMOWEAVE_SYNC_URL: 'http://127.0.0.1:' + port,
      MNEMOWEAVE_SYNC_PASSWORD: password,
    },
  }))
  const result = await client.callTool({ name, arguments: args })
  assert.ok(!result.isError, JSON.stringify(result))
  return JSON.parse(result.content[0].text)
}

async function collectDelegatedRun() {
  const callbacks = new Map()
  const on = (name, callback) => {
    const listeners = callbacks.get(name) ?? new Set()
    callbacks.set(name, listeners)
    listeners.add(callback)
    return () => listeners.delete(callback)
  }
  const cwd = fixture
  const session = (events, header = {}) => ({
    header: { cwd, ...header }, seq: events.length, surface: { nodes: [] },
    eventAt: offset => events[offset], snapshotEvents: (start, end) => events.slice(start, end),
  })
  const parent = { id: 'fixture-parent', session: session([{ type: 'turn/start', seq: 0, data: { turn: 5 } }]), ctx: {} }
  const child = {
    id: 'fixture-child', ctx: { systemPrompt: { section() {}, getSectionOrder: () => 0 }, tools: { restrict() {} } },
    session: session([
      { type: 'assistant/message', data: { turn: 4, step: 1, usage: { inputTokens: 100, outputTokens: 10 } } },
      { type: 'subagent/descriptor', data: {} },
      { type: 'assistant/chunk', data: { turn: 0, step: 1, chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 1 } } } },
      { type: 'assistant/message', data: { turn: 0, step: 1, usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 2 } } },
    ], { origin: 'subagent', parentSession: parent.id }),
  }
  let stopReason = 'completed'
  const privateAnswer = 'Synthetic answer excluded from activity'
  const subagents = {
    list: () => ['spawn'],
    getProvider: () => ({ capabilities: { depthLimit: true }, prepareContinuable() {} }),
    async startActivation() {
      for (const listener of callbacks.get('agent/created') ?? []) listener({ agent: child })
      return {
        childId: child.id, async dispose() {},
        result: Promise.resolve({ stopReason, structured: { answer: privateAnswer, citations: [] }, output: [] }),
      }
    },
  }
  const root = join(fixture, 'delegation')
  const config = { subagentProviderNames: [] }
  const host = { on, tools: { register: () => () => {} }, agents: { get: id => id === child.id ? child : parent } }
  const coordinator = new MnemonSubagentCoordinator(subagents, { config, forAgent: () => ({ config, directory: root }) }, host)
  try {
    const result = await coordinator.answer(parent, 'Synthetic question', [], new AbortController().signal)
    assert.equal(result.answer, privateAnswer)
    stopReason = 'error'
    await assert.rejects(coordinator.answer(parent, 'Synthetic failed question', [], new AbortController().signal))
    const activity = workspaceActivityStore(root, cwd)
    const events = activity.activityIds().map(id => activity.read(id))
    assert.equal(events.length, 2)
    assert.ok(!JSON.stringify(events).includes(privateAnswer))
    const completed = events.find(event => event.outcome === 'completed')
    assert.ok(completed)
    assert.equal(completed.parentSession, activityKey('session', parent.id))
    assert.equal(completed.childSession, activityKey('session', child.id))
    assert.equal(completed.turn, 5)
    assert.deepEqual(completed.usage, { uncachedInputTokens: 7, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 0 })
    assert.ok(events.some(event => event.outcome === 'failed'))
  } finally {
    await coordinator.dispose()
  }
}

try {
  await collectDelegatedRun()
  if (packagedLauncher === undefined) {
    await copyFile(new URL('../dist/mnemo-weave-sync-server.js', import.meta.url), serverEntry)
  }
  const initialize = () => spawnSync(serverCommand, [...serverArgs, '--init-auth'], {
    cwd: fixture, env: serverEnv, input: password + '\n', encoding: 'utf8', timeout: 10_000,
  })
  const initialized = initialize()
  assert.equal(initialized.status, 0, initialized.stderr)
  const saved = await readFile(env.MNEMOWEAVE_SYNC_AUTH_FILE, 'utf8')
  assert.deepEqual(Object.keys(JSON.parse(saved)), ['version', 'salt', 'verifier'])
  assert.ok(!saved.includes(password))
  assert.notEqual(initialize().status, 0)
  assert.equal(await readFile(env.MNEMOWEAVE_SYNC_AUTH_FILE, 'utf8'), saved)

  const port = await availablePort()
  const base = 'http://127.0.0.1:' + port
  await start(port)
  const get = (path, token) => fetch(base + path, {
    headers: token === undefined ? {} : { Authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(5000),
  })
  const post = (path, body) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  })
  const changes = '/v1/sync/working-rules/changes'
  assert.equal((await get('/health')).status, 200)
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
  assert.equal((await post(SYNC_AUTH_VERIFY, verification)).status, 401)
  await assert.rejects(new SyncClient(base, 'working-rules', randomBytes(32).toString('hex')).pull(0), /authentication returned HTTP 401/u)

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

  const content = 'Synthetic rule transferred between isolated MCP processes.'
  await callMcp(port, 'first', 'append_workspace_memory', { content })
  assert.deepEqual(await callMcp(port, 'second', 'read_workspace_memory', {}), [content])
  const rulesHistory = await new SyncClient(base, WORKING_RULES_ACTIVITY_SCOPE, password).pull(0)
  const rulesEvents = rulesHistory.batches.flatMap(batch => batch.changes.map(change => change.value))
  assert.ok(rulesEvents.some(event => event.operation === 'append-working-rules' && event.outcome === 'committed'))
  assert.ok(rulesEvents.some(event => event.operation === 'read-working-rules' && event.outcome === 'returned'))
  assert.ok(!JSON.stringify(rulesEvents).includes(content))

  const scope = activityScope('synthetic-project')
  const firstStore = new ActivityStore(join(fixture, 'activity-a'))
  const secondStore = new ActivityStore(join(fixture, 'activity-b'))
  const read = { version: 1, kind: 'memory', id: activityKey('fixture-read'), source: 'memory-spaces', operation: 'recall', outcome: 'skipped', skipReason: 'budget', results: 0 }
  const subagent = { version: 1, kind: 'subagent', id: activityKey('fixture-run'), operation: 'write', outcome: 'completed', durationMs: 25, committedWrites: 1 }
  firstStore.save(read)
  secondStore.save(subagent)
  const firstSync = connectActivitySync({ url: base, password, scope }, firstStore)
  const secondSync = connectActivitySync({ url: base, password, scope }, secondStore)
  await Promise.all([firstSync(), secondSync()])
  await Promise.all([firstSync(), secondSync()])
  assert.deepEqual(firstStore.activityIds(), [read.id, subagent.id].sort())
  assert.deepEqual(secondStore.activityIds(), firstStore.activityIds())
  assert.deepEqual(await firstSync(), { cursor: 2, pushed: 0, pulled: 0 })
  const separateScope = activityScope('separate-project')
  assert.deepEqual(await connectActivitySync({ url: base, password, scope: separateScope }, secondStore)(), { cursor: 1, pushed: 1, pulled: 0 })
  const separateHistory = await new SyncClient(base, separateScope, password).pull(0)
  assert.deepEqual(separateHistory.batches.flatMap(batch => batch.changes.map(change => change.key)), [subagent.id])

  const config = { storageScope: 'global', writeEnabled: true }
  const hostRoot = join(fixture, 'dsh-rpc')
  const host = { route: () => ({ graph: { configuration: config, config, directory: hostRoot }, selectedWorkspace: { path: fixture }, participation: { excluded: false } }) }
  const syncHandler = createSyncHandler(host)
  process.env.MNEMOWEAVE_SYNC_URL = base
  process.env.MNEMOWEAVE_SYNC_PASSWORD = password
  const dshResult = await syncHandler('server-sync-activity', { syncScope: 'synthetic-project' }, AbortSignal.timeout(5000))
  assert.equal(dshResult.ok, true, JSON.stringify(dshResult))
  assert.deepEqual(workspaceActivityStore(hostRoot, fixture).activityIds(), [read.id, subagent.id].sort())

  process.env.MNEMON_DATA_DIR = join(fixture, 'dsh-working-rules')
  const packs = { storageScope: 'workspaces', writeEnabled: true }
  function globalHost(machine, names) {
    const directory = join(fixture, machine)
    const workspaces = names.map(name => ({ id: machine + '-' + name, title: name, path: join(directory, name) }))
    const memories = new Map(names.map(name => [name, Buffer.alloc(0)]))
    let credential
    const credentials = {
      readRecord: async () => credential,
      modifyRecord: async (_key, mutate) => { credential = await mutate(credential) },
    }
    const runtime = {
      config: packs,
      snapshot: () => ({ config: packs, directory }),
      syncWorkspaces: () => workspaces,
      forWorkspaceId: id => {
        const workspace = workspaces.find(entry => entry.id === id)
        return {
          directory: workspace.path,
          memoryComposition: { current: () => undefined },
          packs: {
            captureWorkspaceSync: async () => {
              const bytes = memories.get(workspace.title)
              // A scope is addressed file by file, so the fake reports the
              // single entry its content stands for.
              return { bytes, entries: { 'content.bin': bytes }, empty: bytes.length === 0 }
            },
            assembleWorkspaceSync: entries => Buffer.from(entries['content.bin'] ?? Buffer.alloc(0)),
            replaceWorkspaceSync: async (bytes, matches) => {
              assert.ok(matches(memories.get(workspace.title)))
              memories.set(workspace.title, bytes)
            },
          },
        }
      },
    }
    return { handler: createSyncHandler(runtime, undefined, () => credentials), workspaces, memories }
  }
  const sender = globalHost('global-sender', ['global-project', '第二个项目'])
  const receiver = globalHost('global-receiver', ['第二个项目', 'global-project'])
  sender.memories.set('global-project', Buffer.from('project A'))
  sender.memories.set('第二个项目', Buffer.from('project B'))
  const firstWorkspace = sender.workspaces[0].path
  const senderActivity = workspaceActivityStore(firstWorkspace, firstWorkspace)
  const newEvent = { ...read, id: activityKey('new-global-event') }
  senderActivity.record(newEvent)

  for (const { handler } of [sender, receiver]) {
    const saved = await handler('save-connection', { url: base, password }, AbortSignal.timeout(10_000))
    assert.deepEqual(saved, { ok: true, value: { url: base + '/', configured: true, writable: true } })
    assert.deepEqual(await handler('connection', {}), saved)
    assert.equal((await handler('save-connection', { url: base, password: randomBytes(32).toString('hex') })).ok, false)
  }
  delete process.env.MNEMOWEAVE_SYNC_URL
  delete process.env.MNEMOWEAVE_SYNC_PASSWORD
  const pushed = await sender.handler('sync-all', {})
  assert.equal(pushed.ok, true, JSON.stringify(pushed))
  assert.equal(pushed.value.pushed, 2)
  const pulled = await receiver.handler('sync-all', {})
  assert.equal(pulled.ok, true, JSON.stringify(pulled))
  assert.equal(pulled.value.pulled, 2)
  assert.deepEqual(receiver.memories, sender.memories)
  const receivingPath = receiver.workspaces[1].path
  assert.ok(workspaceActivityStore(receivingPath, receivingPath).activityIds().includes(newEvent.id))
  assert.deepEqual(await receiver.handler('sync-all', {}), { ok: true, value: { pulled: 0, pushed: 0, activityPulled: 0, activityPushed: 0 } })
  receiver.memories.set('第二个项目', Buffer.from('receiver edit'))
  sender.memories.set('第二个项目', Buffer.from('sender edit'))
  assert.equal((await sender.handler('sync-all', {})).ok, true)
  const conflict = await receiver.handler('sync-all', {})
  assert.equal(conflict.ok, false)
  assert.equal(conflict.error.details.target, '第二个项目')
  // The page reads the failed run instead of guessing from the thrown call.
  const failedProgress = await receiver.handler('progress', {})
  assert.equal(failedProgress.ok, true, JSON.stringify(failedProgress))
  assert.equal(failedProgress.value.running, false)
  assert.equal(failedProgress.value.last.state, 'failed')
  assert.equal(failedProgress.value.last.conflictTarget, '第二个项目')
  assert.ok(failedProgress.value.last.error.length > 0)
  const resolved = await receiver.handler('sync-all', { resolve: 'server', confirmed: true, conflictToken: conflict.error.details.conflictToken })
  assert.equal(resolved.ok, true, JSON.stringify(resolved))
  assert.deepEqual(receiver.memories, sender.memories)
  const doneProgress = await receiver.handler('progress', {})
  assert.equal(doneProgress.ok, true, JSON.stringify(doneProgress))
  assert.equal(doneProgress.value.running, false)
  assert.equal(doneProgress.value.last.state, 'done')
  assert.equal(doneProgress.value.last.pulled, resolved.value.pulled)
  assert.equal(doneProgress.value.last.conflictTarget, undefined)

  // One run states its steps and how much of the current one moved; a later
  // report from a settled run cannot replace what the page shows.
  const steps = new SyncProgressRegistry()
  const watched = steps.begin()
  watched.plan(3)
  watched.step('snapshot', 'global-memory')
  watched.transfer(1, 2)
  const inFlight = steps.view()
  assert.equal(inFlight.running, true)
  assert.equal(inFlight.phase, 'snapshot')
  assert.equal(inFlight.target, 'global-memory')
  assert.equal(inFlight.step, 1)
  assert.equal(inFlight.steps, 3)
  assert.deepEqual([inFlight.done, inFlight.total], [1, 2])
  assert.ok(!Number.isNaN(Date.parse(inFlight.startedAt)))
  watched.finish({ pulled: 2, pushed: 1, activityPulled: 4, activityPushed: 5 })
  watched.transfer(2, 2)
  watched.fail(new Error('stale'))
  const settled = steps.view()
  assert.equal(settled.running, false)
  assert.equal(settled.last.state, 'done')
  assert.deepEqual(
    [settled.last.pulled, settled.last.pushed, settled.last.activityPulled, settled.last.activityPushed],
    [2, 1, 4, 5],
  )
  // A second caller is refused while one run owns the Host, so the two cannot
  // copy the same roots or overwrite each other's reported steps.
  assert.equal(steps.busy(), false)
  const owner = steps.begin()
  assert.equal(steps.busy(), true)
  owner.fail(new Error('refused'))
  assert.equal(steps.busy(), false)

  // The timer runs only when switched on, never over a run in flight, and never
  // past a conflict only a person can settle. It does retry every other failure.
  const auto = new SyncProgressRegistry()
  let runs = 0
  const disabled = new AutoSyncScheduler(() => ({ enabled: false, intervalMs: 60_000 }), auto, async () => { runs += 1 })
  assert.equal(await disabled.ready(), false)
  disabled.dispose()
  const enabled = { enabled: true, intervalMs: 60_000 }
  const running = new AutoSyncScheduler(() => enabled, auto, async () => { runs += 1 })
  assert.equal(await running.ready(), true)
  // Switched on but with no server to reach: idle rather than a failure every interval.
  // The check reads the credential store, so it answers with a promise.
  const unconfigured = new AutoSyncScheduler(() => enabled, auto, async () => { runs += 1 }, async () => false)
  assert.equal(await unconfigured.ready(), false)
  unconfigured.dispose()
  const busyRun = auto.begin()
  assert.equal(await running.ready(), false)
  busyRun.fail(new Error('server unreachable'))
  // A plain failure is retried on the next tick, unlike a conflict.
  assert.equal(await running.ready(), true)
  const conflicted = auto.begin()
  conflicted.fail(new Error('both copies changed'), 'global-memory')
  assert.equal(await running.ready(), false)
  // A run that settles on no change clears the conflict, and the timer resumes.
  const cleared = auto.begin()
  cleared.finish({ pulled: 0, pushed: 0, activityPulled: 0, activityPushed: 0 })
  assert.equal(await running.ready(), true)
  assert.equal(runs, 0)
  running.dispose()

  // The record is claimed in one step, never checked and then taken after an
  // await: two callers arriving together must not both start a run, which
  // would copy the same storage roots while each reports the other's steps.
  const claimed = new SyncProgressRegistry()
  const holders = [claimed.claim(), claimed.claim(), claimed.claim()]
  assert.equal(holders.filter(Boolean).length, 1)
  assert.equal(claimed.busy(), true)
  holders[0].fail(new Error('unreachable server'))
  assert.equal(claimed.busy(), false)
  assert.equal(claimed.last().state, 'failed')
  // A released record can be claimed again, so the timer keeps working.
  const nextClaim = claimed.claim()
  assert.ok(nextClaim)
  nextClaim.finish({ pulled: 0, pushed: 0, activityPulled: 0, activityPushed: 0 })

  // A sync runs under its own budget, never the caller's request signal. The
  // page's HTTP request ends when it navigates or the connection reconnects,
  // and a sync that inherited that signal would stop part way through: some
  // scopes committed, the rest lost, the record left saying it failed.
  const caller = new AbortController()
  const own = AbortSignal.timeout(600_000)
  caller.abort(new Error('page navigated away'))
  assert.equal(caller.signal.aborted, true)
  assert.equal(own.aborted, false)

  // A transport failure reaches the page with its cause. Node's fetch rejects
  // with a bare `fetch failed` and puts the address, certificate or socket
  // problem in `cause`; without it the log says nothing a person can act on.
  const refused = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8787'), { code: 'ECONNREFUSED' }),
  })
  assert.equal(errorMessage(refused), 'fetch failed — connect ECONNREFUSED 127.0.0.1:8787')
  const nested = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('socket hang up'), { cause: new Error('read ETIMEDOUT') }),
  })
  assert.equal(errorMessage(nested), 'fetch failed — socket hang up — read ETIMEDOUT')
  // A self-referencing cause must not recurse.
  const cyclic = new Error('outer')
  cyclic.cause = cyclic
  assert.equal(errorMessage(cyclic), 'outer')
  assert.equal(errorMessage(new Error('Workspace memories changed during sync; retry')), 'Workspace memories changed during sync; retry')

  // The Host keeps the recent lines, newest first, and bounds its own size.
  const log = new DiagnosticLog()
  log.info('sync', 'Sync started', 'https://example.invalid')
  log.failure('sync', 'global-memory: failed', refused)
  assert.deepEqual(log.recent().map(entry => entry.level), ['error', 'info'])
  assert.equal(log.recent()[0].detail, 'fetch failed — connect ECONNREFUSED 127.0.0.1:8787')
  for (let index = 0; index < 260; index += 1) log.info('sync', `line ${index}`)
  assert.equal(log.recent(1000).length, 200)
  assert.equal(log.recent(1000).at(-1).message, 'line 60')
  log.clear()
  assert.equal(log.recent().length, 0)

  // A transport failure is retried; an answer from the server is not. A sync
  // copies scopes in sequence, so a single connect timeout half way through
  // leaves the earlier scopes committed and the rest untouched — the reported
  // "synced part way, then failed".
  const connectTimeout = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('Connect Timeout Error'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
      message: 'Connect Timeout Error (attempted address: memory.example:443, timeout: 10000ms)',
    }),
  })
  assert.equal(transient(connectTimeout), true)
  assert.equal(transient(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) })), true)
  assert.equal(transient(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'EAI_AGAIN' }) })), true)
  // A bare `fetch failed` names no code at all and is still a transport failure.
  assert.equal(transient(new TypeError('fetch failed')), true)
  // An answer is not retried: the same request would get the same answer.
  assert.equal(transient(new Error('Sync server returned HTTP 409')), false)
  assert.equal(transient(new Error('Sync snapshot digest mismatch')), false)
  assert.equal(transient(new Error('Sync authentication returned HTTP 401')), false)
  assert.equal(transient(new RemoteSyncConflict(1, 'conflict')), false)
  assert.equal(transient('not an error'), false)

  // An idle review runs unattended, so its failure and the writes it committed
  // belong in the log the Status page shows rather than in an alert over the
  // workspace. Rebuild the lines `fail()` writes: the failure with its cause,
  // then one line per receipt that was not rolled back.
  const reviewLog = new DiagnosticLog()
  const reviewError = new Error('memory subagent completed without recording its result')
  reviewLog.failure('review', 'Idle review failed after committing writes (run mnemon-run-v1-abc); the writes below were not rolled back', reviewError)
  reviewLog.warning('review', 'Committed by the unfinished review', 'mnemo_runtime_memory · added · d203498942c70d498933cad31aaf23543c6582e15fe6f76c950a12c5a8e40f05')
  const lines = reviewLog.recent()
  assert.equal(lines.length, 2)
  assert.equal(lines[0].level, 'warning')
  assert.match(lines[0].detail, /^mnemo_runtime_memory . added . d2034/u)
  assert.equal(lines[1].level, 'error')
  assert.equal(lines[1].area, 'review')
  assert.match(lines[1].message, /Idle review failed after committing writes/u)
  assert.match(lines[1].message, /run mnemon-run-v1-abc/u)
  assert.match(lines[1].message, /not rolled back/u)
  assert.equal(lines[1].detail, 'memory subagent completed without recording its result')

  // The page writes the automatic sync through the settings channel, so those
  // two nested paths must be accepted there; a missing entry refuses the save.
  const written = []
  const settingsView = { ns: 'mnemon', value: { autoSync: { enabled: false, intervalMs: 900_000 } }, base: {}, user: {}, revision: 1, applies: 'live' }
  const settingsHandler = createSettingsHandler({
    writable: true,
    describe: () => [settingsView],
    mutate: async (ns, ops) => { written.push(...ops) },
  })
  const enabledSave = await settingsHandler('mutate', { ops: [{ op: 'set', path: ['autoSync', 'enabled'], value: true }] })
  assert.equal(enabledSave.ok, true, JSON.stringify(enabledSave))
  const intervalSave = await settingsHandler('mutate', { ops: [{ op: 'set', path: ['autoSync', 'intervalMs'], value: 300_000 }] })
  assert.equal(intervalSave.ok, true, JSON.stringify(intervalSave))
  assert.deepEqual(written.map(op => [op.path.join('.'), op.value]), [['autoSync.enabled', true], ['autoSync.intervalMs', 300_000]])
  // Values outside the range the scheduler accepts are refused where they are written.
  assert.equal((await settingsHandler('mutate', { ops: [{ op: 'set', path: ['autoSync', 'intervalMs'], value: 1_000 }] })).ok, false)
  assert.equal((await settingsHandler('mutate', { ops: [{ op: 'set', path: ['autoSync', 'enabled'], value: 'yes' }] })).ok, false)
  // An unrelated nested field stays refused: the whitelist is not opened wholesale.
  assert.equal((await settingsHandler('mutate', { ops: [{ op: 'set', path: ['autoSync', 'other'], value: 1 }] })).ok, false)

  const activityClient = new SyncClient(base, scope, password)
  await assert.rejects(activityClient.push({ requestId: randomUUID(), baseCursor: 2, changes: [{ key: read.id, operation: 'delete' }] }), /HTTP 400/u)
  await assert.rejects(activityClient.push({ requestId: randomUUID(), baseCursor: 2, changes: [{ key: read.id, operation: 'put', value: { ...read, results: 1 } }] }), /already exists/u)
  await assert.rejects(activityClient.push({ requestId: randomUUID(), baseCursor: 2, changes: [{ key: activityKey('invalid'), operation: 'put', value: { privateContent: content } }] }), /HTTP 400/u)

  const reconnect = new SyncClient(base, 'working-rules', password)
  const position = (await reconnect.pull(0)).head
  assert.ok(position > 0)
  await stop()
  await start(port)
  assert.equal((await get(changes, session.token)).status, 401)
  assert.equal((await reconnect.pull(0)).head, position)
  assert.deepEqual(await secondSync(), { cursor: 2, pushed: 0, pulled: 0 })
  assert.deepEqual(await callMcp(port, 'third', 'read_workspace_memory', {}), [content])
  // A scope is addressed file by file: a run moves only the entries whose
  // content differs. Counting the transport calls is the point — the digest
  // check alone would pass even if the whole snapshot were resent.
  const deltaScope = 'workspace-delta'
  const counting = () => {
    const calls = { uploads: 0, downloads: 0 }
    const transport = new SyncClient(base, deltaScope, password)
    return {
      calls,
      client: {
        pull: (...args) => transport.pull(...args),
        push: (...args) => transport.push(...args),
        uploadBlob: (digest, bytes, signal) => { calls.uploads += 1; return transport.uploadBlob(digest, bytes, signal) },
        downloadBlob: (digest, signal) => { calls.downloads += 1; return transport.downloadBlob(digest, signal) },
      },
    }
  }
  const archive = entries => Buffer.from(zipSync(
    Object.fromEntries(Object.keys(entries).sort().map(path => [path, entries[path]])),
    { level: 6, mtime: new Date(1980, 0, 1) },
  ))
  const makeReplica = transport => {
    let files = {}
    let state
    let received
    const sync = new SnapshotSync(transport.client, {
      async capture() {
        const entries = Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)]))
        return { bytes: archive(entries), entries, empty: Object.keys(entries).length === 0 }
      },
      async apply(bytes) { received = bytes },
      assemble: entries => archive(entries),
      load() { return state },
      save(value) { state = value },
    })
    return { run: () => sync.sync({}), set: value => { files = value }, received: () => received }
  }
  const first = { 'manifest.json': '{"v":1}', 'payload/a.md': 'alpha', 'payload/b.md': 'beta' }
  const changed = { ...first, 'payload/a.md': 'alpha changed' }

  const source = counting()
  const sourceReplica = makeReplica(source)
  sourceReplica.set(first)
  await sourceReplica.run()
  assert.equal(source.calls.uploads, 3)
  assert.equal(source.calls.downloads, 0)

  const peer = counting()
  const peerReplica = makeReplica(peer)
  await peerReplica.run()
  assert.equal(peer.calls.downloads, 3)
  assert.ok(peerReplica.received() !== undefined)

  // Change one file of three: the peer fetches one entry, not the snapshot.
  sourceReplica.set(changed)
  await sourceReplica.run()
  assert.equal(source.calls.uploads, 4, 'one new entry is uploaded')
  peerReplica.set(first)
  await peerReplica.run()
  assert.equal(peer.calls.downloads, 4, 'one entry is downloaded')

  // The progress a page reads counts files that actually moved, not files
  // examined. A run where three of four entries are reused reports one.
  const progressReports = []
  const progressScope = 'workspace-progress'
  const progressFiles = { 'manifest.json': '{"v":1}', 'payload/a.md': 'alpha', 'payload/b.md': 'beta', 'payload/c.md': 'gamma' }
  const progressEntries = Object.fromEntries(Object.entries(progressFiles).map(([path, text]) => [path, strToU8(text)]))
  const progressArchive = entries => archive(entries)
  const peerFiles = { ...progressEntries, 'payload/b.md': strToU8('beta on the peer') }
  const peerManifest = {
    bytes: snapshotDigest(progressArchive(peerFiles)),
    files: Object.entries(peerFiles).map(([path, bytes]) => ({ path, digest: snapshotDigest(bytes) })),
  }
  const heldEntries = Object.fromEntries(Object.entries(progressEntries).filter(([path]) => path !== 'payload/b.md'))
  const heldArchive = snapshotDigest(progressArchive(heldEntries))
  const progressTransport = (() => {
    const transport = new SyncClient(base, progressScope, password)
    return {
      pull: async () => ({ cursor: 1, head: 1, batches: [{ cursor: 1, changes: [{ key: 'memory-snapshot', operation: 'put', value: peerManifest }] }] }),
      push: (...args) => transport.push(...args),
      uploadBlob: (...args) => transport.uploadBlob(...args),
      downloadBlob: (digest, signal) => transport.downloadBlob(digest, signal),
      store: new Map(Object.entries(peerFiles).map(([path, bytes]) => [snapshotDigest(bytes), bytes])),
    }
  })()
  // Serve the peer's blobs from memory so the count is about entries, not disk.
  progressTransport.downloadBlob = async digest => progressTransport.store.get(digest)
  progressTransport.uploadBlob = async () => {}
  progressTransport.push = async () => 2
  const progressSync = new SnapshotSync(progressTransport, {
    async capture() { return { bytes: progressArchive(heldEntries), entries: heldEntries, empty: false } },
    async apply() {},
    assemble: entries => progressArchive(entries),
    load() {
      return { cursor: 0, remote: {
        bytes: heldArchive,
        files: Object.entries(heldEntries).map(([path, bytes]) => ({ path, digest: snapshotDigest(bytes) })),
      } }
    },
    save() {},
  })
  await progressSync.sync({ transfer: progress => progressReports.push(progress) })
  assert.deepEqual(progressReports, [{ done: 1, total: 1 }], 'progress counts the one file that moved')

  // A push refused because the peer committed meanwhile must not end the run.
  // The retry re-reads the peer's manifest; when both copies then hold the same
  // content it settles as "unchanged" instead of asking which copy to keep.
  const retryScope = 'workspace-retry'
  const retryOf = record => Object.fromEntries(Object.entries(record).map(([path, text]) => [path, strToU8(text)]))
  const retryManifest = entries => ({
    bytes: snapshotDigest(archive(entries)),
    files: Object.entries(entries).map(([path, bytes]) => ({ path, digest: snapshotDigest(bytes) })),
  })
  const retryRecorded = retryOf({ 'manifest.json': '{"v":1}', 'payload/a.md': 'shared' })
  const retryLocal = retryOf({ 'manifest.json': '{"v":1}', 'payload/a.md': 'locally edited' })
  let retryPulls = 0
  let retryPushes = 0
  const retrySync = new SnapshotSync({
    async pull() {
      retryPulls += 1
      // The peer first holds the recorded archive, so this run publishes; it
      // then reports the local content, as a concurrent identical write would.
      const manifest = retryManifest(retryPulls === 1 ? retryRecorded : retryLocal)
      return { cursor: retryPulls, head: retryPulls, batches: [{ cursor: retryPulls, changes: [{ key: 'memory-snapshot', operation: 'put', value: manifest }] }] }
    },
    async push() { retryPushes += 1; throw new RemoteSyncConflict(retryPulls, 'the peer committed a newer batch') },
    async uploadBlob() {},
    async downloadBlob(digest) {
      for (const bytes of [...Object.values(retryRecorded), ...Object.values(retryLocal)]) if (snapshotDigest(bytes) === digest) return bytes
      throw new Error('unknown blob')
    },
  }, {
    async capture() { return { bytes: archive(retryLocal), entries: retryLocal, empty: false } },
    async apply() {},
    assemble: entries => archive(entries),
    load() { return { cursor: 0, remote: retryManifest(retryRecorded) } },
    save() {},
  })
  const retryOutcome = await retrySync.sync({})
  assert.equal(retryOutcome.action, 'unchanged', 'a refused push is retried and settles')
  assert.equal(retryPushes, 1)
  assert.equal(retryPulls, 2, 'the retry re-reads the peer manifest')

  // A second run with nothing changed moves nothing at all.
  const before = { uploads: peer.calls.uploads, downloads: peer.calls.downloads }
  peerReplica.set(changed)
  const idle = await peerReplica.run()
  assert.equal(idle.action, 'unchanged')
  assert.deepEqual(peer.calls, before)

  // The advertised manifest is what the peer compares against, and the archive
  // digest it carries still names the assembled bytes.
  assert.equal(snapshotDigest(archive(Object.fromEntries(
    Object.entries(changed).map(([path, text]) => [path, strToU8(text)]),
  ))), snapshotDigest(peerReplica.received() ?? Buffer.alloc(0)))

  // A state file left by the block-based build records `{ digest, blocks }`.
  // It describes an archive this build no longer produces, so it must be read
  // as "never synchronized" and re-published, not rejected: refusing it would
  // leave the scope unable to synchronize at all.
  const legacyState = counting()
  // The cursor is kept, because it is still a position in the same log; only
  // the manifest, which named an archive this build cannot rebuild, is dropped.
  let legacyStateValue = { cursor: 0, remote: { digest: 'a'.repeat(64), blocks: ['b'.repeat(64)] } }
  let legacyFiles = { 'manifest.json': '{"v":1}', 'payload/a.md': 'alpha' }
  const legacy = new SnapshotSync(legacyState.client, {
    async capture() {
      const entries = Object.fromEntries(Object.entries(legacyFiles).map(([path, text]) => [path, strToU8(text)]))
      return { bytes: archive(entries), entries, empty: false }
    },
    async apply() { throw new Error('a legacy state must not pull') },
    assemble: entries => archive(entries),
    load() { return legacyStateValue },
    save(value) { legacyStateValue = value },
  })
  const legacyResult = await legacy.sync({})
  assert.equal(legacyResult.action, 'pushed', 'a legacy state re-publishes the scope')
  assert.ok(Array.isArray(legacyStateValue.remote.files), 'the state is rewritten in the file manifest form')
  assert.ok(legacyStateValue.remote.blocks === undefined)

  // The single-file bound matches the Pack reader's own per-entry limit, so a
  // scope that can be exported can also be synchronized.
  assert.equal(SYNC_BLOB_BYTES, 128 * 1024 * 1024)

  // An incomplete entry set is refused where it is detected, so a pull that
  // could not fetch a declared file names that file instead of arriving at the
  // import path as a damaged archive. The protocol also bounds the file count.
  assert.equal(SYNC_MAX_FILES, 4096)
  assert.equal(syncManifest.safeParse({ bytes: 'a'.repeat(64), files: [] }).success, false)
  assert.equal(syncManifest.safeParse({
    bytes: 'a'.repeat(64),
    files: Array.from({ length: SYNC_MAX_FILES + 1 }, (_, index) => ({ path: `payload/${index}.md`, digest: 'b'.repeat(64) })),
  }).success, false)

  // Collection walks backwards one batch at a time and stops at the first
  // manifest. It must find that manifest when non-manifest batches follow it,
  // and it must terminate: the walk advances strictly downward by cursor.
  const walkDir = await mkdtemp(join(tmpdir(), 'mnemo-walk-'))
  const walkStore = new SqliteSyncStore(join(walkDir, 'sync.sqlite'))
  const walkScope = 'workspace-walk'
  const fileDigest = text => createHash('sha256').update(text).digest('hex')
  const manifestChange = files => ({ key: 'memory-snapshot', operation: 'put', value: {
    bytes: 'a'.repeat(64),
    files: Object.entries(files).map(([path, text]) => ({ path, digest: fileDigest(text) })),
  } })
  const pushBatch = changes => walkStore.push(walkScope, {
    requestId: randomUUID(), baseCursor: walkStore.pull(walkScope, 0).head, changes,
  })
  for (const text of ['live one', 'live two']) walkStore.putBlob(walkScope, fileDigest(text), Buffer.from(text))
  pushBatch([manifestChange({ 'a.md': 'live one', 'b.md': 'live two' })])
  // Two later batches that carry no manifest at all.
  pushBatch([{ key: 'unrelated', operation: 'put', value: { note: 1 } }])
  pushBatch([{ key: 'unrelated-2', operation: 'put', value: { note: 2 } }])
  walkStore['db'].prepare('UPDATE sync_blobs SET created_at = 0').run()
  walkStore.pruneBlobs(walkScope)
  assert.equal(walkStore.hasBlob(walkScope, fileDigest('live one')), true, 'the walk finds a manifest behind non-manifest batches')
  assert.equal(walkStore.hasBlob(walkScope, fileDigest('live two')), true)
  walkStore.close()
  await rm(walkDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })

  console.log('Verified SRP, saved DSH connection, global incremental sync and conflict resolution, MCP and subagent activity, and restart recovery.')
} finally {
  await Promise.allSettled(clients.map(client => client.close()))
  await stop()
  await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
