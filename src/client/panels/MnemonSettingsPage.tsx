import { type JSX } from 'react'
import type { ReactNode } from 'react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { MNEMON_COMPONENT_SETTINGS_SLOT, type ComponentSettingsDirectory, type MemoryComponentSettingsProps } from '../hosting/component-ui.tsx'
import type { ComponentHosts } from '../hosting/component-host.ts'
import { MnemonSettingsCard, type MnemonSettingsCardProps } from './MnemonSettingsCard.tsx'
import type { MnemonDirectoryPicker } from '../kit/picker.ts'
import { useComponentSettingsSource } from './use-component-settings.ts'

/**
 * What a DSH surface lends the Memory System's settings page: the components
 * that registered settings, the configuration and Host operations a shipped
 * component's settings read, and the directory picker the storage section opens.
 */
export interface MnemonSettingsServices {
  componentSettingsDirectory: ComponentSettingsDirectory
  componentHost: ComponentHosts
  directoryPicker: MnemonDirectoryPicker
  renderContributed: (packageName: string, props: MemoryComponentSettingsProps) => ReactNode
}

export interface MnemonSettingsPageProps extends Omit<MnemonSettingsCardProps, 'componentSettings' | 'directoryPicker'> {
  /** Absent while the page is drawn outside a DSH surface that offers the component regions. */
  services?: MnemonSettingsServices
  /**
   * DSH's renderer for this page's declared settings region, through which the
   * contributions render where this page's entry declares them.
   */
  renderSlot?: PropsRenderSlots<typeof MNEMON_COMPONENT_SETTINGS_SLOT>['renderSlot']
}

/**
 * The Memory System's settings page: how the components compose memory, and
 * where memory lives. The component pages it opens render the settings those
 * components registered.
 */
export function MnemonSettingsPage({ services, renderSlot, ...props }: MnemonSettingsPageProps): JSX.Element | null {
  const componentSettings = useComponentSettingsSource({
    directory: services?.componentSettingsDirectory,
    host: services?.componentHost,
    ...(renderSlot === undefined ? {} : { renderSlot }),
    renderContributed: services?.renderContributed,
  })
  return <MnemonSettingsCard
    {...props}
    {...(componentSettings === undefined ? {} : { componentSettings })}
    {...(services === undefined ? {} : { directoryPicker: services.directoryPicker })}
  />
}
