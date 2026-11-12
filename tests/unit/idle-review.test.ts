import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IDLE_REVIEW_IDLE_MS, IDLE_REVIEW_MAX_ATTEMPTS, IDLE_REVIEW_MIN_INTERVAL_MS, idleActivityScore, idleReviewReady, selectIdleReviewSignals,
} from '../../packages/core/application/src/idle-review.ts';

const event = (turnId: string | null, text: string, kind = 'message.user', eventId = `e-${turnId}-${text.slice(0, 4)}`, noRetention = false) => ({
  eventId, sessionId: 's-1', turnId, kind, payload: { text, ...(noRetention ? { noRetention: true as const } : {}) },
});

const options = {
  afterTurn: 0, completedThroughTurn: 5, maxSignals: 10,
  now: '2026-11-11T00:00:00.000Z', id: () => `id-${Math.random().toString(16).slice(2)}`,
};

test('idle review selects corrections, standing rules and durable facts from completed turns', () => {
  const result = selectIdleReviewSignals([
    event('1', '不对，串口应该是 115200 而不是 9600'),
    event('2', '以后都用 pnpm，不要用 npm'),
    event('3', '记住：构建产物放在 work/build 目录'),
    event('4', '这个文件的路径是什么？'),
    event('5', '好'),
  ], options);
  assert.deepEqual(result.signals.map(signal => signal.reason), ['correction', 'standing-instruction', 'durable-fact']);
  // A signal carries no workspace: the session binding decides which workspace an archive targets,
  // and the formal collection is shared.
  assert.deepEqual(Object.keys(result.signals[2]!).sort(), ['createdAt', 'eventId', 'id', 'reason', 'sessionId', 'text', 'turnId']);
  assert.equal(result.lastTurn, 5);
  assert.equal(result.skipped.question, 1);
  assert.equal(result.skipped.tooShort, 1);
});

test('a turn marked not to be retained is never scored or used as evidence', () => {
  const result = selectIdleReviewSignals([
    event('1', '以后都用 pnpm，不要用 npm', 'message.user', 'e-1', true),
    event('2', '以后都用 pnpm，不要用 npm'),
  ], options);
  assert.deepEqual(result.signals.map(signal => signal.turnId), [2]);
  assert.equal(result.skipped.noRetention, 1);
});

test('a retry resumes after the watermark and never repeats a signal', () => {
  const first = selectIdleReviewSignals([event('1', '以后都用 pnpm，不要用 npm')], { ...options, afterTurn: 0 });
  assert.equal(first.signals.length, 1);
  const again = selectIdleReviewSignals(
    [event('1', '以后都用 pnpm，不要用 npm'), event('2', '默认分支是 main，不要直接推送')],
    { ...options, afterTurn: first.lastTurn },
  );
  assert.deepEqual(again.signals.map(signal => signal.turnId), [2]);
  const known = selectIdleReviewSignals([event('2', '默认分支是 main，不要直接推送')], {
    ...options, afterTurn: 1, knownTexts: new Set([again.signals[0]!.text]),
  });
  assert.equal(known.signals.length, 0);
  assert.equal(known.skipped.duplicate, 1);
});

test('turns outside the window and non-user events are left alone', () => {
  const result = selectIdleReviewSignals([
    event('6', '以后都用 pnpm，不要用 npm'),
    event(null, '以后都用 pnpm，不要用 npm'),
    event('2', '以后都用 pnpm，不要用 npm', 'message.assistant.final'),
    event('2', '以后都用 pnpm，不要用 npm', 'message.user', 'e-other'),
  ], { ...options, completedThroughTurn: 5 });
  assert.deepEqual(result.signals.map(signal => signal.turnId), [2]);
  assert.equal(result.skipped.outOfWindow, 1);
  assert.equal(result.skipped.noTurn, 1);
  assert.equal(result.lastTurn, 2, 'the watermark follows the last processed turn');
});

test('the per-pass cap stops new signals without losing the watermark', () => {
  const events = Array.from({ length: 5 }, (_, index) => event(String(index + 1), `必须记住第 ${index + 1} 条现场结论`));
  const result = selectIdleReviewSignals(events, { ...options, maxSignals: 2 });
  assert.equal(result.signals.length, 2);
  assert.equal(result.lastTurn, 5);
});

test('the activity score counts text, turns and tool breadth, and only decides whether to start', () => {
  // 150 code units of user text is 3 points (the cap), one turn is 1, five tool calls is 1.
  assert.equal(idleActivityScore({ userTexts: ['x'.repeat(150)], completedTurns: 1, toolCalls: 5, toolKinds: 0 }), 5);
  // Every component is capped: more text, more calls and more kinds cannot overflow the score.
  assert.equal(idleActivityScore({ userTexts: ['x'.repeat(1000)], completedTurns: 30, toolCalls: 100, toolKinds: 9 }), 3 + 30 + 2 + 2);
  assert.equal(idleActivityScore({ userTexts: [], completedTurns: 0, toolCalls: 0, toolKinds: 0 }), 0);
});

test('a review starts only when idle, active enough, cooled down and within the attempt cap', () => {
  const base = { idleMs: IDLE_REVIEW_IDLE_MS, score: 5, attempts: 0, sinceLastAttemptMs: null, hasRoute: true, hasEvidence: true };
  assert.deepEqual(idleReviewReady(base), { ready: true });
  // Each gate reports its own reason, so the Host can show why it skipped.
  assert.deepEqual(idleReviewReady({ ...base, idleMs: IDLE_REVIEW_IDLE_MS - 1 }), { ready: false, reason: 'idle' });
  assert.deepEqual(idleReviewReady({ ...base, score: 4 }), { ready: false, reason: 'score' });
  assert.deepEqual(idleReviewReady({ ...base, attempts: IDLE_REVIEW_MAX_ATTEMPTS }), { ready: false, reason: 'attempts' });
  assert.deepEqual(idleReviewReady({ ...base, sinceLastAttemptMs: IDLE_REVIEW_MIN_INTERVAL_MS - 1 }), { ready: false, reason: 'cooldown' });
  assert.deepEqual(idleReviewReady({ ...base, sinceLastAttemptMs: IDLE_REVIEW_MIN_INTERVAL_MS }), { ready: true });
  // A missing model route or missing evidence skips before any attempt is spent.
  assert.deepEqual(idleReviewReady({ ...base, hasRoute: false }), { ready: false, reason: 'no-route' });
  assert.deepEqual(idleReviewReady({ ...base, hasEvidence: false }), { ready: false, reason: 'evidence' });
  // A paused review reports the pause rather than one of the numeric gates.
  assert.deepEqual(idleReviewReady({ ...base, paused: 'agent teams' }), { ready: false, reason: 'paused' });
});
