import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer, httpRoutes, statusForCode } from '../../packages/protocols/http/src/index.ts';
import type { ClientHttpEndpoints } from '../../packages/protocols/http/src/index.ts';
import { openapi } from '../../packages/core/contracts/src/index.ts';
import type { ErrorCode, ViewRecord } from '../../packages/core/contracts/src/index.ts';
import type { MemoryApplication } from '../../packages/core/application/src/index.ts';

test('OpenAPI document mirrors the served route list exactly', () => {
  const documented = Object.entries(openapi.paths)
    .flatMap(([path, methods]) => Object.keys(methods).map(method => `${method.toUpperCase()} ${path}`))
    .sort();
  const served = httpRoutes.map(route => `${route.method} ${route.path}`).sort();
  assert.deepEqual(served, documented);
});

test('Error codes map to the documented HTTP statuses', () => {
  const expected: Readonly<Record<ErrorCode, number>> = {
    INVALID_INPUT: 400,
    UNAUTHORIZED: 401,
    NOT_FOUND: 404,
    REVIEW_REQUIRED: 409,
    IDEMPOTENCY_CONFLICT: 409,
    INVALID_STATE: 409,
    VIEW_BUDGET_EXCEEDED: 409,
    QUOTA_EXCEEDED: 409,
    PROVIDER_UNAVAILABLE: 503,
    PROVIDER_TIMEOUT: 503,
    PROVIDER_PROTOCOL: 503,
    PROVIDER_INTEGRITY: 503,
    UNSUPPORTED_VERSION: 503,
    INTERNAL: 503,
    VERSION_CONFLICT: 409,
    CHANGE_ID_REUSED: 409,
    CHANGE_ID_EXPIRED: 409,
    SNAPSHOT_REQUIRED: 409,
    SYNC_QUEUED: 409,
    SYNC_OUTCOME_UNKNOWN: 409,
    RULE_BUDGET_EXCEEDED: 409,
    NEEDS_REVIEW: 409,
    DEVICE_REVOKED: 401,
    SCOPE_FORBIDDEN: 403,
    SYNC_UNAVAILABLE: 503,
  };
  for (const [code, status] of Object.entries(expected)) assert.equal(statusForCode(code as ErrorCode), status, code);
});

test('Every documented route is actually handled by the HTTP server', async () => {
  const uuid = '123e4567-e89b-42d3-a456-426614174000';
  const candidate = { id: uuid, status: 'pending_review' };
  const stub = {
    health: async () => ({ ready: true as const, version: '0.2.13' as const, capabilities: ['health'] }),
    recall: async () => ({ memories: [] }),
    remember: async () => candidate,
    candidateStatus: async () => candidate,
    readMemory: async () => ({ content: 'stub' }),
    readConflict: async () => ({ id: uuid }),
    resolveConflict: async () => candidate,
    cancelVersion: async () => candidate,
    reviewDue: async () => ({ items: [] }),
    completeReview: async () => ({ memoryId: uuid }),
    humanReview: async () => candidate,
    retryWrite: async () => candidate,
  } as unknown as MemoryApplication;
  const token = 'local-contract-token-0123456789';
  const operatorToken = 'local-operator-contract-0123456789';
  const client: ClientHttpEndpoints = {
    view: async () => ({ viewId: uuid } as unknown as ViewRecord),
    context: () => ({ sessionId: 'probe', task: null, revision: 0, closed: false, entries: [], pins: [], capture: 'idle' }),
    pin: () => undefined,
    register: () => undefined,
    closeSession: () => undefined,
    events: () => ({ status: 'stored', eventId: 'probe-event-1' }),
    memories: async () => ({ items: [] }),
    editMemory: async () => ({ memoryId: uuid, revisionId: uuid, providerMemoryId: 'probe-provider-id', contentHash: 'a'.repeat(64), entryVersion: 1 }),
    syncStatus: async () => ({ enabled: true, scopes: [], updatedAt: new Date().toISOString() }),
    syncRefresh: async () => ({ scopes: [], pulled: 0, applied: 0, errors: [], skipped: false }),
    lastInjection: async () => ({ id: uuid, hostId: 'host-probe', sessionId: 'probe', rulesInjected: 0, rulesOmitted: null, memoriesInjected: 0, usedTokens: 96, createdAt: new Date().toISOString() }),
    rules: async () => ({ items: [] }),
    createRule: async () => ({ entryId: uuid, scope: 'global', projectId: null, body: 'probe rule', enabled: true, version: 1, withdrawnAt: null }),
    editRule: async () => ({ entryId: uuid, scope: 'global', projectId: null, body: 'probe rule v2', enabled: false, version: 2, withdrawnAt: null }),
    createArchive: async () => ({ entryId: uuid, projectId: 'probe', title: 'probe', body: 'probe body', source: 'session', verification: 'open', evidence: 'probe evidence', version: 1, withdrawnAt: null }),
    archives: async () => ({ items: [] }),
  };
  const server = createHttpServer(stub, token, operatorToken, client, () => ({ usedBytes: 0, state: 'ok' }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const operatorPaths = new Set(['/v1/runtime/pins', '/v1/runtime/projects', '/v1/review', '/v1/retry', '/v1/conflicts/resolve', '/v1/versions/cancel', '/v1/reviews/due', '/v1/reviews/complete', '/v1/sync/status', '/v1/sync/refresh', '/v1/injections/latest', '/v1/rules', '/v1/rules/{ruleId}', '/v1/archives']);
    const hostPaths = new Set(['/v1/inject', '/v1/view', '/v1/events', '/v1/session/close', '/v1/runtime/context']);
    const bodies: Record<string, string> = {
      '/v1/runtime/context': JSON.stringify({ sessionId: 'probe' }),
      '/v1/runtime/pins': JSON.stringify({ memoryId: uuid, tier: 'critical', scope: 'global' }),
      '/v1/runtime/projects': JSON.stringify({ projectId: 'probe' }),
      '/v1/reviews/complete': JSON.stringify({ memoryId: uuid, reason: 'probe review' }),
      '/v1/view': JSON.stringify({ query: 'probe' }),
      '/v1/inject': JSON.stringify({ query: 'probe' }),
      '/v1/events': JSON.stringify({ protocolVersion: '1', adapterVersion: 'probe', eventId: 'probe-event-1', sessionId: 'probe', kind: 'session.started', occurredAt: new Date().toISOString(), receivedAt: new Date().toISOString(), sourceRef: 'probe', payload: {} }),
      '/v1/session/close': JSON.stringify({ sessionId: 'probe' }),
      '/v1/memories/{memoryId}': JSON.stringify({ content: 'edited content' }),
      '/v1/rules': JSON.stringify({ scope: 'global', body: 'probe rule' }),
      '/v1/rules/{ruleId}': JSON.stringify({ enabled: false }),
      '/v1/archives': JSON.stringify({ projectId: 'probe', title: 'probe', body: 'probe body', source: 'session', verification: 'open', evidence: 'probe evidence' }),
    };
    for (const route of httpRoutes) {
      const path = route.path.replace(/\{[a-zA-Z]+\}/g, () => uuid);
      const headers: Record<string, string> = { authorization: `Bearer ${operatorPaths.has(route.path) ? operatorToken : token}` };
      if (hostPaths.has(route.path)) headers['x-mnemoweave-host'] = 'host-probe';
      const response = await fetch(`${base}${path}`, route.method === 'GET'
        ? { headers }
        : { method: route.method, headers: { ...headers, 'content-type': 'application/json' }, body: bodies[route.path] ?? '{}' });
      assert.notEqual(response.status, 404, `${route.method} ${route.path} fell through to the unknown-route branch`);
      const bodyText = await response.text();
      assert.notEqual(bodyText.includes('NOT_FOUND'), true, `${route.method} ${route.path} fell through to the unknown-route branch`);
    }
    // Unknown paths and wrong methods must still fall through to NOT_FOUND.
    const unknown = await fetch(`${base}/v1/unknown`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(unknown.status, 404);
    const wrongMethod = await fetch(`${base}/v1/recall`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(wrongMethod.status, 404);
    // Sync diagnostics: the operator sees them, and so does a Host that names itself.
    const anonymousStatus = await fetch(`${base}/v1/sync/status`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(anonymousStatus.status, 401, 'a host token without a host header must not read sync state');
    const hostStatus = await fetch(`${base}/v1/sync/status`, { headers: { authorization: `Bearer ${token}`, 'x-mnemoweave-host': 'host-probe' } });
    assert.equal(hostStatus.status, 200);
    const operatorStatus = await fetch(`${base}/v1/sync/status`, { headers: { authorization: `Bearer ${operatorToken}` } });
    assert.equal(operatorStatus.status, 200);
    assert.equal((await operatorStatus.json() as { enabled: boolean }).enabled, true);
    const hostRefresh = await fetch(`${base}/v1/sync/refresh`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-mnemoweave-host': 'host-probe', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(hostRefresh.status, 200);
    const refresh = await fetch(`${base}/v1/sync/refresh`, { method: 'POST', headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(refresh.status, 200);
    assert.equal((await refresh.json() as { skipped: boolean }).skipped, false);
    // Rules and archives: readable by a named Host across every project, writable only by the operator.
    const hostRules = await fetch(`${base}/v1/rules`, { headers: { authorization: `Bearer ${token}`, 'x-mnemoweave-host': 'host-probe' } });
    assert.equal(hostRules.status, 200);
    const anonymousRules = await fetch(`${base}/v1/rules`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(anonymousRules.status, 401);
    const hostRuleWrite = await fetch(`${base}/v1/rules`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-mnemoweave-host': 'host-probe', 'content-type': 'application/json' }, body: bodies['/v1/rules']! });
    assert.equal(hostRuleWrite.status, 401, 'writing a rule stays operator-only');
    const hostArchives = await fetch(`${base}/v1/archives`, { headers: { authorization: `Bearer ${token}`, 'x-mnemoweave-host': 'host-probe' } });
    assert.equal(hostArchives.status, 200);
    assert.deepEqual((await hostArchives.json() as { items: unknown[] }).items, []);
    const anonymousArchives = await fetch(`${base}/v1/archives`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(anonymousArchives.status, 401);
    const hostArchiveWrite = await fetch(`${base}/v1/archives`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-mnemoweave-host': 'host-probe', 'content-type': 'application/json' }, body: bodies['/v1/archives']! });
    assert.equal(hostArchiveWrite.status, 401, 'writing an archive stays operator-only');
    const allRules = await fetch(`${base}/v1/rules?scope=all`, { headers: { authorization: `Bearer ${operatorToken}` } });
    assert.equal(allRules.status, 200);
    const operatorArchives = await fetch(`${base}/v1/archives`, { headers: { authorization: `Bearer ${operatorToken}` } });
    assert.equal(operatorArchives.status, 200);
    // Injection visibility: the operator reads the newest report, a host only its own.
    const operatorInjection = await fetch(`${base}/v1/injections/latest`, { headers: { authorization: `Bearer ${operatorToken}` } });
    assert.equal(operatorInjection.status, 200);
    const hostInjection = await fetch(`${base}/v1/injections/latest`, { headers: { authorization: `Bearer ${token}`, 'x-mnemoweave-host': 'host-probe' } });
    assert.equal(hostInjection.status, 200);
    const anonymousInjection = await fetch(`${base}/v1/injections/latest`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(anonymousInjection.status, 401, 'a host token without a host header must not read the report');
  } finally {
    await new Promise<void>((done, fail) => { server.closeAllConnections(); server.close(error => error ? fail(error) : done()); });
  }
});
