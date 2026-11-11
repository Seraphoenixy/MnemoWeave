/**
 * Skill trash: removing a skill moves its whole folder aside instead of deleting it.
 *
 * The folder is kept intact (scripts included) under the plugin state directory, with a small
 * metadata file recording where it came from. Restoring refuses when a skill of the same name
 * already exists at the original location, so an external skill is never overwritten.
 */
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { assertSkillPath, skillError, skillStateDir } from './skills-write.ts';

export interface TrashEntry {
  id: string;
  name: string;
  originalPath: string;
  root: string;
  removedAt: string;
}

interface TrashMeta extends TrashEntry { originalDir: string }

async function moveDir(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as { code?: string }).code !== 'EXDEV') throw error;
    // The workspace and the state directory can sit on different volumes.
    await cp(from, to, { recursive: true });
    await rm(from, { recursive: true, force: true });
  }
}

async function readMeta(dir: string): Promise<TrashMeta> {
  const value = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as TrashMeta;
  if (typeof value.id !== 'string' || typeof value.originalPath !== 'string' || typeof value.originalDir !== 'string'
    || typeof value.root !== 'string' || typeof value.removedAt !== 'string' || typeof value.name !== 'string') {
    throw skillError('SKILL_INVALID');
  }
  return value;
}

export async function trashSkill(input: {
  workspace: string; path: string; home?: string; stateDir?: string; now?: string;
}): Promise<TrashEntry> {
  const path = assertSkillPath(input.workspace, input.path, input.home);
  const stateDir = input.stateDir ?? skillStateDir();
  const dir = dirname(path);
  const entry: TrashMeta = {
    id: randomUUID(),
    name: dir.split(/[\\/]/u).at(-1) ?? '',
    originalPath: path,
    originalDir: dir,
    root: dirname(dir),
    removedAt: input.now ?? new Date().toISOString(),
  };
  const target = join(stateDir, 'trash', entry.id);
  await moveDir(dir, target);
  await writeFile(join(target, 'meta.json'), `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  return { id: entry.id, name: entry.name, originalPath: entry.originalPath, root: entry.root, removedAt: entry.removedAt };
}

export async function listTrash(stateDir: string = skillStateDir()): Promise<TrashEntry[]> {
  let ids: string[];
  try {
    ids = await readdir(join(stateDir, 'trash'));
  } catch {
    return [];
  }
  const entries: TrashEntry[] = [];
  for (const id of ids) {
    try {
      const meta = await readMeta(join(stateDir, 'trash', id));
      entries.push({ id: meta.id, name: meta.name, originalPath: meta.originalPath, root: meta.root, removedAt: meta.removedAt });
    } catch { /* an unreadable entry is not offered for restore */ }
  }
  return entries.sort((left, right) => right.removedAt.localeCompare(left.removedAt));
}

export async function restoreTrash(input: {
  id: string; workspace: string; home?: string; stateDir?: string;
}): Promise<TrashEntry> {
  const stateDir = input.stateDir ?? skillStateDir();
  if (!/^[a-f0-9-]{36}$/.test(input.id)) throw skillError('NOT_FOUND');
  const dir = join(stateDir, 'trash', input.id);
  const meta = await readMeta(dir);
  // The original location must still be one of this workspace's or user's skill roots.
  assertSkillPath(input.workspace, meta.originalPath, input.home);
  try {
    await readdir(meta.originalDir);
    throw skillError('SKILL_TARGET_EXISTS');
  } catch (error) {
    if ((error as { code?: string }).code === 'SKILL_TARGET_EXISTS') throw error;
  }
  await moveDir(dir, meta.originalDir);
  await rm(join(meta.originalDir, 'meta.json'), { force: true });
  return { id: meta.id, name: meta.name, originalPath: meta.originalPath, root: meta.root, removedAt: meta.removedAt };
}

/** The folder path of a trashed skill, used by tests and by the page to show what is kept. */
export function trashDirFor(stateDir: string, id: string): string {
  return resolvePath(join(stateDir, 'trash', id));
}
