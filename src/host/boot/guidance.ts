import type { HostAgent, HostContextShape } from '../support/dsh.ts'
import type { ResolvedConfig } from '../configuration/config.ts'
import type { ComposableMemoryView } from '../../core/contracts/index.ts'
import type { MnemonAgentRuntimeSource } from '../engine/runtime.ts'

export const GUIDANCE_SECTION_NAME = 'mnemon:routing'
export const RUNTIME_MEMORY_CONTEXT_NAME = 'mnemon:runtime-memory'
export const STRATEGY_SECTION_NAME = 'mnemon:strategy'
export const WORKING_RULES_SECTION_NAME = 'mnemon:working-rules'
export const ROUTING_GUIDANCE = 'Use memory only when needed. Use the named memory tools listed as available in the current turn. Installed tools do not imply an available Source. Never infer missing historical facts. The Host checks authorization when the tool runs. Confirm a write only after its receipt.'

const WORKING_RULES_INTRO = '### Active Working Rules\nFollow these user-authored standing rules by default unless the current user message explicitly overrides them.'

/** A View is an own-plugin message, never part of the shared context snapshot. */
export function withoutMemoryViewContext<T extends { contexts: Array<{ name: string; text: string }> }>(assembly: T): T {
  return { ...assembly, contexts: assembly.contexts.filter(context => context.name !== RUNTIME_MEMORY_CONTEXT_NAME) }
}

/** Inject trusted Strategy instructions after interpolation; Source text stays wrapped and uninterpolated. */
export function applyMemoryViewGuidance<T extends { sections: Array<{ name: string; text: string; interpolate?: boolean }>; contexts: Array<{ name: string; text: string }> }>(assembly: T, view: ComposableMemoryView | undefined, routingEnabled = true, workingRules?: string): T {
  const managed = [GUIDANCE_SECTION_NAME, STRATEGY_SECTION_NAME, WORKING_RULES_SECTION_NAME, 'mnemon:snapshot-history', 'mnemon:runtime-memory-protocol']
  if (view === undefined) return withoutMemoryViewContext({ ...assembly, sections: assembly.sections.filter(section => !managed.includes(section.name)) })
  const sections = assembly.sections.filter(section => !managed.includes(section.name))
  if (view.guidance?.system) sections.push({ name: STRATEGY_SECTION_NAME, text: view.guidance.system })
  if (routingEnabled) sections.push({ name: GUIDANCE_SECTION_NAME, text: view.guidance?.routing ?? ROUTING_GUIDANCE })
  // Place active Working Rules at the end of the Mnemon sections so tool-routing
  // prose does not dilute attention to the user's standing rules.
  if (workingRules !== undefined && workingRules.trim() !== '') sections.push({
    name: WORKING_RULES_SECTION_NAME,
    interpolate: false,
    text: `${WORKING_RULES_INTRO}\n\n<working-rules>\n${workingRules}\n</working-rules>`,
  })
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
