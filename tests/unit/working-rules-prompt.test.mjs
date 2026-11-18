// What the Working Rules layer says about itself in the system prompt. These
// strings carry the behaviour a reader has to get right: apply the entries,
// treat an absent entry as possibly hidden or budgeted out, and do not guess a
// stored importance that the projection does not show.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workingRulesProtocol, WORKING_RULES_AUTHORITY } from '../../src/core/strategy/guidance.ts'
import { applyMemoryViewGuidance, STRATEGY_SECTION_NAME, WORKING_RULES_SECTION_NAME, GUIDANCE_SECTION_NAME } from '../../src/host/boot/guidance.ts'
import { RuntimeMemoryController } from '../../src/components/source-runtime/src/controller.ts'

const RULE = 'Synthetic rule for prompt verification'

function view(system = 'STRATEGY PROTOCOL TEXT', guidance = undefined) {
  return {
    id: 'view', digest: 'd', runtimeGeneration: 'g', createdAt: '2026-01-01T00:00:00.000Z',
    strategyTypeId: 'default-three-tier', strategyInstanceKey: 'synthetic/strategy',
    projection: [], sourcePresentations: [], routes: [], actionOffers: [],
    guidance: { system, ...(guidance === undefined ? {} : { routing: guidance }) },
  }
}

function sectionsFor(workingRules, memoryView = view()) {
  const assembly = applyMemoryViewGuidance({ sections: [], contexts: [] }, memoryView, true, workingRules)
  const byName = name => assembly.sections.find(section => section.name === name)
  return { assembly, byName }
}

test('the protocol tells the reader to apply the entries', () => {
  assert.match(workingRulesProtocol(true), /apply the ones that bear on the current task/u)
  assert.ok(workingRulesProtocol(true).includes(WORKING_RULES_AUTHORITY))
})

test('an absent entry is not reported as deleted', () => {
  assert.match(workingRulesProtocol(true), /absence alone does not show that a rule was deleted/u)
})

// The layer has no model-facing read operation, so a rule the prompt omits
// cannot be looked up. The protocol has to say so rather than let a reader
// answer that the rule does not exist.
test('a rule the prompt omits is not reported as nonexistent', () => {
  assert.match(workingRulesProtocol(true), /say that it may be omitted for one of those reasons instead of reporting that no such rule exists/u)
})

// Without a read operation, offering to look the entry up would be a promise the
// tools cannot keep.
test('the protocol does not promise a lookup it cannot perform', () => {
  assert.match(workingRulesProtocol(true), /has no separate read operation/u)
})

test('the protocol does not claim entries exist when none do', () => {
  const readOnly = workingRulesProtocol(false)
  assert.match(readOnly, /When this prompt carries entries/u)
  assert.doesNotMatch(readOnly, /The entries appear in this prompt/u)
})

test('a replacement keeps a stored importance the prompt cannot show', () => {
  assert.match(workingRulesProtocol(true), /keeps the level already stored unless you set another one/u)
})

test('the entries are their own section, wrapped, and never interpolated', () => {
  const { byName } = sectionsFor(RULE)
  const rules = byName(WORKING_RULES_SECTION_NAME)
  assert.equal(rules.interpolate, false)
  assert.match(rules.text, /### Active Working Rules/u)
  assert.match(rules.text, /<working-rules>\n[\s\S]*\n<\/working-rules>/u)
  assert.ok(rules.text.includes(RULE))
  assert.doesNotMatch(rules.text, /quoted as reference data/u)
  assert.doesNotMatch(workingRulesProtocol(true), /quoted reference data/u)
})

test('working rules are placed after strategy and routing guidance', () => {
  const { assembly } = sectionsFor(RULE)
  const names = assembly.sections.map(section => section.name)
  assert.ok(names.indexOf(STRATEGY_SECTION_NAME) < names.indexOf(GUIDANCE_SECTION_NAME))
  assert.ok(names.indexOf(GUIDANCE_SECTION_NAME) < names.indexOf(WORKING_RULES_SECTION_NAME))
})

test('no entries means no entries section', () => {
  const { byName } = sectionsFor('   ')
  assert.equal(byName(WORKING_RULES_SECTION_NAME), undefined)
  assert.ok(byName(STRATEGY_SECTION_NAME) !== undefined)
})

test('an undefined working rules argument leaves the strategy section alone', () => {
  const { byName } = sectionsFor(undefined)
  assert.equal(byName(WORKING_RULES_SECTION_NAME), undefined)
  assert.equal(byName(STRATEGY_SECTION_NAME).text, 'STRATEGY PROTOCOL TEXT')
})

test('the view routing text replaces the default routing guidance', () => {
  const { byName } = sectionsFor(RULE, view('STRATEGY PROTOCOL TEXT', 'VIEW ROUTING'))
  assert.equal(byName(GUIDANCE_SECTION_NAME).text, 'VIEW ROUTING')
})

test('working rules projection formats bullets and separates pinned rules without storage decoration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mnemo-rules-prompt-'))
  try {
    const controller = new RuntimeMemoryController({ effectiveDataDir: () => dir }, undefined, undefined, undefined, { legacyRoots: [] })
    await controller.mutate({ action: 'add', target: 'memory', content: 'Always run typecheck before finishing' })
    await controller.setPinned('memory', 'Always run typecheck before finishing', true)
    await controller.mutate({ action: 'add', target: 'memory', content: '- Prefer concise Chinese responses' })
    const projection = controller.contextProjection()
    assert.match(projection.text, /^#### Pinned Rules \(must follow\)\n- Always run typecheck before finishing\n\n#### Additional Rules\n- Prefer concise Chinese responses$/u)
    assert.equal(projection.minimumCharacters, '#### Pinned Rules (must follow)\n- Always run typecheck before finishing'.length)
    for (const decoration of ['importance=', 'created=', 'updated=', 'Git branch:', '§']) {
      assert.ok(!projection.text.includes(decoration))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
