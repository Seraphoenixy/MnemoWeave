import { HostEvent, ViewRequest } from '../../../packages/core/contracts/src/index.ts';
import { z } from 'zod';
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { InjectionSessions } from '../../../packages/bridge/src/injection.ts';
import type { InjectionTrigger } from '../../../packages/adapters/shared-sdk/src/injection.ts';

const TRIGGERS: ReadonlySet<string> = new Set<InjectionTrigger>([
  'session_started', 'message_user', 'tool_failure', 'tool_important',
  'explicit_recall', 'budget_near', 'license_change',
]);
const InjectionRequest = ViewRequest.extend({ sessionId: z.string().min(1).max(200), turnId: z.string().min(1).max(200), trigger: z.enum(['session_started', 'message_user', 'tool_failure', 'tool_important', 'explicit_recall', 'budget_near', 'license_change']) });
const MAX_BODY_BYTES = 64_000;

/**
 * Local Host-facing injection endpoint (HOST-05/06). Hook processes are short-lived, so the
 * shared Bridge holds session state; this endpoint never accepts a Host identity from the
 * body and always answers within the foreground deadline through the controller.
 */
export function createInjectionServer(options: { token: string; sessions: InjectionSessions; event?: (input: unknown) => void | Promise<void> }) {
  if (options.token.length < 24) throw new Error('Bridge injection token must contain at least 24 characters');
  const expected = Buffer.from(`Bearer ${options.token}`);
  return createServer(async (req, res) => {
    const traceId = randomUUID();
    const reply = (status: number, value: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-trace-id': traceId });
      res.end(JSON.stringify(value));
    };
    try {
      const actual = Buffer.from(req.headers.authorization ?? '');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply(401, { code: 'UNAUTHORIZED' });
      if (req.headers.origin) return reply(401, { code: 'UNAUTHORIZED' });
      if (req.method === 'GET' && req.url === '/health/live') return reply(200, { live: true });
      if (req.method !== 'POST' || !['/v1/inject', '/v1/events', '/v1/session/close'].includes(req.url ?? '')) return reply(404, { code: 'NOT_FOUND' });
      if (!req.headers['content-type']?.startsWith('application/json')) return reply(400, { code: 'INVALID_INPUT' });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk as Uint8Array);
        size += bytes.length;
        if (size > MAX_BODY_BYTES) return reply(400, { code: 'INVALID_INPUT' });
        chunks.push(bytes);
      }
      let body: Record<string, unknown>;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { return reply(400, { code: 'INVALID_INPUT' }); }
      if (req.url === '/v1/events') {
        const event = HostEvent.parse(body);
        if (!options.event) return reply(503, { code: 'REVIEW_REQUIRED' });
        await options.event(event);
        if (event.kind === 'session.ended') options.sessions.close(event.sessionId);
        return reply(202, { queued: true });
      }
      if (req.url === '/v1/session/close') {
        const input = z.object({ sessionId: z.string().min(1).max(200) }).strict().parse(body);
        options.sessions.close(input.sessionId); return reply(200, { closed: true });
      }
      const input = InjectionRequest.parse(body);
      return reply(200, await options.sessions.handle(input));
    } catch (error) {
      if (error instanceof z.ZodError) return reply(400, { code: 'INVALID_INPUT' });
      process.stderr.write(`${JSON.stringify({ traceId, event: 'bridge_injection_failed', message: String(error).slice(0, 200) })}\n`);
      return reply(503, { code: 'PROVIDER_UNAVAILABLE' });
    }
  });
}
