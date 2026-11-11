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
  if (rules.length > 0) {
    blocks.push(`Runtime rules (confirmed by the user, follow them):\n${rules.map(rule => `- ${rule}`).join('\n')}`);
    if (view?.rulesBudget?.exceeded === true) {
      const count = view.rulesBudget.omittedCount;
      blocks.push(`Runtime rules omitted: ${typeof count === 'number' ? `${count} complete lower-priority entries did not fit` : 'the budget was exceeded'}.`);
    }
  } else if (view?.rulesBudget?.exceeded === true) blocks.push('Runtime rules were omitted: the budget was exceeded.');
  const working = (view?.workingContext ?? []).map(entry => String(entry?.text ?? '')).filter(text => text.trim() !== '');
  if (working.length > 0) blocks.push(`Working context (unverified session material):\n${working.join('\n')}`);
  const memories = (view?.memories ?? []).filter(memory => String(memory?.content ?? '').trim() !== '');
  if (memories.length > 0) {
    blocks.push(`Formal memories:\n${memories.map((memory) => {
      const excerpt = memory?.excerpt === true ? ' [excerpt]' : '';
      return `- ${memory.content}${excerpt}`;
    }).join('\n')}`);
  }
  return blocks.join('\n\n');
}

/** Resolved once per turn, so a settings change is picked up without restarting DSH. */
function currentConfig(config) {
  return resolveHostConfig(config, process.env, readPreferences(process.env));
}

/** Model evidence is smaller than the Provider Recall surface: 1 KiB body, 8 KiB total. */
const MODEL_BODY_BYTES = 1024;
const MODEL_TOTAL_BYTES = 8 * 1024;
function clipUtf8(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let out = '';
  for (const char of text) {
    if (Buffer.byteLength(out + char, 'utf8') > maxBytes) break;
    out += char;
  }
  return out;
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
          limit: { type: 'integer', minimum: 1, maximum: 5, description: 'How many memories to return (default 5).' },
        },
        required: ['query'],
      },
      output: TOOL_OUTPUT,
      execute: async (args, execution) => {
        const result = await callServer(
          config,
          'POST',
          '/v1/recall',
          { query: args.query, ...(args.limit === undefined ? {} : { limit: Math.min(args.limit, 5) }) },
          execution?.signal,
        );
        const memories = Array.isArray(result?.memories) ? result.memories : [];
        let total = 0;
        let truncated = false;
        const bounded = [];
        for (const memory of memories) {
          const content = clipUtf8(String(memory?.content ?? ''), MODEL_BODY_BYTES);
          const bytes = Buffer.byteLength(content, 'utf8');
          if (total + bytes > MODEL_TOTAL_BYTES) { truncated = true; break; }
          total += bytes;
          bounded.push({ ...memory, content, ...(bytes < Buffer.byteLength(String(memory?.content ?? ''), 'utf8') ? { excerpt: true } : {}) });
        }
        return { ...result, memories: bounded, ...(truncated ? { truncated: true } : {}) };
      },
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
      description: 'Read the runtime rules (运行时记忆) that this Server injects into every turn, with their version and enabled state. Rules apply to every session and are read-only here: they are added and edited on the memory page, and the model cannot publish or change them.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: TOOL_OUTPUT,
      execute: (_args, execution) => callServer(config, 'GET', '/v1/rules', undefined, execution?.signal),
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
        const query = args.query?.trim();
        if (Boolean(query) === Boolean(args.entryId)) throw new Error('Supply a query or an archive entryId');
        const params = new URLSearchParams({ projectId });
        if (args.entryId) {
          // Reading one archive is an explicit management read: history returns every stored
          // version, newest first, and the first item is the current body.
          const { items } = await callServer(config, 'GET', `/v1/archives/${encodeURIComponent(args.entryId)}/history`, undefined, execution?.signal);
          const archive = items[0];
          if (!archive) throw new Error('Archive not found in this project');
          if (archive.projectId !== projectId) throw new Error('Archive not found in this project');
          return archive;
        }
        params.set('query', query);
        params.set('limit', '10');
        const result = await callServer(config, 'GET', `/v1/archives/search?${params}`, undefined, execution?.signal);
        return {
          query: result.query,
          total: result.total,
          truncated: result.truncated,
          items: result.results.map(({ entryId, title, verification, version, state, excerpt, excerptTruncated }) => ({
            entryId, title, verification, version, state, excerpt, excerptTruncated,
          })),
        };
      },
    },
    {
      name: 'mnemoweave_remember',
      description: 'Submit one immutable candidate for review. It does not write formal memory: the Worker checks it by rule, and a request it cannot settle waits for a person. Use it only for a durable fact the user supplied or confirmed; never publish model speculation, transcripts or temporary progress.',
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
        },
        required: ['content', 'knowledgeType'],
      },
      output: TOOL_OUTPUT,
      execute: (args, execution) => {
        const body = {
          idempotencyKey: randomUUID().replaceAll('-', ''),
          content: args.content,
          knowledgeType: args.knowledgeType,
          ...(args.tags === undefined ? {} : { tags: args.tags }),
          ...(args.category === undefined ? {} : { category: args.category }),
          ...(args.importance === undefined ? {} : { importance: args.importance }),
          ...(args.entities === undefined ? {} : { entities: args.entities }),
          provenance: {
            source: 'agent',
            sourceReference: `dsh-mnemo-weave:${String(execution?.agent?.id ?? 'unknown')}`,
            evidence: ['Submitted as a candidate by the model through the MnemoWeave DSH tool.'],
            verificationStatus: 'unverified',
            confidence: 0.5,
            applicability: 'global',
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
/** The durable log, not the wall clock, identifies the turn a prompt assembly belongs to. */
function openTurn(agent) {
  let open;
  try {
    for (const event of agent?.session?.snapshotEvents?.() ?? []) {
      const turn = typeof event?.data?.turn === 'number' ? event.data.turn : undefined;
      if (event?.type === 'turn/start' && turn !== undefined) open = turn;
      else if (event?.type === 'turn/end' && event?.data?.turn === open) open = undefined;
    }
  } catch {
    return undefined;
  }
  return open;
}

/** One View per accepted turn: later model steps in the same turn reuse it unchanged. */
function createTurnView(agent, sessionId, config) {
  let cached;
  const load = async () => {
    const turn = openTurn(agent);
    // Hosts that expose no durable turn cannot prove two assemblies belong together, so they
    // keep the older per-assembly fetch rather than silently reusing a View across turns.
    if (turn === undefined) return fetchInjection(sessionId, config);
    if (cached?.turn === turn) {
      if (cached.pending !== undefined) return cached.pending;
      return cached.text;
    }
    const pending = fetchInjection(sessionId, config);
    const entry = { turn, pending };
    cached = entry;
    const text = await pending;
    if (cached === entry) cached = { turn, text };
    return text;
  };
  return { load, clear: () => { cached = undefined; } };
}

export function apply(ctx, config = {}) {
  const releases = [];
  const agentDisposers = new Set();
  for (const tool of createTools(config)) {
    const release = ctx.tools?.register?.(tool);
    if (typeof release === 'function') releases.push(release);
  }
  ctx.on('agent/created', ({ agent } = {}) => {
    const agentCtx = agent?.ctx;
    if (!agentCtx?.on) return;
    const sessionId = String(agent.id ?? 'unknown');
    if (sessionId.startsWith('mnemoweave-task-')) return;
    const loadView = createTurnView(agent, sessionId, config);
    const offs = [];
    offs.push(agentCtx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const assembled = await next();
      try {
        // A rule edited during a turn reaches the model on the next turn; the accepted turn
        // keeps one View so every model step sees the same sources and authority.
        const text = await loadView.load();
        if (!text) return assembled;
        return { ...assembled, sections: [...(assembled.sections ?? []), { name: 'mnemo-weave:view', text }] };
      } catch {
        return assembled;
      }
    }));
    offs.push(agentCtx.on('agent/turn-stopping', () => {
      loadView.clear();
      // The turn is complete (its end event follows). Selection is deterministic and cheap, so
      // the Server records the durable signals an idle-review task reads later; nothing is
      // written to memory here and a failure leaves the turn unaffected.
      const turn = openTurn(agent);
      if (turn !== undefined) {
        void callServer(config, 'POST', '/v1/idle-review/scan', {
          sessionId, completedThroughTurn: turn, maxSignals: 10,
        }).catch(() => undefined);
      }
    }));
    agentDisposers.add(() => {
      for (const off of offs.splice(0)) { try { off?.(); } catch { /* already disposed */ } }
    });
  });
  return () => {
    for (const release of releases.splice(0)) {
      try { release(); } catch { /* already released */ }
    }
    for (const dispose of agentDisposers) {
      try { dispose(); } catch { /* already disposed */ }
    }
    agentDisposers.clear();
  };
}
