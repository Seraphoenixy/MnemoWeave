/**
 * Explicit registration of the "MnemoWeave Local Server" scheduled task.
 *
 * Registration is the one action that asks for elevation, so it only runs when a person asks for
 * it: the settings page button and the install step call this module. Hosts never call it from
 * their connection path — a host that finds no task reports `task_missing` instead of raising a
 * prompt.
 *
 * The elevation request is put in the user's own session by a one-shot scheduled task
 * (`request-registration-task.ps1`), not raised from a plugin process.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_SERVER_TASK_NAME, queryLocalServerTask, runLocalServerTask } from './ensure-server.ts';

/** Where the published Server, its environment file and its scripts live. */
export interface LocalServerRegistration {
  serverDir: string;
  envFile: string;
  nodeExe?: string;
}

export interface RegistrationOutcome {
  result: 'registered' | 'already_registered' | 'denied' | 'failed';
  detail?: string;
}

/** The pointer `scripts/publish-server.mjs` writes so every host plugin agrees on one publish. */
export function localServerPointerPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const base = env['LOCALAPPDATA']?.trim();
  if (base === undefined || base === '') return undefined;
  return join(base, 'MnemoWeave', 'local-server.json');
}

/**
 * Resolve the published directory: explicit environment first, then the pointer file.
 * A broken pointer resolves to nothing rather than throwing.
 */
export function resolveLocalServerRegistration(env: NodeJS.ProcessEnv = process.env): LocalServerRegistration | undefined {
  const serverDir = env['MNEMOWEAVE_SERVER_DIR']?.trim();
  const envFileFromEnv = env['MNEMOWEAVE_ENV_FILE']?.trim();
  const nodeExeFromEnv = env['MNEMOWEAVE_NODE_EXE']?.trim();
  if (serverDir !== undefined && serverDir !== '') {
    return {
      serverDir,
      envFile: envFileFromEnv === undefined || envFileFromEnv === '' ? join(serverDir, '.env.local-server') : envFileFromEnv,
      ...(nodeExeFromEnv === undefined || nodeExeFromEnv === '' ? {} : { nodeExe: nodeExeFromEnv }),
    };
  }
  const pointer = localServerPointerPath(env);
  if (pointer === undefined || !existsSync(pointer)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(pointer, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    const dir = typeof record['serverDir'] === 'string' ? record['serverDir'].trim() : '';
    if (dir === '') return undefined;
    const file = typeof record['envFile'] === 'string' && record['envFile'].trim() !== ''
      ? record['envFile'].trim()
      : join(dir, '.env.local-server');
    const node = typeof record['nodeExe'] === 'string' && record['nodeExe'].trim() !== '' ? record['nodeExe'].trim() : undefined;
    return { serverDir: dir, envFile: file, ...(node === undefined ? {} : { nodeExe: node }) };
  } catch {
    return undefined;
  }
}

function parseOutcome(value: unknown): { state: 'ok' | 'denied' | 'failed'; detail: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const state = record['state'];
  if (state !== 'ok' && state !== 'denied' && state !== 'failed') return undefined;
  return { state, detail: typeof record['detail'] === 'string' ? record['detail'].slice(0, 300) : '' };
}

/**
 * Ask for the task once, then start it so the caller can observe the Server coming up.
 *
 * Everything that can fail without a prompt — an unpublished directory, a missing environment
 * file — is checked first. `already_registered` is answered without running anything.
 */
export async function registerLocalServerTask(
  target: LocalServerRegistration,
  deps: { taskExists?: (taskName: string) => Promise<boolean> } = {},
): Promise<RegistrationOutcome> {
  if (process.platform !== 'win32') return { result: 'failed', detail: 'scheduled tasks are only registered on Windows' };
  const taskExists = deps.taskExists ?? queryLocalServerTask;
  if (await taskExists(LOCAL_SERVER_TASK_NAME)) return { result: 'already_registered' };

  const requestor = join(target.serverDir, 'scripts', 'request-registration-task.ps1');
  if (!existsSync(requestor)) {
    return { result: 'failed', detail: `registration script not found: ${requestor} (run node scripts/publish-server.mjs)` };
  }
  if (!existsSync(target.envFile)) {
    return { result: 'failed', detail: `environment file not found: ${target.envFile} (run node scripts/publish-server.mjs)` };
  }

  const resultFile = join(target.serverDir, '.registration-result.json');
  if (existsSync(resultFile)) {
    try { unlinkSync(resultFile); } catch { /* a stale result is overwritten by the request */ }
  }
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', requestor,
    '-ServerDir', target.serverDir, '-EnvFile', target.envFile, '-ResultFile', resultFile,
    ...(target.nodeExe === undefined ? [] : ['-NodeExe', target.nodeExe]),
  ];
  const outcome = await new Promise<{ state: 'ok' | 'denied' | 'failed'; detail: string }>((resolve) => {
    execFile('powershell.exe', args, { windowsHide: true, timeout: 240_000 }, (error, stdout) => {
      if (error !== null && error !== undefined && (error as { killed?: boolean }).killed === true) {
        resolve({ state: 'failed', detail: 'the elevation request did not finish within 240 s' });
        return;
      }
      // The launcher prints one JSON line; the result file is the durable copy.
      let parsed: { state: 'ok' | 'denied' | 'failed'; detail: string } | undefined;
      for (const line of (stdout ?? '').split(/\r?\n/).reverse()) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try { parsed = parseOutcome(JSON.parse(trimmed) as unknown); } catch { parsed = undefined; }
        if (parsed !== undefined) break;
      }
      if (parsed === undefined) {
        try { parsed = parseOutcome(JSON.parse(readFileSync(resultFile, 'utf8')) as unknown); } catch { parsed = undefined; }
      }
      if (parsed === undefined) {
        resolve({ state: 'failed', detail: (error?.message ?? '').trim().slice(0, 200) || 'registration produced no result' });
        return;
      }
      resolve(parsed);
    });
  });

  if (outcome.state === 'ok') {
    // Start it now so the page's next status call watches the Server boot instead of waiting for
    // the next sign-in. A refused start is reported by the status call, not by registration.
    await runLocalServerTask(LOCAL_SERVER_TASK_NAME);
    return { result: 'registered' };
  }
  if (outcome.state === 'denied') {
    return { result: 'denied', detail: outcome.detail === '' ? 'the elevation prompt was declined' : outcome.detail };
  }
  return { result: 'failed', detail: outcome.detail === '' ? 'registration failed' : outcome.detail };
}
