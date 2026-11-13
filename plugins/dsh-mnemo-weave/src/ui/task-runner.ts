import { randomUUID } from 'node:crypto';
import { idleActivityScore } from '../../../../packages/core/application/src/idle-review.ts';

type Route = { provider?: string; model?: string; reasoningEffort?: string };
interface SessionEvent { type: string; time?: number; data: Record<string, unknown> }
interface AgentContext {
  tools?: { restrict(filter: { allow: string[] }): unknown; get?(name: string, agent: Agent): unknown };
  get?(name: string): unknown;
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
  completedReply?(sessionId: string, replyId: string): { text: string; turnId: string } | null;
  idleSession?(sessionId: string, afterMs: number): {
    turn: number; score: number; active: boolean; paused: boolean;
    abortOnTurn(controller: AbortController): () => void;
  } | undefined;
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
    completedReply: (sessionId: string, replyId: string) => {
      const agent = roots(getAgents() as Agents | undefined).find(item => item.id === sessionId);
      const events = agent?.session.snapshotEvents?.() ?? [];
      let turn: number | undefined;
      let reply: { text: string; turnId: string } | null = null;
      for (const event of events) {
        if (event.type === 'turn/start' && typeof event.data['turn'] === 'number') turn = event.data['turn'];
        if (event.type === 'assistant/message' && turn !== undefined) {
          const message = event.data['message'] as { id?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
          if (message?.id === replyId) {
            const text = (message.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n\n').trim();
            if (text) reply = { text, turnId: String(turn) };
          }
        }
        if (event.type === 'turn/end' && event.data['turn'] === turn) {
          if (reply?.turnId === String(turn)) return reply;
          turn = undefined;
        }
      }
      return null;
    },
    idleSession: (sessionId: string, afterMs: number) => {
      const agent = roots(getAgents() as Agents | undefined).find(item => item.id === sessionId);
      const events = agent?.session.snapshotEvents?.();
      if (!agent || !events) return undefined;
      let turn = 0;
      let active = false;
      const excluded = new Set(events.filter(event => event.type === 'turn/no-retention' || event.type === 'turn/noRetention')
        .map(event => event.data['turn']));
      const userTexts: string[] = [];
      const tools: string[] = [];
      let completedTurns = 0;
      let currentTurn = 0;
      for (const event of events) {
        const value = event.data['turn'];
        if (event.type === 'turn/start') { active = true; if (typeof value === 'number') currentTurn = value; }
        if (event.type === 'turn/end') { active = false; if (typeof value === 'number') turn = value; }
        if ((event.time !== undefined && event.time <= afterMs) || excluded.has(value ?? currentTurn)) continue;
        if (event.type === 'turn/end') completedTurns++;
        if (event.type === 'tool/call' && typeof event.data['name'] === 'string') tools.push(event.data['name']);
        const source = event.data['source'] as { kind?: string } | undefined;
        if (event.type === 'user/message' && source?.kind === 'user' && Array.isArray(event.data['content'])) {
          userTexts.push(event.data['content'].map(block => block?.type === 'text' && typeof block.text === 'string' ? block.text : '').join(''));
        }
      }
      const team = agent.ctx.get?.('agentTeams') as { isEnabled?(agent: Agent): boolean } | undefined;
      return {
        turn, active, paused: team !== undefined && (agent.ctx.tools?.get?.('spawn_teammate', agent) !== undefined
          || (team.isEnabled?.(agent) === true && agent.ctx.tools?.get?.('team_task_create', agent) !== undefined)),
        score: idleActivityScore({ userTexts, completedTurns, toolCalls: tools.length, toolKinds: new Set(tools).size }),
        abortOnTurn(controller: AbortController) {
          const off = agent.ctx.on('session/event', (session, event) => {
            if (session === agent.session && ['turn/start', 'turn/no-retention', 'turn/noRetention'].includes(event.type)) controller.abort();
          });
          return () => { if (typeof off === 'function') off(); };
        },
      };
    },
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
