// Builds importable plugin directories under dist/plugins/.
//   node scripts/build-plugins.mjs
// Each plugin gets its own folder (select it in the host's marketplace/import dialog).
// dist/ is gitignored; rebuild after code changes.
//
// The previous version deleted dist/plugins up front and rebuilt it in place. A host profile can
// point a junction at one of those folders, and while the target was gone the host saw a missing
// package — which surfaces as a blank page rather than an install error, because the module was
// already registered and never re-evaluated. The build now assembles the whole tree in a staging
// directory beside the real one and swaps it in with a rename, so dist/plugins is either the old
// complete tree or the new complete tree and never absent.
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

/**
 * Remove entries the new build does not contain.
 *
 * Used by the in-place path, which overwrites each file but leaves behind whatever an earlier
 * build produced. Files only the old tree has are output of a build that no longer exists; leaving
 * them would let a stale bundle sit beside the current one.
 */
function prune(target, reference) {
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const path = join(target, entry.name);
    const keep = join(reference, entry.name);
    if (!existsSync(keep)) { rmSync(path, { recursive: true, force: true }); continue; }
    if (entry.isDirectory()) prune(path, keep);
  }
}

const root = resolve(process.cwd());
const runtime = join(root, 'dist');
if (!existsSync(runtime)) throw new Error('dist not found; run node node_modules/typescript/bin/tsc first');

const plugins = ['zcode-mnemo-weave', 'chatgpt-mnemo-weave', 'dsh-mnemo-weave'];
const output = join(runtime, 'plugins');
const staging = join(root, 'work', 'plugin-build');
const assembled = join(staging, 'plugins');

// Only the scratch area is cleared up front. The published tree stays untouched until it is
// complete in staging and can be moved into place in one step.
rmSync(staging, { recursive: true, force: true });
mkdirSync(assembled, { recursive: true });

for (const name of plugins) {
  const source = join(root, 'plugins', name);
  if (!existsSync(source)) throw new Error(`plugin directory missing: ${source}`);
  // The DSH package ships source-built halves: the UI Host entry and the browser bundle.
  if (name === 'dsh-mnemo-weave') {
    execFileSync(process.execPath, [join(source, 'build.mjs')], { stdio: 'inherit' });
    execFileSync(process.execPath, [join(source, 'build-client.mjs')], { stdio: 'inherit' });
  }
  const stage = join(staging, name);
  cpSync(source, stage, { recursive: true, filter: path => !path.includes(`${join('plugins', name, 'dist')}`) });
  // Host hooks/MCP launch the compiled server and adapters from inside the plugin folder. The
  // published environment file belongs to the deployment, not to a plugin copy: shipping it
  // would give every plugin its own stale paths.
  if (name !== 'dsh-mnemo-weave') {
    cpSync(runtime, join(stage, 'dist'), {
      recursive: true,
      filter: path => !path.startsWith(output) && !path.startsWith(staging) && !path.endsWith('.env.local-server') && !path.includes(`${join('dist', 'data')}`),
    });
  }
  cpSync(stage, join(assembled, name), { recursive: true });
}

cpSync(join(root, 'plugins', 'README.md'), join(assembled, 'README.md'));
cpSync(join(root, 'plugins', 'marketplace.json'), join(assembled, 'marketplace.json'));

// Swap. The old tree is moved aside first (a rename, not a delete), so a failure between the two
// steps leaves the previous build recoverable rather than erased.
//
// A rename of the top directory can fail with EPERM while the Host holds files under it: DSH keeps
// the plugin's own `lib/` open and the profile junction points here. The fallback copies each file
// over the existing tree instead, which the Host tolerates, and is only reached when the rename is
// refused — so a clean build still swaps a whole tree in one step.
const previous = join(staging, 'plugins.previous');
let swapped = false;
if (existsSync(output)) {
  try {
    renameSync(output, previous);
    swapped = true;
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') throw error;
    process.stdout.write(`in-place update: ${output} is in use, copying over it\n`);
  }
}
if (swapped) {
  try {
    renameSync(assembled, output);
  } catch (error) {
    if (existsSync(previous) && !existsSync(output)) renameSync(previous, output);
    throw error;
  }
  rmSync(previous, { recursive: true, force: true });
} else {
  // Every file is replaced; files the new build does not have are removed so the tree does not
  // accumulate output from earlier builds.
  cpSync(assembled, output, { recursive: true, force: true });
  prune(output, assembled);
}
rmSync(staging, { recursive: true, force: true });

for (const name of plugins) process.stdout.write(`built ${join(output, name)}\n`);
process.stdout.write(`built ${output}\n`);
