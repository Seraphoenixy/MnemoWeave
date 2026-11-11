import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { ChatgptHook, DEFAULT_HOST_ID, normalizeChatgptHook } from './index.ts';
import { publicError } from '../../../core/contracts/src/index.ts';
import { clientFromEnv, ensureServerForTurn, renderView } from '../../../client/src/index.ts';
import type { RenderableView } from '../../../client/src/render.ts';

// Cloud orchestration has different managed-hook requirements; never silently treat it as local.
if (process.env.MNEMOWEAVE_CHATGPT_MODE !== 'local-only') process.exit(0);
const server = process.env.MNEMOWEAVE_SERVER?.replace(/\/$/, '');
const token = process.env.MNEMOWEAVE_TOKEN;
// The Host identity is this adapter's own, not a machine-wide setting: one global
// MNEMOWEAVE_HOST_ID cannot be correct for three different hosts at once. An explicit
// environment value still wins, for running the same adapter under a second identity.
const host = process.env.MNEMOWEAVE_HOST_ID ?? DEFAULT_HOST_ID;
if (!server || !token) process.exit(0);
const client = clientFromEnv({ ...process.env, MNEMOWEAVE_SERVER: server, MNEMOWEAVE_TOKEN: token, MNEMOWEAVE_HOST_ID: host });
let stage = 'input';
try {
  const started = performance.now();
  const hook = ChatgptHook.parse(JSON.parse(readFileSync(0, 'utf8')));
  const event = normalizeChatgptHook(hook, process.env.MNEMOWEAVE_PROJECT_ID);
  stage = 'server';
  // The Server is hosted by the "MnemoWeave Local Server" scheduled task, so the desktop app
  // may well start first. Wake it on a refused connection only, and only within this turn's
  // budget: a first turn that arrives too early continues without memory, the next one retries.
  const turnDeadline = started + 1900;
  const probe = await ensureServerForTurn({
    baseUrl: server, token, hostId: host,
    probeTimeoutMs: 750,
    deadline: turnDeadline,
  }).catch(() => undefined);
  if (probe && probe.state !== 'ready') {
    const detail = probe.state === 'starting' ? probe.detail : `${probe.reason}: ${probe.detail}`;
    process.stderr.write(JSON.stringify({ event: 'chatgpt_local_server_unavailable', detail }) + '\n');
    process.exit(0);
  }
  stage = 'event';
  const recorded = await client.event(event);
  if (!recorded.ok) { process.stderr.write(JSON.stringify({ event: 'chatgpt_event_unavailable', code: recorded.error.code }) + '\n'); process.exit(0); }
  const trigger = event.kind === 'session.started' ? 'session_started' : event.kind === 'message.user' ? 'message_user' : event.kind === 'tool.completed' && event.payload.outcome === 'failure' ? 'tool_failure' : undefined;
  if (trigger) {
    const remaining = turnDeadline - performance.now();
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
