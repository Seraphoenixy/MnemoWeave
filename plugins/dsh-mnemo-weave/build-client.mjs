// Client build: one CJS bundle in the shape DSH's web plugin loader registers.
// React and DSH client services stay external; the loader supplies them at runtime.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, 'package.json'));
const esbuild = require('esbuild');
const pkg = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));

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
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});

const body = result.outputFiles.map(file => file.text).join('');
await mkdir(join(here, 'lib'), { recursive: true });
await writeFile(join(here, 'lib/client.js'), `${banner}${body}${footer}`, 'utf8');
process.stdout.write(`client bundle written: lib/client.js (${(banner.length + body.length + footer.length) / 1024 | 0} KiB)\n`);
