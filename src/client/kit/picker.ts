import type { MnemonClientContext } from '../hosting/dsh-context.ts'
import { isRemoteConnection } from '../connection/remote-rpc.ts'

/** The optional public DSH workspace UI service; cancellation returns null. */
interface DirectoryPickerService {
  pickDirectory?(): Promise<string | null>
}

export interface MnemonDirectoryPicker {
  available(): boolean
  pick(): Promise<string | null>
}

/** Resolve the soft dependency on demand, including after a client plugin reload. */
export function directoryPicker(ctx: Pick<MnemonClientContext, 'get' | 'connection'>): MnemonDirectoryPicker {
  const service = (): DirectoryPickerService | undefined => ctx.get('uiWorkspace') as DirectoryPickerService | undefined
  return {
    available: () => {
      try { return !isRemoteConnection(ctx.connection) && typeof service()?.pickDirectory === 'function' } catch { return false }
    },
    pick: async () => {
      const current = service()
      if (isRemoteConnection(ctx.connection) || typeof current?.pickDirectory !== 'function') throw new Error('Directory chooser is unavailable')
      return await current.pickDirectory()
    },
  }
}
