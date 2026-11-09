import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { ChatgptHook, normalizeChatgptHook } from './index.ts';
import { publicError, View } from '../../../core/contracts/src/index.ts';
import { renderView } from '../../../bridge/src/injection.ts';

// Cloud orchestration has different managed-hook requirements; never silently treat it as local.
if (process.env.MNEMOWEAVE_CHATGPT_MODE !== 'local-only') process.exit(0);
const server = process.env.MNEMOWEAVE_SERVER?.replace(/\/$/, '');
const token = process.env.MNEMOWEAVE_TOKEN;
const host = process.env.MNEMOWEAVE_BRIDGE_HOST_ID;
if (!server || !token || !host) process.exit(0);
let stage = 'input';
try {
  const started = performance.now();
  const hook = ChatgptHook.parse(JSON.parse(readFileSync(0, 'utf8')));
  const event = normalizeChatgptHook(hook, process.env.MNEMOWEAVE_PROJECT_ID);
  const bridge = process.env.MNEMOWEAVE_BRIDGE_URL?.replace(/\/$/, '');
  const localToken = process.env.MNEMOWEAVE_BRIDGE_TOKEN ?? token;
  stage = 'event';
  const response = await fetch(bridge ? `${bridge}/v1/events` : `${server}/v1/sync/intents`, { method: 'POST', headers: { authorization: `Bearer ${bridge ? localToken : token}`, 'x-mnemoweave-host': host, 'content-type': 'application/json' }, body: JSON.stringify(bridge ? event : { intentId: event.eventId, kind: 'event', payload: event }), signal: AbortSignal.timeout(700) });
  if (!response.ok) { process.stderr.write(JSON.stringify({ event: 'chatgpt_event_unavailable', status: response.status }) + '\n'); process.exit(0); }
  const trigger = event.kind === 'session.started' ? 'session_started' : event.kind === 'message.user' ? 'message_user' : event.kind === 'tool.completed' && event.payload.outcome === 'failure' ? 'tool_failure' : undefined;
  if (trigger) {
    const remaining = 1900 - (performance.now() - started);
    if (remaining <= 0) process.exit(0);
    const request = { sessionId: event.sessionId, ...(event.projectId ? { projectId: event.projectId } : {}), ...(event.kind === 'message.user' && event.payload.text ? { query: event.payload.text.slice(0, 2000) } : {}) };
    stage = 'view';
    const delivered = await fetch(bridge ? `${bridge}/v1/inject` : `${server}/v1/view`, { method: 'POST', headers: { authorization: `Bearer ${bridge ? localToken : token}`, 'x-mnemoweave-host': host, 'content-type': 'application/json' }, body: JSON.stringify(bridge ? { ...request, turnId: event.turnId ?? event.eventId, trigger } : request), signal: AbortSignal.timeout(Math.max(1, Math.floor(remaining))) });
    if (delivered.ok) {
      stage = 'render';
      const body: unknown = await delivered.json();
      const text = bridge ? (body as { status: string; text?: string }).status === 'injected' ? (body as { text?: string }).text : undefined : renderView(View.parse(body));
      if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: hook.hook_event_name, additionalContext: text } }) + '\n');
    }
  }
} catch (error) { process.stderr.write(JSON.stringify({ event: 'chatgpt_hook_unavailable', stage, kind: error instanceof Error ? error.name : 'unknown', ...publicError(error) }) + '\n'); }
process.exit(0);
