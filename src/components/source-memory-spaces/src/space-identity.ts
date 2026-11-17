/**
 * Whether two copies of a Mnemon Native space hold the same memories, and the merge of two
 * versions of one (#370, #391). Reading a space changes its bytes, so copies are compared by what
 * they hold; mnemon-store-identity.ts says exactly what that is. Node-only: it reads stores with
 * `node:sqlite` where Node has it and compares bytes where it does not.
 */
import { MnemonStoreIdentity } from './mnemon-store-identity.ts'

export class MemorySpaceIdentity {
  readonly #identity: MnemonStoreIdentity

  /** `parent` holds the short-lived copies a store is read from; dispose of the identity when done. */
  constructor(parent: string) {
    this.#identity = new MnemonStoreIdentity(parent)
  }

  /** The store's content identity, or the digest of its bytes when its content cannot be read. */
  of(bytes: Uint8Array): string {
    return this.#identity.of(bytes)
  }

  /** Whether `outer` holds every row `inner` holds; `outer` may have columns `inner` lacks. */
  contains(outer: Uint8Array, inner: Uint8Array): boolean {
    return this.#identity.contains(outer, inner)
  }

  /**
   * `local` with the rows only `incoming` holds added to it, or undefined when the two cannot
   * merge: a row both hold differently, a table or column `local` lacks, or a store that cannot
   * be read. `local` itself comes back when it already holds everything.
   */
  merge(local: Uint8Array, incoming: Uint8Array): Uint8Array | undefined {
    return this.#identity.merge(local, incoming)
  }

  /** Remove the short-lived copies the identity made. */
  dispose(): void {
    this.#identity.dispose()
  }
}
