import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatgptDescriptor, chatgptHooksJson, chatgptMcpConfig, normalizeChatgptHook } from '../../packages/adapters/chatgpt/src/index.ts';

test('ChatGPT local hook configuration uses arrays and leaves cloud orchestration explicitly unsupported', () => {
  const config = JSON.parse(chatgptHooksJson('node project-hook.js', 'local-only')) as { hooks: Record<string, { hooks: unknown[] }[]> };
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']) assert.ok(Array.isArray(config.hooks[event]![0]!.hooks));
  assert.throws(() => chatgptHooksJson('node project-hook.js', 'cloud'), /REVIEW_REQUIRED/);
  assert.equal(chatgptDescriptor().gatesMet, false);
  const toml = chatgptMcpConfig('node', ['C:\\project\\mcp.js'], { MNEMOWEAVE_HOST_ID: 'chatgpt-host', MNEMOWEAVE_TOKEN: 'fixture-only-01234567890123456789' });
  assert.equal((toml.match(/env = /g) ?? []).length, 1);
  assert.ok(toml.includes('C:\\\\project\\\\mcp.js'));
});

test('ChatGPT event mapping preserves SessionEnd and refuses to invent successful tool outcomes', () => {
  const base = { session_id: 'desktop-session', turn_id: 'desktop-turn' };
  assert.equal(normalizeChatgptHook({ ...base, hook_event_name: 'SessionEnd' }).kind, 'session.ended');
  assert.equal(normalizeChatgptHook({ ...base, hook_event_name: 'Stop', last_assistant_message: 'Final reply' }).payload.text, 'Final reply');
  assert.equal(normalizeChatgptHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { exit_code: 1 } }).payload.outcome, 'failure');
  assert.throws(() => normalizeChatgptHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: 'unknown format' }), /REVIEW_REQUIRED/);
});
