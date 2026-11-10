import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Locate a runnable Mnemon 0.2.13 executable.
 *
 * On Windows the PATH entry is a `.cmd` shim, which `execFile` cannot spawn without
 * a shell, so the native `mnemon.exe` is preferred when present. Every candidate is
 * probed with `--version`; a candidate that cannot run is skipped, and an empty
 * result is reported as a missing environment instead of a silent pass.
 */
export function mnemonBinary(): string {
  const appData = process.env['APPDATA'];
  const candidates = [
    process.env['MNEMON_BINARY']?.trim(),
    resolve('work/tools/mnemon/mnemon.exe'),
    appData ? resolve(appData, 'npm/node_modules/@mnemon-dev/mnemon/node_modules/@mnemon-dev/mnemon-win32-x64/bin/mnemon.exe') : undefined,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore', timeout: 10000 });
      return candidate;
    } catch {
      // Try the next candidate: an unusable path must not silently become the chosen binary.
    }
  }
  throw new Error('Mnemon CLI unavailable: set MNEMON_BINARY to a runnable Mnemon 0.2.13 executable');
}
