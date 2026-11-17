// Install the Starter into an isolated Headless profile of real DSH and verify its tools, settings and disabled state.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { STARTER_COMPONENT_ROWS, STARTER_ENHANCEMENT_PACKAGES } from '../src/host/contracts/starter-components.ts'
import { workspaceStorageId } from '../src/sdk/workspace-storage.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePatches = loadOverlayPatches('dsh', join(root, 'cordis.patch.yml'))
const declaredGroup = composeEntries([bundlePatches.filter(patch => patch.insert !== undefined)]).find(row => row.id === 'mnemon-bundle')
const visibleRows = declaredGroup?.config.filter(row => !row.group)
if (visibleRows?.length !== 1 || visibleRows[0]?.id !== 'mnemon') {
  throw new Error('DSH bundle inventory should only list the MnemoWeave host')
}
const runtimeGroup = composeEntries([bundlePatches]).find(row => row.id === 'mnemon-bundle')
for (const { rowId, packageName } of STARTER_COMPONENT_ROWS) {
  if (!runtimeGroup?.config.some(row => row.id === rowId && row.name === packageName && !row.group)) {
    throw new Error('MnemoWeave runtime profile is missing component ' + rowId)
  }
}
// Set MNEMON_E2E_DSH to another DSH installation's lib/bin.js to verify Headless on that release.
const dshBin = process.env.MNEMON_E2E_DSH ? resolve(process.env.MNEMON_E2E_DSH) : join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const marker = 'HEADLESS_MNEMON_READY'
const upgradeMemoryMarker = 'Synthetic upgrade fixture: project checkpoints stay in SQLite.'
const arguments_ = process.argv.slice(2)
const options = new Map()
for (let index = 0; index < arguments_.length; index += 2) {
  if (!['--package', '--registry', '--strategy-extensions', '--upgrade-from', '--upgrade-registry'].includes(arguments_[index]) || !arguments_[index + 1]) throw new Error('Expected package, registry, upgrade, and/or strategy-extension options in key/value pairs')
  options.set(arguments_[index], arguments_[index + 1])
}
if (options.has('--package') !== options.has('--registry')) throw new Error('--package and --registry must be supplied together')
if (options.has('--upgrade-from') !== options.has('--upgrade-registry')) throw new Error('--upgrade-from and --upgrade-registry must be supplied together')
if (options.has('--upgrade-from') && !options.has('--package')) throw new Error('--upgrade-from requires a target --package')
if (options.has('--strategy-extensions') && options.get('--strategy-extensions') !== 'true') throw new Error('--strategy-extensions expects true')
const extensionNames = STARTER_ENHANCEMENT_PACKAGES
const extensionNameSet = new Set(extensionNames)
const extensionsEnabled = options.has('--strategy-extensions')

function run(args, { cwd = root, env = process.env, timeoutMs = 30_000 } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [dshBin, ...args], {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`dsh Headless verification timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timeout)
      resolveRun({ code, signal, stdout, stderr })
    })
  })
}

function assertSuccess(label, result) {
  if (result.code === 0) return
  throw new Error([
    `${label} failed with code ${String(result.code)}${result.signal === null ? '' : ` (${result.signal})`}`,
    result.stdout.trim(),
    result.stderr.trim(),
  ].filter(Boolean).join('\n'))
}

const requests = []
let nextMemoryTool
const server = createServer(async (request, response) => {
  try {
    let body = ''
    request.setEncoding('utf8')
    for await (const chunk of request) body += chunk
    requests.push(JSON.parse(body))
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    // DSH's DeepSeek adapter speaks the Messages streaming protocol.
    const model = requests.at(-1).model
    const event = value => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
    event({ type: 'message_start', message: { id: `msg-${requests.length}`, type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 10, output_tokens: 0 } } })
    const tool = nextMemoryTool
    nextMemoryTool = undefined
    if (tool === undefined) {
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: marker } })
    } else {
      event({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_mnemo_' + requests.length, name: tool.name, input: {} } })
      event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } })
    }
    event({ type: 'content_block_stop', index: 0 })
    event({ type: 'message_delta', delta: { stop_reason: tool === undefined ? 'end_turn' : 'tool_use' }, usage: { output_tokens: 3 } })
    event({ type: 'message_stop' })
    response.end()
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }))
  }
})

const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-mnemon-headless-'))
const dshHome = join(temporaryRoot, 'dsh-home')
const storageRoot = join(temporaryRoot, 'mnemon-data')
const workspaceRoot = join(temporaryRoot, 'workspace')
await Promise.all([mkdir(dshHome), mkdir(storageRoot), mkdir(workspaceRoot)])

try {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock DeepSeek server did not expose a TCP port')
  const env = {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_API_KEY: 'headless-verification-key',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
    MNEMON_DATA_DIR: storageRoot,
    ...(options.has('--registry') ? { npm_config_registry: options.get('--registry'), NPM_CONFIG_REGISTRY: options.get('--registry') } : {}),
  }


  let upgradeMemory
  if (options.has('--upgrade-from')) {
    const initialInstall = await run(['plugin', '--profile', 'headless', 'add', options.get('--upgrade-from'), '--registry', options.get('--upgrade-registry')], { env, timeoutMs: 120_000 })
    assertSuccess(`installing ${options.get('--upgrade-from')} before the upgrade`, initialInstall)
    const initialExecution = await run(['--profile', 'headless', 'Initialize isolated memory before upgrading Mnemon.'], { cwd: workspaceRoot, env })
    assertSuccess('running the pre-upgrade Headless profile', initialExecution)
    if (!initialExecution.stdout.includes(marker)) throw new Error(`Pre-upgrade Headless output did not contain ${marker}:\n${initialExecution.stdout}`)
    const memoryPath = join(storageRoot, 'runtime', 'memories.json')
    const memory = JSON.parse(await readFile(memoryPath, 'utf8'))
    memory.entries.push({ content: upgradeMemoryMarker, target: 'memory', importance: 'normal',
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' })
    await writeFile(memoryPath, JSON.stringify(memory, null, 2) + '\n')
    requests.length = 0
    const seededExecution = await run(['--profile', 'headless', 'Verify the retained synthetic project memory before upgrading.'], { cwd: workspaceRoot, env })
    assertSuccess('reading synthetic memory on the pre-upgrade Headless profile', seededExecution)
    if (!JSON.stringify(requests).includes(upgradeMemoryMarker)) throw new Error('Pre-upgrade Headless did not read the synthetic Runtime entry')
    upgradeMemory = await readFile(memoryPath, 'utf8')
    requests.length = 0
  }

  // link: skips dependency installation. Explicitly link the same plugin set
  // that a normal install resolves from the Starter's semver dependencies.
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  // Root owns the disabled enhancement Entries. Adding their self-registering
  // bundles as separate Profile layers would intentionally duplicate ids.
  const plugins = Object.keys(manifest.dependencies).filter(name => name.startsWith('dsh-mnemo-weave-') && !extensionNameSet.has(name))
  const packages = options.has('--package')
    ? [options.get('--package')]
    : [`link:${root}`, ...plugins.map(name => `link:${join(root, 'plugins', name)}`)]
  const install = await run(['plugin', '--profile', 'headless', 'add', ...packages,
    ...(options.has('--registry') ? ['--registry', options.get('--registry')] : []),
  ], { env, timeoutMs: 120_000 })
  assertSuccess('installing dsh-mnemo-weave into the Headless profile', install)

  // The verification exercises Mnemon composition, not DSH's native PTY
  // transport. Disable the unrelated shell stack so the check remains
  // hermetic on CI Node/platform combinations without a node-pty prebuild.
  const profilePatchPath = join(dshHome, 'profiles', 'headless', 'cordis.patch.yml')
  const profileOverrides = `
- id: subprocess
  disabled: true
- id: bash-sandbox
  disabled: true
- id: pwsh-sandbox
  disabled: true
- id: tool-bash
  disabled: true
- id: tool-pwsh
  disabled: true
- id: permission
  disabled: true
- id: tool-fs-search
  disabled: true
- id: ptc-runtime
  disabled: true
- id: workflow-ptc
  disabled: true
- id: tool-workflow
  disabled: true
`.trimStart() + (!extensionsEnabled ? '' : STARTER_COMPONENT_ROWS.filter(row => extensionNameSet.has(row.packageName)).map(row =>
    `- id: ${row.rowId}\n  disabled: false\n`,
  ).join(''))
  await writeFile(profilePatchPath, profileOverrides)

  if (extensionsEnabled) {
    // Active capture records through Memory Spaces' remember Action, which a View
    // offers only while a Provider can take writes. Without a Mnemon CLI, as on CI,
    // connect the bundled local Holographic Provider so the contribution has a target.
    await mkdir(join(storageRoot, 'state'), { recursive: true })
    await writeFile(join(storageRoot, 'state', 'memory-providers.json'), `${JSON.stringify({
      version: 4, services: { holographic: { dataPath: join(storageRoot, 'holographic-facts.json') } }, enabled: { holographic: true }, bodies: [],
    })}\n`, { mode: 0o600 })
  }

  const execution = await run(['--profile', 'headless', 'Verify that the Mnemon tool surface is available.'], {
    cwd: workspaceRoot,
    env,
  })
  assertSuccess('running the Headless profile', execution)
  if (!execution.stdout.includes(marker)) throw new Error(`Headless output did not contain ${marker}:\n${execution.stdout}`)

  const toolRequest = requests.find(request => Array.isArray(request.tools) && request.tools.length > 0)
  if (toolRequest === undefined) throw new Error('Headless model request did not expose any tools')
  const toolNames = new Set(toolRequest.tools.map(tool => tool?.name).filter(name => typeof name === 'string'))
  if ([...toolNames].some(name => name.startsWith('mnemon_'))) throw new Error('Headless still exposes legacy mnemon_ tool names')
  for (const name of ['mnemo_document_create', 'mnemo_view_route', 'mnemo_view_action']) {
    if (toolNames.has(name)) throw new Error('Headless still exposes the retired tool ' + name)
  }
  const required = ['mnemo_status', 'mnemo_recall', 'mnemo_document_search', 'mnemo_document_manage', 'mnemo_runtime_memory', 'mnemo_remember']
  const missing = required.filter(name => !toolNames.has(name))
  if (missing.length > 0) throw new Error(`Headless model request is missing Mnemon tools: ${missing.join(', ')}`)
  // SystemPrompt sorts wire schemas lexicographically by default; registry
  // insertion order is checked separately by the Host-first bootstrap tests.
  const mnemonWireOrder = [
    'mnemo_document_manage', 'mnemo_document_search', 'mnemo_forget', 'mnemo_link',
    'mnemo_memory_bodies', 'mnemo_memory_body_create', 'mnemo_memory_body_merge', 'mnemo_memory_body_update',
    'mnemo_recall', 'mnemo_related', 'mnemo_remember', 'mnemo_runtime_memory', 'mnemo_status',
    'mnemo_subagent_result',
  ]
  const mnemonOrder = toolRequest.tools.map(tool => tool?.name).filter(name => typeof name === 'string' && name.startsWith('mnemo_'))
  if (JSON.stringify(mnemonOrder) !== JSON.stringify(mnemonWireOrder)) throw new Error(`Headless Mnemon wire tool order changed: ${mnemonOrder.join(', ')}`)
  if (extensionsEnabled) {
    const prompt = JSON.stringify([toolRequest.system, toolRequest.messages])
    for (const expected of ['MNEMON OPTIONAL AUTO CAPTURE']) {
      if (!prompt.includes(expected)) throw new Error(`Optional Strategy contribution did not reach the real DSH prompt: ${expected}`)
    }
  }
  const rulesDirectory = join(storageRoot, 'working-rules', 'runtime')
  if (!existsSync(join(rulesDirectory, 'memories.json')) || !existsSync(join(rulesDirectory, '工作准则.md'))) throw new Error('Headless plugin did not initialize isolated Working Rules')
  if (!JSON.stringify(toolRequest).includes('工作准则.md')) throw new Error('Working Rules did not reach the real DSH prompt')
  if (upgradeMemory !== undefined && await readFile(join(storageRoot, 'runtime', 'memories.json'), 'utf8') !== upgradeMemory) throw new Error('Package upgrade changed existing Runtime Memory bytes')
  if (upgradeMemory !== undefined && !JSON.stringify(toolRequest).includes(upgradeMemoryMarker)) throw new Error('Upgraded Headless did not read the retained synthetic Runtime entry')

  const privateQuery = 'Synthetic private query for activity verification'
  nextMemoryTool = { name: 'mnemo_document_search', input: { query: privateQuery } }
  assertSuccess('running the document search activity fixture', await run(['--profile', 'headless', 'Search the synthetic documents.'], { cwd: workspaceRoot, env }))
  const privateRule = 'Synthetic private rule for activity verification'
  nextMemoryTool = { name: 'mnemo_runtime_memory', input: { action: 'add', content: privateRule } }
  assertSuccess('running the memory write activity fixture', await run(['--profile', 'headless', 'Save the synthetic rule.'], { cwd: workspaceRoot, env }))
  const activityDirectory = join(storageRoot, 'state', 'activity', 'workspaces', workspaceStorageId(workspaceRoot), 'events')
  const activityFiles = await readdir(activityDirectory)
  const activityText = await Promise.all(activityFiles.map(name => readFile(join(activityDirectory, name), 'utf8')))
  const activity = activityText.map(value => JSON.parse(value))
  if (!activity.some(event => event.operation === 'search' && ['empty', 'returned'].includes(event.outcome))
    || !activity.some(event => event.operation === 'mutate' && event.outcome === 'committed')) {
    throw new Error('DSH did not record recall and committed write outcomes: ' + JSON.stringify(activity))
  }
  if (activityText.some(value => value.includes(privateQuery) || value.includes(privateRule))) throw new Error('Activity includes private source text')

  requests.length = 0
  await writeFile(profilePatchPath, profileOverrides + '- id: mnemon-source-documents\n  disabled: true\n')
  const documentsDisabled = await run(['--profile', 'headless', 'Verify that the documents source is disabled.'], { cwd: workspaceRoot, env })
  assertSuccess('running with the documents component disabled', documentsDisabled)
  const disabledSourceTools = requests.find(request => Array.isArray(request.tools) && request.tools.length > 0)?.tools ?? []
  if (disabledSourceTools.some(tool => tool.name.startsWith('mnemo_document_')) || !disabledSourceTools.some(tool => tool.name === 'mnemo_runtime_memory')) {
    throw new Error('The existing profile ID should disable document tools while leaving Working Rules active: ' + disabledSourceTools.map(tool => tool.name).join(', '))
  }

  requests.length = 0
  await writeFile(profilePatchPath, profileOverrides + '- id: mnemon\n  disabled: true\n')
  const disabledExecution = await run(['--profile', 'headless', 'Verify that disabling Mnemon leaves the Host available.'], {
    cwd: workspaceRoot,
    env,
  })
  assertSuccess('running Headless with the Mnemon Starter disabled', disabledExecution)
  if (!disabledExecution.stdout.includes(marker)) throw new Error('Mnemon-disabled Headless output did not contain the model marker')
  const pendingEntries = disabledExecution.stderr.split(/\r?\n/u).filter(line => line.includes('waiting for service:'))
  if (pendingEntries.length > 0) throw new Error(`Mnemon-disabled Headless left dependent Entries pending:\n${pendingEntries.join('\n')}`)
  const disabledToolNames = new Set(requests.flatMap(request => Array.isArray(request.tools)
    ? request.tools.map(tool => tool?.name).filter(name => typeof name === 'string')
    : []))
  const leakedMnemonTools = [...disabledToolNames].filter(name => name.startsWith('mnemo_')).sort()
  if (leakedMnemonTools.length > 0) throw new Error(`Mnemon-disabled Headless exposed Mnemon tools: ${leakedMnemonTools.join(', ')}`)

  console.log(`Verified Headless profile activation with ${toolNames.size} total tools and ${required.length} representative Mnemon tools.`)
  if (options.has('--upgrade-from')) console.log(`Verified an isolated ${options.get('--upgrade-from')} to ${options.get('--package')} package upgrade without changing Runtime Memory bytes.`)
  console.log('Verified that disabling the legacy mnemon Entry disables the complete Starter without blocking DSH startup.')
  if (extensionsEnabled) console.log('Verified activation of the auto-capture Entry without changing the default Strategy.')
} finally {
  await new Promise(resolveClose => server.close(resolveClose))
  await rm(temporaryRoot, { recursive: true, force: true })
}
