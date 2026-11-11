import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { adoptSkill, createSkill, restoreSkill, skillVersions } from '../../plugins/dsh-mnemo-weave/src/ui/skills-write.ts';

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const skill = (name: string, body: string): string => `---\nname: ${name}\ndescription: A skill\n---\n\n${body}\n`;

async function fixture() {
  const workspace = await mkdtemp(resolve('work', 'skills-write-ws-'));
  const stateDir = await mkdtemp(resolve('work', 'skills-write-state-'));
  const path = join(workspace, '.dsh', 'skills', 'alpha', 'SKILL.md');
  const original = skill('alpha', 'Original body.');
  await mkdir(join(workspace, '.dsh', 'skills', 'alpha'), { recursive: true });
  await writeFile(path, original, 'utf8');
  return { workspace, stateDir, path, original };
}

test('adoption is conditional on the baseline hash and keeps the previous text as a version', async () => {
  const { workspace, stateDir, path, original } = await fixture();
  const candidate = skill('alpha', 'Improved body.');
  const written = await adoptSkill({ workspace, stateDir, path, candidate, baselineHash: hash(original), now: '2026-11-12T00:00:00.000Z' });
  assert.equal(await readFile(path, 'utf8'), candidate);
  assert.equal(written.hash, hash(candidate));
  const versions = await skillVersions({ workspace, stateDir, path });
  assert.equal(versions.length, 1);
  assert.equal(versions[0]!.hash, hash(original));
  assert.equal(versions[0]!.source, 'adopt');

  await assert.rejects(adoptSkill({ workspace, stateDir, path, candidate: skill('alpha', 'Stale.'), baselineHash: hash(original) }),
    (error: unknown) => (error as { code?: string }).code === 'SKILL_CHANGED');
  assert.equal(await readFile(path, 'utf8'), candidate, 'a stale write leaves the external edit intact');
});

test('restore writes the stored version and records the text it replaced', async () => {
  const { workspace, stateDir, path, original } = await fixture();
  const candidate = skill('alpha', 'Improved body.');
  await adoptSkill({ workspace, stateDir, path, candidate, baselineHash: hash(original) });
  const [version] = await skillVersions({ workspace, stateDir, path });
  await restoreSkill({ workspace, stateDir, path, versionId: version!.id, baselineHash: hash(candidate) });
  assert.equal(await readFile(path, 'utf8'), original);
  const versions = await skillVersions({ workspace, stateDir, path });
  assert.deepEqual(versions.map(item => item.source), ['restore', 'adopt']);
});

test('a new skill is written only under a real root and never overwrites an existing name', async () => {
  const workspace = await mkdtemp(resolve('work', 'skills-new-ws-'));
  const root = join(workspace, '.dsh', 'skills');
  const created = await createSkill({ workspace, root, name: 'new-skill', description: 'A new skill.' });
  assert.equal(created.path, join(root, 'new-skill', 'SKILL.md'));
  const text = await readFile(created.path, 'utf8');
  assert.match(text, /^---\nname: new-skill\ndescription: A new skill\.\n---\n/);
  assert.equal(hash(text), created.hash);

  await assert.rejects(createSkill({ workspace, root, name: 'new-skill', description: 'Again.' }),
    (error: unknown) => (error as { code?: string }).code === 'SKILL_EXISTS');
  await assert.rejects(createSkill({ workspace, root: join(workspace, 'elsewhere'), name: 'new-skill', description: 'x' }),
    (error: unknown) => (error as { code?: string }).code === 'SKILL_PATH_INVALID');
  await assert.rejects(createSkill({ workspace, root, name: 'Bad Name', description: 'x' }),
    (error: unknown) => (error as { code?: string }).code === 'SKILL_INVALID');
});
test('writes outside the four skill roots and invalid candidates are refused', async () => {
  const { workspace, stateDir, path, original } = await fixture();
  await assert.rejects(adoptSkill({ workspace, stateDir, path: join(workspace, 'SKILL.md'), candidate: skill('alpha', 'x'), baselineHash: hash(original) }),
    (error: unknown) => (error as { code?: string }).code === 'SKILL_PATH_INVALID');
  await assert.rejects(adoptSkill({ workspace, stateDir, path, candidate: 'no frontmatter', baselineHash: hash(original) }),
    (error: unknown) => (error as { code?: string }).code === 'SKILL_INVALID');
  assert.equal(await readFile(path, 'utf8'), original);
  assert.deepEqual(await skillVersions({ workspace, stateDir, path }), []);
});
