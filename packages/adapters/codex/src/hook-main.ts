// ChatGPT/Codex plugin hook entry: reads one hook payload, asks MnemoWeave for a View,
// and returns the Codex hook response shape (`hookSpecificOutput.additionalContext`).
import { readFileSync } from 'node:fs';

interface HookPayload { hook_event_name?: unknown; session_id?: unknown; prompt?: unknown }
const raw = readFileSync(0, 'utf8');
let payload: HookPayload;
try { payload = JSON.parse(raw) as HookPayload; } catch { process.exit(0); }

const event = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '';
const sessionId = typeof payload.session_id === 'string' ? payload.session_id : 'unknown';
const trigger = event === 'SessionStart' ? 'session_started' : event === 'UserPromptSubmit' ? 'message_user' : undefined;
if (!trigger) process.exit(0);

const serverUrl = process.env.MNEMOWEAVE_SERVER?.replace(/\/$/, '');
const token = process.env.MNEMOWEAVE_TOKEN;
const hostId = process.env.MNEMOWEAVE_BRIDGE_HOST_ID ?? 'chatgpt-host';
const bridgeUrl = process.env.MNEMOWEAVE_BRIDGE_URL?.replace(/\/$/, '');
const bridgeToken = process.env.MNEMOWEAVE_BRIDGE_TOKEN ?? token;
if (!serverUrl || !token || token.length < 24) process.exit(0);

const query = trigger === 'message_user' && typeof payload.prompt === 'string' ? payload.prompt.slice(0, 2000) : null;
const turnId = `${sessionId}-${event}-${Date.now()}`;

async function resolveText(): Promise<string | undefined> {
  if (bridgeUrl && bridgeToken) {
    const response = await fetch(`${bridgeUrl}/v1/inject`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bridgeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, turnId, trigger, ...(query ? { query } : {}) }),
      signal: AbortSignal.timeout(1_900),
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { status?: string; text?: string };
    return body.status === 'injected' ? body.text : undefined;
  }
  const response = await fetch(`${serverUrl}/v1/view`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-mnemoweave-host': hostId },
    body: JSON.stringify(query ? { query } : {}),
    signal: AbortSignal.timeout(1_900),
  });
  if (!response.ok) return undefined;
  const view = await response.json() as { memories?: { content: string }[] };
  const text = (view.memories ?? []).map(memory => `- ${memory.content}`).join('\n');
  return text.length ? text : undefined;
}

try {
  const text = await resolveText();
  if (text) {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })}\n`);
  }
} catch { /* HOST-04: memory unavailability never blocks the session */ }
process.exit(0);
