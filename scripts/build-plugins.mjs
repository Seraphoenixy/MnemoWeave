// Builds importable plugin directories under dist/plugins/.
//   node scripts/build-plugins.mjs
// Each plugin gets its own folder (select it in the host's marketplace/import dialog).
// dist/ is gitignored; rebuild after code changes.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(process.cwd());
const runtime = join(root, 'dist');
if (!existsSync(runtime)) throw new Error('dist not found; run node node_modules/typescript/bin/tsc first');

const plugins = ['zcode-mnemo-weave', 'chatgpt-mnemo-weave', 'dsh-mnemo-weave'];
const output = join(runtime, 'plugins');
const staging = join(root, 'work', 'plugin-build');

rmSync(output, { recursive: true, force: true });
rmSync(staging, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

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
  // Host hooks/MCP launch the compiled server and adapters from inside the plugin folder.
  if (name !== 'dsh-mnemo-weave') cpSync(runtime, join(stage, 'dist'), { recursive: true, filter: path => !path.startsWith(output) });
  cpSync(stage, join(output, name), { recursive: true });
  process.stdout.write(`built ${join(output, name)}\n`);
}

cpSync(join(root, 'plugins', 'README.md'), join(output, 'README.md'));
cpSync(join(root, 'plugins', 'marketplace.json'), join(output, 'marketplace.json'));
process.stdout.write(`built ${output}\n`);
