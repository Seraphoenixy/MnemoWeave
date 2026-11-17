import { randomUUID } from 'node:crypto'
import type { MessageSourceMap } from '@deepseek-ai/dsh-llm'
import type { HostUserMessage } from '../support/dsh.ts'
import type { MemorySnapshotState } from './memory-snapshot-state.ts'
import { MNEMON_PLUGIN_SOURCE } from '../../message-source.ts'

export { isMnemonMessageSource, MNEMON_PLUGIN_SOURCE } from '../../message-source.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-mnemo-weave': {
      kind: 'dsh-mnemo-weave'
      form: 'recall' | 'instructions' | 'memory-snapshot' | 'memory-snapshot-retired'
      snapshot?: MemorySnapshotState
    }
    'dsh-mnemon': Omit<MessageSourceMap['dsh-mnemo-weave'], 'kind'> & { kind: 'dsh-mnemon' }
  }
}

/** A user-role message this plugin adds to a step, marked with its own source. */
export function createPluginMessage(text: string, form: 'recall' | 'instructions' | 'memory-snapshot', snapshot?: MemorySnapshotState): HostUserMessage {
  return structuredClone({
    id: randomUUID(),
    role: 'user' as const,
    content: [{ type: 'text' as const, text }],
    source: {
      kind: MNEMON_PLUGIN_SOURCE,
      form,
      ...(snapshot === undefined ? {} : { snapshot }),
    } satisfies MessageSourceMap['dsh-mnemo-weave'],
  })
}
