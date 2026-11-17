// The packaged Linux bundle, verified without the development tree.
//
// The build workflow extracts the release archive and runs this against the
// bundle's own start.sh, so what is checked is the thing that ships: the bundled
// Node binary starts the server, the server authenticates through PAKE, and a
// sync client built from the source tree can publish and read an activity
// stream against it. Nothing here needs dist/ or a system Node.
//
//   node --experimental-transform-types tests/checks/verify-sync.mjs [start.sh]
//
// Without a launcher the check starts dist/mnemo-weave-sync-server.js, which is
// what a local run after `pnpm build` verifies.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { ActivityStore, activityKey } from '../../src/memory/activity.ts'
import { connectActivitySync } from '../../src/sync/client/activity.ts'
import { SyncClient } from '../../src/sync/client/http.ts'
import { activityScope } from '../../src/sync/client/activity.ts'

const launcher = process.argv[2]
const fixture = await mkdtemp(join(tmpdir(), 'mnemoweave-bundle-'))
const data = join(fixture, 'store')
const password = randomBytes(8).toString('hex')
const env = {
  ...process.env,
  NODE_PATH: '',
  MNEMOWEAVE_SYNC_DATA_DIR: data,
  MNEMOWEAVE_SYNC_AUTH_FILE: join(data, 'auth.json'),
  MNEMOWEAVE_SYNC_TOKEN: '',
}
let child

try {
  // The shipped bundle is launched through its own start.sh, which execs its
  // own Node; a local run copies the built server and starts it with this one.
  let command = launcher
  let args = []
  if (launcher === undefined) {
    command = process.execPath
    const copy = join(fixture, 'server.mjs')
    await copyFile(fileURLToPath(new URL('../../dist/mnemo-weave-sync-server.js', import.meta.url)), copy)
    args = [copy]
  }

  const init = spawnSync(command, [...args, '--init-auth'], {
    cwd: fixture, env, input: password + '\n', encoding: 'utf8', timeout: 20_000,
  })
  assert.equal(init.status, 0, 'the launcher could not initialize authentication:\n' + init.stdout + init.stderr)
  const port = await availablePort()
  child = spawn(command, args, {
    cwd: fixture, env: { ...env, MNEMOWEAVE_SYNC_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  await waitFor(() => output.includes('listening'), 20_000, () => output)
  const base = 'http://127.0.0.1:' + port

  // The health route answers as the deployment's own probe expects.
  const health = await fetch(base + '/health', { signal: AbortSignal.timeout(10_000) })
  assert.deepEqual(await health.json(), { status: 'ok' })

  // An activity stream round-trips: publish, read back from a second client.
  const scope = activityScope('packaged-bundle')
  const first = new ActivityStore(join(fixture, 'activity-a'))
  const second = new ActivityStore(join(fixture, 'activity-b'))
  const event = {
    version: 1, kind: 'memory', id: activityKey('packaged-event'),
    source: 'memory-spaces', operation: 'recall', outcome: 'returned', results: 1,
  }
  first.save(event)
  await connectActivitySync({ url: base, password, scope }, first)()
  await connectActivitySync({ url: base, password, scope }, second)()
  assert.deepEqual(second.activityIds(), [event.id])
  const page = await new SyncClient(base, scope, password).pull(0)
  assert.equal(page.head, 1)

  console.log('Packaged sync server verified: ' + (launcher === undefined ? 'from dist' : launcher))
} finally {
  if (child !== undefined) {
    child.kill()
    await new Promise(resolve => child.once('exit', resolve))
  }
  await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

/** A loopback port nobody is listening on, so the server can bind it. */
async function availablePort() {
  const { createServer } = await import('node:net')
  const { once } = await import('node:events')
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address()
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  return port
}

async function waitFor(ready, timeoutMs, describe) {
  const deadline = Date.now() + timeoutMs
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('the packaged server did not start in time:\n' + describe())
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
