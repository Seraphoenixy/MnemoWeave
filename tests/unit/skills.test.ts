import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { frontmatter, listSkills } from '../../plugins/dsh-mnemo-weave/src/ui/skills.ts';

const skill = (name: string, description: string, body = 'Do the work.'): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;

test('skill discovery follows DSH precedence and reports shadowed and unloadable files', async () => {
  const workspace = await mkdtemp(resolve('work', 'skills-ws-'));
  const home = await mkdtemp(resolve('work', 'skills-home-'));
  const write = async (root: string, dir: string, text: string): Promise<void> => {
    await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, dir, 'SKILL.md'), text);
  };
  await write(join(workspace, '.dsh', 'skills'), 'alpha', skill('alpha', 'Project alpha'));
  await write(join(workspace, '.agents', 'skills'), 'beta', skill('alpha', 'Later duplicate'));
  await write(join(workspace, '.agents', 'skills'), 'broken', 'no frontmatter');
  await write(join(workspace, '.agents', 'skills'), 'empty', '---\nname: empty\ndescription: Has no body\n---\n\n');
  await write(join(home, '.dsh', 'skills'), 'gamma', skill('gamma', 'User gamma'));

  const report = await listSkills(workspace, home);
  assert.deepEqual(report.items.map(item => item.name), ['alpha', 'gamma']);
  assert.equal(report.items[0]!.scope, 'project');
  assert.equal(report.items[1]!.scope, 'user');
  assert.equal(report.items[0]!.hash, createHash('sha256').update(skill('alpha', 'Project alpha')).digest('hex'));
  assert.equal(report.roots.length, 4);
  const shadowed = report.invalid.find(item => item.reason.startsWith('shadowed-by:'));
  assert.equal(shadowed?.reason, `shadowed-by:${report.items[0]!.path}`);
  assert.ok(report.invalid.some(item => item.reason === 'missing-frontmatter'));
  assert.ok(report.invalid.some(item => item.reason === 'empty-body'));
});

test('frontmatter strips quotes and keeps the body byte-for-byte', () => {
  const parsed = frontmatter('---\nname: "alpha"\ndescription: \'A skill\'\n---\n\nBody line\n');
  assert.equal(parsed.name, 'alpha');
  assert.equal(parsed.description, 'A skill');
  assert.equal(parsed.body, '\nBody line\n');
  assert.deepEqual(frontmatter('plain text'), { body: 'plain text' });
});
