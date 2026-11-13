import { isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireSyncCredential } from '../../../packages/infrastructure/sync-client/src/enrollment.ts';
import { syncBaseUrl } from '../../../packages/infrastructure/sync-client/src/index.ts';
import { readSyncCredential, saveSyncCredential } from './sync-credential.ts';

try {
  const [mode, baseUrl, label] = process.argv.slice(2);
  const stateDir = process.env['MNEMOWEAVE_STATE_DIR'];
  if (!stateDir || !isAbsolute(stateDir)) throw new Error('Set MNEMOWEAVE_STATE_DIR to the local Server state directory');
  if (mode === 'pairing-token') {
    const credential = readSyncCredential(stateDir);
    if (!credential) throw new Error('Enroll this device first');
    const response = await fetch(syncBaseUrl(credential.baseUrl) + '/v1/sync/devices/pairing-token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { authorization: 'Bearer ' + credential.token },
    });
    if (!response.ok) throw new Error('Pairing token request failed (HTTP ' + response.status + ')');
    process.stdout.write(await response.text() + '\n');
  } else {
    if ((mode !== 'initialize' && mode !== 'login' && mode !== 'pair') || !baseUrl || !label) {
      throw new Error('Usage: sync-enroll <initialize|login|pair> <server-url> <label> | pairing-token');
    }
    if (process.platform !== 'win32' || !process.stdin.isTTY) throw new Error('Enrollment requires an interactive Windows terminal');
    const prompt = (description: string) => {
      const command = '$ErrorActionPreference = "Stop"; $secret = Read-Host "' + description + '" -AsSecureString; [Console]::Write([System.Net.NetworkCredential]::new("", $secret).Password)';
      const result = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
        stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8', windowsHide: true,
      });
      if (result.status !== 0 || !result.stdout) throw new Error('Enrollment input cancelled');
      return result.stdout;
    };
    const secret = prompt(mode === 'pair' ? 'Pairing token' : 'Master password');
    const bootstrap = mode === 'initialize' ? { bootstrapToken: prompt('Server bootstrap token') } : {};
    const credential = await acquireSyncCredential({ mode, baseUrl, label, secret, ...bootstrap });
    saveSyncCredential(stateDir, credential);
    process.stdout.write(`Device enrolled: ${credential.deviceId}. Restart the local Server.\n`);
  }
} catch (error) {
  // Validation errors and fetch exceptions can carry remote response details.
  const message = error instanceof Error && error.constructor === Error ? error.message : 'Enrollment failed';
  process.stderr.write(message + '\n');
  process.exitCode = 1;
}
