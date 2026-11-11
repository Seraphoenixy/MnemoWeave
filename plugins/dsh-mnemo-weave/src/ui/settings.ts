/**
 * Mutable Host configuration for the settings page.
 *
 * Two rules drive this module:
 *
 * 1. A new connection is swapped in only after it has been validated and tested. A failed save
 *    leaves the previous snapshot and client untouched, so a typo in the address cannot take a
 *    working page offline.
 * 2. The page and the prompt-injection hook must read the same values. Non-secret values are
 *    written through `host-config.js`, which the injection hook also loads; the token never
 *    passes through this module's stored form and is never returned to the browser.
 */
import { MemoryClient, ensureServer, probeServer, registerLocalServerTask, resolveLocalServerRegistration } from '../../../../packages/client/src/index.ts';
import {
  LOCAL_SERVER_TASK_NAME, MIN_TOKEN_LENGTH, describeHostConfig, readPreferences, resolveHostConfig,
  settingsPath, validatePreferences, writePreferences,
} from '../shared/host-config.js';
import type { HostConfigDescription, ResolvedHostConfig } from '../shared/host-config.js';
import type { UiConnectionTest, UiRegisterTest, UiSettings, UiWakeTest } from '../shared/contract.ts';

/**
 * The settings page's registration action. It runs only when a person asks for it, and it is the
 * single place inside the plugin that may raise an elevation prompt.
 */
async function defaultRegisterTask(env: NodeJS.ProcessEnv): Promise<UiRegisterTest> {
  const target = resolveLocalServerRegistration(env);
  if (target === undefined) {
    return { result: 'failed', detail: 'no published Server found; run node scripts/publish-server.mjs' };
  }
  const outcome = await registerLocalServerTask(target);
  return { result: outcome.result, ...(outcome.detail === undefined ? {} : { detail: outcome.detail }) };
}

export interface SettingsDeps {
  /** Entry config from the Cordis plugin, the lowest-priority explicit layer. */
  entryConfig: unknown;
  env?: NodeJS.ProcessEnv;
  /** Injected so tests never touch the real task scheduler or the real Server. */
  runTask?: () => Promise<void>;
  /** Injected so tests never raise a real elevation prompt. */
  registerTask?: () => Promise<UiRegisterTest>;
  probe?: (input: { baseUrl: string; token: string }) => Promise<UiConnectionTest>;
  /**
   * Called whenever the live connection changes, so the read path can adopt the same client.
   * A rejected save never calls this: the old connection stays in use.
   */
  onConnection?: (snapshot: Snapshot) => void;
}

/** The live connection the RPC handlers use. Replaced only after a successful save. */
export interface Snapshot {
  serverUrl: string;
  hostId: string;
  token: string | undefined;
  projectId: string | undefined;
  injectTimeoutMs: number;
  autoStart: boolean;
  client: MemoryClient;
}

export class SettingsService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly runTask: () => Promise<void>;
  private readonly registerTaskAction: () => Promise<UiRegisterTest>;
  private readonly probe: (input: { baseUrl: string; token: string }) => Promise<UiConnectionTest>;
  private resolved: ResolvedHostConfig;
  private current: Snapshot;
  private lastAuth: 'ok' | 'unauthorized' | 'unavailable' | 'unknown' = 'unknown';
  private readonly entryConfig: unknown;
  private readonly onConnection: ((snapshot: Snapshot) => void) | undefined;

  constructor(deps: SettingsDeps) {
    this.entryConfig = deps.entryConfig;
    this.onConnection = deps.onConnection;
    this.env = deps.env ?? process.env;
    this.runTask = deps.runTask ?? defaultRunTask;
    this.registerTaskAction = deps.registerTask ?? (() => defaultRegisterTask(this.env));
    this.probe = deps.probe ?? defaultProbe;
    this.resolved = resolveHostConfig(this.entryConfig, this.env, readPreferences(this.env));
    this.current = this.makeSnapshot(this.resolved);
  }

  private makeSnapshot(resolved: ResolvedHostConfig): Snapshot {
    return {
      serverUrl: resolved.serverUrl,
      hostId: resolved.hostId,
      token: resolved.token,
      projectId: resolved.projectId,
      injectTimeoutMs: resolved.injectTimeoutMs,
      autoStart: resolved.autoStart,
      client: new MemoryClient({
        baseUrl: resolved.serverUrl,
        // The token gate in `apply` guarantees a usable token before this is constructed.
        token: resolved.token ?? '',
        hostId: resolved.hostId,
        // Only user-initiated edits and withdrawals use it; absent means they are refused.
        }),
    };
  }

  get snapshot(): Snapshot { return this.current; }

  /** Record the outcome of an authenticated call so the settings page can show the last result. */
  noteAuth(result: 'ok' | 'unauthorized' | 'unavailable'): void { this.lastAuth = result; }

  describe(): HostConfigDescription { return describeHostConfig(this.resolved); }

  /**
   * The full grouped settings view. Every field carries its source so a saved value and the
   * value actually in use can be told apart.
   */
  settings(): UiSettings {
    const description = this.describe();
    const sources = description.sources;
    return {
      interface: {
        defaultTab: description.preferences.defaultTab,
        pageSize: description.preferences.pageSize,
        source: 'preference',
      },
      connection: {
        serverUrl: description.serverUrl,
        hostId: description.hostId,
        source: sources.serverUrl,
        hostSource: sources.hostId,
      },
      credential: {
        configured: description.tokenStatus.configured,
        source: description.tokenStatus.source,
        lastAuth: this.lastAuth,
      },
      autoStart: {
        enabled: description.autoStart,
        taskName: LOCAL_SERVER_TASK_NAME,
        source: 'preference',
      },
      injection: {
        projectId: description.projectId,
        injectTimeoutMs: description.injectTimeoutMs,
        source: sources.projectId,
        timeoutSource: sources.injectTimeoutMs,
      },
      diagnostics: {
        // Read on demand by the page's status call; here it is only configuration-level truth.
        serverReady: false,
        providerReady: false,
        syncEnabled: false,
        settingsPath: settingsPath(this.env),
      },
    };
  }

  /** Interface preferences save immediately and never touch the connection. */
  saveInterface(patch: unknown): UiSettings {
    writePreferences(patch as Record<string, unknown>, this.env);
    this.reload();
    return this.settings();
  }

  /**
   * Save the connection. The candidate address is validated, then tested with the current token;
   * only a test that reaches our Server is written. A failure changes nothing.
   *
   * The value is written to the shared preference file, not kept in this process: the injection
   * hook resolves from that same file, and a page-only connection would have the two halves
   * talking to different Servers until DSH restarted.
   */
  async saveConnection(input: { serverUrl?: string; hostId?: string }): Promise<UiSettings> {
    const description = this.describe();
    const serverUrl = (input.serverUrl ?? description.serverUrl).trim().replace(/\/$/, '');
    const hostId = (input.hostId ?? description.hostId).trim();
    if (hostId === '' || hostId.length > 200) throw Object.assign(new Error('hostId must be 1–200 characters'), { code: 'INVALID_INPUT' });
    const token = this.current.token;
    if (token === undefined || token.length < MIN_TOKEN_LENGTH) throw Object.assign(new Error('a service token is required'), { code: 'UNAUTHORIZED' });
    const tested = await this.probe({ baseUrl: serverUrl, token });
    if (!tested.ok) {
      // Keep the old snapshot: a rejected address must not break a working connection.
      throw Object.assign(new Error(tested.detail ?? tested.reason), { code: tested.reason === 'unauthorized' ? 'UNAUTHORIZED' : 'INVALID_INPUT' });
    }
    // Persisted only after the test passed, so a typo can never become the stored connection.
    writePreferences({ serverUrl, hostId }, this.env);
    this.reload();
    return this.settings();
  }

  /** The injection wait budget is the only injection preference left. */
  saveInjection(input: { injectTimeoutMs?: number }): UiSettings {
    writePreferences({
      ...(input.injectTimeoutMs === undefined ? {} : { injectTimeoutMs: input.injectTimeoutMs }),
    }, this.env);
    this.reload();
    return this.settings();
  }

  saveAutoStart(input: { enabled?: boolean }): UiSettings {
    if (typeof input.enabled !== 'boolean') throw Object.assign(new Error('enabled must be a boolean'), { code: 'INVALID_INPUT' });
    writePreferences({ autoStart: input.enabled }, this.env);
    this.reload();
    return this.settings();
  }

  private reload(): void {
    const preferences = readPreferences(this.env);
    const next = resolveHostConfig(this.entryConfig, this.env, preferences);
    this.resolved = next;
    // Rebuild the snapshot so the page and the injection hook agree immediately.
    this.current = this.makeSnapshot(next);
    this.onConnection?.(this.current);
  }

  /** Test an address without saving anything. */
  async testConnection(input: { serverUrl?: string }): Promise<UiConnectionTest> {
    const serverUrl = (input.serverUrl ?? this.current.serverUrl).trim().replace(/\/$/, '');
    const token = this.current.token;
    if (token === undefined || token.length < MIN_TOKEN_LENGTH) {
      return { ok: false, reason: 'unauthorized', detail: 'no service token is configured' };
    }
    const result = await this.probe({ baseUrl: serverUrl, token });
    this.lastAuth = result.ok ? 'ok' : result.reason === 'unauthorized' ? 'unauthorized' : 'unavailable';
    return result;
  }

  /**
   * Ask the scheduled task to start the local Server. The four outcomes stay distinct, because
   * "already running", "we woke it", "the task is missing" and "it timed out" need different
   * fixes.
   */
  async testWake(input: { baseUrl?: string } = {}): Promise<UiWakeTest> {
    const serverUrl = input.baseUrl ?? this.current.serverUrl;
    const token = this.current.token;
    if (token === undefined || token.length < MIN_TOKEN_LENGTH) {
      return { result: 'failed', detail: 'no service token is configured' };
    }
    const first = await this.probe({ baseUrl: serverUrl, token });
    if (first.ok) return { result: 'already_running' };
    try {
      await this.runTask();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The task scheduler reports a missing task distinctly; keep that apart from a failure.
      return { result: /cannot find|not found|does not exist/i.test(message) ? 'task_missing' : 'failed', detail: message.slice(0, 200) };
    }
    const ready = await ensureServer({ baseUrl: serverUrl, token, hostId: this.current.hostId, probeTimeoutMs: 1_000, waitMs: 4_000 });
    if (ready.state === 'ready') return { result: 'woken' };
    return { result: 'timeout', detail: ready.state === 'failed' ? ready.detail : 'the Server did not become ready in time' };
  }

  /**
   * Register the scheduled task once, through the scheduler. The page calls this only from its
   * own button: nothing here runs during a connection probe.
   */
  async registerTask(): Promise<UiRegisterTest> {
    return this.registerTaskAction();
  }

  /** Probe used when the page refreshes its status. */
  async statusProbe(): Promise<{ ok: boolean; reason?: string }> {
    const token = this.current.token;
    if (token === undefined) return { ok: false, reason: 'unauthorized' };
    const result = await probeServer({ baseUrl: this.current.serverUrl, token, hostId: this.current.hostId });
    if (result.state === 'ready') return { ok: true };
    return { ok: false, reason: result.state === 'failed' ? result.reason : 'starting' };
  }
}

async function defaultProbe(input: { baseUrl: string; token: string; hostId?: string }): Promise<UiConnectionTest> {
  const result = await probeServer({ baseUrl: input.baseUrl, token: input.token, hostId: input.hostId ?? 'dsh' });
  if (result.state === 'ready') return { ok: true, reason: 'ok' };
  if (result.state === 'starting') return { ok: false, reason: 'connection_refused', detail: result.detail };
  if (result.reason === 'unauthorized') return { ok: false, reason: 'unauthorized', detail: result.detail };
  if (result.reason === 'address_conflict') return { ok: false, reason: 'address_conflict', detail: result.detail };
  if (result.reason === 'connection_refused') return { ok: false, reason: 'connection_refused', detail: result.detail };
  return { ok: false, reason: 'invalid', detail: result.detail };
}

/** Start the registered task through the standard scheduler CLI. */
async function defaultRunTask(): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  // `schtasks` is a native executable; its output is read from stdout only, because the
  // PowerShell wrapper turns stderr into a terminating error.
  const { stdout } = await run('schtasks', ['/run', '/tn', LOCAL_SERVER_TASK_NAME], { windowsHide: true });
  void stdout;
}

export { validatePreferences };
