import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { ChatgptHook, normalizeChatgptHook } from './index.ts';
import { publicError } from '../../../core/contracts/src/index.ts';
import { clientFromEnv, renderView } from '../../../client/src/index.ts';
import type { RenderableView } from '../../../client/src/render.ts';

// Cloud orchestration has different managed-hook requirements; never silently treat it as local.
if (process.env.MNEMOWEAVE_CHATGPT_MODE !== 'local-only') process.exit(0);
const server = process.env.MNEMOWEAVE_SERVER?.replace(/\/$/, '');
const token = process.env.MNEMOWEAVE_TOKEN;
const host = process.env.MNEMOWEAVE_HOST_ID;
if (!server || !token || !host) process.exit(0);
const client = clientFromEnv({ ...process.env, MNEMOWEAVE_SERVER: server, MNEMOWEAVE_TOKEN: token, MNEMOWEAVE_HOST_ID: host });
let stage = 'input';
try {
  const started = performance.now();
  const hook = ChatgptHook.parse(JSON.parse(readFileSync(0, 'utf8')));
  const event = normalizeChatgptHook(hook, process.env.MNEMOWEAVE_PROJECT_ID);
  stage = 'event';
  const recorded = await client.event(event);
  if (!recorded.ok) { process.stderr.write(JSON.stringify({ event: 'chatgpt_event_unavailable', code: recorded.error.code }) + '\n'); process.exit(0); }
  const trigger = event.kind === 'session.started' ? 'session_started' : event.kind === 'message.user' ? 'message_user' : event.kind === 'tool.completed' && event.payload.outcome === 'failure' ? 'tool_failure' : undefined;
  if (trigger) {
    const remaining = 1900 - (performance.now() - started);
    if (remaining <= 0) process.exit(0);
    const request = { sessionId: event.sessionId, ...(event.projectId ? { projectId: event.projectId } : {}), ...(event.kind === 'message.user' && event.payload.text ? { query: event.payload.text.slice(0, 2000) } : {}) };
    stage = 'view';
    const delivered = await client.inject(request, Math.max(1, Math.floor(remaining)));
    if (delivered.ok) {
      stage = 'render';
      const text = renderView(delivered.value as RenderableView);
      if (text.length > 0) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: hook.hook_event_name, additionalContext: text } }) + '\n');
    }
  }
} catch (error) { process.stderr.write(JSON.stringify({ event: 'chatgpt_hook_unavailable', stage, kind: error instanceof Error ? error.name : 'unknown', ...publicError(error) }) + '\n'); }
process.exit(0);
