/**
 * Idle-review signal selection.
 *
 * The Server never calls a model. This module only decides which completed user turns carry a
 * durable signal worth reviewing; an isolated task Agent does the semantic work later. Every rule
 * here is deterministic and explains itself in `reason`, so a review can say why a turn was
 * selected (or why it was skipped).
 *
 * A turn the user marked "do not retain" is never selected: it does not score and does not
 * become evidence.
 */

export interface ReviewableEvent {
  eventId: string;
  sessionId: string;
  turnId: string | null;
  kind: string;
  payload: { text?: string; noRetention?: true };
}

export interface IdleReviewSignal {
  id: string;
  sessionId: string;
  turnId: number;
  eventId: string;
  text: string;
  reason: 'correction' | 'standing-instruction' | 'durable-fact';
  createdAt: string;
}

export interface IdleReviewSkipCounts {
  tooShort: number;
  question: number;
  noTurn: number;
  outOfWindow: number;
  duplicate: number;
  noRetention: number;
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
  const skipped: IdleReviewSkipCounts = { tooShort: 0, question: 0, noTurn: 0, outOfWindow: 0, duplicate: 0, noRetention: 0 };
  // Duplicate detection compares normalized text, so the same instruction phrased with different
  // spacing or width is recognized as the one already recorded.
  const known = new Set([...(options.knownTexts ?? [])].map(normalize));
  const signals: IdleReviewSignal[] = [];
  let lastTurn = options.afterTurn;
  // Turns marked "do not retain" are excluded entirely: not scored, not evidence, and no write
  // triggered by them may run.
  const noRetentionTurns = new Set<string>();
  for (const event of events) {
    if (event.payload.noRetention === true && event.turnId !== null) noRetentionTurns.add(event.turnId);
  }
  // Turn order, then event order: a stable selection that a retry reproduces.
  const ordered = [...events].sort((left, right) => (left.turnId ?? '').localeCompare(right.turnId ?? '', undefined, { numeric: true })
    || left.eventId.localeCompare(right.eventId));
  for (const event of ordered) {
    if (event.kind !== 'message.user') continue;
    const turn = event.turnId === null ? Number.NaN : Number(event.turnId);
    if (!Number.isInteger(turn) || turn < 0) { skipped.noTurn += 1; continue; }
    if (turn <= options.afterTurn || turn > options.completedThroughTurn) { skipped.outOfWindow += 1; continue; }
    if (event.payload.noRetention === true || noRetentionTurns.has(String(event.turnId))) { skipped.noRetention += 1; continue; }
    lastTurn = Math.max(lastTurn, turn);
    if (signals.length >= options.maxSignals) continue;
    // Matching runs on a normalized form, but the signal keeps the user's own wording: the task
    // Agent quotes this text as evidence and a rewritten quote would not match what was said.
    const original = (event.payload.text ?? '').trim();
    const text = normalize(original);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes < MIN_BYTES || bytes > MAX_BYTES) { skipped.tooShort += 1; continue; }
    const reason = reasonFor(text);
    const question = QUESTION_END.test(text);
    if (reason === null) { if (question) skipped.question += 1; continue; }
    if (question && !STANDING.test(text) && !CORRECTION.test(text)) { skipped.question += 1; continue; }
    if (known.has(text)) { skipped.duplicate += 1; continue; }
    known.add(text);
    signals.push({
      id: options.id(), sessionId: event.sessionId, turnId: turn, eventId: event.eventId, text: original,
      reason, createdAt: options.now,
    });
  }
  return { signals, lastTurn, skipped };
}

/** Activity score from completed turns; only used to decide whether review may start. */
export function idleActivityScore(input: {
  userTexts: readonly string[];
  completedTurns: number;
  toolCalls: number;
  toolKinds: number;
}): number {
  const textPoints = Math.min(3, Math.ceil(input.userTexts
    .reduce((sum, text) => sum + text.length, 0) / 50));
  const turnPoints = Math.min(input.completedTurns, Number.MAX_SAFE_INTEGER);
  const toolPoints = Math.min(2, Math.floor(input.toolCalls / 5));
  const kindPoints = input.toolKinds >= 4 ? 2 : input.toolKinds >= 3 ? 1 : 0;
  return textPoints + turnPoints + toolPoints + kindPoints;
}

/** Continuous idle time before a session is a candidate for review. */
export const IDLE_REVIEW_IDLE_MS = 30_000;
/** Activity below this is not worth a model task. */
export const IDLE_REVIEW_MIN_SCORE = 5;
/** Two attempts on one session are at least this far apart. */
export const IDLE_REVIEW_MIN_INTERVAL_MS = 5 * 60_000;
/** After this many attempts the session is left alone. */
export const IDLE_REVIEW_MAX_ATTEMPTS = 20;

/**
 * Whether a review may start now. Every reason is reported so the Host can show why it skipped.
 * A cancelled or failed attempt still counts: the cap bounds the cost of an unreviewable session.
 */
export function idleReviewReady(input: {
  idleMs: number;
  score: number;
  attempts: number;
  sinceLastAttemptMs: number | null;
  paused?: string;
  hasRoute: boolean;
  hasEvidence: boolean;
}): { ready: true } | { ready: false; reason: 'idle' | 'score' | 'cooldown' | 'attempts' | 'paused' | 'no-route' | 'evidence' } {
  if (input.paused !== undefined) return { ready: false, reason: 'paused' };
  if (!input.hasRoute) return { ready: false, reason: 'no-route' };
  if (!input.hasEvidence) return { ready: false, reason: 'evidence' };
  if (input.idleMs < IDLE_REVIEW_IDLE_MS) return { ready: false, reason: 'idle' };
  if (input.score < IDLE_REVIEW_MIN_SCORE) return { ready: false, reason: 'score' };
  if (input.attempts >= IDLE_REVIEW_MAX_ATTEMPTS) return { ready: false, reason: 'attempts' };
  if (input.sinceLastAttemptMs !== null && input.sinceLastAttemptMs < IDLE_REVIEW_MIN_INTERVAL_MS) return { ready: false, reason: 'cooldown' };
  return { ready: true };
}
