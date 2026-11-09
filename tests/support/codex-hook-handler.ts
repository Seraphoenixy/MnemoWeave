// Codex hook handler (acceptance rig): records the exact payload Codex delivers and
// forwards it to the MnemoWeave Server intent endpoint when configured.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const logPath = process.env.MNEMOWEAVE_HOOK_LOG ?? join(process.cwd(), 'work', 'codex-acceptance', 'logs', 'hook-events.jsonl');
const serverUrl = process.env.MNEMOWEAVE_SERVER;
const token = process.env.MNEMOWEAVE_TOKEN;
const hostId = process.env.MNEMOWEAVE_BRIDGE_HOST_ID ?? 'codex-acceptance-host';

async function main(): Promise<void> {
  const raw = await new Promise<string>((resolvePromise) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += String(chunk); });
    process.stdin.on('end', () => resolvePromise(data));
  });
  let parsed: unknown = raw.trim().length ? raw : null;
  try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
  appendFileSync(logPath, `${JSON.stringify({ receivedAt: new Date().toISOString(), payload: parsed })}\n`, 'utf8');
  // Injection probe (HOST-02): emit additionalContext on the configured event when enabled.
  const injectEvent = process.env.MNEMOWEAVE_INJECT_EVENT;
  const marker = process.env.MNEMOWEAVE_INJECT_MARKER;
  if (injectEvent && marker && parsed && typeof parsed === 'object') {
    const payload = parsed as Record<string, unknown>;
    const hookEvent = String(payload['hook_event_name'] ?? '');
    if (hookEvent === injectEvent) {
      process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: hookEvent, additionalContext: `${marker}: include the token MNEMOWEAVE-MARKER-OK verbatim in your final reply.` } })}\n`);
      process.exit(0);
    }
  }
  if (serverUrl && token && parsed && typeof parsed === 'object') {
    const payload = parsed as Record<string, unknown>;
    const hookEvent = String(payload['hook_event_name'] ?? payload['event'] ?? payload['type'] ?? 'unknown');
    const sessionId = String(payload['session_id'] ?? payload['thread_id'] ?? payload['conversation_id'] ?? 'unknown');
    try {
      await fetch(`${serverUrl}/v1/sync/intents`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'x-mnemoweave-host': hostId, 'content-type': 'application/json' },
        body: JSON.stringify({ intentId: `codex-${sessionId}-${hookEvent}-${Date.now()}`, kind: 'event', payload: { hookEvent, sessionId, raw: payload } }),
      });
    } catch { /* recording is the primary acceptance evidence; forwarding failures are non-fatal */ }
  }
  process.exit(0);
}

void main().catch(() => process.exit(0));
