import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { SyncSource } from '../../packages/infrastructure/governance/src/sync-source.ts';
import { MemoryApplication } from '../../packages/core/application/src/index.ts';
import { MemoryRuntime } from '../../packages/core/application/src/runtime.ts';
import { ViewAssembler, estimateTokens } from '../../packages/core/application/src/view.ts';
import { renderView, InjectionSessions } from '../../packages/bridge/src/injection.ts';
import { HostEvent, MnemoWeaveError, RememberInput } from '../../packages/core/contracts/src/index.ts';
import { SourceRegistry } from '../../packages/core/application/src/composition.ts';

async function fixture() {
  await mkdir('work/tests', { recursive: true });
  const root = await mkdtemp(resolve('work/tests/runtime-'));
  const path = join(root, 'governance.db');
  const repo = new SqliteCandidates(path);
  const contents = new Map<string, string>();
  const queries: string[] = [];
  const provider = {
    health: async () => ({ ready: true as const, version: '0.2.13' as const, capabilities: ['health' as const] }),
    recall: async (input: { query: string }) => { queries.push(input.query); return { memories: [...contents].map(([id, content]) => ({ id, content, score: 1 })) }; },
    readMemory: async (id: string) => ({ id, content: contents.get(id)! }),
  };
  const app = new MemoryApplication(provider, repo, repo);
  const source = new SyncSource(repo, async id => contents.get(id)!);
  const grant = source.issueGrant('host-a', ['project-a'], false);
  source.issueGrant('host-b', ['project-b'], true);
  const publish = (content: string, projectId = 'project-a', scope: 'project' | 'global' = 'project') => {
    const request = RememberInput.parse({ idempotencyKey: randomUUID(), content, scope, ...(scope === 'project' ? { projectId } : {}), knowledgeType: 'Constraint', provenance: { source: 'runtime-test', sourceReference: 'fixture', evidence: ['fixture'], verificationStatus: 'verified', confidence: 1, applicability: 'fixture', limitations: 'isolated test', lastVerified: null } });
    const candidate = repo.submit(request);
    repo.review(candidate.id, 'approve', 'operator', 'fixture', null);
    const id = randomUUID(); contents.set(id, content);
    repo.acquire('publisher', 90000); repo.finish(repo.claim('publisher')!, { id, action: 'added' }, false); repo.release('publisher');
    return repo.get(candidate.id).publication!;
  };
  const event = (kind: 'session.started' | 'session.ended' | 'message.user' | 'message.assistant.final' | 'tool.completed', text = '', sessionId = 'session-a') => HostEvent.parse({ protocolVersion: '1', adapterVersion: 'test', eventId: randomUUID(), sessionId, projectId: 'project-a', kind, occurredAt: new Date().toISOString(), receivedAt: new Date().toISOString(), sourceRef: 'fixture', payload: kind.startsWith('session.') ? {} : { text } });
  const send = (input: ReturnType<typeof HostEvent.parse>) => source.submitIntent('host-a', { intentId: input.eventId, kind: 'event', payload: input });
  const runtime = new MemoryRuntime(repo.runtime, new ViewAssembler(app, { revocations: source }));
  return { root, path, repo, app, source, grant, publish, event, send, runtime, queries };
}

test('A new session receives resident memory without a search query; continue retains its task', async () => {
  const f = await fixture();
  try {
    const pinned = f.publish('Always use the isolated project store.');
    f.repo.runtime.pin({ memoryId: pinned.memoryId, scope: 'project', projectId: 'project-a', tier: 'critical', remove: false });
    const view = await f.runtime.view(f.grant, { sessionId: 'session-a', projectId: 'project-a' });
    assert.equal(view.memories[0]!.content, 'Always use the isolated project store.');
    assert.equal(view.memories[0]!.tier, 'pinned-critical');
    assert.match(view.guidance!, /candidate/);
    f.send(f.event('message.user', 'Implement the isolated revision migration'));
    f.send(f.event('message.user', '继续'));
    const next = await f.runtime.view(f.grant, { sessionId: 'session-a', query: '继续' });
    assert.match(f.queries.at(-1)!, /isolated revision migration/);
    assert.match(next.runtime!.task!, /migration/);
    assert.ok(estimateTokens(renderView(next)) <= next.budget.limitTokens);
    assert.ok(Object.isFrozen(next.workingContext![0]));
  } finally { f.repo.close(); }
});

test('Runtime pins survive restart and Host/Session pins never leak to another session', async () => {
  const f = await fixture();
  const pinned = f.publish('Session private resident constraint');
  f.repo.runtime.pin({ memoryId: pinned.memoryId, scope: 'session', hostId: 'host-a', sessionId: 'session-a', tier: 'critical', remove: false });
  f.repo.close();
  const reopened = new SqliteCandidates(f.path);
  try {
    assert.equal(reopened.runtime.context('host-a', 'session-a').pins.length, 1);
    assert.equal(reopened.runtime.context('host-a', 'other').pins.length, 0);
    assert.equal(reopened.runtime.context('host-b', 'session-a').pins.length, 0);
  } finally { reopened.close(); }
});

test('Permission filtering precedes model rerank and applies to direct and pinned reads', async () => {
  const f = await fixture();
  try {
    const allowed = f.publish('Allowed project content');
    const denied = f.publish('Private project B secret', 'project-b');
    const global = f.publish('Global secret', '', 'global');
    const inputs: string[] = [];
    const assembler = new ViewAssembler(f.app, { reranker: { rerank: async (_component, _query, memories, generation) => { inputs.push(...memories.map(memory => memory.content)); return { generation, order: memories.map(memory => memory.id) }; } } });
    const view = await assembler.assemble({ grant: f.grant, query: 'project', rerank: true, pinned: [{ memoryId: denied.memoryId, tier: 'critical' }] });
    assert.ok(view.memories.every(memory => memory.memoryId === allowed.memoryId));
    assert.equal(inputs.some(text => text.includes('secret')), false);
    const recall = await f.app.recall({ query: 'project' }, f.grant);
    assert.equal(recall.memories.length, 1);
    await assert.rejects(f.app.readMemory(denied, f.grant), /UNAUTHORIZED/);
    await assert.rejects(f.app.readMemory(global, f.grant), /UNAUTHORIZED/);
  } finally { f.repo.close(); }
});

test('Capture extracts only user evidence, persists a reviewed candidate boundary and protects evidence', async () => {
  const f = await fixture();
  try {
    const user = f.event('message.user', 'Our project requires all migrations to run in an isolated store.');
    f.send(user);
    f.send(f.event('message.assistant.final', 'Assistant-invented assertion must not become user evidence.'));
    await f.repo.runtime.tick({ capture: async (_component, entries) => {
      assert.deepEqual(entries.map(entry => entry.eventId), [user.eventId]);
      return { candidates: [{ content: 'Project migrations require an isolated store.', eventIds: [user.eventId] }] };
    } });
    const inspect = new DatabaseSync(f.path);
    try {
      const row = inspect.prepare('SELECT id,status FROM governance_candidates').get()!;
      assert.equal(row['status'], 'pending_review');
      assert.equal(inspect.prepare('SELECT count(*) n FROM catalog_memories').get()!['n'], 0);
      assert.equal(inspect.prepare('SELECT count(*) n FROM runtime_capture_runs').get()!['n'], 1);
      assert.equal(inspect.prepare('SELECT count(*) n FROM runtime_capture_receipts').get()!['n'], 1);
      assert.equal(inspect.prepare('SELECT count(*) n FROM session_event_refs').get()!['n'], 1);
      assert.equal(f.repo.events.get('host-a', user.eventId).payload.text, user.payload.text);
    } finally { inspect.close(); }
  } finally { f.repo.close(); }
});

test('Missing models, opt-out, invalid citations and revocation cannot silently publish knowledge', async () => {
  const f = await fixture();
  try {
    f.send(f.event('message.user', 'Project uses strict TypeScript.'));
    f.send(f.event('message.assistant.final'));
    await f.repo.runtime.tick(undefined);
    assert.equal(f.repo.runtime.context('host-a', 'session-a').capture, 'awaiting_model');
    f.send(f.event('message.user', '不要记住这些内容'));
    let calls = 0;
    await f.repo.runtime.tick({ capture: async () => { calls++; return { candidates: [] }; } });
    assert.equal(calls, 0);
    assert.equal(f.repo.runtime.context('host-a', 'session-a').entries.length, 0);
    f.send(f.event('message.user', 'Project uses a native deployment.', 'session-b'));
    f.send(f.event('message.assistant.final', '', 'session-b'));
    await f.repo.runtime.tick({ capture: async () => ({ candidates: [{ content: 'Invented', eventIds: ['foreign-event'] }] }) });
    const db = new DatabaseSync(f.path);
    try { assert.equal(db.prepare('SELECT count(*) n FROM governance_candidates').get()!['n'], 0); } finally { db.close(); }
    f.send(f.event('message.user', 'Use isolation for tests.', 'session-c'));
    f.send(f.event('message.assistant.final', '', 'session-c'));
    f.source.revokeHost('host-a');
    await f.repo.runtime.tick({ capture: async () => { calls++; return { candidates: [] }; } });
    assert.equal(calls, 0);
  } finally { f.repo.close(); }
});

test('Session end rejects new runtime views and pending injection cannot revive a closed session', async () => {
  const f = await fixture();
  try {
    f.send(f.event('session.started'));
    f.send(f.event('session.ended'));
    await assert.rejects(f.runtime.view(f.grant, { sessionId: 'session-a' }), /INVALID_STATE/);
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const sessions = new InjectionSessions({ assemble: async () => { await waiting; return f.runtime.view(f.grant, { sessionId: 'other' }); }, isRevoked: async () => false });
    const pending = sessions.handle({ sessionId: 'other', turnId: 'turn-a', trigger: 'session_started' });
    sessions.close('other'); release();
    assert.notEqual((await pending).status, 'injected');
    assert.equal(sessions.sessionCount, 0);
  } finally { f.repo.close(); }
});

test('Composition rejects unavailable capabilities before executing a Source', async () => {
  const registry = new SourceRegistry();
  let calls = 0;
  registry.register({ id: 'runtime', capabilities: ['project'], read: async () => { calls++; return {}; } });
  assert.throws(() => registry.compile({ plan: () => ({ steps: [{ sourceId: 'runtime', capability: 'write' }] }) }), /REVIEW_REQUIRED/);
  assert.equal(calls, 0);
});

test('Scoped snapshots and change streams contain only granted project history', async () => {
  const f = await fixture();
  try {
    const allowed = f.publish('Project A scoped memory');
    f.publish('Hidden project B memory', 'project-b');
    f.publish('Hidden Global memory', '', 'global');
    const changes = await f.source.changes(0, undefined, f.grant);
    const serialized = JSON.stringify(changes);
    assert.equal(serialized.includes('Hidden'), false);
    assert.ok(changes.changes.some(change => change.op === 'scope_skip'));
    const snapshotPath = join(f.root, 'scoped.db');
    await f.source.snapshot(snapshotPath, undefined, f.grant);
    const db = new DatabaseSync(snapshotPath, { readOnly: true });
    try {
      assert.deepEqual(db.prepare('SELECT id FROM replica_memories').all().map(row => row['id']), [allowed.memoryId]);
      assert.equal(db.prepare('SELECT count(*) n FROM replica_revisions').get()!['n'], 1);
      assert.equal(db.prepare('SELECT project_id FROM replica_memories').get()!['project_id'], 'project-a');
    } finally { db.close(); }
  } finally { f.repo.close(); }
});
