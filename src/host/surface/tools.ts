import { REUSABLE_LESSON_CONTENT, TROUBLESHOOTING_RECALL } from '../../core/strategy/guidance.ts'
import type { MemoryRuntime } from '../../core/runtime.ts'
import { memoryTool } from '../contracts/memory-tools.ts'
import type { HostContextShape, ToolDefinition, ToolExecution } from '../support/dsh.ts'
import type { DocumentMutation } from 'dsh-mnemo-weave/source-documents/contracts'
import type { RuntimeMemoryImportance } from 'dsh-mnemo-weave/source-runtime/contracts'
import { CATEGORIES, CATEGORY_PARAMETER_DESCRIPTION, EDGE_TYPES, ENTITY_PARAMETER_DESCRIPTION, SOURCES, type Category, type EdgeType, type Source } from 'dsh-mnemo-weave/source-memory-spaces/contracts'
import { assertParticipation } from '../support/access.ts'
import type { MemoryCapability, MemoryJsonValue } from '../../core/contracts/index.ts'
import { agentScope, type MnemonAgentRuntimeSource, type MnemonRuntimeGraph } from '../engine/runtime.ts'
import { isSubagent, MnemonSubagentCoordinator } from '../delegation/subagent.ts'
import { namedToolPresentation } from '../review/activity-presentation.ts'
import { assertAgentMemoryIncluded } from '../support/workspace-exclusion.ts'
import { documentReceipt } from '../support/document-receipt.ts'

const text = (value: unknown): Array<{ type: 'text'; text: string }> => [{
  type: 'text',
  text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
}]

function definition(value: ToolDefinition): ToolDefinition {
  return { ...value, parameters: { ...value.parameters, additionalProperties: false } }
}

// DSH tool outputs use its supported JSON Schema subset. `type: "json"` is
// valid in the parameter DSL, but it is not a JSON Schema type.
const JSON_OBJECT_OUTPUT = { type: 'object', additionalProperties: true } as const

/** Register a deliberately small model-facing surface over Mnemon's protocol. */
function requireAgent(exec: ToolExecution) {
  if (exec.agent === undefined) throw new Error('Mnemon semantic operations require a live DSH agent')
  return exec.agent
}

/**
 * Named product tools are views over the same Source Route/Action protocol. Each family registers its tools in the
 * historical registry order, which puts Memory Spaces' reads before the Documents tools and its writes after
 * the runtime memory tool. DSH's prompt assembler independently orders wire schemas.
 */
export function registerTools(ctx: HostContextShape, runtimeSource: MnemonAgentRuntimeSource, coordinator: MnemonSubagentCoordinator, contributions: MemoryRuntime, initialReady?: Promise<unknown>): () => void {
  const definitions: ToolDefinition[] = []
  const catalog = { tools: { register: (tool: ToolDefinition) => { definitions.push(tool) } } } as unknown as HostContextShape
  const helpers = toolHelpers(runtimeSource)
  registerMemorySpaceReadTools(catalog, helpers, coordinator)
  registerDocumentTools(catalog, helpers, coordinator)
  registerRuntimeTools(catalog, helpers, coordinator)
  registerMemorySpaceWriteTools(catalog, helpers, coordinator)
  const registered = new Map<string, () => unknown>()
  let active = true
  let ready = initialReady === undefined
  const reconcile = (snapshot: ReturnType<MemoryRuntime['contributionSnapshot']>) => {
    const types = new Set(snapshot.sources.map(source => source.definition.manifest.typeId))
    for (const tool of definitions) {
      const type = memoryTool(tool.name)?.sourceTypeId
      const available = type === undefined || (ready && types.has(type))
      if (!available) {
        registered.get(tool.name)?.()
        registered.delete(tool.name)
      } else if (!registered.has(tool.name)) {
        const dispose = ctx.tools.register(tool)
        if (typeof dispose !== 'function') throw new Error('dsh-mnemo-weave tool registration did not return a disposer: ' + tool.name)
        registered.set(tool.name, dispose as () => unknown)
      }
    }
  }
  const unsubscribe = contributions.onCommittedContributionsChanged(reconcile)
  const dispose = () => {
    if (!active) return
    active = false
    unsubscribe()
    for (const release of registered.values()) release()
    registered.clear()
  }
  try { reconcile(contributions.committedContributionSnapshot()) }
  catch (error) { dispose(); throw error }
  // The Starter loads Host before Sources. Publish its initial named families
  // together after the Loader settles, without replacing independent tools.
  void initialReady?.then(() => {
    if (!active) return
    ready = true
    reconcile(contributions.committedContributionSnapshot())
  }).catch(error => {
    if (active) console.warn('dsh-mnemo-weave: could not initialize Source tool families', error)
  })
  return dispose
}

/** What the handlers of every family share: the calling Agent's runtime graph and Sources, its checks, and a Source Action call. */
function toolHelpers(runtimeSource: MnemonAgentRuntimeSource) {
  const runtimeFor = (exec: ToolExecution): MnemonRuntimeGraph => {
    const agent = requireAgent(exec)
    assertAgentMemoryIncluded(runtimeSource, agent)
    return runtimeSource.forAgent(agent)
  }
  const sourceFor = (exec: ToolExecution, typeId: string) => {
    const graph = runtimeFor(exec)
    return graph.source(typeId, agentScope(requireAgent(exec), graph.config))
  }
  const requireSource = (exec: ToolExecution, typeId: string, capability: MemoryCapability): MnemonRuntimeGraph => {
    const graph = runtimeFor(exec)
    assertParticipation(graph.config, typeId, capability, 'automatic')
    if (['write', 'archive', 'link', 'forget', 'import'].includes(capability) && !runtimeSource.config.writeEnabled) throw new Error('dsh-mnemo-weave is configured read-only')
    return graph
  }
  const config = runtimeSource.config
  const composableTurn = (exec: ToolExecution) => {
    const agent = requireAgent(exec)
    const graph = runtimeFor(exec)
    const manager = graph.composableTurns
    const turn = manager.activeTurn(agentScope(agent, graph.config).agentId!)
    if (turn === undefined) throw new Error('Composable Memory View is not pinned to the current turn')
    return { manager, turn }
  }
  const sourceAction = async (exec: ToolExecution, typeId: string, actionId: string, input: unknown) => {
    const receipt = await sourceFor(exec, typeId).action(actionId, input, offer => runtimeSource.config.writeEnabled && offer.authority === undefined, exec.signal)
    const details = receipt.details
    const result = typeof details === 'object' && details !== null && !Array.isArray(details) && 'result' in details ? details.result : details
    // Keep familiar product fields, but never erase accepted/candidate/unknown completion for the model.
    return { ...(typeof result === 'object' && result !== null && !Array.isArray(result) ? result : { result }),
      memoryReceipt: { status: receipt.status, completion: receipt.completion, ...(receipt.committedAt === undefined ? {} : { committedAt: receipt.committedAt }) },
    }
  }
  return { runtimeFor, sourceFor, requireSource, config, composableTurn, sourceAction }
}

type ToolHelpers = ReturnType<typeof toolHelpers>

/** Memory Spaces' catalog, Recall, Related and health. */
function registerMemorySpaceReadTools(ctx: HostContextShape, { sourceFor, requireSource }: ToolHelpers, coordinator: MnemonSubagentCoordinator): void {
  ctx.tools.register(definition({
    name: 'mnemo_memory_bodies',
    description: 'Inspect Memory Space IDs, capabilities, activation, and health. Use for space management or to check whether a specific read or write operation is supported. memoryBodyId means Memory Space ID. For broad Recall, omit memoryBodyIds and let mnemo_recall search the pinned active spaces.',
    parameters: { type: 'object', properties: {} },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value) },
    async execute(_args: unknown, exec: ToolExecution) {
      requireSource(exec, 'memory-spaces', 'status')
      const evidence = await sourceFor(exec, 'memory-spaces').route('inspect', { section: 'directory' }, exec.signal)
      return evidence.output ?? evidence
    },
    presentCall: () => ({ card: 'generic', title: 'Inspect Mnemon Memory Spaces', kind: 'search' }),
    presentResult: () => ({ card: 'generic', title: 'Mnemon Memory Spaces ready' }),
  } as never))

  ctx.tools.register(definition({
    name: 'mnemo_recall',
    description: `Recall durable evidence from the pinned active Memory Spaces. ${TROUBLESHOOTING_RECALL} Use one focused query and, only if needed, one different refinement. Duplicate queries replay earlier evidence. truncated=true means the returned evidence is partial. Project records belong in mnemo_document_search; Recall may return a cold archive index.`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Focused natural-language memory query.' },
        mode: { type: 'string', enum: ['smart', 'keyword', 'basic'], description: 'smart=graph-enhanced default, keyword=token ranking, basic=SQL LIKE fallback.' },
        limit: { type: 'integer', minimum: 1, description: 'Maximum requested results. The initial query admits up to 4 results and 3600 content characters. Both queries share up to 6 results and 4800 content characters.' },
        entities: { type: 'array', items: { type: 'string' }, maxItems: 50, description: 'Optional entity names to anchor and prioritize recall.' },
        memoryBodyIds: { type: 'array', items: { type: 'string' }, description: 'Optional known active Memory Space ids to narrow recall. Omit this field to search every pinned active space; do not list the catalog only to populate it. The Host rejects ids outside the pinned Source.' },
      },
      required: ['query'],
    },
    output: {
      schema: JSON_OBJECT_OUTPUT,
      render: (_args: unknown, value: unknown) => text(value),
      presentationMeta: namedToolPresentation('mnemo_recall'),
    },
    async execute(args: { query: string; mode?: 'smart' | 'keyword' | 'basic'; limit?: number; entities?: string[]; memoryBodyIds?: string[] }, exec: ToolExecution) {
      requireSource(exec, 'memory-spaces', 'recall')
      const agent = requireAgent(exec)
      return coordinator.recall(agent, args, exec.signal, { requirePinnedView: true })
    },
    presentCall: (args: { query: string }) => ({ card: 'generic', title: 'Recall Mnemon memory', kind: 'search', rawInput: args.query }),
    presentResult: () => ({ card: 'generic', title: 'Mnemon recall complete' }),
  } as never))

  ctx.tools.register(definition({
    name: 'mnemo_related',
    description: 'Follow relationships from an insight admitted by this turn’s Recall when graph context would help. One traversal per turn. Check capabilities.related for the owning Memory Space. truncated=true means the returned evidence is partial. Providers may differ in whether they report or filter edge types.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Insight id returned by mnemo_recall.' },
        depth: { type: 'integer', minimum: 1, maximum: 5, description: 'Traversal depth. Default 2.' },
        edge: { type: 'string', enum: [...EDGE_TYPES] },
        memoryBodyId: { type: 'string', description: 'Active Memory Space that returned this insight id.' },
      },
      required: ['id'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value),
      presentationMeta: namedToolPresentation('mnemo_related') },
    async execute(args: { id: string; depth?: number; edge?: EdgeType; memoryBodyId?: string }, exec: ToolExecution) {
      requireSource(exec, 'memory-spaces', 'related')
      const agent = requireAgent(exec)
      return coordinator.related(agent, args.id, args.memoryBodyId, exec.signal, {
        ...(args.depth === undefined ? {} : { depth: args.depth }),
        ...(args.edge === undefined ? {} : { edge: args.edge }),
        requirePinnedView: true,
      })
    },
    presentCall: (args: { id: string }) => ({ card: 'generic', title: 'Traverse Mnemon graph', kind: 'search', rawInput: args.id }),
    presentResult: () => ({ card: 'generic', title: 'Mnemon graph traversal complete' }),
  } as never))

  ctx.tools.register(definition({
    name: 'mnemo_status',
    description: 'Check a bounded health summary for memory-provider integrations and Memory Spaces. Use only when a memory operation fails or the user asks about memory health; full paths, settings, directories, and per-Space statistics stay in the control plane.',
    parameters: { type: 'object', properties: {} },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value) },
    async execute(_args: unknown, exec: ToolExecution) {
      requireSource(exec, 'memory-spaces', 'status')
      const evidence = await sourceFor(exec, 'memory-spaces').route('inspect', { section: 'health' }, exec.signal)
      const health = evidence.output ?? evidence
      return { ...health as Record<string, unknown>, idleReviewAccess: coordinator.reviewAccessStatus(requireAgent(exec)) }
    },
    presentCall: () => ({ card: 'generic', title: 'Check Mnemon status', kind: 'other' }),
    presentResult: () => ({ card: 'generic', title: 'Mnemon status checked' }),
  } as never))
}

/** The workspace Documents tools. */
function registerDocumentTools(ctx: HostContextShape, { requireSource, config, sourceAction }: ToolHelpers, coordinator: MnemonSubagentCoordinator): void {
  ctx.tools.register(definition({
    name: 'mnemo_document_search',
    description: 'Run one focused search over the workspace-scoped managed Documents the current View pins when the task needs a workspace record. The Host admits only one Documents query per executing Agent turn; parallel calls share that slot, while child turns have independent budgets. Results contain bounded query-local evidence, not complete records. Cold archives are excluded unless a known archive reference requires them. It searches Documents only: memories in Memory Spaces are never in its results, so recall those with mnemo_recall.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Focused natural-language or keyword query. Empty lists recent documents.' },
        workspaceId: { type: 'string', description: 'Registered DSH workspace ID. Supply only when the user explicitly selects another workspace.' },
        includeArchived: { type: 'boolean', description: 'Include cold archived originals only for explicit deep-reference inspection.' },
        limit: { type: 'integer', minimum: 1, description: 'Maximum requested results. Model output is capped at 4.' },
      },
      required: ['query'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value),
      presentationMeta: namedToolPresentation('mnemo_document_search') },
    async execute(args: { query: string; includeArchived?: boolean; limit?: number; workspaceId?: string }, exec: ToolExecution) {
      const agent = requireAgent(exec)
      requireSource(exec, 'documents', 'search')
      return coordinator.documentQuery(agent, args, exec.signal)
    },
    presentCall: (args: { query: string }) => ({ card: 'generic', title: 'Search Mnemon Documents', kind: 'search', rawInput: args.query }),
    presentResult: () => ({ card: 'generic', title: 'Mnemon Documents ready' }),
  } as never))

  ctx.tools.register(definition({
    name: 'mnemo_document_manage',
    description: 'Create or update one managed workspace Document through the Mnemon Documents control plane. Use for a substantial workspace record whose rationale, evidence, or steps should be preserved together, such as a design, investigation, runbook, or handoff. Skip routine progress, raw transcripts, and secrets. Source paths are references inside the workspace and are never edited. Idle reviews may only create or update and fail if the write exceeds capacity. Explicit archive requests may write a durable Mnemon cold-reference through an isolated subagent.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'archive'] },
        id: { type: 'string', description: 'Required for update and archive.' },
        title: { type: 'string', description: 'Meaningful workspace-document title. Required for create.' },
        description: { type: 'string', description: 'Concise routing description.' },
        content: { type: 'string', description: 'Managed Markdown body. For a reference-only record, omit the body and provide sourcePaths.' },
        sourcePaths: { type: 'array', items: { type: 'string' }, description: 'Read-only source paths relative to the workspace.' },
      },
      required: ['action'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value),
      presentationMeta: namedToolPresentation('mnemo_document_manage') },
    execute: (args: { action: 'create' | 'update' | 'archive'; id?: string; title?: string; description?: string; content?: string; sourcePaths?: string[] }, exec: ToolExecution) => {
      if (!config.writeEnabled) throw new Error('dsh-mnemo-weave is configured read-only (writeEnabled: false)')
      const agent = requireAgent(exec)
      if (args.action === 'archive') {
        // Without a Memory Spaces layer to index into, the coordinator archives locally (#336).
        requireSource(exec, 'documents', 'archive')
        if (isSubagent(agent) && !coordinator.isUserContinuation(agent)) throw new Error('idle document workers cannot cold-archive directly')
        if (args.id === undefined) throw new Error('document id is required for archive')
        return Promise.resolve(coordinator.archiveDocument(agent, args.id, exec.signal)).then(documentReceipt)
      }
      requireSource(exec, 'documents', 'write')
      const request: DocumentMutation = args.action === 'create'
        ? { action: 'create', title: args.title ?? '', content: args.content ?? '', ...(args.description === undefined ? {} : { description: args.description }), ...(args.sourcePaths === undefined ? {} : { sourcePaths: args.sourcePaths }), sessionIds: [agent.id] }
        : { action: 'update', id: args.id ?? '', ...(args.title === undefined ? {} : { title: args.title }), ...(args.description === undefined ? {} : { description: args.description }), ...(args.content === undefined ? {} : { content: args.content }), ...(args.sourcePaths === undefined ? {} : { sourcePaths: args.sourcePaths }), sessionIds: [agent.id] }
      return Promise.resolve(isSubagent(agent) ? sourceAction(exec, 'documents', 'manage', request) : coordinator.document(agent, request, exec.signal)).then(documentReceipt)
    },
    presentCall: (args: { action: string; title?: string }) => ({ card: 'generic', title: `${args.action} Mnemon Document`, kind: 'edit', ...(args.title === undefined ? {} : { rawInput: args.title }) }),
    presentResult: () => ({ card: 'generic', title: 'Mnemon Document processed' }),
  } as never))
}

/** Update the shared working rules. */
function registerRuntimeTools(ctx: HostContextShape, { requireSource, config, composableTurn }: ToolHelpers, coordinator: MnemonSubagentCoordinator): void {
  ctx.tools.register(definition({
    name: 'mnemo_runtime_memory',
    description: 'Maintain the shared Working Rules. Save an explicit user preference or standing behavior rule that should guide future turns by default. A general request to remember something does not determine its destination. Skip retrieved evidence unless the user explicitly asks to save it. Skip guesses, assistant-authored claims, temporary progress, secrets, easily rediscovered facts, and skill-covered guidance. Existing rules may move to the local archive when capacity is exceeded.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'replace', 'remove'], description: 'add a new entry, replace one uniquely matched entry, or remove one uniquely matched entry.' },
        content: { type: 'string', description: 'Compact entry content. Required for add and replace.' },
        old_text: { type: 'string', description: 'Full content of the existing entry or a unique substring. A unique full-content match takes precedence. Required for replace and remove.' },
        importance: { type: 'string', enum: ['critical', 'normal', 'low'], description: 'critical for explicit must/always/never rules; low for transient facts; normal by default.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value),
      presentationMeta: namedToolPresentation('mnemo_runtime_memory') },
    execute: (args: { action: 'add' | 'replace' | 'remove'; content?: string; old_text?: string; importance?: RuntimeMemoryImportance }, exec: ToolExecution) => {
      if (!config.writeEnabled) throw new Error('dsh-mnemo-weave is configured read-only (writeEnabled: false)')
      if ('target' in args) throw new Error('Working Rules mutations no longer accept target')
      requireSource(exec, 'runtime', 'write')
      composableTurn(exec)
      const request = {
        action: args.action,
        target: 'memory' as const,
        ...(args.content === undefined ? {} : { content: args.content }),
        ...(args.old_text === undefined ? {} : { oldText: args.old_text }),
        ...(args.importance === undefined ? {} : { importance: args.importance }),
      }
      return coordinator.runtime(requireAgent(exec), request, exec.signal)
    },
    presentCall: (args: { action: string }) => ({ card: 'generic', title: `${args.action} working rule`, kind: 'edit' }),
    presentResult: () => ({ card: 'generic', title: 'Runtime memory updated' }),
  } as never))
}

/** Memory Spaces' writes: remember, link and forget, and creating, updating and merging spaces. */
function registerMemorySpaceWriteTools(ctx: HostContextShape, { requireSource, sourceAction }: ToolHelpers, coordinator: MnemonSubagentCoordinator): void {
  ctx.tools.register(definition({
    name: 'mnemo_remember',
    description: `Store one self-contained durable memory entry (decision, preference, fact, troubleshooting insight, or context) in a selected provider-backed Memory Space. Use this when the user explicitly chooses a Memory Space or when a verified lesson, decision, fact, or preference should be retrieved on demand, such as a diagnosed cause and remedy, an engineering trade-off, or a platform constraint. ${REUSABLE_LESSON_CONTENT} Save each distinct qualifying entry separately when it is independently useful. Keep related details together when they form one entry. Respect requests not to remember. Choose a suitable writable space, check for equivalent entries when recall is available, and wait for the provider receipt. Providers using semantic extraction may return skipped. Skip duplicates, transcripts, temporary progress, guesses, secrets, routine observations, and entries already covered by an equivalent retrievable memory.`,
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'One concise, self-contained durable memory entry.' },
        replacesId: { type: 'string', description: 'A recalled insight ID in the same active Space, only when verified evidence supersedes its conclusion or metadata. Unsupported Providers skip the revision.' },
        category: { type: 'string', enum: [...CATEGORIES], description: CATEGORY_PARAMETER_DESCRIPTION },
        importance: { type: 'integer', minimum: 1, maximum: 5, description: 'Durable value from 1 through 5.' },
        entities: { type: 'array', items: { type: 'string' }, maxItems: 50, description: ENTITY_PARAMETER_DESCRIPTION },
        source: { type: 'string', enum: [...SOURCES], description: 'Defaults to agent for model-authored writeback.' },
        memoryBodyId: { type: 'string', description: 'Target Memory Space id; the write goes there or nowhere. Select an active space. A save request does not authorize reactivation. Required unless exactly one space is active.' },
      },
      required: ['content'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value),
      presentationMeta: namedToolPresentation('mnemo_remember') },
    async execute(args: { content: string; replacesId?: string; category?: Category; importance?: number; entities?: string[]; source?: Source; memoryBodyId?: string }, exec: ToolExecution) {
      requireSource(exec, 'memory-spaces', 'write')
      if (args.replacesId !== undefined) requireSource(exec, 'memory-spaces', 'forget')
      const request = { ...args, source: args.source ?? 'agent' }
      return isSubagent(exec.agent)
        ? sourceAction(exec, 'memory-spaces', 'remember', request)
        : coordinator.remember(requireAgent(exec), request, exec.signal)
    },
    presentCall: () => ({ card: 'generic', title: 'Write Mnemon memory', kind: 'edit' }),
    presentResult: () => ({ card: 'generic', title: 'Mnemon memory processed' }),
  } as never))

  ctx.tools.register(definition({
    name: 'mnemo_link',
    description: 'Create a typed bidirectional relationship that improves future recall. Verify both insight IDs in the same readable Memory Space and confirm capabilities.link. Select a relationship supported by the evidence.',
    parameters: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Exact ID of the first verified insight.' },
        targetId: { type: 'string', description: 'Exact ID of the second verified insight, in the same Memory Space.' },
        type: { type: 'string', enum: [...EDGE_TYPES], description: 'Relationship type supported by the evidence. Default semantic.' },
        weight: { type: 'number', minimum: 0, maximum: 1, description: 'Relationship confidence. Default 0.5.' },
        reason: { type: 'string', maxLength: 1000, description: 'Brief evidence-based explanation of the relationship.' },
        memoryBodyId: { type: 'string', description: 'Memory Space ID containing both insights. Specify it if the IDs could be ambiguous.' },
      },
      required: ['sourceId', 'targetId'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value),
      presentationMeta: namedToolPresentation('mnemo_link') },
    async execute(args: { sourceId: string; targetId: string; type?: EdgeType; weight?: number; reason?: string; memoryBodyId?: string }, exec: ToolExecution) {
      requireSource(exec, 'memory-spaces', 'link')
      return isSubagent(exec.agent)
        ? sourceAction(exec, 'memory-spaces', 'link', args)
        : coordinator.write(requireAgent(exec), 'link', args, exec.signal)
    },
    presentCall: () => ({ card: 'generic', title: 'Link Mnemon insights', kind: 'edit' }),
    presentResult: () => ({ card: 'generic', title: 'Mnemon insights linked' }),
  } as never))

  ctx.tools.register(definition({
    name: 'mnemo_forget',
    description: 'Destructively forget an insight by exact ID in a Memory Space with capabilities.forget. Use only on explicit request or when verified obsolete or incorrect. Resolve the ID in the current readable View and specify memoryBodyId if it exists in multiple spaces. Mnemon Native uses soft deletion.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Exact insight ID previously admitted by this View or found in a readable Memory Space.' }, memoryBodyId: { type: 'string', description: 'Memory Space ID. Required if multiple readable spaces contain this insight ID.' } },
      required: ['id'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value),
      presentationMeta: namedToolPresentation('mnemo_forget') },
    execute: (args: { id: string; memoryBodyId?: string }, exec: ToolExecution) => {
      requireSource(exec, 'memory-spaces', 'forget')
      return isSubagent(exec.agent)
        ? sourceAction(exec, 'memory-spaces', 'forget', args)
        : coordinator.write(requireAgent(exec), 'forget', args, exec.signal)
    },
    presentCall: (args: { id: string }) => ({ card: 'generic', title: 'Forget Mnemon insight', kind: 'edit', rawInput: args.id }),
    presentResult: () => ({ card: 'generic', title: 'Mnemon insight forgotten' }),
  } as never))

  ctx.tools.register(definition({
    name: 'mnemo_memory_body_create',
    description: 'Create a new isolated Memory Space only on an explicit user request to create one. First inspect mnemo_memory_bodies.persistenceStrategy. In manual mode the host fixes the Provider. In automatic mode select only an eligible configured Provider from that policy and supply a concise reason and confidence; the host validates every hard rule and injects saved connection settings. Never invent credentials or endpoints. A new space starts switched off; activate it with mnemo_memory_body_update only when the user asks. An ordinary request to save an insight does not authorize creating a space.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Topic-specific human-readable name that remains meaningful in the directory.' },
        description: { type: 'string', description: 'Precise routing boundary: what durable knowledge belongs here and when it should be recalled.' },
        providerId: { type: 'string', description: 'Automatic mode only: one eligible Provider id from persistenceStrategy.' },
        reason: { type: 'string', description: 'Automatic mode only: concise user-facing reason for this Provider choice.' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Automatic mode only: calibrated confidence in the Provider choice.' },
      },
      required: ['name', 'description'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value),
      presentationMeta: namedToolPresentation('mnemo_memory_body_create') },
    execute: (args: { name: string; description: string; providerId?: string; reason?: string; confidence?: string }, exec: ToolExecution) => {
      requireSource(exec, 'memory-spaces', 'write')
      return isSubagent(exec.agent)
      ? sourceAction(exec, 'memory-spaces', 'manage-spaces', { operation: 'create', request: { name: args.name, description: args.description }, ...(args.providerId === undefined && args.reason === undefined && args.confidence === undefined ? {} : { selection: { providerId: args.providerId ?? '', reason: args.reason ?? '', confidence: args.confidence ?? '' } }) })
      : coordinator.write(requireAgent(exec), 'create-memory-body', args, exec.signal)
    },
    presentCall: () => ({ card: 'generic', title: 'Create Memory Space', kind: 'edit' }),
    presentResult: () => ({ card: 'generic', title: 'Memory Space created' }),
  } as never))

  ctx.tools.register(definition({
    name: 'mnemo_memory_body_update',
    description: 'Update a Memory Space name, routing description, or activation only when explicitly requested by the user. Activation controls read eligibility from the next turn, default write destination selection, and whether model-initiated writes can target a space. A user can explicitly select an inactive space in the UI to write and reactivate it.',
    parameters: {
      type: 'object',
      properties: {
        memoryBodyId: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        active: { type: 'boolean' },
      },
      required: ['memoryBodyId'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value),
      presentationMeta: namedToolPresentation('mnemo_memory_body_update') },
    execute: (args: { memoryBodyId: string; name?: string; description?: string; active?: boolean }, exec: ToolExecution) => {
      requireSource(exec, 'memory-spaces', 'write')
      return isSubagent(exec.agent)
        ? sourceAction(exec, 'memory-spaces', 'manage-spaces', { operation: 'update', ...args })
        : coordinator.write(requireAgent(exec), 'update-memory-body', args, exec.signal)
    },
    presentCall: () => ({ card: 'generic', title: 'Update Mnemon Memory Space', kind: 'edit' }),
    presentResult: () => ({ card: 'generic', title: 'Mnemon Memory Space updated' }),
  } as never))

  ctx.tools.register(definition({
    name: 'mnemo_memory_body_merge',
    description: 'Non-destructively merge complete Mnemon Native source Memory Spaces into one Mnemon Native target through import, preserving durable nodes and typed graph edges. External providers are not mergeable. Use only when the user explicitly requests consolidation. Source databases are retained and merely deactivated by default.',
    parameters: {
      type: 'object',
      properties: {
        targetMemoryBodyId: { type: 'string' },
        sourceMemoryBodyIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, description: 'Memory Space IDs to merge into the target space.' },
        deactivateSources: { type: 'boolean', description: 'Defaults to true. Never deletes source databases.' },
      },
      required: ['targetMemoryBodyId', 'sourceMemoryBodyIds'],
    },
    output: { schema: JSON_OBJECT_OUTPUT, render: (_args: unknown, value: unknown) => text(value),
      presentationMeta: namedToolPresentation('mnemo_memory_body_merge') },
    execute: (args: { targetMemoryBodyId: string; sourceMemoryBodyIds: string[]; deactivateSources?: boolean }, exec: ToolExecution) => {
      requireSource(exec, 'memory-spaces', 'write')
      return isSubagent(exec.agent)
        ? sourceAction(exec, 'memory-spaces', 'manage-spaces', { operation: 'merge', ...args })
        : coordinator.write(requireAgent(exec), 'merge-memory-bodies', args, exec.signal)
    },
    presentCall: () => ({ card: 'generic', title: 'Merge Mnemon Memory Spaces', kind: 'edit' }),
    presentResult: () => ({ card: 'generic', title: 'Mnemon Memory Spaces merged' }),
  } as never))
}
