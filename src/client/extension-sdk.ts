// Browser-only public helpers behind dsh-mnemo-weave/client. No Source registration,
// default workbench, Host Context, or raw transport is part of this module.
export {
  installMemorySourceUI, memorySourcePageEntryId, MNEMON_SOURCE_PAGE_SLOT,
  MNEMON_SOURCE_CONFIGURATION_MUTATE, MNEMON_SOURCE_CONFIGURATION_READ,
  type MemorySourcePageComponent, type MemorySourcePageDefinition,
  type MemorySourcePageProps, type MemorySourceUIContribution, type MemorySourceUIContext, type MemorySourcePageNavigation,
} from './hosting/source-pages.tsx'
export type { MnemonSourceManagementClient, MemorySourcePageInstance } from './connection/source-contracts.ts'
// The directory a page may offer as a per-run model choice, as its management
// client answers it; the pages read it and nothing else here drives it.
export type { TaskAgentModelCatalog, TaskAgentModelCatalogGroup, TaskAgentModelCatalogModel } from 'dsh-mnemo-weave/contracts'
export {
  installMemoryComponentUI, MNEMON_COMPONENT_SETTINGS_SLOT, MNEMON_COMPONENT_STATUS_SLOT,
  type MemoryComponentConfigurationSnapshot, type MemoryComponentHost,
  type MemoryComponentSettingsComponent, type MemoryComponentSettingsProps, type MemoryComponentStatusComponent, type MemoryComponentStatusProps,
  type MemoryComponentUIContext, type MemoryComponentUIContribution,
} from './hosting/component-ui.tsx'
// What Memory Spaces' own settings are drawn with, the controls and styles dsh-mnemo-weave drew them with.
export { memorySettingsStyles, ToggleRow } from './kit/settings-controls.tsx'
export { PanelActions, useLive, useStaged, WriteFailure } from './kit/settings-panel.tsx'
export { Callout, Reveal } from './kit/feedback.tsx'
export { GlobalLocationSetting } from './panels/GlobalLocationSetting.tsx'
export * from './kit/page-kit.tsx'
export * from './kit/page-controls.tsx'
export * from './kit/page-client.tsx'
export { MnemonDialog, type MnemonDialogProps } from './kit/MnemonDialog.tsx'
export { MnemonLogo } from './kit/MnemonLogo.tsx'
export { useRequestVersion } from './workspace/use-request-version.ts'
export { appearanceClass } from './kit/view-styles.ts'
export { translateEn, translateZh, type MnemonKey, type MnemonTranslate } from './i18n/locales.ts'
export { IconChevronLeftOutline14 } from './kit/ui-icons.ts'
