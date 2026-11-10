import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { normalize as normalizePath, resolve } from 'node:path';
import { normalizeHookEvent, injectContext, zcodeWorkspaceHooks, installWorkspaceHooks, installWorkspaceMcp, zcodeDescriptor, ZCODE_HOST_FACTS } from '../../packages/adapters/zcode/src/index.ts';
import { DSH_HOST_FACTS } from '../../packages/adapters/dsh/src/index.ts';
import type { HandlerOptions } from '../../packages/adapters/zcode/src/index.ts';

const hookInput = (event: string, extra: Record<string, unknown> = {}) => ({
  session_id: 'sess-zcode-1', hook_event_name: event, ...extra,
});

const handlerBase: HandlerOptions = {
  serverUrl: 'http://127.0.0.1:1', token: 'local-adapter-test-token-012345678', hostId: 'host-z',
  recallAndAssemble: async () => ({ text: 'context body', viewId: 'view-1' }),
};

test('ZCode hook normalization maps the verified event set onto the MnemoWeave envelope', () => {
  const receivedAt = new Date().toISOString();
  const session = normalizeHookEvent(hookInput('SessionStart') as never, receivedAt);
  assert.equal(session.kind, 'session.started');
  assert.equal(session.sessionId, 'sess-zcode-1');
  assert.equal(session.sourceRef, 'zcode-hook:SessionStart');
  const user = normalizeHookEvent(hookInput('UserPromptSubmit', { prompt: 'Fix the failing test' }) as never, receivedAt);
  assert.equal(user.kind, 'message.user');
  assert.equal(user.payload.text, 'Fix the failing test');
  const toolOk = normalizeHookEvent(hookInput('PostToolUse', { tool_name: 'Bash' }) as never, receivedAt);
  assert.equal(toolOk.kind, 'tool.completed');
  assert.deepEqual(toolOk.payload.outcome, 'success');
  const toolFail = normalizeHookEvent(hookInput('PostToolUseFailure', { tool_name: 'Bash' }) as never, receivedAt);
  assert.equal(toolFail.kind, 'tool.completed');
  assert.deepEqual(toolFail.payload.outcome, 'failure');
  const stop = normalizeHookEvent(hookInput('Stop', { last_assistant_message: 'final reply text' }) as never, receivedAt);
  assert.equal(stop.kind, 'message.assistant.final');
  assert.equal(stop.payload.text, 'final reply text');
});

test('ZCode additionalContext injection honors the HOST-06 deadline', async () => {
  const injected = await injectContext(handlerBase, 'Fix the failing test', 'turn-1');
  assert.ok(injected?.additionalContext.includes('context body'));
  assert.ok(injected?.additionalContext.includes('view-1'));
  const missed = await injectContext({ ...handlerBase, deadlineMs: 60, recallAndAssemble: () => new Promise<{ text: string; viewId: string }>(resolve => setTimeout(() => resolve({ text: 'late', viewId: 'view-2' }), 500)) }, 'anything', 'turn-2');
  assert.equal(missed, undefined, 'deadline miss emits nothing instead of blocking the session');
});

test('ZCode workspace config generation enables hooks and merges without losing state', async () => {
  const hooks = zcodeWorkspaceHooks('node dist/adapters/zcode-hook.js', { timeoutMs: 2_500 });
  assert.equal(hooks.enabled, true, 'configuration hooks are disabled by default and must be enabled');
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop']) {
    assert.ok(hooks.events[event], `missing hook registration for ${event}`);
  }
  const root = await mkdtemp(resolve('work/tests/zcode-'));
  const preExisting = join2(root, '.zcode', 'config.json');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join2(root, '.zcode'), { recursive: true });
  await writeFile(preExisting, JSON.stringify({ mcp: { servers: { existing: { command: 'keep' } } } }), 'utf8');
  const installed = installWorkspaceHooks(root, 'node dist/adapters/zcode-hook.js');
  const mcp = installWorkspaceMcp(root, 'mnemoweave', 'node', ['dist/apps/server/src/mcp-main.js'], { MNEMON_STORE: 'zcode' });
  const merged = JSON.parse(await readFile(mcp.configPath, 'utf8')) as { hooks: { enabled: boolean }; mcp: { servers: Record<string, unknown> } };
  assert.equal(merged.hooks.enabled, true);
  assert.equal(merged.mcp.servers.existing !== undefined, true, 'pre-existing servers survive the merge');
  assert.equal((merged.mcp.servers.mnemoweave as { command: string }).command, 'node');
  assert.equal(normalizePath(installed.configPath), normalizePath(preExisting));
  void hooks;
});

function join2(...parts: string[]): string { return parts.join('/').replace(/\/{2,}/g, '/'); }

test('HOST-01 records keep verification state honest per host', () => {
  // ZCode: the assistant-final gap was corrected by upstream docs — Stop carries the text.
  assert.equal(ZCODE_HOST_FACTS.assistantFinalEntry.includes('Stop hook stdin carries last_assistant_message'), true);
  assert.equal(ZCODE_HOST_FACTS.sessionEndEntry.includes('missing'), true, 'the remaining ZCode gap is the missing session-end event');
  const zcode = zcodeDescriptor();
  assert.equal(zcode.capabilities.context_injection.status, 'unverified');
  assert.equal(zcode.gatesMet, false, 'ZCode stays unverified until a live session runs the handler');
  assert.equal(DSH_HOST_FACTS.status, 'blocked', 'DSH stays blocked until an installed SDK/runtime can be verified');
});
