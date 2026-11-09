/** The narrow DSH browser contracts this plugin binds to; no @deepseek-ai import is required. */
import type { ReactNode } from 'react';
import type { RpcResult } from '../shared/contract.ts';

export interface ClientRpc {
  call<T = unknown>(channel: string, endpoint: string, payload?: unknown, signal?: AbortSignal): Promise<RpcResult<T>>;
}

export interface ClientConnection {
  rpc: ClientRpc;
  isLoopback?: boolean;
}

export interface SlotRegisterOptions {
  name: string;
  id?: string;
  key?: string;
  order?: number;
  label?: string | (() => string);
  locale?: string;
  inject?: () => Record<string, unknown>;
}

export interface SlotsService {
  inject(name: string, setup: () => () => void): () => void;
  register(options: SlotRegisterOptions, component: (props: never) => ReactNode): () => void;
}

export interface LayoutService {
  selectPanel(id: string | null): void;
}

export interface LocaleSnapshot { active?: string }
export interface LocaleService {
  getSnapshot?(): LocaleSnapshot;
  subscribe?(listener: () => void): () => void;
}

export interface ClientContext {
  connection: ClientConnection;
  slots: SlotsService;
  layout: LayoutService;
  locale?: LocaleService;
  effect(setup: () => void | (() => void), label?: string): void;
}

export const MAIN_PANEL_ID = 'mnemoweave';
