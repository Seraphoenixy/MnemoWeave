/** Types for the checked-in Host bundle; the implementation lives in `index.js`. */
export declare const name: string;
export declare const inject: readonly string[];
/** Renders the resident rule block; an incomplete delivery renders nothing. */
export declare function render(injection: unknown): string;
/** The command name a person types to mark the current turn as not retained. */
export declare const NO_RETENTION_COMMAND: string;
/**
 * Reads a service the plugin does not declare. Cordis throws for undeclared property reads, and an
 * exception in `apply` unloads the fiber, so optional services go through `ctx.get`.
 */
export declare function readOptionalService(ctx: unknown, name: string): any;
/** The shared engineering-experience guidance every `remember` description quotes. */
export declare const ENGINEERING_EXPERIENCE_GUIDANCE: string;
/** One model-facing tool, in the shape DSH's `ctx.tools.register` accepts. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render: (args: Record<string, unknown>, value: unknown) => Array<{ type: 'text'; text: string }>;
  };
  execute: (args: Record<string, unknown>, execution?: { signal?: AbortSignal | undefined; agent?: { id?: string } }) => Promise<unknown>;
}
/** The memory tool family; names carry the `mnemoweave_` prefix to avoid dsh-mnemon collisions. */
export declare function createTools(config?: Record<string, unknown>): ToolDefinition[];
/** Registers the tools and the per-turn prompt section; returns a disposer for the tools. */
export declare function apply(ctx: unknown, config?: Record<string, unknown>): () => void;
