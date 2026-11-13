/**
 * The parts of 「保存回复」 that are not markup.
 *
 * Kept apart from the component so the identity rule and the text extraction can be tested
 * without a browser: a wrong task id would write twice, and a wrong extraction would save text the
 * user never saw.
 */

/** The Chat node shape the reply action reads; the rest of the snapshot is not used. */
export interface ChatNode {
  readonly kind?: string;
  readonly messageId?: string;
  readonly turn?: number;
  readonly blocks?: ReadonlyArray<{ readonly kind?: string; readonly text?: string }>;
}

export interface ChatSnapshot {
  readonly nodes?: { values(): IterableIterator<ChatNode> };
}

/**
 * Deterministic id for one reply's save.
 *
 * The Server keys a receipt on `(host, task, index)`. Deriving the task id from the session and
 * the durable reply id means a second click, a reopened page and a retry all address the same
 * receipt, so the same reply can only ever produce one write.
 */
export function replyTaskId(sessionId: string, messageId: string): string {
  let hash = 0x811c9dc5;
  const source = `${sessionId}\u0000${messageId}`;
  const bytes: number[] = [];
  for (let index = 0; index < 16; index += 1) {
    const value = hash >>> 0;
    for (let round = 0; round < 4; round += 1) {
      hash ^= source.charCodeAt((index * 4 + round) % source.length) ^ (index + round * 17);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    bytes.push(value & 0xff);
  }
  const hex = bytes.map(byte => byte.toString(16).padStart(2, '0')).join('');
  // Version 4 and the RFC 4122 variant: the value is arbitrary, but the shape must be a UUID.
  const versioned = `${hex.slice(0, 12)}4${hex.slice(13, 16)}`;
  const variant = ((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${versioned.slice(0, 8)}-${versioned.slice(8, 12)}-${versioned.slice(12, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

/** The visible prose of one assistant reply, or null when the node carries no text. */
export function replyText(node: ChatNode | undefined): string | null {
  if (node === undefined || node.blocks === undefined) return null;
  const text = node.blocks.filter(block => block.kind === 'text').map(block => block.text ?? '').join('').trim();
  return text === '' ? null : text;
}
