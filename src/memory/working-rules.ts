import { join } from 'node:path'
import { RuntimeMemoryController } from '../components/source-runtime/src/controller.ts'
import { WORKING_RULES_DIRECTORY } from '../components/source-runtime/src/contracts.ts'
import { localSnapshotSync, type SyncEndpoint } from '../sync/client/filesystem.ts'
import { globalMemoryDirectory } from './data-directory.ts'
import { ActivityStore } from './activity.ts'

export function openWorkingRules(legacyDirectory?: string) {
  const globalDirectory = globalMemoryDirectory()
  const directory = join(globalDirectory, WORKING_RULES_DIRECTORY)
  const memory = new RuntimeMemoryController({ effectiveDataDir: () => directory }, undefined, undefined, undefined, {
    legacyRoots: legacyDirectory === undefined ? [globalDirectory] : [globalDirectory, legacyDirectory],
    followStoredLimit: true,
  })
  return {
    memory,
    activity: new ActivityStore(join(directory, 'state', 'activity')),
    connectSync: (endpoint: SyncEndpoint) => localSnapshotSync(endpoint, directory, {
      capture: async () => memory.captureWorkingRules(),
      apply: async (bytes, matches) => memory.replaceWorkingRules(bytes, matches),
      assemble: entries => memory.assembleWorkingRules(entries),
    }),
  }
}
