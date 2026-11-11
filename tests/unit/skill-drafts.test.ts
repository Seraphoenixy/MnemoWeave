import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { adoptStoredDraft, dismissSkillDraft, listSkillDrafts, markSkillDraftAdopted, saveSkillDraft } from '../../plugins/dsh-mnemo-weave/src/ui/skill-drafts.ts';

const base = {
  workspace: '/w/alpha',
  skillPath: '/w/alpha/.dsh/skills/alpha/SKILL.md',
  reason: 'The user corrected the serial settings twice.',
  evidence: [{ step: 2, role: 'user' as const, text: '不对，应该是 115200' }],
  baseline: '---\nname: alpha\ndescription: x\n---\n\nold\n',
  candidate: '---\nname: alpha\ndescription: x\n---\n\nnew\n',
  scenario: 'Set the serial port.',
  checks: ['the answer names 115200'],
  report: { baseline: { answer: 'a', steps: 's', checks: [{ passed: true, reason: 'ok' }] }, candidate: { answer: 'b', steps: 's', checks: [{ passed: true, reason: 'ok' }] }, regressions: [] },
  backtestError: null,
};

test('drafts persist with their original workspace and skill path', async () => {
  const stateDir = await mkdtemp(resolve('work', 'skill-drafts-'));
  const first = await saveSkillDraft(base, stateDir);
  assert.equal(first.workspace, base.workspace);
  assert.equal(first.skillPath, base.skillPath);
  assert.equal(first.adoptedAt, null);
  const second = await saveSkillDraft({ ...base, workspace: '/w/beta', skillPath: '/w/beta/.dsh/skills/beta/SKILL.md', reason: 'second' }, stateDir);
  const all = await listSkillDrafts({ stateDir });
  assert.deepEqual(all.map(draft => draft.id), [second.id, first.id], 'newest first');
  assert.deepEqual((await listSkillDrafts({ stateDir, workspace: '/w/alpha' })).map(draft => draft.id), [first.id]);
  assert.deepEqual((await listSkillDrafts({ stateDir, skillPath: '/w/beta/.dsh/skills/beta/SKILL.md' })).map(draft => draft.id), [second.id]);
});

test('a stored draft is adopted through the baseline-checked write and marked adopted', async () => {
  const stateDir = await mkdtemp(resolve('work', 'skill-drafts3-'));
  const workspace = await mkdtemp(resolve('work', 'skill-drafts3-ws-'));
  const skillPath = join(workspace, '.dsh', 'skills', 'alpha', 'SKILL.md');
  await mkdir(join(workspace, '.dsh', 'skills', 'alpha'), { recursive: true });
  const original = base.baseline;
  await writeFile(skillPath, original, 'utf8');
  const draft = await saveSkillDraft({ ...base, workspace, skillPath, baseline: original }, stateDir);
  const hash = createHash('sha256').update(original).digest('hex');
  const adopted = await adoptStoredDraft({ id: draft.id, baselineHash: hash, stateDir });
  assert.ok(adopted.draft.adoptedAt !== null);
  assert.equal(await readFile(skillPath, 'utf8'), base.candidate);
  assert.equal((await listSkillDrafts({ stateDir }))[0]!.adoptedAt !== null, true);
  await assert.rejects(adoptStoredDraft({ id: draft.id, baselineHash: hash, stateDir }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_STATE');
  const dismissed = await saveSkillDraft({ ...base, workspace, skillPath }, stateDir);
  await dismissSkillDraft(dismissed.id, stateDir);
  await assert.rejects(adoptStoredDraft({ id: dismissed.id, baselineHash: hash, stateDir }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_STATE');
});
test('a draft is dismissed or marked adopted without losing its content', async () => {
  const stateDir = await mkdtemp(resolve('work', 'skill-drafts2-'));
  const draft = await saveSkillDraft(base, stateDir);
  const dismissed = await dismissSkillDraft(draft.id, stateDir);
  assert.ok(dismissed.dismissedAt !== null);
  assert.equal((await listSkillDrafts({ stateDir }))[0]!.candidate, base.candidate);
  const adopted = await markSkillDraftAdopted(draft.id, stateDir);
  assert.ok(adopted.adoptedAt !== null);
  await assert.rejects(dismissSkillDraft('00000000-0000-4000-8000-000000000000', stateDir),
    (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND');
});
