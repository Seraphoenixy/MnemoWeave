/**
 * Persisted skill drafts.
 *
 * A draft records the workspace and the skill path it was reviewed against, so switching
 * projects never re-points it at another file. The store is a single JSON file written
 * atomically; a corrupted file reads as empty rather than throwing into the page.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UiSkillDraft, UiSkillVersion } from '../shared/contract.ts';
import { adoptSkill, skillStateDir } from './skills-write.ts';

const MAX_DRAFTS = 100;

interface Store { version: 1; drafts: UiSkillDraft[] }

async function readStore(stateDir: string): Promise<Store> {
  try {
    const parsed = JSON.parse(await readFile(join(stateDir, 'drafts.json'), 'utf8')) as Store;
    if (parsed.version === 1 && Array.isArray(parsed.drafts)) return parsed;
  } catch { /* a missing or unreadable file starts empty */ }
  return { version: 1, drafts: [] };
}

async function writeStore(stateDir: string, store: Store): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const temporary = join(stateDir, `drafts.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await rename(temporary, join(stateDir, 'drafts.json'));
}

export async function saveSkillDraft(input: Omit<UiSkillDraft, 'id' | 'createdAt' | 'adoptedAt' | 'dismissedAt'>, stateDir: string = skillStateDir()): Promise<UiSkillDraft> {
  const store = await readStore(stateDir);
  const draft: UiSkillDraft = { ...input, id: randomUUID(), createdAt: new Date().toISOString(), adoptedAt: null, dismissedAt: null };
  store.drafts = [draft, ...store.drafts].slice(0, MAX_DRAFTS);
  await writeStore(stateDir, store);
  return draft;
}

export async function listSkillDrafts(input: { stateDir?: string; workspace?: string; skillPath?: string } = {}): Promise<UiSkillDraft[]> {
  const store = await readStore(input.stateDir ?? skillStateDir());
  return store.drafts
    .filter(draft => input.workspace === undefined || draft.workspace === input.workspace)
    .filter(draft => input.skillPath === undefined || draft.skillPath === input.skillPath);
}

export async function dismissSkillDraft(id: string, stateDir: string = skillStateDir()): Promise<UiSkillDraft> {
  const store = await readStore(stateDir);
  const draft = store.drafts.find(item => item.id === id);
  if (draft === undefined) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  draft.dismissedAt = new Date().toISOString();
  await writeStore(stateDir, store);
  return draft;
}

export async function markSkillDraftAdopted(id: string, stateDir: string = skillStateDir()): Promise<UiSkillDraft> {
  const store = await readStore(stateDir);
  const draft = store.drafts.find(item => item.id === id);
  if (draft === undefined) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  draft.adoptedAt = new Date().toISOString();
  await writeStore(stateDir, store);
  return draft;
}

/** Adopt a stored draft through the same baseline-checked write a manual adoption uses. */
export async function adoptStoredDraft(input: {
  id: string; baselineHash: string; stateDir?: string;
}): Promise<{ draft: UiSkillDraft; hash: string; version: UiSkillVersion }> {
  const stateDir = input.stateDir ?? skillStateDir();
  const store = await readStore(stateDir);
  const draft = store.drafts.find(item => item.id === input.id);
  if (draft === undefined) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  if (draft.skillPath === null) throw Object.assign(new Error('SKILL_PATH_INVALID'), { code: 'SKILL_PATH_INVALID' });
  if (draft.adoptedAt !== null) throw Object.assign(new Error('INVALID_STATE'), { code: 'INVALID_STATE' });
  if (draft.dismissedAt !== null) throw Object.assign(new Error('INVALID_STATE'), { code: 'INVALID_STATE' });
  const written = await adoptSkill({ workspace: draft.workspace, path: draft.skillPath, candidate: draft.candidate, baselineHash: input.baselineHash, stateDir });
  draft.adoptedAt = new Date().toISOString();
  await writeStore(stateDir, store);
  return { draft, hash: written.hash, version: written.version };
}
