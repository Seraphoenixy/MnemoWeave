import { clientFromEnv, renderView } from '../../../client/src/index.ts';
import type { RenderableView } from '../../../client/src/render.ts';
// Runnable hook entry for the installed ZCode hooks configuration: all wiring comes from
// environment variables; an unconfigured or unreachable Server never blocks the session (HOST-04).
import { runHookStdin } from './index.ts';
import type { InjectionContext } from './index.ts';

const serverUrl = process.env.MNEMOWEAVE_SERVER;
const token = process.env.MNEMOWEAVE_TOKEN;
if (!serverUrl || !token || token.length < 24) process.exit(0);
const hostId = process.env.MNEMOWEAVE_HOST_ID ?? 'zcode-host';
const deadlineMs = Math.max(250, Number(process.env.MNEMOWEAVE_INJECT_DEADLINE_MS ?? 2_000));
const client = clientFromEnv({ ...process.env, MNEMOWEAVE_SERVER: serverUrl, MNEMOWEAVE_TOKEN: token, MNEMOWEAVE_HOST_ID: hostId });

runHookStdin({
  serverUrl: serverUrl.replace(/\/$/, ''),
  token, hostId, deadlineMs,
  ...(process.env.MNEMOWEAVE_PROJECT_ID ? { projectId: process.env.MNEMOWEAVE_PROJECT_ID } : {}),
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
