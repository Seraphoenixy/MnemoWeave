import type { Context } from '@deepseek-ai/cordis'
import { defineMemoryPlugin, installMemory, memoryConfigurationDigest } from 'dsh-mnemo-weave/extension-sdk'
import { Config } from './config.ts'
import { createRuntimeMemorySource } from './source.ts'

/** The Entry name the Loader mounts: a subpath of the package every component ships in. */
export const name = 'dsh-mnemo-weave/source-runtime'
/** The npm package that ships this component. */
export const packageName = 'dsh-mnemo-weave'
export const inject = ['mnemonMemory']
export { Config }

export const memoryPlugin = defineMemoryPlugin({
  packageName,
  componentId: 'source-runtime',
  label: { en: 'Working Rules', 'zh-CN': '工作准则' },
  description: { en: 'Bounded, deterministic hot memory injected directly into every eligible turn.', 'zh-CN': '有界且确定的热记忆，在每个符合条件的回合中直接注入。' },
  roles: ['source'],
  provides: [{ id: 'source' }, { id: 'source.working-context' }],
})

export function apply(ctx: Context, config: Config = {}): void {
  installMemory(ctx, { plugin: memoryPlugin, sources: [createRuntimeMemorySource(config)] }, { effectiveDigest: memoryConfigurationDigest(config) })
}

export { createRuntimeMemorySource, RUNTIME_MEMORY_SOURCE } from './source.ts'
export type * from './contracts.ts'
