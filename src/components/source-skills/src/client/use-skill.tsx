import { useEffect, useRef } from 'react'

/**
 * "Use" puts `/name ` into the conversation's input, where DSH's own gesture
 * loads the skill when the message is sent. The page and the composer meet
 * through one window event; the composer side answers by marking it handled.
 */
export const SKILL_USE_EVENT = 'dsh-mnemo-weave:skill-use'

interface SkillUseDetail {
  name: string
  sessionId?: string
  handled: boolean
}

/** A request no composer has taken yet: the next composer of its session to mount takes it. */
let pending: { detail: SkillUseDetail; at: number } | undefined
const PENDING_MS = 10_000

/**
 * Ask the open composer to take `/name`. When the conversation is not on
 * screen yet, the request waits briefly for its composer to mount.
 * @returns whether a composer took it at once.
 */
export function requestSkillUse(name: string, sessionId?: string): boolean {
  const detail: SkillUseDetail = { name, ...(sessionId === undefined ? {} : { sessionId }), handled: false }
  window.dispatchEvent(new CustomEvent(SKILL_USE_EVENT, { detail }))
  pending = detail.handled ? undefined : { detail, at: Date.now() }
  return detail.handled
}

/** Where `/name` goes in a draft: first, once, ahead of what is already typed. */
export function draftWithSkill(draft: string, name: string): string {
  const token = `/${name}`
  if (new RegExp(`(^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(\\s|$)`, 'u').test(draft)) return draft
  const rest = draft.trimStart()
  return rest === '' ? `${token} ` : `${token} ${rest}`
}

interface ComposerInputActions {
  setDraft(text: string): void
}

/** DSH's session-scoped composer props: the input selector and its stable actions. */
export interface SkillUseBridgeProps {
  sessionId?: string
  inputActions?: ComposerInputActions
  useInput?: <T>(selector: (state: { draft: string }) => T) => T
}

const noDraft = <T,>(selector: (state: { draft: string }) => T): T => selector({ draft: '' })

/** Mounted in the composer row; renders nothing and answers "Use" for its own session. */
export function SkillUseBridge(props: SkillUseBridgeProps): null {
  const useInput = props.useInput ?? noDraft
  const draft = useInput(state => state.draft)
  const latest = useRef(draft)
  latest.current = draft
  useEffect(() => {
    const take = (detail: SkillUseDetail | undefined): void => {
      if (detail === undefined || detail.handled || props.inputActions === undefined) return
      if (detail.sessionId !== undefined && props.sessionId !== undefined && detail.sessionId !== props.sessionId) return
      props.inputActions.setDraft(draftWithSkill(latest.current ?? '', detail.name))
      detail.handled = true
      if (pending?.detail === detail) pending = undefined
    }
    // The page asked before this composer was on screen.
    if (pending !== undefined && Date.now() - pending.at < PENDING_MS) take(pending.detail)
    const listener = (event: Event) => take((event as CustomEvent<SkillUseDetail>).detail)
    window.addEventListener(SKILL_USE_EVENT, listener)
    return () => window.removeEventListener(SKILL_USE_EVENT, listener)
  }, [props.inputActions, props.sessionId])
  return null
}

interface SlotRegistry {
  inject(name: string, factory: () => () => void): () => void
  register(options: { name: string; id: string; order?: number }, component: (props: SkillUseBridgeProps) => null): () => void
}

export const SKILL_USE_SLOT = 'conversation.input.left'

/**
 * Register the bridge in the composer's tool row once the conversation
 * declares that row; a host without it leaves "Use" untaken.
 */
export function installSkillUseBridge(ctx: { slots: unknown }): () => void {
  const slots = ctx.slots as SlotRegistry
  try {
    return slots.inject(SKILL_USE_SLOT, () => slots.register({ name: SKILL_USE_SLOT, id: 'dsh-mnemo-weave-skills/use', order: 1000 }, SkillUseBridge))
  } catch {
    return () => undefined
  }
}
