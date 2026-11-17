import { AsyncLocalStorage } from 'node:async_hooks'
import type { HostAgent, HostSubagentProvider, HostSubagentRun, HostSubagentStartRequest, HostSubagentsService } from '../support/dsh.ts'
import { activationOwned, claimReservedChild, isReservedChild, reservedChildId, titleTask, withReservedChild } from '../session/agent-compat.ts'

/** The Agent registry lookups that find an activation's local child. */
export interface SubagentStartAgents {
  get?(id: string): HostAgent | undefined
  isOwnedBy?(id: string, parent: HostAgent): boolean
}

/** Where DSH reports each Agent it publishes, before the Agent's first step. */
export interface SubagentPublications {
  on(name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): unknown
}

/** A delegated child's own tools and persona. */
type ChildComposition = Pick<HostSubagentStartRequest, 'toolFilter' | 'persona'>

/** DSH's deployment persona, which a child's own section of the same name replaces for that child. */
const PERSONA_SECTION = 'deployment:persona-prefix'

// Distinguishes overlapping starts, as continuation-turn.ts does.
const composingChild = new AsyncLocalStorage<symbol>()

/** Local activation providers publish a child whose tool and prompt scope we can configure. */
export function supportsChildComposition(subagents: HostSubagentsService, provider: HostSubagentProvider | undefined): boolean {
  return typeof subagents.startActivation === 'function' && typeof provider?.prepareContinuable === 'function'
}

export async function startSubagent(
  subagents: HostSubagentsService,
  agents: SubagentStartAgents | undefined,
  provider: string,
  request: HostSubagentStartRequest & { label: string },
  publications?: SubagentPublications,
): Promise<HostSubagentRun> {
  if (typeof subagents.startActivation !== 'function') throw new Error('DSH must provide subagents.startActivation')
  if (reservedChildId(request.parent) === undefined) {
    return withReservedChild(request.parent, () => startSubagent(subagents, agents, provider, request, publications))
  }
  const { toolFilter, persona, ...task } = request
  if (toolFilter === undefined && persona === undefined) {
    return startOnHost(subagents, agents, provider, task)
  }
  if (!supportsChildComposition(subagents, subagents.getProvider(provider))) throw new Error('DSH provider must publish a local activation to compose a Mnemon child')
  if (publications === undefined) throw new Error('MnemoWeave needs the DSH agent publication scope to configure its delegated child')
  const composition: ChildComposition = { ...(toolFilter === undefined ? {} : { toolFilter }), ...(persona === undefined ? {} : { persona }) }
  return startComposed(publications, agents, request.parent, composition, () => startOnHost(subagents, agents, provider, task), activationOwned(subagents))
}

async function startOnHost(
  subagents: HostSubagentsService,
  agents: SubagentStartAgents | undefined,
  provider: string,
  request: Omit<HostSubagentStartRequest, 'toolFilter' | 'persona'> & { label: string },
): Promise<HostSubagentRun> {
  const startActivation = subagents.startActivation!
  const { label, signal, name, ...task } = request
  const modern = activationOwned(subagents)
  const childId = claimReservedChild(request.parent)
  if (modern && (childId === undefined || agents?.get?.(request.parent.id) !== request.parent)) {
    throw new Error('Mnemon requires an exact live parent and reserved child identity on an activation-owned DSH')
  }
  // This source snapshot reports the same version as the published rc.1. Select the
  // contract before dispatch; never retry a potentially accepted start with another shape.
  const startCurrent = startActivation as unknown as (spec: Omit<HostSubagentStartRequest, 'label'> & { provider: string; label: string; childId: string; delivery: 'caller' }) => ReturnType<NonNullable<HostSubagentsService['startActivation']>>
  const activation = modern
    ? await startCurrent.call(subagents, { ...task, provider, label, signal, childId: childId!, delivery: 'caller',
      ...('resolveName' in subagents && typeof subagents.resolveName === 'function' && name !== undefined ? { name } : {}),
    })
    : await startActivation.call(subagents, { provider, label, ...(childId === undefined ? {} : { childId }), request: task, signal, delivery: 'caller' })
  // A second dispose from the caller reports any failure of this one.
  const stop = () => { activation.dispose().catch(() => {}) }
  try {
    const release = () => signal.removeEventListener('abort', stop)
    signal.addEventListener('abort', stop, { once: true })
    void activation.result.then(release, release)
    if (signal.aborted) stop()
    // The child is resident until the activation settles, which takes at least one model turn.
    const child = agents?.get?.(activation.childId)
    if (modern && (activation.childId !== childId || child === undefined || !isReservedChild(agents, request.parent, child))) {
      throw new Error('DSH did not return the reserved live Mnemon child')
    }
    if (modern && child !== undefined) titleTask(child, label.startsWith('Mnemon ') ? label : `Mnemon · ${label}`)
    const localAgent = child !== undefined && (modern || typeof agents?.isOwnedBy !== 'function' || agents.isOwnedBy(child.id, request.parent)) ? child : undefined
    return {
      id: activation.childId,
      ...(localAgent === undefined ? {} : { localAgent }),
      result: activation.result,
      dispose: () => activation.dispose(),
    }
  } catch (error) {
    // The caller never received this run, so nothing else would release the child.
    stop()
    throw error
  }
}

/**
 * The persona replaces the deployment persona and the filter narrows the tools
 * the child shares with its parent, for that child alone. Its scope releases
 * both with it.
 */
function compose(agent: HostAgent, { toolFilter, persona }: ChildComposition): void {
  const prompt = agent.ctx.systemPrompt
  const tools = agent.ctx.tools
  if (persona !== undefined && (typeof prompt?.section !== 'function' || typeof prompt.getSectionOrder !== 'function')) {
    throw new Error('DSH gives this memory subagent no prompt section of its own, so dsh-mnemo-weave cannot give it its instructions')
  }
  if (toolFilter !== undefined && typeof tools?.restrict !== 'function') {
    throw new Error('DSH gives this memory subagent no tool restriction of its own, so dsh-mnemo-weave cannot limit it to its memory tools')
  }
  if (persona !== undefined) prompt!.section!({ name: PERSONA_SECTION, order: prompt!.getSectionOrder!('DEPLOYMENT_PERSONA_PREFIX'), text: persona })
  if (toolFilter !== undefined) tools!.restrict!(toolFilter)
}

/**
 * Start a child and compose it while DSH publishes it, ahead of other plugins'
 * listeners. Async context attributes concurrent starts, and DSH's ownership
 * check confirms the parent. A failed composition makes DSH roll the child
 * back; a child that was not seen published is disposed and refused.
 */
async function startComposed(
  publications: SubagentPublications,
  agents: SubagentStartAgents | undefined,
  parent: HostAgent,
  composition: ChildComposition,
  start: () => Promise<HostSubagentRun>,
  reserved = false,
): Promise<HostSubagentRun> {
  const pending = Symbol('Mnemon child composition')
  const expectedChildId = reserved ? reservedChildId(parent) : undefined
  const composed = new Set<string>()
  let failure: unknown
  const listener = publications.on('agent/created', (({ agent }: { agent: HostAgent }) => {
    if (composingChild.getStore() !== pending) return
    if (reserved && (agent.id !== expectedChildId || !isReservedChild(agents, parent, agent))) return
    if (typeof agents?.isOwnedBy === 'function' && !agents.isOwnedBy(agent.id, parent)) return
    try {
      compose(agent, composition)
      composed.add(agent.id)
    } catch (error) {
      failure = error
      throw error
    }
  }) as never, { prepend: true })
  if (typeof listener !== 'function') throw new Error('dsh-mnemo-weave could not observe the memory subagent DSH creates, so it does not start one')
  let stopObserving: (() => unknown) | undefined = listener as () => unknown
  const closeObserver = async () => {
    const stop = stopObserving
    stopObserving = undefined
    await stop?.()
  }
  let run: HostSubagentRun | undefined
  try {
    run = await composingChild.run(pending, start)
    if (failure !== undefined) throw failure
    if (!composed.has(run.id)) throw new Error(`dsh-mnemo-weave did not see memory subagent ${run.id} created, so it could not give it its own instructions and tools`)
    // Stop observing before handing the run over; a failure here takes the same path as a failed start.
    await closeObserver()
    return run
  } catch (error) {
    try { await closeObserver() } catch { /* Preserve the start failure. */ }
    // The caller never receives this run, so nothing else would stop the child.
    try { await run?.dispose() } catch { /* Preserve the start failure. */ }
    throw error
  }
}
