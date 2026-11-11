/**
 * Idle-review signal selection.
 *
 * The Server never calls a model. This module only decides which completed user turns carry a
 * durable signal worth reviewing; an isolated task Agent does the semantic work later. Every
 * rule here is deterministic and explains itself in `reason`, so a review can say why a turn was
 * selected (or why it was skipped).
 */

export interface ReviewableEvent {
  eventId: string;
  sessionId: string;
  turnId: string | null;
  projectId: string | null;
  kind: string;
  payload: { text?: string };
}

export interface IdleReviewSignal {
  id: string;
  sessionId: string;
  turnId: number;
  eventId: string;
  text: string;
  projectId: string | null;
  reason: 'correction' | 'standing-instruction' | 'durable-fact';
  createdAt: string;
}

export interface IdleReviewSkipCounts {
  tooShort: number;
  question: number;
  noTurn: number;
  outOfWindow: number;
  duplicate: number;
}

export interface IdleReviewSelection {
  signals: IdleReviewSignal[];
  lastTurn: number;
  skipped: IdleReviewSkipCounts;
}

const CORRECTION = /不对|不是.{0,12}而是|纠正|更正|其实|应该(是|改|用)|改为|改成/iu;
const STANDING = /以后|今后|始终|总是|必须|不要|禁止|不能|默认|每逢|每次/iu;
const DURABLE = /记住|记一下|记录下来|保存为?记忆|别忘了|remember|always|never|must|should|from now on|instead|default/iu;
const QUESTION_END = /[?？]\s*$/u;

/** Minimum UTF-8 bytes: shorter turns are acknowledgements, not knowledge. */
const MIN_BYTES = 12;
const MAX_BYTES = 2000;

function normalize(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

/** One reason per turn, in priority order: a correction outranks a standing rule. */
function reasonFor(text: string): IdleReviewSignal['reason'] | null {
  if (CORRECTION.test(text)) return 'correction';
  if (STANDING.test(text)) return 'standing-instruction';
  if (DURABLE.test(text)) return 'durable-fact';
  return null;
}

/**
 * Select signals from `message.user` events in `(afterTurn, completedThroughTurn]`.
 *
 * A question is skipped unless it also carries a durable cue: "shouldn't this be 3.3V?" is a
 * question, while "shouldn't this be 3.3V — from now on always 3.3V" states a rule.
 */
export function selectIdleReviewSignals(
  events: readonly ReviewableEvent[],
  options: { afterTurn: number; completedThroughTurn: number; maxSignals: number; knownTexts?: ReadonlySet<string>; now: string; id: () => string },
): IdleReviewSelection {
  const skipped: IdleReviewSkipCounts = { tooShort: 0, question: 0, noTurn: 0, outOfWindow: 0, duplicate: 0 };
  const known = new Set(options.knownTexts ?? []);
  const signals: IdleReviewSignal[] = [];
  let lastTurn = options.afterTurn;
  // Turn order, then event order: a stable selection that a retry reproduces.
  const ordered = [...events].sort((left, right) => (left.turnId ?? '').localeCompare(right.turnId ?? '', undefined, { numeric: true })
    || left.eventId.localeCompare(right.eventId));
  for (const event of ordered) {
    if (event.kind !== 'message.user') continue;
    const turn = event.turnId === null ? Number.NaN : Number(event.turnId);
    if (!Number.isInteger(turn) || turn < 0) { skipped.noTurn += 1; continue; }
    if (turn <= options.afterTurn || turn > options.completedThroughTurn) { skipped.outOfWindow += 1; continue; }
    lastTurn = Math.max(lastTurn, turn);
    if (signals.length >= options.maxSignals) continue;
    const text = normalize(event.payload.text ?? '');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes < MIN_BYTES) { skipped.tooShort += 1; continue; }
    if (bytes > MAX_BYTES) { skipped.tooShort += 1; continue; }
    const reason = reasonFor(text);
    const question = QUESTION_END.test(text);
    if (reason === null) { if (question) skipped.question += 1; continue; }
    if (question && !STANDING.test(text) && !CORRECTION.test(text)) { skipped.question += 1; continue; }
    if (known.has(text)) { skipped.duplicate += 1; continue; }
    known.add(text);
    signals.push({
      id: options.id(), sessionId: event.sessionId, turnId: turn, eventId: event.eventId, text,
      projectId: event.projectId, reason, createdAt: options.now,
    });
  }
  return { signals, lastTurn, skipped };
}
