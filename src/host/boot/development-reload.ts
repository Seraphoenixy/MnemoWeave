import { existsSync, readFileSync, unwatchFile, watchFile, type Stats } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { HostContextShape } from '../support/dsh.ts'

export interface BundleManager {
  setBundleEnabled(name: string, enabled: boolean): Promise<{
    application: string
    restartReason?: string
    error?: { message?: string }
  }>
}

export interface DevelopmentReloadOptions {
  checkoutRoot?: URL
  intervalMs?: number
  env?: NodeJS.ProcessEnv
  logger?: Pick<Console, 'info' | 'warn'>
}

const DEFAULT_WATCH_INTERVAL_MS = 500
const REQUIRED_BUILD_ARTIFACTS = ['dist/index.js', 'dist/client.js'] as const

/** Locate the linked checkout root regardless of entry or chunk nesting depth. */
export function findCheckoutRoot(moduleUrl: string | URL = import.meta.url): URL | undefined {
  let current = new URL('./', moduleUrl)
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(new URL('tsdown.config.ts', current)) && existsSync(new URL('package.json', current))) {
      return current
    }
    const parent = new URL('../', current)
    if (parent.href === current.href) break
    current = parent
  }
  return undefined
}

function readMarker(markerPath: string): string | undefined {
  try {
    return readFileSync(markerPath, 'utf8')
  } catch {
    return undefined
  }
}

function buildArtifactsReady(checkoutRoot: URL): boolean {
  return REQUIRED_BUILD_ARTIFACTS.every(relativePath => existsSync(new URL(relativePath, checkoutRoot)))
}

export function installDevelopmentReload(ctx: HostContextShape, options: DevelopmentReloadOptions = {}): void {
  const env = options.env ?? process.env
  if (env.DSH_MNEMO_WEAVE_HOT_RELOAD === '0') return
  const checkout = options.checkoutRoot ?? findCheckoutRoot(import.meta.url)
  if (checkout === undefined) return
  const logger = options.logger ?? console
  const intervalMs = options.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS
  const marker = fileURLToPath(new URL('.cache/dsh-build-complete', checkout))

  ctx.effect(() => {
    let disposed = false
    let pending = false
    let running = false
    let restartAnnounced = false
    let lastMarker = readMarker(marker)

    async function reload(): Promise<void> {
      running = true
      try {
        while (!disposed && pending) {
          pending = false
          if (!buildArtifactsReady(checkout!)) {
            logger.warn('MnemoWeave 自动重载：构建产物不完整，等待完整构建完成')
            continue
          }
          try {
            const manager = ctx.get('pluginManager') as BundleManager | undefined
            if (typeof manager?.setBundleEnabled !== 'function') {
              logger.warn('MnemoWeave 自动重载：当前 DSH profile 缺少插件管理器')
              continue
            }
            const result = await manager.setBundleEnabled('dsh-mnemo-weave', true)
            if (result.application === 'applied') {
              restartAnnounced = false
              logger.info('MnemoWeave 自动重载：DSH 已应用新构建（WebUI 变更刷新页面生效）')
            } else if (result.application === 'restart-required') {
              const detail = result.restartReason ?? result.application
              if (!restartAnnounced || result.restartReason !== 'no-hmr') {
                logger.warn(`MnemoWeave 自动重载：${detail}，请重启 DSH`)
              }
              if (result.restartReason === 'no-hmr') restartAnnounced = true
            } else {
              const detail = result.error?.message ?? result.restartReason ?? result.application
              logger.warn(`MnemoWeave 自动重载：${detail}`)
            }
          } catch (error) {
            logger.warn('MnemoWeave 自动重载失败', error)
          }
        }
      } finally {
        running = false
      }
    }

    const changed = (current: Stats, previous: Stats): void => {
      if (disposed || current.mtimeMs === 0) return
      const nextMarker = readMarker(marker)
      const mtimeChanged = current.mtimeMs !== previous.mtimeMs
      const contentChanged = nextMarker !== undefined && nextMarker !== lastMarker
      if (!mtimeChanged && !contentChanged) return
      lastMarker = nextMarker
      pending = true
      if (!running) void reload()
    }
    watchFile(marker, { persistent: false, interval: intervalMs }, changed)
    return () => {
      disposed = true
      unwatchFile(marker, changed)
    }
  }, 'dsh-mnemo-weave: development reload')
}
