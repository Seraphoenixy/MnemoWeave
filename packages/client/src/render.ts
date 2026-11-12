/** Renders the complete resident rule set into the text a Host injects into the conversation. */
export interface RenderableRules {
  rules?: Array<{ body?: string | undefined }> | undefined;
  /** False when the host could not deliver every rule whole; a partial set is never rendered. */
  complete?: boolean | undefined;
  failure?: 'deadline' | 'output_limit' | 'request_failed' | undefined;
}

/**
 * Every rule whole, in the order the Server returned. The renderer never trims, reorders or
 * drops a rule to fit: it renders nothing when the delivery was incomplete, and the host reports
 * the failure instead. A partial block would let the model believe a rule had been removed.
 */
export function renderRules(view: RenderableRules): string {
  if (view.complete === false) return '';
  const bodies = (view.rules ?? []).map(rule => rule.body ?? '').filter(body => body.trim() !== '');
  if (bodies.length === 0) return '';
  return `准则（用户确认，按此执行）：\n${bodies.map(body => `- ${body.trim()}`).join('\n')}`;
}
