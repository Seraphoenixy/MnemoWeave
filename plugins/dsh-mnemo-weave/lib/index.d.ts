/** Types for the checked-in Host bundle; the implementation lives in `index.js`. */
export declare const name: string;
export declare const inject: readonly string[];
/** Renders one View into the prompt section the Host injects (rules → context → memories). */
export declare function render(view: unknown): string;
export declare function apply(ctx: unknown, config?: Record<string, unknown>): void;
