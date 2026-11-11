/**
 * DSH skill discovery.
 *
 * DSH loads `SKILL.md` folders from four roots, and the first root that defines a name wins:
 * the project's `.dsh/skills` and `.agents/skills`, then the user's `~/.dsh/skills` and
 * `~/.agents/skills`. This module only reads and validates; writing a skill is a separate,
 * versioned operation.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SkillRoot { path: string; scope: 'project' | 'user' }

export interface SkillEntry {
  name: string;
  description: string;
  path: string;
  root: string;
  scope: 'project' | 'user';
  hash: string;
  bodyBytes: number;
  /** Set when an earlier root already defines this name; the earlier entry stays loadable. */
  shadowedBy?: string;
}

export interface SkillReport {
  items: SkillEntry[];
  invalid: Array<{ path: string; reason: string }>;
  roots: string[];
}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function skillRoots(workspace: string, home: string = homedir()): SkillRoot[] {
  return [
    { path: join(workspace, '.dsh', 'skills'), scope: 'project' },
    { path: join(workspace, '.agents', 'skills'), scope: 'project' },
    { path: join(home, '.dsh', 'skills'), scope: 'user' },
    { path: join(home, '.agents', 'skills'), scope: 'user' },
  ];
}

/** The Agent Skills frontmatter subset this page needs; anything unresolved is reported, not guessed. */
export function frontmatter(text: string): { name?: string; description?: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (match === null) return { body: text };
  const fields: { name?: string; description?: string } = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^(name|description):\s*(.+)$/.exec(line.trim());
    if (field === null) continue;
    const value = field[2]!.trim().replace(/^["']|["']$/g, '');
    fields[field[1] as 'name' | 'description'] = value;
  }
  return { ...fields, body: match[2]! };
}

export async function listSkills(workspace: string, home?: string): Promise<SkillReport> {
  const roots = skillRoots(workspace, home);
  const items: SkillEntry[] = [];
  const invalid: Array<{ path: string; reason: string }> = [];
  const seen = new Map<string, string>();
  for (const root of roots) {
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await readdir(root.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(root.path, entry.name);
      const path = join(dir, 'SKILL.md');
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch {
        invalid.push({ path, reason: 'missing-skill-md' });
        continue;
      }
      const parsed = frontmatter(text);
      if (parsed.name === undefined || parsed.description === undefined) { invalid.push({ path, reason: 'missing-frontmatter' }); continue; }
      if (!NAME.test(parsed.name)) { invalid.push({ path, reason: 'invalid-name' }); continue; }
      if (parsed.description.trim() === '') { invalid.push({ path, reason: 'missing-description' }); continue; }
      if (parsed.body.trim() === '') { invalid.push({ path, reason: 'empty-body' }); continue; }
      const shadow = seen.get(parsed.name);
      if (shadow !== undefined) { invalid.push({ path, reason: `shadowed-by:${shadow}` }); continue; }
      seen.set(parsed.name, path);
      items.push({
        name: parsed.name, description: parsed.description, path, root: root.path, scope: root.scope,
        hash: createHash('sha256').update(text).digest('hex'), bodyBytes: Buffer.byteLength(parsed.body, 'utf8'),
      });
    }
  }
  return { items, invalid, roots: roots.map(root => root.path) };
}
