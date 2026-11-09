/** The narrow part of the DSH Host Context this plugin uses; no DSH SDK import is required. */
import type { RpcResult } from '../shared/contract.ts';

export type RpcHandler = (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<RpcResult<unknown>>;

export interface HostConnectionHandle {
  rpc: {
    handle(channel: string, handler: RpcHandler): unknown;
  };
}

export interface HostContext {
  connection?: HostConnectionHandle;
  effect(setup: () => void | (() => void), label?: string): void;
  get(name: string): unknown;
  inject?(deps: string[], setup: (ctx: HostContext) => void): void;
}
