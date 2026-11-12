import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer, httpRoutes, statusForCode } from '../../packages/protocols/http/src/index.ts';
import type { ClientHttpEndpoints } from '../../packages/protocols/http/src/index.ts';
import { openapi } from '../../packages/core/contracts/src/index.ts';
import type { ErrorCode } from '../../packages/core/contracts/src/index.ts';
import type { MemoryApplication } from '../../packages/core/application/src/index.ts';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';

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
    RULE_ITEM_TOO_LARGE: 409,
    RULE_CAPACITY_EXCEEDED: 409,
    ARCHIVE_BODY_TOO_LARGE: 409,
    ARCHIVE_CAPACITY_EXCEEDED: 409,
    ARCHIVE_NOT_ACTIVE: 409,
    WORKSPACE_REQUIRED: 409,
    WORKSPACE_NOT_BOUND: 409,
    TURN_BUDGET_EXCEEDED: 409,
    TURN_NO_RETENTION: 409,
    MEMORY_WRITE_TASK_INVALID: 409,
    ARCHIVE_DISTILLATION_INVALID: 409,
    NEEDS_REVIEW: 409,
    DEVICE_REVOKED: 401,
    SCOPE_FORBIDDEN: 403,
    SYNC_UNAVAILABLE: 503,
  };
  for (const [code, status] of Object.entries(expected)) assert.equal(statusForCode(code as ErrorCode), status, code);
});

/** One integration pass that walks every served route and fails on a fall-through. */
test('Every documented route is actually handled by the HTTP server', async () => {
  const candidate = { id: UUID, status: 'pending_review' };
  const stub = {
    health: async () => ({ ready: true as const, version: '0.2.13' as const, capabilities: ['health'] }),
    recall: async () => ({ memories: [] }),
    remember: async () => candidate,
    candidateStatus: async () => candidate,
    readMemory: async () => ({ content: 'stub' }),
    readConflict: async () => ({ id: UUID }),
    resolveConflict: async () => candidate,
    cancelVersion: async () => candidate,
    reviewDue: async () => ({ items: [] }),
    completeReview: async () => ({ memoryId: UUID }),
    humanReview: async () => candidate,
    retryWrite: async () => candidate,
  } as unknown as MemoryApplication;
  const token = 'local-contract-token-0123456789';
  const operatorToken = 'local-operator-contract-0123456789';
  const now = () => new Date().toISOString();
  const rule = (version = 1) => ({
    entryId: UUID, body: 'probe rule', enabled: true, version, withdrawnAt: null,
    importance: 'normal' as const, pinned: false, bodyBytes: 10,
  });
  const archive = (version = 1) => ({
    entryId: UUID, workspaceId: WORKSPACE, title: 'probe', body: 'probe body', source: 'session' as const,
    verification: 'open' as const, evidence: 'probe evidence', version, withdrawnAt: null,
    state: 'active' as const, archivedAt: null, bodyBytes: 10,
  });
  const idleRun = () => ({
    id: UUID, sessionId: 'probe', state: 'running' as const, attempt: 1,
    startedAt: now(), finishedAt: null, error: null, items: [],
  });
  const client: ClientHttpEndpoints = {
    inject: async hostId => ({ hostId, sessionId: 'probe', rules: [], usedBytes: 0, limitBytes: 10_000, complete: true, createdAt: now() }),
    closeSession: () => undefined,
    events: () => ({ status: 'stored', eventId: 'probe-event-1' }),
    memories: async () => ({ items: [] }),
    createMemory: async () => ({ memoryId: UUID, revisionId: UUID, providerMemoryId: 'probe', contentHash: 'a'.repeat(64), entryVersion: 0 }),
    editMemory: async () => ({ memoryId: UUID, revisionId: UUID, providerMemoryId: 'probe', contentHash: 'a'.repeat(64), entryVersion: 1 }),
    withdrawMemory: async () => ({ memoryId: UUID, revisionId: UUID, entryVersion: 2, withdrawnAt: now() }),
    embeddingDiagnostics: async () => ({
      provider: 'mnemon', model: 'nomic-embed-text', protocol: 'ollama',
      serviceAvailable: false, modelAvailable: false, embedded: 0, total: 0, coverage: 0,
      recallMode: 'unknown', degraded: true, lastError: 'embedding service unreachable', checkedAt: now(),
    }),
    embeddingBackfill: async () => ({ id: UUID, kind: 'embedding-backfill', state: 'running', startedAt: now(), finishedAt: null }),
    graph: async () => ({ nodes: [], edges: [], truncated: false }),
    recall: async () => ({ memories: [] }),
    related: async () => ({ memories: [], truncated: false }),
    explore: async () => ({ query: 'probe', hits: [], unregistered: 0, truncated: false }),
    syncStatus: async () => ({ enabled: true, protocol: 2, streams: [], updatedAt: now() }),
    syncRefresh: async () => ({ streams: [], pulled: 0, applied: 0, errors: [], skipped: false }),
    lastInjection: async () => ({ id: UUID, hostId: 'host-probe', sessionId: 'probe', ruleCount: 0, usedBytes: 0, createdAt: now() }),
    rules: async () => ({
      items: [], usage: { limitBytes: 10_000, itemMaxBytes: 8192, usedBytes: 0, entryCount: 0, exceeded: false, overByBytes: 0 },
    }),
    ruleArchive: async () => ({ items: [] }),
    createRule: async () => rule(),
    editRule: async () => rule(2),
    workspaces: async () => ({ items: [{ workspaceId: WORKSPACE, name: 'probe workspace', createdAt: now() }] }),
    registerWorkspace: async input => ({ workspaceId: input.workspaceId, name: input.name, createdAt: now() }),
    bindWorkspace: async workspaceId => ({ workspaceId, name: 'probe workspace', createdAt: now(), boundRootCount: 1 }),
    bindSession: async (_hostId, sessionId) => ({ sessionId, workspaceId: WORKSPACE, boundAt: now() }),
    sessionWorkspace: () => WORKSPACE,
    archives: async () => ({ items: [], capacities: [{ workspaceId: WORKSPACE, activeBytes: 0, limitBytes: 10 * 1024 * 1024, activeCount: 0, archivedCount: 0, exceeded: false }] }),
    searchArchives: async (_hostId, input) => ({
      query: input.query, total: 0, results: [], totalChars: 0, truncated: false, totalLimitChars: 6_000, callsLimit: 4,
    }),
    archiveHistory: async entryId => ({ entryId, items: [] }),
    archiveSegment: async entryId => ({
      entryId, workspaceId: WORKSPACE, version: 1, title: 'probe', content: 'body', complete: true, totalChars: 4,
    }),
    createArchive: async () => archive(),
    editArchive: async entryId => ({ ...archive(2), entryId }),
    editArchiveState: async entryId => ({ ...archive(2), entryId, state: 'archived', archivedAt: now() }),
    writeTaskAction: async () => ({
      taskId: UUID, index: 0, kind: 'formal-memory', action: 'create', status: 'published',
      memoryId: UUID, entryVersion: 1, entryId: null, candidateId: null, errorCode: null, updatedAt: now(),
    }),
    writeTaskReceipt: async () => ({
      taskId: UUID, index: 0, kind: 'formal-memory', action: 'create', status: 'published',
      memoryId: UUID, entryVersion: 1, entryId: null, candidateId: null, errorCode: null, updatedAt: now(),
    }),
    createDistillation: async () => ({
      draftId: UUID, source: { workspaceId: WORKSPACE, entryId: UUID, entryVersion: 1, contentHash: 'a'.repeat(64) },
      content: 'probe', knowledgeType: 'Practice', reason: 'probe', assessment: 'supported',
      contentHash: 'b'.repeat(64), createdAt: now(), taskId: null,
    }),
    readDistillation: async () => ({
      draftId: UUID, source: { workspaceId: WORKSPACE, entryId: UUID, entryVersion: 1, contentHash: 'a'.repeat(64) },
      content: 'probe', knowledgeType: 'Practice', reason: 'probe', assessment: 'supported',
      contentHash: 'b'.repeat(64), createdAt: now(), taskId: null,
    }),
    idleReviewScan: async () => ({ signals: [], lastTurn: 0, skipped: { tooShort: 0, question: 0, noTurn: 0, outOfWindow: 0, duplicate: 0, noRetention: 0 } }),
    idleReviewSignals: async () => ({ items: [] }),
    idleReviewRunStart: async () => ({ run: idleRun(), signals: [] }),
    idleReviewRuns: async () => ({ items: [] }),
    idleReviewPending: async () => ({ sessions: [] }),
    idleReviewRunItem: async () => idleRun(),
    idleReviewRunFinish: async () => ({ ...idleRun(), state: 'cancelled', finishedAt: now() }),
  };
  const server = createHttpServer(stub, token, operatorToken, client, () => ({ usedBytes: 0, state: 'ok' }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    // Routes the operator credential owns; everything else needs a named Host.
    const operatorPaths = new Set([
      '/v1/workspaces', '/v1/review', '/v1/retry', '/v1/conflicts/resolve', '/v1/versions/cancel',
      '/v1/reviews/due', '/v1/reviews/complete', '/v1/sync/status', '/v1/sync/refresh',
      '/v1/injections/latest', '/v1/rules', '/v1/rules/archive', '/v1/rules/{ruleId}',
      '/v1/archives', '/v1/archives/{entryId}/state', '/v1/archives/{entryId}/history', '/v1/archives/search',
    ]);
    const bodies: Record<string, string> = {
      '/v1/inject': JSON.stringify({ sessionId: 'probe' }),
      '/v1/events': JSON.stringify({
        protocolVersion: '1', adapterVersion: 'probe', eventId: 'probe-event-1', sessionId: 'probe',
        kind: 'session.started', occurredAt: now(), receivedAt: now(), sourceRef: 'probe', payload: {},
      }),
      '/v1/session/close': JSON.stringify({ sessionId: 'probe' }),
      '/v1/recall': JSON.stringify({ query: 'probe' }),
      '/v1/memories/explore': JSON.stringify({ query: 'probe' }),
      '/v1/memories/related': JSON.stringify({ memoryId: UUID }),
      '/v1/memories': JSON.stringify({ content: 'probe', knowledgeType: 'Practice' }),
      '/v1/memories/{memoryId}': JSON.stringify({ content: 'edited', entryVersion: 1 }),
      '/v1/memories/{memoryId}/withdraw': JSON.stringify({ reason: 'probe', entryVersion: 1 }),
      '/v1/rules': JSON.stringify({ body: 'probe rule' }),
      '/v1/rules/{ruleId}': JSON.stringify({ enabled: false, baseVersion: 1 }),
      '/v1/workspaces': JSON.stringify({ workspaceId: WORKSPACE, name: 'probe workspace' }),
      '/v1/workspaces/{workspaceId}/binding': JSON.stringify({ rootPath: process.cwd() }),
      '/v1/sessions/{sessionId}/workspace': JSON.stringify({ workspaceId: WORKSPACE }),
      '/v1/archives': JSON.stringify({
        workspaceId: WORKSPACE, title: 'probe', body: 'probe body', source: 'session',
        verification: 'open', evidence: 'probe evidence',
      }),
      '/v1/archives/{entryId}': JSON.stringify({ title: 'updated', baseVersion: 1 }),
      '/v1/archives/{entryId}/state': JSON.stringify({ state: 'archived', baseVersion: 1 }),
      '/v1/archives/search': '{}',
      '/v1/memory-write-tasks/{taskId}/actions/{index}': JSON.stringify({
        kind: 'formal-memory', trigger: 'conversation', action: 'create', reason: 'probe',
        assessment: 'supported', evidenceRefs: ['probe'], content: 'probe memory', knowledgeType: 'Practice',
      }),
      '/v1/archive-distillations': JSON.stringify({
        source: { workspaceId: WORKSPACE, entryId: UUID, entryVersion: 1, contentHash: 'a'.repeat(64) },
        content: 'probe', knowledgeType: 'Practice', reason: 'probe', assessment: 'supported',
      }),
      '/v1/idle-review/scan': JSON.stringify({ sessionId: 'probe', completedThroughTurn: 1 }),
      '/v1/idle-review/runs': JSON.stringify({ sessionId: 'probe' }),
      '/v1/idle-review/runs/{runId}/items': JSON.stringify({ index: 0, action: 'skip', state: 'skipped' }),
      '/v1/idle-review/runs/{runId}/finish': JSON.stringify({ state: 'succeeded' }),
      '/v1/reviews/complete': JSON.stringify({ memoryId: UUID, reason: 'probe review' }),
      '/v1/review': JSON.stringify({ candidateId: UUID, decision: 'approve', reason: 'probe' }),
      '/v1/retry': JSON.stringify({ candidateId: UUID, reason: 'probe', confirmNoActiveWrite: true }),
      '/v1/versions/cancel': JSON.stringify({ candidateId: UUID, reason: 'probe', confirmNoActiveWrite: true }),
      '/v1/conflicts/resolve': JSON.stringify({ caseId: UUID, decision: 'keep_existing', reason: 'probe', evidence: ['probe'] }),
    };
    // A query string is part of the fixture, not of the route pattern.
    const queryFor = (path: string): string => path.includes('?') ? path.slice(path.indexOf('?')) : '';
    const routeKey = (path: string): string => path.split('?')[0]!;
    for (const route of httpRoutes) {
      // The action index is a decimal segment, everything else is a UUID.
      const substituted = route.path.replace(/\{(index|runId|memoryId|entryId|ruleId|workspaceId|taskId|sessionId|draftId|caseId|candidateId|changeId)\}/g, (_match, name: string) => name === 'index' ? '0' : name === 'sessionId' ? 'probe' : UUID);
      const fixture = route.path === '/v1/archives/search'
        ? `/v1/archives/search?workspaceId=${WORKSPACE}&query=probe`
        : substituted;
      const target = `/v1/archives/search` === route.path ? fixture : substituted;
      const headers: Record<string, string> = {
        authorization: `Bearer ${operatorPaths.has(route.path) ? operatorToken : token}`,
        'x-mnemoweave-host': 'host-probe',
      };
      // Model-facing reads require the turn identity the host reads from its execution context.
      if (['/v1/recall', '/v1/memories/related', '/v1/memories/explore', '/v1/archives/{entryId}/content'].includes(route.path)) {
        headers['x-mnemoweave-session-id'] = 'probe';
        headers['x-mnemoweave-turn-id'] = '1';
      }
      const body = bodies[route.path] ?? '{}';
      const response = await fetch(`${base}${target}${queryFor(fixture)}`, route.method === 'GET'
        ? { headers }
        : { method: route.method, headers: { ...headers, 'content-type': 'application/json' }, body });
      assert.notEqual(response.status, 404, `${route.method} ${route.path} fell through to the unknown-route branch`);
      assert.equal(routeKey(target), routeKey(substituted));
    }

    // Unknown paths and wrong methods still fall through to NOT_FOUND.
    assert.equal((await fetch(`${base}/v1/unknown`, { headers: { authorization: `Bearer ${token}` } })).status, 404);
    assert.equal((await fetch(`${base}/v1/recall`, { headers: { authorization: `Bearer ${token}` } })).status, 404);

    // Sync diagnostics: the operator reads them, and so does a Host that names itself.
    assert.equal((await fetch(`${base}/v1/sync/status`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
    assert.equal((await fetch(`${base}/v1/sync/status`, { headers: { authorization: `Bearer ${token}`, 'x-mnemoweave-host': 'host-probe' } })).status, 200);
    const operatorStatus = await fetch(`${base}/v1/sync/status`, { headers: { authorization: `Bearer ${operatorToken}` } });
    assert.equal(operatorStatus.status, 200);
    const status = await operatorStatus.json() as { enabled: boolean; protocol: number; streams: unknown[] };
    assert.equal(status.enabled, true);
    assert.equal(status.protocol, 2, 'the diagnostics name the protocol the local Server speaks');

    // Rules and archives are user writes: a named Host may perform them, an anonymous one may not.
    const hostRuleWrite = await fetch(`${base}/v1/rules`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-mnemoweave-host': 'host-probe', 'content-type': 'application/json' },
      body: bodies['/v1/rules']!,
    });
    assert.equal(hostRuleWrite.status, 201);
    assert.equal((await fetch(`${base}/v1/rules`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: bodies['/v1/rules']!,
    })).status, 401);

    // An archive management list without a workspace is refused, not silently unscoped.
    const unscoped = await fetch(`${base}/v1/archives`, { headers: { authorization: `Bearer ${operatorToken}` } });
    assert.equal(unscoped.status, 409);
    assert.equal((await unscoped.json() as { code: string }).code, 'WORKSPACE_REQUIRED');
    const scoped = await fetch(`${base}/v1/archives?workspaceId=${WORKSPACE}`, { headers: { authorization: `Bearer ${operatorToken}` } });
    assert.equal(scoped.status, 200);

    // A removed project filter is refused rather than ignored: a client that still sends one
    // would otherwise read an unfiltered list and believe it was filtered.
    const removedFilter = await fetch(`${base}/v1/memories?projectId=alpha`, { headers: { authorization: `Bearer ${token}`, 'x-mnemoweave-host': 'host-probe' } });
    assert.equal(removedFilter.status, 400);
    const removedGraphFilter = await fetch(`${base}/v1/memories/graph?includeGlobal=false`, { headers: { authorization: `Bearer ${token}`, 'x-mnemoweave-host': 'host-probe' } });
    assert.equal(removedGraphFilter.status, 400);
    // `/v1/view` is gone with the aggregate View.
    assert.equal((await fetch(`${base}/v1/view`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-mnemoweave-host': 'host-probe', 'content-type': 'application/json' }, body: '{}',
    })).status, 404);

    // The authorized write-task entry is host code only, and never a model tool.
    assert.equal((await fetch(`${base}/v1/memory-write-tasks/${UUID}/actions/0`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
    })).status, 401);

    // Injection visibility: the operator reads the newest report, a host only its own.
    assert.equal((await fetch(`${base}/v1/injections/latest`, { headers: { authorization: `Bearer ${operatorToken}` } })).status, 200);
    assert.equal((await fetch(`${base}/v1/injections/latest`, { headers: { authorization: `Bearer ${token}`, 'x-mnemoweave-host': 'host-probe' } })).status, 200);
    assert.equal((await fetch(`${base}/v1/injections/latest`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
  } finally {
    await new Promise<void>((done, fail) => { server.closeAllConnections(); server.close(error => error ? fail(error) : done()); });
  }
});
