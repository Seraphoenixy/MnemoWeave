/** Types for the checked-in Host bundle; the implementation lives in `index.js`. */
export declare const name: string;
export declare const inject: readonly string[];
/** Renders one View into the prompt section the Host injects (rules → context → memories). */
export declare function render(view: unknown): string;
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
