import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const credential = z.object({ baseUrl: z.url(), deviceId: z.uuid(), token: z.string().min(32) });

function protect(value: string, decrypt: boolean): string {
  if (process.platform !== 'win32') throw new Error('Sync credential storage requires Windows');
  const command = decrypt
    ? '$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd()); [Console]::Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, "CurrentUser")))'
    : '$bytes = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Console]::Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes, $null, "CurrentUser")))';
  const script = '$ErrorActionPreference = "Stop"; [void][Reflection.Assembly]::LoadWithPartialName("System.Security"); ' + command;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    input: value, encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  if (result.status !== 0 || !result.stdout) throw new Error('Windows sync credential protection failed');
  return result.stdout;
}

export function readSyncCredential(stateDir: string) {
  const path = join(stateDir, 'sync-credential.dpapi');
  if (!existsSync(path)) return undefined;
  return credential.parse(JSON.parse(protect(readFileSync(path, 'utf8'), true)));
}

export function saveSyncCredential(stateDir: string, value: z.infer<typeof credential>) {
  const encrypted = protect(JSON.stringify(credential.parse(value)), false);
  mkdirSync(stateDir, { recursive: true });
  const temporary = join(stateDir, 'sync-credential.' + randomUUID());
  writeFileSync(temporary, encrypted, { flag: 'wx' });
  try {
    renameSync(temporary, join(stateDir, 'sync-credential.dpapi'));
  } finally {
    rmSync(temporary, { force: true });
  }
}
