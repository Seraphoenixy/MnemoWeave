// Copy each component's presentation assets and locale files into dist, where the
// package's subpath exports resolve them. The build emits code and declarations;
// these are data files that ship beside it.
import { cp, mkdir, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src', 'components')
const target = join(root, 'dist', 'components')

const components = (await readdir(source, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
for (const name of components) {
  for (const asset of ['presentation', 'locale', 'market']) {
    const from = join(source, name, asset)
    try {
      await readdir(from)
    } catch {
      continue
    }
    const to = join(target, name, asset)
    await mkdir(dirname(to), { recursive: true })
    await cp(from, to, { recursive: true })
  }
}
console.log(`Copied component assets for ${components.length} components.`)
