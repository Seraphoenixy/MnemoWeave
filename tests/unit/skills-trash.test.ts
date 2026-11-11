import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { listTrash, restoreTrash, trashSkill, trashDirFor } from '../../plugins/dsh-mnemo-weave/src/ui/skills-trash.ts';

const skill = (name: string): string => `---\nname: ${name}\ndescription: A skill\n---\n\n# ${name}\n`;

test('removing a skill keeps its whole folder and restore returns it unchanged', async () => {
  const workspace = await mkdtemp(resolve('work', 'skills-trash-ws-'));
  const stateDir = await mkdtemp(resolve('work', 'skills-trash-state-'));
  const dir = join(workspace, '.dsh', 'skills', 'alpha');
  const path = join(dir, 'SKILL.md');
  await mkdir(join(dir, 'scripts'), { recursive: true });
  await writeFile(path, skill('alpha'), 'utf8');
  await writeFile(join(dir, 'scripts', 'run.sh'), 'echo hi\n', 'utf8');

  const entry = await trashSkill({ workspace, stateDir, path, now: '2026-11-12T00:00:00.000Z' });
  assert.equal(entry.name, 'alpha');
  assert.equal(entry.originalPath, path);
  assert.equal((await readdir(join(workspace, '.dsh', 'skills'))).includes('alpha'), false);
  assert.equal(await readFile(join(trashDirFor(stateDir, entry.id), 'scripts', 'run.sh'), 'utf8'), 'echo hi\n');
  assert.equal((await listTrash(stateDir))[0]!.id, entry.id);

  await restoreTrash({ workspace, stateDir, id: entry.id });
  assert.equal(await readFile(path, 'utf8'), skill('alpha'));
  assert.equal(await readFile(join(dir, 'scripts', 'run.sh'), 'utf8'), 'echo hi\n');
  assert.deepEqual(await listTrash(stateDir), []);
});

test('restore refuses to overwrite a skill created at the same location', async () => {
  const workspace = await mkdtemp(resolve('work', 'skills-trash2-ws-'));
  const stateDir = await mkdtemp(resolve('work', 'skills-trash2-state-'));
  const path = join(workspace, '.dsh', 'skills', 'alpha', 'SKILL.md');
  await mkdir(join(workspace, '.dsh', 'skills', 'alpha'), { recursive: true });
  await writeFile(path, skill('alpha'), 'utf8');
  const entry = await trashSkill({ workspace, stateDir, path });
  await mkdir(join(workspace, '.dsh', 'skills', 'alpha'), { recursive: true });
  await writeFile(path, skill('alpha'), 'utf8');
  await assert.rejects(restoreTrash({ workspace, stateDir, id: entry.id }),
    (error: unknown) => (error as { code?: string }).code === 'SKILL_TARGET_EXISTS');
  assert.equal(await readFile(path, 'utf8'), skill('alpha'));
});

test('a path outside the four roots is refused', async () => {
  const workspace = await mkdtemp(resolve('work', 'skills-trash3-ws-'));
  const stateDir = await mkdtemp(resolve('work', 'skills-trash3-state-'));
  await assert.rejects(trashSkill({ workspace, stateDir, path: join(workspace, 'SKILL.md') }),
    (error: unknown) => (error as { code?: string }).code === 'SKILL_PATH_INVALID');
});
