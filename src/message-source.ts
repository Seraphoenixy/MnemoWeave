export const MNEMON_PLUGIN_SOURCE = 'dsh-mnemo-weave'
export const UPSTREAM_MESSAGE_SOURCE = 'dsh-mnemo-weave'

/** Session history may carry the upstream source or a DSH migration wrapper. */
export function isMnemonMessageSource(source: unknown): boolean {
  if (typeof source !== 'object' || source === null) return false
  const { kind, plugin } = source as { kind?: unknown; plugin?: unknown }
  return [MNEMON_PLUGIN_SOURCE, UPSTREAM_MESSAGE_SOURCE].some(name =>
    kind === name || kind === `plugin:${name}` || (kind === 'plugin' && plugin === name))
}
