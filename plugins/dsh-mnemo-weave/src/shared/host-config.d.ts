/** Types for the plain-JS shared configuration module loaded by both DSH halves. */

export interface Preferences {
  defaultTab: string;
  serverUrl: string | null;
  hostId: string | null;
  pageSize: number;
  injectTimeoutMs: number;
  autoStart: boolean;
}

export interface PreferencesWithPath extends Preferences { path: string }

export type ConfigSource = 'preference' | 'profile' | 'environment' | 'default' | 'missing';

export interface ConfigSources {
  serverUrl: ConfigSource;
  token: ConfigSource;
  hostId: ConfigSource;
  projectId: ConfigSource;
  injectTimeoutMs: ConfigSource;
}

export interface ResolvedHostConfig {
  serverUrl: string;
  token: string | undefined;
  hostId: string;
  projectId: string | undefined;
  injectTimeoutMs: number;
  autoStart: boolean;
  preferences: { defaultTab: string; pageSize: number; path: string };
  taskName: string;
  sources: ConfigSources;
}

export interface HostConfigDescription {
  serverUrl: string;
  hostId: string;
  projectId: string | null;
  injectTimeoutMs: number;
  autoStart: boolean;
  taskName: string;
  tokenStatus: { configured: boolean; source: ConfigSource };
  preferences: { defaultTab: string; pageSize: number; path: string };
  sources: ConfigSources;
}

export const DEFAULT_SERVER_URL: string;
export const DEFAULT_HOST_ID: string;
export const DEFAULT_INJECT_TIMEOUT_MS: number;
export const DEFAULT_PAGE_SIZE: number;
export const MIN_TOKEN_LENGTH: number;
export const MIN_INJECT_TIMEOUT_MS: number;
export const MAX_INJECT_TIMEOUT_MS: number;
export const LOCAL_SERVER_TASK_NAME: string;
export const DEFAULT_PREFERENCES: Preferences;
export function settingsPath(env?: NodeJS.ProcessEnv): string;
export function validatePreferences(patch: Record<string, unknown>): Partial<Preferences>;
export function readPreferences(env?: NodeJS.ProcessEnv): PreferencesWithPath;
export function writePreferences(patch: Record<string, unknown>, env?: NodeJS.ProcessEnv): PreferencesWithPath;
export function resolveHostConfig(entryConfig?: unknown, env?: NodeJS.ProcessEnv, preferences?: PreferencesWithPath): ResolvedHostConfig;
export function describeHostConfig(resolved: ResolvedHostConfig): HostConfigDescription;
export const DEFAULT_WAKE_BUDGET_MS: number;
export interface WakeResult { ready: boolean; woken: boolean; detail?: string }
export function ensureReachable(options?: {
  serverUrl: string;
  token: string;
  hostId?: string;
  autoStart?: boolean;
  budgetMs?: number;
  runTask?: () => Promise<void>;
  /** Only `ok` and `status` are read, so tests can answer without building a full Response. */
  fetchImpl?: (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;
}): Promise<WakeResult>;
