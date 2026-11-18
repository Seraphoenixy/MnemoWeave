// Active capture is a prompt, not a background writer. Its boundary text has to
// permit revising the entry this conversation corrected, and forbid turning the
// hint into an unrelated cleanup pass.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_THREE_TIER_VIEW_STRATEGY } from '../../src/core/strategy/strategy.ts'
import { threeTierContributions } from '../../src/core/strategy/extensions.ts'
import { createAutoCaptureExtension } from '../../src/components/strategy-auto-capture/src/index.ts'

const SOURCE_KEY = 'source:include:mnemon-source-memory-spaces'

function sourceFacts(actionIds = ['remember', 'forget', 'link', 'manage-spaces']) {
  return {
    sourceInstanceKey: SOURCE_KEY, sourceTypeId: 'memory-spaces', role: 'durable-evidence',
    availability: 'ready', capabilities: ['project', 'write'], consistency: 'namespace-pinned-live-read',
    routeIds: ['recall'], actionIds,
    actions: actionIds.map(id => ({ id, capability: id === 'forget' ? 'forget' : 'write' })),
  }
}

const request = {
  scope: { storage: 'workspace', workspaceId: 'synthetic-workspace' },
  budget: { maxProjectionCharacters: 20_000, maxEvidenceCharacters: 20_000, maxEvidenceItems: 50 },
}

/** One capture contribution, shaped exactly as the Host hands it to a Strategy. */
function captureContribution(actionIds) {
  const extension = createAutoCaptureExtension({})
  return { instanceKey: 'synthetic/capture', typeId: extension.manifest.typeId, slot: 'capture',
    value: extension.contribute(request, [sourceFacts(actionIds)]) }
}

function captureText(actionIds) {
  const spec = DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, [sourceFacts(actionIds)], [captureContribution(actionIds)])
  return JSON.stringify(spec.guidance)
}

test('active capture may revise the entry this conversation corrected', () => {
  const text = captureText()
  assert.match(text, /corrects or supersedes an existing entry, update that entry/u)
  assert.doesNotMatch(text, /Do not overwrite or delete existing memory/u)
})

test('active capture stays out of unrelated cleanup', () => {
  assert.match(captureText(), /Do not gather unrelated entries into a cleanup pass/u)
})

test('active capture records through remember and never offers forget', () => {
  assert.deepEqual([...captureContribution().value.actionIds], ['remember'])
  assert.deepEqual(captureContribution().value.actionIds.includes('forget'), false)
  assert.deepEqual(threeTierContributions([captureContribution()]).capture?.actionIds, ['remember'])
})

test('the boundary permits revision while leaving deletion to the user', () => {
  const text = captureText().replace(/\\n/gu, ' ')
  assert.match(text, /capturing corrects what this conversation changed, and nothing else/u)
})

// The Strategy protocol sends preferences to Working Rules while active capture
// writes to a durable Source. Naming the split keeps the two from claiming the
// same input.
test('active capture defers preferences to Working Rules', () => {
  const text = captureText().replace(/\\n/gu, ' ')
  assert.match(text, /a standing preference or working convention belongs to Working Rules through mnemo_runtime_memory/u)
  assert.match(text, /only facts that do not belong there qualify for an eligible Source/u)
})

// The Working Rules layer ends its own instructions expecting the entries to
// follow. A capture block placed after it would sit between that heading and the
// entries, so the capture policy goes first. The runtime Source supplies the
// Working Rules protocol; without it the composition has no such section.
test('the capture policy precedes the Working Rules protocol', () => {
  const runtime = {
    sourceInstanceKey: 'source:include:mnemon-source-runtime', sourceTypeId: 'runtime', role: 'working-context',
    availability: 'ready', capabilities: ['status', 'project', 'write'], consistency: 'exact-snapshot',
    routeIds: [], actionIds: ['mutate'], actions: [{ id: 'mutate', capability: 'write' }],
  }
  const spec = DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, [runtime, sourceFacts()], [captureContribution()])
  const system = spec.guidance.system
  assert.ok(system.includes('### Working Rules'))
  assert.ok(system.indexOf('MNEMON OPTIONAL AUTO CAPTURE') < system.indexOf('### Working Rules'))
})

// The capture list has moved above the entries, so the block may not point the
// reader at a location below it.
test('the capture policy does not point at a position below itself', () => {
  assert.doesNotMatch(captureText(), /qualify for an eligible Source below/u)
})
