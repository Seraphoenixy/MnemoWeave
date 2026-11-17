import { existsSync, unwatchFile, watchFile, type Stats } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { HostContextShape } from '../support/dsh.ts'

interface BundleManager {
  setBundleEnabled(name: string, enabled: boolean): Promise<{
    application: string
    restartReason?: string
    error?: { message?: string }
  }>
}

const checkout = [new URL('../', import.meta.url), new URL('../../', import.meta.url)]
  .find(root => existsSync(new URL('tsdown.config.ts', root)))

export function installDevelopmentReload(ctx: HostContextShape): void {
  if (!checkout || process.env.DSH_MNEMO_WEAVE_HOT_RELOAD === '0') return
  const marker = fileURLToPath(new URL('.cache/dsh-build-complete', checkout))
  ctx.effect(() => {
    let disposed = false
    let pending = false
    let running = false

    async function reload(): Promise<void> {
      running = true
      try {
        while (!disposed && pending) {
          pending = false
          try {
            const manager = ctx.get('pluginManager') as BundleManager | undefined
            if (typeof manager?.setBundleEnabled !== 'function') {
              console.warn('MnemoWeave 自动重载：当前 DSH profile 缺少插件管理器')
              continue
            }
            const result = await manager.setBundleEnabled('dsh-mnemo-weave', true)
            if (result.application === 'applied') {
              console.info('MnemoWeave 自动重载：DSH 已应用新构建')
            } else {
              const detail = result.error?.message ?? result.restartReason ?? result.application
              console.warn(`MnemoWeave 自动重载：${detail}${result.application === 'restart-required' ? '，请重启 DSH' : ''}`)
            }
          } catch (error) {
            console.warn('MnemoWeave 自动重载失败', error)
          }
        }
      } finally {
        running = false
      }
    }

    const changed = (current: Stats, previous: Stats): void => {
      if (disposed || current.mtimeMs === 0 || current.mtimeMs === previous.mtimeMs) return
      pending = true
      if (!running) void reload()
    }
    watchFile(marker, { persistent: false, interval: 500 }, changed)
    return () => {
      disposed = true
      unwatchFile(marker, changed)
    }
  }, 'dsh-mnemo-weave: development reload')
}
