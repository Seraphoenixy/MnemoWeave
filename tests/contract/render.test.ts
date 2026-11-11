import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderView } from '../../packages/client/src/render.ts';

/** The injected text is the only part the model sees; its block order and wording are contract. */

test('the rendered injection keeps the fixed block order', () => {
  const text = renderView({
    guidance: 'Server guidance line.',
    rules: [{ body: '提交前必须运行类型检查。' }, { body: '禁止直接改正式记忆以外的地方。' }],
    workingContext: [{ text: 'Working note one.' }],
    memories: [{ content: 'Formal memory one.' }],
  });
  const positions = ['Server guidance line.', 'Runtime rules', '提交前必须运行类型检查。', 'Working context', 'Formal memories']
    .map(needle => text.indexOf(needle));
  assert.ok(positions.every(position => position >= 0), text);
  assert.deepEqual([...positions].sort((left, right) => left - right), positions, 'blocks must appear in guidance → rules → context → memories order');
});

test('rules are delivered whole as bullets and keep their text', () => {
  const text = renderView({ rules: [{ body: ' 准则一 ' }, { body: '准则二' }] });
  assert.match(text, /Runtime rules \(confirmed by the user, follow them\):/);
  assert.match(text, /- 准则一/);
  assert.match(text, /- 准则二/);
  assert.equal(text.includes('undefined'), false);
});

test('an exhausted rule budget is named instead of silently dropping the block', () => {
  const text = renderView({ rules: [], rulesBudget: { exceeded: true }, memories: [{ content: 'Still delivered.' }] });
  assert.match(text, /Runtime rules were omitted: the budget was exceeded\./);
  assert.match(text, /Formal memories/);
  assert.ok(text.indexOf('Runtime rules were omitted') < text.indexOf('Formal memories'));
});

test('a view without rules renders no rule block and no omission note', () => {
  const text = renderView({ memories: [{ content: 'Only memory.' }] });
  assert.equal(text.includes('Runtime rules'), false);
  assert.equal(text.includes('omitted'), false);
  assert.equal(text, 'Formal memories:\n- Only memory.');
});

test('empty or blank rule bodies never produce an empty bullet', () => {
  const text = renderView({ rules: [{ body: '   ' }, { body: '' }, { body: 'kept' }] });
  assert.equal(text.includes('- \n'), false);
  assert.match(text, /- kept/);
});
