import { z } from 'zod';

export const RuntimeScope = z.object({
  sessionId: z.string().min(1).max(200), projectId: z.string().min(1).max(200).optional(),
}).strict();
export const PinInput = z.object({
  memoryId: z.uuid(), tier: z.enum(['critical', 'normal']),
  scope: z.enum(['global', 'project', 'host', 'session']),
  projectId: z.string().min(1).max(200).optional(),
  hostId: z.string().min(1).max(200).optional(), sessionId: z.string().min(1).max(200).optional(),
  remove: z.boolean().default(false),
}).strict().superRefine((pin, ctx) => {
  if ((pin.scope === 'project' && !pin.projectId) || (['host', 'session'].includes(pin.scope) && !pin.hostId) || (pin.scope === 'session' && !pin.sessionId)) ctx.addIssue({ code: 'custom', message: 'Pin requires explicit scope identity' });
});
export type PinRecord = z.infer<typeof PinInput>;
export const RuntimeContextInput = RuntimeScope.extend({ task: z.string().trim().min(1).max(2000).optional(), close: z.boolean().default(false) });
export const CaptureOutput = z.object({
  candidates: z.array(z.object({ content: z.string().trim().min(1).max(2000), eventIds: z.array(z.string().min(1)).min(1).max(12) }).strict()).max(1),
}).strict();
export type CaptureResult = z.infer<typeof CaptureOutput>;
export interface RuntimeContext {
  sessionId: string; projectId?: string; task: string | null; revision: number; closed: boolean;
  entries: { eventId: string; text: string; kind: 'user' | 'task' | 'tool' }[];
  pins: { memoryId: string; tier: 'critical' | 'normal' }[];
  capture: string;
}

export const RuntimeContextOutput = z.object({
  sessionId: z.string(), projectId: z.string().optional(), task: z.string().nullable(), revision: z.number().int().nonnegative(), closed: z.boolean(),
  entries: z.array(z.object({ eventId: z.string(), text: z.string(), kind: z.enum(['user', 'task', 'tool']) })),
  pins: z.array(z.object({ memoryId: z.uuid(), tier: z.enum(['critical', 'normal']) })), capture: z.string(),
}).strict();
