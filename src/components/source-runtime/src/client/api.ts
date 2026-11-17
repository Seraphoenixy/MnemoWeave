import type { RuntimeMemoryImportance, RuntimeMemoryMutationResult, RuntimeMemorySnapshot } from '../contracts.ts'

/** Source-owned structural page API; the default bundle may supply agent-assisted callbacks. */
export interface RuntimePageClient {
  runtimeMemory(): Promise<RuntimeMemorySnapshot>
  pinRuntimeMemory?(request: { content: string; pinned: boolean }): Promise<RuntimeMemorySnapshot>
  mutateRuntimeMemory(request: {
    action: 'add' | 'replace' | 'remove'
    content?: string
    old_text?: string
    importance?: RuntimeMemoryImportance
    branches?: string[]
  }): Promise<RuntimeMemoryMutationResult>
}
