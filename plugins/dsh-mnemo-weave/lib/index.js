// DSH plugin: injects one MnemoWeave View per session at prompt assembly time.
// Cordis plugin shape: name/inject/apply. No runtime dependencies; the View is
// fetched from the MnemoWeave Server with the service token.
//
// Configuration is not resolved here. `./host-config.js` is the single reader shared with the
// page's Host half, so the endpoint, Host identity, project and injection budget the page shows
// are the same values this hook uses. Stored preferences win over the Cordis entry, which wins
// over the environment.
import { randomUUID } from 'node:crypto';
import { ensureReachable, readPreferences, resolveHostConfig } from './host-config.js';

export const name = 'dsh-mnemo-weave';
// Registering the memory tools is the host service that makes them callable; without it the
// plugin still injects the View but the model has no way to ask for anything else.
export const inject = ['tools'];

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

/** One text projection for every tool result: the model reads the JSON the Server returned. */
const TOOL_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2) }],
};

/** One authenticated call to the local Server. Settings are re-read per call, like the View fetch. */
async function callServer(config, method, path, body, signal) {
  const resolved = currentConfig(config);
  if (!resolved.token || resolved.token.length < 24) {
    throw new Error('MnemoWeave service token is not configured (MNEMOWEAVE_TOKEN)');
  }
  const timeout = AbortSignal.timeout(10_000);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const response = await fetch(`${resolved.serverUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${resolved.token}`,
      'x-mnemoweave-host': resolved.hostId,
      ...(resolved.projectId === undefined ? {} : { 'x-mnemoweave-project': resolved.projectId }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: combined,
  });
  const text = await response.text();
  let parsed;
  try { parsed = text === '' ? {} : JSON.parse(text); } catch { throw new Error('MnemoWeave returned a response that is not JSON'); }
  if (!response.ok) {
    const code = typeof parsed?.code === 'string' ? parsed.code : 'INTERNAL';
    throw new Error(`${code}: ${typeof parsed?.message === 'string' ? parsed.message : response.statusText}`);
  }
  return parsed;
}

/**
 * The model-facing tool family.
 *
 * Names carry the product prefix rather than dsh-mnemon's `mnemon_` prefix, because both plugins
 * can be installed in the same DSH profile and two tools with one name would collide. The family
 * stays inside the project's write boundary: recall/read/runtime are reads, and `remember` submits
 * a candidate for review instead of publishing formal memory.
 */
export function createTools(config) {
  return [
    {
      name: 'mnemoweave_recall',
      description: 'Recall published formal memories from the local MnemoWeave Server by semantic similarity. Read-only. Use it when the injected memory view is not enough; it returns memory ids and text so you can open or cite them.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'What to search for, in natural language.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many memories to return (default 10).' },
        },
        required: ['query'],
      },
      output: TOOL_OUTPUT,
      execute: (args, execution) => callServer(
        config,
        'POST',
        '/v1/recall',
        { query: args.query, ...(args.limit === undefined ? {} : { limit: args.limit }) },
        execution?.signal,
      ),
    },
    {
      name: 'mnemoweave_read_memory',
      description: 'Read one published formal memory: the current revision by default, or a named historical revision. Read-only; it does not move the entry version.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memoryId: { type: 'string', description: 'The memory id returned by recall, the list or the injected view.' },
          revisionId: { type: 'string', description: 'A revision id from the memory detail history; omit for the current revision.' },
        },
        required: ['memoryId'],
      },
      output: TOOL_OUTPUT,
      execute: (args, execution) => callServer(
        config,
        'GET',
        `/v1/memories/${encodeURIComponent(args.memoryId)}${args.revisionId === undefined ? '' : `?revisionId=${encodeURIComponent(args.revisionId)}`}`,
        undefined,
        execution?.signal,
      ),
    },
    {
      name: 'mnemoweave_runtime_memory',
      description: 'Read the runtime rules (运行时记忆) that this Server injects into every turn, with their scope, version and enabled state. Read-only: rules are added and edited on the memory page, and the model cannot publish or change them.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string', enum: ['all', 'global', 'project'], description: 'Which rules to read; default all.' },
          projectId: { type: 'string', description: 'The project whose rules to read when scope is project.' },
        },
      },
      output: TOOL_OUTPUT,
      execute: (args, execution) => {
        const scope = args.scope ?? 'all';
        if (scope === 'project' && (typeof args.projectId !== 'string' || args.projectId.trim() === '')) {
          throw new Error('projectId is required when scope is project');
        }
        const query = new URLSearchParams({ scope, ...(args.projectId === undefined ? {} : { projectId: args.projectId }) });
        return callServer(config, 'GET', `/v1/rules?${query.toString()}`, undefined, execution?.signal);
      },
    },
    {
      name: 'mnemoweave_project_archives',
      description: 'Search project archives by keyword. Returns matching titles and IDs without full text. Supply an archive ID to read one full document in the same project.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          projectId: { type: 'string', minLength: 1, maxLength: 200, description: 'Defaults to the configured project.' },
          query: { type: 'string', minLength: 1, maxLength: 200 },
          entryId: { type: 'string', format: 'uuid' },
        },
        oneOf: [{ required: ['query'] }, { required: ['entryId'] }],
      },
      output: TOOL_OUTPUT,
      execute: async (args, execution) => {
        const projectId = (args.projectId ?? currentConfig(config).projectId)?.trim();
        if (!projectId || projectId.length > 200) throw new Error('A projectId is required');
        const query = args.query?.trim().toLowerCase();
        if (Boolean(query) === Boolean(args.entryId)) throw new Error('Supply a query or an archive entryId');
        const params = new URLSearchParams({ projectId });
        const { items } = await callServer(config, 'GET', `/v1/archives?${params}`, undefined, execution?.signal);
        if (args.entryId) {
          const archive = items.find(item => item.entryId === args.entryId);
          if (!archive) throw new Error('Archive not found in this project');
          return archive;
        }
        return { items: items
          .filter(item => [item.title, item.body].some(text => text.toLowerCase().includes(query)))
          .slice(0, 10)
          .map(({ entryId, title, verification, version }) => ({ entryId, title, verification, version })) };
      },
    },
    {
      name: 'mnemoweave_remember',
      description: 'Submit one immutable candidate for review. It does not write formal memory: a person accepts or rejects it. Use it only for a durable fact the user supplied or confirmed; never publish model speculation, transcripts or temporary progress.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string', description: 'The candidate text, 1–8000 UTF-8 bytes.' },
          knowledgeType: { type: 'string', enum: ['Concept', 'Practice', 'Architecture', 'Troubleshooting', 'Constraint', 'Procedure', 'Reference'] },
          category: { type: 'string', enum: ['preference', 'decision', 'fact', 'insight', 'context', 'general'] },
          importance: { type: 'integer', minimum: 1, maximum: 5 },
          tags: { type: 'array', items: { type: 'string' }, description: 'At most 20 tags.' },
          entities: { type: 'array', items: { type: 'string' }, description: 'At most 50 entity names.' },
          scope: { type: 'string', enum: ['global', 'project'], description: 'Defaults to global; project requires projectId.' },
          projectId: { type: 'string', description: 'The project the candidate belongs to when scope is project.' },
        },
        required: ['content', 'knowledgeType'],
      },
      output: TOOL_OUTPUT,
      execute: (args, execution) => {
        const scope = args.scope ?? 'global';
        if (scope === 'project' && (typeof args.projectId !== 'string' || args.projectId.trim() === '')) {
          throw new Error('projectId is required when scope is project');
        }
        const body = {
          idempotencyKey: randomUUID().replaceAll('-', ''),
          content: args.content,
          knowledgeType: args.knowledgeType,
          ...(args.tags === undefined ? {} : { tags: args.tags }),
          ...(args.category === undefined ? {} : { category: args.category }),
          ...(args.importance === undefined ? {} : { importance: args.importance }),
          ...(args.entities === undefined ? {} : { entities: args.entities }),
          scope,
          ...(scope === 'project' ? { projectId: args.projectId } : {}),
          provenance: {
            source: 'agent',
            sourceReference: `dsh-mnemo-weave:${String(execution?.agent?.id ?? 'unknown')}`,
            evidence: ['Submitted as a candidate by the model through the MnemoWeave DSH tool.'],
            verificationStatus: 'unverified',
            confidence: 0.5,
            applicability: scope === 'global' ? 'global' : `project:${args.projectId}`,
            limitations: 'Model output; a person must review before it is published.',
            lastVerified: null,
          },
        };
        return callServer(config, 'POST', '/v1/remember', body, execution?.signal);
      },
    },
  ];
}

/** Registers the tools and one prompt section per turn; failures never block the turn. */
export function apply(ctx, config = {}) {
  const releases = [];
  for (const tool of createTools(config)) {
    const release = ctx.tools?.register?.(tool);
    if (typeof release === 'function') releases.push(release);
  }
  ctx.on('agent/created', ({ agent } = {}) => {
    const agentCtx = agent?.ctx;
    if (!agentCtx?.on) return;
    const sessionId = String(agent.id ?? 'unknown');
    if (sessionId.startsWith('mnemoweave-task-')) return;
    const offs = [];
    offs.push(agentCtx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const assembled = await next();
      try {
        // Every assembly fetches the View again, so a runtime rule added or edited in the page
        // reaches the model on the next turn. A failed fetch leaves the turn untouched and the
        // next turn retries; no failure is remembered.
        const text = await fetchInjection(sessionId, config);
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
  return () => {
    for (const release of releases.splice(0)) {
      try { release(); } catch { /* already released */ }
    }
  };
}
