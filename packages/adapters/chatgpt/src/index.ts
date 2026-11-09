import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HostEvent, MnemoWeaveError } from '../../../core/contracts/src/index.ts';
import { unverifiedDescriptor } from '../../shared-sdk/src/descriptor.ts';

export const CHATGPT_HOOKS_EVIDENCE = 'https://learn.chatgpt.com/docs/hooks';
export const ChatgptHook = z.object({
  session_id: z.string().min(1), turn_id: z.string().optional(), tool_use_id: z.string().optional(),
  hook_event_name: z.enum(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']),
  prompt: z.string().optional(), last_assistant_message: z.string().nullable().optional(),
  tool_name: z.string().optional(), tool_response: z.unknown().optional(),
}).passthrough();

/** No transcript scraping and no assumption that an unknown tool response means success. */
export function normalizeChatgptHook(input: unknown, projectId?: string) {
  const hook = ChatgptHook.parse(input);
  const now = new Date().toISOString();
  const base = { protocolVersion: '1', adapterVersion: '0.1.0', eventId: `chatgpt-${randomUUID()}`, sessionId: hook.session_id, ...(hook.turn_id ? { turnId: hook.turn_id } : {}), ...(projectId ? { projectId } : {}), occurredAt: now, receivedAt: now, sourceRef: `chatgpt-hook:${hook.hook_event_name}` };
  switch (hook.hook_event_name) {
    case 'SessionStart': return HostEvent.parse({ ...base, kind: 'session.started', payload: {} });
    case 'SessionEnd': return HostEvent.parse({ ...base, kind: 'session.ended', payload: {} });
    case 'UserPromptSubmit': return HostEvent.parse({ ...base, kind: 'message.user', payload: { text: hook.prompt ?? '' } });
    case 'Stop': return HostEvent.parse({ ...base, kind: 'message.assistant.final', payload: { text: hook.last_assistant_message ?? '' } });
    case 'PostToolUse': {
      const mcp = z.object({ isError: z.boolean() }).passthrough().safeParse(hook.tool_response);
      const process = z.object({ exit_code: z.number().int() }).passthrough().safeParse(hook.tool_response);
      const outcome = mcp.success ? mcp.data.isError ? 'failure' : 'success' : process.success ? process.data.exit_code === 0 ? 'success' : 'failure' : undefined;
      if (!outcome) throw new MnemoWeaveError('REVIEW_REQUIRED');
      return HostEvent.parse({ ...base, kind: 'tool.completed', payload: { toolName: hook.tool_name ?? 'unknown', outcome } });
    }
  }
}

/** Configuration artifact only; the Host's native trust review is still required. */
export function chatgptHooksJson(command: string, mode: 'local-only' | 'cloud'): string {
  if (mode !== 'local-only') throw new MnemoWeaveError('REVIEW_REQUIRED');
  const wrap = () => [{ hooks: [{ type: 'command', command, timeout: 2, additionalContextLimit: 4096 }] }];
  return JSON.stringify({ hooks: { SessionStart: wrap(), UserPromptSubmit: wrap(), PostToolUse: [{ matcher: '.*', ...wrap()[0] }], Stop: wrap(), SessionEnd: wrap() } }, null, 2);
}

export function chatgptMcpConfig(command: string, args: string[], env: Record<string, string>): string {
  if (Object.keys(env).some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) throw new MnemoWeaveError('INVALID_INPUT');
  return `[mcp_servers.mnemoweave]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\nenv = { ${Object.entries(env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(', ')} }\n`;
}

export function chatgptDescriptor(version = 'unverified') {
  return unverifiedDescriptor('ChatGPT', version, '0.1.0', `${CHATGPT_HOOKS_EVIDENCE}; local-only protocol implemented, desktop session and tool result variants unverified`);
}
