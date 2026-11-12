import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { rmSync, rmdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * One place where tests create and reclaim their scratch directories.
 *
 * Before this existed every test called `mkdtemp` itself with its own prefix under `work/`, and
 * almost none of them removed anything: a single unit+contract run left about 1 GB and hundreds of
 * directories behind, growing without bound. A test that leaks its store is not merely untidy -
 * the leaked Mnemon stores and governance databases are the size of the artifacts they exercise.
 *
 * Two properties matter:
 *
 * - Everything lives under `work/tmp/<suite>/`, so the whole tree can be reclaimed without
 *   touching artifacts a developer keeps deliberately (`work/tools`, `work/demo-store`, the
 *   dependency caches).
 * - Reclaiming happens on process exit. Registering `after()` lazily from inside a test body does
 *   not work: by the time the first test calls in, that test is already running, and the runner
 *   has finished collecting root-level hooks. `process.on('exit')` is the only point that is both
 *   unconditionally reached and late enough to see every directory.
 *
 * `MW_KEEP_TEMP=1` keeps the directories and prints where they are, which is the one case where a
 * failing test should leave evidence on disk.
 */

const ROOT = resolve('work', 'tmp');
const KEEP = process.env['MW_KEEP_TEMP'] === '1';
const created = new Set<string>();
/** Per-suite parents this process made. Removed only when they end up empty. */
const parents = new Set<string>();

/** Directories this process made, so the sweep only removes what it owns. */
function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once('exit', () => {
    if (KEEP) {
      if (created.size > 0) {
        const sample = [...created].slice(0, 3).join(', ');
        process.stderr.write(`MW_KEEP_TEMP=1: kept ${created.size} test director${created.size === 1 ? 'y' : 'ies'} under work/tmp (${sample}${created.size > 3 ? ', …' : ''})\n`);
      }
      return;
    }
    // The exit handler must be synchronous: a promise would not be awaited.
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    created.clear();
    for (const parent of parents) { try { rmdirSync(parent); } catch { /* in use or gone */ } }
    parents.clear();
    try { rmdirSync(ROOT); } catch { /* another suite parent remains */ }
  });
}
let cleanupRegistered = false;

/**
 * A fresh directory under `work/tmp/<suite>/`, reclaimed when the file's tests finish.
 *
 * `suite` groups one file's directories so a leftover tree is traceable to its test file. The
 * prefix keeps the per-case kind readable in a listing.
 */
export async function tempDir(suite: string, prefix: string): Promise<string> {
  const parent = resolve(ROOT, suite);
  await mkdir(parent, { recursive: true });
  parents.add(parent);
  registerCleanup();
  const dir = await mkdtemp(resolve(parent, `${prefix}-`));
  created.add(dir);
  return dir;
}

/** Remove the directories this process created. Safe to await from a test that cleans up early. */
export async function sweepCreated(): Promise<void> {
  const targets = [...created];
  created.clear();
  for (const dir of targets) await rm(dir, { recursive: true, force: true });
  // Only this process's own suite parents: test files run in parallel processes, so removing the
  // whole `work/tmp` would delete directories another file is still using. `rmdir` on a non-empty
  // parent fails harmlessly, which keeps a second process's tree intact.
  for (const parent of parents) {
    try { rmdirSync(parent); } catch { /* still in use, or already gone */ }
  }
  parents.clear();
  try { rmdirSync(ROOT); } catch { /* other suite parents remain */ }
}

/**
 * Remove everything under `work/tmp`, including trees left by a run that was killed before its
 * `after` hook could run. Only that subtree is touched.
 */
export async function sweepAllTemp(): Promise<void> {
  await rm(ROOT, { recursive: true, force: true });
}
