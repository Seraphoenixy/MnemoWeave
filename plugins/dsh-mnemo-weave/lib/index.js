// DSH plugin: injects one MnemoWeave View per session at prompt assembly time.
// Cordis plugin shape: name/inject/apply. No runtime dependencies; the View is
// fetched from the local Bridge (preferred) or the MnemoWeave Server.
export const name = 'dsh-mnemo-weave';
export const inject = [];

const injected = new Set();

function endpoint(config) {
  return (config?.serverUrl ?? process.env.MNEMOWEAVE_SERVER ?? 'http://127.0.0.1:4317').replace(/\/$/, '');
}

async function fetchView(sessionId, config) {
  const token = process.env.MNEMOWEAVE_TOKEN;
  if (!token || token.length < 24) return undefined;
  const bridgeUrl = (process.env.MNEMOWEAVE_BRIDGE_URL ?? config?.bridgeUrl ?? '').replace(/\/$/, '');
  const bridgeToken = process.env.MNEMOWEAVE_BRIDGE_TOKEN ?? token;
  const timeout = config?.timeoutMs ?? 1900;
  if (bridgeUrl) {
    const response = await fetch(`${bridgeUrl}/v1/inject`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bridgeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, turnId: `${sessionId}-session-start`, trigger: 'session_started', ...(config?.pinned ? { pinned: config.pinned } : {}) }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) return undefined;
    const body = await response.json();
    return body?.status === 'injected' ? body.text : undefined;
  }
  const hostId = process.env.MNEMOWEAVE_BRIDGE_HOST_ID ?? 'dsh-host';
  const response = await fetch(`${endpoint(config)}/v1/view`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-mnemoweave-host': hostId },
    body: JSON.stringify({
      ...(config?.pinned ? { pinned: config.pinned } : {}),
      ...(config?.query ? { query: config.query } : {}),
    }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) return undefined;
  const view = await response.json();
  const text = (view?.memories ?? []).map(memory => `- ${memory.content}`).join('\n');
  return text.length ? text : undefined;
}

/** Registers one prompt section per session; failures never block the turn. */
export function apply(ctx, config = {}) {
  ctx.on('agent/created', ({ agent } = {}) => {
    const agentCtx = agent?.ctx;
    if (!agentCtx?.on) return;
    const sessionId = String(agent.id ?? 'unknown');
    const offs = [];
    offs.push(agentCtx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const assembled = await next();
      if (injected.has(sessionId)) return assembled;
      injected.add(sessionId);
      try {
        const text = await fetchView(sessionId, config);
        if (!text) return assembled;
        return { ...assembled, sections: [...(assembled.sections ?? []), { name: 'mnemo-weave:view', text }] };
      } catch {
        return assembled;
      }
    }));
    offs.push(agentCtx.on('agent/turn-stopping', () => {
      for (const off of offs.splice(0)) { try { off?.(); } catch { /* already disposed */ } }
    }));
  });
}
