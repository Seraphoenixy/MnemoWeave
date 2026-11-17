// Fixtures the sync cases share: a disposable server, an MCP client, and a
// counting transport. A case owns what it starts and disposes it in `after`,
// so one failing case cannot leave a listener or a child process behind for
// the next one.
import { once } from 'node:events'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

/** A loopback port nobody is listening on, so a server can bind it. */
export async function availablePort() {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address()
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  return port
}

/**
 * One standalone sync server process.
 *
 * It resolves its own storage and auth file from the environment, which is what
 * makes it a separate artifact rather than an in-process handler: the cases
 * that use it are checking the shipped launcher too.
 */
export function startServer(input) {
  const { command, args, env, directory, port, token } = input
  const state = { child: undefined, done: undefined, stderr: '' }
  const processEnv = { ...env, MNEMOWEAVE_SYNC_PORT: String(port), MNEMOWEAVE_SYNC_TOKEN: token }
  const started = (async () => {
    const child = spawn(command, args, { cwd: directory, env: processEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    state.child = child
    state.done = once(child, 'exit')
    child.stderr.setEncoding('utf8').on('data', chunk => { state.stderr += chunk })
    const timeout = AbortSignal.timeout(10_000)
    await Promise.race([
      once(child.stdout, 'data', { signal: timeout }),
      state.done.then(([code]) => { throw new Error('Standalone server exited with ' + code + '\n' + state.stderr) }),
    ])
  })()
  return {
    ready: started,
    get stderr() { return state.stderr },
    /** Whether this run started a child at all, for a case that stops before it. */
    get running() { return state.child !== undefined },
    async stop() {
      if (state.child === undefined) return
      state.child.kill()
      await state.done
      state.child = undefined
    },
  }
}

/** An MCP client over stdio, connected to whichever entry and environment it is given. */
export async function connectMcp(input) {
  const client = new Client({ name: 'mnemoweave-test', version: '1.0.0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [input.entry], env: input.env }))
  return {
    client,
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args })
      if (result.isError) throw new Error(JSON.stringify(result))
      return JSON.parse(result.content[0].text)
    },
    close: () => client.close(),
  }
}

/** Where a case keeps its server copy and its data, inside the case's own directory. */
export function serverPaths(fixture) {
  return {
    entry: join(fixture, 'server.mjs'),
    data: join(fixture, 'store'),
  }
}
