import { randomUUID } from 'node:crypto';

type Route = { provider?: string; model?: string; reasoningEffort?: string };
interface SessionEvent { type: string; data: Record<string, unknown> }
interface AgentContext {
  tools?: { restrict(filter: { allow: string[] }): unknown };
  on(name: 'session/event', listener: (session: unknown, event: SessionEvent) => void): unknown;
}
interface Agent {
  id: string;
  options?: Route;
  session: { header?: { cwd?: string; origin?: string }; requestHeader?(): { config?: Route }; snapshotEvents?(): readonly SessionEvent[] };
  ctx: AgentContext;
  followup(message: { id: string; role: 'user'; content: { type: 'text'; text: string }[]; source: { kind: string; plugin: string } }): void;
}
interface Agents {
  roots?(): Agent[];
  list?(): Agent[];
  create(options: {
    sessionId: string;
    meta: { cwd: string; origin: 'subagent' };
    agentOptions: Route;
    signal: AbortSignal;
    setup(ctx: AgentContext): void;
  }): Promise<{ agent: Agent; dispose(): Promise<void> }>;
}

function unavailable(message: string): never {
  throw Object.assign(new Error(message), { code: 'PROVIDER_UNAVAILABLE' });
}

type RunTask = (prompt: string, requestSignal?: AbortSignal) => Promise<unknown>;
export type TaskRunner = RunTask & {
  pin?(sessionId?: string): RunTask;
  conversations?(): { id: string; workspace: string }[];
  reviewEvidence?(sessionId: string): { step: number; role: 'user' | 'assistant'; text: string }[];
};

function redactEvidence(text: string): string {
  return text.replace(/(Bearer\s+)[^\s"',;]+/gi, '$1[redacted]')
    .replace(/((?:api[_ -]?key|token|password|secret)\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[redacted]')
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, '[redacted]');
}

export function createTaskRunner(getAgents: () => unknown): TaskRunner {
  const roots = (agents: Agents | undefined) => (agents?.roots?.() ?? agents?.list?.() ?? []).filter(agent =>
    agent.session.header?.origin !== 'subagent' && !agent.id.startsWith('mnemoweave-task-'));
  const pin = (sessionId?: string): RunTask => {
    const agents = getAgents() as Agents | undefined;
    const active = roots(agents).filter(agent => sessionId === undefined || agent.id === sessionId);
    const routes = active.flatMap(agent => {
      const route = agent.session.requestHeader?.()?.config ?? agent.options;
      return route?.provider && route.model ? [{ route, cwd: agent.session.header?.cwd ?? process.cwd() }] : [];
    });
    const selected = routes[0];
    if (!agents || typeof agents.create !== 'function' || !selected) unavailable('Open a DSH conversation with a configured model before running a memory task.');
    if (routes.some(({ route, cwd }) => cwd !== selected.cwd || route.provider !== selected.route.provider
      || route.model !== selected.route.model || route.reasoningEffort !== selected.route.reasoningEffort)) {
      unavailable('Open conversations use different workspaces or models. Close unrelated conversations before running this task.');
    }

    return async (prompt, requestSignal) => {
      const timeout = AbortSignal.timeout(60_000);
      const signal = requestSignal ? AbortSignal.any([timeout, requestSignal]) : timeout;
      let restricted = false;
      const handle = await agents.create({
        sessionId: `mnemoweave-task-${randomUUID()}`,
        meta: { cwd: selected.cwd, origin: 'subagent' },
        agentOptions: {
          provider: selected.route.provider!,
          model: selected.route.model!,
          ...(selected.route.reasoningEffort === undefined ? {} : { reasoningEffort: selected.route.reasoningEffort }),
        },
        signal,
        setup(ctx) {
          if (typeof ctx.tools?.restrict !== 'function') unavailable('This DSH version cannot restrict tools for a memory task.');
          ctx.tools.restrict({ allow: [] });
          restricted = true;
        },
      });
      try {
        if (!restricted) unavailable('DSH did not apply the task tool restriction.');
        signal.throwIfAborted();
        return await new Promise<unknown>((resolve, reject) => {
          const { agent } = handle;
          let text = '';
          let detach: unknown;
          const finish = (action: () => void) => {
            signal.removeEventListener('abort', abort);
            if (typeof detach === 'function') detach();
            action();
          };
          const abort = () => finish(() => reject(signal.reason));
          detach = agent.ctx.on('session/event', (session, event) => {
            if (session !== agent.session) return;
            if (event.type === 'assistant/message') {
              const message = event.data.message as { content?: { type: string; text?: string }[] } | undefined;
              text = message?.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n') ?? '';
            }
            if (event.type === 'turn/end') {
              finish(() => {
                try {
                  resolve(JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, '')));
                } catch {
                  reject(Object.assign(new Error('The task Agent returned no valid JSON result.'), { code: 'PROVIDER_PROTOCOL' }));
                }
              });
            }
          });
          signal.addEventListener('abort', abort, { once: true });
          try {
            signal.throwIfAborted();
            agent.followup({
              id: randomUUID(), role: 'user', content: [{ type: 'text', text: prompt }],
              source: { kind: 'plugin', plugin: 'dsh-mnemo-weave' },
            });
          } catch (error) { finish(() => reject(error)); }
        });
      } finally {
        await handle.dispose();
      }
    };
  };
  return Object.assign(async (prompt: string, signal?: AbortSignal) => pin()(prompt, signal), {
    pin,
    conversations: () => roots(getAgents() as Agents | undefined).map(agent => ({
      id: agent.id, workspace: agent.session.header?.cwd ?? process.cwd(),
    })),
    reviewEvidence: (sessionId: string) => {
      const agent = roots(getAgents() as Agents | undefined).find(item => item.id === sessionId);
      const events = agent?.session.snapshotEvents?.();
      if (!events) unavailable('The selected DSH conversation is unavailable.');
      const end = events.findLastIndex(event => event.type === 'turn/end');
      return events.slice(0, end + 1).slice(-160).flatMap((event, index) => {
        const role: 'user' | 'assistant' | null = event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant' : null;
        if (!role) return [];
        const source = event.data.source as { kind?: string } | undefined;
        if (role === 'user' && source?.kind !== 'user') return [];
        const message = event.data.message as { content?: unknown } | undefined;
        const content = role === 'user' ? event.data.content : message?.content;
        const text = Array.isArray(content) ? content.flatMap(block =>
          block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n').trim() : '';
        return text ? [{ step: index + 1, role, text: redactEvidence(text).slice(0, 1200) }] : [];
      }).slice(-24);
    },
  });
}
