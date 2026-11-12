import type { z } from 'zod';
import { CandidateIdInput, Candidate, ConflictDescriptor, ConflictIdInput, MemoryIdInput, MnemoWeaveError, ProviderHealth, RecallOutput, PublishedMemoryOutput } from '../../../packages/core/contracts/src/index.ts';

/**
 * Thin stdio MCP transport client.
 *
 * The single local Server owns the Core, Provider and Worker; the MCP process only forwards
 * authenticated calls. The session id is bound by the process environment, so a model argument
 * cannot name a different session.
 */
export function httpMemoryClient(base: string, token: string, hostId: string, sessionId?: string) {
  if (!hostId.trim() || token.length < 24) throw new Error('MCP requires a configured Host identity and service credential');
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid Server URL');
  const request = async <T>(path: string, schema: z.ZodType<T>, input?: unknown): Promise<T> => {
    const response = await fetch(`${base.replace(/\/$/, '')}${path}`, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-mnemoweave-host': hostId, 'content-type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json() as { code?: MnemoWeaveError['code'] };
    if (!response.ok) throw new MnemoWeaveError(body.code ?? 'PROVIDER_UNAVAILABLE');
    return schema.parse(body);
  };
  const bindSession = (input: unknown): Record<string, unknown> => {
    const body = input as Record<string, unknown>;
    if (!sessionId || body['sessionId'] !== undefined && body['sessionId'] !== sessionId) throw new MnemoWeaveError('UNAUTHORIZED');
    return { ...body, sessionId };
  };
  return {
    acceptsCandidates: true,
    health: () => request('/health/ready', ProviderHealth),
    recall: (input: unknown) => request('/v1/recall', RecallOutput, input),
    remember: (input: unknown) => request('/v1/remember', Candidate, bindSession(input)),
    candidateStatus: (input: unknown) => request(`/v1/candidates/${CandidateIdInput.parse(input).candidateId}`, Candidate),
    readMemory: (input: unknown) => {
      const parsed = MemoryIdInput.parse(input);
      return request(`/v1/memories/${parsed.memoryId}${parsed.revisionId ? `?revisionId=${parsed.revisionId}` : ''}`, PublishedMemoryOutput);
    },
    readConflict: (input: unknown) => request(`/v1/conflicts/${ConflictIdInput.parse(input).caseId}`, ConflictDescriptor),
  };
}
