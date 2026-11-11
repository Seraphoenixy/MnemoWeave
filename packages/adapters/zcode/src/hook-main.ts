import { clientFromEnv, ensureServerForTurn, renderView } from '../../../client/src/index.ts';
import type { RenderableView } from '../../../client/src/render.ts';
// Runnable hook entry for the installed ZCode hooks configuration: all wiring comes from
// environment variables; an unconfigured or unreachable Server never blocks the session (HOST-04).
import { DEFAULT_HOST_ID, runHookStdin } from './index.ts';
import type { InjectionContext } from './index.ts';

const serverUrl = process.env.MNEMOWEAVE_SERVER;
const token = process.env.MNEMOWEAVE_TOKEN;
if (!serverUrl || !token || token.length < 24) process.exit(0);
// This adapter's own Host identity: a machine-wide MNEMOWEAVE_HOST_ID cannot be correct for
// three hosts at once. An explicit environment value still wins.
const hostId = process.env.MNEMOWEAVE_HOST_ID ?? DEFAULT_HOST_ID;
const deadlineMs = Math.max(250, Number(process.env.MNEMOWEAVE_INJECT_DEADLINE_MS ?? 2_000));
const client = clientFromEnv({ ...process.env, MNEMOWEAVE_SERVER: serverUrl, MNEMOWEAVE_TOKEN: token, MNEMOWEAVE_HOST_ID: hostId });

/**
 * The Server is hosted by the "MnemoWeave Local Server" scheduled task, so ZCode may start
 * before it. On a refused connection the shared client wakes that task and waits — but only
 * within the budget this call has left. A first turn that arrives before the Server is ready
 * simply misses its injection; the next turn tries again. Nothing here holds the session open.
 */
let announced: string | undefined;
async function ready(budgetMs: number): Promise<boolean> {
  const probe = await ensureServerForTurn({
    baseUrl: serverUrl!, token: token!, hostId,
    probeTimeoutMs: Math.min(1_000, Math.max(200, budgetMs)),
    waitMs: budgetMs,
  });
  if (probe.state === 'ready') return true;
  // Report once per process: hooks are per-event, so repeating the same line every turn
  // would bury the session's own output.
  const detail = probe.state === 'starting' ? probe.detail : `${probe.reason}: ${probe.detail}`;
  if (announced !== detail) {
    announced = detail;
    process.stderr.write(`${JSON.stringify({ event: 'zcode_local_server_unavailable', detail })}\n`);
  }
  return false;
}

runHookStdin({
  serverUrl: serverUrl.replace(/\/$/, ''),
  token, hostId, deadlineMs,
  ...(process.env.MNEMOWEAVE_PROJECT_ID ? { projectId: process.env.MNEMOWEAVE_PROJECT_ID } : {}),
  ensureReachable: budgetMs => ready(budgetMs),
  recallAndAssemble: async (query, context?: InjectionContext) => {
    const input = {
      ...(query && query.trim().length ? { query: query.trim().slice(0, 2000) } : {}),
      ...(context ? { sessionId: context.sessionId } : {}),
      ...(process.env.MNEMOWEAVE_PROJECT_ID ? { projectId: process.env.MNEMOWEAVE_PROJECT_ID } : {}),
    };
    // Online-only: the Server assembles the View inside the deadline; hooks stay stateless.
    const response = await client.inject(input, deadlineMs);
    if (!response.ok) return undefined;
    const view = response.value as RenderableView;
    const text = renderView(view);
    return text.length > 0 && typeof view.viewId === 'string' ? { text, viewId: view.viewId } : undefined;
  },
});
