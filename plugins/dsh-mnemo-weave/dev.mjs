// Development loop for the DSH package: rebuild both halves whenever `src/` changes.
// The running Host half notices `lib/` changing and asks DSH to recompose (see src/ui/hot-reload.ts);
// the browser picks up `lib/client.js` on the next page refresh.
//
//   node plugins/dsh-mnemo-weave/dev.mjs          # watch
//   node plugins/dsh-mnemo-weave/dev.mjs --once   # single build, then exit
//
// Build failures are printed and the watcher keeps running: a half-written change should not
// kill the loop. `DSH_MNEMO_WEAVE_HOT_RELOAD=0` only affects the in-Host watcher, not this script.
import { watch, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const once = process.argv.includes('--once');
const stamp = () => new Date().toLocaleTimeString('en-GB', { hour12: false });

function build(script) {
  execFileSync(process.execPath, [join(here, script)], { stdio: 'inherit', cwd: here });
}

function runBuild(why) {
  process.stdout.write(`[${stamp()}] build: ${why}\n`);
  try {
    build('build.mjs');
    build('build-client.mjs');
    process.stdout.write(`[${stamp()}] build ok\n`);
  } catch (error) {
    process.stderr.write(`[${stamp()}] build failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}\n`);
  }
}

runBuild(once ? 'initial' : 'initial (watch mode)');
if (once) process.exit(0);

const src = join(here, 'src');
if (!existsSync(src)) {
  process.stderr.write(`[${stamp()}] src/ is missing; nothing to watch\n`);
  process.exit(1);
}
let timer;
let stopped = false;

const schedule = (_event, file) => {
  if (stopped || file === null) return;
  if (!/\.(ts|tsx)$/u.test(String(file).replaceAll('\\', '/'))) return;
  clearTimeout(timer);
  timer = setTimeout(() => { timer = undefined; runBuild(String(file).replaceAll('\\', '/')); }, 150);
};

const watcher = watch(src, { recursive: true }, schedule);
watcher.on('error', error => process.stderr.write(`[${stamp()}] watcher error: ${error.message}\n`));
process.stdout.write(`[${stamp()}] watching ${src} (Ctrl+C to stop)\n`);

const stop = () => {
  if (stopped) return;
  stopped = true;
  clearTimeout(timer);
  try { watcher.close(); } catch { /* already closed */ }
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
