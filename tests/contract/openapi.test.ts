import { MnemoWeaveError } from '../../packages/core/contracts/src/index.ts';
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
    RULE_ITEM_TOO_LARGE: 409,
    RULE_CAPACITY_EXCEEDED: 409,
    RULE_ARCHIVE_UNAVAILABLE: 409,
    ARCHIVE_BODY_TOO_LARGE: 409,
    ARCHIVE_CAPACITY_EXCEEDED: 409,
    ARCHIVE_NOT_ACTIVE: 409,
    ARCHIVE_SEARCH_BUDGET_EXCEEDED: 409,
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
    rules: async () => ({ items: [], usage: { limitBytes: 14336, itemMaxBytes: 8192, targetBytes: 10035, usedBytes: 0, entryCount: 0, exceeded: false, overByBytes: 0 } }),
    ruleArchive: async () => ({ items: [] }),
    createRule: async () => ({ entryId: uuid, body: 'probe rule', enabled: true, version: 1, withdrawnAt: null, importance: 'normal', pinned: false, bodyBytes: 10 }),
    editRule: async () => ({ entryId: uuid, body: 'probe rule v2', enabled: false, version: 2, withdrawnAt: null, importance: 'normal', pinned: false, bodyBytes: 13 }),
    createArchive: async () => ({ entryId: uuid, projectId: 'probe', title: 'probe', body: 'probe body', source: 'session', verification: 'open', evidence: 'probe evidence', version: 1, withdrawnAt: null, state: 'active', archivedAt: null, bodyBytes: 10 }),
    editArchive: async (entryId, input) => {
      if (input.baseVersion !== 1) throw new MnemoWeaveError('VERSION_CONFLICT');
      return { entryId, projectId: 'probe', title: input.title, body: input.body, source: 'user', verification: input.verification, evidence: input.evidence, version: 2, withdrawnAt: null, state: 'active', archivedAt: null, bodyBytes: 12 };
    },
    editArchiveState: async entryId => ({ entryId, projectId: 'probe', title: 'probe', body: 'probe body', source: 'user', verification: 'open', evidence: 'probe evidence', version: 2, withdrawnAt: null, state: 'archived', archivedAt: new Date().toISOString(), bodyBytes: 10 }),
    archiveHistory: async entryId => ({ entryId, items: [] }),
    searchArchives: async (_hostId, input) => ({ query: input.query, total: 0, results: [], totalBytes: 0, truncated: false, excerptLimitBytes: 512, totalLimitBytes: 4096, callsLimit: 4 }),
    archives: async () => ({ items: [], capacities: [] }),
    projects: async () => ({ projects: [] }),
    embeddingDiagnostics: async () => ({ provider: 'mnemon', model: 'nomic-embed-text', protocol: 'ollama', serviceAvailable: false, modelAvailable: false, embedded: 0, total: 0, coverage: 0, recallMode: 'unknown', degraded: true, lastError: 'embedding service unreachable', checkedAt: new Date().toISOString() }),
    embeddingBackfill: async () => ({ id: uuid, kind: 'embedding-backfill', state: 'running', startedAt: new Date().toISOString(), finishedAt: null }),
    idleReviewScan: async () => ({ signals: [], lastTurn: 0, skipped: { tooShort: 0, question: 0, noTurn: 0, outOfWindow: 0, duplicate: 0 } }),
    idleReviewSignals: async () => ({ items: [] }),
    idleReviewRunStart: async () => ({ run: { id: uuid, sessionId: 's', state: 'running', attempt: 1, startedAt: new Date().toISOString(), finishedAt: null, error: null, items: [] }, signals: [] }),
    idleReviewRuns: async () => ({ items: [] }),
    idleReviewPending: async () => ({ sessions: [] }),
    idleReviewRunItem: async () => ({ id: uuid, sessionId: 's', state: 'running', attempt: 1, startedAt: new Date().toISOString(), finishedAt: null, error: null, items: [] }),
    idleReviewRunFinish: async () => ({ id: uuid, sessionId: 's', state: 'cancelled', attempt: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), error: null, items: [] }),
  };
  const server = createHttpServer(stub, token, operatorToken, client, () => ({ usedBytes: 0, state: 'ok' }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const operatorPaths = new Set(['/v1/runtime/pins', '/v1/runtime/projects', '/v1/review', '/v1/retry', '/v1/conflicts/resolve', '/v1/versions/cancel', '/v1/reviews/due', '/v1/reviews/complete', '/v1/sync/status', '/v1/sync/refresh', '/v1/injections/latest', '/v1/rules', '/v1/rules/archive', '/v1/rules/{ruleId}', '/v1/archives', '/v1/archives/{entryId}/state', '/v1/archives/{entryId}/history', '/v1/archives/search']);
    const hostPaths = new Set(['/v1/inject', '/v1/view', '/v1/events', '/v1/session/close', '/v1/runtime/context', '/v1/projects', '/v1/diagnostics/embeddings', '/v1/diagnostics/embeddings/backfill', '/v1/idle-review/scan', '/v1/idle-review/signals', '/v1/idle-review/runs', '/v1/idle-review/pending', '/v1/idle-review/runs/{runId}/items', '/v1/idle-review/runs/{runId}/finish']);
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
      '/v1/rules': JSON.stringify({ body: 'probe rule' }),
      '/v1/rules/{ruleId}': JSON.stringify({ enabled: false }),
      '/v1/archives': JSON.stringify({ projectId: 'probe', title: 'probe', body: 'probe body', source: 'session', verification: 'open', evidence: 'probe evidence' }),
      '/v1/archives/{entryId}/state': JSON.stringify({ state: 'archived', baseVersion: 1 }),
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
    // A named Host can read and write rules and project archives.
    const hostRules = await fetch(`${base}/v1/rules`, { headers: { authorization: `Bearer ${token}`, 'x-mnemoweave-host': 'host-probe' } });
    assert.equal(hostRules.status, 200);
    const anonymousRules = await fetch(`${base}/v1/rules`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(anonymousRules.status, 401);
    const hostRuleWrite = await fetch(`${base}/v1/rules`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-mnemoweave-host': 'host-probe', 'content-type': 'application/json' }, body: bodies['/v1/rules']! });
    assert.equal(hostRuleWrite.status, 201, 'a Host may publish a rule');
    const anonymousRuleWrite = await fetch(`${base}/v1/rules`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', connection: 'close' }, body: bodies['/v1/rules']! });
    assert.equal(anonymousRuleWrite.status, 401, 'a rule write without a Host is refused');
    const hostRuleEdit = await fetch(`${base}/v1/rules/${uuid}`, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'x-mnemoweave-host': 'host-probe', 'content-type': 'application/json', connection: 'close' }, body: bodies['/v1/rules/{ruleId}']! });
    assert.equal(hostRuleEdit.status, 200, 'a Host may edit a rule');
    const operatorRuleEdit = await fetch(`${base}/v1/rules/${uuid}`, { method: 'PATCH', headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json', connection: 'close' }, body: bodies['/v1/rules/{ruleId}']! });
    assert.equal(operatorRuleEdit.status, 200, 'the operator still edits without a Host');
    const hostArchives = await fetch(`${base}/v1/archives`, { headers: { authorization: `Bearer ${token}`, 'x-mnemoweave-host': 'host-probe' } });
    assert.equal(hostArchives.status, 200);
    assert.deepEqual((await hostArchives.json() as { items: unknown[] }).items, []);
    const anonymousArchives = await fetch(`${base}/v1/archives`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(anonymousArchives.status, 401);
    const hostArchiveWrite = await fetch(`${base}/v1/archives`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-mnemoweave-host': 'host-probe', 'content-type': 'application/json' }, body: bodies['/v1/archives']! });
    assert.equal(hostArchiveWrite.status, 201);
    const archiveEdit = { title: 'updated', body: 'updated body', evidence: 'updated evidence', verification: 'open', baseVersion: 1 };
    const editArchive = (body: unknown, host = true) => fetch(`${base}/v1/archives/${uuid}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(host ? { 'x-mnemoweave-host': 'host-probe' } : {}) },
      body: JSON.stringify(body),
    });
    assert.equal((await editArchive(archiveEdit, false)).status, 401);
    assert.equal((await editArchive({ ...archiveEdit, baseVersion: undefined })).status, 400);
    assert.equal((await editArchive({ ...archiveEdit, baseVersion: 2 })).status, 409);
    const editedArchive = await editArchive(archiveEdit);
    assert.equal(editedArchive.status, 200);
    assert.equal((await editedArchive.json() as { version: number }).version, 2);
    const allRules = await fetch(`${base}/v1/rules`, { headers: { authorization: `Bearer ${operatorToken}` } });
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
