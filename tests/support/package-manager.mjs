// Resolve how to run a package.json script through the package manager that
// started the current process.
//
// `npm_execpath` is a JavaScript entry for package managers installed through
// npm (`node_modules/pnpm/bin/pnpm.cjs`), and a native executable for standalone
// installs (`~/.local/share/pnpm/pnpm`, or `pnpm.exe` on Windows). Node cannot
// load a native executable as a module, so only a JavaScript entry runs through
// `process.execPath`; everything else is spawned directly.
import { extname } from 'node:path'

const JAVASCRIPT_ENTRIES = new Set(['.js', '.cjs', '.mjs'])

export function packageManagerCommand(environment = process.env) {
  const npmExecPath = environment.npm_execpath
  if (npmExecPath === undefined || npmExecPath === '') {
    throw new Error('Run this check through the package manager')
  }
  if (JAVASCRIPT_ENTRIES.has(extname(npmExecPath).toLowerCase())) {
    return { command: process.execPath, args: [npmExecPath] }
  }
  return { command: npmExecPath, args: [] }
}
