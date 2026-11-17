/**
 * A request to open one component's page on the dsh-mnemo-weave configuration
 * under Plugins, such as 技能管理's gear asking for its own settings. DSH opens
 * the bundle page; the configuration takes the request once it can name the
 * component, or at once when it is already on screen.
 */
let pending: string | undefined
const listeners = new Set<() => void>()

/** Ask the configuration to open this component's page, by its package name. */
export function requestComponentPage(packageName: string): void {
  pending = packageName
  for (const listener of [...listeners]) listener()
}

/** The package whose page was asked for, taken once. */
export function takeComponentPage(): string | undefined {
  const value = pending
  pending = undefined
  return value
}

export function subscribeComponentPage(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
