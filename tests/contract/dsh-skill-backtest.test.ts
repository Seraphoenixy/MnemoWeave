import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backtestSkill } from '../../plugins/dsh-mnemo-weave/src/ui/skill-backtest.ts';

test('paired skill backtest pins the route and reports previously passing checks that now fail', async () => {
  let calls = 0;
  let pins = 0;
  const task = Object.assign(async () => { throw new Error('unbound task'); }, {
    pin() {
      pins += 1;
      return async (prompt: string) => {
        calls += 1;
        if (calls % 2 === 1) {
          assert.match(prompt, /check a document/);
          return { answer: 'Answer', steps: 'Steps' };
        }
        assert.match(prompt, /Include source/);
        return { checks: [{ passed: calls === 2, reason: 'Fixture' }] };
      };
    },
  });
  const result = await backtestSkill(task, { baseline: 'A', candidate: 'B', scenario: 'check a document', checks: ['Include source'] });
  assert.equal(pins, 1);
  assert.equal(calls, 4);
  assert.deepEqual(result.regressions, ['Include source']);
  await assert.rejects(backtestSkill(async () => ({ answer: 'Answer', steps: 'Steps' }),
    { baseline: '', candidate: 'B', scenario: 'C', checks: ['D'] }), /every check/);
});
