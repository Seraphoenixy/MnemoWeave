#!/usr/bin/env node
import { isAbsolute, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { RUNTIME_ENTRY_MAX_BYTES } from './components/source-runtime/src/contracts.ts'
import { createRuntimeMemorySource } from './components/source-runtime/src/source.ts'
import { createDocumentsMemorySource } from './components/source-documents/src/source.ts'
import { createMemorySpacesSource } from './components/source-memory-spaces/src/source.ts'
import { CATEGORIES, EDGE_TYPES, SOURCES } from './components/source-memory-spaces/src/contracts.ts'
import { PrivateMemorySpaceProviderHost } from './components/source-memory-spaces/src/providers/host.ts'
import mnemonNativeProvider from './components/provider-mnemon-native/src/index.ts'
import { MemoryRuntime } from './core/runtime.ts'
import { DEFAULT_THREE_TIER_VIEW_STRATEGY } from './core/strategy/strategy.ts'
import { REUSABLE_LESSON_CONTENT, TROUBLESHOOTING_RECALL } from './core/strategy/guidance.ts'
import type { MemoryOperationScope } from './core/contracts/index.ts'
import { resolveConfig } from './host/configuration/config.ts'
import { createRuntimeGraph, type MnemonRuntimeGraph } from './host/engine/runtime.ts'
import { errorMessage } from './host/support/error-message.ts'
import { syncServerEndpoint } from './memory/sync-config.ts'
import { openWorkingRules } from './memory/working-rules.ts'
import { activityKey } from './memory/activity.ts'
import { WORKING_RULES_ACTIVITY_SCOPE, type MemoryActivityEvent } from './sync/activity-protocol.ts'
import { connectActivitySync } from './sync/client/activity.ts'

const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    workspace: { type: 'string' },
    'storage-scope': { type: 'string' },
    'storage-dir': { type: 'string' },
  },
})

const dataDir = values['data-dir']
if (dataDir !== undefined && !isAbsolute(dataDir)) throw new Error('--data-dir must be an absolute legacy workspace memory directory')

const storageScopeArg = values['storage-scope'] ?? process.env.MNEMON_STORAGE_SCOPE
const storageScope = (storageScopeArg === 'global' || storageScopeArg === 'workspace' || storageScopeArg === 'custom' || storageScopeArg === 'workspaces')
  ? storageScopeArg
  : 'global'
const storageDir = values['storage-dir'] ?? process.env.MNEMON_STORAGE_DIR
if (storageScope === 'custom' && (storageDir === undefined || storageDir.trim() === '')) {
  throw new Error('--storage-dir (or MNEMON_STORAGE_DIR) is required when --storage-scope is custom')
}
const workspaceRoot = resolve(values.workspace ?? process.cwd())

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
 * when the server is unreachable.
 */
const syncRules = async (): Promise<{ synchronized: true } | { synchronized: false; message: string }> => {
  if (rulesSync === undefined) return { synchronized: false, message: 'No sync server is configured' }
  try {
    await rulesSync.sync({ signal: AbortSignal.timeout(15_000) })
    return { synchronized: true }
  } catch (error) {
    return { synchronized: false, message: errorMessage(error, 'Sync failed') }
  }
}

const configured = rulesSync !== undefined

/** Lazy-initialized Composable Memory runtime graph for Documents & Memory Spaces tools. */
let cachedRuntime: { extensions: MemoryRuntime; graph: MnemonRuntimeGraph } | undefined
const mcpSessionId = `mcp-${randomUUID()}`

function ensureRuntimeGraph(): MnemonRuntimeGraph {
  if (cachedRuntime !== undefined) return cachedRuntime.graph
  const config = resolveConfig({
    storageScope,
    ...(storageDir === undefined ? {} : { dataDir: storageDir }),
  })
  const extensions = new MemoryRuntime()
  const providerHost = new PrivateMemorySpaceProviderHost('include:mnemon-source-memory-spaces')
  const fakeOwner = { effect: (cb: () => unknown) => cb() } as never
  mnemonNativeProvider.apply(fakeOwner, providerHost.bind('mnemon-native', 'mnemon-native', undefined), undefined)
  const providerSnapshot = providerHost.snapshot()

  extensions.service.installContributions({ strategies: [DEFAULT_THREE_TIER_VIEW_STRATEGY] }, { instanceId: 'mnemon' })
  extensions.service.installContributions({ sources: [createRuntimeMemorySource()] }, { instanceId: 'include:mnemon-source-runtime' })
  extensions.service.installContributions({ sources: [createDocumentsMemorySource()] }, { instanceId: 'include:mnemon-source-documents' })
  extensions.service.installContributions({ sources: [createMemorySpacesSource(providerSnapshot)] }, { instanceId: 'include:mnemon-source-memory-spaces' })

  const graph = createRuntimeGraph(config, workspaceRoot, extensions)
  cachedRuntime = { extensions, graph }
  return graph
}

let activeTurnId: string | undefined

async function withTurn<T>(fn: (graph: MnemonRuntimeGraph, scope: MemoryOperationScope) => Promise<T>, options: { refreshAfter?: boolean } = {}): Promise<T> {
  const graph = ensureRuntimeGraph()
  if (activeTurnId === undefined) {
    activeTurnId = `mcp-turn-${randomUUID()}`
  }
  const scope: MemoryOperationScope = {
    storage: graph.config.storageScope,
    workspaceId: workspaceRoot,
    sessionId: mcpSessionId,
    agentId: mcpSessionId,
  }
  await graph.composableTurns.beginTurn(activeTurnId, scope)
  try {
    return await fn(graph, scope)
  } finally {
    if (options.refreshAfter) {
      const stale = activeTurnId
      activeTurnId = undefined
      graph.composableTurns.endTurn(stale)
    }
  }
}

async function sourceAction(graph: MnemonRuntimeGraph, scope: MemoryOperationScope, typeId: string, actionId: string, input: unknown) {
  const receipt = await graph.source(typeId, scope).action(actionId, input, offer => graph.config.writeEnabled && offer.authority === undefined)
  const details = receipt.details
  const result = typeof details === 'object' && details !== null && !Array.isArray(details) && 'result' in details ? details.result : details
  return {
    ...(typeof result === 'object' && result !== null && !Array.isArray(result) ? result : { result }),
    memoryReceipt: {
      status: receipt.status,
      completion: receipt.completion,
      ...(receipt.committedAt === undefined ? {} : { committedAt: receipt.committedAt }),
    },
  }
}

function jsonText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
}

const server = new McpServer({ name: 'mnemo-weave', version: '0.1.2' })

// 1. Working Rules (read companion for MCP hosts without system-prompt injection + DSH mnemo_runtime_memory)
server.registerTool('mnemo_working_rules', {
  description: 'Read the shared Working Rules (standing preferences, constraints, and conventions). Returns the active Working Rules projection and entries.',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => {
  const sync = await syncRules()
  const started = performance.now()
  let entries
  let text: string
  try {
    const visible = memory.snapshot().entries.filter(entry => entry.target === 'memory')
    const formatEntry = (content: string) => (/^\s*(?:[-*]|\d+\.)\s/u.test(content) ? content : `- ${content}`)
    const pinned = visible.filter(entry => entry.pinned === true).map(entry => formatEntry(entry.content)).join('\n')
    const plain = visible.filter(entry => entry.pinned !== true).map(entry => formatEntry(entry.content)).join('\n')
    text = [
      pinned === '' ? '' : `#### Pinned Rules (must follow)\n${pinned}`,
      plain === '' ? '' : `${pinned === '' ? '' : '#### Additional Rules\n'}${plain}`,
    ].filter(Boolean).join('\n\n')
    entries = visible
  } catch (error) {
    await recordActivity('read-working-rules', started, 'failed')
    throw error
  }
  await recordActivity('read-working-rules', started, entries.length === 0 ? 'empty' : 'returned', entries.length)
  return jsonText({
    entries: entries.map(entry => ({
      content: entry.content,
      importance: entry.importance,
      ...(entry.pinned === true ? { pinned: true } : {}),
    })),
    text,
    ...(configured && !sync.synchronized ? { sync } : {}),
  })
})

server.registerTool('mnemo_runtime_memory', {
  description: 'Maintain the shared Working Rules. Save an explicit user preference or standing behavior rule that should guide future turns by default. A general request to remember something does not determine its destination. Skip retrieved evidence unless the user explicitly asks to save it. Skip guesses, assistant-authored claims, temporary progress, secrets, easily rediscovered facts, and skill-covered guidance. Existing rules may move to the local archive when capacity is exceeded.',
  inputSchema: z.strictObject({
    action: z.enum(['add', 'replace', 'remove']).describe('add a new entry, replace one uniquely matched entry, or remove one uniquely matched entry.'),
    content: z.string().trim().min(1).refine(
      content => Buffer.byteLength(content, 'utf8') <= RUNTIME_ENTRY_MAX_BYTES,
      { message: `Memory content must fit in ${RUNTIME_ENTRY_MAX_BYTES} UTF-8 bytes` },
    ).optional().describe('Compact entry content. Required for add and replace.'),
    old_text: z.string().trim().min(1).optional().describe('Full content of the existing entry or a unique substring. A unique full-content match takes precedence. Required for replace and remove.'),
    importance: z.enum(['critical', 'normal', 'low']).optional().describe('critical for explicit must/always/never rules; low for transient facts; normal by default.'),
  }),
  annotations: { readOnlyHint: false, openWorldHint: false },
}, async ({ action, content, old_text, importance }) => {
  const before = await syncRules()
  const started = performance.now()
  let result
  try {
    result = await memory.mutate({
      action,
      target: 'memory',
      ...(content === undefined ? {} : { content }),
      ...(old_text === undefined ? {} : { oldText: old_text }),
      ...(importance === undefined ? {} : { importance }),
    })
  } catch (error) {
    await recordActivity('append-working-rules', started, 'failed')
    throw error
  }
  const [after] = await Promise.all([syncRules(), recordActivity('append-working-rules', started, 'committed')])
  const sync = !configured || after.synchronized ? {} : { sync: after }
  return jsonText({ ...result, ...sync, ...(before.synchronized || !configured ? {} : { before }) })
})

// 2. Memory Spaces Read / Inspect Tools
server.registerTool('mnemo_memory_bodies', {
  description: 'Inspect Memory Space IDs, capabilities, activation, and health. Use for space management or to check whether a specific read or write operation is supported. memoryBodyId means Memory Space ID. For broad Recall, omit memoryBodyIds and let mnemo_recall search the pinned active spaces.',
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => withTurn(async (graph, scope) => {
  const evidence = await graph.source('memory-spaces', scope).route('inspect', { section: 'directory' })
  return jsonText(evidence.output ?? evidence)
}))

server.registerTool('mnemo_recall', {
  description: `Recall durable evidence from the pinned active Memory Spaces. ${TROUBLESHOOTING_RECALL} Use one focused query and, only if needed, one different refinement. Duplicate queries replay earlier evidence. truncated=true means the returned evidence is partial. Project records belong in mnemo_document_search; Recall may return a cold archive index.`,
  inputSchema: {
    query: z.string().describe('Focused natural-language memory query.'),
    mode: z.enum(['smart', 'keyword', 'basic']).optional().describe('smart=graph-enhanced default, keyword=token ranking, basic=SQL LIKE fallback.'),
    limit: z.number().int().min(1).optional().describe('Maximum requested results.'),
    entities: z.array(z.string()).max(50).optional().describe('Optional entity names to anchor and prioritize recall.'),
    memoryBodyIds: z.array(z.string()).optional().describe('Optional known active Memory Space ids to narrow recall. Omit this field to search every pinned active space; do not list the catalog only to populate it.'),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async (args) => withTurn(async (graph, scope) => {
  const evidence = await graph.source('memory-spaces', scope).route('recall', args)
  return jsonText(evidence.output ?? evidence)
}))

server.registerTool('mnemo_related', {
  description: 'Follow relationships from an insight admitted by Recall when graph context would help. Check capabilities.related for the owning Memory Space. truncated=true means the returned evidence is partial. Providers may differ in whether they report or filter edge types.',
  inputSchema: {
    id: z.string().describe('Insight id returned by mnemo_recall.'),
    depth: z.number().int().min(1).max(5).optional().describe('Traversal depth. Default 2.'),
    edge: z.enum([...EDGE_TYPES]).optional(),
    memoryBodyId: z.string().optional().describe('Active Memory Space that returned this insight id.'),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async (args) => withTurn(async (graph, scope) => {
  const evidence = await graph.source('memory-spaces', scope).route('related', args)
  return jsonText(evidence.output ?? evidence)
}))

server.registerTool('mnemo_status', {
  description: 'Check a bounded health summary for memory-provider integrations and Memory Spaces. Use only when a memory operation fails or the user asks about memory health; full paths, settings, directories, and per-Space statistics stay in the control plane.',
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => withTurn(async (graph, scope) => {
  const evidence = await graph.source('memory-spaces', scope).route('inspect', { section: 'health' })
  return jsonText(evidence.output ?? evidence)
}))

// 3. Workspace Documents Tools
server.registerTool('mnemo_document_search', {
  description: 'Run one focused search over the workspace-scoped managed Documents when the task needs a workspace record. Results contain bounded query-local evidence, not complete records. Cold archives are excluded unless a known archive reference requires them. It searches Documents only: memories in Memory Spaces are never in its results, so recall those with mnemo_recall.',
  inputSchema: {
    query: z.string().describe('Focused natural-language or keyword query. Empty lists recent documents.'),
    workspaceId: z.string().optional().describe('Registered workspace ID. Supply only when the user explicitly selects another workspace.'),
    includeArchived: z.boolean().optional().describe('Include cold archived originals only for explicit deep-reference inspection.'),
    limit: z.number().int().min(1).optional().describe('Maximum requested results.'),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async (args) => withTurn(async (graph, scope) => {
  const evidence = await graph.source('documents', scope).route('search', args)
  return jsonText(evidence.output ?? evidence)
}))

server.registerTool('mnemo_document_manage', {
  description: 'Create or update one managed workspace Document through the Mnemon Documents control plane. Use for a substantial workspace record whose rationale, evidence, or steps should be preserved together, such as a design, investigation, runbook, or handoff. Skip routine progress, raw transcripts, and secrets. Source paths are references inside the workspace and are never edited.',
  inputSchema: {
    action: z.enum(['create', 'update', 'archive']),
    id: z.string().optional().describe('Required for update and archive.'),
    title: z.string().optional().describe('Meaningful workspace-document title. Required for create.'),
    description: z.string().optional().describe('Concise routing description.'),
    content: z.string().optional().describe('Managed Markdown body. For a reference-only record, omit the body and provide sourcePaths.'),
    sourcePaths: z.array(z.string()).optional().describe('Read-only source paths relative to the workspace.'),
  },
  annotations: { readOnlyHint: false, openWorldHint: false },
}, async (args) => withTurn(async (graph, scope) => {
  if (args.action === 'archive') {
    if (args.id === undefined) throw new Error('document id is required for archive')
    return jsonText(await graph.source('documents', scope).mutate('archive', { id: args.id }))
  }
  const request = args.action === 'create'
    ? { action: 'create', title: args.title ?? '', content: args.content ?? '', ...(args.description === undefined ? {} : { description: args.description }), ...(args.sourcePaths === undefined ? {} : { sourcePaths: args.sourcePaths }), sessionIds: [mcpSessionId] }
    : { action: 'update', id: args.id ?? '', ...(args.title === undefined ? {} : { title: args.title }), ...(args.description === undefined ? {} : { description: args.description }), ...(args.content === undefined ? {} : { content: args.content }), ...(args.sourcePaths === undefined ? {} : { sourcePaths: args.sourcePaths }), sessionIds: [mcpSessionId] }
  return jsonText(await sourceAction(graph, scope, 'documents', 'manage', request))
}, { refreshAfter: true }))

// 4. Memory Spaces Write / Management Tools
server.registerTool('mnemo_remember', {
  description: `Store one self-contained durable insight in a selected provider-backed Memory Space. Use this when the user explicitly chooses a Memory Space or when a verified lesson or durable insight should be retrieved on demand, such as a diagnosed cause and remedy or a tested workaround. ${REUSABLE_LESSON_CONTENT} Save each distinct qualifying lesson separately when it is independently useful. Keep related details together when they form one lesson. Respect requests not to remember. Choose a suitable writable space, check for equivalent insights when recall is available, and wait for the provider receipt. Skip duplicates, transcripts, temporary progress, guesses, secrets, routine observations, and lessons already covered by an equivalent retrievable memory entry.`,
  inputSchema: {
    content: z.string().describe('One concise, self-contained durable insight.'),
    replacesId: z.string().optional().describe('A recalled insight ID in the same active Space, only when verified evidence supersedes its conclusion.'),
    category: z.enum([...CATEGORIES]).optional(),
    importance: z.number().int().min(1).max(5).optional().describe('Durable value from 1 through 5.'),
    entities: z.array(z.string()).max(50).optional().describe('Named entities.'),
    source: z.enum([...SOURCES]).optional().describe('Defaults to agent for model-authored writeback.'),
    memoryBodyId: z.string().optional().describe('Target Memory Space id; the write goes there or nowhere. Required unless exactly one space is active.'),
  },
  annotations: { readOnlyHint: false, openWorldHint: false },
}, async (args) => withTurn(async (graph, scope) => {
  return jsonText(await sourceAction(graph, scope, 'memory-spaces', 'remember', { ...args, source: args.source ?? 'agent' }))
}, { refreshAfter: true }))

server.registerTool('mnemo_link', {
  description: 'Create a typed bidirectional relationship that improves future recall. Verify both insight IDs in the same readable Memory Space and confirm capabilities.link. Select a relationship supported by the evidence.',
  inputSchema: {
    sourceId: z.string().describe('Exact ID of the first verified insight.'),
    targetId: z.string().describe('Exact ID of the second verified insight, in the same Memory Space.'),
    type: z.enum([...EDGE_TYPES]).optional().describe('Relationship type supported by the evidence. Default semantic.'),
    weight: z.number().min(0).max(1).optional().describe('Relationship confidence. Default 0.5.'),
    reason: z.string().max(1000).optional().describe('Brief evidence-based explanation of the relationship.'),
    memoryBodyId: z.string().optional().describe('Memory Space ID containing both insights. Specify it if the IDs could be ambiguous.'),
  },
  annotations: { readOnlyHint: false, openWorldHint: false },
}, async (args) => withTurn(async (graph, scope) => {
  return jsonText(await sourceAction(graph, scope, 'memory-spaces', 'link', args))
}))

server.registerTool('mnemo_forget', {
  description: 'Destructively forget an insight by exact ID in a Memory Space with capabilities.forget. Use only on explicit request or when verified obsolete or incorrect. Resolve the ID in the current readable View and specify memoryBodyId if it exists in multiple spaces. Mnemon Native uses soft deletion.',
  inputSchema: {
    id: z.string().describe('Exact insight ID previously admitted by this View or found in a readable Memory Space.'),
    memoryBodyId: z.string().optional().describe('Memory Space ID. Required if multiple readable spaces contain this insight ID.'),
  },
  annotations: { readOnlyHint: false, openWorldHint: false },
}, async (args) => withTurn(async (graph, scope) => {
  return jsonText(await sourceAction(graph, scope, 'memory-spaces', 'forget', args))
}, { refreshAfter: true }))

server.registerTool('mnemo_memory_body_create', {
  description: 'Create a new isolated Memory Space only on an explicit user request to create one. First inspect mnemo_memory_bodies.persistenceStrategy. An ordinary request to save an insight does not authorize creating a space.',
  inputSchema: {
    name: z.string().describe('Topic-specific human-readable name that remains meaningful in the directory.'),
    description: z.string().describe('Precise routing boundary: what durable knowledge belongs here and when it should be recalled.'),
    providerId: z.string().optional().describe('Automatic mode only: one eligible Provider id from persistenceStrategy.'),
    reason: z.string().optional().describe('Automatic mode only: concise user-facing reason for this Provider choice.'),
    confidence: z.enum(['high', 'medium', 'low']).optional().describe('Automatic mode only: calibrated confidence in the Provider choice.'),
  },
  annotations: { readOnlyHint: false, openWorldHint: false },
}, async (args) => withTurn(async (graph, scope) => {
  return jsonText(await sourceAction(graph, scope, 'memory-spaces', 'manage-spaces', {
    operation: 'create',
    request: { name: args.name, description: args.description },
    ...(args.providerId === undefined && args.reason === undefined && args.confidence === undefined
      ? {}
      : { selection: { providerId: args.providerId ?? '', reason: args.reason ?? '', confidence: args.confidence ?? '' } }),
  }))
}, { refreshAfter: true }))

server.registerTool('mnemo_memory_body_update', {
  description: 'Update a Memory Space name, routing description, or activation only when explicitly requested by the user. Activation controls read eligibility from the next turn, default write destination selection, and whether model-initiated writes can target a space.',
  inputSchema: {
    memoryBodyId: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    active: z.boolean().optional(),
  },
  annotations: { readOnlyHint: false, openWorldHint: false },
}, async (args) => withTurn(async (graph, scope) => {
  return jsonText(await sourceAction(graph, scope, 'memory-spaces', 'manage-spaces', { operation: 'update', ...args }))
}, { refreshAfter: true }))

server.registerTool('mnemo_memory_body_merge', {
  description: 'Non-destructively merge complete Mnemon Native source Memory Spaces into one Mnemon Native target through import, preserving durable nodes and typed graph edges. External providers are not mergeable. Use only when the user explicitly requests consolidation. Source databases are retained and merely deactivated by default.',
  inputSchema: {
    targetMemoryBodyId: z.string(),
    sourceMemoryBodyIds: z.array(z.string()).min(1).max(20).describe('Memory Space IDs to merge into the target space.'),
    deactivateSources: z.boolean().optional().describe('Defaults to true. Never deletes source databases.'),
  },
  annotations: { readOnlyHint: false, openWorldHint: false },
}, async (args) => withTurn(async (graph, scope) => {
  return jsonText(await sourceAction(graph, scope, 'memory-spaces', 'manage-spaces', { operation: 'merge', ...args }))
}, { refreshAfter: true }))

const cleanup = () => {
  cachedRuntime?.graph.dispose()
  void cachedRuntime?.extensions.dispose()
}
process.once('SIGINT', cleanup)
process.once('SIGTERM', cleanup)

await server.connect(new StdioServerTransport())
