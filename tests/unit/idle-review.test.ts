import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectIdleReviewSignals } from '../../packages/core/application/src/idle-review.ts';

const event = (turnId: string | null, text: string, kind = 'message.user', eventId = `e-${turnId}-${text.slice(0, 4)}`) => ({
  eventId, sessionId: 's-1', turnId, projectId: turnId === '3' ? 'alpha' : null, kind, payload: { text },
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
  assert.equal(result.signals[2]?.projectId, 'alpha');
  assert.equal(result.lastTurn, 5);
  assert.equal(result.skipped.question, 1);
  assert.equal(result.skipped.tooShort, 1);
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
