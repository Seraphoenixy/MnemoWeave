import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ClientConnectionHandle, ClientSettingsScope, Config, InteractionConfig } from '../../host/contracts/protocol.ts'
import { MnemonInterfaceSettings } from './MnemonInterfaceSettings.tsx'
import type { MnemonTranslate } from '../i18n/locales.ts'

/** The dsh-mnemo-weave page under DSH Plugins, which renders a bundle's configuration as its `page` view only. */
export interface MnemonSettingsHostProps {
  view: PluginConfigViewProps['view']
  scope: ClientSettingsScope<Config>
  /** The in-conversation surfaces keep their own live namespace. */
  interactionScope?: ClientSettingsScope<InteractionConfig>
  connection?: ClientConnectionHandle
  t: MnemonTranslate
}

/**
 * The dsh-mnemo-weave page under DSH Plugins carries the interface settings
 * alone: where the memory system appears and which in-conversation surfaces run.
 * Memory composition and storage are on the Memory System's own settings page,
 * which is reached without leaving the workspace (see MnemonSettingsCard).
 */
export function MnemonSettingsHost({ view, ...settings }: MnemonSettingsHostProps): JSX.Element | null {
  return view === 'page' ? <MnemonInterfaceSettings {...settings} /> : null
}
