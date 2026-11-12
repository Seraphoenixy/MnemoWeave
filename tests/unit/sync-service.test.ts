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
    state: (stream: string): SyncStateRecord => states.get(stream) ?? { stream, cursor: 0, lastPullAt: null, lastError: null },
    cursor: (stream: string) => stub.state(stream).cursor,
    setCursor: (stream: string, cursor: number, at: string) => { states.set(stream, { ...stub.state(stream), cursor, lastPullAt: at }); },
    setError: (stream: string, error: string | null, at: string) => { states.set(stream, { ...stub.state(stream), lastError: error, lastPullAt: at }); },
    enqueue: () => undefined,
    outbox: (state = 'pending') => (state === 'pending'
      ? Array.from({ length: options.pending ?? 0 }, () => ({ stream: 'rules' }))
      : []) as never[],
    markOutbox: () => undefined,
    receive: () => true,
    inbox: (stream: string) => (options.unapplied ?? []).filter((item) => item.startsWith(stream)).map(() => ({}) as SyncInboxRecord),
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
    async pullStream(stream) { calls.push(`pull:${stream}`); return { received: 1, needsSnapshot: false, gapAt: null, mismatched: 0 }; },
    async applyStream(stream) { calls.push(`apply:${stream}`); return { applied: 1, cursor: 1 }; },
    async captureSnapshot(stream) { calls.push(`snapshot:${stream}`); return { applied: 2, failed: 0, cursor: 9 }; },
    ...overrides,
  };
  return { calls, driver: base };
}

function remote(streams: string[]) {
  return { async streams() { return { deviceId: 'device-a', streams: streams.map((stream) => ({ stream, canRead: true, canWrite: true })) }; } };
}

test('a pass covers every readable stream in resolve, flush, pull, apply order', async () => {
  const { ledger } = ledgerStub();
  const { calls, driver: pass } = driver();
  const service = new SyncService({ remote: remote(['rules', 'formal-memories']), coordinator: pass, ledger, apply: async () => ({ status: 'applied' }), intervalMs: 0, now: () => NOW });
  const result = await service.refresh();
  assert.deepEqual(calls, ['resolve', 'flush', 'pull:rules', 'apply:rules', 'pull:formal-memories', 'apply:formal-memories']);
  assert.deepEqual(result.streams, ['rules', 'formal-memories']);
  assert.equal(result.pulled, 2);
  assert.equal(result.applied, 2);
  assert.deepEqual(result.errors, []);
});

test('a failing stream is recorded and does not stop the others', async () => {
  const { stub, ledger } = ledgerStub();
  const { driver: pass } = driver({
    async pullStream(stream) { if (stream === 'rules') throw new Error('SYNC_UNAVAILABLE'); return { received: 0, needsSnapshot: false, gapAt: null, mismatched: 0 }; },
  });
  const service = new SyncService({ remote: remote(['rules', 'formal-memories']), coordinator: pass, ledger, apply: async () => ({ status: 'applied' }), intervalMs: 0, now: () => NOW });
  const result = await service.refresh();
  assert.deepEqual(result.errors, ['rules:Error']);
  assert.equal(stub.state('rules').lastError, 'SYNC_UNAVAILABLE');
  assert.equal(result.applied, 1);
});

test('a retention gap takes a snapshot instead of stalling on the cursor', async () => {
  const { ledger } = ledgerStub();
  const { calls, driver: pass } = driver({
    async pullStream(stream) { calls.push(`pull:${stream}`); return { received: 0, needsSnapshot: true, gapAt: null, mismatched: 0 }; },
  });
  const service = new SyncService({ remote: remote(['rules']), coordinator: pass, ledger, apply: async () => ({ status: 'applied' }), intervalMs: 0, now: () => NOW });
  const result = await service.refresh();
  assert.deepEqual(calls, ['resolve', 'flush', 'pull:rules', 'snapshot:rules']);
  assert.equal(result.applied, 2);
  assert.deepEqual(result.errors, []);
});

test('an incomplete snapshot application is reported per stream', async () => {
  const { ledger } = ledgerStub();
  const { driver: pass } = driver({
    async pullStream() { return { received: 0, needsSnapshot: true, gapAt: null, mismatched: 0 }; },
    async captureSnapshot() { return { applied: 1, failed: 1, cursor: 9 }; },
  });
  const service = new SyncService({ remote: remote(['rules']), coordinator: pass, ledger, apply: async () => ({ status: 'applied' }), intervalMs: 0, now: () => NOW });
  const result = await service.refresh();
  assert.deepEqual(result.errors, ['rules:SNAPSHOT_APPLY_INCOMPLETE']);
});

test('overlapping passes are skipped instead of queued', async () => {
  const { ledger } = ledgerStub();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { driver: pass } = driver({ async pullStream() { await gate; return { received: 0, needsSnapshot: false, gapAt: null, mismatched: 0 }; } });
  const service = new SyncService({ remote: remote(['rules']), coordinator: pass, ledger, apply: async () => ({ status: 'applied' }), intervalMs: 0, now: () => NOW });
  const first = service.refresh();
  const second = await service.refresh();
  assert.equal(second.skipped, true);
  release();
  await first;
});

test('status reports cursor, pending and unapplied counts per stream', async () => {
  const { stub, ledger } = ledgerStub({ pending: 2, unapplied: ['rules', 'rules'] });
  const { driver: pass } = driver();
  const service = new SyncService({ remote: remote(['rules']), coordinator: pass, ledger, apply: async () => ({ status: 'applied' }), intervalMs: 0, now: () => NOW });
  await service.refresh();
  stub.setCursor('rules', 4, NOW);
  const status = service.status();
  assert.equal(status.enabled, true);
  assert.equal(status.protocol, 2);
  assert.deepEqual(status.streams, [{ stream: 'rules', cursor: 4, lastPullAt: NOW, lastError: null, pending: 2, unknown: 0, unapplied: 2 }]);
});

test('start runs once immediately and stop clears the timer', async () => {
  const { ledger } = ledgerStub();
  let passes = 0;
  const { driver: pass } = driver({ async resolveUnknown() { passes += 1; return { confirmed: 0, requeued: 0 }; } });
  const service = new SyncService({ remote: remote(['rules']), coordinator: pass, ledger, apply: async () => ({ status: 'applied' }), intervalMs: 0, now: () => NOW });
  service.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(passes, 1);
  service.stop();
  service.stop();
});
