import { join, resolve } from 'node:path'
import { expandStorageDirectory, globalMemoryDirectory } from '../../memory/data-directory.ts'
import type { ResolvedConfig } from '../configuration/config.ts'
import { withMemoryStorageLock } from '../../sdk/storage-lock.ts'
import { workspaceStorageId } from '../../sdk/workspace-storage.ts'

export interface StorageRoot {
  effectiveDataDir(): string
  withExclusive<T>(operation: () => T | Promise<T>): Promise<T>
}

/** Host owns every built-in layout; Sources own the data within the chosen root. */
function storageDirectory(config: Pick<ResolvedConfig, 'storageScope' | 'dataDir'>, workspaceRoot?: string): string {
  switch (config.storageScope) {
    case 'global': return globalMemoryDirectory()
    case 'custom': return expandStorageDirectory(config.dataDir!)
    case 'workspace': return resolve(workspaceRoot ?? process.cwd(), '.mnemon')
    case 'workspaces': {
      const root = config.dataDir === undefined ? globalMemoryDirectory() : expandStorageDirectory(config.dataDir)
      return join(root, 'workspaces', workspaceStorageId(resolve(workspaceRoot ?? process.cwd())))
    }
  }
}

export function createStorageRoot(config: Pick<ResolvedConfig, 'storageScope' | 'dataDir'>, workspaceRoot?: string): StorageRoot {
  const directory = storageDirectory(config, workspaceRoot)
  return {
    effectiveDataDir: () => directory,
    withExclusive: operation => withMemoryStorageLock(directory, operation),
  }
}
