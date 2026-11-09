import { readFileSync } from 'node:fs';
import { unverifiedDescriptor, validateDescriptor } from '../../shared-sdk/src/descriptor.ts';
import type { AdapterDescriptor } from '../../shared-sdk/src/descriptor.ts';

/**
 * Codex adapter (WP7). Facts verified on this machine during HOST-01 (2026-11-08):
 * codex-cli 0.148.0 (`@openai/codex@0.148.0` npm global), `codex mcp add/list/get/remove`
 * client management, `codex mcp-server` stdio mode, the `notify` hook present in the live
 * `~/.codex/config.toml`, and the `hooks` feature reported `stable, enabled=true` by
 * `codex features list`.
 *
 * Real-session verification (2026-11-08, isolated CODEX_HOME + `codex exec --json`,
 * see host-acceptance/codex.md): hooks.json with Claude-Code-style event names fired in a
 * live session and delivered real payloads — SessionStart(source), UserPromptSubmit(turn_id,
 * prompt), PostToolUse(tool_name, tool_input, tool_response), Stop(last_assistant_message),
 * SessionEnd(reason). The hook handler emitted additionalContext on UserPromptSubmit and the
 * model's final reply was exactly the injected marker — automatic injection verified end-to-end.
 */
export const CODEX_HOST_FACTS = {
  product: 'Codex' as const,
  cliVersion: '0.148.0',
  evidence: [
    'codex mcp add/list/get/remove verified present in `codex mcp --help`',
    'codex mcp-server (stdio) verified present in `codex --help`',
    'notify hook verified live in ~/.codex/config.toml (turn-ended)',
    '`codex features list`: hooks = stable, enabled',
    'real-session hook payloads captured 2026-11-08: SessionStart/UserPromptSubmit/PostToolUse/Stop(last_assistant_message)/SessionEnd',
    'additionalContext injection verified end-to-end: the final reply was exactly the injected marker',
    'binary enum also contains pre_tool_use/permission_request/pre_compact/post_compact/subagent_* and a success field on post_tool_use (failure semantics via the flag)',
  ],
  remaining: [
    "post_tool_use failure-flag capture: the live run's model skipped the failing command (field evidence from the binary); retry in a session that exercises a failing tool",
    'live pairing/revocation recheck inside a running Codex session (contract-level tests cover the endpoints)',
  ],
};

/** Generates the config.toml lines that register the MnemoWeave MCP server for Codex. */
export function codexMcpServerBlock(serverName: string, command: string, args: string[], env: Record<string, string>): string {
  const envLines = Object.entries(env).map(([key, value]) => `env = { ${key} = "${value.replace(/"/g, '\\"')}" }`);
  const argsToml = `[${args.map(arg => `"${arg.replace(/"/g, '\\"')}"`).join(', ')}]`;
  return [
    `[mcp_servers.${serverName}]`,
    `command = "${command.replace(/"/g, '\\"')}"`,
    `args = ${argsToml}`,
    ...envLines,
  ].join('\n');
}

/**
 * Generates the hooks.json content for an isolated CODEX_HOME: Claude-Code-style event
 * names were verified live (hooks fired and delivered the payloads above).
 */
export function codexHooksJson(handlerCommand: string, options: { timeoutMs?: number } = {}): string {
  const hook = { type: 'command', command: handlerCommand, ...(options.timeoutMs !== undefined ? { timeout: Math.ceil(options.timeoutMs / 1000) } : {}) };
  const wrap = (hooks: unknown) => [{ hooks }];
  return `${JSON.stringify({
    hooks: {
      SessionStart: wrap(hook),
      UserPromptSubmit: wrap(hook),
      PostToolUse: [{ matcher: '.*', hooks: [hook] }],
      Stop: wrap(hook),
      SessionEnd: wrap(hook),
    },
  }, null, 2)}
`;
}

/**
 * Generates the notify hook entry for turn-end event forwarding. Applied only by the
 * operator (it edits the live config.toml); the adapter never mutates a user config
 * on its own (AUTH-04 spirit: pairing and host wiring are user-confirmed actions).
 */
export function codexNotifyEntry(notifyCommand: string, event: string = 'turn-ended'): string {
  return `notify = [ "${notifyCommand.replace(/\\/g, '\\\\')}", "${event}" ]`;
}

/** Reads the live Codex config and reports whether MnemoWeave is registered. */
export function codexRegistrationStatus(configPath: string, serverName: string): { configFound: boolean; mcpRegistered: boolean; notifyConfigured: boolean } {
  let text: string;
  try { text = readFileSync(configPath, 'utf8'); } catch { return { configFound: false, mcpRegistered: false, notifyConfigured: false }; }
  return {
    configFound: true,
    mcpRegistered: text.includes(`[mcp_servers.${serverName}]`),
    notifyConfigured: /(^|\n)\s*notify\s*=/.test(text),
  };
}

/**
 * HOST-01 capability declaration after real-session verification: injection and event
 * collection are `supported` on the strength of the captured payloads; budget reporting
 * stays unverified (no budget hook observed).
 */
export function codexDescriptor(configPath: string, serverName: string): AdapterDescriptor {
  const evidence = `${CODEX_HOST_FACTS.evidence.join('; ')}; cli ${CODEX_HOST_FACTS.cliVersion}`;
  const descriptor = unverifiedDescriptor('Codex', CODEX_HOST_FACTS.cliVersion, '0.1.0', evidence, '2026-11-08');
  const registration = codexRegistrationStatus(configPath, serverName);
  descriptor.capabilities.tool_calls = {
    status: registration.mcpRegistered ? 'supported' : 'unverified',
    evidence: registration.mcpRegistered ? `${evidence}; MCP server registered in live config` : `${evidence}; registration pending`,
    verifiedAt: registration.mcpRegistered ? '2026-11-08' : null,
  };
  descriptor.capabilities.message_events = {
    status: 'supported',
    evidence: `${evidence}; real payloads: UserPromptSubmit(prompt), Stop(last_assistant_message), PostToolUse(tool_name/input/response), SessionEnd(reason)`,
    verifiedAt: '2026-11-08',
  };
  descriptor.capabilities.session_start = {
    status: 'supported',
    evidence: `${evidence}; SessionStart fired with session_id/model/permission_mode/source`,
    verifiedAt: '2026-11-08',
  };
  descriptor.capabilities.context_injection = {
    status: 'supported',
    evidence: `${evidence}; hookSpecificOutput.additionalContext on UserPromptSubmit — the final reply was exactly the injected marker`,
    verifiedAt: '2026-11-08',
  };
  descriptor.capabilities.dynamic_increment = {
    status: 'supported',
    evidence: `${evidence}; UserPromptSubmit increments deliver new context per turn`,
    verifiedAt: '2026-11-08',
  };
  validateDescriptor(descriptor);
  return descriptor;
}
