import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { MNEMON_COMPONENT_SETTINGS_SLOT, type ComponentSettingsDirectory, type MemoryComponentSettingsProps } from '../hosting/component-ui.tsx'
import type { ComponentHosts } from '../hosting/component-host.ts'
import type { ComponentSettingsSource } from './MnemonSettingsCard.tsx'

export interface ComponentSettingsSourceOptions {
  /** The components that registered settings into the region dsh-mnemo-weave declares. */
  directory?: ComponentSettingsDirectory | undefined
  /** The configuration and Host operations a shipped component's settings read. */
  host?: ComponentHosts | undefined
  /** DSH's renderer, for the page whose entry declares the region. */
  renderSlot?: PropsRenderSlots<typeof MNEMON_COMPONENT_SETTINGS_SLOT>['renderSlot'] | undefined
  /**
   * Renders one contribution for pages mounted outside the declaring region.
   */
  renderContributed: ((packageName: string, props: MemoryComponentSettingsProps) => ReactNode) | undefined
}

/**
 * Resolves each component's contributed settings for the Memory System.
 */
export function useComponentSettingsSource({ directory, host, renderSlot, renderContributed }: ComponentSettingsSourceOptions): ComponentSettingsSource | undefined {
  const subscribe = useCallback((listener: () => void) => directory?.subscribe(listener) ?? (() => {}), [directory])
  const getSnapshot = useCallback(() => directory?.getSnapshot(), [directory])
  const contributed = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const renders = renderSlot !== undefined || renderContributed !== undefined
  return useMemo<ComponentSettingsSource | undefined>(() => !renders || contributed === undefined ? undefined : {
    has: packageName => contributed.has(packageName),
    render: (entry, page) => {
      const hosts = host?.(entry.componentId, page.sessionId, page.workspace?.id)
      const owner: MemoryComponentSettingsProps = {
        component: { componentId: entry.componentId, packageName: entry.packageName, label: page.label, enabled: page.enabled },
        writable: page.writable, language: page.language,
        ...(page.sessionId === undefined ? {} : { sessionId: page.sessionId }),
        ...(page.workspace === undefined ? {} : { workspace: page.workspace }),
        ...(hosts === undefined ? {} : { host: hosts }),
      }
      return renderSlot === undefined
        ? renderContributed!(entry.componentId, owner)
        : renderSlot(MNEMON_COMPONENT_SETTINGS_SLOT, owner, { entryKey: entry.componentId, fallback: null })
    },
  }, [renders, renderSlot, renderContributed, contributed, host])
}
