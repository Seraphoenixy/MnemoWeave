/**
 * MnemoWeave DSH plugin — Host half.
 *
 * Registers one read-only RPC channel the client page calls. The Host, not the browser,
 * reaches the Bridge UI endpoint: the Bridge refuses browser origins and the UI token
 * stays in this process. Configuration comes from the Cordis entry (or the matching
 * MNEMOWEAVE_* environment variables); without a token the plugin stays inert and says so.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeUiClient } from './bridge-client.ts';
import { createRpcHandler } from './rpc.ts';
import { BUNDLE_NAME, isHostArtifact, reloadBundle, shouldWatch, watchLib } from './hot-reload.ts';
import type { PluginManagerLike } from './hot-reload.ts';
import { isRecord, RPC_CHANNEL } from '../shared/contract.ts';
import type { HostContext } from './types.ts';

export const name = 'dsh-mnemo-weave/ui';
// `connection.rpc.handle` mounts the channel route on the web server through the context that read
// the service, so that context must also carry `webServer`; without it registration throws
// `cannot get property "webServer" without inject` and the entry fails.
export const inject = ['connection', 'webServer'] as const;

export const DEFAULT_BRIDGE_UI_URL = 'http://127.0.0.1:4319';
export const MIN_TOKEN_LENGTH = 24;

export interface Config {
  bridgeUrl?: string;
  token?: string;
  hostId?: string;
  timeoutMs?: number;
}

export interface ResolvedConfig {
  bridgeUrl: string;
  token: string | undefined;
  hostId: string | undefined;
  timeoutMs: number;
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Entry config first, environment second: a profile can keep the token out of its patch file. */
export function resolveConfig(config: unknown, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const record = isRecord(config) ? config : {};
  const bridgeUrl = pickString(record['bridgeUrl']) ?? pickString(env.MNEMOWEAVE_BRIDGE_UI_URL) ?? DEFAULT_BRIDGE_UI_URL;
  if (!/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?\/?$/i.test(bridgeUrl)) {
    throw new Error('dsh-mnemo-weave bridgeUrl must be a loopback http(s) URL');
  }
  if (bridgeUrl.startsWith('https://') && !bridgeUrl.includes('127.0.0.1') && !bridgeUrl.includes('localhost')) {
    throw new Error('dsh-mnemo-weave bridgeUrl must be loopback');
  }
  const timeout = record['timeoutMs'];
  const timeoutMs = typeof timeout === 'number' && Number.isFinite(timeout) ? Math.min(Math.max(Math.trunc(timeout), 250), 30_000) : 3_000;
  return {
    bridgeUrl: bridgeUrl.replace(/\/$/, ''),
    token: pickString(record['token']) ?? pickString(env.MNEMOWEAVE_BRIDGE_UI_TOKEN),
    hostId: pickString(record['hostId']) ?? pickString(env.MNEMOWEAVE_BRIDGE_HOST_ID),
    timeoutMs,
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
    warn('MNEMOWEAVE_BRIDGE_UI_TOKEN is missing or shorter than 24 characters; the memory page stays unavailable');
    return;
  }
  const client = new BridgeUiClient({ baseUrl: resolved.bridgeUrl, token: resolved.token, ...(resolved.hostId === undefined ? {} : { hostId: resolved.hostId }), timeoutMs: resolved.timeoutMs });
  ctx.effect(() => {
    const connection = ctx.connection;
    const webServer = ctx.get('webServer');
    if (connection === undefined || webServer === undefined) return;
    // The channel is mounted through the context that read `connection`, so hand the registration a
    // context carrying `webServer` as its own property, the way dsh-mnemon registers its channels.
    const owner = ctx.extend === undefined ? ctx : ctx.extend({ webServer });
    const target = owner.connection;
    if (target === undefined) return;
    const dispose = target.rpc.handle(RPC_CHANNEL, createRpcHandler(client));
    return () => { if (typeof dispose === 'function') (dispose as () => void)(); };
  }, 'dsh-mnemo-weave: read channel');
}
