import type { MemoryComponentHost } from 'dsh-mnemo-weave/client'
import type {
  CheckMemoryProviderServiceRequest,
  LocalEmbeddingDeployResult,
  LocalEmbeddingDevice,
  LocalEmbeddingLifecycle,
  LocalEmbeddingPreset,
  LocalEmbeddingRuntimeStatus,
  MemoryProviderServiceCatalog,
  MemoryProviderServiceCheckResult,
  MemoryProviderServiceView,
  MnemonEmbeddingFill,
  MnemonEmbeddingStatus,
  UpdateMemoryProviderServiceRequest,
} from '../contracts.ts'

export interface LocalEmbeddingRequestOverrides {
  localPreset?: LocalEmbeddingPreset
  lifecycle?: LocalEmbeddingLifecycle
  localDevice?: LocalEmbeddingDevice
  llamaServerPath?: string
}

export interface ProviderVersionComponentView {
  id: string
  name: string
  executablePath?: string
  current?: string
  latest?: string
  outdated: boolean
  installMode: 'npm' | 'homebrew' | 'go' | 'link' | 'manual' | 'missing'
  updateSupported: boolean
  updateHint: string
  checkError?: string
}

export interface ProviderVersionStatusView {
  checkedAt: string
  components: ProviderVersionComponentView[]
}

export interface ProviderInstallResultView {
  component: string
  previousVersion?: string
  currentVersion?: string
  updated: boolean
  restartRequired: boolean
  output?: string
}

/**
 * What these settings ask of the Host, through the operations dsh-mnemo-weave
 * serves Memory Spaces on its configuration page.
 */
export interface MemorySpacesSettingsClient {
  /** Whether the Host finds the Mnemon CLI that Mnemon Native runs. */
  statusSummary(): Promise<{ commandFound: boolean }>
  providerServices(): Promise<MemoryProviderServiceCatalog>
  checkProviderService(request: CheckMemoryProviderServiceRequest): Promise<MemoryProviderServiceCheckResult>
  updateProviderService(request: UpdateMemoryProviderServiceRequest): Promise<MemoryProviderServiceView>
  checkProviderInstall(): Promise<ProviderVersionStatusView>
  installOrUpdateMnemon(): Promise<ProviderInstallResultView>
  embeddingStatus(): Promise<MnemonEmbeddingStatus>
  /** Fill in the vectors a Mnemon Native space lacks (#392). */
  fillEmbeddings(memoryBodyId: string): Promise<MnemonEmbeddingFill>
  localEmbeddingStatus(overrides?: LocalEmbeddingRequestOverrides): Promise<LocalEmbeddingRuntimeStatus>
  deployLocalEmbedding(overrides?: LocalEmbeddingRequestOverrides): Promise<LocalEmbeddingDeployResult>
  controlLocalEmbedding(action: 'start' | 'stop', overrides?: LocalEmbeddingRequestOverrides): Promise<LocalEmbeddingRuntimeStatus>
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
      checkProviderService: request => operations.read('provider-service-check', JSON.parse(JSON.stringify(request))) as Promise<MemoryProviderServiceCheckResult>,
      updateProviderService: request => operations.write('provider-service-update', JSON.parse(JSON.stringify(request))) as Promise<MemoryProviderServiceView>,
      checkProviderInstall: () => operations.read('versions') as Promise<ProviderVersionStatusView>,
      installOrUpdateMnemon: () => operations.write('version-update', { component: 'mnemon' }) as Promise<ProviderInstallResultView>,
      embeddingStatus: () => operations.read('embedding-status') as Promise<MnemonEmbeddingStatus>,
      fillEmbeddings: memoryBodyId => operations.write('embedding-fill', { memoryBodyId }) as Promise<MnemonEmbeddingFill>,
      localEmbeddingStatus: (overrides = {}) => operations.read('local-embedding-status', JSON.parse(JSON.stringify(overrides))) as Promise<LocalEmbeddingRuntimeStatus>,
      deployLocalEmbedding: (overrides = {}) => operations.write('local-embedding-deploy', JSON.parse(JSON.stringify(overrides))) as Promise<LocalEmbeddingDeployResult>,
      controlLocalEmbedding: (action, overrides = {}) => operations.write('local-embedding-control', JSON.parse(JSON.stringify({ ...overrides, action }))) as Promise<LocalEmbeddingRuntimeStatus>,
    }
    clients.set(operations, client)
  }
  return client
}
