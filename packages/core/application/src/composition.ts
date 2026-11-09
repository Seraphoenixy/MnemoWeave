import { MnemoWeaveError } from '../../contracts/src/index.ts';
import type { ReadGrantRecord } from '../../contracts/src/index.ts';
import { assertGrant } from './access.ts';

export interface Source {
  readonly id: string;
  readonly capabilities: readonly string[];
  read(capability: string, input: unknown, context: { grant: ReadGrantRecord; signal?: AbortSignal | undefined }): Promise<unknown>;
}
export interface CompositionPlan { readonly steps: readonly { sourceId: string; capability: string }[] }
export interface Strategy { plan(sources: readonly { id: string; capabilities: readonly string[] }[]): CompositionPlan }
/** Definitions are snapshotted; an in-flight pipeline cannot silently switch Source instances. */
export class SourceRegistry {
  private readonly sources = new Map<string, Source>();
  register(source: Source): void {
    if (!source.id.trim() || this.sources.has(source.id) || !source.capabilities.length || new Set(source.capabilities).size !== source.capabilities.length) throw new MnemoWeaveError('INVALID_INPUT');
    this.sources.set(source.id, Object.freeze({ id: source.id, capabilities: Object.freeze([...source.capabilities]), read: source.read.bind(source) }));
  }
  compile(strategy: Strategy): CompositionPipeline {
    const sources = new Map(this.sources);
    const plan = strategy.plan(Object.freeze([...sources.values()].map(source => Object.freeze({ id: source.id, capabilities: source.capabilities }))));
    if (!plan.steps.length || plan.steps.length > 32) throw new MnemoWeaveError('INVALID_INPUT');
    const steps = plan.steps.map(step => {
      const source = sources.get(step.sourceId);
      if (!source || !source.capabilities.includes(step.capability)) throw new MnemoWeaveError('REVIEW_REQUIRED');
      return Object.freeze({ source, capability: step.capability });
    });
    return new CompositionPipeline(Object.freeze(steps));
  }
}
/** Read-only Pipeline. Reviewed side effects remain in the durable write workflow. */
export class CompositionPipeline {
  private readonly steps: readonly { source: Source; capability: string }[];
  constructor(steps: readonly { source: Source; capability: string }[]) { this.steps = steps; }
  async execute(input: unknown, grant: ReadGrantRecord, signal?: AbortSignal): Promise<unknown> {
    let value = input;
    for (const step of this.steps) {
      signal?.throwIfAborted(); assertGrant(grant);
      value = await step.source.read(step.capability, value, { grant, signal });
    }
    signal?.throwIfAborted(); assertGrant(grant);
    return value;
  }
}
