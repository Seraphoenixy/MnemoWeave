// DSH plugin: injects one MnemoWeave View per session at prompt assembly time.
// Cordis plugin shape: name/inject/apply. No runtime dependencies; the View is
// fetched from the MnemoWeave Server with the service token.
//
// Configuration is not resolved here. `./host-config.js` is the single reader shared with the
// page's Host half, so the endpoint, Host identity, project and injection budget the page shows
// are the same values this hook uses. Stored preferences win over the Cordis entry, which wins
// over the environment.
import { ensureReachable, readPreferences, resolveHostConfig } from './host-config.js';

export const name = 'dsh-mnemo-weave';
export const inject = [];

const injected = new Set();

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

/** Resolved once per turn, so a settings change is picked up without restarting DSH. */
function currentConfig(config) {
  return resolveHostConfig(config, process.env, readPreferences(process.env));
}

async function fetchInjection(sessionId, config) {
  const resolved = currentConfig(config);
  const token = resolved.token;
  if (!token || token.length < 24) return undefined;
  // The whole turn may not exceed two seconds. The wake gets a slice of it and the injection
  // request gets whatever is left, so a cold Server never pushes the turn past its deadline.
  const startedAt = Date.now();
  await ensureReachable({ serverUrl: resolved.serverUrl, token, hostId: resolved.hostId, autoStart: resolved.autoStart }).catch(() => undefined);
  const remaining = Math.max(200, resolved.injectTimeoutMs - (Date.now() - startedAt));
  const response = await fetch(`${resolved.serverUrl}/v1/inject`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-mnemoweave-host': resolved.hostId,
      ...(resolved.projectId === undefined ? {} : { 'x-mnemoweave-project': resolved.projectId }),
    },
    body: JSON.stringify({
      sessionId,
      ...(config?.pinned ? { pinned: config.pinned } : {}),
      ...(config?.query ? { query: config.query } : {}),
    }),
    signal: AbortSignal.timeout(remaining),
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
