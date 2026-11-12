import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SkillBacktestResult } from '../../plugins/dsh-mnemo-weave/src/shared/contract.ts';
import { adoptionDecision, autoAdoptSkill, readSkillPreferences, saveSkillPreferences } from '../../plugins/dsh-mnemo-weave/src/ui/skills-adopt.ts';
import { tempDir } from '../support/temp.ts';

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const skill = (body: string): string => `---\nname: alpha\ndescription: A skill\n---\n\n${body}\n`;
const side = (passed: boolean) => ({ answer: 'ok', steps: 'one', checks: [{ passed, reason: passed ? 'ok' : 'missing evidence' }] });
const review = (overrides: Partial<SkillBacktestResult> = {}, completedAt = '2026-11-12T00:00:00.000Z') => ({
  report: { baseline: side(true), candidate: side(true), regressions: [], ...overrides },
  checks: ['the answer names the port'],
  completedAt,
});
const NOW = '2026-11-12T01:00:00.000Z';
const base = { enabled: true, hasBaseline: true, baselineChanged: false, review: review(), now: NOW };

test('automatic adoption requires an enabled, unchanged baseline and a fresh complete pass', () => {
  assert.equal(adoptionDecision(base).reason, 'eligible');
  assert.equal(adoptionDecision({ ...base, enabled: false }).reason, 'disabled');
  assert.equal(adoptionDecision({ ...base, hasBaseline: false }).reason, 'no-baseline');
  assert.equal(adoptionDecision({ ...base, baselineChanged: true }).reason, 'baseline-changed');
  assert.equal(adoptionDecision({ ...base, review: null }).reason, 'no-backtest');
  assert.equal(adoptionDecision({ ...base, review: review({}, '2026-11-10T00:00:00.000Z') }).reason, 'stale-backtest');
  assert.equal(adoptionDecision({ ...base, review: review({}, '2026-11-13T00:00:00.000Z') }).reason, 'stale-backtest');
  assert.equal(adoptionDecision({ ...base, review: { ...review(), checks: ['a', 'b'] } }).reason, 'incomplete-backtest');
  assert.equal(adoptionDecision({ ...base, review: review({ regressions: ['the answer names the port'] }) }).reason, 'regressions');
  assert.equal(adoptionDecision({ ...base, review: review({ candidate: side(false) }) }).reason, 'failed-check');
});

test('the preference defaults to off and survives a restart', async () => {
  const stateDir = await tempDir('skills-adopt', 'skills-prefs');
  assert.deepEqual(await readSkillPreferences(stateDir), { autoAdopt: false });
  assert.deepEqual(await saveSkillPreferences({ autoAdopt: true }, stateDir), { autoAdopt: true });
  assert.deepEqual(await readSkillPreferences(stateDir), { autoAdopt: true });
});

test('an enabled host adopts only when the gate passes, keeping the old text', async () => {
  const workspace = await tempDir('skills-adopt', 'skills-auto-ws');
  const stateDir = await tempDir('skills-adopt', 'skills-auto-state');
  const path = join(workspace, '.dsh', 'skills', 'alpha', 'SKILL.md');
  await mkdir(join(workspace, '.dsh', 'skills', 'alpha'), { recursive: true });
  const original = skill('Original.');
  await writeFile(path, original, 'utf8');
  const candidate = skill('Improved.');

  const off = await autoAdoptSkill({ workspace, stateDir, path, candidate, baselineHash: hash(original), review: review(), now: NOW });
  assert.deepEqual({ adopted: off.adopted, reason: off.reason }, { adopted: false, reason: 'disabled' });
  assert.equal(await readFile(path, 'utf8'), original);

  await saveSkillPreferences({ autoAdopt: true }, stateDir);
  const adopted = await autoAdoptSkill({ workspace, stateDir, path, candidate, baselineHash: hash(original), review: review(), now: NOW });
  assert.equal(adopted.adopted, true);
  assert.equal(await readFile(path, 'utf8'), candidate);

  const stale = await autoAdoptSkill({ workspace, stateDir, path, candidate: skill('Later.'), baselineHash: hash(candidate), review: review({ candidate: side(false) }), now: NOW });
  assert.deepEqual({ adopted: stale.adopted, reason: stale.reason }, { adopted: false, reason: 'failed-check' });
  assert.equal(await readFile(path, 'utf8'), candidate);
});
