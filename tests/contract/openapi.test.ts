import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHttpServer, httpRoutes, statusForCode } from '../../packages/protocols/http/src/index.ts';
import type { SyncHttpEndpoints } from '../../packages/protocols/http/src/index.ts';
import { openapi } from '../../packages/core/contracts/src/index.ts';
import type { ErrorCode, ReadGrantRecord, ViewRecord } from '../../packages/core/contracts/src/index.ts';
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
  const grant: ReadGrantRecord = { grantId: uuid, hostId: 'host-probe', projects: ['*'], globalIncluded: true, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), generation: 0 };
  const snapshotPath = join(await mkdtemp(resolve('work/tests/openapi-')), 'snapshot.db');
  await writeFile(snapshotPath, 'probe snapshot bytes');
  const sync: SyncHttpEndpoints = {
    currentGrant: () => grant,
    issueGrant: async () => grant,
    revoke: async () => undefined,
    isRevoked: async () => false,
    watermark: () => 0,
    changes: async () => ({ changes: [], windowOldestSeq: 0, latestSeq: 0 }),
    snapshot: async () => ({ path: snapshotPath, latestSeq: 0 }),
    partitionSummaries: async () => [],
    submitIntent: async () => ({ status: 'accepted', reference: uuid }),
  };
  const server = createHttpServer(stub, token, operatorToken, sync, async () => ({ viewId: uuid } as unknown as ViewRecord), () => ({ usedBytes: 0, state: 'ok' }), { context: () => ({ sessionId: 'probe', task: null, revision: 0, closed: false, entries: [], pins: [], capture: 'idle' }), pin: () => {}, register: () => {} });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const expectedStatus: Record<string, number> = {
      'POST /v1/runtime/context': 200, 'POST /v1/runtime/pins': 200, 'POST /v1/runtime/projects': 200, 'GET /health/live': 200, 'GET /health/ready': 200, 'GET /openapi.json': 200, 'GET /v1/storage': 200,
      'GET /v1/candidates/{candidateId}': 200, 'GET /v1/memories/{memoryId}': 200, 'GET /v1/conflicts/{caseId}': 200,
      'POST /v1/recall': 200, 'POST /v1/view': 200, 'POST /v1/remember': 202, 'POST /v1/review': 200,
      'POST /v1/retry': 202, 'POST /v1/conflicts/resolve': 200, 'POST /v1/versions/cancel': 200,
      'GET /v1/reviews/due': 200, 'POST /v1/reviews/complete': 200,
      'GET /v1/sync/changes': 200, 'GET /v1/sync/snapshot': 200, 'GET /v1/sync/verify': 200,
      'GET /v1/sync/watermark': 200, 'GET /v1/sync/grant': 200, 'POST /v1/sync/grant': 200,
      'POST /v1/sync/revoke': 200, 'POST /v1/sync/intents': 200,
    };
    const operatorPaths = new Set(['/v1/runtime/pins', '/v1/runtime/projects', '/v1/review', '/v1/retry', '/v1/conflicts/resolve', '/v1/versions/cancel', '/v1/sync/grant', '/v1/sync/revoke', '/v1/reviews/due', '/v1/reviews/complete']);
    const hostPaths = new Set(['/v1/recall', '/v1/remember', '/v1/memories/{memoryId}', '/v1/candidates/{candidateId}', '/v1/conflicts/{caseId}', '/v1/runtime/context', '/v1/sync/changes', '/v1/sync/snapshot', '/v1/sync/verify', '/v1/sync/watermark', '/v1/sync/grant', '/v1/sync/intents', '/v1/view']);
    const bodies: Record<string, string> = {
      '/v1/runtime/context': JSON.stringify({ sessionId: 'probe' }),
      '/v1/runtime/pins': JSON.stringify({ memoryId: uuid, tier: 'critical', scope: 'global' }),
      '/v1/runtime/projects': JSON.stringify({ projectId: 'probe' }),
      '/v1/reviews/complete': JSON.stringify({ memoryId: uuid, reason: 'probe review' }),
      '/v1/view': JSON.stringify({ query: 'probe' }),
      '/v1/sync/grant': JSON.stringify({ hostId: 'host-probe', projects: [], globalIncluded: true }),
      '/v1/sync/revoke': JSON.stringify({ hostId: 'host-probe' }),
      '/v1/sync/intents': JSON.stringify({ intentId: 'probe-intent', kind: 'remember', payload: {} }),
    };
    for (const route of httpRoutes) {
      const path = route.path.replace(/\{[a-zA-Z]+\}/g, () => uuid);
      const headers: Record<string, string> = { authorization: `Bearer ${operatorPaths.has(route.path) ? operatorToken : token}` };
      if (hostPaths.has(route.path)) headers['x-mnemoweave-host'] = 'host-probe';
      const response = await fetch(`${base}${path}`, route.method === 'POST'
        ? { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: bodies[route.path] ?? '{}' }
        : { headers });
      assert.equal(response.status, expectedStatus[`${route.method} ${route.path}`], `${route.method} ${route.path}`);
      const bodyText = await response.text();
      assert.notEqual(bodyText.includes('NOT_FOUND'), true, `${route.method} ${route.path} fell through to the unknown-route branch`);
    }
    // Unknown paths must still fall through to NOT_FOUND instead of matching a route.
    const unknown = await fetch(`${base}/v1/unknown`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(unknown.status, 404);
    const wrongMethod = await fetch(`${base}/v1/recall`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(wrongMethod.status, 404);
  } finally {
    await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
  }
});
