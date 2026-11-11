import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskRunner, type TaskRunner } from '../../plugins/dsh-mnemo-weave/src/ui/task-runner.ts';
import { reviewSkill } from '../../plugins/dsh-mnemo-weave/src/ui/skill-review.ts';

test('DSH review reads only the selected completed conversation and redacts credentials', () => {
  const user = (text: string, kind = 'user') => ({ type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] } });
  const task = createTaskRunner(() => ({
    roots: () => [{ id: 'selected', session: { snapshotEvents: () => [
      user('Correction. token=credential'), user('Internal plugin prompt', 'plugin'),
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Understood' }] } } },
      { type: 'turn/end', data: {} }, user('Unfinished turn'),
    ] } }, { id: 'other', session: { snapshotEvents: () => [user('Another project'), { type: 'turn/end', data: {} }] } }],
  }));
  assert.deepEqual(task.reviewEvidence?.('selected'), [
    { step: 1, role: 'user', text: 'Correction. token=[redacted]' },
    { step: 3, role: 'assistant', text: 'Understood' },
  ]);
  assert.throws(() => task.reviewEvidence?.('missing'), /unavailable/);
});

test('a cited skill draft is automatically backtested and survives an evaluation failure', async () => {
  const evidence = [{ step: 4, role: 'user' as const, text: 'Always cite the source.' }];
  const candidate = '---\nname: review\ndescription: Review a report\n---\nCite the source.';
  const createTask = (steps: number[], fail: boolean): TaskRunner => {
    let calls = 0;
    return Object.assign(async () => { throw new Error('Expected pinned route'); }, {
      reviewEvidence: () => evidence,
      pin: (sessionId?: string) => {
        assert.equal(sessionId, 'selected');
        return async () => {
          calls += 1;
          if (calls === 1) return { action: 'draft', reason: 'User correction', steps, candidate, scenario: 'Review report', checks: ['Cites source'] };
          if (fail) throw new Error('Unavailable model');
          return calls % 2 === 0 ? { answer: 'Report cites the source', steps: 'Read and cite' }
            : { checks: [{ passed: true, reason: 'Citation present' }] };
        };
      },
    });
  };
  const result = await reviewSkill(createTask([4], false), 'selected', '');
  assert.ok(result.kind === 'draft' && result.report);
  assert.deepEqual(result.evidence, evidence);
  const failed = await reviewSkill(createTask([4], true), 'selected', '');
  assert.ok(failed.kind === 'draft' && failed.backtestError === 'Unavailable model');
  assert.equal(failed.input.candidate, candidate);
  await assert.rejects(reviewSkill(createTask([5], false), 'selected', ''), /evidence reference/);
});
