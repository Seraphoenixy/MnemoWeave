import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SKILLS_CONFIG } from '../../src/host/contracts/protocol.ts'
import { SkillEvolution } from '../../src/host/skills/skill-evolution.ts'

function session(id, cwd, sequence) {
  const events = [{ type: 'turn/start', data: { turn: 1 } }]
  for (const [name, input, failed] of sequence) {
    const callId = String(events.length)
    events.push({ type: 'tool/call', data: { name, callId, arguments: input } })
    events.push({ type: 'tool/result', data: { message: {
      source: { callId }, isError: failed, content: [{ type: 'text', text: failed ? 'Synthetic failure' : 'Synthetic success' }],
    } } })
  }
  events.push({ type: 'turn/end', data: { turn: 1 } })
  return { id, status: 'idle', session: { header: { cwd }, seq: events.length, snapshotEvents: (start, end) => events.slice(start, end) } }
}

test('a new skill evaluation requires an independently repeated workflow in the same workspace', async () => {
  const requests = []
  const recorded = []
  const source = {
    async read(operation) { return operation === 'catalog' ? { skills: [], roots: [] } : [] },
    async mutate(operation, value) { recorded.push({ operation, value }); return { suggestions: [] } },
  }
  const evolution = new SkillEvolution({
    settings: () => ({ ...DEFAULT_SKILLS_CONFIG, evolution: true, reviewThreshold: 1, idleSeconds: 0 }),
    source: () => source,
    runTask: async (_workspace, _signal, run) => run({}),
    skillEvidence: async () => ({ memories: [{ id: 'evidence', text: 'Validated workflow' }] }),
    async skillTask(_agent, _label, prompt) {
      requests.push(prompt)
      return { structured: { outcome: 'nothing', summary: 'No change', suggestions: [] } }
    },
  })
  const workflow = [['probe', { target: 'lease' }], ['repair', { mode: 'renew' }], ['probe', { target: 'epoch' }]]
  const pause = () => new Promise(resolve => setTimeout(resolve, 20))
  try {
    await evolution.turnEnded(session('one', 'workspace-a', workflow), 1)
    await evolution.turnEnded(session('other-workspace', 'workspace-b', workflow), 1)
    await evolution.turnEnded(session('different-input', 'workspace-a', [['probe', { target: 'disk' }], ...workflow.slice(1)]), 1)
    await pause()
    assert.equal(requests.length, 0)
    await evolution.turnEnded(session('two', 'workspace-a', workflow), 1)
    await pause()
    assert.equal(requests.length, 1)
    assert.match(requests[0], /create=true, update=false/)
    assert.match(requests[0], /Validated workflow/)
    assert.equal(recorded[0]?.operation, 'review-record')
  } finally { evolution.dispose() }
})

test('automatic improvement starts only after two independent uses of the same skill show recovery', async () => {
  const requests = []
  const skill = { name: 'diagnose-lease', description: 'Diagnose synthetic leases', key: 'lease', root: 'project', path: 'SKILL.md', content: 'Probe the lease.' }
  const source = {
    async read(operation) {
      if (operation === 'catalog') return { skills: [skill], roots: [] }
      if (operation === 'skill') return skill
      return []
    },
    async mutate() { return { suggestions: [] } },
  }
  const evolution = new SkillEvolution({
    settings: () => ({ ...DEFAULT_SKILLS_CONFIG, evolution: true, reviewThreshold: 1, idleSeconds: 0 }),
    source: () => source,
    runTask: async (_workspace, _signal, run) => run({}),
    async skillTask(_agent, _label, prompt) {
      requests.push(prompt)
      return { structured: { outcome: 'nothing', summary: 'No change', suggestions: [] } }
    },
  })
  const sequence = [['skill', { name: skill.name }], ['probe', { mode: 'old' }, true], ['probe', { mode: 'new' }, false]]
  try {
    await evolution.turnEnded(session('one', 'workspace', sequence), 1)
    assert.equal(requests.length, 0)
    await evolution.turnEnded(session('two', 'workspace', sequence), 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(requests.length, 1)
    assert.match(requests[0], /create=false, update=true/)
    assert.match(requests[0], /Probe the lease/)
    assert.match(requests[0], /previousSession.*Synthetic failure/)
  } finally { evolution.dispose() }
})
