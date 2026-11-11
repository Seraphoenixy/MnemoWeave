// Shared Host configuration for both DSH halves.
//
// Two places used to resolve the same settings independently: the page's Host half
// (`src/ui/index.ts`) and the prompt-injection hook (`lib/index.js`). They could disagree, so a
// setting could save successfully while the running code still read the other copy. This module
// is the single reader both import, and it reports which layer each value came from so the
// settings page can say who manages it.
//
// Resolution order (non-sensitive values): the stored preference, then the Cordis entry, then the
// environment, then the default. Credentials never come from the stored file: the token is only
// read from the entry (a protected profile file) or the environment.
//
// Plain JS on purpose: `lib/index.js` is loaded by DSH directly and cannot import TypeScript,
// while the Host half is bundled by esbuild. One file serves both.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:4317';
export const DEFAULT_HOST_ID = 'dsh';
export const DEFAULT_INJECT_TIMEOUT_MS = 1900;
export const DEFAULT_PAGE_SIZE = 25;
export const MIN_TOKEN_LENGTH = 24;
export const MIN_INJECT_TIMEOUT_MS = 250;
export const MAX_INJECT_TIMEOUT_MS = 1900;
export const LOCAL_SERVER_TASK_NAME = 'MnemoWeave Local Server';

const LOOPBACK = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?\/?$/i;

function pick(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Where preferences live. `MNEMOWEAVE_DSH_SETTINGS` overrides it for tests and odd profiles. */
export function settingsPath(env = process.env) {
  const override = pick(env.MNEMOWEAVE_DSH_SETTINGS);
  if (override !== undefined) return override;
  const profileDir = pick(env.DSH_PROFILE_DIR);
  if (profileDir !== undefined) return join(profileDir, 'mnemo-weave.settings.json');
  return join(homedir(), '.dsh', 'mnemo-weave.settings.json');
}

/** Preferences this page owns. Anything unknown is dropped rather than carried along. */
export const DEFAULT_PREFERENCES = {
  defaultTab: 'overview',
  pageSize: DEFAULT_PAGE_SIZE,
  injectTimeoutMs: DEFAULT_INJECT_TIMEOUT_MS,
  autoStart: true,
  // A connection the user saved from the settings page. Stored here rather than kept in the page
  // process only, so the prompt-injection hook resolves the same Server.
  serverUrl: null,
  hostId: null,
};

const TABS = new Set(['overview', 'memories', 'runtime', 'archives', 'skills', 'settings']);

/**
 * Validate a preference patch. A bad value is rejected with a message instead of being clamped
 * silently, so a save either lands as asked or says why it did not.
 */
export function validatePreferences(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('preferences must be an object');
  const next = {};
  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case 'defaultTab':
        // Sync moved from a page-level tab into the settings page; an old preference follows it
        // instead of being rejected (a rejected stored value would reset every preference).
        if (value === 'sync') { next.defaultTab = 'settings'; break; }
        if (typeof value !== 'string' || !TABS.has(value)) throw new Error('defaultTab must be a known tab');
        next.defaultTab = value;
        break;
      case 'defaultScope':
        // Retired: the memory list has no scope filter. A stored value is dropped instead of
        // rejected, so an existing preference file still loads.
        break;
      case 'pageSize':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 5 || value > 200) throw new Error('pageSize must be an integer between 5 and 200');
        next.pageSize = value;
        break;
      case 'projectId':
        // Retired with the injection project; see `defaultScope` above.
        break;
      case 'injectTimeoutMs':
        // The injection budget is part of the turn's 2-second deadline, so it cannot exceed it.
        if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_INJECT_TIMEOUT_MS || value > MAX_INJECT_TIMEOUT_MS) {
          throw new Error(`injectTimeoutMs must be an integer between ${MIN_INJECT_TIMEOUT_MS} and ${MAX_INJECT_TIMEOUT_MS}`);
        }
        next.injectTimeoutMs = value;
        break;
      case 'autoStart':
        if (typeof value !== 'boolean') throw new Error('autoStart must be a boolean');
        next.autoStart = value;
        break;
      case 'serverUrl':
        // Only a loopback address is ever accepted: the service token must not leave this machine.
        if (value !== null && (typeof value !== 'string' || !LOOPBACK.test(value.trim()))) throw new Error('serverUrl must be a loopback http(s) URL');
        next.serverUrl = value === null ? null : value.trim().replace(/\/$/, '');
        break;
      case 'hostId':
        if (value !== null && (typeof value !== 'string' || value.trim() === '' || value.trim().length > 200)) throw new Error('hostId must be null or 1–200 characters');
        next.hostId = value === null ? null : value.trim();
        break;
      default:
        throw new Error(`unknown preference: ${key.slice(0, 40)}`);
    }
  }
  return next;
}

/** Read the stored preferences; a missing or unreadable file yields the defaults. */
export function readPreferences(env = process.env) {
  const path = settingsPath(env);
  if (!existsSync(path)) return { ...DEFAULT_PREFERENCES, path };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const stored = parsed !== null && typeof parsed === 'object' && typeof parsed.preferences === 'object' && parsed.preferences !== null
      ? validatePreferences(parsed.preferences)
      : {};
    return { ...DEFAULT_PREFERENCES, ...stored, path };
  } catch {
    // A corrupt file must not brick the page; the defaults are the honest fallback.
    return { ...DEFAULT_PREFERENCES, path };
  }
}

/** Replace the stored preferences. Written atomically so a crash cannot leave half a file. */
export function writePreferences(patch, env = process.env) {
  const validated = validatePreferences(patch);
  const current = readPreferences(env);
  const { path, ...existing } = current;
  const next = { ...existing, ...validated };
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, preferences: next }, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
  return { ...next, path };
}

/**
 * Resolve the effective Host configuration.
 *
 * `sources` names the layer that supplied each value, which is what the settings page shows so a
 * saved value and the value actually in use can never be confused.
 */
export function resolveHostConfig(entryConfig, env = process.env, preferences = readPreferences(env)) {
  const entry = entryConfig !== null && typeof entryConfig === 'object' ? entryConfig : {};
  const sources = {};

  // A connection saved from the settings page wins, so the page and the injection hook cannot
  // end up pointing at different Servers.
  const storedServerUrl = pick(preferences.serverUrl);
  const entryServerUrl = pick(entry.serverUrl);
  const envServerUrl = pick(env.MNEMOWEAVE_SERVER);
  const serverUrl = (
    storedServerUrl ?? entryServerUrl ?? envServerUrl ?? DEFAULT_SERVER_URL
  ).replace(/\/$/, '');
  sources.serverUrl = storedServerUrl !== undefined ? 'preference' : entryServerUrl !== undefined ? 'profile' : envServerUrl !== undefined ? 'environment' : 'default';
  if (!LOOPBACK.test(serverUrl)) throw new Error('dsh-mnemo-weave serverUrl must be a loopback http(s) URL');

  const entryToken = pick(entry.token);
  const envToken = pick(env.MNEMOWEAVE_TOKEN);
  const token = entryToken ?? envToken;
  // The token value never leaves this function; only its layer and whether it exists.
  sources.token = entryToken !== undefined ? 'profile' : envToken !== undefined ? 'environment' : 'missing';

  // No operator credential is read here. This is a single-user deployment: the service token and
  // the Host header are the whole identity model, so the plugin never has to hold a second secret.

  const entryHost = pick(entry.hostId);
  const envHost = pick(env.MNEMOWEAVE_HOST_ID);
  const storedHost = pick(preferences.hostId);
  const hostId = storedHost ?? entryHost ?? envHost ?? DEFAULT_HOST_ID;
  sources.hostId = storedHost !== undefined ? 'preference' : entryHost !== undefined ? 'profile' : envHost !== undefined ? 'environment' : 'default';

  const entryProject = pick(entry.projectId);
  const envProject = pick(env.MNEMOWEAVE_PROJECT_ID);
  const storedProject = preferences.projectId ?? undefined;
  const projectId = storedProject ?? entryProject ?? envProject;
  sources.projectId = storedProject !== undefined ? 'preference' : entryProject !== undefined ? 'profile' : envProject !== undefined ? 'environment' : 'default';

  const entryTimeout = typeof entry.timeoutMs === 'number' ? entry.timeoutMs : undefined;
  const injectTimeoutMs = entryTimeout ?? preferences.injectTimeoutMs;
  sources.injectTimeoutMs = entryTimeout !== undefined ? 'profile' : 'preference';

  return {
    serverUrl,
    token,
    hostId,
    projectId,
    injectTimeoutMs: Math.min(Math.max(injectTimeoutMs, MIN_INJECT_TIMEOUT_MS), MAX_INJECT_TIMEOUT_MS),
    autoStart: preferences.autoStart,
    preferences: {
      defaultTab: preferences.defaultTab,
      pageSize: preferences.pageSize,
      path: preferences.path,
    },
    taskName: LOCAL_SERVER_TASK_NAME,
    sources,
  };
}

/** What the settings page may see: no token value, only whether one exists and where from. */export function describeHostConfig(resolved) {
  return {
    serverUrl: resolved.serverUrl,
    hostId: resolved.hostId,
    projectId: resolved.projectId ?? null,
    injectTimeoutMs: resolved.injectTimeoutMs,
    autoStart: resolved.autoStart,
    taskName: resolved.taskName,
    tokenStatus: {
      configured: resolved.token !== undefined && resolved.token.length >= MIN_TOKEN_LENGTH,
      source: resolved.sources.token,
    },
    preferences: resolved.preferences,
    sources: resolved.sources,
  };
}

/** The injection path may spend at most this long on a wake before the turn moves on. */
export const DEFAULT_WAKE_BUDGET_MS = 1_200;
const WAKE_PROBE_TIMEOUT_MS = 400;

/**
 * Make sure the local Server answers before a prompt is assembled.
 *
 * The page half already does this; without the same step here, a user who opens a session without
 * visiting the memory page gets no injection after the Server stops, even with auto-start enabled.
 *
 * Only a refused connection wakes the task. A timeout, a wrong token or a foreign service must not
 * start anything: those need a person, not another process.
 */
export async function ensureReachable(options = {}) {
  const {
    serverUrl,
    token,
    hostId,
    autoStart = true,
    budgetMs = DEFAULT_WAKE_BUDGET_MS,
    runTask = runServerTask,
    fetchImpl = fetch,
  } = options;
  if (typeof serverUrl !== 'string' || typeof token !== 'string') return { ready: false, woken: false, detail: 'no endpoint or token' };

  const probe = async () => {
    try {
      const response = await fetchImpl(`${serverUrl}/health/live`, {
        headers: { authorization: `Bearer ${token}`, 'x-mnemoweave-host': String(hostId ?? DEFAULT_HOST_ID) },
        signal: AbortSignal.timeout(WAKE_PROBE_TIMEOUT_MS),
      });
      // A rejected token still proves our Server is listening; a foreign service would not
      // identify itself, and that is checked by the caller's own request.
      return { ready: response.ok || response.status === 401, refused: false };
    } catch (error) {
      // `fetch` reports a refused connection through the cause chain.
      const code = error?.cause?.code ?? error?.code;
      return { ready: false, refused: code === 'ECONNREFUSED' };
    }
  };

  const first = await probe();
  if (first.ready) return { ready: true, woken: false };
  if (!first.refused || autoStart !== true) return { ready: false, woken: false, detail: first.refused ? 'auto-start is off' : 'not a refused connection' };

  try {
    await runTask();
  } catch (error) {
    return { ready: false, woken: false, detail: `wake failed: ${String(error?.message ?? error).slice(0, 120)}` };
  }

  // Poll inside the remaining budget; the turn must not wait longer than its deadline.
  const deadline = Date.now() + Math.max(0, budgetMs);
  for (;;) {
    const attempt = await probe();
    if (attempt.ready) return { ready: true, woken: true };
    if (Date.now() >= deadline) return { ready: false, woken: true, detail: 'started but not ready in time' };
    await new Promise(done => setTimeout(done, 120));
  }
}

/** Start the registered scheduled task. Output is ignored; the caller only needs the failure. */
async function runServerTask() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)('schtasks', ['/run', '/tn', LOCAL_SERVER_TASK_NAME], { windowsHide: true });
}
