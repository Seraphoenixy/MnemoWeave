// Host build: Emit the read-only page's Host half as ESM the DSH Host imports from `lib/ui/index.js`.
// The legacy prompt-injection entry stays the hand-written `lib/index.js`.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const tsc = join(here, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc');
const result = spawnSync(process.execPath, [tsc, '-p', join(here, 'tsconfig.host.json')], { stdio: 'inherit' });
process.exit(result.status ?? 1);
