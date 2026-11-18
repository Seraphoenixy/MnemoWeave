// What the Working Rules layer says about itself in the system prompt. These
// strings carry the behaviour a reader has to get right: apply the entries,
// treat an absent entry as possibly hidden or budgeted out, and do not guess a
// stored importance that the projection does not show.
import test from 'node:test'
import assert from 'node:assert/strict'
import { workingRulesProtocol, WORKING_RULES_AUTHORITY } from '../../src/core/strategy/guidance.ts'
import { applyMemoryViewGuidance, STRATEGY_SECTION_NAME, WORKING_RULES_SECTION_NAME, GUIDANCE_SECTION_NAME } from '../../src/host/boot/guidance.ts'

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

test('the entries are their own section and are never interpolated', () => {
  const { byName } = sectionsFor(RULE)
  const rules = byName(WORKING_RULES_SECTION_NAME)
  assert.equal(rules.interpolate, false)
  assert.ok(rules.text.includes(RULE))
})

test('the entries follow the section that describes them', () => {
  const { assembly } = sectionsFor(RULE)
  const names = assembly.sections.map(section => section.name)
  assert.equal(names.indexOf(WORKING_RULES_SECTION_NAME), names.indexOf(STRATEGY_SECTION_NAME) + 1)
})

test('routing guidance stays behind the entries', () => {
  const { assembly } = sectionsFor(RULE)
  const names = assembly.sections.map(section => section.name)
  assert.ok(names.indexOf(GUIDANCE_SECTION_NAME) > names.indexOf(WORKING_RULES_SECTION_NAME))
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
