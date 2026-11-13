// Host build: bundle the Host half into `lib/ui/index.js`.
// The Host half imports the shared client from `packages/client` with a relative path (the plugin
// package is outside the workspace), so the packaged copy must carry that code: esbuild inlines it.
// The prompt-injection entry stays the hand-written `lib/index.js`, which imports the shared
// configuration module from `lib/`; that module is copied here so both halves load one file.
//
// The build identity is stamped into this bundle and into `lib/client.js`. The two are loaded at
// different moments, so the value is what lets either half tell whether the other is current.
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCarriesBuildId, buildId } from './build-id.ts';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, 'package.json'));
const esbuild = require('esbuild');

const id = await buildId(here);
const define = { __MNEMOWEAVE_BUILD__: JSON.stringify(id) };

await mkdir(join(here, 'lib', 'ui'), { recursive: true });
// Copied before bundling: the Host half imports the same file, and shipping a stale copy would
// reintroduce exactly the two-readers-disagree problem this module exists to remove.
await copyFile(join(here, 'src', 'shared', 'host-config.js'), join(here, 'lib', 'host-config.js'));
await esbuild.build({
  entryPoints: [join(here, 'src/ui/index.ts')],
  outfile: join(here, 'lib', 'ui', 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  charset: 'utf8',
  legalComments: 'none',
  define,
  logLevel: 'warning',
});
await assertCarriesBuildId(join(here, 'lib', 'ui', 'index.js'), id);
process.stdout.write(`host bundle written: lib/ui/index.js (build ${id}, shared config: lib/host-config.js)\n`);
