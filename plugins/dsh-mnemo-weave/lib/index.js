// DSH plugin: injects one MnemoWeave View per session at prompt assembly time.
// Cordis plugin shape: name/inject/apply. No runtime dependencies; the View is
// fetched from the MnemoWeave Server with the service token.
//
// Configuration comes from the Cordis entry first (serverUrl / token / hostId / projectId)
// and falls back to MNEMOWEAVE_SERVER / MNEMOWEAVE_TOKEN / MNEMOWEAVE_HOST_ID /
// MNEMOWEAVE_PROJECT_ID, the same order the page half uses.
export const name = 'dsh-mnemo-weave';
export const inject = [];

const injected = new Set();

function pick(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function endpoint(config) {
  return (pick(config?.serverUrl) ?? pick(process.env.MNEMOWEAVE_SERVER) ?? 'http://127.0.0.1:4317').replace(/\/$/, '');
}

/**
 * Injection order is fixed: rules, then working context, then formal memories. A rule block
 * omitted for budget is named so the model can tell it apart from "no rules apply".
 */
export function render(view) {
  const blocks = [];
  const rules = (view?.rules ?? []).map(rule => String(rule?.body ?? '').trim()).filter(body => body !== '');
  if (rules.length > 0) blocks.push(`Runtime rules (confirmed by the user, follow them):\n${rules.map(rule => `- ${rule}`).join('\n')}`);
  else if (view?.rulesBudget?.exceeded === true) blocks.push('Runtime rules were omitted: the budget was exceeded.');
  const working = (view?.workingContext ?? []).map(entry => String(entry?.text ?? '')).filter(text => text.trim() !== '');
  if (working.length > 0) blocks.push(`Working context (unverified session material):\n${working.join('\n')}`);
  const memories = (view?.memories ?? []).filter(memory => String(memory?.content ?? '').trim() !== '');
  if (memories.length > 0) {
    blocks.push(`Formal memories:\n${memories.map((memory) => {
      const scope = memory?.scope === 'global' ? 'global' : 'project';
      const excerpt = memory?.excerpt === true ? ' [excerpt]' : '';
      return `- (${scope}) ${memory.content}${excerpt}`;
    }).join('\n')}`);
  }
  return blocks.join('\n\n');
}

async function fetchInjection(sessionId, config) {
  const token = pick(config?.token) ?? pick(process.env.MNEMOWEAVE_TOKEN);
  if (!token || token.length < 24) return undefined;
  const hostId = pick(config?.hostId) ?? pick(process.env.MNEMOWEAVE_HOST_ID) ?? 'dsh';
  const projectId = pick(config?.projectId) ?? pick(process.env.MNEMOWEAVE_PROJECT_ID);
  const timeout = config?.timeoutMs ?? 1900;
  const response = await fetch(`${endpoint(config)}/v1/inject`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-mnemoweave-host': hostId,
      ...(projectId === undefined ? {} : { 'x-mnemoweave-project': projectId }),
    },
    body: JSON.stringify({
      sessionId,
      ...(config?.pinned ? { pinned: config.pinned } : {}),
      ...(config?.query ? { query: config.query } : {}),
    }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) return undefined;
  const view = await response.json();
  const text = render(view);
  return text.length === 0 ? undefined : text;
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
      try {
        const text = await fetchInjection(sessionId, config);
        if (!text) return assembled;
        // Marked only after a successful delivery, so an unreachable Server retries next turn.
        injected.add(sessionId);
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
