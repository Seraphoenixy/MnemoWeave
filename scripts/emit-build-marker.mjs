// Emit the DSH hot-reload completion marker only after all build stages
// (bundle compilation, declarations linking, and component asset copying) finish.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cache = join(root, '.cache')
const marker = join(cache, 'dsh-build-complete')
const staging = join(cache, `.dsh-build-complete.${process.pid}.tmp`)

mkdirSync(cache, { recursive: true })
writeFileSync(staging, `${Date.now()}-${process.pid}\n`, 'utf8')
renameSync(staging, marker)
