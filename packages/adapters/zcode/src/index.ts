import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { HostEvent } from '../../../core/contracts/src/index.ts';
import type { HostEventRecord } from '../../../core/contracts/src/index.ts';
import { unverifiedDescriptor, validateDescriptor } from '../../shared-sdk/src/descriptor.ts';
import type { AdapterDescriptor } from '../../shared-sdk/src/descriptor.ts';

/**
 * ZCode adapter (WP7). Entry contracts verified against the installed ZCode Desktop
 * 3.17.2.9661 configuration guide: seven hook events, `hooks.enabled: true` gate,
 * `additionalContext` stdout injection, `mcp.servers` auto-connect at both scopes.
 *
 * Upstream correction (2026-11-08, zcode.z.ai/cn/docs/hooks): the Stop hook's stdin
 * payload CARRIES `last_assistant_message` — the assistant's final reply text. The
 * earlier "assistant.final missing" gap assessment was wrong and is superseded: Stop
 * maps to message.assistant.final. Remaining smaller gap: no dedicated session-end
 * event on ZCode (Stop fires per turn, not per session).
 */

/** Installed-version facts recorded during HOST-01 verification (2026-11-08). */
export const ZCODE_HOST_FACTS = {
  product: 'ZCode' as const,
  desktopVersion: '3.17.2.9661',
  configGuideEvidence: 'installed zcode-configuration-guide skill (user scope config paths, seven hook events, additionalContext injection, mcp.servers auto-connect)',
  hookEvents: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Stop'] as const,
  assistantFinalEntry: 'Stop hook stdin carries last_assistant_message (upstream docs, 2026-11-08) — mapped to message.assistant.final',
  sessionEndEntry: 'missing: no dedicated session-end event; Stop fires per turn — registered as the remaining ZCode gap',
};

const HookInput = z.object({
  session_id: z.string().min(1),
  hook_event_name: z.enum(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Stop']),
  event_id: z.string().optional(),
  turn_id: z.string().optional(),
  prompt: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.record(z.string(), z.unknown()).optional(),
  tool_response: z.unknown().optional(),
  last_assistant_message: z.string().optional(),
}).passthrough();

export type ZCodeHookInput = z.infer<typeof HookInput>;

export interface HandlerOptions {
  /** Absolute server base URL for intent intake (/v1/sync/intents). */
  serverUrl: string;
  token: string;
  hostId: string;
  projectId?: string;
  bridgeUrl?: string;
  bridgeToken?: string;
  /** Monotonic foreground deadline for the additionalContext assembly (HOST-06). */
  deadlineMs?: number;
  /** Async recall used to build the injected context; wired to Bridge/Server recall. */
  recallAndAssemble: (query: string | null, context?: InjectionContext) => Promise<{ text: string; viewId: string } | undefined>;
}

/** Session/turn identity for Bridge-hosted injection (HOST-05 trigger selection). */
export interface InjectionContext {
  sessionId: string;
  turnId: string;
  trigger: 'session_started' | 'message_user' | 'tool_failure';
}

/**
 * Normalizes one hook invocation into the MnemoWeave event envelope (HOST-03) and
 * forwards it to the Server intent endpoint; identity comes from the paired grant.
 */
export function normalizeHookEvent(input: ZCodeHookInput, receivedAt: string): HostEventRecord {
  const base = {
    protocolVersion: '1', adapterVersion: '0.1.0',
    eventId: input.event_id ?? `zcode-${createHash('sha256').update(JSON.stringify([input.session_id, input.turn_id ?? receivedAt, input.hook_event_name, input.prompt, input.tool_name, input.tool_response])).digest('hex')}`,
    sessionId: input.session_id, ...(input.turn_id ? { turnId: input.turn_id } : {}), receivedAt,
    occurredAt: receivedAt,
    sourceRef: `zcode-hook:${input.hook_event_name}`,
    payload: {} as HostEventRecord['payload'],
  };
  let shaped: Record<string, unknown>;
  switch (input.hook_event_name) {
    case 'SessionStart': shaped = { kind: 'session.started' }; break;
    case 'Stop': shaped = { kind: 'message.assistant.final', payload: { text: input.last_assistant_message ?? '' } }; break;
    case 'UserPromptSubmit': shaped = { kind: 'message.user', payload: { text: input.prompt ?? '' } }; break;
    case 'PostToolUse': shaped = { kind: 'tool.completed', payload: { toolName: input.tool_name ?? 'unknown', outcome: 'success' } }; break;
    case 'PostToolUseFailure': shaped = { kind: 'tool.completed', payload: { toolName: input.tool_name ?? 'unknown', outcome: 'failure' } }; break;
    default: shaped = { kind: 'session.started' }; // PermissionRequest carries no required event
  }
  return HostEvent.parse({ ...base, ...shaped }) as HostEventRecord;
}

export async function forwardEvent(options: HandlerOptions, event: HostEventRecord): Promise<void> {
  const response = await fetch(options.bridgeUrl ? `${options.bridgeUrl}/v1/events` : `${options.serverUrl}/v1/sync/intents`, {
    method: 'POST',
    headers: { authorization: `Bearer ${options.bridgeUrl ? options.bridgeToken ?? options.token : options.token}`, 'x-mnemoweave-host': options.hostId, 'content-type': 'application/json' },
    body: JSON.stringify(options.bridgeUrl ? event : { intentId: event.eventId, kind: 'event', payload: event }),
    signal: AbortSignal.timeout(Math.min(800, options.deadlineMs ?? 2000)),
  });
  if (!response.ok) throw new Error(`intent intake failed: HTTP ${response.status}`);
}

/**
 * SessionStart / UserPromptSubmit handler: within the HOST-06 deadline, recall the
 * local-first context and emit `{ additionalContext }` — the installed ZCode's
 * supported automatic injection entry. Deadline misses emit nothing (HOST-04).
 */
export async function injectContext(options: HandlerOptions, query: string | null, turnId: string, context?: InjectionContext): Promise<{ additionalContext: string } | undefined> {
  const deadline = Date.now() + (options.deadlineMs ?? 2_000);
  const assembled = await Promise.race([
    options.recallAndAssemble(query, context),
    new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now()))),
  ]);
  if (assembled === undefined) return undefined; // explicit miss; ordinary tasks continue
  return { additionalContext: `[MnemoWeave view ${assembled.viewId} @ turn ${turnId}]\n${assembled.text}` };
}

const WorkspaceHookEvents = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop'] as const;

/**
 * Generates the workspace `.zcode/config.json` hooks block for the installed ZCode:
 * `hooks.enabled: true` (required), process-type handlers without a shell, and the
 * 2-second-class timeout budget so a dead Bridge never stalls the session for long.
 */
export function zcodeWorkspaceHooks(handlerCommand: string, options: { timeoutMs?: number; toolMatcher?: string } = {}): { enabled: true; timeoutMs: number; events: Record<string, unknown> } {
  const timeoutMs = options.timeoutMs ?? 2_500;
  const hook = { type: 'process', command: handlerCommand, timeoutMs, statusMessage: 'MnemoWeave memory adapter' };
  const events: Record<string, unknown> = {};
  for (const event of WorkspaceHookEvents) {
    const entry = event === 'PostToolUse' || event === 'PostToolUseFailure'
      ? { matcher: options.toolMatcher ?? '.*', hooks: [hook] }
      : { hooks: [hook] };
    events[event] = [entry];
  }
  return { enabled: true, timeoutMs, events };
}

/** Reads the workspace config (if any), merges the hooks block, and writes it back. */
export function installWorkspaceHooks(workspaceDir: string, handlerCommand: string, options: { timeoutMs?: number } = {}): { configPath: string; hooks: unknown } {
  const normalized = join(workspaceDir, '.zcode', 'config.json');
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(readFileSync(normalized, 'utf8')) as Record<string, unknown>; } catch { /* fresh workspace config */ }
  const hooks = zcodeWorkspaceHooks(handlerCommand, options);
  config['hooks'] = hooks;
  mkdirSync(dirname(normalized), { recursive: true });
  writeFileSync(normalized, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { configPath: normalized, hooks };
}

function readExists(path: string): boolean {
  try { readFileSync(path); return true; } catch { return false; }
}

/**
 * MCP registration for the installed ZCode: `mcp.servers` in the same workspace config;
 * servers from every scope auto-connect at session start (verified config contract).
 */
export function installWorkspaceMcp(workspaceDir: string, serverName: string, command: string, args: string[], env: Record<string, string>): { configPath: string; server: unknown } {
  const normalized = join(workspaceDir, '.zcode', 'config.json');
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(readFileSync(normalized, 'utf8')) as Record<string, unknown>; } catch { /* fresh workspace config */ }
  const servers = (config['mcp'] as { servers?: Record<string, unknown> } | undefined)?.servers ?? {};
  servers[serverName] = { command, args, env };
  config['mcp'] = { servers };
  mkdirSync(dirname(normalized), { recursive: true });
  writeFileSync(normalized, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { configPath: normalized, server: servers[serverName] };
}

/**
 * HOST-01 capability declaration. Everything is `unverified` until a live ZCode session
 * runs the handler; the assistant-final gap is structural and recorded as blocking.
 */
export function zcodeDescriptor(): AdapterDescriptor {
  const evidence = `${ZCODE_HOST_FACTS.configGuideEvidence}; desktop ${ZCODE_HOST_FACTS.desktopVersion}`;
  const descriptor = unverifiedDescriptor('ZCode', ZCODE_HOST_FACTS.desktopVersion, '0.1.0', evidence, '2026-11-08');
  descriptor.capabilities.context_injection.evidence = `${evidence}; entry = SessionStart/UserPromptSubmit additionalContext`;
  descriptor.capabilities.message_events.evidence = `${evidence}; entries = UserPromptSubmit (user), PostToolUse/PostToolUseFailure (tools)`;
  descriptor.capabilities.message_events.status = 'unverified';
  validateDescriptor(descriptor);
  return descriptor;
}

/** CLI shim for the hook process entry: reads one invocation from stdin and reacts. */
export function runHookStdin(options: HandlerOptions): void {
  const raw = readFileSync(0, 'utf8');
  let parsed: ZCodeHookInput;
  try { parsed = HookInput.parse(JSON.parse(raw)); } catch { process.exit(1); }
  const normalized = normalizeHookEvent(parsed, new Date().toISOString());
  const event = HostEvent.parse({ ...normalized, ...(options.projectId ? { projectId: options.projectId } : {}) });
  const started = performance.now();
  void (async () => {
    await forwardEvent(options, event).catch(() => undefined);
    if (!['session.started', 'message.user'].includes(event.kind) && !(event.kind === 'tool.completed' && event.payload.outcome === 'failure')) return;
    const remaining = (options.deadlineMs ?? 2000) - (performance.now() - started);
    if (remaining <= 0) return;
    const context: InjectionContext = {
      sessionId: parsed.session_id, turnId: parsed.turn_id ?? event.eventId,
      trigger: event.kind === 'session.started' ? 'session_started' : event.kind === 'tool.completed' ? 'tool_failure' : 'message_user',
    };
    const query = event.kind === 'message.user' ? (parsed.prompt ?? '').slice(0, 2000) : null;
    const output = await injectContext({ ...options, deadlineMs: remaining }, query, context.turnId, context);
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  })().then(() => process.exit(0)).catch(() => process.exit(0));
}
