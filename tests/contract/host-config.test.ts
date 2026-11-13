import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  DEFAULT_INJECT_TIMEOUT_MS, DEFAULT_SERVER_URL, describeHostConfig, ensureReachable, readPreferences,
  resolveHostConfig, validatePreferences, writePreferences,
} from '../../plugins/dsh-mnemo-weave/src/shared/host-config.js';
import { SettingsService } from '../../plugins/dsh-mnemo-weave/src/ui/settings.ts';
import { tempDir } from '../support/temp.ts';

/**
 * The page and the prompt-injection hook must read one configuration. These tests pin the
 * resolution order, the split between what may be stored and what may only come from a protected
 * source, and the rule that a rejected connection never replaces a working one.
 */

const TOKEN = 'service-token-0123456789abcdef';

async function tempEnv(name: string): Promise<NodeJS.ProcessEnv> {
  // A fresh directory per run: preferences are files, so a shared path would leak between runs.
  const root = await tempDir('host-config', name);
  return { MNEMOWEAVE_DSH_SETTINGS: join(root, 'settings.json') } as NodeJS.ProcessEnv;
}

test('resolution order is stored preference, then profile, then environment, then default', async () => {
  const env = await tempEnv('order');
  // Environment only.
  const workspace = '11111111-1111-4111-8111-111111111111';
  const fromEnv = resolveHostConfig({}, { ...env, MNEMOWEAVE_SERVER: 'http://127.0.0.1:5555', MNEMOWEAVE_HOST_ID: 'env-host', MNEMOWEAVE_WORKSPACE_ID: workspace });
  assert.equal(fromEnv.serverUrl, 'http://127.0.0.1:5555');
  assert.equal(fromEnv.hostId, 'env-host');
  assert.equal(fromEnv.workspaceId, workspace);
  assert.equal(fromEnv.sources.serverUrl, 'environment');

  // A profile value wins over the environment.
  const other = '22222222-2222-4222-8222-222222222222';
  const fromProfile = resolveHostConfig({ serverUrl: 'http://127.0.0.1:6666', hostId: 'profile-host', workspaceId: other }, { ...env, MNEMOWEAVE_SERVER: 'http://127.0.0.1:5555', MNEMOWEAVE_HOST_ID: 'env-host' });
  assert.equal(fromProfile.serverUrl, 'http://127.0.0.1:6666');
  assert.equal(fromProfile.hostId, 'profile-host');
  assert.equal(fromProfile.workspaceId, other);
  assert.equal(fromProfile.sources.serverUrl, 'profile');
  assert.equal(fromProfile.sources.workspaceId, 'profile');

  // The retired project variables no longer name a scope; only the workspace binding is read.
  const legacy = resolveHostConfig({}, { ...env, MNEMOWEAVE_PROJECT_ID: 'legacy-project' });
  assert.equal(legacy.workspaceId, undefined);

  // The stored preference wins over both for the Host identity.
  writePreferences({ hostId: 'pref-host' }, env);
  const fromPreference = resolveHostConfig({ hostId: 'profile-host' }, env);
  assert.equal(fromPreference.hostId, 'pref-host');
  assert.equal(fromPreference.sources.hostId, 'preference');

  // Nothing configured falls back to the defaults.
  const absent = await tempDir('host-config', 'absent');
  const bare = resolveHostConfig({}, { MNEMOWEAVE_DSH_SETTINGS: join(absent, 'settings.json') } as NodeJS.ProcessEnv);
  assert.equal(bare.serverUrl, DEFAULT_SERVER_URL);
  assert.equal(bare.hostId, 'dsh');
  assert.equal(bare.injectTimeoutMs, DEFAULT_INJECT_TIMEOUT_MS);
  assert.equal(bare.sources.serverUrl, 'default');
});

test('a non-loopback address is rejected instead of being sent the service token', async () => {
  const env = await tempEnv('loopback');
  for (const serverUrl of ['http://example.com:4317', 'https://10.0.0.5:4317', 'http://169.254.1.1']) {
    assert.throws(() => resolveHostConfig({ serverUrl }, env), /loopback/);
  }
  // Loopback forms are all accepted.
  for (const serverUrl of ['http://127.0.0.1:4317', 'http://localhost:4317', 'http://[::1]:4317']) {
    assert.equal(resolveHostConfig({ serverUrl }, env).serverUrl, serverUrl);
  }
});

test('the token value never appears in what the page can read', async () => {
  const env = await tempEnv('token');
  const resolved = resolveHostConfig({ token: TOKEN }, env);
  const description = describeHostConfig(resolved);
  const serialized = JSON.stringify(description);
  assert.equal(serialized.includes(TOKEN), false, 'the token must not be serialized');
  assert.equal(description.tokenStatus.configured, true);
  assert.equal(description.tokenStatus.source, 'profile');

  // A short token is reported as unusable rather than silently accepted.
  const short = describeHostConfig(resolveHostConfig({ token: 'short' }, env));
  assert.equal(short.tokenStatus.configured, false);
});

test('preferences reject bad values and unknown keys instead of clamping silently', async () => {
  assert.deepEqual(validatePreferences({ pageSize: 25 }), { pageSize: 25 });
  assert.throws(() => validatePreferences({ pageSize: 2 }), /pageSize/);
  assert.throws(() => validatePreferences({ pageSize: 999 }), /pageSize/);
  assert.throws(() => validatePreferences({ defaultTab: 'nope' }), /defaultTab/);
  // Sync is a settings section now; an old preference follows it instead of failing every read.
  assert.deepEqual(validatePreferences({ defaultTab: 'sync' }), { defaultTab: 'settings' });
  // Scope is retired with the global memory model: a stored value is dropped, not rejected.
  assert.deepEqual(validatePreferences({ defaultScope: 'everything' }), {});
  // The retired project binding is dropped as well; an unknown key still fails.
  assert.throws(() => validatePreferences({ projectId: 'old-project' }), /unknown preference/);
  // A workspace binding is a UUID or null; anything else is refused.
  assert.deepEqual(validatePreferences({ workspaceId: '11111111-1111-4111-8111-111111111111' }), { workspaceId: '11111111-1111-4111-8111-111111111111' });
  assert.throws(() => validatePreferences({ workspaceId: 'not-a-uuid' }), /workspaceId/);
  // The injection budget is part of the turn deadline, so the upper bound is enforced.
  assert.throws(() => validatePreferences({ injectTimeoutMs: 5_000 }), /injectTimeoutMs/);
  assert.throws(() => validatePreferences({ injectTimeoutMs: 10 }), /injectTimeoutMs/);
  assert.deepEqual(validatePreferences({ injectTimeoutMs: 1_200 }), { injectTimeoutMs: 1_200 });
  assert.throws(() => validatePreferences({ autoStart: 'yes' }), /autoStart/);
  assert.throws(() => validatePreferences({ surprise: 1 }), /unknown preference/);
});

test('a saved connection is what the injection hook resolves too', async () => {
  const env = await tempEnv('connection');
  const service = new SettingsService({
    entryConfig: { token: TOKEN, serverUrl: 'http://127.0.0.1:4317', hostId: 'dsh' },
    env,
    probe: async () => ({ ok: true, reason: 'ok' as const }),
  });
  await service.saveConnection({ serverUrl: 'http://127.0.0.1:4517', hostId: 'dsh-work' });

  // The page sees it immediately...
  assert.equal(service.settings().connection.serverUrl, 'http://127.0.0.1:4517');
  // ...and so does the hook, which resolves independently from the same file. Before this was
  // stored, the page used the new address while injection kept the old one until DSH restarted.
  const hookView = resolveHostConfig({ token: TOKEN }, env, readPreferences(env));
  assert.equal(hookView.serverUrl, 'http://127.0.0.1:4517');
  assert.equal(hookView.hostId, 'dsh-work');
  assert.equal(hookView.sources.serverUrl, 'preference');

  // Saving another group must not drop the connection: it is read back from the file.
  service.saveInjection({ injectTimeoutMs: 800 });
  const afterOtherGroup = resolveHostConfig({ token: TOKEN }, env, readPreferences(env));
  assert.equal(afterOtherGroup.serverUrl, 'http://127.0.0.1:4517', 'an unrelated save keeps the connection');
});

test('a non-loopback connection is never stored', async () => {
  const env = await tempEnv('connection-guard');
  const service = new SettingsService({
    entryConfig: { token: TOKEN, serverUrl: 'http://127.0.0.1:4317', hostId: 'dsh' },
    env,
    probe: async () => ({ ok: true, reason: 'ok' as const }),
  });
  await assert.rejects(service.saveConnection({ serverUrl: 'http://10.0.0.8:4317' }), /loopback/);
  // Nothing was written, so both halves still resolve the original address.
  assert.equal(readPreferences(env).serverUrl, null);
});

test('only a refused connection wakes the local Server, and only when auto-start is on', async () => {
  const base = { serverUrl: 'http://127.0.0.1:4317', token: TOKEN, hostId: 'dsh' };
  let started = 0;
  const runTask = async () => { started += 1; };
  const refused = async () => { const error = new Error('fetch failed'); (error as { cause?: unknown }).cause = { code: 'ECONNREFUSED' }; throw error; };

  // Refused + auto-start on: exactly one wake, then the probe succeeds.
  let calls = 0;
  const woken = await ensureReachable({
    ...base, runTask,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return refused();
      return { ok: true, status: 200 };
    },
  });
  assert.equal(woken.ready, true);
  assert.equal(woken.woken, true);
  assert.equal(started, 1, 'the task is started once');

  // Refused but auto-start off: nothing is started.
  started = 0;
  const off = await ensureReachable({
    ...base, autoStart: false, runTask,
    fetchImpl: async () => refused(),
  });
  assert.equal(off.ready, false);
  assert.equal(started, 0, 'a disabled auto-start must not start anything');

  // A timeout is not a refusal: starting the task would not help and could duplicate a Server.
  started = 0;
  const timedOut = await ensureReachable({
    ...base, runTask,
    fetchImpl: async () => { const error = new Error('timed out'); (error as { cause?: unknown }).cause = { code: 'ETIMEDOUT' }; throw error; },
  });
  assert.equal(timedOut.ready, false);
  assert.equal(started, 0, 'only ECONNREFUSED may wake the task');

  // A reachable Server is never disturbed.
  started = 0;
  const already = await ensureReachable({ ...base, runTask, fetchImpl: async () => ({ ok: true, status: 200 }) });
  assert.equal(already.ready, true);
  assert.equal(already.woken, false);
  assert.equal(started, 0);
});

test('a wake that never becomes ready reports the timeout instead of blocking the turn', async () => {
  const started = Date.now();
  const result = await ensureReachable({
    serverUrl: 'http://127.0.0.1:4317', token: TOKEN, hostId: 'dsh',
    budgetMs: 300,
    runTask: async () => undefined,
    fetchImpl: async () => { const error = new Error('refused'); (error as { cause?: unknown }).cause = { code: 'ECONNREFUSED' }; throw error; },
  });
  assert.equal(result.ready, false);
  assert.equal(result.woken, true);
  // The budget is a ceiling: the injection path must still get its turn.
  assert.ok(Date.now() - started < 2_000, 'the wake respects its budget');
});

test('a rejected connection leaves the previous client in use', async () => {
  const env = await tempEnv('reject');
  let switched = 0;
  const service = new SettingsService({
    entryConfig: { token: TOKEN, serverUrl: 'http://127.0.0.1:4317', hostId: 'dsh' },
    env,
    // Every candidate address is refused.
    probe: async () => ({ ok: false, reason: 'connection_refused' as const, detail: 'nothing is listening' }),
    onConnection: () => { switched += 1; },
  });
  const before = service.snapshot;
  await assert.rejects(
    service.saveConnection({ serverUrl: 'http://127.0.0.1:4999', hostId: 'other' }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_INPUT',
  );
  assert.equal(service.snapshot, before, 'the snapshot must not change on a failed save');
  assert.equal(switched, 0, 'no connection change is announced');

  // A tested address does switch, and announces it exactly once.
  const accepted = new SettingsService({
    entryConfig: { token: TOKEN, serverUrl: 'http://127.0.0.1:4317', hostId: 'dsh' },
    env,
    probe: async () => ({ ok: true, reason: 'ok' as const }),
    onConnection: () => { switched += 1; },
  });
  const previous = accepted.snapshot;
  const settings = await accepted.saveConnection({ serverUrl: 'http://127.0.0.1:4998', hostId: 'other' });
  assert.notEqual(accepted.snapshot, previous, 'a validated connection replaces the old one');
  assert.equal(switched, 1);
  assert.equal(settings.connection.serverUrl, 'http://127.0.0.1:4998');
  assert.equal(settings.connection.hostId, 'other');
});

test('the page and the injection hook read the same saved values', async () => {
  const env = await tempEnv('shared');
  const service = new SettingsService({
    entryConfig: { token: TOKEN, serverUrl: 'http://127.0.0.1:4317', hostId: 'dsh' },
    env,
    probe: async () => ({ ok: true, reason: 'ok' as const }),
  });
  service.saveInjection({ injectTimeoutMs: 900 });
  const pageView = service.settings();
  // The hook resolves independently, from the same file.
  const hookView = resolveHostConfig({ token: TOKEN }, env, readPreferences(env));
  // The workspace binding is the one scope an injection setting carries, and both halves agree.
  assert.equal(pageView.injection.workspaceId ?? null, hookView.workspaceId ?? null);
  assert.equal(pageView.injection.injectTimeoutMs, hookView.injectTimeoutMs);
  assert.equal(hookView.injectTimeoutMs, 900);
});

test('preferences survive a restart through the stored file', async () => {
  const env = await tempEnv('persist');
  writePreferences({ defaultTab: 'memories', pageSize: 40, hostId: 'pref-host' }, env);
  // A fresh read stands in for a DSH restart.
  const reloaded = readPreferences(env);
  assert.equal(reloaded.defaultTab, 'memories');
  assert.equal(reloaded.hostId, 'pref-host');
  assert.equal(reloaded.pageSize, 40);
  // The file holds only preferences; no credential is written.
  const raw = readFileSync(reloaded.path, 'utf8');
  assert.equal(raw.includes('token'), false);
  assert.equal(raw.includes(TOKEN), false);
});

test('a corrupt preference file falls back to defaults instead of breaking the page', async () => {
  const env = await tempEnv('corrupt');
  writePreferences({ pageSize: 30 }, env);
  const path = readPreferences(env).path;
  // Truncate to something unparsable, as a crash mid-write would.
  writeFileSync(path, '{ not json');
  const recovered = readPreferences(env);
  assert.equal(recovered.pageSize, 25);
  assert.equal(recovered.defaultTab, 'overview');
});


test('the registration action is delegated and never runs during a probe', async () => {
  const env = await tempEnv('register');
  let calls = 0;
  const service = new SettingsService({
    entryConfig: { token: TOKEN, serverUrl: 'http://127.0.0.1:4317', hostId: 'dsh' },
    env,
    probe: async () => ({ ok: true, reason: 'ok' as const }),
    registerTask: async () => { calls += 1; return { result: 'registered' as const }; },
  });
  assert.equal(calls, 0, 'constructing the service or probing must not raise a prompt');
  assert.deepEqual(await service.registerTask(), { result: 'registered' });
  assert.equal(calls, 1, 'each press asks the injected action exactly once');
});
