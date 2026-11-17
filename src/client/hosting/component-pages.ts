import type { MnemonTranslate } from '../i18n/locales.ts'
import { installMemorySourceUI } from './source-pages.tsx'
import { installRuntimeMemoryUI } from '../../components/source-runtime/src/client/ui.tsx'
import { installDocumentsMemoryUI } from '../../components/source-documents/src/client/ui.tsx'
import { installMemorySpacesUI } from '../../components/source-memory-spaces/src/client/ui.tsx'
import { installSkillUseBridge } from '../../components/source-skills/src/client/use-skill.tsx'
import { installSkillsMemoryUI } from '../../components/source-skills/src/client/ui.tsx'

/**
 * Register the pages every shipped component draws.
 *
 * Each component used to be a package with a client artifact of its own, so its
 * pages registered when DSH loaded that artifact. They now ship inside this
 * package and this client, so this entry registers them: a component's pages are
 * part of the one client bundle, and nothing else calls into them.
 */
export function installShippedComponentPages(ctx: Parameters<typeof installMemorySourceUI>[0], t: MnemonTranslate): () => void {
  const disposers = [
    installRuntimeMemoryUI(ctx, t),
    installDocumentsMemoryUI(ctx, t),
    installMemorySpacesUI(ctx, t),
    installSkillsMemoryUI(ctx),
    installSkillUseBridge(ctx),
  ]
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
