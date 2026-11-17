import type { HostAgent, HostContextShape } from '../support/dsh.ts'
import type { ResolvedConfig } from '../configuration/config.ts'
import type { ComposableMemoryView } from '../../core/contracts/index.ts'
import type { MnemonAgentRuntimeSource } from '../engine/runtime.ts'

export const GUIDANCE_SECTION_NAME = 'mnemon:routing'
export const RUNTIME_MEMORY_CONTEXT_NAME = 'mnemon:runtime-memory'
export const STRATEGY_SECTION_NAME = 'mnemon:strategy'
export const SNAPSHOT_GUIDANCE = 'Mnemon memory snapshots are budget-limited projections. A newer snapshot supersedes earlier snapshots of the same Source instance only. Do not treat an older snapshot of that Source as additional current facts or authority. Absence may reflect filtering or projection budgets and does not imply deletion from storage. Current View permissions govern every tool call, including calls described by earlier reminders.'
export const ROUTING_GUIDANCE = 'Use memory only when needed. Use the named memory tools listed as available in the current View. Installed tools do not imply an available Source. Never infer missing historical facts. The Host checks authorization when the tool runs. Confirm a write only after its receipt.'

/** A View is an own-plugin message, never part of the shared context snapshot. */
export function withoutMemoryViewContext<T extends { contexts: Array<{ name: string; text: string }> }>(assembly: T): T {
  return { ...assembly, contexts: assembly.contexts.filter(context => context.name !== RUNTIME_MEMORY_CONTEXT_NAME) }
}

/** Inject trusted Strategy instructions after interpolation; Source text stays quoted in the Wake. */
export function applyMemoryViewGuidance<T extends { sections: Array<{ name: string; text: string }>; contexts: Array<{ name: string; text: string }> }>(assembly: T, view: ComposableMemoryView | undefined, routingEnabled = true): T {
  if (view === undefined) return withoutMemoryViewContext({ ...assembly, sections: assembly.sections.filter(section => section.name !== 'mnemon:snapshot-history') })
  const sections = assembly.sections.filter(section => ![GUIDANCE_SECTION_NAME, STRATEGY_SECTION_NAME, 'mnemon:runtime-memory-protocol', 'mnemon:snapshot-history'].includes(section.name))
  sections.push({ name: 'mnemon:snapshot-history', text: SNAPSHOT_GUIDANCE })
  if (view.guidance?.system) sections.push({ name: STRATEGY_SECTION_NAME, text: view.guidance.system })
  if (routingEnabled) sections.push({ name: GUIDANCE_SECTION_NAME, text: view.guidance?.routing ?? ROUTING_GUIDANCE })
  return withoutMemoryViewContext({ ...assembly, sections })
}

/** Register once the prompt service is active; Cordis re-runs this if the service is replaced. */
export function registerGuidance(ctx: HostContextShape, config?: Pick<ResolvedConfig, 'routingGuidance'>, runtime?: Pick<MnemonAgentRuntimeSource, 'memoryParticipation'>): void {
  ctx.inject(['systemPrompt'], prompted => {
    const prompt = prompted.get('systemPrompt') as { section(value: { name: string; order: number; text: (context?: { agent?: HostAgent }) => string }): unknown }
    prompt.section({
      name: GUIDANCE_SECTION_NAME,
      order: 150,
      text: context => config?.routingGuidance === false || context?.agent !== undefined && runtime?.memoryParticipation?.(context.agent).excluded ? '' : ROUTING_GUIDANCE,
    })
  })
}
