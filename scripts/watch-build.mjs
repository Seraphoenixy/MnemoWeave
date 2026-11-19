// Watch source and build configuration files, running serialized full builds
// so `.cache/dsh-build-complete` only updates after every artifact is ready.
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEBOUNCE_MS = 200
const WATCH_TARGETS = [
  join(root, 'src'),
  join(root, 'tsdown.config.ts'),
  join(root, 'package.json'),
]

let dirty = false
let building = false
let closed = false
let timer
let currentChild

function runBuild() {
  return new Promise((resolvePromise) => {
    const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    const child = spawn(command, ['run', 'build'], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    currentChild = child
    child.on('exit', (code) => {
      if (currentChild === child) currentChild = undefined
      if (code !== 0 && !closed) {
        console.error(`[build:watch] build exited with code ${code ?? 'unknown'}`)
      }
      resolvePromise()
    })
    child.on('error', (error) => {
      if (currentChild === child) currentChild = undefined
      if (!closed) console.error('[build:watch] failed to start build:', error)
      resolvePromise()
    })
  })
}

async function flush() {
  if (building || closed) return
  building = true
  try {
    while (dirty && !closed) {
      dirty = false
      await runBuild()
    }
  } finally {
    building = false
  }
}

function schedule() {
  if (closed) return
  dirty = true
  if (timer !== undefined) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = undefined
    void flush()
  }, DEBOUNCE_MS)
}

const watchers = WATCH_TARGETS.map((target) => {
  const isSrc = target === join(root, 'src')
  return watch(target, { recursive: isSrc }, () => schedule())
})

function shutdown() {
  closed = true
  if (timer !== undefined) clearTimeout(timer)
  for (const watcher of watchers) watcher.close()
  currentChild?.kill()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

console.log('[build:watch] watching src/, tsdown.config.ts, and package.json...')
schedule()
