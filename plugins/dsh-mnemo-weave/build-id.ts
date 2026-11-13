// One build identity stamped into both halves of the DSH plugin.
//
// The two halves load at different times: `lib/ui/index.js` is evaluated when the Host composes
// the plugin at startup, while `lib/client.js` is fetched from disk when the page loads. Rebuild
// the plugin without restarting DSH and the page runs new code against a Host still running the
// old one — which shows up as a method that does not exist, or a component that renders nothing,
// never as a message that says "the Host is out of date". A shared identity is what makes that
// state observable instead of guessed at.
//
// The identity is a hash of the sources, not a timestamp: the built files stay byte-identical for
// identical sources, so rebuilding without changes does not churn the output.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Hash every source file of one plugin directory.
 *
 * Paths are hashed alongside contents so that moving a file changes the identity, and the walk is
 * sorted so the same tree always produces the same value. Only sources count: hashing the build
 * output would be circular.
 */
export async function buildId(pluginDir: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!/\.(ts|tsx|js|mjs|css)$/.test(entry.name)) continue;
      // lib/ holds build output; including it would make the identity depend on the last build.
      if (path.includes(`${join(pluginDir, 'lib')}`)) continue;
      hash.update(path.slice(pluginDir.length).replaceAll('\\', '/'));
      hash.update('\0');
      hash.update(await readFile(path));
      hash.update('\0');
    }
  };
  await walk(join(pluginDir, 'src'));
  return hash.digest('hex').slice(0, 12);
}

/**
 * Fail the build when a bundle does not carry the identity.
 *
 * esbuild's `define` is a silent no-op when the identifier is never referenced, so a dropped
 * reference would leave the two halves unable to compare themselves — exactly the state this
 * exists to detect. That failure belongs in the build, not in front of a user.
 */
export async function assertCarriesBuildId(file: string, id: string): Promise<void> {
  const text = await readFile(file, 'utf8');
  if (!text.includes(id)) {
    throw new Error(`${file} does not carry the build identity ${id}; check that __MNEMOWEAVE_BUILD__ is still referenced`);
  }
}
