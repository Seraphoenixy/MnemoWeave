import type { MemoryComponentHost } from 'dsh-mnemo-weave/client'
import type { MemoryProviderServiceCatalog, MemoryProviderServiceView, MnemonEmbeddingFill, MnemonEmbeddingStatus, UpdateMemoryProviderServiceRequest } from '../contracts.ts'

/**
 * What these settings ask of the Host, through the operations dsh-mnemo-weave
 * serves Memory Spaces on its configuration page.
 */
export interface MemorySpacesSettingsClient {
  /** Whether the Host finds the Mnemon CLI that Mnemon Native runs. */
  statusSummary(): Promise<{ commandFound: boolean }>
  providerServices(): Promise<MemoryProviderServiceCatalog>
  updateProviderService(request: UpdateMemoryProviderServiceRequest): Promise<MemoryProviderServiceView>
  embeddingStatus(): Promise<MnemonEmbeddingStatus>
  /** Fill in the vectors a Mnemon Native space lacks (#392). */
  fillEmbeddings(memoryBodyId: string): Promise<MnemonEmbeddingFill>
}

type Operations = NonNullable<MemoryComponentHost['operations']>

// The page keeps one set of operations per conversation and workspace; so does this, so a
// remounted list finds the Providers it read last.
const clients = new WeakMap<Operations, MemorySpacesSettingsClient>()

export function memorySpacesSettingsClient(operations: Operations): MemorySpacesSettingsClient {
  let client = clients.get(operations)
  if (client === undefined) {
    client = {
      statusSummary: () => operations.read('status-summary') as Promise<{ commandFound: boolean }>,
      providerServices: () => operations.read('provider-services') as Promise<MemoryProviderServiceCatalog>,
      updateProviderService: request => operations.write('provider-service-update', JSON.parse(JSON.stringify(request))) as Promise<MemoryProviderServiceView>,
      embeddingStatus: () => operations.read('embedding-status') as Promise<MnemonEmbeddingStatus>,
      fillEmbeddings: memoryBodyId => operations.write('embedding-fill', { memoryBodyId }) as Promise<MnemonEmbeddingFill>,
    }
    clients.set(operations, client)
  }
  return client
}
