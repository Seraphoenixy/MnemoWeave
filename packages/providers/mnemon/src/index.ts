import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { MnemoWeaveError } from '../../../core/contracts/src/index.ts';
import type { Health, RecallRequest, RecallResult } from '../../../core/contracts/src/index.ts';
import type { MemoryProvider } from '../../../core/application/src/index.ts';

export type Runner = (args: string[]) => Promise<string>;
export function createRunner(binary: string, timeout = 15000, maxBuffer = 2 * 1024 * 1024): Runner {
  if (!isAbsolute(binary)) throw new Error('MNEMON_BINARY must be absolute');
  return args => new Promise((resolve, reject) => {
    execFile(binary, args, { shell: false, windowsHide: true, timeout, maxBuffer, encoding: 'utf8', env: { ...process.env, MNEMON_MAX_INSIGHTS: '0' } }, (error, stdout) => {
      if (error) {
        reject(new MnemoWeaveError(error.killed ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE'));
      } else resolve(stdout);
    });
  });
}
const NativeRecall = z.object({ results: z.array(z.object({ id: z.string().min(1), content: z.string(), score: z.number().finite(), superseded: z.boolean().optional() })) });
const NativeRemember = z.discriminatedUnion('action', [
  z.object({ id: z.string().min(1), action: z.literal('added') }),
  z.object({ id: z.string().min(1), action: z.literal('skipped'), replaced_id: z.string().min(1) }),
]);
const Status = z.object({ total_insights: z.number().int().nonnegative() });
const NativeMemory = z.object({ id: z.string().min(1), content: z.string() });
function decode<T>(schema: z.ZodType<T>, text: string): T {
  try { return schema.parse(JSON.parse(text)); } catch { throw new MnemoWeaveError('PROVIDER_PROTOCOL'); }
}

export class MnemonCliProvider implements MemoryProvider {
  private readonly runner: Runner;
  private readonly prefix: string[];
  private queue: Promise<unknown> = Promise.resolve();
  constructor(options: { binary: string; dataDir: string; store: string; runner?: Runner }) {
    if (!isAbsolute(options.dataDir) || !/^[a-zA-Z0-9_-]+$/.test(options.store)) throw new Error('Explicit absolute dataDir and safe store are required');
    this.runner = options.runner ?? createRunner(options.binary);
    this.prefix = ['--data-dir', options.dataDir, '--store', options.store];
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async checked(args: string[]): Promise<string> {
    const version = (await this.runner(['--version'])).trim();
    if (version !== 'mnemon version 0.2.13') throw new MnemoWeaveError('UNSUPPORTED_VERSION');
    return this.runner([...this.prefix, ...args]);
  }
  health(): Promise<Health> {
    return this.serial(async () => {
      decode(Status, await this.checked(['status']));
      return { ready: true, version: '0.2.13', capabilities: ['health', 'recall', 'remember'] };
    });
  }
  recall(request: RecallRequest): Promise<RecallResult> {
    return this.serial(async () => {
      const result = decode(NativeRecall, await this.checked(['recall', '--limit', String(request.limit), '--', request.query]));
      return { memories: result.results.map(({ id, content, score, superseded }) => ({ id, content, score, ...(superseded === undefined ? {} : { superseded }) })) };
    });
  }
  /** Bounded official CLI lookup; absence alone never authorizes retrying an uncertain write. */
  inspectExact(content: string): Promise<{ matches: { id: string; content: string }[]; complete: boolean }> {
    if (!content.trim() || Buffer.byteLength(content, 'utf8') > 8000) return Promise.reject(new MnemoWeaveError('INVALID_INPUT'));
    return this.serial(async () => {
      const rows = decode(z.array(NativeMemory).nullable(), await this.checked(['recall', '--basic', '--limit', '200', '--', content])) ?? [];
      // LIKE treats % and _ as patterns. Filter exact content and report truncation.
      return { matches: rows.filter(row => row.content === content), complete: rows.length < 200 };
    });
  }
  verifyContent(id: string, expectedContent: string): Promise<boolean> {
    if (!id.trim()) return Promise.reject(new MnemoWeaveError('INVALID_INPUT'));
    return this.serial(async () => {
      const memory = decode(NativeMemory, await this.checked(['show', '--', id]));
      return memory.id === id && memory.content === expectedContent;
    });
  }
  readMemory(id: string): Promise<{ id: string; content: string }> {
    if (!id.trim()) return Promise.reject(new MnemoWeaveError('INVALID_INPUT'));
    return this.serial(async () => {
      const result = decode(NativeMemory, await this.checked(['show', '--', id]));
      if (result.id !== id) throw new MnemoWeaveError('PROVIDER_PROTOCOL');
      return result;
    });
  }
  /** Internal relation projection only; approval and publication are owned by the workflow. */
  linkSupersedes(sourceId: string, targetId: string, metadata: { operationId: string; reason: string; effectiveAt: string }): Promise<{ sourceId: string; targetId: string; edgeType: 'supersedes' }> {
    const input = z.object({ sourceId: z.uuid(), targetId: z.uuid(), metadata: z.object({ operationId: z.uuid(), reason: z.string().trim().min(1).max(4000), effectiveAt: z.iso.datetime() }).strict() }).strict().parse({ sourceId, targetId, metadata });
    if (input.sourceId === input.targetId) return Promise.reject(new MnemoWeaveError('INVALID_INPUT'));
    return this.serial(async () => {
      const ack = decode(z.object({ status: z.literal('linked'), source_id: z.string(), target_id: z.string(), edge_type: z.literal('supersedes'), metadata: z.record(z.string(), z.string()) }), await this.checked(['link', input.sourceId, input.targetId, '--type', 'supersedes', '--meta', JSON.stringify(input.metadata)]));
      if (ack.source_id !== input.sourceId || ack.target_id !== input.targetId || Object.entries(input.metadata).some(([key, value]) => ack.metadata[key] !== value)) throw new MnemoWeaveError('PROVIDER_PROTOCOL');
      return { sourceId: input.sourceId, targetId: input.targetId, edgeType: 'supersedes' };
    });
  }
  /** Internal write port; only the reviewed, durably queued workflow invokes it. */
  persistReviewed(content: string, writeKey: string): Promise<{ id: string; action: 'added' | 'skipped' }> {
    if (!content.trim() || Buffer.byteLength(content, 'utf8') > 8000 || !/^candidate:[a-f0-9-]{36}$/.test(writeKey)) return Promise.reject(new MnemoWeaveError('INVALID_INPUT'));
    return this.serial(async () => {
      const result = decode(NativeRemember, await this.checked(['remember', '--source', `mnemoweave:${writeKey}`, '--', content]));
      return { id: result.action === 'skipped' ? result.replaced_id : result.id, action: result.action };
    });
  }
  /** Provider acceptance only. Business Remember must enter Candidate/Review first. */
  acceptanceRemember(content: string): Promise<{ id: string; action: 'added' | 'skipped' }> {
    if (!content.trim() || Buffer.byteLength(content, 'utf8') > 8000) return Promise.reject(new MnemoWeaveError('INVALID_INPUT'));
    return this.serial(async () => {
      const result = decode(NativeRemember, await this.checked(['remember', '--source', 'external', '--', content]));
      return { id: result.action === 'skipped' ? result.replaced_id : result.id, action: result.action };
    });
  }
}
