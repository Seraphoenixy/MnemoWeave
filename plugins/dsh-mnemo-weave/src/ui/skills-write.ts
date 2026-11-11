/**
 * Versioned skill writes.
 *
 * A write is conditional on the baseline hash the caller read: if the file changed since then,
 * the write is refused and the external edit stays intact. Every accepted write first stores the
 * previous text as a version, so adoption and restore are both reversible.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { frontmatter, skillRoots } from './skills.ts';

export interface SkillVersion {
  id: string;
  hash: string;
  savedAt: string;
  source: 'adopt' | 'restore';
}

interface IndexEntry { id: string; hash: string; savedAt: string; source: SkillVersion['source']; file: string }
interface Index { version: 1; skills: Record<string, IndexEntry[]> }

const MAX_VERSIONS = 20;

export function skillStateDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const settings = env.MNEMOWEAVE_DSH_SETTINGS;
  return join(settings !== undefined && settings.trim() !== '' ? dirname(resolvePath(settings)) : join(home, '.dsh'), 'mnemo-weave.skills');
}

export function skillError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }

/** Only a `SKILL.md` directly inside one directory of a real skill root may be written. */
export function assertSkillPath(workspace: string, path: string, home?: string): string {
  const target = resolvePath(path);
  const allowed = skillRoots(workspace, home).some(root => {
    const dir = dirname(target);
    return dirname(dir) === resolvePath(root.path) && target.toLowerCase().endsWith('skill.md');
  });
  if (!allowed) throw skillError('SKILL_PATH_INVALID');
  return target;
}

function validate(candidate: string): void {
  const parsed = frontmatter(candidate);
  if (parsed.name === undefined || parsed.description === undefined || parsed.body.trim() === '') throw skillError('SKILL_INVALID');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parsed.name)) throw skillError('SKILL_INVALID');
}

async function readIndex(stateDir: string): Promise<Index> {
  try {
    const parsed = JSON.parse(await readFile(join(stateDir, 'versions.json'), 'utf8')) as Index;
    if (parsed.version === 1 && typeof parsed.skills === 'object' && parsed.skills !== null) return parsed;
  } catch { /* a missing or unreadable index starts empty */ }
  return { version: 1, skills: {} };
}

async function writeIndex(stateDir: string, index: Index): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const temporary = join(stateDir, `versions.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  await rename(temporary, join(stateDir, 'versions.json'));
}

async function atomicWrite(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, 'utf8');
  await rename(temporary, path);
}

async function remember(stateDir: string, path: string, text: string, source: SkillVersion['source'], savedAt: string): Promise<SkillVersion> {
  const index = await readIndex(stateDir);
  const id = randomUUID();
  const file = join(stateDir, 'files', `${id}.md`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
  const entry: IndexEntry = { id, hash: hash(text), savedAt, source, file };
  const versions = [...(index.skills[path] ?? []), entry];
  const dropped = versions.slice(0, Math.max(0, versions.length - MAX_VERSIONS));
  index.skills[path] = versions.slice(-MAX_VERSIONS);
  await writeIndex(stateDir, index);
  for (const old of dropped) await rm(old.file, { force: true }).catch(() => undefined);
  return { id, hash: entry.hash, savedAt, source };
}

export async function skillVersions(input: { workspace: string; path: string; home?: string; stateDir?: string }): Promise<SkillVersion[]> {
  const path = assertSkillPath(input.workspace, input.path, input.home);
  const index = await readIndex(input.stateDir ?? skillStateDir());
  return (index.skills[path] ?? []).map(entry => ({ id: entry.id, hash: entry.hash, savedAt: entry.savedAt, source: entry.source })).reverse();
}

export interface SkillWriteResult { hash: string; version: SkillVersion }

/** The page shows at most this much text; larger skills are compared by hash instead. */
export const MAX_SKILL_TEXT = 24_000;

export async function readSkillText(input: { workspace: string; path: string; home?: string }): Promise<{ text: string; hash: string }> {
  const path = assertSkillPath(input.workspace, input.path, input.home);
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_SKILL_TEXT) throw skillError('SKILL_TOO_LARGE');
  return { text, hash: hash(text) };
}

export async function readVersionText(input: { workspace: string; path: string; versionId: string; home?: string; stateDir?: string }): Promise<{ text: string; hash: string }> {
  const path = assertSkillPath(input.workspace, input.path, input.home);
  const index = await readIndex(input.stateDir ?? skillStateDir());
  const entry = (index.skills[path] ?? []).find(item => item.id === input.versionId);
  if (entry === undefined) throw skillError('NOT_FOUND');
  const text = await readFile(entry.file, 'utf8');
  return { text, hash: hash(text) };
}

/** Create a new skill folder under one of the four roots. Existing names are refused. */
export async function createSkill(input: {
  workspace: string; root: string; name: string; description: string; body?: string; home?: string;
}): Promise<{ path: string; hash: string }> {
  const name = input.name.trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw skillError('SKILL_INVALID');
  const description = input.description.trim();
  if (description === '' || description.length > 500) throw skillError('SKILL_INVALID');
  const body = (input.body ?? `# ${name}\n\n${description}\n`).trim();
  if (body === '') throw skillError('SKILL_INVALID');
  const roots = skillRoots(input.workspace, input.home).map(root => resolvePath(root.path));
  const root = resolvePath(input.root);
  if (!roots.includes(root)) throw skillError('SKILL_PATH_INVALID');
  const dir = join(root, name);
  const path = join(dir, 'SKILL.md');
  try {
    await readFile(path, 'utf8');
    throw skillError('SKILL_EXISTS');
  } catch (error) {
    if ((error as { code?: string }).code === 'SKILL_EXISTS') throw error;
    // A missing file is the expected state for a new skill.
  }
  const text = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
  await mkdir(dir, { recursive: true });
  await atomicWrite(path, text);
  return { path, hash: hash(text) };
}

/** Replace a skill file when its current text still hashes to the baseline the caller read. */
export async function adoptSkill(input: {
  workspace: string; path: string; candidate: string; baselineHash: string; home?: string; stateDir?: string; now?: string;
}): Promise<SkillWriteResult> {
  const path = assertSkillPath(input.workspace, input.path, input.home);
  const stateDir = input.stateDir ?? skillStateDir();
  validate(input.candidate);
  const current = await readFile(path, 'utf8');
  if (hash(current) !== input.baselineHash) throw skillError('SKILL_CHANGED');
  const now = input.now ?? new Date().toISOString();
  const version = await remember(stateDir, path, current, 'adopt', now);
  await atomicWrite(path, input.candidate);
  return { hash: hash(input.candidate), version };
}

/** Put a stored version back; the current text is stored first, so a restore is itself reversible. */
export async function restoreSkill(input: {
  workspace: string; path: string; versionId: string; baselineHash: string; home?: string; stateDir?: string; now?: string;
}): Promise<SkillWriteResult> {
  const path = assertSkillPath(input.workspace, input.path, input.home);
  const stateDir = input.stateDir ?? skillStateDir();
  const current = await readFile(path, 'utf8');
  if (hash(current) !== input.baselineHash) throw skillError('SKILL_CHANGED');
  const index = await readIndex(stateDir);
  const entry = (index.skills[path] ?? []).find(item => item.id === input.versionId);
  if (entry === undefined) throw skillError('NOT_FOUND');
  const text = await readFile(entry.file, 'utf8');
  validate(text);
  const now = input.now ?? new Date().toISOString();
  const version = await remember(stateDir, path, current, 'restore', now);
  await atomicWrite(path, text);
  return { hash: hash(text), version };
}
