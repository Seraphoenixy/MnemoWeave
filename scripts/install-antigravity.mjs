import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const VALID_STORAGE_SCOPES = new Set(['global', 'workspace', 'custom', 'workspaces'])

export function defaultAntigravityPluginDir(homeDir = homedir()) {
  return join(homeDir, '.gemini', 'config', 'plugins', 'mnemo-weave')
}

export function ensureAntigravityBuild(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'))
  const mcpEntry = resolve(repoRoot, 'dist', 'mnemo-weave-mcp.js')
  if (options.skipBuild || (!options.forceBuild && existsSync(mcpEntry))) {
    return mcpEntry
  }

  if (!existsSync(join(repoRoot, 'node_modules'))) {
    const installResult = spawnSync('pnpm', ['install', '--frozen-lockfile'], {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    if (installResult.status !== 0) {
      throw new Error(`"pnpm install --frozen-lockfile" failed with exit code ${installResult.status ?? 1}.`)
    }
  }

  const buildResult = spawnSync('pnpm', ['build'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (buildResult.status !== 0) {
    throw new Error(`"pnpm build" failed with exit code ${buildResult.status ?? 1}.`)
  }
  return mcpEntry
}

export function buildAntigravityMcpConfig(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'))
  const mcpEntry = resolve(repoRoot, 'dist', 'mnemo-weave-mcp.js')
  if (!existsSync(mcpEntry)) {
    throw new Error(`Missing built MCP entry at ${mcpEntry}. Run "pnpm build" first.`)
  }

  const args = [mcpEntry.replaceAll('\\', '/')]

  if (options.storageScope !== undefined) {
    if (!VALID_STORAGE_SCOPES.has(options.storageScope)) {
      throw new Error(`Invalid --storage-scope "${options.storageScope}". Expected one of: global, workspace, custom, workspaces.`)
    }
    args.push('--storage-scope', options.storageScope)
  }

  if (options.storageScope === 'custom' && (options.storageDir === undefined || options.storageDir.trim() === '')) {
    throw new Error('--storage-dir is required when --storage-scope is custom.')
  }

  if (options.storageDir !== undefined && options.storageDir.trim() !== '') {
    args.push('--storage-dir', resolve(options.storageDir).replaceAll('\\', '/'))
  }

  if (options.workspace !== undefined && options.workspace.trim() !== '') {
    args.push('--workspace', resolve(options.workspace).replaceAll('\\', '/'))
  }

  if (options.dataDir !== undefined && options.dataDir.trim() !== '') {
    if (!isAbsolute(options.dataDir)) {
      throw new Error('--data-dir must be an absolute legacy workspace memory directory.')
    }
    args.push('--data-dir', resolve(options.dataDir).replaceAll('\\', '/'))
  }

  const env = {}
  if (options.syncUrl !== undefined && options.syncUrl.trim() !== '') {
    env.MNEMOWEAVE_SYNC_URL = options.syncUrl.trim()
  }
  if (options.syncPassword !== undefined && options.syncPassword.trim() !== '') {
    env.MNEMOWEAVE_SYNC_PASSWORD = options.syncPassword.trim()
  }

  const serverConfig = {
    command: 'node',
    args,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  }

  return {
    mcpServers: {
      mnemo_weave: serverConfig,
    },
  }
}

export function installAntigravityPlugin(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'))
  if (options.build) {
    ensureAntigravityBuild({ repoRoot, forceBuild: true })
  }
  const sourceDir = join(repoRoot, 'integrations', 'antigravity')
  const targetDir = resolve(options.target ?? defaultAntigravityPluginDir())
  const mcpConfig = buildAntigravityMcpConfig({ ...options, repoRoot })

  if (options.dryRun) {
    return { targetDir, mcpConfig, dryRun: true }
  }

  mkdirSync(targetDir, { recursive: true })
  for (const relativePath of ['plugin.json', 'rules', 'skills']) {
    cpSync(join(sourceDir, relativePath), join(targetDir, relativePath), { recursive: true, force: true })
  }
  writeFileSync(join(targetDir, 'mcp_config.json'), `${JSON.stringify(mcpConfig, null, 2)}\n`, 'utf8')

  return { targetDir, mcpConfig, dryRun: false }
}

function printHelp() {
  console.log(`Usage: node scripts/install-antigravity.mjs [options]

Options:
  --target <path>           Plugin destination (default: ~/.gemini/config/plugins/mnemo-weave)
  --storage-scope <scope>   global | workspace | custom | workspaces
  --storage-dir <path>      Storage directory (required for custom, root for workspaces)
  --workspace <path>        Explicit workspace root passed to mnemo-weave-mcp.js
  --data-dir <path>         Absolute legacy workspace memory directory to migrate on startup
  --sync-url <url>          Optional MNEMOWEAVE_SYNC_URL written to mcp_config.json env
  --sync-password <secret>  Optional MNEMOWEAVE_SYNC_PASSWORD written to mcp_config.json env
  --build                   Force running "pnpm build" before installing
  --no-build                Skip automatic build even when dist/mnemo-weave-mcp.js is missing
  --dry-run                 Print target directory and generated mcp_config.json without writing
  -h, --help                Show this help message`)
}

function main() {
  const { values } = parseArgs({
    options: {
      target: { type: 'string' },
      'storage-scope': { type: 'string' },
      'storage-dir': { type: 'string' },
      workspace: { type: 'string' },
      'data-dir': { type: 'string' },
      'sync-url': { type: 'string' },
      'sync-password': { type: 'string' },
      build: { type: 'boolean', default: false },
      'no-build': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })

  if (values.help) {
    printHelp()
    return
  }

  ensureAntigravityBuild({
    forceBuild: values.build,
    skipBuild: values['no-build'] || values['dry-run'],
  })

  const result = installAntigravityPlugin({
    target: values.target,
    storageScope: values['storage-scope'],
    storageDir: values['storage-dir'],
    workspace: values.workspace,
    dataDir: values['data-dir'],
    syncUrl: values['sync-url'],
    syncPassword: values['sync-password'],
    dryRun: values['dry-run'],
  })

  if (result.dryRun) {
    console.log(`Dry run target: ${result.targetDir}`)
    console.log(JSON.stringify(result.mcpConfig, null, 2))
    return
  }

  console.log(`Installed Antigravity plugin to ${result.targetDir}`)
  console.log(`MCP server entry: ${result.mcpConfig.mcpServers.mnemo_weave.args[0]}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
