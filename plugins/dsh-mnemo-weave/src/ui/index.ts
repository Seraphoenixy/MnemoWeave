/**
 * MnemoWeave DSH plugin — Host half.
 *
 * Registers one editable RPC channel the client page calls. The Host, not the browser, reaches
 * the MnemoWeave Server through the shared `packages/client` transport: the service token stays
 * in this process and the Server identifies the caller by the `x-mnemoweave-host` header.
 * Configuration comes from the Cordis entry (or the matching environment variables); without a
 * usable token the plugin stays inert and says why on stderr, never aborting the DSH boot.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryClient, ensureServer, prewarmBudgetMs } from '../../../../packages/client/src/index.ts';
import { createRpcHandler } from './rpc.ts';
import { createTaskRunner } from './task-runner.ts';
import { runIdleReview } from './idle-review-task.ts';
import { SettingsService } from './settings.ts';
import { MemorySource } from './memory-source.ts';
import { BUNDLE_NAME, isHostArtifact, reloadBundle, shouldWatch, watchLib } from './hot-reload.ts';
import type { PluginManagerLike } from './hot-reload.ts';
import { isRecord, RPC_CHANNEL } from '../shared/contract.ts';
import {
  DEFAULT_HOST_ID, DEFAULT_SERVER_URL, MIN_TOKEN_LENGTH, describeHostConfig, readPreferences,
  resolveHostConfig, writePreferences,
} from '../shared/host-config.js';
import type { HostConfigDescription } from '../shared/host-config.js';
import type { HostContext } from './types.ts';

export const name = 'dsh-mnemo-weave/ui';
// `connection.rpc.handle` mounts the channel route on the web server through the context that read
// the service, so that context must also carry `webServer`; without it registration throws
// `cannot get property "webServer" without inject` and the entry fails.
export const inject = ['connection', 'webServer'] as const;

export { DEFAULT_HOST_ID, DEFAULT_SERVER_URL, MIN_TOKEN_LENGTH };

export interface Config {
  serverUrl?: string;
  token?: string;
  hostId?: string;
  /** Explicit workspace binding for a host with no workspace root directory. */
  workspaceId?: string;
  timeoutMs?: number;
}

export interface ResolvedConfig {
  serverUrl: string;
  token: string | undefined;
  /** Credential for actions that claim a person performed them; absent means they are refused. */
  hostId: string;
  workspaceId: string | undefined;
  injectTimeoutMs: number;
  autoStart: boolean;
  description: HostConfigDescription;
}

/**
 * Entry config, stored preferences and environment, resolved by the shared module so the page and
 * the injection hook always read the same values.
 */
export function resolveConfig(config: unknown, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const resolved = resolveHostConfig(config, env, readPreferences(env));
  return {
    serverUrl: resolved.serverUrl,
    token: resolved.token,
    hostId: resolved.hostId,
    workspaceId: resolved.workspaceId,
    injectTimeoutMs: resolved.injectTimeoutMs,
    autoStart: resolved.autoStart,
    description: describeHostConfig(resolved),
  };
}

function warn(message: string): void {
  process.stderr.write(`${JSON.stringify({ event: 'mnemoweave_ui_plugin', level: 'warn', message })}\n`);
}

function info(message: string): void {
  process.stderr.write(`${JSON.stringify({ event: 'mnemoweave_ui_plugin', level: 'info', message })}\n`);
}

/**
 * Dev-only watcher: rebuild output under `lib/` asks the Host to recompose this bundle.
 * It runs before the token gate so a developer still gets reloads while tuning config.
 */
function installHotReload(ctx: HostContext, packageDir: string): void {
  if (!shouldWatch(packageDir)) return;
  const libDir = join(packageDir, 'lib');
  let reloading = false;
  let queued = false;
  const request = (): void => {
    if (reloading) { queued = true; return; }
    if (ctx.get('hmr') === undefined) {
      warn('自动重载：本 profile 没有 hmr 服务，宿主要重启才生效，跳过这次');
      return;
    }
    const manager = ctx.get('pluginManager') as PluginManagerLike | undefined;
    reloading = true;
    info('自动重载：检测到 lib 变化，请求宿主按磁盘上的新代码重新组合');
    void reloadBundle(manager, BUNDLE_NAME)
      .then(outcome => { (outcome.ok ? info : warn)(`自动重载：${outcome.message}`); })
      .catch(error => warn(`自动重载异常：${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        reloading = false;
        if (!queued) return;
        queued = false;
        request();
      });
  };
  const stop = watchLib({
    dir: libDir,
    filter: isHostArtifact,
    onChange: request,
    logger: { info: message => info(message), warn: message => warn(message) },
  });
  ctx.effect(() => stop, 'dsh-mnemo-weave: hot reload');
  info(`自动重载已启用：监视 ${libDir}（DSH_MNEMO_WEAVE_HOT_RELOAD=0 可关闭）`);
}

export function apply(ctx: HostContext, config?: unknown): void {
  // Development loop first; it must survive a temporary configuration mistake.
  installHotReload(ctx, dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
  let resolved: ResolvedConfig;
  try { resolved = resolveConfig(config); }
  catch (error) {
    warn(`configuration rejected: ${String((error as Error).message).slice(0, 200)}`);
    return;
  }
  if (resolved.token === undefined || resolved.token.length < MIN_TOKEN_LENGTH) {
    warn('MNEMOWEAVE_TOKEN is missing or shorter than 24 characters; the memory page stays unavailable');
    return;
  }
  let client: MemoryClient;
  try {
    client = new MemoryClient({
      baseUrl: resolved.serverUrl, token: resolved.token, hostId: resolved.hostId,
    });
  } catch (error) {
    warn(`configuration rejected: ${String((error as Error).message).slice(0, 200)}`);
    return;
  }
  // One configuration service for the page; it also owns the switch to a newly saved connection.
  const settings = new SettingsService({
    entryConfig: config,
    onConnection: snapshot => {
      // Adopt the client only after a save that already tested it, so the read path and the
      // settings page never point at different Servers.
      source.useConnection({
        client: snapshot.client, serverUrl: snapshot.serverUrl, hostId: snapshot.hostId, hasToken: true,
        sources: { ...settings.describe().sources },
      });
    },
  });
  // The local Server is hosted by the "MnemoWeave Local Server" scheduled task, so DSH may be
  // opened before it. Prewarm in the background: a refused connection wakes the task once, and
  // the memory page shows the phase while it comes up. Failures never abort the DSH boot.
  //
  // Registration is an install step (`node scripts/publish-server.mjs --register`), not something
  // a host does at startup: asking for elevation on every launch would make the permission
  // prompt part of normal operation. A missing task is reported as `task_missing`.
  const ensure = (budgetMs: number) => {
    const live = settings.snapshot;
    return ensureServer({
      baseUrl: live.serverUrl,
      token: live.token!,
      hostId: live.hostId,
      probeTimeoutMs: 1_000,
      waitMs: budgetMs,
    });
  };
  void ensure(prewarmBudgetMs())
    .then(probe => {
      if (probe.state === 'ready') info('本机 Server 已连接');
      else if (probe.state === 'starting') info(`本机 Server 正在启动：${probe.detail}`);
      else warn(`本机 Server 不可用：${probe.reason}（${probe.detail}）`);
    })
    .catch(error => warn(`本机 Server 探测异常：${error instanceof Error ? error.message : String(error)}`));
  const source = new MemorySource({
    client, serverUrl: resolved.serverUrl, hasToken: true, ensureServer: ensure,
    sources: { ...resolved.description.sources },
  });
  let getAgents: (() => unknown) | undefined;
  ctx.inject?.(['agents'], agentContext => {
    const accessor = () => agentContext.get('agents');
    getAgents = accessor;
    agentContext.effect(() => () => {
      if (getAgents === accessor) getAgents = undefined;
    }, 'dsh-mnemo-weave: task agents');
  });
  // Idle review is a background improvement: one pass at a time, only when a model route exists,
  // and every failure is contained by the next tick. The Server owns single-flight per session.
  let reviewing = false;
  const idleTimer = setInterval(() => {
    if (reviewing || getAgents === undefined) return;
    reviewing = true;
    void (async () => {
      try {
        for (const session of (await source.idleReviewPending()).slice(0, 3)) {
          await runIdleReview(source, createTaskRunner(() => getAgents?.()), session.sessionId, undefined);
        }
      } catch {
        // A missing model route or an already running session is retried on the next tick.
      } finally { reviewing = false; }
    })();
  }, 10 * 60_000);
  idleTimer.unref?.();
  ctx.effect?.(() => () => clearInterval(idleTimer), 'dsh-mnemo-weave: idle review timer');
  ctx.effect(() => {
    const connection = ctx.connection;
    const webServer = ctx.get('webServer');
    if (connection === undefined || webServer === undefined) return;
    // The channel is mounted through the context that read `connection`, so hand the registration a
    // context carrying `webServer` as its own property, the way dsh-mnemon registers its channels.
    const owner = ctx.extend === undefined ? ctx : ctx.extend({ webServer });
    const target = owner.connection;
    if (target === undefined) return;
    const dispose = target.rpc.handle(RPC_CHANNEL, createRpcHandler(source, settings, createTaskRunner(() => getAgents?.())));
    return () => { if (typeof dispose === 'function') (dispose as () => void)(); };
  }, 'dsh-mnemo-weave: memory channel');
}
