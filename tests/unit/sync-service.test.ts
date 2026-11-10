import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SyncInboxRecord, SyncLedgerPort, SyncStateRecord } from '../../packages/core/application/src/sync.ts';
import { SyncService } from '../../apps/server/src/sync-service.ts';
import type { SyncPassDriver } from '../../apps/server/src/sync-service.ts';

const NOW = '2026-11-10T11:00:00.000Z';

function ledgerStub(options: { pending?: number; unapplied?: string[] } = {}) {
  const states = new Map<string, SyncStateRecord>();
  const stub = {
    states,
    state: (scope: string): SyncStateRecord => states.get(scope) ?? { scope, cursor: 0, lastPullAt: null, lastError: null },
    cursor: (scope: string) => stub.state(scope).cursor,
    setCursor: (scope: string, cursor: number, at: string) => { states.set(scope, { ...stub.state(scope), cursor, lastPullAt: at }); },
    setError: (scope: string, error: string | null, at: string) => { states.set(scope, { ...stub.state(scope), lastError: error, lastPullAt: at }); },
    enqueue: () => undefined,
    outbox: (state = 'pending') => (state === 'pending'
      ? Array.from({ length: options.pending ?? 0 }, () => ({ scope: 'global' }))
      : []) as never[],
    markOutbox: () => undefined,
    receive: () => true,
    inbox: (scope: string) => (options.unapplied ?? []).filter((item) => item.startsWith(scope)).map(() => ({}) as SyncInboxRecord),
    markInbox: () => undefined,
    progress: () => [],
  };
  return { stub, ledger: stub as unknown as SyncLedgerPort };
}

function driver(overrides: Partial<SyncPassDriver> = {}) {
  const calls: string[] = [];
  const base: SyncPassDriver = {
    async resolveUnknown() { calls.push('resolve'); return { confirmed: 0, requeued: 0 }; },
    async flushOutbox() { calls.push('flush'); return { confirmed: 0, conflict: 0, unknown: 0, queued: 0, needsReview: 0 }; },
    async pullScope(scope) { calls.push(`pull:${scope}`); return { received: 1, needsSnapshot: false, gapAt: null }; },
    async applyScope(scope) { calls.push(`apply:${scope}`); return { applied: 1, cursor: 1 }; },
    async captureSnapshot(scope) { calls.push(`snapshot:${scope}`); return { applied: 2, failed: 0, cursor: 9 }; },
    ...overrides,
  };
  return { calls, driver: base };
}

function remote(scopes: string[]) {
  return { async scopes() { return { deviceId: 'device-a', scopes: scopes.map((scope) => ({ scope, canRead: true, canWrite: true })) }; } };
}

test('a pass covers every readable scope in resolve, flush, pull, apply order', async () => {
  const { ledger } = ledgerStub();
  const { calls, driver: pass } = driver();
  const service = new SyncService({ remote: remote(['global', 'project:alpha']), coordinator: pass, ledger, apply: async () => ({ status: 'applied' }), intervalMs: 0, now: () => NOW });
  const result = await service.refresh();
  assert.deepEqual(calls, ['resolve', 'flush', 'pull:global', 'apply:global', 'pull:project:alpha', 'apply:project:alpha']);
  assert.deepEqual(result.scopes, ['global', 'project:alpha']);
  assert.equal(result.pulled, 2);
  assert.equal(result.applied, 2);
  assert.deepEqual(result.errors, []);
});

test('a failing scope is recorded and does not stop the others', async () => {
  const { stub, ledger } = ledgerStub();
  const { driver: pass } = driver({
    async pullScope(scope) { if (scope === 'global') throw new Error('SYNC_UNAVAILABLE'); return { received: 0, needsSnapshot: false, gapAt: null }; },
  });
  const service = new SyncService({ remote: remote(['global', 'project:alpha']), coordinator: pass, ledger, apply: async () => ({ status: 'applied' }), intervalMs: 0, now: () => NOW });
  const result = await service.refresh();
  assert.deepEqual(result.errors, ['global:Error']);
  assert.equal(stub.state('global').lastError, 'SYNC_UNAVAILABLE');
  assert.equal(result.applied, 1);
});

test('a retention gap takes a snapshot instead of stalling on the cursor', async () => {
  const { ledger } = ledgerStub();
  const { calls, driver: pass } = driver({
    async pullScope(scope) { calls.push(`pull:${scope}`); return { received: 0, needsSnapshot: true, gapAt: null }; },
  });
  const service = new SyncService({ remote: remote(['global']), coordinator: pass, ledger, apply: async () => ({ status: 'applied' }), intervalMs: 0, now: () => NOW });
  const result = await service.refresh();
  assert.deepEqual(calls, ['resolve', 'flush', 'pull:global', 'snapshot:global']);
  assert.equal(result.applied, 2);
  assert.deepEqual(result.errors, []);
});

test('an incomplete snapshot application is reported per scope', async () => {
  const { ledger } = ledgerStub();
  const { driver: pass } = driver({
    async pullScope() { return { received: 0, needsSnapshot: true, gapAt: null }; },
    async captureSnapshot() { return { applied: 1, failed: 1, cursor: 9 }; },
  });
  const service = new SyncService({ remote: remote(['global']), coordinator: pass, ledger, apply: async () => ({ status: 'applied' }), intervalMs: 0, now: () => NOW });
  const result = await service.refresh();
  assert.deepEqual(result.errors, ['global:SNAPSHOT_APPLY_INCOMPLETE']);
});

test('overlapping passes are skipped instead of queued', async () => {
  const { ledger } = ledgerStub();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { driver: pass } = driver({ async pullScope() { await gate; return { received: 0, needsSnapshot: false, gapAt: null }; } });
  const service = new SyncService({ remote: remote(['global']), coordinator: pass, ledger, apply: async () => ({ status: 'applied' }), intervalMs: 0, now: () => NOW });
  const first = service.refresh();
  const second = await service.refresh();
  assert.equal(second.skipped, true);
  release();
  await first;
});

test('status reports cursor, pending and unapplied counts per scope', async () => {
  const { stub, ledger } = ledgerStub({ pending: 2, unapplied: ['global', 'global'] });
  const { driver: pass } = driver();
  const service = new SyncService({ remote: remote(['global']), coordinator: pass, ledger, apply: async () => ({ status: 'applied' }), intervalMs: 0, now: () => NOW });
  await service.refresh();
  stub.setCursor('global', 4, NOW);
  const status = service.status();
  assert.equal(status.enabled, true);
  assert.deepEqual(status.scopes, [{ scope: 'global', cursor: 4, lastPullAt: NOW, lastError: null, pending: 2, unknown: 0, unapplied: 2 }]);
});

test('start runs once immediately and stop clears the timer', async () => {
  const { ledger } = ledgerStub();
  let passes = 0;
  const { driver: pass } = driver({ async resolveUnknown() { passes += 1; return { confirmed: 0, requeued: 0 }; } });
  const service = new SyncService({ remote: remote(['global']), coordinator: pass, ledger, apply: async () => ({ status: 'applied' }), intervalMs: 0, now: () => NOW });
  service.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(passes, 1);
  service.stop();
  service.stop();
});
