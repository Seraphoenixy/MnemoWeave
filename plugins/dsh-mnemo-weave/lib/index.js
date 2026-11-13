// DSH plugin: registers the native memory tools and injects the complete rule block once per turn.
// Cordis plugin shape: name/inject/apply. No runtime dependencies; every call goes to the local
// MnemoWeave Server with the service token.
//
// Configuration is not resolved here. `./host-config.js` is the single reader shared with the
// page's Host half, so the endpoint, Host identity and injection budget the page shows are the
// same values this hook uses. Stored preferences win over the Cordis entry, which wins over the
// environment.
import { randomUUID } from 'node:crypto';
import { ensureReachable, readPreferences, resolveHostConfig } from './host-config.js';

export const name = 'dsh-mnemo-weave';
// Registering the memory tools is the host service that makes them callable; without it the
// plugin still injects the rules but the model has no way to ask for anything else.
export const inject = ['tools'];

/**
 * Reads a service the plugin does not declare. Cordis throws `cannot get property "X" without
 * inject` for any undeclared name, and an exception in `apply` unloads the whole fiber, so an
 * optional dependency must be read through `ctx.get` (which answers undefined) rather than as a
 * property. The command registry below is such a dependency: the tools and the injected rules do
 * not depend on it.
 */
function readOptionalService(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(name);
    return ctx[name];
  } catch {
    return undefined;
  }
}

/** The shared engineering-experience guidance every `remember` description quotes. */
export const ENGINEERING_EXPERIENCE_GUIDANCE = [
  '当本轮验证了一个非显然、能减少未来排查或返工、且可在其他工作区复用的工程结论时，主动考虑记录。',
  '先在剩余召回额度内核对是否已有同等结论，再选本轮最有价值的一条，写清适用条件、观察结果和可复用做法，并给出证据引用。本轮不留存时跳过。',
  '适合记录的是有可核对依据的诊断方法、工具版本差异、可复现的故障条件和验证过的解决办法；仓库特有路径、部署地址和项目交接信息留在工作区档案。',
  '单凭执行过一条命令、一次原因不明的成功、模型猜测或原始日志堆积不能作为新经验提交。',
].join('');
const NO_RETENTION_NOTE = '本轮被标记为不留存时，这些工具会拒绝写入。';

/**
 * Renders the resident rule block. Every rule is delivered whole; when the host could not hold the
 * whole set the block is empty and the reason is written to stderr, so the model never sees a
 * partial set that looks complete.
 */
export function render(injection) {
  if (injection === null || typeof injection !== 'object') return '';
  if (injection.complete === false) return '';
  const rules = Array.isArray(injection.rules) ? injection.rules : [];
  const bodies = rules.map(rule => String(rule?.body ?? '').trim()).filter(body => body !== '');
  if (bodies.length === 0) return '';
  return `准则（用户确认，按此执行）：\n${bodies.map(body => `- ${body}`).join('\n')}`;
}

/** Resolved once per call, so a settings change is picked up without restarting DSH. */
function currentConfig(config) {
  return resolveHostConfig(config, process.env, readPreferences(process.env));
}

/** Model evidence is smaller than the Provider Recall surface. */
const MODEL_BODY_CHARS = 1200;

function clipChars(text, max) {
  if (text.length <= max) return text;
  let end = Math.max(0, max);
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return text.slice(0, end);
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
  try {
    const response = await fetch(`${resolved.serverUrl}/v1/inject`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-mnemoweave-host': resolved.hostId,
      },
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(remaining),
    });
    if (!response.ok) {
      process.stderr.write(`${JSON.stringify({ event: 'mnemoweave_injection_failed', code: response.status })}\n`);
      return undefined;
    }
    const injection = await response.json();
    const text = render(injection);
    if (text === '') {
      // A complete-but-empty set renders nothing; an incomplete one is a delivery failure.
      if (injection?.complete === false) {
        process.stderr.write(`${JSON.stringify({ event: 'mnemoweave_injection_incomplete', reason: 'the host output limit could not hold every rule' })}\n`);
      }
      return undefined;
    }
    return text;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ event: 'mnemoweave_injection_failed', reason: error instanceof Error ? error.name : 'unknown' })}\n`);
    return undefined;
  }
}

/** One text projection for every tool result: the model reads the JSON the Server returned. */
const TOOL_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2) }],
};

/**
 * One authenticated call to the local Server.
 *
 * Model-facing reads must carry the session and turn they ran in: the Server attributes a turn
 * budget from these headers and refuses a call that does not name a turn. The identity comes from
 * the tool execution context, never from the model's arguments.
 */
async function callServer(config, method, path, body, execution, query) {
  const resolved = currentConfig(config);
  if (!resolved.token || resolved.token.length < 24) {
    throw new Error('MnemoWeave service token is not configured (MNEMOWEAVE_TOKEN)');
  }
  const sessionId = typeof execution?.agent?.id === 'string' && execution.agent.id !== '' ? execution.agent.id : undefined;
  const turn = currentTurn(execution);
  const turnId = turn === undefined ? undefined : String(turn);
  const agentId = typeof execution?.agent?.id === 'string' ? execution.agent.id : 'default';
  const search = query === undefined ? '' : `?${new URLSearchParams(query).toString()}`;
  const timeout = AbortSignal.timeout(10_000);
  const signal = execution?.signal === undefined ? timeout : AbortSignal.any([execution.signal, timeout]);
  const response = await fetch(`${resolved.serverUrl}${path}${search}`, {
    method,
    headers: {
      authorization: `Bearer ${resolved.token}`,
      'x-mnemoweave-host': resolved.hostId,
      ...(sessionId === undefined ? {} : { 'x-mnemoweave-session-id': sessionId }),
      ...(turnId === undefined ? {} : { 'x-mnemoweave-turn-id': turnId }),
      'x-mnemoweave-agent-id': agentId,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  const text = await response.text();
  let parsed;
  try { parsed = text === '' ? {} : JSON.parse(text); } catch { throw new Error('MnemoWeave returned a response that is not JSON'); }
  if (!response.ok) {
    const code = typeof parsed?.code === 'string' ? parsed.code : 'INTERNAL';
    throw new Error(code);
  }
  return parsed;
}

/**
 * The model-facing tool family.
 *
 * Names carry the product prefix rather than dsh-mnemon's `mnemon_` prefix, because both plugins
 * can be installed in the same DSH profile and two tools with one name would collide. The family
 * stays inside the project's write boundary: recall/read/rules are reads, and `remember` hands the
 * proposed body to a write task; it never publishes from the model's own call.
 */
export function createTools(config) {
  return [
    {
      name: 'mnemoweave_recall',
      description: 'Recall published formal memories from the shared collection by semantic similarity. Read-only. Returns memory ids and text so you can open or cite them.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'What to search for, in natural language.' },
          limit: { type: 'integer', minimum: 1, maximum: 4, description: 'How many memories to return.' },
        },
        required: ['query'],
      },
      output: TOOL_OUTPUT,
      execute: async (args, execution) => {
        const result = await callServer(config, 'POST', '/v1/recall', {
          query: args.query, ...(args.limit === undefined ? {} : { limit: Math.min(args.limit, 4) }),
        }, execution);
        const memories = Array.isArray(result?.memories) ? result.memories : [];
        let total = 0;
        let truncated = false;
        const bounded = [];
        for (const memory of memories) {
          const content = clipChars(String(memory?.content ?? ''), MODEL_BODY_CHARS);
          if (total + content.length > 3600) { truncated = true; break; }
          total += content.length;
          bounded.push({ ...memory, content, ...(content.length < String(memory?.content ?? '').length ? { excerpt: true } : {}) });
        }
        return { ...result, memories: bounded, ...(truncated ? { truncated: true } : {}) };
      },
    },
    {
      name: 'mnemoweave_read_memory',
      description: 'Read one published formal memory: the current revision by default, or a named historical revision. Read-only. One complete body may be read per turn.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memoryId: { type: 'string', description: 'The memory id returned by recall or the list.' },
          revisionId: { type: 'string', description: 'A revision id from the memory history; omit for the current revision.' },
        },
        required: ['memoryId'],
      },
      output: TOOL_OUTPUT,
      execute: (args, execution) => callServer(
        config, 'GET',
        `/v1/memories/${encodeURIComponent(args.memoryId)}`,
        undefined, execution,
        args.revisionId === undefined ? undefined : { revisionId: args.revisionId },
      ),
    },
    {
      name: 'mnemoweave_read_rules',
      description: 'Read the resident rules (准则) with their version and enabled state. Rules apply to every session and are read-only here: they are added and edited in the memory page. Reading does not change the rules already injected into this turn.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: TOOL_OUTPUT,
      execute: (_args, execution) => callServer(config, 'GET', '/v1/rules', undefined, execution),
    },
    {
      name: 'mnemoweave_change_rule',
      description: `Ask the user to change one rule. This tool does not write: a rule change is a user write with a version the editor read, so the page's rule editor performs it. Return what you would propose and let the user confirm it there.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['create', 'edit', 'remove'] },
          body: { type: 'string', description: 'The rule text for create or edit.' },
          entryId: { type: 'string', description: 'The rule being edited or removed.' },
          baseVersion: { type: 'integer', minimum: 1, description: 'The version read from mnemoweave_read_rules.' },
          reason: { type: 'string', description: 'Why the user asked for this change.' },
        },
        required: ['action', 'reason'],
      },
      output: TOOL_OUTPUT,
      execute: async (_args, execution) => {
        const refusal = noRetentionRefusal(execution);
        if (refusal !== undefined) throw refusal;
        // A rule write needs the user's own confirmation in an editor that carries the version
        // they read. Handing that to the model would remove the confirmation step entirely.
        throw new Error('RULE_WRITE_REQUIRES_USER: change rules in the memory page');
      },
    },
    {
      name: 'mnemoweave_workspace_archives',
      description: 'Read workspace archives for the session the host bound. Pass a query to search (bounded excerpts), or an entryId with an optional cursor to read the current body in segments. The two are exclusive. The model has no workspace parameter: the host takes it from the session binding.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 200 },
          entryId: { type: 'string', format: 'uuid' },
          cursor: { type: 'string', description: 'A cursor returned by a previous call for the same archive version.' },
        },
        oneOf: [{ required: ['query'] }, { required: ['entryId'] }],
      },
      output: TOOL_OUTPUT,
      execute: async (args, execution) => {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (Boolean(query) === Boolean(args.entryId)) throw new Error('Supply a query or an archive entryId');
        if (args.entryId !== undefined) {
          return callServer(config, 'GET', `/v1/archives/${encodeURIComponent(args.entryId)}/content`, undefined, execution,
            args.cursor === undefined ? undefined : { cursor: args.cursor });
        }
        const result = await callServer(config, 'GET', '/v1/archives/search', undefined, execution, { query, limit: '5' });
        return {
          query: result.query,
          total: result.total,
          truncated: result.truncated,
          items: (result.results ?? []).map(({ entryId, title, verification, version, state, excerpt, excerptTruncated }) => ({
            entryId, title, verification, version, state, excerpt, excerptTruncated,
          })),
        };
      },
    },
    {
      name: 'mnemoweave_write_workspace_archive',
      description: `Create or update an archive in the workspace the host bound to this session. An update must carry the baseVersion read from the archive. The idle review may only create. ${NO_RETENTION_NOTE}`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['create', 'edit'] },
          entryId: { type: 'string', description: 'The archive being edited.' },
          baseVersion: { type: 'integer', minimum: 1, description: 'The version read before editing.' },
          title: { type: 'string', maxLength: 200 },
          body: { type: 'string' },
          evidence: { type: 'string', maxLength: 2000 },
          reason: { type: 'string' },
        },
        required: ['action', 'reason'],
      },
      output: TOOL_OUTPUT,
      execute: async (_args, execution) => {
        const refusal = noRetentionRefusal(execution);
        if (refusal !== undefined) throw refusal;
        // An archive write is attributed to a workspace and a version the user read; the page's
        // archive form carries both. The model may read archives but not create them here.
        throw new Error('ARCHIVE_WRITE_REQUIRES_USER: write archives in the memory page');
      },
    },
    {
      name: 'mnemoweave_related',
      description: 'Expand the relations of a formal memory this turn already recalled. One call per turn, bounded result count, and never a memory already delivered.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memoryId: { type: 'string', description: 'A memory id returned by mnemoweave_recall this turn.' },
          edge: { type: 'string', enum: ['supersedes', 'semantic', 'causal', 'entity', 'temporal'] },
        },
        required: ['memoryId'],
      },
      output: TOOL_OUTPUT,
      execute: (args, execution) => callServer(config, 'POST', '/v1/memories/related', args, execution),
    },
    {
      name: 'mnemoweave_remember',
      description: `Propose one durable engineering conclusion or a long-term fact the user supplied. Submit it as a candidate for review and return the candidate receipt. ${ENGINEERING_EXPERIENCE_GUIDANCE} ${NO_RETENTION_NOTE}`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string', description: 'The memory text, 1–8000 UTF-8 bytes.' },
          category: { type: 'string', enum: ['preference', 'decision', 'fact', 'insight', 'context', 'general'] },
          importance: { type: 'integer', minimum: 1, maximum: 5 },
          tags: { type: 'array', items: { type: 'string' }, description: 'At most 20 tags.' },
          entities: { type: 'array', items: { type: 'string' }, description: 'At most 50 entity names.' },
          evidenceRefs: { type: 'array', items: { type: 'string' }, description: 'Ids of the evidence this turn produced: persisted user events or verified observations.' },
          reason: { type: 'string', description: 'Why this is worth keeping now.' },
          assessment: { type: 'string', enum: ['supported', 'uncertain', 'conflict'] },
        },
        required: ['content', 'reason'],
      },
      output: TOOL_OUTPUT,
      execute: async (args, execution) => {
        // A turn marked "do not retain" refuses the write before any task or candidate exists.
        const refusal = noRetentionRefusal(execution);
        if (refusal !== undefined) throw refusal;
        // Model-initiated remember submits a candidate for review.
        const candidate = await callServer(config, 'POST', '/v1/remember', {
          idempotencyKey: `dsh-${randomUUID()}`.slice(0, 64),
          content: args.content,
          tags: [],
          ...(args.category === undefined ? {} : { category: args.category }),
          ...(args.importance === undefined ? {} : { importance: args.importance }),
          ...(args.entities === undefined ? {} : { entities: args.entities }),
          ...(args.evidenceRefs === undefined ? {} : { evidenceRefs: args.evidenceRefs }),
          provenance: {
            source: 'dsh-host',
            sourceReference: `mnemoweave-tool:${String(args.reason).slice(0, 200)}`,
          },
          ...(args.assessment === 'supported' ? {} : {}),
        }, execution);
        return { status: 'candidate', candidate };
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

/**
 * The turn each session is currently in.
 *
 * DSH does not put a turn on the tool execution context, and the `agent` a tool receives is not
 * the one whose Session log the prompt hook reads, so a tool cannot derive the turn on its own.
 * The `system-prompt/assemble` hook runs once per model step with the live agent, so it records
 * the open turn there and the tools read it back. Without this the tools sent a session header and
 * no turn header, which the Server refuses as a partial identity.
 */
const openTurnBySession = new Map();

function rememberTurn(sessionId, turn) {
  if (typeof sessionId !== 'string' || sessionId === '') return;
  if (turn === undefined) openTurnBySession.delete(sessionId);
  else openTurnBySession.set(sessionId, turn);
}

/**
 * The turn a tool call belongs to. An explicit `execution.turn` wins when a host supplies one;
 * otherwise the turn recorded by the current step's prompt assembly is used, then the Session log.
 */
function currentTurn(execution) {
  const explicit = typeof execution?.turn === 'number' ? execution.turn
    : typeof execution?.turn === 'string' && execution.turn.trim() !== '' ? Number(execution.turn) : undefined;
  if (explicit !== undefined && Number.isFinite(explicit)) return explicit;
  const sessionId = execution?.agent?.id;
  if (typeof sessionId === 'string') {
    const recorded = openTurnBySession.get(sessionId);
    if (recorded !== undefined) return recorded;
  }
  return openTurn(execution?.agent);
}

/**
 * Whether the current turn was marked "do not retain".
 *
 * The Host records that intent as a session event on the turn it applies to; a turn with no such
 * event is retained. Marking is per turn, never per session, so the next turn is unaffected.
 */
function turnNoRetention(agent, turn) {
  if (turn === undefined) return false;
  try {
    for (const event of agent?.session?.snapshotEvents?.() ?? []) {
      if (event?.type !== 'turn/no-retention' && event?.type !== 'turn/noRetention') continue;
      if (event?.data?.turn === turn || event?.data?.turn === undefined) return true;
    }
  } catch {
    // An unreadable log cannot prove the turn is retained, so the write is refused instead.
    return true;
  }
  return false;
}

/**
 * A write the Host must refuse because the turn promised not to retain anything.
 *
 * The check runs before any task delegation, candidate submission or resource write, so a refused
 * turn leaves no trace. The Server repeats the check when the action carries a turn binding.
 */
let markedNoRetention = () => false;

function noRetentionRefusal(execution) {
  const agent = execution?.agent;
  const turn = currentTurn(execution);
  if (agent === undefined || turn === undefined || !Number.isFinite(turn)) return undefined;
  if (!turnNoRetention(agent, turn) && !markedNoRetention(agent, turn)) return undefined;
  const error = new Error('TURN_NO_RETENTION: this turn was marked not to be retained, so no memory write is accepted');
  error.code = 'TURN_NO_RETENTION';
  return error;
}

/** One rule block per accepted turn: later model steps in the same turn reuse it unchanged. */
function createTurnRules(agent, sessionId, config) {
  let cached;
  const load = async () => {
    const turn = openTurn(agent);
    // Tools cannot see this agent, so the turn is published here for them to read back.
    rememberTurn(sessionId, turn);
    // A host that exposes no durable turn cannot prove two assemblies belong together, so it
    // reads again rather than silently reusing a block across turns.
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

/** The command name a person types to mark the current turn as not retained. */
export const NO_RETENTION_COMMAND = 'no-retention';

export function apply(ctx, config = {}) {
  const releases = [];
  const agentDisposers = new Set();
  // 「本轮不留存」: a turn-scoped marker. It is sent to the Server as a host event with the
  // documented `noRetention` payload, so the Server refuses that turn's writes on its own, and
  // kept in memory so the tools in this process refuse before sending anything. It covers the
  // turn it was set on; a later turn in the same session is retained normally.
  const noRetentionTurns = new Map();
  // Expire a marker after the turn is long over, so the map cannot grow without bound.
  markedNoRetention = (agent, turn) => {
    const key = `${String(agent?.id ?? 'unknown')}:${turn}`;
    const at = noRetentionTurns.get(key);
    if (at === undefined) return false;
    if (Date.now() - at > 24 * 60 * 60_000) { noRetentionTurns.delete(key); return false; }
    return true;
  };
  const commands = readOptionalService(ctx, 'commands');
  if (typeof commands?.register === 'function') {
    const release = commands.register({
      name: NO_RETENTION_COMMAND,
      description: '标记本轮不留存：本轮不进入空闲复盘，模型发起的记忆写入被拒绝。只影响当前轮次。',
      recordInput: false,
      handler: invocation => {
        const agent = invocation?.agent;
        const turn = openTurn(agent);
        if (turn === undefined) return { message: '当前没有可标记的轮次。' };
        const sessionId = String(agent?.id ?? 'unknown');
        const key = `${sessionId}:${turn}`;
        noRetentionTurns.set(key, Date.now());
        // Report the intent to the Server; a failed report still leaves the local refusal in
        // place, and the person is told the turn is marked rather than told nothing happened.
        void callServer(config, 'POST', '/v1/events', {
          protocolVersion: '1', adapterVersion: 'dsh-mnemo-weave',
          eventId: `no-retention-${sessionId}-${turn}`.slice(0, 128),
          sessionId, turnId: String(turn),
          kind: 'message.user',
          occurredAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
          sourceRef: 'dsh-mnemo-weave:no-retention',
          payload: { text: '本轮不留存', noRetention: true },
        }, undefined).catch(() => undefined);
        return { message: `已将第 ${turn} 轮标记为不留存。` };
      },
    });
    if (typeof release === 'function') releases.push(release);
  }
  for (const tool of createTools(config)) {
    const release = ctx.tools?.register?.(tool);
    if (typeof release === 'function') releases.push(release);
  }
  ctx.on('agent/created', ({ agent } = {}) => {
    const agentCtx = agent?.ctx;
    if (!agentCtx?.on) return;
    const sessionId = String(agent.id ?? 'unknown');
    // The write-task Agent does not receive the resident block or any tool; it works from the
    // evidence its host passes in.
    if (sessionId.startsWith('mnemoweave-task-')) return;
    const loadRules = createTurnRules(agent, sessionId, config);
    const offs = [];
    offs.push(agentCtx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const assembled = await next();
      try {
        const text = await loadRules.load();
        if (!text) return assembled;
        return { ...assembled, sections: [...(assembled.sections ?? []), { name: 'mnemo-weave:rules', text }] };
      } catch {
        return assembled;
      }
    }));
    offs.push(agentCtx.on('agent/turn-stopping', () => {
      loadRules.clear();
      // The turn is complete (its end event follows). Selection is deterministic and cheap, so the
      // Server records the durable signals an idle-review task reads later; nothing is written to
      // memory here and a failure leaves the turn unaffected.
      const turn = openTurn(agent);
      if (turn !== undefined) {
        void callServer(config, 'POST', '/v1/idle-review/scan', {
          sessionId, completedThroughTurn: turn, maxSignals: 10,
        }, undefined).catch(() => undefined);
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
