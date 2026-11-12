import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NO_RETENTION_COMMAND, apply, createTools, inject, render } from '../../plugins/dsh-mnemo-weave/lib/index.js';

/**
 * The DSH plugin's model-facing tools and prompt handling.
 *
 * The Server is stubbed at `fetch`: these tests pin what the plugin sends (path, identity headers,
 * turn identity, candidate provenance) and that the prompt section carries the rules only. They do
 * not replace the Server's own contract tests.
 */

const root = mkdtempSync(join(tmpdir(), 'mnemoweave-dsh-tools-'));
const TOKEN = 't'.repeat(32);
const CONFIG = { serverUrl: 'http://127.0.0.1:4399', token: TOKEN, hostId: 'dsh-test' };
const EXPECTED_TOOLS = [
  'mnemoweave_recall', 'mnemoweave_read_memory', 'mnemoweave_read_rules', 'mnemoweave_change_rule',
  'mnemoweave_workspace_archives', 'mnemoweave_write_workspace_archive', 'mnemoweave_related',
  'mnemoweave_remember',
];
type FetchCall = { url: string; init: RequestInit };

let calls: FetchCall[] = [];
let released: string[] = [];
/** The DSH tool execution context: the agent id is the session id DSH uses everywhere else. */
const toolRun = (turn: number, agentId = 'session-1') => ({ signal: undefined, agent: { id: agentId }, turn });
const INJECTION = { hostId: 'dsh-test', sessionId: 's-1', rules: [{ body: '提交前必须运行类型检查。' }], usedBytes: 33, limitBytes: 10_000, complete: true, createdAt: '2026-11-10T00:00:00.000Z' };

before(() => {
  process.env.MNEMOWEAVE_DSH_SETTINGS = join(root, 'settings.json');
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    calls.push({ url: target, init: init ?? {} });
    if (target.endsWith('/health/live')) return new Response(JSON.stringify({ live: true, service: 'mnemoweave', protocol: 1 }), { status: 200 });
    if (target.endsWith('/v1/inject')) return new Response(JSON.stringify(INJECTION), { status: 200 });
    if (target.endsWith('/v1/rules')) {
      return new Response(JSON.stringify({ items: [{ entryId: 'rule-1', body: '准则正文', enabled: true, version: 1, withdrawnAt: null }], usage: { limitBytes: 10_000, usedBytes: 12, entryCount: 1, itemMaxBytes: 8192, exceeded: false, overByBytes: 0 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ memories: [{ id: 'm1', content: '命中正文' }], complete: true }), { status: 200 });
  }) as typeof fetch;
});

after(() => {
  delete process.env.MNEMOWEAVE_DSH_SETTINGS;
  rmSync(root, { recursive: true, force: true });
});

/**
 * A Host context that records the tool registrations and event handlers.
 *
 * It reproduces the Cordis behavior that decides whether the plugin loads at all: reading a
 * service that is neither declared nor provided throws `cannot get property "X" without inject`,
 * and the exception escapes `apply`, so nothing is registered. A stub that answered `undefined`
 * for every unknown name hid exactly that failure. `ctx.get` is the documented unchecked read.
 */
function hostContext(options: { commands?: boolean } = {}) {
  const tools: Array<{ name: string; description: string; execute: (args: never, execution?: unknown) => Promise<unknown> }> = [];
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const provided = new Map<string, unknown>();
  if (options.commands === true) provided.set('commands', { register: () => () => undefined });
  const target = {
    tools: {
      register(definition: { name: string }) {
        tools.push(definition as never);
        released.push(definition.name);
        return () => { released.push(`release:${definition.name}`); };
      },
    },
    on(event: string, handler: (payload: unknown) => unknown) {
      handlers.set(event, handler);
      return () => undefined;
    },
    get(name: string) { return provided.get(name); },
  };
  const ctx = new Proxy(target, {
    get(object, prop, receiver) {
      if (typeof prop === 'string' && !(prop in object) && !provided.has(prop)) {
        throw new Error(`cannot get property "${prop}" without inject`);
      }
      return Reflect.get(object, prop, receiver);
    },
  });
  return { ctx, tools, handlers };
}

test('the plugin declares the tools service and registers the documented tool family once each', () => {
  assert.deepEqual(inject, ['tools']);
  const { ctx, tools } = hostContext();
  apply(ctx, CONFIG);
  assert.deepEqual(tools.map(tool => tool.name), EXPECTED_TOOLS);
  for (const tool of tools) assert.ok(tool.description.length > 40, `${tool.name} explains itself`);
  // The names the workspace model retired must not linger: a model that still sees one would call
  // a route that no longer exists.
  for (const removed of ['mnemoweave_runtime_memory', 'mnemoweave_project_archives']) {
    assert.equal(tools.some(tool => tool.name === removed), false, removed);
  }
});

test('a Host without the command registry still gets every tool and the injected rules', () => {
  // The command registry is optional. Reading it as a property used to throw out of `apply`, and
  // the failure was invisible here because every stub returned `undefined` for unknown names.
  const { ctx, tools, handlers } = hostContext();
  assert.doesNotThrow(() => apply(ctx, CONFIG));
  assert.deepEqual(tools.map(tool => tool.name), EXPECTED_TOOLS);
  assert.equal(handlers.has('agent/created'), true, 'the prompt hook is still registered');
});

test('applying and disposing releases every registration', () => {
  const { ctx, tools } = hostContext();
  const dispose = apply(ctx, CONFIG);
  assert.equal(tools.length, EXPECTED_TOOLS.length);
  dispose();
  assert.equal(released.filter(name => name.startsWith('release:')).length, EXPECTED_TOOLS.length, 'each tool has a disposer');
});

test('a tool call with no turn field on the execution context still names its turn from the log', async () => {
  // DSH does not put a turn on the tool execution context. Reading only `execution.turn` sent a
  // session header and no turn header, and the Server refuses that partial identity as
  // UNAUTHORIZED. The Session log is the authority for the open turn.
  calls = [];
  const recall = createTools(CONFIG).find(tool => tool.name === 'mnemoweave_recall')!;
  const agent = { id: 'session-from-log', session: { snapshotEvents: () => [{ type: 'turn/start', data: { turn: 12 } }] } };
  await recall.execute({ query: 'TypeScript', limit: 2 } as never, { signal: undefined, agent } as never);
  const headers = calls.at(-1)!.init.headers as Record<string, string>;
  assert.equal(headers['x-mnemoweave-turn-id'], '12', 'the open turn comes from the session log');
  assert.equal(headers['x-mnemoweave-session-id'], 'session-from-log');
  // A turn that already ended must not be reported: the next turn has not started yet.
  const closed = { id: 'session-ended', session: { snapshotEvents: () => [{ type: 'turn/start', data: { turn: 3 } }, { type: 'turn/end', data: { turn: 3 } }] } };
  await recall.execute({ query: 'TypeScript', limit: 2 } as never, { signal: undefined, agent: closed } as never);
  assert.equal((calls.at(-1)!.init.headers as Record<string, string>)['x-mnemoweave-turn-id'], undefined);
});

test('the no-retention refusal also derives the turn from the session log', async () => {
  calls = [];
  const remember = createTools(CONFIG).find(tool => tool.name === 'mnemoweave_remember')!;
  const agent = {
    id: 'session-refused',
    session: {
      snapshotEvents: () => [
        { type: 'turn/start', data: { turn: 9 } },
        { type: 'turn/no-retention', data: { turn: 9 } },
      ],
    },
  };
  await assert.rejects(
    async () => remember.execute({ content: '候选正文', reason: '测试', evidenceRefs: ['e-1'] } as never, { signal: undefined, agent } as never),
    /TURN_NO_RETENTION/,
  );
  assert.equal(calls.length, 0, 'a refused turn never reaches the Server');
});

test('recall carries the host and turn identity and stays a read', async () => {
  calls = [];
  const recall = createTools(CONFIG).find(tool => tool.name === 'mnemoweave_recall')!;
  await recall.execute({ query: 'TypeScript', limit: 4 } as never, toolRun(7, 'session-1') as never);
  const call = calls.at(-1)!;
  assert.equal(call.url, 'http://127.0.0.1:4399/v1/recall');
  assert.equal(call.init.method, 'POST');
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers['authorization'], `Bearer ${TOKEN}`);
  assert.equal(headers['x-mnemoweave-host'], 'dsh-test');
  // The turn identity comes from the tool execution context, never from the model's arguments.
  assert.equal(headers['x-mnemoweave-session-id'], 'session-1');
  assert.equal(headers['x-mnemoweave-turn-id'], '7');
  assert.equal(headers['x-mnemoweave-agent-id'], 'session-1');
  assert.deepEqual(JSON.parse(String(call.init.body)), { query: 'TypeScript', limit: 4 });
  // The tool caps the result itself so a model cannot ask for the administrative page size.
  assert.equal((recall.parameters as { properties: { limit: { maximum: number } } }).properties.limit.maximum, 4);
});

test('read_memory reads one revision and read_rules lists the whole set', async () => {
  calls = [];
  const tools = createTools(CONFIG);
  await tools.find(tool => tool.name === 'mnemoweave_read_memory')!.execute({ memoryId: 'm-1', revisionId: 'r-2' } as never, { signal: undefined });
  assert.equal(calls.at(-1)!.url, 'http://127.0.0.1:4399/v1/memories/m-1?revisionId=r-2');
  assert.equal(calls.at(-1)!.init.method, 'GET');

  await tools.find(tool => tool.name === 'mnemoweave_read_rules')!.execute({} as never, { signal: undefined });
  assert.equal(calls.at(-1)!.url, 'http://127.0.0.1:4399/v1/rules');
  assert.equal(calls.at(-1)!.init.method, 'GET');
});

test('a rule or archive change is refused with the reason a version is required', async () => {
  calls = [];
  const tools = createTools(CONFIG);
  // A model did not read the entry, so it cannot name the version its change is based on.
  for (const [name, args] of [
    ['mnemoweave_change_rule', { action: 'replace', entryId: 'rule-1', body: '新正文', reason: '用户要求' }],
    ['mnemoweave_write_workspace_archive', { action: 'create', title: '标题', body: '正文', evidence: 'x', reason: '用户要求' }],
  ] as const) {
    const tool = tools.find(item => item.name === name)!;
    await assert.rejects(
      async () => tool.execute(args as never, toolRun(1) as never),
      (error: unknown) => /_REQUIRES_USER/.test(String((error as Error).message)),
      name,
    );
  }
  assert.equal(calls.length, 0, 'a refused change never reaches the Server');
});

test('workspace archives search by query and read one segment by id', async () => {
  const previous = globalThis.fetch;
  const seen: Array<{ url: string; body: unknown }> = [];
  const entryId = '00000000-0000-4000-8000-000000000001';
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    seen.push({ url: target, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    if (target.includes('/v1/archives/search')) {
      return Response.json({
        query: 'notes', total: 1, truncated: false, totalChars: 12, totalLimitChars: 6_000, callsLimit: 4,
        results: [{ entryId, title: 'Design', verification: 'open', version: 1, state: 'active', excerpt: 'Project notes', excerptChars: 13, excerptTruncated: false }],
      });
    }
    return Response.json({ entryId, workspaceId: '11111111-1111-4111-8111-111111111111', version: 1, title: 'Design', content: 'Project notes', complete: true, totalChars: 13 });
  };
  try {
    const tool = createTools(CONFIG).find(item => item.name === 'mnemoweave_workspace_archives')!;
    const searched = await tool.execute({ query: 'notes' } as never, toolRun(2) as never);
    assert.match(seen[0]!.url, /\/v1\/archives\/search\?query=notes/);
    assert.equal((searched as { total: number }).total, 1);
    const read = await tool.execute({ entryId } as never, toolRun(2) as never);
    assert.equal((read as { entryId: string }).entryId, entryId);
    assert.equal((read as { content: string }).content, 'Project notes');
    assert.equal((read as { complete: boolean }).complete, true);
    // Query and segment are exclusive: asking for both is refused before any request.
    await assert.rejects(async () => tool.execute({ query: 'x', entryId } as never, toolRun(2) as never));
    assert.equal(seen.length, 2);
  } finally {
    globalThis.fetch = previous;
  }
});

test('remember submits a candidate with host-generated provenance, never a publication', async () => {
  calls = [];
  const remember = createTools(CONFIG).find(tool => tool.name === 'mnemoweave_remember')!;
  const result = await remember.execute({
    content: '提交前必须运行类型检查。', reason: '用户要求记录',
    evidenceRefs: ['tool:pnpm-typecheck'], assessment: 'supported',
  } as never, toolRun(3, 'session-1') as never);
  const call = calls.at(-1)!;
  assert.equal(call.url, 'http://127.0.0.1:4399/v1/remember');
  assert.equal(call.init.method, 'POST');
  const body = JSON.parse(String(call.init.body));
  assert.match(body.idempotencyKey, /^[A-Za-z0-9_-]{8,128}$/);
  assert.equal('scope' in body, false, 'a candidate has no workspace scope');
  assert.equal('projectId' in body, false);
  assert.equal(typeof body.provenance.source, 'string');
  assert.ok(body.provenance.sourceReference.length > 0);
  assert.equal(body.provenance.verificationStatus, 'unverified');
  assert.equal(body.provenance.lastVerified, null);
  assert.ok(body.provenance.evidence.length > 0);
  // The entry never carries a workspace: the formal collection is shared.
  assert.equal(body.provenance.applicability, 'shared collection');
  // The model never receives a publication: without a delegation capability the answer is a
  // candidate receipt, which the Host must report as pending rather than as published.
  assert.equal((result as { status?: string }).status, 'candidate');
  assert.ok((result as { candidate?: unknown }).candidate);
});

test('related expands one already-recalled memory within the turn budget', async () => {
  calls = [];
  const related = createTools(CONFIG).find(tool => tool.name === 'mnemoweave_related')!;
  await related.execute({ memoryId: 'm-1' } as never, toolRun(4) as never);
  assert.equal(calls.at(-1)!.url, 'http://127.0.0.1:4399/v1/memories/related');
  assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)), { memoryId: 'm-1' });
});

test('a turn marked not to be retained refuses every model-initiated write before it leaves', async () => {
  calls = [];
  const tools = createTools(CONFIG);
  // The Host records the marker on the turn it applies to; the tool reads it from the same log.
  const marked = (turn: number) => ({
    signal: undefined,
    session: { snapshotEvents: () => [{ type: 'turn/start', data: { turn } }, { type: 'turn/no-retention', data: { turn } }] },
    agent: { id: 'session-1', session: { snapshotEvents: () => [{ type: 'turn/start', data: { turn } }, { type: 'turn/no-retention', data: { turn } }] } },
    turn,
  });
  for (const [name, args] of [
    ['mnemoweave_remember', { content: '候选正文', reason: '测试', evidenceRefs: ['e-1'] }],
    ['mnemoweave_change_rule', { action: 'replace', entryId: 'rule-1', body: '新正文', reason: '测试' }],
    ['mnemoweave_write_workspace_archive', { action: 'create', title: '标题', body: '正文', evidence: 'x', reason: '测试' }],
  ] as const) {
    const tool = tools.find(item => item.name === name)!;
    await assert.rejects(
      async () => tool.execute(args as never, marked(4) as never),
      (error: unknown) => (error as { code?: string }).code === 'TURN_NO_RETENTION',
      name,
    );
  }
  assert.equal(calls.length, 0, 'a refused turn never reaches the Server');
  // The next turn is unaffected: marking is per turn, not per session.
  const remember = tools.find(item => item.name === 'mnemoweave_remember')!;
  const result = await remember.execute(
    { content: '候选正文', reason: '测试', evidenceRefs: ['e-1'] } as never,
    { signal: undefined, agent: { id: 'session-1', session: { snapshotEvents: () => [{ type: 'turn/start', data: { turn: 5 } }] } }, turn: 5 } as never,
  );
  assert.equal((result as { status?: string }).status, 'candidate');
});

test('the no-retention command reports the marker to the Server and refuses this turn\'s writes', async () => {
  calls = [];
  const commands: Array<{ name: string; handler: (invocation: unknown) => unknown }> = [];
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const ctx = {
    tools: { register: () => () => undefined },
    commands: { register(definition: { name: string; handler: (invocation: unknown) => unknown }) { commands.push(definition); return () => undefined; } },
    on(event: string, handler: (payload: unknown) => unknown) { handlers.set(event, handler); return () => undefined; },
  };
  apply(ctx as never, CONFIG);
  assert.deepEqual(commands.map(command => command.name), [NO_RETENTION_COMMAND]);
  const events: Array<{ type: string; data: { turn: number } }> = [{ type: 'turn/start', data: { turn: 4 } }];
  const sessionEvents = () => events;
  const agent = { id: 'session-marked', session: { snapshotEvents: sessionEvents }, ctx: { on: () => () => undefined } };
  handlers.get('agent/created')!({ agent });
  const result = commands[0]!.handler({ agent }) as { message: string };
  assert.match(result.message, /第 4 轮/);
  // The Server learns the marker through the documented host event.
  const deadline = Date.now() + 500;
  while (Date.now() < deadline && !calls.some(call => call.url.endsWith('/v1/events'))) {
    await new Promise(done => setTimeout(done, 5));
  }
  const reported = calls.find(call => call.url.endsWith('/v1/events'));
  assert.ok(reported, 'the marker is reported to the Server');
  const body = JSON.parse(String(reported!.init.body));
  assert.equal(body.payload.noRetention, true);
  assert.equal(body.turnId, '4');
  assert.equal(body.kind, 'message.user');
});

test('a missing service token fails before any request is sent', async () => {
  calls = [];
  const tools = createTools({ serverUrl: 'http://127.0.0.1:4399', hostId: 'dsh-test' });
  await assert.rejects(
    async () => tools[0]!.execute({ query: 'x' } as never, toolRun(1) as never),
    /token is not configured/,
  );
  assert.equal(calls.length, 0, 'no request leaves the process without a token');
});

test('later model steps in one turn reuse the accepted rule block, the next turn fetches again', async () => {
  calls = [];
  const { ctx, handlers } = hostContext();
  apply(ctx, CONFIG);
  const events: Array<{ type: string; data: { turn: number } }> = [{ type: 'turn/start', data: { turn: 7 } }];
  const agentHandlers = new Map<string, (...args: never[]) => unknown>();
  const agent = {
    id: 'session-fixed-rules',
    session: { snapshotEvents: () => events },
    ctx: { on: (event: string, handler: never) => { agentHandlers.set(event, handler); return () => undefined; } },
  };
  handlers.get('agent/created')!({ agent });
  const assemble = agentHandlers.get('system-prompt/assemble') as unknown as (assembly: unknown, context: unknown, next: () => Promise<unknown>) => Promise<unknown>;
  const first = await assemble({}, {}, async () => ({ sections: [] }));
  const second = await assemble({}, {}, async () => ({ sections: [] }));
  assert.equal(calls.filter(call => call.url.endsWith('/v1/inject')).length, 1, 'two steps in one turn share one read');
  assert.deepEqual(
    (first as { sections: Array<{ text: string }> }).sections.at(-1)?.text,
    (second as { sections: Array<{ text: string }> }).sections.at(-1)?.text,
  );
  // The section is appended after the host's own assembly, never replacing it.
  assert.deepEqual((await assemble({}, {}, async () => ({ sections: [{ text: 'host' }] })) as { sections: unknown[] }).sections.length, 2);
  events.push({ type: 'turn/end', data: { turn: 7 } }, { type: 'turn/start', data: { turn: 8 } });
  await assemble({}, {}, async () => ({ sections: [] }));
  assert.equal(calls.filter(call => call.url.endsWith('/v1/inject')).length, 2, 'a new turn reads again');
});

test('a turn whose rules cannot be read appends no section and still assembles the prompt', async () => {
  const previous = globalThis.fetch;
  // An unreachable Server must never block the host turn.
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  try {
    const { ctx, handlers } = hostContext();
    apply(ctx, CONFIG);
    const events: Array<{ type: string; data: { turn: number } }> = [{ type: 'turn/start', data: { turn: 1 } }];
    const agentHandlers = new Map<string, (...args: never[]) => unknown>();
    const agent = { id: 'session-offline', session: { snapshotEvents: () => events }, ctx: { on: (event: string, handler: never) => { agentHandlers.set(event, handler); return () => undefined; } } };
    handlers.get('agent/created')!({ agent });
    const assemble = agentHandlers.get('system-prompt/assemble') as unknown as (assembly: unknown, context: unknown, next: () => Promise<unknown>) => Promise<unknown>;
    const result = await assemble({}, {}, async () => ({ sections: [{ text: 'host' }] })) as { sections: unknown[] };
    assert.deepEqual(result.sections, [{ text: 'host' }], 'the host sections survive an unreachable Server');
  } finally {
    globalThis.fetch = previous;
  }
});

test('the end of a turn asks the Server to scan completed turns for idle review', async () => {
  calls = [];
  const { ctx, handlers } = hostContext();
  apply(ctx, CONFIG);
  const events: Array<{ type: string; data: { turn: number } }> = [{ type: 'turn/start', data: { turn: 3 } }];
  const agentHandlers = new Map<string, (...args: never[]) => unknown>();
  const agent = {
    id: 'session-idle',
    session: { snapshotEvents: () => events },
    ctx: { on: (event: string, handler: never) => { agentHandlers.set(event, handler); return () => undefined; } },
  };
  handlers.get('agent/created')!({ agent });
  const assemble = agentHandlers.get('system-prompt/assemble') as unknown as (assembly: unknown, context: unknown, next: () => Promise<unknown>) => Promise<unknown>;
  await assemble({}, {}, async () => ({ sections: [] }));
  (agentHandlers.get('agent/turn-stopping') as unknown as () => void)();
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && !calls.some(call => call.url.endsWith('/v1/idle-review/scan'))) {
    await new Promise(done => setTimeout(done, 10));
  }
  const scan = calls.find(call => call.url.endsWith('/v1/idle-review/scan'));
  assert.ok(scan, 'the turn end triggers one scan');
  const body = JSON.parse(String(scan!.init.body));
  assert.equal(body.sessionId, 'session-idle');
  assert.equal(body.completedThroughTurn, 3);
  assert.equal(body.maxSignals, 10);
});

test('the injected section is the rule block and nothing else', () => {
  assert.equal(
    render(INJECTION),
    '准则（用户确认，按此执行）：\n- 提交前必须运行类型检查。',
  );
  // A partial delivery is reported, not injected: the host must be able to tell the user.
  assert.equal(render({ ...INJECTION, complete: false, failure: 'output_limit' }), '');
});
