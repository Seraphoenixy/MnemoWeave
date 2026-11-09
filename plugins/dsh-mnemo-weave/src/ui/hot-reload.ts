/**
 * Development-only hot reload for this DSH plugin, modelled on dsh-plugin-harbor.
 *
 * The Host half watches its own build output (`lib/`) and asks the DSH Host to recompose
 * this bundle from disk through the `pluginManager` service. It never clears module caches
 * itself: that reaches into kernel internals and can leave the plugin half-dead.
 *
 * Only a checkout install watches anything (`src/ui/index.ts` + `build.mjs` exist); the
 * packaged copy has neither, so this is inert in production. `DSH_MNEMO_WEAVE_HOT_RELOAD=0`
 * turns it off. The first activation still needs one DSH restart: the watcher lives in the
 * already-loaded Host half.
 */
import { existsSync, realpathSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

export const BUNDLE_NAME = 'dsh-mnemo-weave';
export const HOT_RELOAD_ENV = 'DSH_MNEMO_WEAVE_HOT_RELOAD';

export interface HotReloadLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** The slice of the host `pluginManager` service this watcher uses. */
export interface PluginManagerLike {
  setBundleEnabled?(name: string, enabled: boolean): Promise<unknown>;
}

export interface ReloadOutcome { ok: boolean; message: string }

/** Host-side artifacts only: `client.js` is the browser entry and needs a page refresh, not a recompose. */
export function isHostArtifact(file: string): boolean {
  const normalized = file.replaceAll('\\', '/');
  if (normalized === 'client.js' || normalized.endsWith('/client.js')) return false;
  return normalized.endsWith('.js');
}

/**
 * Watch only when this copy is a checkout: packaged installs carry `lib/` but neither the
 * TypeScript sources nor the build script, so the branch is dead there.
 */
export function shouldWatch(packageDir: string, env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): boolean {
  if (env[HOT_RELOAD_ENV] === '0') return false;
  if (!exists(join(packageDir, 'src', 'ui', 'index.ts'))) return false;
  if (!exists(join(packageDir, 'build.mjs'))) return false;
  return exists(join(packageDir, 'lib'));
}

export interface WatchLibOptions {
  dir: string;
  onChange(): void;
  filter?: (file: string) => boolean;
  logger: HotReloadLogger;
  debounceMs?: number;
}

/**
 * Merge a burst of writes into one callback; watchers and timers are unref'd so an idle
 * desktop process can still exit. The `link:` install shows up as a junction, so watch the
 * real path rather than the link (events from writes through the other path are missed).
 */
export function watchLib(options: WatchLibOptions): () => void {
  const { dir, onChange, logger } = options;
  const filter = options.filter ?? (() => true);
  const debounceMs = options.debounceMs ?? 700;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let target = dir;
  try { target = realpathSync(dir); } catch { /* the directory may be mid-rebuild; watch the given path */ }
  let watcher: FSWatcher;
  try {
    watcher = watch(target, { recursive: true });
  } catch (error) {
    logger.warn(`无法监视 ${target}：${error instanceof Error ? error.message : String(error)}`);
    return () => {};
  }
  const schedule = (event: string, filename: string | null): void => {
    if (stopped) return;
    if (filename !== null && !filter(String(filename).replaceAll('\\', '/'))) return;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; if (!stopped) onChange(); }, debounceMs);
    timer.unref?.();
  };
  watcher.on('change', schedule);
  watcher.on('rename', schedule);
  watcher.on('error', error => logger.warn(`监视器错误：${error instanceof Error ? error.message : String(error)}`));
  watcher.unref?.();
  return () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    timer = undefined;
    try { watcher.close(); } catch { /* already closed */ }
  };
}

/** Ask the host to recompose this bundle from disk; failures are reported, never swallowed. */
export async function reloadBundle(manager: PluginManagerLike | undefined, bundleName = BUNDLE_NAME): Promise<ReloadOutcome> {
  if (manager === undefined || typeof manager.setBundleEnabled !== 'function') {
    return { ok: false, message: '宿主 pluginManager 不可用，无法自动重载（请重启 DSH）' };
  }
  try {
    const raw = await manager.setBundleEnabled(bundleName, true);
    const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : undefined;
    const status = record?.['status'];
    const message = typeof record?.['message'] === 'string' ? record['message'] : undefined;
    if (status === 'failed') return { ok: false, message: message ?? '宿主报告重载失败' };
    if (typeof status === 'string') return { ok: true, message: message ?? `宿主已重新组合（${status}）` };
    return { ok: true, message: message ?? '宿主已重新组合' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
