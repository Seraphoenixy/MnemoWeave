// Client build: one CJS bundle in the shape DSH's web plugin loader registers.
// React and DSH client services stay external; the loader supplies them at runtime.
//
// esbuild transpiles without type-checking, so an undefined identifier survives the build and
// throws at render time — a blank page rather than a failed build. The root tsconfig excludes
// src/client/, so this is the only place the client half is type-checked: it runs first, and a
// type error stops the build.
//
// The build identity stamped here is also stamped into `lib/ui/index.js`. The page fetches this
// file at load time while the Host was composed at startup, so when the two disagree the page can
// say so instead of failing in some way that only looks like a bug in the plugin.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCarriesBuildId, buildId } from './build-id.ts';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, 'package.json'));
const esbuild = require('esbuild');
const pkg = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));

execFileSync(process.execPath, [
  join(here, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc'),
  '-p', join(here, 'tsconfig.client.json'), '--noEmit',
], { stdio: 'inherit' });
process.stdout.write('client typecheck ok\n');

const id = await buildId(here);

const banner = `window.__ModuleLoader__.load({\n`
  + `\tid: ${JSON.stringify(pkg.name)},\n`
  + `\tfactory: (require) => {\n`
  + `\t\tvar module = { exports: {} };\n`
  + `\t\tvar exports = module.exports;\n`
  + `\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n`;
const footer = `\n\t\treturn module.exports;\n\t}\n});\n`;

const result = await esbuild.build({
  entryPoints: [join(here, 'src/client/index.tsx')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  charset: 'utf8',
  legalComments: 'none',
  external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/*'],
  define: { 'process.env.NODE_ENV': '"production"', __MNEMOWEAVE_BUILD__: JSON.stringify(id) },
  logLevel: 'warning',
});

const body = result.outputFiles.map(file => file.text).join('');
await mkdir(join(here, 'lib'), { recursive: true });
await writeFile(join(here, 'lib/client.js'), `${banner}${body}${footer}`, 'utf8');
await assertCarriesBuildId(join(here, 'lib', 'client.js'), id);
process.stdout.write(`client bundle written: lib/client.js (${(banner.length + body.length + footer.length) / 1024 | 0} KiB, build ${id})\n`);
