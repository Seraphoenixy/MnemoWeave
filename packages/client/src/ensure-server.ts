/**
 * Getting the local Server reachable before a host uses it.
 *
 * The Server is hosted by a Windows scheduled task, not by the host process. A host may
 * therefore start first: DSH, ZCode and the ChatGPT desktop app can all be opened while
 * nothing is listening on the loopback port yet. `ensureServer` makes that case recoverable
 * without turning a host plugin into a process supervisor:
 *
 *   probe → already serving            → use it
 *         → connection refused         → ask the scheduled task to run, then poll
 *         → our Server, not ready yet  → keep polling until the deadline
 *         → 401                        → stop: the token does not match this Server
 *         → answered, but not ours     → stop: another program holds the port
 *         → timeout / unresponsive     → stop: something is wrong we cannot fix by waiting
 *
 * Only a refused connection triggers the task. That is the one result that proves nothing
 * is listening there. A timeout may mean a Server that is still starting or a stuck one, and
 * a foreign 200 response must never be "fixed" by launching a second process on the port.
 *
 * Nothing here supervises or proxies the Server: the task owns the process, the host only
 * detects, wakes and then connects directly. `waitMs` bounds the wait so a host turn is
 * never held open by a Server that will not come up.
 */
import { execFile } from 'node:child_process';

/** The one scheduled task name; installation registers it and hosts only run it by name. */
export const LOCAL_SERVER_TASK_NAME = 'MnemoWeave Local Server';

/** Why a probe stopped, in the order hosts need to tell them apart. */
export type ServerProbeFailure =
  /** Nothing accepted the connection: the only result that proves the Server is not running. */
  | 'connection_refused'
  /** A request was sent but no answer arrived inside the budget. */
  | 'timeout'
  /** Something answered, and it is not this Server (another program holds the port). */
  | 'address_conflict'
  /** This Server answered but rejected the token. */
  | 'unauthorized'
  /** This Server is up, but its Provider dependency is not ready yet. */
  | 'starting'
  /** The task could not be run, or the Server never became ready. */
  | 'task_failed';

export type ServerProbe =
  | { state: 'ready' }
  | { state: 'starting'; detail: string }
  | { state: 'failed'; reason: ServerProbeFailure; detail: string; taskRun: boolean };

export interface ProbeOptions {
  baseUrl: string;
  token: string;
  hostId: string;
  /** Budget for one HTTP probe, not for the whole wait. */
  probeTimeoutMs?: number;
  signal?: AbortSignal | undefined;
  /** Injectable transport for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface EnsureServerOptions extends ProbeOptions {
  /** Total budget for waiting for the Server to become usable. */
  waitMs?: number;
  /** Delay between polls while waiting for a starting Server or for the task to act. */
  pollMs?: number;
  /** Ask the scheduled task to run. Defaults to `schtasks /run`; injectable for tests. */
  runTask?: (taskName: string) => Promise<{ ok: boolean; detail: string }>;
  /** Clock injection so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** The identity a live MnemoWeave Server reports; anything else holds the port. */
const SERVICE = 'mnemoweave';

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Ask the scheduled task to run. A successful trigger only means the request was accepted:
 * Task Scheduler guarantees one instance (IgnoreNew), so three hosts waking concurrently
 * still produce one Server, and every caller then waits on the same address.
 */
export async function runLocalServerTask(taskName: string = LOCAL_SERVER_TASK_NAME): Promise<{ ok: boolean; detail: string }> {
  if (process.platform !== 'win32') return { ok: false, detail: 'the local Server task is only registered on Windows' };
  return new Promise((resolve) => {
    execFile('schtasks', ['/run', '/tn', taskName], { windowsHide: true, timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, detail: (stderr || stdout || error.message || '').trim().slice(0, 200) || 'schtasks failed' });
        return;
      }
      resolve({ ok: true, detail: (stdout || '').trim().slice(0, 200) });
    });
  });
}

/**
 * One probe. Distinguishes the four outcomes that matter:
 *
 * - the connection was refused (nothing listening),
 * - the request timed out (something may be listening but did not answer),
 * - a response came back but does not identify as this Server,
 * - this Server answered: authorized and ready, authorized but starting, or 401.
 */
export async function probeServer(options: ProbeOptions): Promise<ServerProbe> {
  const base = withoutTrailingSlash(options.baseUrl);
  const timeoutMs = options.probeTimeoutMs ?? 1_500;
  const headers = { authorization: `Bearer ${options.token}`, 'x-mnemoweave-host': options.hostId };
  const doFetch = options.fetchImpl ?? fetch;

  const live = await getJson(`${base}/health/live`, headers, timeoutMs, options.signal, doFetch);
  if (live.kind === 'refused') return { state: 'failed', reason: 'connection_refused', detail: 'nothing is listening on this address', taskRun: false };
  if (live.kind === 'timeout') return { state: 'failed', reason: 'timeout', detail: 'the address accepted the connection but did not answer', taskRun: false };
  if (live.kind === 'unauthorized') {
    // Our route with our shape but a rejected token is still "not ours to use", and the
    // realistic cause is a token mismatch, so report it as such rather than as an intruder.
    if (identifiesAsUs(live.value, false)) return { state: 'failed', reason: 'unauthorized', detail: 'the Server rejected the service token', taskRun: false };
    return { state: 'failed', reason: 'address_conflict', detail: 'another service answered on this port', taskRun: false };
  }
  if (live.kind === 'invalid') {
    return { state: 'failed', reason: 'address_conflict', detail: 'a different service answered on this port', taskRun: false };
  }
  // A 5xx from a liveness route is this Server being unhealthy, not another service.
  if (live.kind === 'ok' && !identifiesAsUs(live.value, true)) {
    return { state: 'failed', reason: 'address_conflict', detail: 'a different service answered on this port', taskRun: false };
  }
  if (live.kind === 'unavailable') return { state: 'starting', detail: 'the Server is up but its liveness route is not healthy yet' };

  const ready = await getJson(`${base}/health/ready`, headers, timeoutMs, options.signal, doFetch);
  if (ready.kind === 'refused') return { state: 'failed', reason: 'connection_refused', detail: 'the Server stopped answering between probes', taskRun: false };
  if (ready.kind === 'timeout') return { state: 'failed', reason: 'timeout', detail: 'the Server accepted the connection but did not answer', taskRun: false };
  if (ready.kind === 'unauthorized') return { state: 'failed', reason: 'unauthorized', detail: 'the Server rejected the service token', taskRun: false };
  if (ready.kind === 'invalid') return { state: 'starting', detail: 'the Server answered but its readiness report is not usable yet' };
  if (ready.kind === 'ok') return { state: 'ready' };
  // A 5xx from /health/ready means the Server is up and its Provider is not ready.
  return { state: 'starting', detail: 'the Server is up and its memory provider is still starting' };
}

type JsonOutcome =
  | { kind: 'ok'; value: unknown }
  | { kind: 'unauthorized'; value: unknown }
  | { kind: 'unavailable'; status: number }
  | { kind: 'invalid' }
  | { kind: 'timeout' }
  | { kind: 'refused' };

/**
 * Does this response come from our Server? The liveness route reports `live` together with
 * `service`; a rejected token reports `service` alongside the error. Both are needed: a
 * stranger that answers 200 with `{live:true}` is still not ours, and a stranger that answers
 * 401 must not be mistaken for a token mismatch.
 */
function identifiesAsUs(value: unknown, expectLive: boolean): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record['service'] !== SERVICE) return false;
  return expectLive ? record['live'] === true : true;
}

async function getJson(url: string, headers: Record<string, string>, timeoutMs: number, signal: AbortSignal | undefined, doFetch: typeof fetch): Promise<JsonOutcome> {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await doFetch(url, { method: 'GET', headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const text = await response.text();
    let parsed: unknown = {};
    if (text !== '') {
      try { parsed = JSON.parse(text); } catch { return { kind: 'invalid' }; }
    }
    if (response.status === 401 || response.status === 403) return { kind: 'unauthorized', value: parsed };
    if (response.status >= 500) return { kind: 'unavailable', status: response.status };
    if (!response.ok) return { kind: 'invalid' };
    return { kind: 'ok', value: parsed };
  } catch (error) {
    // The distinction that decides whether the task may be triggered: a refused connection
    // means nothing is listening; a timeout means something is there but did not answer.
    const name = error instanceof Error ? error.name : '';
    const code = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
    if (code === undefined && (name === 'TimeoutError' || name === 'AbortError')) return { kind: 'timeout' };
    if (code === 'ECONNREFUSED') return { kind: 'refused' };
    if (code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return { kind: 'refused' };
    if (name === 'TimeoutError' || name === 'AbortError') return { kind: 'timeout' };
    // A connection that reset mid-flight is neither: report it as unresponsive.
    return { kind: 'timeout' };
  }
}

/**
 * Budget for a session-start prewarm. A hook that fires once per session can afford to wait;
 * a per-turn hook cannot, so it passes the remaining share of the injection deadline instead.
 */
export function prewarmBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['MNEMOWEAVE_STARTUP_WAIT_MS'];
  // An unset or empty variable means "use the default": Number('') is 0, which would
  // otherwise read as an explicit "do not wait at all".
  if (raw === undefined || raw.trim() === '') return 4_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 4_000;
  return Math.floor(parsed);
}

/**
 * Ensure the Server before one hook turn, without exceeding the caller's deadline.
 *
 * A host turn must not be held open by a Server that will not come up: the returned probe is
 * advisory, and callers continue with their own request either way. `0` disables the wait for
 * callers that have already spent their budget.
 */
export async function ensureServerForTurn(options: EnsureServerOptions & { deadline?: number }): Promise<ServerProbe> {
  const now = options.now ?? (() => Date.now());
  const waitMs = options.deadline === undefined
    ? options.waitMs ?? prewarmBudgetMs()
    : Math.max(0, Math.min(options.waitMs ?? prewarmBudgetMs(), options.deadline - now()));
  if (waitMs <= 0) return probeServer(options);
  return ensureServer({ ...options, waitMs });
}

/**
 * Make the local Server usable, waking the scheduled task when — and only when — nothing is
 * listening. Returns the probe result; callers use it to decide what to show and whether to
 * continue with the request they were about to make.
 */
export async function ensureServer(options: EnsureServerOptions): Promise<ServerProbe> {
  const waitMs = options.waitMs ?? 20_000;
  const pollMs = options.pollMs ?? 250;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => { setTimeout(done, ms); }));
  const now = options.now ?? (() => Date.now());
  const runTask = options.runTask ?? runLocalServerTask;
  const deadline = now() + waitMs;

  let taskRun = false;
  let started = false;
  for (;;) {
    const probe = await probeServer(options);
    if (probe.state === 'ready') return probe;
    if (probe.state === 'failed') {
      // Only a refused connection justifies waking the task, and only once.
      if (probe.reason !== 'connection_refused') return { ...probe, taskRun };
      if (!started) {
        started = true;
        const run = await runTask(LOCAL_SERVER_TASK_NAME);
        if (!run.ok) return { state: 'failed', reason: 'task_failed', detail: run.detail, taskRun: false };
        taskRun = true;
        continue;
      }
      // Already asked; keep waiting for it to come up.
    }
    if (now() >= deadline) {
      const reason: ServerProbeFailure = probe.state === 'starting' ? 'task_failed' : probe.reason;
      const detail = probe.state === 'starting'
        ? 'the Server did not become ready before the deadline'
        : probe.detail;
      return { state: 'failed', reason, detail, taskRun };
    }
    await sleep(pollMs);
  }
}
