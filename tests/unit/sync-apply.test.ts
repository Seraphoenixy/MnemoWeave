import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { SyncContentValue, SyncEntryValue } from '../../packages/core/contracts/src/index.ts';
import { plainContent } from '../../packages/core/application/src/sync.ts';
import { applyInboxEntry, decodeContent } from '../../packages/core/application/src/sync-apply.ts';
import type { FormalMapRow, FormalProviderPort, LocalArchiveRow, LocalRuleRow, MemoryApplyStore } from '../../packages/core/application/src/sync-apply.ts';
import type { SyncInboxRecord } from '../../packages/core/application/src/sync.ts';

const NOW = '2026-11-10T09:00:00.000Z';
const ENTRY = '33333333-3333-4333-8333-333333333333';

class FakeStore implements MemoryApplyStore {
  rules: LocalRuleRow[] = [];
  withdrawnRules: string[] = [];
  archives: LocalArchiveRow[] = [];
  withdrawnArchives: string[] = [];
  maps = new Map<string, FormalMapRow>();
  upsertRule(row: LocalRuleRow): void { this.rules = this.rules.filter((item) => item.entryId !== row.entryId).concat(row); }
  withdrawRule(entryId: string): void { this.withdrawnRules.push(entryId); }
  upsertArchive(row: LocalArchiveRow): void { this.archives = this.archives.filter((item) => item.entryId !== row.entryId).concat(row); }
  withdrawArchive(entryId: string): void { this.withdrawnArchives.push(entryId); }
  upsertFormalMap(row: FormalMapRow): void { this.maps.set(`${row.entryId}:${row.version}`, row); }
  formalProviderId(entryId: string, version: number): string | null { return this.maps.get(`${entryId}:${version}`)?.providerId ?? null; }
  versions = new Map<string, number>();
  setEntryVersion(entryId: string, version: number): void { this.versions.set(entryId, version); }
}

class FakeProvider implements FormalProviderPort {
  calls: string[] = [];
  contents = new Map<string, string>();
  links: { source: string; target: string }[] = [];
  private counter = 0;
  async remember(content: string): Promise<{ id: string }> {
    this.calls.push('remember');
    const id = `p-${++this.counter}`;
    this.contents.set(id, content);
    return { id };
  }
  async show(id: string): Promise<{ id: string; content: string }> {
    this.calls.push('show');
    return { id, content: this.contents.get(id) ?? '' };
  }
  async linkSupersedes(sourceId: string, targetId: string): Promise<unknown> {
    this.calls.push(`link:${targetId}`);
    this.links.push({ source: sourceId, target: targetId });
    return { status: 'linked' };
  }
  async forget(): Promise<unknown> {
    this.calls.push('forget');
    return { status: 'deleted' };
  }
}

function entry(overrides: Partial<SyncEntryValue> = {}): SyncEntryValue {
  return {
    entryId: ENTRY,
    kind: 'runtime',
    scope: 'project:alpha',
    version: 1,
    content: plainContent('提交前必须运行类型检查。'),
    payload: { enabled: true },
    withdrawnAt: null,
    revisions: [],
    ...overrides,
  };
}

function inbox(overrides: Partial<SyncInboxRecord> = {}): SyncInboxRecord {
  return {
    scope: 'project:alpha',
    seq: 1,
    changeId: randomUUID(),
    entryId: ENTRY,
    version: 1,
    operation: 'create',
    entry: entry(),
    state: 'received',
    error: null,
    ...overrides,
  };
}

function ports(store = new FakeStore(), provider = new FakeProvider()) {
  return { store, provider, now: () => NOW };
}

test('content is verified before anything is stored', () => {
  assert.equal(decodeContent(plainContent('准则')), '准则');
  assert.throws(() => decodeContent({ ...plainContent('准则'), contentHash: 'a'.repeat(64) }));
  assert.throws(() => decodeContent({ ...plainContent('准则'), byteLength: 99 }));
  const encrypted: SyncContentValue = { format: 'enc-v1', data: 'cipher-text', contentHash: createHash('sha256').update('cipher-text').digest('hex'), byteLength: 11 };
  assert.throws(() => decodeContent(encrypted));
});

test('a runtime change is written locally', async () => {
  const p = ports();
  assert.deepEqual(await applyInboxEntry(inbox(), p), { status: 'applied' });
  assert.equal(p.store.rules.length, 1);
  assert.equal(p.store.rules[0]?.body, '提交前必须运行类型检查。');
  assert.equal(p.store.rules[0]?.scope, 'project');
  assert.equal(p.store.rules[0]?.projectId, 'alpha');
  assert.equal(p.store.rules[0]?.enabled, true);
});

test('a deleted runtime change withdraws instead of storing', async () => {
  const p = ports();
  assert.deepEqual(await applyInboxEntry(inbox({ operation: 'delete', entry: entry({ withdrawnAt: NOW }) }), p), { status: 'applied' });
  assert.deepEqual(p.store.withdrawnRules, [ENTRY]);
  assert.equal(p.store.rules.length, 0);
});

test('an archive change keeps project, verification and evidence', async () => {
  const p = ports();
  const payload = { title: '同步按范围维护游标', source: 'session' as const, verification: 'open' as const, evidence: '三次实验', tags: [] as string[] };
  assert.deepEqual(await applyInboxEntry(inbox({ entry: entry({ kind: 'archive', payload }) }), p), { status: 'applied' });
  assert.equal(p.store.archives[0]?.projectId, 'alpha');
  assert.equal(p.store.archives[0]?.verification, 'open');
  assert.equal(p.store.archives[0]?.evidence, '三次实验');
});

test('a formal change is written, read back and only then mapped', async () => {
  const p = ports();
  const payload = { category: 'fact' as const, importance: 3, tags: [], entities: [], relations: [] };
  assert.deepEqual(await applyInboxEntry(inbox({ entry: entry({ kind: 'formal', payload }) }), p), { status: 'applied' });
  assert.deepEqual(p.provider.calls, ['remember', 'show']);
  const map = p.store.maps.get(`${ENTRY}:1`);
  assert.equal(map?.state, 'applied');
  assert.equal(map?.providerId, 'p-1');
});

test('a later formal revision links to the previous local revision', async () => {
  const p = ports();
  p.store.upsertFormalMap({ entryId: ENTRY, version: 1, providerId: 'p-old', contentHash: 'x'.repeat(64), state: 'applied', appliedAt: NOW });
  const payload = { category: 'fact' as const, importance: 3, tags: [], entities: [], relations: [] };
  const record = inbox({ seq: 2, version: 2, operation: 'update', entry: entry({ kind: 'formal', version: 2, content: plainContent('第二版正式记忆。'), payload }) });
  assert.deepEqual(await applyInboxEntry(record, p), { status: 'applied' });
  assert.deepEqual(p.provider.links, [{ source: 'p-1', target: 'p-old' }]);
  assert.equal(p.store.formalProviderId(ENTRY, 2), 'p-1');
});

test('a mismatched read-back stops before the mapping moves', async () => {
  const p = ports();
  p.provider.show = async (id: string) => ({ id, content: '内容已被外部改写' });
  const payload = { category: 'fact' as const, importance: 3, tags: [], entities: [], relations: [] };
  assert.deepEqual(await applyInboxEntry(inbox({ entry: entry({ kind: 'formal', payload }) }), p), { status: 'needs_review', error: 'PROVIDER_INTEGRITY' });
  assert.equal(p.store.maps.size, 0);
});

test('a withdrawn formal memory is forgotten and stays readable as a tombstone', async () => {
  const p = ports();
  p.store.upsertFormalMap({ entryId: ENTRY, version: 1, providerId: 'p-old', contentHash: 'x'.repeat(64), state: 'applied', appliedAt: NOW });
  const payload = { category: 'fact' as const, importance: 3, tags: [], entities: [], relations: [] };
  const record = inbox({ seq: 2, version: 2, operation: 'delete', entry: entry({ kind: 'formal', version: 2, payload, withdrawnAt: NOW }) });
  assert.deepEqual(await applyInboxEntry(record, p), { status: 'applied' });
  assert.deepEqual(p.provider.calls, ['forget']);
  assert.equal(p.store.maps.get(`${ENTRY}:2`)?.providerId, null);
});

test('encrypted or unverifiable bodies never reach the store', async () => {
  const p = ports();
  const encrypted: SyncContentValue = { format: 'enc-v1', data: 'cipher-text', contentHash: createHash('sha256').update('cipher-text').digest('hex'), byteLength: 11 };
  assert.deepEqual(await applyInboxEntry(inbox({ entry: entry({ content: encrypted }) }), p), { status: 'needs_review', error: 'NEEDS_REVIEW' });
  assert.equal(p.store.rules.length, 0);
  assert.deepEqual(p.provider.calls, []);
});
