#!/usr/bin/env node
import { isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { RUNTIME_ENTRY_MAX_BYTES } from './components/source-runtime/src/contracts.ts'
import { syncServerEndpoint } from './memory/sync-config.ts'
import { errorMessage } from './host/support/error-message.ts'
import { openWorkingRules } from './memory/working-rules.ts'
import { activityKey } from './memory/activity.ts'
import { WORKING_RULES_ACTIVITY_SCOPE, type MemoryActivityEvent } from './sync/activity-protocol.ts'
import { connectActivitySync } from './sync/client/activity.ts'

const { values } = parseArgs({ options: { 'data-dir': { type: 'string' } } })
const dataDir = values['data-dir']
if (dataDir !== undefined && !isAbsolute(dataDir)) throw new Error('--data-dir must be an absolute legacy workspace memory directory')

const { memory, activity, connectSync } = openWorkingRules(dataDir)
const endpoint = syncServerEndpoint('working-rules')
const rulesSync = endpoint === undefined ? undefined : connectSync(endpoint)
const activitySync = endpoint === undefined ? undefined : connectActivitySync({ ...endpoint, scope: WORKING_RULES_ACTIVITY_SCOPE }, activity)

async function recordActivity(operation: 'read-working-rules' | 'append-working-rules', started: number, outcome: MemoryActivityEvent['outcome'], results?: number) {
  activity.record({
    version: 1, kind: 'memory', id: activityKey('mcp', randomUUID()), at: Date.now(), source: 'runtime',
    operation, outcome, durationMs: Math.round(performance.now() - started),
    ...(results === undefined ? {} : { results }),
  })
  try { await activitySync?.(AbortSignal.timeout(5_000)) }
  catch { console.error('MnemoWeave could not synchronize Working Rules activity') }
}
/**
 * Synchronize when a server is configured, and report the failure instead of
 * throwing it. The MCP tools must keep working against the local Working Rules
 * when the server is unreachable: a session on a laptop away from the network
 * still needs to read and save. The caller says whether the run was synchronized.
 */
const syncRules = async (): Promise<{ synchronized: true } | { synchronized: false; message: string }> => {
  if (rulesSync === undefined) return { synchronized: false, message: 'No sync server is configured' }
  try {
    await rulesSync.sync({ signal: AbortSignal.timeout(15_000) })
    return { synchronized: true }
  } catch (error) {
    // The cause chain matters here: `fetch failed` alone does not say whether
    // the address was refused, unresolvable, or behind a certificate the
    // machine does not trust.
    return { synchronized: false, message: errorMessage(error, 'Sync failed') }
  }
}
/** No endpoint at all is not a failure to report: the tool keeps its plain shape. */
const configured = rulesSync !== undefined

const server = new McpServer({ name: 'mnemo-weave', version: '0.1.0' })

server.registerTool('read_workspace_memory', {
  description: 'Read the shared Working Rules that apply across branches.',
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => {
  const sync = await syncRules()
  const started = performance.now()
  let entries: string[]
  try {
    entries = memory.snapshot().entries
      .filter(entry => entry.target === 'memory' && !entry.branches?.length)
      .map(entry => entry.content)
  } catch (error) {
    await recordActivity('read-working-rules', started, 'failed')
    throw error
  }
  await recordActivity('read-working-rules', started, entries.length === 0 ? 'empty' : 'returned', entries.length)
  // The local copy is authoritative for this answer; an unsynchronized read is
  // still a real read, so it is reported rather than hidden or refused.
  return { content: [{ type: 'text', text: JSON.stringify(configured && !sync.synchronized ? { entries, sync } : entries) }] }
})

server.registerTool('append_workspace_memory', {
  description: 'Save a durable rule or fact to the shared Working Rules.',
  inputSchema: {
    content: z.string().trim().min(1).refine(
      content => Buffer.byteLength(content, 'utf8') <= RUNTIME_ENTRY_MAX_BYTES,
      { message: `Memory content must fit in ${RUNTIME_ENTRY_MAX_BYTES} UTF-8 bytes` },
    ),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ content }) => {
  // Pull before writing so the new entry joins what the server already holds.
  // A failed pull is not a reason to drop the write: record it and go on, or a
  // member of the team who is offline loses the rule they just asked to keep.
  const before = await syncRules()
  const started = performance.now()
  let result
  try { result = await memory.mutate({ action: 'add', target: 'memory', content }) }
  catch (error) {
    await recordActivity('append-working-rules', started, 'failed')
    throw error
  }
  const [after] = await Promise.all([syncRules(), recordActivity('append-working-rules', started, 'committed')])
  // A configured-but-failed sync is named; a profile with no server keeps the
  // result exactly as it was before synchronization existed.
  const sync = !configured || after.synchronized ? {} : { sync: after }
  return { content: [{ type: 'text', text: JSON.stringify({ ...result, ...sync, ...(before.synchronized || !configured ? {} : { before }) }) }] }
})

await server.connect(new StdioServerTransport())
