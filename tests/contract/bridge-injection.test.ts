import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { InjectionSessions, renderView } from '../../packages/bridge/src/injection.ts';
import { createInjectionServer } from '../../apps/bridge/src/view-server.ts';
import { MnemoWeaveError, View } from '../../packages/core/contracts/src/index.ts';
import type { ViewRecord } from '../../packages/core/contracts/src/index.ts';

const makeView = (generation: number, content = 'bridged memory content'): ViewRecord => View.parse({
  viewId: randomUUID(), generation, createdAt: new Date().toISOString(), grantId: randomUUID(),
  query: 'probe', scopeNote: { projects: ['proj-1'], globalIncluded: true },
  budget: { limitTokens: 4096, usedTokens: 12, estimator: 'utf8-bytes-3', estimated: true, envelopeReserveTokens: 96 },
  memories: [{
    memoryId: randomUUID(), revisionId: randomUUID(), providerMemoryId: 'provider-1', tier: 'dynamic',
    scope: 'project', applicability: 'bridge fixture', content, excerpt: false, sourceReference: 'test:bridge',
  }],
  excluded: [], complete: true, rerank: { status: 'not_requested', reason: 'Deterministic ordering' },
});

test('Session start injects the assembled view and later triggers deliver a new generation', async () => {
  let assembled = 0;
  const sessions = new InjectionSessions({
    assemble: async input => { assembled++; return makeView(assembled, input.query ?? 'session start view'); },
    isRevoked: async () => false,
    deadlineMs: 500,
  });
  const first = await sessions.handle({ sessionId: 'session-1', turnId: 'turn-1', trigger: 'session_started' });
  assert.equal(first.status, 'injected');
  assert.match(first.text ?? '', /session start view/);
  assert.equal(assembled, 1);
  const second = await sessions.handle({ sessionId: 'session-1', turnId: 'turn-2', trigger: 'message_user', query: 'next topic' });
  assert.equal(second.status, 'injected');
  assert.notEqual(second.viewId, first.viewId);
  assert.equal(second.viewGeneration, 2);
  assert.equal(assembled, 2);
  sessions.close('session-1');
  assert.equal(sessions.sessionCount, 0);
});

test('Revocation denies injection before any assembly attempt', async () => {
  let assembled = 0;
  const sessions = new InjectionSessions({
    assemble: async () => { assembled++; return makeView(1); },
    isRevoked: async () => true,
  });
  const outcome = await sessions.handle({ sessionId: 'session-2', turnId: 'turn-1', trigger: 'session_started' });
  assert.equal(outcome.status, 'denied');
  assert.equal(outcome.reason, 'revoked');
  assert.equal(assembled, 0);
});

test('Slow assembly reports explicit unavailability within the deadline and offers the late view later', async () => {
  let assembled = 0;
  const sessions = new InjectionSessions({
    assemble: async () => {
      assembled++;
      await new Promise(resolve => setTimeout(resolve, 120));
      return makeView(assembled, 'late view content');
    },
    isRevoked: async () => false,
    deadlineMs: 30,
  });
  const started = Date.now();
  const miss = await sessions.handle({ sessionId: 'session-3', turnId: 'turn-1', trigger: 'message_user', query: 'slow topic' });
  const elapsed = Date.now() - started;
  assert.equal(miss.status, 'unavailable');
  assert.match(miss.reason, /deadline/);
  assert.ok(elapsed < 300, `foreground returned in ${elapsed}ms`);
  await new Promise(resolve => setTimeout(resolve, 200));
  const late = await sessions.handle({ sessionId: 'session-3', turnId: 'turn-2', trigger: 'session_started' });
  assert.equal(late.status, 'injected');
  assert.match(late.reason, /late result/);
  assert.match(late.text ?? '', /late view content/);
});

test('Budget overflow is reported as budget_exceeded, not as a truncated view', async () => {
  const sessions = new InjectionSessions({
    assemble: async () => { throw new MnemoWeaveError('VIEW_BUDGET_EXCEEDED'); },
    isRevoked: async () => false,
  });
  const outcome = await sessions.handle({ sessionId: 'session-4', turnId: 'turn-1', trigger: 'session_started' });
  assert.equal(outcome.status, 'budget_exceeded');
});

test('Bridge injection endpoint enforces its token, validates the trigger and returns the outcome', async () => {
  const sessions = new InjectionSessions({
    assemble: async () => makeView(1, 'endpoint view content'),
    isRevoked: async () => false,
  });
  const token = 'local-bridge-injection-token-0123456789';
  const server = createInjectionServer({ token, sessions });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const live = await fetch(`${base}/health/live`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(live.status, 200);

    const unauthenticated = await fetch(`${base}/v1/inject`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's', turnId: 't', trigger: 'session_started' }),
    });
    assert.equal(unauthenticated.status, 401);

    const invalid = await fetch(`${base}/v1/inject`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's', turnId: 't', trigger: 'not-a-trigger' }),
    });
    assert.equal(invalid.status, 400);

    const delivered = await fetch(`${base}/v1/inject`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's', turnId: 't', trigger: 'session_started', pinned: [{ memoryId: randomUUID(), tier: 'critical' }] }),
    });
    assert.equal(delivered.status, 200);
    const body = await delivered.json() as { status: string; text: string };
    assert.equal(body.status, 'injected');
    assert.match(body.text, /endpoint view content/);
  } finally {
    await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
  }
});

test('View rendering lists delivered memories with their tier and excerpt marker', () => {
  const view = makeView(1, 'rendered content');
  view.memories[0]!.excerpt = true;
  const text = renderView(view);
  assert.ok(text.includes('[dynamic;'));
  assert.ok(text.includes(view.memories[0]!.revisionId));
  assert.match(text, /rendered content \(excerpt\)$/);
});
