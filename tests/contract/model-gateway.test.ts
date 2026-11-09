import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ChatModelGateway, fileUsageSink, TASK_CAPABILITIES } from '../../packages/infrastructure/model-gateway/src/index.ts';
import type { ModelUsageEntry } from '../../packages/infrastructure/model-gateway/src/index.ts';
import { SemanticAssessment } from '../../packages/core/contracts/src/index.ts';
import type { CandidateRecord } from '../../packages/core/contracts/src/index.ts';

const checks = Object.fromEntries(['source', 'accuracy', 'reuse', 'scope', 'duplication', 'consistency'].map(key => [key, { result: 'pass', reason: 'Test fixture assessment' }]));
const assessmentPayload = { checks, requiresHuman: false, conflict: 'none', summary: 'Test only; not real technical validation.' };
const candidate = { id: '123e4567-e89b-42d3-a456-426614174000', request: { idempotencyKey: 'gateway-fixture-1', content: 'gateway fixture content' } } as unknown as CandidateRecord;
const call = (gateway: ChatModelGateway) => gateway.assess('candidate-review', candidate, []);

const okBody = (usage?: Record<string, unknown>) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(assessmentPayload) } }], ...(usage ? { usage } : {}) }), { status: 200 });

/** Replaces global fetch for the duration of one test; returns recorded calls. */
function stubFetch(handler: (init: RequestInit) => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => { calls.push({ url: String(url), init }); return handler(init); }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('Only declared components with a capable route may call the gateway', async () => {
  const gateway = new ChatModelGateway({ routes: [{ url: 'https://model.test/primary', model: 'primary-model', capabilities: ['semantic-assessment'] }] });
  await assert.rejects(gateway.assess('undeclared-task', candidate, []), /Undeclared model caller/);
  const incapable = new ChatModelGateway({ routes: [{ url: 'https://model.test/primary', model: 'primary-model', capabilities: ['other-capability'] }] });
  await assert.rejects(call(incapable), /No configured route declares 'semantic-assessment'/);
  assert.equal(TASK_CAPABILITIES['candidate-review'], 'semantic-assessment');
});

test('Temporary failures retry the primary three times and the backup once, then recover', async () => {
  const usage: ModelUsageEntry[] = [];
  const gateway = new ChatModelGateway({
    routes: [
      { url: 'https://model.test/primary', model: 'primary-model', capabilities: ['semantic-assessment'] },
      { url: 'https://model.test/backup', model: 'backup-model', capabilities: ['semantic-assessment'] },
    ],
    usageSink: { record: entry => usage.push(entry) },
  });
  const stub = stubFetch(async init => String(JSON.parse(String(init.body)).model) === 'primary-model' ? new Response('overloaded', { status: 503 }) : okBody());
  try {
    const result = await call(gateway);
    assert.equal(result.summary, assessmentPayload.summary);
    assert.deepEqual(usage.map(entry => `${entry.route}#${entry.attempt}:${entry.outcome}`), ['primary#1:temporary', 'primary#2:temporary', 'primary#3:temporary', 'backup#1:ok']);
    assert.equal(stub.calls.length, 4);
  } finally { stub.restore(); }
});

test('Parameter, permission and capability failures stop immediately without retry or backup', async () => {
  for (const [status, outcome] of [[400, 'parameter'], [401, 'permission'], [404, 'capability']] as const) {
    const usage: ModelUsageEntry[] = [];
    const gateway = new ChatModelGateway({
      routes: [
        { url: 'https://model.test/primary', model: 'primary-model', capabilities: ['semantic-assessment'] },
        { url: 'https://model.test/backup', model: 'backup-model', capabilities: ['semantic-assessment'] },
      ],
      usageSink: { record: entry => usage.push(entry) },
    });
    const stub = stubFetch(async () => new Response('rejected', { status }));
    try {
      await assert.rejects(call(gateway));
      assert.deepEqual(usage.map(entry => `${entry.route}:${entry.outcome}`), [`primary:${outcome}`]);
      assert.equal(stub.calls.length, 1);
    } finally { stub.restore(); }
  }
});

test('Protocol failures are terminal: truncated or invalid assessments never retry into approval', async () => {
  const usage: ModelUsageEntry[] = [];
  const gateway = new ChatModelGateway({
    routes: [{ url: 'https://model.test/primary', model: 'primary-model', capabilities: ['semantic-assessment'] }, { url: 'https://model.test/backup', model: 'backup-model', capabilities: ['semantic-assessment'] }],
    usageSink: { record: entry => usage.push(entry) },
  });
  const stub = stubFetch(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"checks":{}}' } }] }), { status: 200 }));
  try {
    await assert.rejects(call(gateway));
    assert.deepEqual(usage.map(entry => entry.outcome), ['protocol']);
    assert.equal(stub.calls.length, 1);
  } finally { stub.restore(); }
});

test('The step budget caps retries even when every failure is temporary', async () => {
  const usage: ModelUsageEntry[] = [];
  const gateway = new ChatModelGateway({
    routes: [{ url: 'https://model.test/primary', model: 'primary-model', capabilities: ['semantic-assessment'] }],
    usageSink: { record: entry => usage.push(entry) },
    callTimeoutMs: 40, stepBudgetMs: 70,
  });
  const stub = stubFetch(async init => new Promise<Response>((_, reject) => {
    // Behave like real fetch: reject when the abort signal fires (TimeoutError on timeout).
    (init.signal as AbortSignal | null)?.addEventListener('abort', () => reject((init.signal as AbortSignal).reason), { once: true });
  }));
  try {
    await assert.rejects(call(gateway));
    assert.equal(usage.filter(entry => entry.outcome === 'timeout').length, 2, 'second attempt refused by exhausted budget');
    assert.equal(stub.calls.length, 2);
    for (const entry of usage) { assert.equal(entry.promptTokens, 'unknown'); assert.equal(entry.completionTokens, 'unknown'); }
  } finally { stub.restore(); }
});

test('Usage records keep provider-reported tokens and never record credentials', async () => {
  const usage: ModelUsageEntry[] = [];
  const gateway = new ChatModelGateway({
    routes: [{ url: 'https://model.test/primary', model: 'primary-model', apiKey: 'secret-key-value', capabilities: ['semantic-assessment'] }],
    usageSink: { record: entry => usage.push(entry) },
  });
  const stub = stubFetch(async () => okBody({ prompt_tokens: 12, completion_tokens: 34 }));
  try {
    await call(gateway);
    assert.equal(usage.length, 1);
    assert.equal(usage[0]!.promptTokens, 12);
    assert.equal(usage[0]!.completionTokens, 34);
    assert.equal(usage[0]!.totalTokens, 'unknown');
    assert.equal(JSON.stringify(usage).includes('secret-key-value'), false);
    assert.equal(JSON.stringify(stub.calls[0]!.init.headers).includes('secret-key-value'), true, 'credential goes to the endpoint only');
  } finally { stub.restore(); }
});

test('At most two background model calls run concurrently, extra callers queue', async () => {
  let inFlight = 0; let peak = 0;
  const gateway = new ChatModelGateway({
    routes: [{ url: 'https://model.test/primary', model: 'primary-model', capabilities: ['semantic-assessment'] }],
  });
  const stub = stubFetch(async () => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(resolve => setTimeout(resolve, 40));
    inFlight--;
    return okBody();
  });
  try {
    const results = await Promise.all([call(gateway), call(gateway), call(gateway)]);
    assert.equal(results.length, 3);
    assert.equal(peak, 2);
  } finally { stub.restore(); }
});

test('File usage sink appends parseable JSONL records outside rotated diagnostics', async () => {
  await mkdir('work/tests', { recursive: true });
  const root = await mkdtemp(resolve('work/tests/gateway-'));
  const path = join(root, 'model-usage.jsonl');
  const sink = fileUsageSink(path);
  sink.record({ component: 'candidate-review', model: 'primary-model', route: 'primary', attempt: 1, outcome: 'ok', durationMs: 12, queueWaitMs: 0, promptTokens: 5, completionTokens: 'unknown', totalTokens: 'unknown' });
  sink.record({ component: 'candidate-review', model: 'backup-model', route: 'backup', attempt: 1, outcome: 'temporary', durationMs: 30, queueWaitMs: 3, promptTokens: 'unknown', completionTokens: 'unknown', totalTokens: 'unknown' });
  const lines = (await readFile(path, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal((JSON.parse(lines[0]!) as ModelUsageEntry).outcome, 'ok');
  assert.equal((JSON.parse(lines[1]!) as ModelUsageEntry).route, 'backup');
});
