import { createContext, useContext, type JSX } from 'react'
import type { StatusView } from '../../host/contracts/protocol.ts'
import { installMemoryComponentUI, type MemoryComponentUIContext } from './component-ui.tsx'
import { MEMORY_SPACES_COMPONENT, RUNTIME_COMPONENT } from '../panels/component-settings.tsx'
import { SKILLS_COMPONENT } from '../panels/skills-settings.tsx'
import { humanBytes, useT } from '../kit/page-kit.tsx'

export const DOCUMENTS_COMPONENT = 'source-documents'

/**
 * The status the Memory System read for the conversation and workspace it
 * shows. Only dsh-mnemo-weave's own cards read it; a card an installed component
 * contributes reads its own Source.
 */
export const WorkbenchStatusContext = createContext<StatusView | null>(null)

/**
 * Register the Status cards of the shipped Sources, the way an installed
 * component registers its own: each says what its Source holds.
 */
export function installShippedComponentStatus(ctx: MemoryComponentUIContext): () => void {
  const disposers = [
    installMemoryComponentUI(ctx, { componentId: RUNTIME_COMPONENT, status: () => <RuntimeStatus /> }),
    installMemoryComponentUI(ctx, { componentId: DOCUMENTS_COMPONENT, status: () => <DocumentsStatus /> }),
    installMemoryComponentUI(ctx, { componentId: MEMORY_SPACES_COMPONENT, status: () => <SpacesStatus /> }),
    installMemoryComponentUI(ctx, { componentId: SKILLS_COMPONENT, status: () => <SkillsStatus /> }),
  ]
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

/** A card's headline and one line under it. */
function Figure(props: { headline: string; detail: string }): JSX.Element {
  return <><strong>{props.headline}</strong><p>{props.detail}</p></>
}

function RuntimeStatus(): JSX.Element {
  const t = useT()
  const status = useContext(WorkbenchStatusContext)
  const storage = status?.storage
  const area = storage?.scopes.find(scope => scope.kind === (storage.activeKind ?? 'global'))?.areas.find(candidate => candidate.kind === 'runtime')
  if (area === undefined) return <Figure headline={t('status.runtimeWaiting')} detail={t('status.runtimeWaitingDetail')} />
  return <Figure headline={t('status.runtimeRatio', { user: Number(area.details.userEntries ?? 0), memory: Number(area.details.memoryEntries ?? 0) })}
    detail={t('status.runtimeBytes', { bytes: humanBytes(area.bytes) })} />
}

function DocumentsStatus(): JSX.Element {
  const t = useT()
  const documents = useContext(WorkbenchStatusContext)?.documents
  if (documents === undefined) return <Figure headline={t('status.documentsWaiting')} detail={t('status.documentsSession')} />
  return <Figure headline={t('status.documentRatio', { active: documents.activeCount, archived: documents.archivedCount })}
    detail={t('status.documentUsage', { used: humanBytes(documents.activeBytes), limit: humanBytes(documents.limitBytes) })} />
}

function SpacesStatus(): JSX.Element {
  const t = useT()
  const status = useContext(WorkbenchStatusContext)
  const spaces = status?.memoryBodies
  if (spaces === undefined) return <Figure headline={t('status.directoryUnsynced')} detail={t('status.activeMemories', { count: status?.stats?.totalInsights ?? 0 })} />
  return <Figure headline={t('status.activeRatio', { active: spaces.filter(space => space.active).length, total: spaces.length })}
    detail={t('status.activeMemories', { count: status?.stats?.totalInsights ?? 0 })} />
}

/** 技能管理: how many skills, and what evolution has waiting for the user. */
function SkillsStatus(): JSX.Element {
  const t = useT()
  const skills = useContext(WorkbenchStatusContext)?.skills
  if (skills === undefined) return <Figure headline={t('board.running')} detail={t('skills.statusOff')} />
  return <Figure headline={t('skills.statusCount', { count: skills.skills })}
    detail={!skills.evolution ? t('skills.statusOff') : skills.waiting > 0 ? t('skills.statusOn', { waiting: skills.waiting }) : t('skills.statusIdle')} />
}
