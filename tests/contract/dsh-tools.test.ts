import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply, createTools, inject } from '../../plugins/dsh-mnemo-weave/lib/index.js';

/**
 * The DSH plugin's model-facing tools and prompt handling.
 *
 * The Server is stubbed at `fetch`: these tests pin what the plugin sends (path, identity headers,
 * candidate provenance, the runtime read) and that the prompt section is assembled from a fresh
 * View every turn. They do not replace the Server's own contract tests.
 */

const root = mkdtempSync(join(tmpdir(), 'mnemoweave-dsh-tools-'));
const TOKEN = 't'.repeat(32);
const CONFIG = { serverUrl: 'http://127.0.0.1:4399', token: TOKEN, hostId: 'dsh-test' };
type FetchCall = { url: string; init: RequestInit };

let calls: FetchCall[] = [];
let released: string[] = [];

before(() => {
  process.env.MNEMOWEAVE_DSH_SETTINGS = join(root, 'settings.json');
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    calls.push({ url: target, init: init ?? {} });
    if (target.endsWith('/health/live')) {
      return new Response(JSON.stringify({ live: true, service: 'mnemoweave', protocol: 1 }), { status: 200 });
    }
    if (target.endsWith('/v1/inject')) {
      return new Response(JSON.stringify({ rules: [{ body: '提交前必须运行类型检查。' }], memories: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, memories: [{ id: 'm1', content: '命中正文' }] }), { status: 200 });
  }) as typeof fetch;
});

after(() => {
  delete process.env.MNEMOWEAVE_DSH_SETTINGS;
  rmSync(root, { recursive: true, force: true });
});

/** A Host context that records the tool registrations and event handlers. */
function hostContext() {
  const tools: Array<{ name: string; description: string; execute: (args: never, execution?: unknown) => Promise<unknown> }> = [];
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const ctx = {
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
  };
  return { ctx, tools, handlers };
}

test('the plugin declares the tools service and registers the memory tool family', () => {
  assert.deepEqual(inject, ['tools']);
  const { ctx, tools } = hostContext();
  apply(ctx, CONFIG);
  assert.deepEqual(tools.map(tool => tool.name), [
    'mnemoweave_recall', 'mnemoweave_read_memory', 'mnemoweave_runtime_memory', 'mnemoweave_project_archives', 'mnemoweave_remember',
  ]);
  for (const tool of tools) assert.ok(tool.description.length > 40, `${tool.name} explains itself`);
});

test('applying and disposing releases every registration', () => {
  const { ctx, tools } = hostContext();
  const dispose = apply(ctx, CONFIG);
  assert.equal(tools.length, 5);
  dispose();
  assert.equal(released.filter(name => name.startsWith('release:')).length, 5, 'each tool has a disposer');
});

test('recall and read_memory carry the host identity and stay reads', async () => {
  calls = [];
  const [recall, readMemory] = createTools(CONFIG);
  await recall!.execute({ query: 'TypeScript', limit: 5 }, { signal: undefined });
  const recallCall = calls.at(-1)!;
  assert.equal(recallCall.url, 'http://127.0.0.1:4399/v1/recall');
  assert.equal(recallCall.init.method, 'POST');
  assert.equal((recallCall.init.headers as Record<string, string>)['authorization'], `Bearer ${TOKEN}`);
  assert.equal((recallCall.init.headers as Record<string, string>)['x-mnemoweave-host'], 'dsh-test');
  assert.deepEqual(JSON.parse(String(recallCall.init.body)), { query: 'TypeScript', limit: 5 });

  await readMemory!.execute({ memoryId: 'm-1', revisionId: 'r-2' }, { signal: undefined });
  const readCall = calls.at(-1)!;
  assert.equal(readCall.url, 'http://127.0.0.1:4399/v1/memories/m-1?revisionId=r-2');
  assert.equal(readCall.init.method, 'GET');
});

test('the runtime-memory tool reads rules and refuses an unqualified project scope', async () => {
  calls = [];
  const [, , runtime] = createTools(CONFIG);
  await assert.rejects(async () => runtime!.execute({ scope: 'project' } as never, { signal: undefined }), /projectId/);
  await runtime!.execute({ scope: 'project', projectId: 'alpha' } as never, { signal: undefined });
  const call = calls.at(-1)!;
  assert.equal(call.url, 'http://127.0.0.1:4399/v1/rules?scope=project&projectId=alpha');
  assert.equal(call.init.method, 'GET');
});

test('project archive search returns metadata and reading returns one document', async () => {
  const previousFetch = globalThis.fetch;
  const archive = { entryId: '00000000-0000-4000-8000-000000000001', title: 'Design', body: 'Project notes', verification: 'open', version: 1 };
  globalThis.fetch = async url => {
    assert.equal(String(url), 'http://127.0.0.1:4399/v1/archives?projectId=alpha');
    return Response.json({ items: [archive] });
  };
  try {
    const tool = createTools({ ...CONFIG, projectId: 'alpha' }).find(item => item.name === 'mnemoweave_project_archives')!;
    const { body, ...metadata } = archive;
    assert.deepEqual(await tool.execute({ query: 'notes' } as never), { items: [metadata] });
    assert.deepEqual(await tool.execute({ entryId: archive.entryId } as never), archive);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('remember submits a candidate with host-generated provenance, never a publication', async () => {
  calls = [];
  const [, , , , remember] = createTools(CONFIG);
  await remember!.execute({ content: '提交前必须运行类型检查。', knowledgeType: 'Practice', tags: ['verification'] } as never, {
    signal: undefined,
    agent: { id: 'agent-1' },
  });
  const call = calls.at(-1)!;
  assert.equal(call.url, 'http://127.0.0.1:4399/v1/remember');
  assert.equal(call.init.method, 'POST');
  const body = JSON.parse(String(call.init.body));
  assert.match(body.idempotencyKey, /^[A-Za-z0-9_-]{8,128}$/);
  assert.equal(body.scope, 'global');
  assert.equal(body.provenance.source, 'agent');
  assert.equal(body.provenance.sourceReference, 'dsh-mnemo-weave:agent-1');
  assert.equal(body.provenance.verificationStatus, 'unverified');
  assert.equal(body.provenance.lastVerified, null);
  assert.ok(body.provenance.limitations.includes('review'));
});

test('a missing service token fails before any request is sent', async () => {
  calls = [];
  const tools = createTools({ serverUrl: 'http://127.0.0.1:4399', hostId: 'dsh-test' });
  await assert.rejects(async () => tools[0]!.execute({ query: 'x' } as never, { signal: undefined }), /token is not configured/);
  assert.equal(calls.length, 0, 'no request leaves the process without a token');
});

test('the prompt section is re-assembled from a fresh View on every turn', async () => {
  calls = [];
  const { ctx, handlers } = hostContext();
  apply(ctx, CONFIG);
  const created = handlers.get('agent/created')!;
  const agentHandlers = new Map<string, (assembly: unknown, context: unknown, next: () => Promise<unknown>) => Promise<unknown>>();
  created({ agent: { id: 'session-1', ctx: { on: (event: string, handler: never) => { agentHandlers.set(event, handler); return () => undefined; } } } });
  const assemble = agentHandlers.get('system-prompt/assemble')!;
  for (let index = 0; index < 2; index += 1) {
    const assembled = await assemble({}, {}, async () => ({ sections: [] }));
    const section = (assembled as { sections: Array<{ name: string; text: string }> }).sections.at(-1)!;
    assert.equal(section.name, 'mnemo-weave:view');
    assert.match(section.text, /提交前必须运行类型检查。/, 'the runtime rule reaches the prompt');
  }
  const injections = calls.filter(call => call.url.endsWith('/v1/inject'));
  assert.equal(injections.length, 2, 'each assembly fetches a fresh View; a rule edited mid-session is injected next turn');
});
