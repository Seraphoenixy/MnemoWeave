// Exercise shipped Web presets with local synthetic model choices and disposable data.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node verify-web-profile.mjs DSH_PACKAGE_ROOT OUTPUT_JSON [PACKED_STARTER REGISTRY]')
const dsh = await realpath(resolve(process.argv[2]))
const output = resolve(process.argv[3])
const packedStarter = process.argv[4]
const registry = process.argv[5]
if (Boolean(packedStarter) !== Boolean(registry)) throw new Error('A packed Starter requires its candidate registry')
const require = createRequire(join(dsh, 'package.json'))
const load = name => import(pathToFileURL(require.resolve(name)).href)
const originalDirectory = process.cwd()
const verifyDistillation = process.env.MNEMO_VERIFY_DISTILLATION === '1'
const temporary = await mkdtemp(join(tmpdir(), 'mnemon-current-dsh-web-'))
const home = join(temporary, 'home'), workspace = join(temporary, 'workspace'), data = join(temporary, 'data')
await Promise.all([home, workspace, data].map(path => mkdir(path)))
const rule = 'Synthetic standing rule: use the Cedar verification profile and keep {{fixture}} literal.'
const rulesDirectory = join(data, 'working-rules', 'runtime')
await mkdir(rulesDirectory, { recursive: true })
await writeFile(join(rulesDirectory, 'memories.json'), JSON.stringify({
  version: 1,
  entries: [{ target: 'memory', content: rule, importance: 'normal', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }],
}))
const env = { ...process.env, DSH_HOME: home, MNEMON_DATA_DIR: data, DSH_TELEMETRY_DISABLED: '1',
  DEEPSEEK_API_KEY: 'synthetic-no-api', DEEPSEEK_BASE_URL: 'http://127.0.0.1:1', MNEMON_EMBED_ENDPOINT: '' }
delete env.NODE_PATH
Object.assign(process.env, env)
delete process.env.NODE_PATH
process.chdir(workspace)
let ctx
try {
  let runNative
  if (verifyDistillation) {
    const { findMnemonCommand, resolveMnemonInvocation } = await import('../../src/components/source-memory-spaces/src/native-cli.ts')
    const command = findMnemonCommand({}, { env })
    assert(command, 'Mnemon Native CLI is required for the distillation fixture')
    runNative = args => {
      const invocation = resolveMnemonInvocation(command, ['--data-dir', data, ...args], env)
      const result = spawnSync(invocation.command, invocation.args, { env: invocation.env, encoding: 'utf8', windowsHide: true })
      assert.equal(result.status, 0, result.stderr || String(result.error))
    }
    runNative(['store', 'create', 'fixture'])
  }
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  await new Promise((resolveInstall, reject) => {
    const packages = packedStarter ? [packedStarter, '--registry', registry] : [`link:${root}`]
    const child = spawn(process.execPath, [join(dsh, 'lib/bin.js'), 'plugin', '--profile', 'web', 'add', ...packages],
      { env, cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    child.stdout.on('data', chunk => { log += chunk })
    child.stderr.on('data', chunk => { log += chunk })
    const timer = setTimeout(() => child.kill('SIGTERM'), 60_000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolveInstall() : reject(new Error(`Disposable profile install failed: ${log}`)) })
  })
  await writeFile(join(home, 'profiles/web/cordis.patch.yml'), '- id: directory-picker\n  disabled: true\n'
    + (verifyDistillation ? '- id: permission\n  disabled: true\n' : '')
    + '- id: mnemon\n  config:\n    idleReview:\n      enabled: ' + verifyDistillation + '\n      minIntervalMs: 5000\n    idleReviewMs: 5000\n'
    + (verifyDistillation ? '    taskAgentModel:\n      mode: fixed\n      provider: fixture\n      model: fixture\n' : ''))
  const { createLaunchEnvironmentSnapshot } = await load('@deepseek-ai/dsh-launch-environment')
  const { runProfile } = await import(pathToFileURL(join(dsh, 'lib/profile-boot.js')).href)
  const { LlmAdapter, createUserMessage } = await load('@deepseek-ai/dsh-llm')
  ;({ ctx } = await runProfile({ environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: env }]),
    profile: 'web', patchFiles: [], args: ['--no-open', '--host', '127.0.0.1', '--port', '0'] }))
  const clientEntries = ctx.clientModules.graph().entries
  for (const name of Object.keys(manifest.dependencies).filter(name => name.startsWith('dsh-mnemo-weave-source-'))) {
    const entry = clientEntries.find(row => row.id === name)
    assert(entry?.external.includes(`${manifest.name}/client`), `Web profile is missing the Source client for ${name}`)
  }
  const observations = []
  const lesson = 'Synthetic lease E734 diagnosis: compare the lease epoch with the worker epoch before restarting the worker.'
  const correctedLesson = 'Synthetic lease E734 diagnosis: compare the lease epoch with the coordinator epoch. Worker epochs never identify this failure.'
  const distillationRequests = []
  let previousInsightId
  let secondWorkspaceId
  let legacyArchivePath
  const archiveBody = 'Archived original: the worker epoch was recorded in the legacy handoff.'
  if (verifyDistillation) {
    const other = join(temporary, 'other-workspace')
    await mkdir(other)
    const otherWorkspace = await ctx.workspaceRegistry.create(other)
    secondWorkspaceId = otherWorkspace.id
    const documents = []
    for (const [location, content, status] of [
      [workspace, 'Shared-key first workspace record', 'active'],
      [otherWorkspace.path, 'Shared-key second workspace record', 'active'],
      [workspace, archiveBody, 'archived'],
    ]) {
      const id = String(documents.length + 1).repeat(8)
      const filename = 'fixture-' + id + '.md'
      const relativePath = 'documents/' + status + '/' + filename
      const markdown = '---\nid: "' + id + '"\n---\n\n' + content + '\n'
      await mkdir(join(data, 'documents', status), { recursive: true })
      await writeFile(join(data, relativePath), markdown)
      const contentHash = createHash('sha256').update(content).digest('hex')
      const timestamp = new Date().toISOString()
      if (status === 'archived') {
        legacyArchivePath = '.mnemon/' + relativePath
        runNative(['--store', 'fixture', 'remember', `ColdindexZ91 document ${legacyArchivePath} SHA-256 ${contentHash}`])
      }
      documents.push({ id, title: status === 'archived' ? 'Legacy archived fixture' : content,
        description: '', status, filename, relativePath: status === 'archived' ? legacyArchivePath : relativePath,
        workspaceRoot: location, sourcePaths: [], sessionIds: [], createdAt: timestamp, updatedAt: timestamp,
        lastAccessedAt: timestamp, revision: 1, contentHash, sizeBytes: Buffer.byteLength(markdown),
        memoryBodyIds: status === 'archived' ? ['fixture'] : [] })
    }
    await writeFile(join(data, 'documents', 'index.json'), JSON.stringify({ version: 1, documents }))
  }
  if (verifyDistillation) ctx.tools.register({
    name: 'fixture_diagnose_lease', description: 'Inspect a synthetic worker lease.',
    parameters: { type: 'object', properties: { check: { type: 'string' } }, required: ['check'] },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute({ check }) {
      if (check === 'status') throw new Error('Synthetic lease E734: worker rejected a stale lease')
      if (check === 'routine') return 'Routine check passed.'
      return 'Lease epoch 1 differs from worker epoch 2. Renewing the lease resolves E734.'
    },
  })
  async function* fixtureReply(text, tool) {
    if (tool) {
      const { name, args, id } = tool
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  class Adapter extends LlmAdapter {
    async *stream(options) {
      const context = JSON.stringify([options.system, options.messages])
      const prior = observations.filter(item => item.id === options.sessionId).length
      const tools = (options.tools ?? []).map(tool => tool.name)
      if (verifyDistillation && context.includes('[dsh-mnemo-weave:delegated review]')) {
        const step = distillationRequests.length
        distillationRequests.push({ context, tools })
        const requestId = /requestId `([a-f0-9-]+)`/u.exec(context)?.[1]
        if (context.includes('The coordinator check supersedes the earlier lesson.')) {
          if (!context.includes('synthetic-revision-recall')) {
            yield* fixtureReply('', { name: 'mnemo_recall', args: { query: 'Synthetic lease E734', mode: 'keyword' }, id: 'synthetic-revision-recall' })
          } else if (!context.includes('synthetic-revision-write')) {
            yield* fixtureReply('', { name: 'mnemo_remember', args: { content: correctedLesson, memoryBodyId: 'fixture', replacesId: previousInsightId }, id: 'synthetic-revision-write' })
          } else if (requestId && !context.includes('synthetic-revision-done')) {
            yield* fixtureReply('', { name: 'mnemo_subagent_result', args: { requestId, result: { action: 'updated', summary: 'Synthetic revision', memoryBodyIds: [] } }, id: 'synthetic-revision-done' })
          } else yield* fixtureReply('Synthetic revision complete.')
          return
        }
        const alreadyCalled = context.includes('synthetic-distill-write')
        const retry = context.includes('Retry this synthetic memory checkpoint.')
        if (!alreadyCalled && tools.includes('mnemo_remember')) {
          yield* fixtureReply('', { name: 'mnemo_remember', args: { content: lesson, memoryBodyId: 'fixture' }, id: 'synthetic-distill-write' })
        } else if (requestId && tools.includes('mnemo_subagent_result') && !context.includes('synthetic-distill-result')) {
          const action = alreadyCalled && !retry ? 'failed' : 'skipped'
          yield* fixtureReply('', { name: 'mnemo_subagent_result', args: { requestId, result: { action, summary: 'Synthetic distillation', memoryBodyIds: [] } }, id: 'synthetic-distill-result' })
        } else yield* fixtureReply('Synthetic distillation complete.')
        return
      }
      if (verifyDistillation && options.sessionId === 'synthetic-distillation') {
        if (!context.includes('synthetic-lease-status')) {
          yield* fixtureReply('', { name: 'fixture_diagnose_lease', args: { check: 'status' }, id: 'synthetic-lease-status' })
        } else if (!context.includes('synthetic-lease-epoch')) {
          yield* fixtureReply('', { name: 'fixture_diagnose_lease', args: { check: 'epoch' }, id: 'synthetic-lease-epoch' })
        } else yield* fixtureReply(lesson)
        return
      }
      if (verifyDistillation && options.sessionId === 'synthetic-routine-check') {
        if (!context.includes('synthetic-routine-result')) {
          yield* fixtureReply('', { name: 'fixture_diagnose_lease', args: { check: 'routine' }, id: 'synthetic-routine-result' })
        } else yield* fixtureReply('Routine verification completed.')
        return
      }
      if (verifyDistillation && options.sessionId === 'synthetic-distillation-revise') {
        yield* fixtureReply(correctedLesson)
        return
      }
      if (verifyDistillation && options.sessionId?.startsWith('synthetic-document-scope-')) {
        if (context.includes('synthetic-document-query')) yield* fixtureReply('Document search complete.')
        else {
          const input = options.sessionId.endsWith('-other') ? { query: 'Shared-key', workspaceId: secondWorkspaceId } : { query: 'Shared-key' }
          yield* fixtureReply('', { name: 'mnemo_document_search', args: input, id: 'synthetic-document-query' })
        }
        return
      }
      if (verifyDistillation && options.sessionId === 'synthetic-legacy-archive') {
        if (!context.includes('synthetic-cold-index')) {
          yield* fixtureReply('', { name: 'mnemo_recall', args: { query: 'ColdindexZ91', mode: 'keyword' }, id: 'synthetic-cold-index' })
        } else if (!context.includes('synthetic-cold-original')) {
          yield* fixtureReply('', { name: 'mnemo_document_search', args: { query: legacyArchivePath, includeArchived: true }, id: 'synthetic-cold-original' })
        } else yield* fixtureReply('Legacy original found.')
        return
      }
      if (verifyDistillation && options.sessionId?.startsWith('synthetic-distillation-recall')) {
        if (context.includes('tool_use_id') || context.includes('synthetic-distill-recall')) yield* fixtureReply('Synthetic recall complete.')
        else yield* fixtureReply('', { name: 'mnemo_recall', args: { query: 'Synthetic lease E734', mode: 'keyword' }, id: 'synthetic-distill-recall' })
        return
      }
      if (tools.length > 0) {
        const messages = JSON.stringify(options.messages)
        const system = JSON.stringify(options.messages.filter(message => message.role === 'system'))
        const conversation = JSON.stringify(options.messages.filter(message => message.role !== 'system'))
        observations.push({ id: options.sessionId, tools, workingRulesInSystem: system.split(rule).length === 2,
          workingRulesInMessages: conversation.includes(rule),
          wake: messages.includes('MNEMON VIEW TOOLS'),
          reminder: options.messages.some(message => message.source?.form === 'instructions'
            && JSON.stringify(message.content).includes('[dsh-mnemo-weave]')) })
      }
      if (tools.length > 0 && prior < 2) {
        const name = tools.includes('run_code') ? 'run_code' : prior === 0 ? 'mnemo_status' : 'mnemo_document_search'
        const args = name === 'run_code' ? { description: 'Synthetic read', code: prior === 0
          ? 'return await tools.mnemo_status({})' : 'return await tools.mnemo_document_search({query:"synthetic"})' } : prior === 0 ? {} : { query: 'synthetic' }
        const id = `synthetic-${options.sessionId}-${prior}`
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        const text = 'Synthetic reads complete.'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Adapter())
  const presets = []
  for (const preset of ['standard', 'ptc']) {
    const handle = await ctx.agents.create({ sessionId: 'synthetic-' + preset, meta: { cwd: workspace, agentPreset: preset },
      agentOptions: { provider: 'fixture', model: 'fixture' }, setup: async scoped => { await ctx.agentPresets.mount(scoped, preset) } })
    try {
      const agent = handle.agent
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read synthetic status and documents.' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      const requests = observations.filter(item => item.id === agent.id)
      const events = agent.session.snapshotEvents()
      const errors = events.filter(event => event.type === 'tool/result').map(event => event.data.message.isError)
      assert.equal(requests.length, 3)
      assert(requests.every(request => request.workingRulesInSystem && !request.workingRulesInMessages && request.wake && !request.reminder), JSON.stringify(requests))
      assert.deepEqual(errors, [false, false])
      assert(events.some(event => event.type === 'turn/end'))
      assert(requests.every(request => preset === 'ptc' ? request.tools.includes('run_code')
        : request.tools.includes('mnemo_status') && request.tools.includes('mnemo_document_search')))
      presets.push({ preset, modelRequests: requests.length, workingRulesInSystem: true, wake: true, duplicateReminder: false,
        toolsRead: ['mnemo_status', 'mnemo_document_search'], toolErrors: errors, completedTurn: true })
    } finally { await handle.dispose() }
  }
  if (verifyDistillation) {
    const createAgent = sessionId => ctx.agents.create({ sessionId, meta: { cwd: workspace, agentPreset: 'standard' },
      agentOptions: { provider: 'fixture', model: 'fixture' }, setup: async scoped => { await ctx.agentPresets.mount(scoped, 'standard') } })
    const send = async (agent, text) => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    }
    const waitForRequest = async predicate => {
      const deadline = Date.now() + 25_000
      while (Date.now() < deadline) {
        const request = distillationRequests.find(predicate)
        if (request) return request
        await new Promise(resolveWait => setTimeout(resolveWait, 200))
      }
    }
    const handle = await createAgent('synthetic-distillation')
    const routine = await createAgent('synthetic-routine-check')
    try {
      const archive = await createAgent('synthetic-legacy-archive')
      try {
        await send(archive.agent, 'Read the original document referenced by ColdindexZ91.')
        const responses = archive.agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
        for (const [callId, expected] of [['synthetic-cold-index', legacyArchivePath], ['synthetic-cold-original', archiveBody]]) {
          const message = responses.find(event => event.data.message.source?.callId === callId)?.data.message
          assert(message && message.isError === false && JSON.stringify(message.content).includes(expected), JSON.stringify(message?.content))
        }
      } finally { await archive.dispose() }
      for (const [scope, included, excluded] of [['local', 'first', 'second'], ['other', 'second', 'first']]) {
        const doc = await createAgent('synthetic-document-scope-' + scope)
        try {
          await send(doc.agent, scope === 'other' ? 'Search Shared-key in workspace ' + secondWorkspaceId : 'Search Shared-key in the current workspace.')
          const event = doc.agent.session.snapshotEvents().find(event => event.type === 'tool/result'
            && event.data.message.source?.callId === 'synthetic-document-query')
          const output = JSON.stringify(event?.data.message.content)
          assert(event?.data.message.isError === false, output)
          assert(output.includes('Shared-key ' + included + ' workspace record'))
          assert(!output.includes('Shared-key ' + excluded + ' workspace record'))
        } finally { await doc.dispose() }
      }
      await send(routine.agent, 'Run the routine validation.')
      await send(handle.agent, 'Diagnose the synthetic lease error.')
      const events = handle.agent.session.snapshotEvents()
      assert(!events.some(event => event.type === 'tool/call' && event.data.name === 'mnemo_remember'))
      assert.deepEqual(events.filter(event => event.type === 'tool/result'
        && event.data.message.source?.callId?.startsWith('synthetic-lease-')).map(event => event.data.message.isError), [true, false])
      const committed = await waitForRequest(request => request.context.includes('committedAt'))
      assert(distillationRequests[0]?.tools.includes('mnemo_remember'), 'Review did not offer formal memory write: ' + JSON.stringify(distillationRequests.map(item => item.tools)))
      assert(!distillationRequests[0].tools.some(tool => tool === 'mnemo_runtime_memory' || tool === 'mnemo_document_manage'))
      assert(committed, 'Expected a formal memory commit receipt')
      await waitForRequest(request => request.context.includes('synthetic-distill-result'))
      await send(handle.agent, 'Remember the verified result. Retry this synthetic memory checkpoint.')
      const refused = await waitForRequest(request => request.context.includes('This mutation was already committed.'))
      assert(refused, 'Expected a repeated write to be blocked after the previous review failed')
      assert(distillationRequests.every(request => !request.context.includes('Run the routine validation.')), 'Routine check started a review')
      const recall = await createAgent('synthetic-distillation-recall')
      try {
        await send(recall.agent, 'Find the synthetic lesson about E734.')
        const result = recall.agent.session.snapshotEvents().find(event => event.type === 'tool/result'
          && event.data.message.source?.callId === 'synthetic-distill-recall')
        assert(result && result.data.message.isError === false, 'Expected a successful recall in the new session')
        const recalled = JSON.parse(result.data.message.content.find(block => block.type === 'text').text)
        assert.equal(recalled.results.filter(item => item.content === lesson).length, 1, 'Expected just one recalled lesson')
        previousInsightId = recalled.results.find(item => item.content === lesson).id
      } finally { await recall.dispose() }
      const revise = await createAgent('synthetic-distillation-revise')
      try {
        await send(revise.agent, 'Remember this verified correction. The coordinator check supersedes the earlier lesson. ' + correctedLesson)
        const updated = await waitForRequest(item => item.context.includes('synthetic-revision-write')
          && item.context.includes('previousId') && item.context.includes('committedAt'))
        assert(updated, 'Expected a committed revision receipt')
      } finally { await revise.dispose() }
      const revisedRecall = await createAgent('synthetic-distillation-recall-revised')
      try {
        await send(revisedRecall.agent, 'Find the corrected synthetic lesson about E734.')
        const result = revisedRecall.agent.session.snapshotEvents().find(event => event.type === 'tool/result'
          && event.data.message.source?.callId === 'synthetic-distill-recall')
        assert(result && result.data.message.isError === false)
        const recalled = JSON.parse(result.data.message.content.find(block => block.type === 'text').text)
        assert.equal(recalled.results.filter(item => item.content === correctedLesson).length, 1)
        assert(!recalled.results.some(item => item.content === lesson))
      } finally { await revisedRecall.dispose() }
    } finally {
      await routine.dispose()
      await handle.dispose()
    }
  }
  const result = { dsh: require('@deepseek-ai/dsh/package.json').version, node: process.version,
    profile: 'web', linkedBuiltStarter: !packedStarter, packedStarter: Boolean(packedStarter), syntheticModel: true, realModelRequests: 0, presets,
    ...(verifyDistillation ? { distillation: { foregroundWriteCalls: 0, recalledLessons: 1, routineReviewCalls: 0, repeatedWriteBlocked: true, revisionCommitted: true, workspaceSearchIsolated: true, legacyColdIndexReadable: true } } : {}) }
  await writeFile(output, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} finally {
  await ctx?.fiber.dispose()
  process.chdir(originalDirectory)
  await rm(temporary, { recursive: true, force: true })
}
// Exit only after successful assertions and cleanup; failed checks retain a nonzero status.
process.exit(0)
