import type { Context } from '@deepseek-ai/cordis'
import { defineMemoryPlugin, installMemory, memoryConfigurationDigest } from 'dsh-mnemo-weave/extension-sdk'
import { Config } from './config.ts'
import { createDocumentsMemorySource } from './source.ts'

/** The Entry name the Loader mounts: a subpath of the package every component ships in. */
export const name = 'dsh-mnemo-weave/source-documents'
/** The npm package that ships this component. */
export const packageName = 'dsh-mnemo-weave'
export const inject = ['mnemonMemory']
export { Config }

export const memoryPlugin = defineMemoryPlugin({
  packageName,
  componentId: 'source-documents',
  label: { en: 'Workspace Documents', 'zh-CN': '工作区档案' },
  description: { en: 'Versioned narrative documents kept per workspace, searched first and read in full on demand.', 'zh-CN': '按工作区保存的可版本化叙事文档，先检索，再按需阅读全文。' },
  roles: ['source'],
  provides: [{ id: 'source' }, { id: 'source.narrative' }],
})

export function apply(ctx: Context, config: Config = {}): void {
  installMemory(ctx, { plugin: memoryPlugin, sources: [createDocumentsMemorySource(config)] }, { effectiveDigest: memoryConfigurationDigest(config) })
}

export { createDocumentsMemorySource, DOCUMENTS_MEMORY_SOURCE } from './source.ts'
export type * from './contracts.ts'
