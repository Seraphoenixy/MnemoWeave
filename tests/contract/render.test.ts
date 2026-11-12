import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRules } from '../../packages/client/src/render.ts';

/**
 * The injected text is the only part the model sees, and it carries the rules and nothing else.
 * Every visible enabled rule is delivered whole: there is no budget that trims or selects a
 * subset, because a partial block looks like a rule the user removed.
 */

test('every rule is delivered whole, in the order the Server returned', () => {
  const text = renderRules({
    rules: [{ body: '提交前必须运行类型检查。' }, { body: '禁止直接改正式记忆以外的地方。' }],
    complete: true,
  });
  const positions = ['提交前必须运行类型检查。', '禁止直接改正式记忆以外的地方。'].map(needle => text.indexOf(needle));
  assert.ok(positions.every(position => position >= 0), text);
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
  assert.match(text, /^准则（用户确认，按此执行）：/);
});

test('rules are trimmed at the edges and rendered as bullets', () => {
  const text = renderRules({ rules: [{ body: ' 准则一 ' }, { body: '准则二' }], complete: true });
  assert.match(text, /- 准则一/);
  assert.match(text, /- 准则二/);
  assert.equal(text.includes('undefined'), false);
});

test('an incomplete delivery renders nothing so the host reports the failure', () => {
  const text = renderRules({ rules: [{ body: '准则一' }], complete: false, failure: 'output_limit' });
  assert.equal(text, '');
});

test('an empty set renders nothing and no note', () => {
  assert.equal(renderRules({ rules: [], complete: true }), '');
  assert.equal(renderRules({ rules: [{ body: '   ' }, { body: '' }], complete: true }), '');
  assert.equal(renderRules({}), '');
});

test('empty or blank rule bodies never produce an empty bullet', () => {
  const text = renderRules({ rules: [{ body: '   ' }, { body: '' }, { body: 'kept' }], complete: true });
  assert.equal(text.includes('- \n'), false);
  assert.match(text, /- kept/);
});
