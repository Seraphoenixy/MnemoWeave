/** Renders one immutable View into the text a Host injects into the conversation. */
export interface RenderableView {
  viewId?: string | undefined;
  guidance?: string | undefined;
  rules?: Array<{ body?: string | undefined }> | undefined;
  rulesBudget?: { exceeded?: boolean | undefined } | undefined;
  workingContext?: Array<{ text?: string | undefined }> | undefined;
  memories?: Array<{
    content: string;
    excerpt?: boolean | undefined;
    applicability?: string | undefined;
    sourceReference?: string | undefined;
  }> | undefined;
}

/**
 * Injection order is fixed: server guidance, then the confirmed rules, then working context,
 * then formal memories. A rule omitted for budget is named instead of disappearing, so the
 * model can tell "no rules apply" from "rules were dropped".
 */
export function renderView(view: RenderableView): string {
  const blocks: string[] = [];
  if (typeof view.guidance === 'string' && view.guidance.trim() !== '') blocks.push(view.guidance.trim());
  const rules = (view.rules ?? []).map(rule => rule.body ?? '').filter(body => body.trim() !== '');
  if (rules.length > 0) blocks.push(`Runtime rules (confirmed by the user, follow them):\n${rules.map(rule => `- ${rule.trim()}`).join('\n')}`);
  else if (view.rulesBudget?.exceeded === true) blocks.push('Runtime rules were omitted: the budget was exceeded.');
  const working = (view.workingContext ?? []).map(entry => entry.text ?? '').filter(text => text.trim() !== '');
  if (working.length > 0) blocks.push(`Working context (unverified session material):\n${working.join('\n')}`);
  const memories = (view.memories ?? []).filter(memory => memory.content.trim() !== '');
  if (memories.length > 0) {
    blocks.push(`Formal memories:\n${memories.map(memory => {
      const truncated = memory.excerpt === true ? ' [excerpt]' : '';
      return `- ${memory.content}${truncated}`;
    }).join('\n')}`);
  }
  return blocks.join('\n\n');
}
