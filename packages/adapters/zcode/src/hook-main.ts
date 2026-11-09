import { renderView } from '../../../bridge/src/injection.ts';
import type { ViewRecord } from '../../../core/contracts/src/index.ts';
// Runnable hook entry for the installed ZCode hooks configuration: all wiring comes
// from environment variables set by the workspace setup script; an unconfigured or
// unreachable memory service never blocks the session (HOST-04).
import { runHookStdin } from './index.ts';
import type { InjectionContext } from './index.ts';

const serverUrl = process.env.MNEMOWEAVE_SERVER;
const token = process.env.MNEMOWEAVE_TOKEN;
if (!serverUrl || !token || token.length < 24) process.exit(0);
const hostId = process.env.MNEMOWEAVE_BRIDGE_HOST_ID ?? 'zcode-host';
const deadlineMs = Math.max(250, Number(process.env.MNEMOWEAVE_INJECT_DEADLINE_MS ?? 2_000));
const bridgeUrl = process.env.MNEMOWEAVE_BRIDGE_URL?.replace(/\/$/, '');
const bridgeToken = process.env.MNEMOWEAVE_BRIDGE_TOKEN ?? token;

runHookStdin({
  serverUrl: serverUrl.replace(/\/$/, ''),
  token, hostId, deadlineMs,
  ...(process.env.MNEMOWEAVE_PROJECT_ID ? { projectId: process.env.MNEMOWEAVE_PROJECT_ID } : {}),
  ...(bridgeUrl ? { bridgeUrl, bridgeToken } : {}),
  recallAndAssemble: async (query, context?: InjectionContext) => {
    const request = { ...(query && query.trim().length ? { query: query.trim().slice(0, 2000) } : {}), ...(context ? { sessionId: context.sessionId } : {}), ...(process.env.MNEMOWEAVE_PROJECT_ID ? { projectId: process.env.MNEMOWEAVE_PROJECT_ID } : {}) };
    // HOST-05: the Bridge holds the session view; hooks stay short-lived and stateless.
    if (bridgeUrl && bridgeToken && context) {
      const response = await fetch(`${bridgeUrl}/v1/inject`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bridgeToken}`, 'x-mnemoweave-host': hostId, 'content-type': 'application/json' },
        body: JSON.stringify({ turnId: context.turnId, trigger: context.trigger, ...request }),
        signal: AbortSignal.timeout(deadlineMs),
      });
      if (response.ok) {
        const result = await response.json() as { status?: string; text?: string; viewId?: string };
        if (result.status === 'injected' && result.text && result.viewId) return { text: result.text, viewId: result.viewId };
      }
      return undefined;
    }
    // Fallback: server-side View delivery (online-only path, no cross-event reuse).
    const response = await fetch(`${serverUrl.replace(/\/$/, '')}/v1/view`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-mnemoweave-host': hostId },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(deadlineMs),
    });
    if (!response.ok) return undefined;
    const result = await response.json() as ViewRecord;
    const text = renderView(result);
    return text.length && result.viewId ? { text, viewId: result.viewId } : undefined;
  },
});
